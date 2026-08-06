use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{ErrorKind, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant},
};

use chrono::Utc;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ssh2::Session;
use tauri::{AppHandle, Emitter, Manager};

use crate::{
    commands::{self, connect_ssh},
    crypto::CryptoService,
    error::AppError,
    models::{AgentBridgeSettings, ConnectionProfile},
    state::{AgentPtyPhase, AgentPtyRun, AgentPtyState, AppState, RuntimeSession, SessionControl},
    storage::StorageService,
};

// Agent 文件读写与递归传输作为独立子域维护；只读入口继续从 agent_bridge 根模块公开。
mod files;
pub use files::{list_agent_files, read_agent_file};
use files::{
    delete_agent_file, download_agent_path, mkdir_agent_file, rename_agent_file,
    upload_agent_path, write_agent_file,
};

// HTTP Broker 适配器独立维护协议细节；动作分派入口继续从根模块公开给内置 Agent。
mod http;
pub use http::{dispatch_agent_action, dispatch_agent_action_with_context};
use http::{handle_http_request, write_http_json};

// 审批请求的排队与执行状态机独立维护；公开审批 API 保持原路径。
mod requests;
pub use requests::{approve_request, clear_finished_requests, list_requests, reject_request};
use requests::{request_download_paths, request_upload_paths, submit_action};

