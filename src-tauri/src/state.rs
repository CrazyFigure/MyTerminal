use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64},
        mpsc::Sender,
        Arc, Condvar, Mutex,
    },
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

#[derive(Debug, Clone)]
pub struct RuntimeSession {
    pub session: TerminalSession,
    pub cols: u16,
    pub rows: u16,
    pub output_queue: Arc<Mutex<Vec<TerminalOutputChunk>>>,
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
