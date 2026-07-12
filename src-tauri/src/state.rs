use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicU64},
        mpsc::Sender,
        Arc, Condvar, Mutex,
    },
    time::Instant,
};

use crate::{
    agent_bridge::AgentBridgeRuntime,
    crypto::CryptoService,
    error::AppError,
    models::{ConnectionProfile, TerminalOutputChunk, TerminalSession},
    storage::StorageService,
    webdav::WebDavService,
};
use ssh2::{Session, Sftp};

#[derive(Debug, Clone)]
pub enum SessionControl {
    Input(String),
    Resize { cols: u16, rows: u16 },
    Close,
}

/// 每会话未读输出的字节上限；前端通常会立即拉取并 drain，但 renderer 挂起、IPC 中断或后台会话
/// 高速输出时队列会累积，必须有硬上限，不能依赖“前端及时读取”保证内存安全。
const OUTPUT_QUEUE_MAX_BYTES: usize = 1024 * 1024;
/// 队列清空后若容量超过该阈值则收缩，避免一次突发输出让大容量 VecDeque 永久驻留。
const OUTPUT_QUEUE_SHRINK_THRESHOLD: usize = 64;

/// 有界终端输出队列：内容按字节封顶并合并相邻纯内容分片，cwd/status 控制元数据优先保留。
/// 达到上限时丢弃最旧内容分片并插入一次 truncated 标记，避免用户误以为终端完整保留了历史。
#[derive(Debug, Default)]
pub struct TerminalOutputQueue {
    chunks: VecDeque<TerminalOutputChunk>,
    /// 仅统计内容字节；cwd/status 元数据分片不计入淘汰预算，保证控制信息不被内容挤掉。
    content_bytes: usize,
    /// 已因超限丢弃过内容但尚未向前端发出截断提示时为 true，下次入队时补一条 truncated 标记。
    pending_truncation_notice: bool,
}

impl TerminalOutputQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// 入队一条纯内容分片：优先与队尾相邻内容分片合并，减少大量小 String 对象；随后按字节上限淘汰。
    pub fn push_content(&mut self, session_id: &str, content: String) {
        if content.is_empty() {
            return;
        }
        self.content_bytes = self.content_bytes.saturating_add(content.len());

        // 队尾若也是纯内容分片（无 cwd/status），直接追加字符串，避免产生新的 chunk 对象。
        if let Some(last) = self.chunks.back_mut() {
            if last.cwd.is_none() && last.status.is_none() {
                last.content.push_str(&content);
                self.enforce_limit();
                return;
            }
        }

        self.chunks.push_back(TerminalOutputChunk {
            session_id: session_id.to_string(),
            cwd: None,
            status: None,
            content,
        });
        self.enforce_limit();
    }

    /// 入队 cwd/status 等控制元数据分片；这类分片不计入内容字节预算，也不参与内容合并。
    pub fn push_meta(&mut self, chunk: TerminalOutputChunk) {
        self.chunks.push_back(chunk);
    }

    /// 超出每会话字节上限时，从最旧的内容分片开始丢弃，直到回落到上限内。
    /// cwd/status 元数据分片跳过不丢，保证淘汰内容时不丢失最新目录和连接状态。
    fn enforce_limit(&mut self) {
        let mut dropped = false;
        while self.content_bytes > OUTPUT_QUEUE_MAX_BYTES {
            // 找到最旧的一条纯内容分片丢弃；若队首是元数据则跳过它继续找下一条内容分片。
            let mut removed = false;
            for index in 0..self.chunks.len() {
                if self.chunks[index].cwd.is_none() && self.chunks[index].status.is_none() {
                    let chunk = self.chunks.remove(index).expect("index in range");
                    self.content_bytes = self.content_bytes.saturating_sub(chunk.content.len());
                    dropped = true;
                    removed = true;
                    break;
                }
            }
            // 没有可丢弃的内容分片（理论上不会发生，因为超限必有内容），跳出防止死循环。
            if !removed {
                break;
            }
        }
        if dropped {
            self.pending_truncation_notice = true;
        }
    }

    /// 取走队列内容，缩短持锁时间；发生过淘汰时在最前面补一条截断提示分片。
    pub fn take(&mut self, session_id: &str) -> Vec<TerminalOutputChunk> {
        let mut drained: Vec<TerminalOutputChunk> = self.chunks.drain(..).collect();
        self.content_bytes = 0;
        if self.pending_truncation_notice {
            self.pending_truncation_notice = false;
            drained.insert(
                0,
                TerminalOutputChunk {
                    session_id: session_id.to_string(),
                    cwd: None,
                    status: None,
                    content: "\r\n\x1b[2m[较早的输出因超出缓存上限已被回收]\x1b[0m\r\n".to_string(),
                },
            );
        }
        // 突发输出后 VecDeque 可能保留很大容量；清空后按阈值收缩，避免永久占用。
        if self.chunks.capacity() > OUTPUT_QUEUE_SHRINK_THRESHOLD {
            self.chunks.shrink_to(OUTPUT_QUEUE_SHRINK_THRESHOLD);
        }
        drained
    }
}