const AGENT_BRIDGE_HISTORY_LIMIT: usize = 120;
const AGENT_BRIDGE_APPROVAL_WAIT_SEC: u64 = 3600;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBridgeLocalSecret {
    /// Broker token 只保存在本机 secret 文件中，不进入 WebDAV 或本地配置包。
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBridgeDiscovery {
    /// discovery 文件给 CLI/MCP 自动发现本地 Broker，端口为运行期随机端口。
    pub port: u16,
    /// 本地 token 随 discovery 暴露给同一用户进程，外部请求仍必须携带 Authorization。
    pub token: String,
    pub started_at: String,
    /// 每次 Broker 启动生成独立 ID，用于多实例注册、归属校验和安全清理。
    #[serde(default)]
    pub instance_id: String,
    /// Broker 实际使用的数据目录；多实例回退时据此恢复对应目录的兼容 discovery 文件。
    #[serde(default)]
    pub data_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBridgeStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: Option<u16>,
    pub token: Option<String>,
    pub discovery_path: String,
    pub cli_command: String,
    pub mcp_command: String,
    /// 随应用一同分发的 myterminal-cli 可执行文件绝对路径，供前端拼出直连 stdio 的 MCP 配置。
    pub cli_path: Option<String>,
    /// 当前实际使用的数据目录，供前端在 MCP 配置里注入 MYTERMINAL_DATA_DIR，保证 CLI 无论从哪启动都能定位 Broker。
    pub data_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnectionSummary {
    pub id: String,
    pub name: String,
    pub group_path: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnectionGroupNode {
    pub name: String,
    pub path: String,
    pub children: Vec<AgentConnectionGroupNode>,
    pub connections: Vec<AgentConnectionSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConnectionList {
    pub groups: Vec<AgentConnectionGroupNode>,
    pub connections: Vec<AgentConnectionSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    pub connection_id: String,
    pub title: String,
    pub cwd: String,
    pub opened_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommandResult {
    pub run_id: String,
    pub session_id: String,
    pub connection_id: String,
    pub command: String,
    pub cwd: String,
    pub status: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub started_at: String,
    pub finished_at: String,
    /// 本次执行通道："terminal" 表示在用户可见的终端标签里执行，"exec" 表示后台隐藏通道。
    pub execution_mode: String,
    /// 可见执行时的目标终端会话 id，便于 agent 在回复中引用具体标签。
    pub terminal_session_id: Option<String>,
    /// 回退到隐藏通道时的原因；可见执行成功时为 None。如实告知 agent 与用户本次是否可见。
    pub fallback_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFileReadResult {
    pub session_id: String,
    pub path: String,
    pub encoding: String,
    pub content: Option<String>,
    pub content_base64: Option<String>,
    pub size: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBridgeRequest {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub connection_id: String,
    pub session_id: Option<String>,
    pub title: String,
    pub command: Option<String>,
    pub path: Option<String>,
    pub new_path: Option<String>,
    pub content_preview: Option<String>,
    pub logs: Vec<String>,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// 内置 AI 对话发起的请求会带上对话 ID；外部 MCP 请求保持为空。
    pub conversation_id: Option<String>,
    /// 对应的模型工具调用 ID，用于把审批卡片准确放回原工具调用下方。
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing)]
    pub action: AgentAction,
}

/// 内置 AI 工具调用的来源上下文；外部 MCP 入口不传，继续进入独立审批记录页。
pub struct AgentActionContext<'a> {
    pub conversation_id: &'a str,
    pub tool_call_id: &'a str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionRequest {
    /// 优先使用 list_connections 返回的连接 id；为空时可用 connectionName 按保存的连接名称打开。
    pub connection_id: Option<String>,
    /// 给 MCP agent 的便捷入口：用户说“打开 28开发”时可直接传连接名称，不需要猜 sessionId。
    pub connection_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseSessionRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCommandRequest {
    pub session_id: String,
    pub command: String,
    pub cwd: Option<String>,
    pub timeout_sec: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePathRequest {
    pub session_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteRequest {
    pub session_id: String,
    pub path: String,
    pub content: Option<String>,
    pub content_base64: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileUploadRequest {
    pub session_id: String,
    /// 兼容旧版 MCP/CLI：单一路径继续从 localPath 接收。
    pub local_path: Option<String>,
    /// 批量上传直接接收本机路径列表，Bridge 用 SFTP 传输，避免把文件内容塞进 base64 导致 MCP 超时。
    #[serde(default)]
    pub local_paths: Vec<String>,
    pub remote_dir: Option<String>,
    pub remote_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDownloadRequest {
    pub session_id: String,
    /// 兼容旧版 MCP/CLI：单个远端路径继续从 path 接收。
    pub path: Option<String>,
    /// 批量下载使用 paths；多个同名文件落到同一目录时会自动追加序号避免互相覆盖。
    #[serde(default)]
    pub paths: Vec<String>,
    pub local_dir: Option<String>,
    pub local_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRenameRequest {
    pub session_id: String,
    pub path: String,
    pub new_path: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFileTransferResult {
    pub session_id: String,
    pub source_path: String,
    pub destination_path: String,
    /// 批量传输时返回全部源路径，单个传输也保留一项，方便 MCP 客户端读取结果。
    pub source_paths: Vec<String>,
    /// 批量传输时返回全部目标路径，单个传输也保留一项，方便 MCP 客户端读取结果。
    pub destination_paths: Vec<String>,
    pub files: usize,
    pub directories: usize,
    pub bytes: u64,
}

#[derive(Debug, Clone)]
pub enum AgentAction {
    RunCommand(RunCommandRequest),
    FileWrite(FileWriteRequest),
    FileUpload(FileUploadRequest),
    FileDownload(FileDownloadRequest),
    FileDelete(FilePathRequest),
    FileRename(FileRenameRequest),
    FileMkdir(FilePathRequest),
}

#[derive(Debug, Clone)]
struct AgentBridgeServer {
    /// 当前进程拥有的 discovery 记录；停止时只清理同一 instanceId，不能误删其它实例。
    discovery: AgentBridgeDiscovery,
    /// 当前进程在全局注册目录中的独立文件路径。
    registry_path: PathBuf,
    stop_flag: Arc<AtomicBool>,
    /// 监听线程实际持有的执行设置快照，用于判断保存设置后是否真的需要重启 Broker。
    settings: AgentBridgeSettings,
}

#[derive(Debug, Clone)]
pub struct AgentBridgeRuntime {
    requests: Arc<Mutex<VecDeque<AgentBridgeRequest>>>,
    request_changed: Arc<Condvar>,
    sessions: Arc<Mutex<HashMap<String, AgentSession>>>,
    command_lanes: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    server: Arc<Mutex<Option<AgentBridgeServer>>>,
    app_handle: Arc<Mutex<Option<AppHandle>>>,
}

impl AgentBridgeRuntime {
    pub fn new() -> Self {
        Self {
            requests: Arc::new(Mutex::new(VecDeque::new())),
            request_changed: Arc::new(Condvar::new()),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            command_lanes: Arc::new(Mutex::new(HashMap::new())),
            server: Arc::new(Mutex::new(None)),
            app_handle: Arc::new(Mutex::new(None)),
        }
    }
}

impl Default for AgentBridgeRuntime {
    fn default() -> Self {
        Self::new()
    }
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

pub fn set_app_handle(runtime: &AgentBridgeRuntime, app_handle: AppHandle) -> Result<(), AppError> {
    *runtime
        .app_handle
        .lock()
        .map_err(|_| AppError::Validation("agent bridge app handle is unavailable".into()))? =
        Some(app_handle);
    Ok(())
}

fn emit_requests_changed(runtime: &AgentBridgeRuntime) {
    // 请求列表变更后同时唤醒 CLI 等待线程和前端事件订阅，前端不再需要固定 1 秒轮询。
    if let Ok(app_handle) = runtime.app_handle.lock() {
        if let Some(app_handle) = app_handle.as_ref() {
            let _ = app_handle.emit("agent-bridge-requests-changed", ());
        }
    }
}

fn lock_requests<'a>(
    runtime: &'a AgentBridgeRuntime,
) -> Result<MutexGuard<'a, VecDeque<AgentBridgeRequest>>, AppError> {
    runtime
        .requests
        .lock()
        .map_err(|_| AppError::Validation("agent bridge request queue is unavailable".into()))
}

fn lock_sessions<'a>(
    runtime: &'a AgentBridgeRuntime,
) -> Result<MutexGuard<'a, HashMap<String, AgentSession>>, AppError> {
    runtime
        .sessions
        .lock()
        .map_err(|_| AppError::Validation("agent bridge session registry is unavailable".into()))
}

fn lock_command_lanes<'a>(
    runtime: &'a AgentBridgeRuntime,
) -> Result<MutexGuard<'a, HashMap<String, Arc<Mutex<()>>>>, AppError> {
    runtime
        .command_lanes
        .lock()
        .map_err(|_| AppError::Validation("agent bridge command lanes are unavailable".into()))
}

fn command_lane_for_session(
    runtime: &AgentBridgeRuntime,
    session_id: &str,
) -> Result<Arc<Mutex<()>>, AppError> {
    let mut lanes = lock_command_lanes(runtime)?;
    // 命令串行粒度是 AI 会话；同一 agent 对同一机器的 session 顺序执行，不同 agent/session 仍可并行。
    Ok(lanes
        .entry(session_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone())
}

fn lock_server<'a>(
    runtime: &'a AgentBridgeRuntime,
) -> Result<MutexGuard<'a, Option<AgentBridgeServer>>, AppError> {
    runtime
        .server
        .lock()
        .map_err(|_| AppError::Validation("agent bridge server state is unavailable".into()))
}

fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn load_or_create_token(storage: &StorageService) -> Result<String, AppError> {
    let path = storage.agent_bridge_secret_path();
    if path.exists() {
        let raw = fs::read_to_string(&path)?;
        let secret: AgentBridgeLocalSecret = serde_json::from_str(&raw)?;
        if !secret.token.trim().is_empty() {
            return Ok(secret.token);
        }
    }

    reset_agent_bridge_token(storage)
}

pub fn reset_agent_bridge_token(storage: &StorageService) -> Result<String, AppError> {
    let token = random_token();
    let secret = AgentBridgeLocalSecret {
        token: token.clone(),
    };
    if let Some(parent) = storage.agent_bridge_secret_path().parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(
        storage.agent_bridge_secret_path(),
        serde_json::to_string_pretty(&secret)?,
    )?;
    Ok(token)
}

/// 读取单个 discovery；注册目录中的临时文件和异常退出留下的损坏文件会被调用方忽略。
fn read_discovery(path: &Path) -> Option<AgentBridgeDiscovery> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// 使用带鉴权的 /status 探测 Broker，不能只判断端口可连接，避免端口被其它进程复用后误路由 MCP。
pub fn discovery_is_healthy(discovery: &AgentBridgeDiscovery) -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], discovery.port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(350)) else {
        return false;
    };
    let timeout = Some(Duration::from_millis(700));
    if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() {
        return false;
    }
    let request = format!(
        "GET /status HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        discovery.port, discovery.token
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = Vec::new();
    if stream.read_to_end(&mut response).is_err() {
        return false;
    }
    let Some(body_start) = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
    else {
        return false;
    };
    serde_json::from_slice::<Value>(&response[body_start..])
        .ok()
        .and_then(|body| body.get("ok").and_then(Value::as_bool))
        == Some(true)
}

/// 返回全局注册目录中仍健康的 Broker，按启动时间从新到旧排列；同时清理崩溃遗留记录。
fn healthy_registered_discoveries() -> Vec<(PathBuf, AgentBridgeDiscovery)> {
    // 并发启动时，另一个进程可能刚原子发布记录、监听线程尚未来得及 accept；给新文件留出启动宽限期。
    const DISCOVERY_STARTUP_GRACE: Duration = Duration::from_secs(3);
    let registry_dir = StorageService::agent_bridge_registry_dir_path();
    let Ok(entries) = fs::read_dir(&registry_dir) else {
        return Vec::new();
    };
    let mut discoveries = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_recent = fs::metadata(&path)
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|elapsed| elapsed < DISCOVERY_STARTUP_GRACE);
        // 原子写入使用 .tmp 扩展名；只处理最终的 JSON 注册文件。
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            // 异常退出可能遗留临时文件；只清理超过启动宽限期的项，不能破坏另一个正在发布的实例。
            if !is_recent {
                let _ = fs::remove_file(path);
            }
            continue;
        }
        let Some(discovery) = read_discovery(&path) else {
            if !is_recent {
                let _ = fs::remove_file(path);
            }
            continue;
        };
        if discovery_is_healthy(&discovery) {
            discoveries.push((path, discovery));
        } else if !is_recent {
            let _ = fs::remove_file(path);
        }
    }
    discoveries.sort_by(|left, right| right.1.started_at.cmp(&left.1.started_at));
    discoveries
}

/// 以“临时文件 + rename”发布独立注册记录，避免 MCP 扫描线程读到半段 JSON。
fn write_registry_discovery(path: &Path, discovery: &AgentBridgeDiscovery) -> Result<(), AppError> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Validation("agent bridge registry path has no parent".into()))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!("{}.tmp", discovery.instance_id));
    fs::write(&temporary, serde_json::to_string_pretty(discovery)?)?;
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    Ok(())
}

