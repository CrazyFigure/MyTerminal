use std::{
    collections::HashMap,
    sync::{atomic::AtomicBool, mpsc::Sender, Arc, Mutex},
};

use crate::{
    agent_bridge::AgentBridgeRuntime,
    crypto::CryptoService,
    error::AppError,
    models::{TerminalOutputChunk, TerminalSession},
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
    pub stop_flag: Arc<AtomicBool>,
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
        })
    }
}