#[derive(Debug, Clone)]
pub struct RuntimeSession {
    pub session: TerminalSession,
    pub cols: u16,
    pub rows: u16,
    pub output_queue: Arc<Mutex<TerminalOutputQueue>>,
    pub control_tx: Sender<SessionControl>,
    /// 连接仍在后台握手时，关闭标签需要能阻止迟到的状态事件重新激活会话。
    pub stop_flag: Arc<AtomicBool>,
}

#[derive(Debug, Clone)]
pub struct TunnelRuntime {
    /// 隧道所属连接 ID，用于同一 SSH 配置的多个本地监听共享会话池并在停止时清理空闲连接。
    pub connection_id: String,
    pub stop_flag: Arc<AtomicBool>,
    /// 保持共享会话池存活；最后一个隧道停止后由命令层关闭并移除池。
    pub pool: Arc<TunnelSshPool>,
}

#[derive(Debug)]
pub struct TunnelSshPool {
    /// 隧道会话池只保存 SSH 连接配置快照；连接配置更新时必须关闭旧池，避免继续使用旧主机或旧凭据。
    pub connection: ConnectionProfile,
    /// 池状态受互斥锁保护，避免网页并发请求同时创建过多 SSH 握手。
    pub inner: Mutex<TunnelSshPoolState>,
    /// 并发请求在池满或正在建连时等待该条件变量，连接归还或新连接可用时唤醒。
    pub available: Condvar,
}

#[derive(Debug)]
pub struct TunnelSshPoolState {
    /// 可承载隧道 channel 的 SSH session 列表；每个 session 可在非阻塞模式下跑多个 direct-tcpip channel。
    pub sessions: Vec<TunnelSshPoolSession>,
    /// 正在建立的 SSH session 数量，用于抑制冷启动时的握手风暴。
    pub connecting_sessions: usize,
    /// session ID 只在当前池内递增，用于 channel 结束后准确归还活跃计数。
    pub next_session_id: u64,
    /// 池关闭后不再接收新 channel，空闲 session 会立即释放。
    pub closed: bool,
}

#[derive(Clone)]
pub struct TunnelSshPoolSession {
    /// 池内 session 标识，避免 Vec 下标变化导致归还到错误 session。
    pub id: u64,
    /// 真实 SSH session；ssh2 内部有锁，非阻塞模式下可安全跨线程轮询多个 channel。
    pub session: Session,
    /// 当前 session 上正在转发的 direct-tcpip channel 数量。
    pub active_channels: usize,
    /// 出现 transport 级错误后不再分配新 channel，等现有 channel 退出后移除。
    pub failed: bool,
}

impl std::fmt::Debug for TunnelSshPoolSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TunnelSshPoolSession")
            .field("id", &self.id)
            .field("active_channels", &self.active_channels)
            .field("failed", &self.failed)
            .finish()
    }
}

pub struct AuxiliarySshSession {
    /// 文件管理、运行状态和历史查询共用的 SSH 会话，避免每次刷新都重新握手。
    pub session: Session,
    /// SFTP 子系统按需初始化；目录切换和文件读取优先复用同一个远端文件通道。
    pub sftp: Option<Sftp>,
    /// 远端 uid 到用户名的缓存，SFTP 属性刷新时不重复读取 /etc/passwd。
    pub user_names: Option<HashMap<u32, String>>,
    /// 远端 gid 到组名的缓存，SFTP 属性刷新时不重复读取 /etc/group。
    pub group_names: Option<HashMap<u32, String>>,
    /// 最近一次被文件/历史/资源操作访问的时刻；保活守护线程据此按空闲 TTL 回收连接。
    pub last_used_at: Instant,
}

impl std::fmt::Debug for AuxiliarySshSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AuxiliarySshSession")
            .field("has_sftp", &self.sftp.is_some())
            .field("has_user_names", &self.user_names.is_some())
            .field("has_group_names", &self.group_names.is_some())
            .finish()
    }
}