/// 同时写入数据目录下的兼容 discovery 与全局多实例注册；全局记录供“后启动健康实例优先”选择。
fn write_discovery(
    storage: &StorageService,
    port: u16,
    token: &str,
) -> Result<(AgentBridgeDiscovery, PathBuf), AppError> {
    let discovery = AgentBridgeDiscovery {
        port,
        token: token.to_string(),
        started_at: now_rfc3339(),
        instance_id: uuid::Uuid::new_v4().to_string(),
        data_dir: storage.data_dir_path().to_string_lossy().to_string(),
    };
    // 启动时顺便淘汰崩溃遗留项，避免注册目录无限增长；健康旧实例继续保留以便当前实例退出后回退。
    let _ = healthy_registered_discoveries();
    let registry_path = StorageService::agent_bridge_registry_dir_path()
        .join(format!("{}.json", discovery.instance_id));
    // 全局注册是多实例增强能力；目录暂不可写时仍保留数据目录 discovery，避免 MCP 功能整体不可用。
    if let Err(error) = write_registry_discovery(&registry_path, &discovery) {
        eprintln!("failed to publish agent bridge registry entry: {error}");
    }
    if let Err(error) = fs::write(
        storage.agent_bridge_discovery_path(),
        serde_json::to_string_pretty(&discovery)?,
    ) {
        let _ = fs::remove_file(&registry_path);
        return Err(error.into());
    }
    Ok((discovery, registry_path))
}

/// 停止当前 Broker 时只移除自己的注册记录；若同一数据目录仍有其它健康实例，则恢复兼容 discovery。
fn remove_owned_discovery(storage: &StorageService, server: &AgentBridgeServer) {
    let _ = fs::remove_file(&server.registry_path);
    let local_path = storage.agent_bridge_discovery_path();
    let owns_local = read_discovery(&local_path).is_some_and(|discovery| {
        (!discovery.instance_id.is_empty() && discovery.instance_id == server.discovery.instance_id)
            || (discovery.instance_id.is_empty()
                && discovery.port == server.discovery.port
                && discovery.token == server.discovery.token)
    });
    if !owns_local {
        return;
    }

    let current_data_dir = storage.data_dir_path().to_string_lossy();
    let fallback = healthy_registered_discoveries()
        .into_iter()
        .map(|(_, discovery)| discovery)
        .find(|discovery| discovery.data_dir == current_data_dir);
    if let Some(discovery) = fallback {
        let _ = fs::write(
            local_path,
            serde_json::to_string_pretty(&discovery).unwrap_or_default(),
        );
    } else {
        let _ = fs::remove_file(local_path);
    }
}

/// Bridge 未启用时仅删除确认失效的本地记录，不能把另一个共用数据目录的健康实例误清掉。
fn remove_stale_local_discovery(storage: &StorageService) {
    let path = storage.agent_bridge_discovery_path();
    let should_remove = read_discovery(&path)
        .map(|discovery| !discovery_is_healthy(&discovery))
        .unwrap_or_else(|| path.exists());
    if should_remove {
        let _ = fs::remove_file(path);
    }
}

/// 解析随应用一同分发的 myterminal-cli 可执行文件路径。
/// 安装版把 CLI 与主程序放在同一目录，`tauri dev` 也会把两者输出到 target/debug；
/// 找到后 MCP 配置可直接以该可执行文件作为 stdio server，免去 npx 与本地 launcher 包依赖。
fn resolve_cli_executable() -> Option<PathBuf> {
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let current = std::env::current_exe().ok()?;
    let dir = current.parent()?;

    // 1) 与主程序同名的常规 CLI 名（tauri dev 的 target 目录、以及手工放置场景）。
    let plain = dir.join(format!("myterminal-cli{ext}"));
    if plain.exists() {
        return Some(plain);
    }

    // 2) Tauri externalBin 会把 sidecar 以 <name>-<target-triple><ext> 的名字随安装包分发；
    //    安装版主程序旁只有带 triple 后缀的这个文件，需按前缀匹配后返回。
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let matches =
                name.starts_with("myterminal-cli-") && (ext.is_empty() || name.ends_with(ext));
            if matches {
                return Some(entry.path());
            }
        }
    }
    None
}

pub fn bridge_status(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    settings: &AgentBridgeSettings,
) -> Result<AgentBridgeStatus, AppError> {
    let server = lock_server(runtime)?;
    let (running, port, token) = server
        .as_ref()
        .map(|server| {
            (
                true,
                Some(server.discovery.port),
                Some(server.discovery.token.clone()),
            )
        })
        .unwrap_or((false, None, None));
    let cli_command = "myterminal-cli bridge status --json".to_string();
    let mcp_command = "myterminal-cli mcp --stdio".to_string();

    Ok(AgentBridgeStatus {
        enabled: settings.enabled,
        running,
        port,
        token,
        discovery_path: storage
            .agent_bridge_discovery_path()
            .to_string_lossy()
            .to_string(),
        // 数据目录暴露给前端，用于在生成的 MCP 配置里注入 MYTERMINAL_DATA_DIR，
        // 使 CLI 被外部客户端拉起时无论工作目录如何都能定位到 discovery 文件。
        data_dir: storage.data_dir_path().to_string_lossy().to_string(),
        cli_command,
        mcp_command,
        cli_path: resolve_cli_executable().map(|path| path.to_string_lossy().to_string()),
    })
}

pub fn sync_server(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    settings: &AgentBridgeSettings,
) -> Result<(), AppError> {
    if settings.enabled {
        // Broker 线程持有设置快照；只有 MCP 执行设置真实变化时才重启，
        // 避免外观保存、重复初始化等无关调用重置正在进行的 MCP 请求。
        let settings_changed = lock_server(runtime)?
            .as_ref()
            .map(|server| server.settings != *settings)
            .unwrap_or(false);
        if settings_changed {
            restart_server(runtime, storage)?;
        }
        start_server(runtime, storage, crypto, settings)?;
    } else {
        stop_server(runtime, storage)?;
    }
    Ok(())
}

/// 按持久化开关确保 Broker 处于正确状态，但不重启已经运行的监听器。
/// 应用启动和前端 bootstrap 可能几乎同时触发；这里保持幂等，避免第二次初始化重置正在进行的 MCP 请求。
pub fn ensure_server(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    settings: &AgentBridgeSettings,
) -> Result<(), AppError> {
    if settings.enabled {
        start_server(runtime, storage, crypto, settings)
    } else if lock_server(runtime)?.is_some() {
        stop_server(runtime, storage)
    } else {
        // Bridge 本来就是关闭状态时只清理确认失效的 discovery；共用目录中的其它健康实例必须保留。
        remove_stale_local_discovery(storage);
        Ok(())
    }
}

pub fn start_server(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    settings: &AgentBridgeSettings,
) -> Result<(), AppError> {
    if lock_server(runtime)?.is_some() {
        return Ok(());
    }

    let token = load_or_create_token(storage)?;
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let (discovery, registry_path) = write_discovery(storage, port, &token)?;

    let stop_flag = Arc::new(AtomicBool::new(false));
    let server_state = AgentBridgeServer {
        discovery,
        registry_path,
        stop_flag: Arc::clone(&stop_flag),
        settings: settings.clone(),
    };
    *lock_server(runtime)? = Some(server_state);

    let runtime_clone = runtime.clone();
    let storage_clone = storage.clone();
    let crypto_clone = crypto.clone();
    let settings_clone = settings.clone();
    thread::spawn(move || loop {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }

        match listener.accept() {
            Ok((mut stream, _)) => {
                let runtime = runtime_clone.clone();
                let storage = storage_clone.clone();
                let crypto = crypto_clone.clone();
                let settings = settings_clone.clone();
                let token = token.clone();
                thread::spawn(move || {
                    let response = handle_http_request(
                        &mut stream,
                        &runtime,
                        &storage,
                        &crypto,
                        &settings,
                        &token,
                    );
                    if let Err(error) = response {
                        let _ = write_http_json(
                            &mut stream,
                            500,
                            &json!({ "ok": false, "error": error.to_string() }),
                        );
                    }
                });
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(80));
            }
            Err(_) => break,
        }
    });

    Ok(())
}

pub fn stop_server(runtime: &AgentBridgeRuntime, storage: &StorageService) -> Result<(), AppError> {
    stop_server_with_policy(runtime, storage, true, true)
}

fn restart_server(runtime: &AgentBridgeRuntime, storage: &StorageService) -> Result<(), AppError> {
    // 配置保存只需要替换监听线程和 discovery 文件；AI session 只是逻辑句柄，保留后可避免 agent 突然拿到 session not found。
    stop_server_with_policy(runtime, storage, false, false)
}

fn stop_server_with_policy(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    close_sessions: bool,
    fail_waiting: bool,
) -> Result<(), AppError> {
    let server = lock_server(runtime)?.take();
    if let Some(server) = server.as_ref() {
        server.stop_flag.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(("127.0.0.1", server.discovery.port));
    }
    if close_sessions {
        close_all_agent_sessions(runtime)?;
    }
    if fail_waiting {
        fail_waiting_requests(runtime, "MCP Bridge 已停止，请重新打开会话后再执行。")?;
    }
    if let Some(server) = server.as_ref() {
        remove_owned_discovery(storage, server);
    } else {
        remove_stale_local_discovery(storage);
    }
    Ok(())
}

pub fn close_all_agent_sessions(runtime: &AgentBridgeRuntime) -> Result<bool, AppError> {
    lock_sessions(runtime)?.clear();
    // 关闭全部 AI 会话时同步清理命令串行 lane；正在执行的命令仍持有自己的 Arc，不会被中途打断。
    lock_command_lanes(runtime)?.clear();
    Ok(true)
}

fn fail_waiting_requests(runtime: &AgentBridgeRuntime, reason: &str) -> Result<(), AppError> {
    let now = now_rfc3339();
    let mut requests = lock_requests(runtime)?;
    for request in requests.iter_mut() {
        if request.status == "pending" || request.status == "running" {
            request.status = "error".into();
            request.error = Some(reason.into());
            request.updated_at = now.clone();
            request.logs.push("Bridge 已停止，已取消该请求。".into());
        }
    }
    runtime.request_changed.notify_all();
    emit_requests_changed(runtime);
    Ok(())
}

pub fn list_connections(
    storage: &StorageService,
    crypto: &CryptoService,
) -> Result<AgentConnectionList, AppError> {
    let connections = storage
        .load_connections(crypto)?
        .into_iter()
        // Agent 的命令、文件和终端能力都建立在 SSH 上，Windows RDP 只在桌面连接管理中展示。
        .filter(|connection| connection.protocol.trim().eq_ignore_ascii_case("ssh"))
        .map(sanitize_connection)
        .collect::<Vec<_>>();
    let settings = storage.load_settings(crypto)?;
    let groups = build_group_tree(&settings.connection_groups, &connections);
    Ok(AgentConnectionList {
        groups,
        connections,
    })
}

fn sanitize_connection(connection: ConnectionProfile) -> AgentConnectionSummary {
    AgentConnectionSummary {
        id: connection.id,
        name: connection.name,
        group_path: connection.group_path,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        note: connection.note,
    }
}

pub fn build_group_tree(
    group_paths: &[String],
    connections: &[AgentConnectionSummary],
) -> Vec<AgentConnectionGroupNode> {
    let mut paths = group_paths.to_vec();
    for connection in connections {
        if let Some(path) = connection
            .group_path
            .as_ref()
            .filter(|value| !value.is_empty())
        {
            if !paths.contains(path) {
                paths.push(path.clone());
            }
        }
    }
    paths.sort();
    paths.dedup();
    build_group_children("", &paths, connections)
}

fn build_group_children(
    parent: &str,
    paths: &[String],
    connections: &[AgentConnectionSummary],
) -> Vec<AgentConnectionGroupNode> {
    let mut nodes = Vec::new();
    for path in paths {
        let (node_parent, name) = path.rsplit_once('/').unwrap_or(("", path.as_str()));
        if node_parent != parent {
            continue;
        }
        let children = build_group_children(path, paths, connections);
        let group_connections = connections
            .iter()
            .filter(|connection| connection.group_path.as_deref() == Some(path.as_str()))
            .cloned()
            .collect();
        nodes.push(AgentConnectionGroupNode {
            name: name.to_string(),
            path: path.clone(),
            children,
            connections: group_connections,
        });
    }
    nodes
}

pub fn open_agent_session(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    request: &OpenSessionRequest,
) -> Result<AgentSession, AppError> {
    let connection = find_connection_for_open_session(storage, crypto, request)?;
    let session = AgentSession {
        id: uuid::Uuid::new_v4().to_string(),
        connection_id: connection.id.clone(),
        title: format!("{}@{}", connection.username, connection.host),
        cwd: "~".into(),
        opened_at: now_rfc3339(),
    };
    lock_sessions(runtime)?.insert(session.id.clone(), session.clone());
    Ok(session)
}

pub fn close_agent_session(
    runtime: &AgentBridgeRuntime,
    session_id: &str,
) -> Result<bool, AppError> {
    lock_sessions(runtime)?.remove(session_id);
    // 单个 AI 会话关闭后移除对应串行 lane，后续同名旧 session 请求会先被 session 校验拦截。
    lock_command_lanes(runtime)?.remove(session_id);
    Ok(true)
}

/// 统一清理 MCP/CLI 传入的可选字符串，空白字符串按未提供处理。
fn trimmed_non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn find_connection(
    storage: &StorageService,
    crypto: &CryptoService,
    connection_id: &str,
) -> Result<ConnectionProfile, AppError> {
    storage
        .load_connections(crypto)?
        .into_iter()
        .find(|connection| connection.id == connection_id)
        .ok_or_else(|| AppError::NotFound(format!("connection {connection_id} not found")))
}

/// 根据 open_session 请求解析连接；优先使用稳定 id，名称只做自然语言入口，重复时要求 agent 回退到 id。
fn find_connection_for_open_session(
    storage: &StorageService,
    crypto: &CryptoService,
    request: &OpenSessionRequest,
) -> Result<ConnectionProfile, AppError> {
    if let Some(connection_id) = trimmed_non_empty(request.connection_id.as_deref()) {
        return find_connection(storage, crypto, connection_id);
    }

    // 允许用户直接说“打开 28开发”，但名称不是稳定主键，所以重复名称必须显式报出候选 id。
    let connection_name =
        trimmed_non_empty(request.connection_name.as_deref()).ok_or_else(|| {
            AppError::Validation(
                "connectionId or connectionName is required; call myterminal_list_connections first when unsure".into(),
            )
        })?;
    let matches = storage
        .load_connections(crypto)?
        .into_iter()
        .filter(|connection| connection.name == connection_name)
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [connection] => Ok(connection.clone()),
        [] => Err(AppError::NotFound(format!(
            "connection name {connection_name} not found; call myterminal_list_connections and use connectionId"
        ))),
        _ => {
            let ids = matches
                .iter()
                .map(|connection| format!("{} ({})", connection.id, connection.host))
                .collect::<Vec<_>>()
                .join(", ");
            Err(AppError::Validation(format!(
                "connection name {connection_name} is ambiguous; use one of these connectionId values: {ids}"
            )))
        }
    }
}

fn connection_for_session(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    session_id: &str,
) -> Result<(AgentSession, ConnectionProfile), AppError> {
    let session = resolve_agent_session(runtime, storage, crypto, session_id)?;
    let connection = find_connection(storage, crypto, &session.connection_id)?;
    Ok((session, connection))
}