#[derive(Debug)]
pub struct AppState {
    pub storage: StorageService,
    pub crypto: CryptoService,
    pub webdav: WebDavService,
    pub agent_bridge: AgentBridgeRuntime,
    pub sessions: Mutex<HashMap<String, RuntimeSession>>,
    /// 关闭流程只允许启动一次；后续 CloseRequested 必须放行，让 WebView 窗口正常销毁。
    pub is_shutting_down: AtomicBool,
    /// 辅助 SSH 缓存只服务非交互查询，不和终端 PTY 共用连接，避免文件管理阻塞键盘输入。
    pub auxiliary_sessions: Mutex<HashMap<String, Arc<Mutex<AuxiliarySshSession>>>>,
    /// 首次建立辅助连接按连接 ID 串行化，防止文件列表和运行状态同时触发两次 SSH 握手。
    pub auxiliary_session_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    pub tunnels: Mutex<HashMap<String, TunnelRuntime>>,
    /// SSH 隧道专用会话池按连接配置共享，避免每个网页请求都重新握手。
    pub tunnel_ssh_pools: Mutex<HashMap<String, Arc<TunnelSshPool>>>,
    /// SSH 保活间隔（秒，0=关闭）。后台守护线程和交互终端各自克隆一份 Arc 读取；保存设置时热更新，无需重连。
    pub ssh_keepalive_interval_sec: Arc<AtomicU64>,
}

impl AppState {
    pub fn new() -> Result<Self, AppError> {
        let storage = StorageService::new(StorageService::default_data_dir())?;
        let mut persisted_tunnels = storage.load_tunnels()?;
        let had_running_tunnels = persisted_tunnels
            .iter()
            .any(|tunnel| tunnel.status == "running");
        if had_running_tunnels {
            for tunnel in &mut persisted_tunnels {
                if tunnel.status == "running" {
                    tunnel.status = "stopped".into();
                }
            }
            storage.save_tunnels(&persisted_tunnels)?;
        }

        let crypto = CryptoService::new(storage.key_path())?;
        // 启动时读取保活间隔初值；后续保存设置时由命令层热更新该原子值。
        let keepalive_interval_sec = storage
            .load_settings(&crypto)
            .map(|settings| settings.ssh_keepalive_interval_sec as u64)
            .unwrap_or(30);
        Ok(Self {
            storage,
            crypto,
            webdav: WebDavService::new(),
            agent_bridge: AgentBridgeRuntime::new(),
            sessions: Mutex::new(HashMap::new()),
            is_shutting_down: AtomicBool::new(false),
            auxiliary_sessions: Mutex::new(HashMap::new()),
            auxiliary_session_locks: Mutex::new(HashMap::new()),
            tunnels: Mutex::new(HashMap::new()),
            tunnel_ssh_pools: Mutex::new(HashMap::new()),
            ssh_keepalive_interval_sec: Arc::new(AtomicU64::new(keepalive_interval_sec)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{TerminalOutputQueue, OUTPUT_QUEUE_MAX_BYTES};

    // 相邻纯内容分片必须合并为一个 chunk，避免大量小 String 对象。
    #[test]
    fn merges_adjacent_content_chunks() {
        let mut queue = TerminalOutputQueue::new();
        queue.push_content("s1", "hello ".into());
        queue.push_content("s1", "world".into());
        let chunks = queue.take("s1");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].content, "hello world");
    }

    // 超出字节上限时丢弃最旧内容并补一条截断提示；总内容不得超过上限。
    #[test]
    fn caps_bytes_and_emits_truncation_notice() {
        let mut queue = TerminalOutputQueue::new();
        // 写入 3 段各占上限一半的内容，合计 1.5 倍上限，必然触发淘汰。
        let half = "a".repeat(OUTPUT_QUEUE_MAX_BYTES / 2 + 1);
        // 用元数据分片打断合并，制造多个可独立淘汰的内容分片。
        queue.push_content("s1", half.clone());
        queue.push_meta(super::TerminalOutputChunk {
            session_id: "s1".into(),
            cwd: Some("/tmp".into()),
            status: None,
            content: String::new(),
        });
        queue.push_content("s1", half.clone());
        queue.push_meta(super::TerminalOutputChunk {
            session_id: "s1".into(),
            cwd: None,
            status: Some("connected".into()),
            content: String::new(),
        });
        queue.push_content("s1", half);

        let chunks = queue.take("s1");
        let content_bytes: usize = chunks.iter().map(|c| c.content.len()).sum();
        // 内容部分（含截断提示）不应显著超过上限；提示语很短，用 1.1 倍上限做宽松断言。
        assert!(content_bytes <= OUTPUT_QUEUE_MAX_BYTES + OUTPUT_QUEUE_MAX_BYTES / 10);
        // cwd/status 控制元数据必须保留，不能在内容淘汰时被丢掉。
        assert!(chunks.iter().any(|c| c.cwd.as_deref() == Some("/tmp")));
        assert!(chunks.iter().any(|c| c.status.as_deref() == Some("connected")));
        // 发生过淘汰，必须有一条截断提示。
        assert!(chunks.iter().any(|c| c.content.contains("已被回收")));
    }
}