/// 解析远程工具传入的 sessionId。显式会话优先；不存在时把它作为连接 id 或唯一连接名称解析，
/// 并建立稳定的隐式逻辑会话。这样 MCP 客户端即使按需工具搜索没有发现 open_session，也能直接完成任务。
fn resolve_agent_session(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    session_id: &str,
) -> Result<AgentSession, AppError> {
    let selector = session_id.trim();
    if selector.is_empty() {
        return Err(AppError::Validation(
            "sessionId is required; use a connection id/name from myterminal_list_connections or a session id from myterminal_open_session".into(),
        ));
    }

    // 快路径只持有会话锁，不触发磁盘读取；绝大多数连续调用都会从这里返回。
    if let Some(session) = lock_sessions(runtime)?.get(selector).cloned() {
        return Ok(session);
    }

    let connection = find_connection_for_session_selector(storage, crypto, selector)?;
    let implicit_session = AgentSession {
        // 连接 id/名称本身作为稳定别名，后续调用无需从上一次文本响应中提取随机 UUID。
        id: selector.to_string(),
        connection_id: connection.id.clone(),
        title: format!("{}@{}", connection.username, connection.host),
        cwd: "~".into(),
        opened_at: now_rfc3339(),
    };

    // 并发请求可能同时解析同一连接；entry 保证最终共用先写入的逻辑会话。
    let mut sessions = lock_sessions(runtime)?;
    Ok(sessions
        .entry(selector.to_string())
        .or_insert(implicit_session)
        .clone())
}

/// 把远程工具的 sessionId 兜底解析为连接 id 或唯一名称；IP/主机名/用户名不参与匹配，
/// 避免模型猜测含义不稳定的标识。重复名称必须回退到 list_connections 返回的稳定 id。
fn find_connection_for_session_selector(
    storage: &StorageService,
    crypto: &CryptoService,
    selector: &str,
) -> Result<ConnectionProfile, AppError> {
    let connections = storage.load_connections(crypto)?;
    if let Some(connection) = connections
        .iter()
        .find(|connection| connection.id == selector)
    {
        return Ok(connection.clone());
    }

    let matches = connections
        .into_iter()
        .filter(|connection| connection.name == selector)
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [connection] => Ok(connection.clone()),
        [] => Err(AppError::NotFound(format!(
            "agent session or connection {selector} not found; call myterminal_list_connections and use connections[].id"
        ))),
        _ => {
            let ids = matches
                .iter()
                .map(|connection| format!("{} ({})", connection.id, connection.host))
                .collect::<Vec<_>>()
                .join(", ");
            Err(AppError::Validation(format!(
                "connection name {selector} is ambiguous; use one of these connection ids as sessionId: {ids}"
            )))
        }
    }
}

pub fn run_agent_command(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    settings: &AgentBridgeSettings,
    payload: &RunCommandRequest,
) -> Result<AgentCommandResult, AppError> {
    let command_lane = command_lane_for_session(runtime, &payload.session_id)?;
    // 同一 AI 会话的命令必须串行，避免多个 SSH exec 同时修改同一 cwd/文件状态造成 agent 侧顺序错乱。
    let _command_order_guard = command_lane
        .lock()
        .map_err(|_| AppError::Validation("agent bridge command lane is unavailable".into()))?;
    let (session, connection) =
        connection_for_session(runtime, storage, crypto, &payload.session_id)?;
    let cwd = payload.cwd.clone().unwrap_or_else(|| session.cwd.clone());
    let timeout = Duration::from_secs(
        payload
            .timeout_sec
            .unwrap_or(settings.default_timeout_sec as u64)
            .clamp(1, 3600),
    );

    // 优先在用户可见的终端标签里执行；拿不到可注入的终端时如实记录原因并回退隐藏通道。
    let fallback_reason = if settings.visible_execution {
        match run_agent_command_in_terminal(runtime, &session, payload, &cwd, timeout, settings) {
            Ok(result) => return Ok(result),
            Err(reason) => Some(reason.to_string()),
        }
    } else {
        Some("设置中已关闭“在终端中执行”".to_string())
    };

    let ssh_session = connect_ssh(&connection)?;
    let command = command_with_cwd(&payload.command, &cwd);
    let mut result = exec_agent_command(
        ssh_session,
        &session,
        command,
        payload.command.clone(),
        cwd,
        timeout,
        settings.max_output_bytes.max(1024),
    )?;
    result.fallback_reason = fallback_reason;
    Ok(result)
}

/// 可见执行无法进行的原因；一律转成中文说明返回给 agent 与用户，不静默降级。
#[derive(Debug)]
enum VisibleExecUnavailable {
    /// 应用未就绪（Broker 尚未拿到 AppHandle）。
    AppUnavailable,
    /// 该连接没有可用终端标签，且自动新开失败。
    NoTerminal(String),
    /// 终端 shell 不具备命令边界能力（bash < 4.4 且非 zsh、dash/fish 等）。
    NoCommandBoundary,
    /// 前台是全屏 TUI（vim/top 等），注入会被当作按键吃掉。
    AlternateScreen,
    /// 终端被用户输入或另一条 agent 命令占用，等待超时。
    Busy,
    /// 注入后等待命令开始标记超时，shell 可能已失去钩子。
    BeginTimeout,
}

impl std::fmt::Display for VisibleExecUnavailable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::AppUnavailable => "应用窗口尚未就绪",
            Self::NoTerminal(reason) => return write!(formatter, "无法打开终端标签：{reason}"),
            Self::NoCommandBoundary => "该终端的 Shell 不支持命令边界协议（需要 zsh 或 bash 4.4+）",
            Self::AlternateScreen => "终端前台正在运行全屏程序",
            Self::Busy => "终端正被使用中（用户正在输入或有命令在运行）",
            Self::BeginTimeout => "终端未响应命令开始标记",
        };
        formatter.write_str(message)
    }
}

/// 等待终端空闲可注入的最长时间；超时即回退隐藏通道，绝不打断用户正在敲的命令。
const VISIBLE_EXEC_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(3);
/// 新开标签后等待 shell 就绪（收到能力标记与提示符）的最长时间。
const VISIBLE_EXEC_READY_TIMEOUT: Duration = Duration::from_secs(20);
/// 注入命令后等待命令开始标记的最长时间。
const VISIBLE_EXEC_BEGIN_TIMEOUT: Duration = Duration::from_secs(10);
/// 用户最后一次按键后需静默多久才允许注入，避免与用户输入交错。
const VISIBLE_EXEC_USER_IDLE: Duration = Duration::from_millis(750);

/// 在用户可见的终端标签里执行一条 agent 命令，并精确回收 stdout 与退出码。
/// 任何一步不满足条件都返回 Err，由调用方回退隐藏通道——绝不为了“可见”而牺牲正确性。
fn run_agent_command_in_terminal(
    runtime: &AgentBridgeRuntime,
    session: &AgentSession,
    payload: &RunCommandRequest,
    cwd: &str,
    timeout: Duration,
    settings: &AgentBridgeSettings,
) -> Result<AgentCommandResult, VisibleExecUnavailable> {
    let app_handle = runtime
        .app_handle
        .lock()
        .ok()
        .and_then(|handle| handle.clone())
        .ok_or(VisibleExecUnavailable::AppUnavailable)?;
    let state = app_handle.state::<AppState>();

    let terminal_session_id = resolve_terminal_session(
        &state,
        &app_handle,
        &session.id,
        &session.connection_id,
    )?;

    let run_id = uuid::Uuid::new_v4().to_string();
    let started_at = now_rfc3339();
    // cwd 用子 shell 包裹，命令执行完不会改变用户终端所在目录，语义与隐藏通道一致。
    let wrapped = wrap_command_for_terminal(&payload.command, cwd);

    let outcome = {
        // RAII 租约保证任何提前返回、超时或 panic 都会把终端复位为空闲并解除捕获武装。
        let lease = TerminalExecLease::acquire(&state, &terminal_session_id)?;
        // 抢占成功后再打来源标记，避免抢不到终端时留下无意义的提示行。
        commands::announce_agent_command(
            &state,
            &app_handle,
            &terminal_session_id,
            &wrapped,
        );
        lease.run(&wrapped, timeout)?
    };

    let max_output_bytes = settings.max_output_bytes.max(1024);
    let mut stdout = outcome.captured;
    let mut truncated = outcome.truncated;
    if stdout.len() > max_output_bytes {
        // 按 UTF-8 边界裁剪到设置上限，避免把多字节字符切断。
        let mut cut = max_output_bytes;
        while cut > 0 && !stdout.is_char_boundary(cut) {
            cut -= 1;
        }
        stdout.truncate(cut);
        truncated = true;
    }

    let status = if outcome.aborted {
        "timeout"
    } else if outcome.exit_code.unwrap_or(0) != 0 {
        "failed"
    } else {
        "completed"
    };

    Ok(AgentCommandResult {
        run_id,
        session_id: session.id.clone(),
        connection_id: session.connection_id.clone(),
        command: payload.command.clone(),
        cwd: cwd.to_string(),
        status: status.to_string(),
        exit_code: outcome.exit_code,
        stdout,
        // 终端 PTY 天然合并 stdout 与 stderr，无法分离；如实留空而不是伪造内容。
        stderr: String::new(),
        truncated,
        started_at,
        finished_at: now_rfc3339(),
        execution_mode: "terminal".into(),
        terminal_session_id: Some(terminal_session_id),
        fallback_reason: None,
    })
}

/// 为一次可见执行挑选目标终端标签：优先沿用该 agent 会话上次用过的标签，
/// 其次选同连接中最近出现过提示符的已连接标签，都没有则自动新开一个并等待就绪。
fn resolve_terminal_session(
    state: &AppState,
    app_handle: &AppHandle,
    agent_session_id: &str,
    connection_id: &str,
) -> Result<String, VisibleExecUnavailable> {
    // 粘性绑定让同一 agent 会话的命令始终落在同一个标签，保持 shell 历史连贯。
    let bound = state
        .agent_terminal_bindings
        .lock()
        .ok()
        .and_then(|bindings| bindings.get(agent_session_id).cloned());

    if let Some(candidate) = bound {
        // 绑定标签仍属于该连接就继续用：即使此刻用户正在里面敲字，
        // acquire 会等一小会儿；等不到再由调用方回退隐藏通道，好过为同一会话到处开新标签。
        if terminal_session_is_usable(state, &candidate, connection_id) {
            return Ok(candidate);
        }
        // 绑定的标签已关闭或重连换了 id，惰性清理后重新挑选。
        if let Ok(mut bindings) = state.agent_terminal_bindings.lock() {
            bindings.remove(agent_session_id);
        }
    }

    if let Some(candidate) = pick_recent_terminal_session(state, connection_id) {
        bind_terminal_session(state, agent_session_id, &candidate);
        return Ok(candidate);
    }

    // 没有可用标签就自动开一个，并广播给前端立即显示，用户能看到 agent 为它开了哪个终端。
    let session = commands::start_ssh_session(state, app_handle, connection_id, true)
        .map_err(|error| VisibleExecUnavailable::NoTerminal(error.to_string()))?;
    wait_for_terminal_ready(state, &session.id)?;
    bind_terminal_session(state, agent_session_id, &session.id);
    Ok(session.id)
}

fn bind_terminal_session(state: &AppState, agent_session_id: &str, terminal_session_id: &str) {
    if let Ok(mut bindings) = state.agent_terminal_bindings.lock() {
        bindings.insert(
            agent_session_id.to_string(),
            terminal_session_id.to_string(),
        );
    }
}

/// 判断某个终端标签是否仍属于该连接且处于已连接状态。
/// 判断某个终端标签是否仍属于该连接且可承载可见执行。
///
/// 注意：`RuntimeSession.session.status` 是创建时的快照（"connecting"），
/// 后续状态只经输出队列推给前端，后端这份副本永远不会变成 "connected"。
/// 因此就绪与否必须看 shell 是否真的回传过能力标记与提示符，而不是看这个字段。
fn terminal_session_is_usable(state: &AppState, session_id: &str, connection_id: &str) -> bool {
    let Ok(sessions) = state.sessions.lock() else {
        return false;
    };
    let Some(runtime) = sessions.get(session_id) else {
        return false;
    };
    if runtime.session.connection_id != connection_id || runtime.session.kind != "ssh" {
        return false;
    }
    runtime
        .agent_pty
        .lock()
        .map(|pty| pty.command_boundary_ready && pty.last_prompt_at.is_some())
        .unwrap_or(false)
}

/// 该标签此刻能否立刻接受注入：停在提示符、没有正在跑的 agent 命令、
/// 不在全屏 TUI 里、用户当前行也没有半截内容。
/// 挑选目标标签时优先选满足这些条件的，避免选中用户正忙的标签后白等一轮超时。
fn terminal_session_is_idle_now(runtime: &RuntimeSession) -> bool {
    runtime
        .agent_pty
        .lock()
        .map(|pty| {
            pty.command_boundary_ready
                && pty.at_prompt
                && !pty.alternate_screen_active
                && !pty.user_line_dirty
                && pty.phase == AgentPtyPhase::Idle
        })
        .unwrap_or(false)
}

/// 在同一连接的已连接标签中挑选最近出现过提示符的一个。
/// 按提示符时间而非 HashMap 迭代顺序选择，保证多标签时行为稳定且贴近用户正在看的那个。
fn pick_recent_terminal_session(state: &AppState, connection_id: &str) -> Option<String> {
    let sessions = state.sessions.lock().ok()?;
    sessions
        .values()
        // 同上：不能用 session.status 判活，它是创建时快照且永远停在 "connecting"。
        .filter(|runtime| {
            runtime.session.kind == "ssh" && runtime.session.connection_id == connection_id
        })
        .filter_map(|runtime| {
            let pty = runtime.agent_pty.lock().ok()?;
            // 没上报过能力或还没出现提示符的标签不能承载可见执行，直接排除。
            if !pty.command_boundary_ready || pty.last_prompt_at.is_none() {
                return None;
            }
            drop(pty);
            // 空闲标签优先：用户正在该标签里跑命令或敲字时，宁可另开一个也不去打扰他。
            let idle = terminal_session_is_idle_now(runtime);
            let last_prompt_at = runtime.agent_pty.lock().ok()?.last_prompt_at;
            Some((idle, last_prompt_at, runtime.session.id.clone()))
        })
        // 先按“是否空闲”排序，同为空闲时取最近出现提示符的（多半是用户正看着的那个）。
        .max_by_key(|(idle, last_prompt_at, _)| (*idle, *last_prompt_at))
        .and_then(|(idle, _, session_id)| idle.then_some(session_id))
}

/// 等待新开标签完成 SSH 握手与 shell 注入：收到能力标记且出现过提示符才算就绪。
///
/// 只在循环开头取一次 Arc，之后全程只持有 agent_pty 锁等待 Condvar，
/// 绝不在持有 agent_pty 时再去锁 sessions——shell 线程正是按“先 sessions 后 agent_pty”
/// 的顺序推进状态，反向加锁会直接死锁。
fn wait_for_terminal_ready(
    state: &AppState,
    terminal_session_id: &str,
) -> Result<(), VisibleExecUnavailable> {
    let (agent_pty, signal) = terminal_agent_pty(state, terminal_session_id)
        .ok_or_else(|| VisibleExecUnavailable::NoTerminal("终端标签已关闭".into()))?;
    let deadline = Instant::now() + VISIBLE_EXEC_READY_TIMEOUT;
    let mut guard = agent_pty
        .lock()
        .map_err(|_| VisibleExecUnavailable::NoTerminal("终端状态不可用".into()))?;

    loop {
        if guard.command_boundary_ready && guard.last_prompt_at.is_some() {
            return Ok(());
        }

        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(VisibleExecUnavailable::NoCommandBoundary);
        }
        // Condvar 等待期间自动释放锁，shell 线程解析到能力标记或提示符时唤醒。
        let (next_guard, _timeout) = signal
            .wait_timeout(guard, remaining)
            .map_err(|_| VisibleExecUnavailable::NoTerminal("终端状态不可用".into()))?;
        guard = next_guard;
    }
}

/// 取出某个终端会话的占用状态与信号量；会话不存在时返回 None。
fn terminal_agent_pty(
    state: &AppState,
    terminal_session_id: &str,
) -> Option<(Arc<Mutex<AgentPtyState>>, Arc<Condvar>)> {
    let sessions = state.sessions.lock().ok()?;
    let runtime = sessions.get(terminal_session_id)?;
    Some((
        Arc::clone(&runtime.agent_pty),
        Arc::clone(&runtime.agent_pty_signal),
    ))
}

/// 一次可见执行的结果。
struct TerminalExecOutcome {
    exit_code: Option<i32>,
    captured: String,
    truncated: bool,
    /// 是否因超时被中止（已向终端发送 Ctrl+C）。
    aborted: bool,
}

/// 终端占用租约：构造时抢占，Drop 时无条件复位为空闲并解除捕获武装。
/// 有了它，超时、错误提前返回甚至 panic 都不会让用户的终端永久拒绝 agent 命令。
struct TerminalExecLease {
    agent_pty: Arc<Mutex<AgentPtyState>>,
    signal: Arc<Condvar>,
    control_tx: std::sync::mpsc::Sender<SessionControl>,
}

impl TerminalExecLease {
    /// 等待终端空闲并抢占：要求已连接、具备命令边界能力、不在全屏 TUI、
    /// 停在提示符上、用户当前行干净且已静默一小段时间。
    fn acquire(
        state: &AppState,
        terminal_session_id: &str,
    ) -> Result<Self, VisibleExecUnavailable> {
        let (agent_pty, signal, control_tx) = {
            let sessions = state
                .sessions
                .lock()
                .map_err(|_| VisibleExecUnavailable::Busy)?;
            let runtime = sessions
                .get(terminal_session_id)
                .ok_or_else(|| VisibleExecUnavailable::NoTerminal("终端标签已关闭".into()))?;
            (
                Arc::clone(&runtime.agent_pty),
                Arc::clone(&runtime.agent_pty_signal),
                runtime.control_tx.clone(),
            )
        };

        let deadline = Instant::now() + VISIBLE_EXEC_ACQUIRE_TIMEOUT;
        let mut guard = agent_pty.lock().map_err(|_| VisibleExecUnavailable::Busy)?;
        loop {
            if !guard.command_boundary_ready {
                return Err(VisibleExecUnavailable::NoCommandBoundary);
            }
            if guard.alternate_screen_active {
                return Err(VisibleExecUnavailable::AlternateScreen);
            }

            let user_idle = guard
                .last_user_input_at
                .map(|at| at.elapsed() >= VISIBLE_EXEC_USER_IDLE)
                .unwrap_or(true);
            // 必须是“此刻停在提示符”，而不是“历史上出现过提示符”：
            // 用户正在跑 tail -f / top 时前者为 false，注入会被前台程序吃掉。
            if guard.phase == AgentPtyPhase::Idle
                && guard.at_prompt
                && user_idle
                && !guard.user_line_dirty
            {
                guard.phase = AgentPtyPhase::AwaitingBegin;
                guard.active = Some(AgentPtyRun::default());
                break;
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(VisibleExecUnavailable::Busy);
            }
            let (next_guard, _timeout) = signal
                .wait_timeout(guard, remaining)
                .map_err(|_| VisibleExecUnavailable::Busy)?;
            guard = next_guard;
        }
        drop(guard);

        Ok(Self {
            agent_pty,
            signal,
            control_tx,
        })
    }

    /// 注入命令并等待其执行完毕；超时则发送 Ctrl+C 中止并返回已捕获的部分输出。
    fn run(
        &self,
        wrapped_command: &str,
        timeout: Duration,
    ) -> Result<TerminalExecOutcome, VisibleExecUnavailable> {
        // 先武装捕获，再写入命令：两条消息经同一控制通道，shell 线程内严格有序，
        // 保证 PS0 发出的开始标记一定落在武装之后。
        self.control_tx
            .send(SessionControl::SetAgentCapture(true))
            .map_err(|_| VisibleExecUnavailable::NoTerminal("终端已断开".into()))?;
        // 命令与回车合并成一条消息写入，避免与用户按键在 pending_input 中交错。
        self.control_tx
            .send(SessionControl::AgentInput(format!("{wrapped_command}\n")))
            .map_err(|_| VisibleExecUnavailable::NoTerminal("终端已断开".into()))?;

        let begin_deadline = Instant::now() + VISIBLE_EXEC_BEGIN_TIMEOUT;
        let run_deadline = Instant::now() + timeout;
        let mut guard = self
            .agent_pty
            .lock()
            .map_err(|_| VisibleExecUnavailable::Busy)?;
        let mut aborted = false;
        let mut abort_sent = false;

        loop {
            if guard.active.as_ref().is_some_and(|run| run.finished) {
                let run = guard.active.take().unwrap_or_default();
                return Ok(TerminalExecOutcome {
                    exit_code: run.exit_code,
                    captured: run.captured,
                    truncated: run.truncated,
                    aborted,
                });
            }

            let now = Instant::now();
            // 命令始终没开始执行，说明 shell 钩子已失效（例如命令自行覆盖了 PROMPT_COMMAND）。
            if guard.phase == AgentPtyPhase::AwaitingBegin && now >= begin_deadline {
                return Err(VisibleExecUnavailable::BeginTimeout);
            }

            if now >= run_deadline {
                if !abort_sent {
                    // 超时只发 Ctrl+C 打断当前命令，绝不关闭通道——那是用户的终端。
                    let _ = self.control_tx.send(SessionControl::AgentInput("\u{3}".into()));
                    abort_sent = true;
                    aborted = true;
                } else {
                    // 二次超时仍拿不到结束标记，返回已捕获部分，避免 MCP 调用永久挂起。
                    let run = guard.active.take().unwrap_or_default();
                    return Ok(TerminalExecOutcome {
                        exit_code: None,
                        captured: run.captured,
                        truncated: run.truncated,
                        aborted: true,
                    });
                }
            }

            let wait = if abort_sent {
                Duration::from_secs(2)
            } else {
                let until = run_deadline.min(if guard.phase == AgentPtyPhase::AwaitingBegin {
                    begin_deadline
                } else {
                    run_deadline
                });
                until
                    .saturating_duration_since(now)
                    .max(Duration::from_millis(20))
            };
            let (next_guard, _timeout) = self
                .signal
                .wait_timeout(guard, wait)
                .map_err(|_| VisibleExecUnavailable::Busy)?;
            guard = next_guard;
        }
    }
}

impl Drop for TerminalExecLease {
    fn drop(&mut self) {
        // 无条件解除武装并复位状态，保证异常路径也不会让终端卡在被占用状态。
        let _ = self
            .control_tx
            .send(SessionControl::SetAgentCapture(false));
        if let Ok(mut guard) = self.agent_pty.lock() {
            guard.phase = AgentPtyPhase::Idle;
            guard.active = None;
        }
        self.signal.notify_all();
    }
}

/// 把命令包进子 shell 并附带 cwd，保证执行完不改变用户终端的当前目录。
fn wrap_command_for_terminal(command: &str, cwd: &str) -> String {
    let trimmed_cwd = cwd.trim();
    if uses_default_shell_directory(trimmed_cwd) {
        format!("( {command} )")
    } else {
        format!("( cd {} && {command} )", shell_quote(trimmed_cwd))
    }
}

fn command_with_cwd(command: &str, cwd: &str) -> String {
    let trimmed_cwd = cwd.trim();
    if uses_default_shell_directory(trimmed_cwd) {
        command.to_string()
    } else {
        format!("cd {} && {}", shell_quote(trimmed_cwd), command)
    }
}

/// 只有空值和用户主目录占位符沿用会话默认目录；点目录也显式执行 cd，统一 cwd 包装语义。
fn uses_default_shell_directory(cwd: &str) -> bool {
    cwd.is_empty() || cwd == "~"
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn append_bounded(target: &mut Vec<u8>, input: &[u8], max_output_bytes: usize) -> bool {
    if target.len() >= max_output_bytes {
        return true;
    }
    let remaining = max_output_bytes - target.len();
    if input.len() > remaining {
        target.extend_from_slice(&input[..remaining]);
        true
    } else {
        target.extend_from_slice(input);
        false
    }
}

fn exec_agent_command(
    ssh_session: Session,
    session: &AgentSession,
    wrapped_command: String,
    original_command: String,
    cwd: String,
    timeout: Duration,
    max_output_bytes: usize,
) -> Result<AgentCommandResult, AppError> {
    let run_id = uuid::Uuid::new_v4().to_string();
    let started_at = now_rfc3339();
    let mut channel = ssh_session
        .channel_session()
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    channel
        .exec(&wrapped_command)
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    ssh_session.set_blocking(false);

    let started = Instant::now();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut truncated = false;
    let mut stdout_buffer = [0_u8; 8192];
    let mut stderr_buffer = [0_u8; 8192];
    let mut timed_out = false;

    loop {
        match channel.read(&mut stdout_buffer) {
            Ok(0) => {}
            Ok(size) => {
                truncated |= append_bounded(&mut stdout, &stdout_buffer[..size], max_output_bytes);
            }
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                ) => {}
            Err(error) => return Err(AppError::Io(error)),
        }

        {
            let mut stderr_stream = channel.stderr();
            match stderr_stream.read(&mut stderr_buffer) {
                Ok(0) => {}
                Ok(size) => {
                    truncated |=
                        append_bounded(&mut stderr, &stderr_buffer[..size], max_output_bytes);
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                    ) => {}
                Err(error) => return Err(AppError::Io(error)),
            }
        }

        if channel.eof() {
            break;
        }

        if started.elapsed() >= timeout {
            timed_out = true;
            let _ = channel.close();
            break;
        }

        thread::sleep(Duration::from_millis(30));
    }

    let _ = channel.wait_close();
    let exit_code = channel.exit_status().ok();
    let mut status = if timed_out { "timeout" } else { "completed" }.to_string();
    if !timed_out && exit_code.unwrap_or(0) != 0 {
        status = "failed".into();
    }

    Ok(AgentCommandResult {
        run_id,
        session_id: session.id.clone(),
        connection_id: session.connection_id.clone(),
        command: original_command,
        cwd,
        status,
        exit_code,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        truncated,
        started_at,
        finished_at: now_rfc3339(),
        // 本函数即隐藏通道本身；回退原因由调用方在决定回退时补充。
        execution_mode: "exec".into(),
        terminal_session_id: None,
        fallback_reason: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_command_keeps_dot_cwd_wrapper() {
        // 点目录也显式进入 cwd 包装；同一段包装代码同时用于实际执行和终端展示。
        assert_eq!(
            wrap_command_for_terminal("docker ps", "."),
            "( cd '.' && docker ps )"
        );
    }

    #[test]
    fn visible_command_keeps_explicit_cwd() {
        // 指定目录仍需在子 Shell 内切换，并正确引用包含空格的路径。
        assert_eq!(
            wrap_command_for_terminal("docker ps", "/opt/my app"),
            "( cd '/opt/my app' && docker ps )"
        );
    }

    #[test]
    fn sanitize_connection_drops_secrets() {
        let summary = sanitize_connection(ConnectionProfile {
            id: "c1".into(),
            protocol: "ssh".into(),
            name: "prod".into(),
            group_path: Some("ops/prod".into()),
            host: "10.0.0.2".into(),
            port: 22,
            username: "root".into(),
            auth_method: "password".into(),
            password: "secret".into(),
            private_key_path: Some("C:/key".into()),
            private_key_text: Some("PRIVATE".into()),
            passphrase: Some("pass".into()),
            // 脱敏测试只关注主连接凭据，跳板与代理使用空配置保持构造体完整。
            jump_hosts: Vec::new(),
            proxy: crate::models::SshProxyConfig::default(),
            note: Some("note".into()),
        });
        let serialized = serde_json::to_string(&summary).unwrap();
        assert!(serialized.contains("10.0.0.2"));
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("PRIVATE"));
        assert!(!serialized.contains("pass"));
    }

    #[test]
    fn group_tree_keeps_nested_groups() {
        let connections = vec![AgentConnectionSummary {
            id: "c1".into(),
            name: "web".into(),
            group_path: Some("prod/web".into()),
            host: "10.0.0.3".into(),
            port: 22,
            username: "root".into(),
            note: None,
        }];
        let tree = build_group_tree(&["prod".into(), "prod/web".into()], &connections);
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].children.len(), 1);
        assert_eq!(tree[0].children[0].connections.len(), 1);
    }

    #[test]
    fn auto_execute_allows_every_connection_when_enabled() {
        let settings = AgentBridgeSettings {
            enabled: true,
            auto_execute: true,
            allowed_connection_ids: vec!["safe".into()],
            default_timeout_sec: 60,
            max_output_bytes: 1024,
            // 审批策略与可见执行相互独立；这两个用例只验证白名单逻辑。
            visible_execution: true,
        };
        assert!(requests::should_auto_execute(&settings, "safe"));
        assert!(requests::should_auto_execute(&settings, "prod"));
    }

    #[test]
    fn auto_execute_off_uses_connection_allowlist() {
        let settings = AgentBridgeSettings {
            enabled: true,
            auto_execute: false,
            allowed_connection_ids: vec!["safe".into()],
            default_timeout_sec: 60,
            max_output_bytes: 1024,
            // 审批策略与可见执行相互独立；这两个用例只验证白名单逻辑。
            visible_execution: true,
        };
        assert!(requests::should_auto_execute(&settings, "safe"));
        assert!(!requests::should_auto_execute(&settings, "prod"));
    }

    #[test]
    fn command_lanes_are_scoped_to_agent_session() {
        let runtime = AgentBridgeRuntime::new();
        // 同一个 AI session 必须复用同一条命令 lane，确保并发命令按进入 lane 的顺序串行。
        let first = command_lane_for_session(&runtime, "session-a").unwrap();
        let second = command_lane_for_session(&runtime, "session-a").unwrap();
        assert!(Arc::ptr_eq(&first, &second));

        // 不同 AI session 即使指向同一台机器，也会使用不同 lane，允许不同 agent 并发执行。
        let other = command_lane_for_session(&runtime, "session-b").unwrap();
        assert!(!Arc::ptr_eq(&first, &other));

        // session 关闭后清理 lane，避免长时间运行的 MCP Bridge 积累已失效 session 锁。
        close_agent_session(&runtime, "session-a").unwrap();
        let replacement = command_lane_for_session(&runtime, "session-a").unwrap();
        assert!(!Arc::ptr_eq(&first, &replacement));
    }
}
