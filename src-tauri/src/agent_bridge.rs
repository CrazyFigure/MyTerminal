use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::{ErrorKind, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ssh2::{Session, Sftp};

use crate::{
    commands::connect_ssh,
    crypto::CryptoService,
    error::AppError,
    models::{AgentBridgeSettings, ConnectionProfile, RemoteFileEntry},
    storage::StorageService,
};

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
    pub tags: Vec<String>,
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
    #[serde(skip_serializing)]
    pub action: AgentAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionRequest {
    pub connection_id: String,
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
    port: u16,
    token: String,
    stop_flag: Arc<AtomicBool>,
}

#[derive(Debug, Clone)]
pub struct AgentBridgeRuntime {
    requests: Arc<Mutex<VecDeque<AgentBridgeRequest>>>,
    request_changed: Arc<Condvar>,
    sessions: Arc<Mutex<HashMap<String, AgentSession>>>,
    server: Arc<Mutex<Option<AgentBridgeServer>>>,
}

impl AgentBridgeRuntime {
    pub fn new() -> Self {
        Self {
            requests: Arc::new(Mutex::new(VecDeque::new())),
            request_changed: Arc::new(Condvar::new()),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            server: Arc::new(Mutex::new(None)),
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

fn write_discovery(storage: &StorageService, port: u16, token: &str) -> Result<(), AppError> {
    let discovery = AgentBridgeDiscovery {
        port,
        token: token.to_string(),
        started_at: now_rfc3339(),
    };
    fs::write(
        storage.agent_bridge_discovery_path(),
        serde_json::to_string_pretty(&discovery)?,
    )?;
    Ok(())
}

fn remove_discovery(storage: &StorageService) {
    let _ = fs::remove_file(storage.agent_bridge_discovery_path());
}

pub fn bridge_status(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    settings: &AgentBridgeSettings,
) -> Result<AgentBridgeStatus, AppError> {
    let server = lock_server(runtime)?;
    let (running, port, token) = server
        .as_ref()
        .map(|server| (true, Some(server.port), Some(server.token.clone())))
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
        cli_command,
        mcp_command,
    })
}

pub fn sync_server(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    settings: &AgentBridgeSettings,
) -> Result<(), AppError> {
    if settings.enabled {
        // Broker 线程持有设置快照；保存设置时重启监听，确保自动执行白名单和输出限制立即生效。
        if lock_server(runtime)?.is_some() {
            stop_server(runtime, storage)?;
        }
        start_server(runtime, storage, crypto, settings)?;
    } else {
        stop_server(runtime, storage)?;
    }
    Ok(())
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
    write_discovery(storage, port, &token)?;

    let stop_flag = Arc::new(AtomicBool::new(false));
    let server_state = AgentBridgeServer {
        port,
        token: token.clone(),
        stop_flag: Arc::clone(&stop_flag),
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
    let server = lock_server(runtime)?.take();
    if let Some(server) = server {
        server.stop_flag.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(("127.0.0.1", server.port));
    }
    close_all_agent_sessions(runtime)?;
    fail_waiting_requests(runtime, "MCP Bridge 已停止，请重新打开会话后再执行。")?;
    remove_discovery(storage);
    Ok(())
}

pub fn close_all_agent_sessions(runtime: &AgentBridgeRuntime) -> Result<bool, AppError> {
    lock_sessions(runtime)?.clear();
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
    Ok(())
}

pub fn list_requests(runtime: &AgentBridgeRuntime) -> Result<Vec<AgentBridgeRequest>, AppError> {
    Ok(lock_requests(runtime)?.iter().cloned().collect())
}

pub fn clear_finished_requests(runtime: &AgentBridgeRuntime) -> Result<bool, AppError> {
    let mut requests = lock_requests(runtime)?;
    requests.retain(|request| request.status == "pending" || request.status == "running");
    Ok(true)
}

pub fn reject_request(
    runtime: &AgentBridgeRuntime,
    request_id: &str,
    reason: Option<String>,
) -> Result<bool, AppError> {
    let mut requests = lock_requests(runtime)?;
    let request = requests
        .iter_mut()
        .find(|request| request.id == request_id)
        .ok_or_else(|| AppError::NotFound(format!("agent request {request_id} not found")))?;
    request.status = "rejected".into();
    request.error = Some(reason.unwrap_or_else(|| "rejected by user".into()));
    request.updated_at = now_rfc3339();
    request.logs.push("用户已拒绝执行。".into());
    runtime.request_changed.notify_all();
    Ok(true)
}

pub fn approve_request(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    settings: &AgentBridgeSettings,
    request_id: &str,
    edited_command: Option<String>,
) -> Result<bool, AppError> {
    let action = {
        let mut requests = lock_requests(runtime)?;
        let request = requests
            .iter_mut()
            .find(|request| request.id == request_id)
            .ok_or_else(|| AppError::NotFound(format!("agent request {request_id} not found")))?;

        if request.status != "pending" {
            return Err(AppError::Validation(format!(
                "agent request {request_id} is not pending"
            )));
        }

        if let (Some(command), AgentAction::RunCommand(payload)) = (
            edited_command.filter(|value| !value.trim().is_empty()),
            &mut request.action,
        ) {
            payload.command = command.clone();
            request.command = Some(command);
            request.logs.push("用户已修改命令后批准。".into());
        } else {
            request.logs.push("用户已批准执行。".into());
        }

        request.status = "running".into();
        request.updated_at = now_rfc3339();
        request.action.clone()
    };

    let runtime_clone = runtime.clone();
    let storage_clone = storage.clone();
    let crypto_clone = crypto.clone();
    let settings_clone = settings.clone();
    let request_id = request_id.to_string();
    thread::spawn(move || {
        let result = execute_action(
            &runtime_clone,
            &storage_clone,
            &crypto_clone,
            &settings_clone,
            &action,
        )
        .and_then(|value| serde_json::to_value(value).map_err(AppError::from));
        complete_request(&runtime_clone, &request_id, result);
    });

    Ok(true)
}

fn complete_request(
    runtime: &AgentBridgeRuntime,
    request_id: &str,
    result: Result<Value, AppError>,
) {
    if let Ok(mut requests) = lock_requests(runtime) {
        if let Some(request) = requests.iter_mut().find(|request| request.id == request_id) {
            match result {
                Ok(value) => {
                    request.status = "completed".into();
                    request.result = Some(value);
                    request.error = None;
                    request.logs.push("执行完成。".into());
                }
                Err(error) => {
                    request.status = "error".into();
                    request.error = Some(error.to_string());
                    request.logs.push(format!("执行失败：{error}"));
                }
            }
            request.updated_at = now_rfc3339();
        }
    }
    runtime.request_changed.notify_all();
}

fn wait_for_request_result(
    runtime: &AgentBridgeRuntime,
    request_id: &str,
) -> Result<Value, AppError> {
    let deadline = Instant::now() + Duration::from_secs(AGENT_BRIDGE_APPROVAL_WAIT_SEC);
    let mut requests = lock_requests(runtime)?;
    loop {
        if let Some(request) = requests.iter().find(|request| request.id == request_id) {
            match request.status.as_str() {
                "completed" => {
                    return request.result.clone().ok_or_else(|| {
                        AppError::Validation("agent request result is empty".into())
                    });
                }
                "rejected" | "error" => {
                    return Err(AppError::Validation(
                        request
                            .error
                            .clone()
                            .unwrap_or_else(|| "agent request failed".into()),
                    ));
                }
                _ => {}
            }
        } else {
            return Err(AppError::NotFound(format!(
                "agent request {request_id} not found"
            )));
        }

        let now = Instant::now();
        if now >= deadline {
            return Err(AppError::Validation(
                "agent request approval timed out".into(),
            ));
        }
        let remaining = deadline
            .saturating_duration_since(now)
            .min(Duration::from_secs(2));
        let (next_requests, _) = runtime
            .request_changed
            .wait_timeout(requests, remaining)
            .map_err(|_| {
                AppError::Validation("agent bridge request queue is unavailable".into())
            })?;
        requests = next_requests;
    }
}

fn push_trimmed_path(paths: &mut Vec<String>, value: Option<&str>) {
    if let Some(trimmed) = value.map(str::trim).filter(|value| !value.is_empty()) {
        paths.push(trimmed.to_string());
    }
}

fn request_upload_paths(payload: &FileUploadRequest) -> Vec<String> {
    let mut paths = Vec::new();
    // 先保留旧字段 localPath，再追加新字段 localPaths，方便旧 MCP 客户端平滑升级。
    push_trimmed_path(&mut paths, payload.local_path.as_deref());
    for path in &payload.local_paths {
        push_trimmed_path(&mut paths, Some(path));
    }
    paths
}

fn request_download_paths(payload: &FileDownloadRequest) -> Vec<String> {
    let mut paths = Vec::new();
    // 先保留旧字段 path，再追加新字段 paths，方便旧 MCP 客户端平滑升级。
    push_trimmed_path(&mut paths, payload.path.as_deref());
    for path in &payload.paths {
        push_trimmed_path(&mut paths, Some(path));
    }
    paths
}

fn request_first_upload_path(payload: &FileUploadRequest) -> Option<String> {
    request_upload_paths(payload).into_iter().next()
}

fn request_first_download_path(payload: &FileDownloadRequest) -> Option<String> {
    request_download_paths(payload).into_iter().next()
}

fn transfer_request_preview(action: &str, paths: &[String]) -> String {
    if paths.is_empty() {
        return format!("{action}：未提供路径。");
    }

    // 审批卡片只放有限路径，避免一次批量传输把底部面板撑得很长。
    let mut lines = vec![format!("{action}：{} 个路径。", paths.len())];
    for path in paths.iter().take(8) {
        lines.push(format!("- {path}"));
    }
    if paths.len() > 8 {
        lines.push(format!("... 另有 {} 个路径", paths.len() - 8));
    }
    lines.join("\n")
}

fn enqueue_request(
    runtime: &AgentBridgeRuntime,
    action: AgentAction,
    session: &AgentSession,
) -> Result<String, AppError> {
    let now = now_rfc3339();
    let (kind, command, path, new_path, preview) = match &action {
        AgentAction::RunCommand(payload) => (
            "run_command".to_string(),
            Some(payload.command.clone()),
            payload.cwd.clone(),
            None,
            None,
        ),
        AgentAction::FileWrite(payload) => (
            "file_write".to_string(),
            None,
            Some(payload.path.clone()),
            None,
            payload
                .content
                .as_ref()
                .map(|value| value.chars().take(240).collect::<String>())
                .or_else(|| {
                    payload
                        .content_base64
                        .as_ref()
                        .map(|_| "[base64 content]".into())
                }),
        ),
        AgentAction::FileUpload(payload) => (
            "file_upload".to_string(),
            None,
            request_first_upload_path(payload),
            payload
                .remote_path
                .clone()
                .or_else(|| payload.remote_dir.clone()),
            Some(transfer_request_preview(
                "上传本地文件或文件夹到远端",
                &request_upload_paths(payload),
            )),
        ),
        AgentAction::FileDownload(payload) => (
            "file_download".to_string(),
            None,
            request_first_download_path(payload),
            payload
                .local_path
                .clone()
                .or_else(|| payload.local_dir.clone()),
            Some(transfer_request_preview(
                "下载远端文件或文件夹到本地",
                &request_download_paths(payload),
            )),
        ),
        AgentAction::FileDelete(payload) => (
            "file_delete".to_string(),
            None,
            Some(payload.path.clone()),
            None,
            None,
        ),
        AgentAction::FileRename(payload) => (
            "file_rename".to_string(),
            None,
            Some(payload.path.clone()),
            Some(payload.new_path.clone()),
            None,
        ),
        AgentAction::FileMkdir(payload) => (
            "file_mkdir".to_string(),
            None,
            Some(payload.path.clone()),
            None,
            None,
        ),
    };
    let id = uuid::Uuid::new_v4().to_string();
    let mut requests = lock_requests(runtime)?;
    requests.push_front(AgentBridgeRequest {
        id: id.clone(),
        kind,
        status: "pending".into(),
        connection_id: session.connection_id.clone(),
        session_id: Some(session.id.clone()),
        title: session.title.clone(),
        command,
        path,
        new_path,
        content_preview: preview,
        logs: vec!["等待 GUI 审批。".into()],
        result: None,
        error: None,
        created_at: now.clone(),
        updated_at: now,
        action,
    });
    while requests.len() > AGENT_BRIDGE_HISTORY_LIMIT {
        requests.pop_back();
    }
    runtime.request_changed.notify_all();
    Ok(id)
}

fn should_auto_execute(settings: &AgentBridgeSettings, connection_id: &str) -> bool {
    // 自动执行开关开启时表示用户信任当前 MCP 客户端对全部连接执行；关闭时退回连接白名单。
    if settings.auto_execute {
        return true;
    }

    settings
        .allowed_connection_ids
        .iter()
        .any(|allowed| allowed == connection_id)
}

fn submit_action(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    settings: &AgentBridgeSettings,
    action: AgentAction,
) -> Result<Value, AppError> {
    let session = session_for_action(runtime, &action)?;
    if should_auto_execute(settings, &session.connection_id) {
        return execute_action(runtime, storage, crypto, settings, &action)
            .and_then(|value| serde_json::to_value(value).map_err(AppError::from));
    }

    let request_id = enqueue_request(runtime, action, &session)?;
    wait_for_request_result(runtime, &request_id)
}

fn session_for_action(
    runtime: &AgentBridgeRuntime,
    action: &AgentAction,
) -> Result<AgentSession, AppError> {
    let session_id = match action {
        AgentAction::RunCommand(payload) => &payload.session_id,
        AgentAction::FileWrite(payload) => &payload.session_id,
        AgentAction::FileUpload(payload) => &payload.session_id,
        AgentAction::FileDownload(payload) => &payload.session_id,
        AgentAction::FileDelete(payload) => &payload.session_id,
        AgentAction::FileRename(payload) => &payload.session_id,
        AgentAction::FileMkdir(payload) => &payload.session_id,
    };
    let sessions = lock_sessions(runtime)?;
    sessions
        .get(session_id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("agent session {session_id} not found")))
}

fn execute_action(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    settings: &AgentBridgeSettings,
    action: &AgentAction,
) -> Result<Value, AppError> {
    match action {
        AgentAction::RunCommand(payload) => serde_json::to_value(run_agent_command(
            runtime, storage, crypto, settings, payload,
        )?)
        .map_err(AppError::from),
        AgentAction::FileWrite(payload) => {
            write_agent_file(runtime, storage, crypto, payload)?;
            Ok(json!({ "ok": true }))
        }
        AgentAction::FileUpload(payload) => {
            serde_json::to_value(upload_agent_path(runtime, storage, crypto, payload)?)
                .map_err(AppError::from)
        }
        AgentAction::FileDownload(payload) => {
            serde_json::to_value(download_agent_path(runtime, storage, crypto, payload)?)
                .map_err(AppError::from)
        }
        AgentAction::FileDelete(payload) => {
            delete_agent_file(runtime, storage, crypto, payload)?;
            Ok(json!({ "ok": true }))
        }
        AgentAction::FileRename(payload) => {
            rename_agent_file(runtime, storage, crypto, payload)?;
            Ok(json!({ "ok": true }))
        }
        AgentAction::FileMkdir(payload) => {
            mkdir_agent_file(runtime, storage, crypto, payload)?;
            Ok(json!({ "ok": true }))
        }
    }
}

pub fn list_connections(
    storage: &StorageService,
    crypto: &CryptoService,
) -> Result<AgentConnectionList, AppError> {
    let connections = storage
        .load_connections(crypto)?
        .into_iter()
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
        tags: connection.tags,
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
    connection_id: &str,
) -> Result<AgentSession, AppError> {
    let connection = find_connection(storage, crypto, connection_id)?;
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
    Ok(true)
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

fn connection_for_session(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    session_id: &str,
) -> Result<(AgentSession, ConnectionProfile), AppError> {
    let session = lock_sessions(runtime)?
        .get(session_id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("agent session {session_id} not found")))?;
    let connection = find_connection(storage, crypto, &session.connection_id)?;
    Ok((session, connection))
}

pub fn run_agent_command(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    settings: &AgentBridgeSettings,
    payload: &RunCommandRequest,
) -> Result<AgentCommandResult, AppError> {
    let (session, connection) =
        connection_for_session(runtime, storage, crypto, &payload.session_id)?;
    let ssh_session = connect_ssh(&connection)?;
    let cwd = payload.cwd.clone().unwrap_or_else(|| session.cwd.clone());
    let timeout = Duration::from_secs(
        payload
            .timeout_sec
            .unwrap_or(settings.default_timeout_sec as u64)
            .clamp(1, 3600),
    );
    let command = command_with_cwd(&payload.command, &cwd);
    exec_agent_command(
        ssh_session,
        &session,
        command,
        payload.command.clone(),
        cwd,
        timeout,
        settings.max_output_bytes.max(1024),
    )
}

fn command_with_cwd(command: &str, cwd: &str) -> String {
    let trimmed_cwd = cwd.trim();
    if trimmed_cwd.is_empty() || trimmed_cwd == "~" {
        command.to_string()
    } else {
        format!("cd {} && {}", shell_quote(trimmed_cwd), command)
    }
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
    })
}

pub fn list_agent_files(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    payload: &FilePathRequest,
) -> Result<Vec<RemoteFileEntry>, AppError> {
    let (_session, connection) =
        connection_for_session(runtime, storage, crypto, &payload.session_id)?;
    let ssh_session = connect_ssh(&connection)?;
    let sftp = ssh_session
        .sftp()
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    let entries = sftp
        .readdir(Path::new(&payload.path))
        .map_err(|error| AppError::Ssh(error.to_string()))?;

    Ok(entries
        .into_iter()
        .filter_map(|(path, stat)| {
            let name = path.file_name()?.to_string_lossy().to_string();
            if name == "." || name == ".." {
                return None;
            }
            let remote_path = join_remote_path(&payload.path, &name);
            Some(RemoteFileEntry {
                name,
                path: remote_path,
                is_dir: stat_is_dir(&stat),
                is_symlink: stat_is_symlink(&stat),
                size: stat.size.unwrap_or(0),
                modified_at: stat.mtime.map(|mtime| {
                    chrono::DateTime::<Utc>::from_timestamp(mtime as i64, 0)
                        .unwrap_or_else(Utc::now)
                        .to_rfc3339()
                }),
                permissions: None,
                owner: stat.uid.map(|uid| uid.to_string()),
                group: stat.gid.map(|gid| gid.to_string()),
            })
        })
        .collect())
}

pub fn read_agent_file(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    payload: &FilePathRequest,
) -> Result<AgentFileReadResult, AppError> {
    let (_session, connection) =
        connection_for_session(runtime, storage, crypto, &payload.session_id)?;
    let ssh_session = connect_ssh(&connection)?;
    let sftp = ssh_session
        .sftp()
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    let mut file = sftp
        .open(Path::new(&payload.path))
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let size = bytes.len();
    match String::from_utf8(bytes) {
        Ok(content) => Ok(AgentFileReadResult {
            session_id: payload.session_id.clone(),
            path: payload.path.clone(),
            encoding: "utf-8".into(),
            content: Some(content),
            content_base64: None,
            size,
        }),
        Err(error) => Ok(AgentFileReadResult {
            session_id: payload.session_id.clone(),
            path: payload.path.clone(),
            encoding: "base64".into(),
            content: None,
            content_base64: Some(STANDARD.encode(error.into_bytes())),
            size,
        }),
    }
}

#[derive(Default)]
struct AgentTransferStats {
    files: usize,
    directories: usize,
    bytes: u64,
}

fn normalize_remote_path(path: &str) -> String {
    let normalized = path.trim().replace('\\', "/");
    if normalized.is_empty() {
        ".".into()
    } else {
        normalized
    }
}

fn remote_file_name(path: &str) -> Option<String> {
    normalize_remote_path(path)
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn sanitize_local_file_name(name: &str, fallback: &str) -> String {
    let sanitized = name
        .chars()
        .map(|character| {
            // Windows 下载目标不能包含这些保留字符；替换后仍保留原文件的大致可识别名称。
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>()
        .trim_matches(|character| matches!(character, ' ' | '.'))
        .to_string();
    if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized
    }
}

fn normalize_remote_relative_path(path: &str) -> Result<String, AppError> {
    let normalized = normalize_remote_path(path).trim_matches('/').to_string();
    if normalized.is_empty() {
        return Err(AppError::Validation(
            "remote path segment is required".into(),
        ));
    }

    let parts = normalized.split('/').collect::<Vec<_>>();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return Err(AppError::Validation(
            "remote relative path contains invalid segments".into(),
        ));
    }
    Ok(parts.join("/"))
}

fn resolve_agent_remote_path(sftp: &Sftp, path: &str) -> Result<String, AppError> {
    let normalized = normalize_remote_path(path);
    if normalized == "." || normalized == "~" {
        return sftp
            .realpath(Path::new("."))
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .map_err(|error| AppError::Ssh(error.to_string()));
    }

    if let Some(suffix) = normalized.strip_prefix("~/") {
        let home = sftp
            .realpath(Path::new("."))
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .map_err(|error| AppError::Ssh(error.to_string()))?;
        return Ok(join_remote_path(&home, suffix));
    }

    Ok(normalized)
}

fn resolve_agent_remote_dir(
    sftp: &Sftp,
    session: &AgentSession,
    remote_dir: Option<&str>,
) -> Result<String, AppError> {
    let requested = remote_dir.unwrap_or(&session.cwd);
    resolve_agent_remote_path(sftp, requested)
}

fn remote_parent_path(path: &str) -> Option<String> {
    let normalized = normalize_remote_path(path);
    let trimmed = normalized.trim_end_matches('/');
    let (parent, _) = trimmed.rsplit_once('/')?;
    if parent.is_empty() && trimmed.starts_with('/') {
        Some("/".into())
    } else if parent.is_empty() {
        Some(".".into())
    } else {
        Some(parent.to_string())
    }
}

fn ensure_remote_directory(sftp: &Sftp, path: &str) -> Result<(), AppError> {
    let normalized = normalize_remote_path(path);
    let trimmed = normalized.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == "/" {
        return Ok(());
    }

    let mut current = if trimmed.starts_with('/') {
        "/".to_string()
    } else {
        String::new()
    };
    for part in trimmed
        .trim_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
    {
        if part == "." {
            continue;
        }
        if part == ".." {
            return Err(AppError::Validation(
                "remote directory cannot contain ..".into(),
            ));
        }

        current = if current.is_empty() {
            part.to_string()
        } else if current == "/" {
            format!("/{part}")
        } else {
            format!("{current}/{part}")
        };

        match sftp.stat(Path::new(&current)) {
            Ok(stat) if stat_is_dir(&stat) => continue,
            Ok(_) => {
                return Err(AppError::Validation(format!(
                    "remote path {current} exists and is not a directory"
                )))
            }
            Err(_) => sftp
                .mkdir(Path::new(&current), 0o755)
                .map_err(|error| AppError::Ssh(error.to_string()))?,
        }
    }

    Ok(())
}

fn upload_local_file_to_remote(
    sftp: &Sftp,
    local_path: &Path,
    remote_path: &str,
    stats: &mut AgentTransferStats,
) -> Result<(), AppError> {
    if let Some(parent) = remote_parent_path(remote_path) {
        ensure_remote_directory(sftp, &parent)?;
    }

    let mut local_file = fs::File::open(local_path)?;
    let mut remote_file = sftp
        .create(Path::new(remote_path))
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    let copied = std::io::copy(&mut local_file, &mut remote_file)?;
    remote_file.flush()?;
    stats.files += 1;
    stats.bytes = stats.bytes.saturating_add(copied);
    Ok(())
}

fn upload_local_directory_to_remote(
    sftp: &Sftp,
    local_dir: &Path,
    remote_dir: &str,
    stats: &mut AgentTransferStats,
) -> Result<(), AppError> {
    ensure_remote_directory(sftp, remote_dir)?;
    stats.directories += 1;
    for entry in fs::read_dir(local_dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let local_child = entry.path();
        let child_name = entry.file_name().to_string_lossy().to_string();
        let remote_child =
            join_remote_path(remote_dir, &normalize_remote_relative_path(&child_name)?);

        if file_type.is_dir() {
            upload_local_directory_to_remote(sftp, &local_child, &remote_child, stats)?;
        } else if file_type.is_file() {
            upload_local_file_to_remote(sftp, &local_child, &remote_child, stats)?;
        }
        // 本地符号链接和特殊文件不上传，避免把链接目标或设备文件误传到远端。
    }
    Ok(())
}

fn download_remote_file_to_local(
    sftp: &Sftp,
    remote_path: &str,
    local_path: &Path,
    stats: &mut AgentTransferStats,
) -> Result<(), AppError> {
    if let Some(parent) = local_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut remote_file = sftp
        .open(Path::new(remote_path))
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    let mut local_file = fs::File::create(local_path)?;
    let copied = std::io::copy(&mut remote_file, &mut local_file)?;
    local_file.flush()?;
    stats.files += 1;
    stats.bytes = stats.bytes.saturating_add(copied);
    Ok(())
}

fn download_remote_directory_to_local(
    sftp: &Sftp,
    remote_dir: &str,
    local_dir: &Path,
    stats: &mut AgentTransferStats,
) -> Result<(), AppError> {
    fs::create_dir_all(local_dir)?;
    stats.directories += 1;
    let entries = sftp
        .readdir(Path::new(remote_dir))
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    for (entry_path, stat) in entries {
        let Some(name) = entry_path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if name == "." || name == ".." {
            continue;
        }

        let remote_child = entry_path.to_string_lossy().replace('\\', "/");
        let local_child = local_dir.join(sanitize_local_file_name(name, "item"));
        let target_stat = if stat_is_symlink(&stat) {
            sftp.stat(&entry_path).ok()
        } else {
            None
        };
        let is_directory = target_stat
            .as_ref()
            .map(stat_is_dir)
            .unwrap_or_else(|| stat_is_dir(&stat));

        if is_directory && !stat_is_symlink(&stat) {
            download_remote_directory_to_local(sftp, &remote_child, &local_child, stats)?;
        } else if !(stat_is_symlink(&stat) && is_directory) {
            // 符号链接目录不递归跟随，避免远端循环链接导致下载无限展开。
            download_remote_file_to_local(sftp, &remote_child, &local_child, stats)?;
        }
    }
    Ok(())
}

fn collect_upload_sources(payload: &FileUploadRequest) -> Result<Vec<PathBuf>, AppError> {
    let mut seen = HashSet::new();
    let mut sources = Vec::new();
    for path in request_upload_paths(payload) {
        let source = PathBuf::from(&path);
        // 批量参数可能由 MCP 客户端合并生成，按字符串去重即可避免重复上传同一路径。
        if seen.insert(source.to_string_lossy().to_string()) {
            sources.push(source);
        }
    }

    if sources.is_empty() {
        return Err(AppError::Validation(
            "localPath or localPaths is required".into(),
        ));
    }
    Ok(sources)
}

fn collect_download_sources(payload: &FileDownloadRequest) -> Result<Vec<String>, AppError> {
    let mut seen = HashSet::new();
    let mut sources = Vec::new();
    for path in request_download_paths(payload) {
        // 远端路径先按用户输入去重，后续仍会经过 resolve_agent_remote_path 处理 ~ 和相对路径。
        if seen.insert(path.clone()) {
            sources.push(path);
        }
    }

    if sources.is_empty() {
        return Err(AppError::Validation("path or paths is required".into()));
    }
    Ok(sources)
}

fn unique_agent_local_destination(destination: PathBuf, used: &mut HashSet<PathBuf>) -> PathBuf {
    if !destination.exists() && used.insert(destination.clone()) {
        return destination;
    }

    let parent = destination
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(PathBuf::new);
    let stem = destination
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let extension = destination.extension().and_then(|value| value.to_str());

    // 批量下载同名文件/文件夹时追加 Windows 常见的 " (n)" 后缀，避免覆盖用户已有内容。
    for index in 1..10_000 {
        let file_name = if let Some(extension) = extension {
            format!("{stem} ({index}).{extension}")
        } else {
            format!("{stem} ({index})")
        };
        let candidate = parent.join(file_name);
        if !candidate.exists() && used.insert(candidate.clone()) {
            return candidate;
        }
    }

    destination
}

fn upload_agent_path(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    payload: &FileUploadRequest,
) -> Result<AgentFileTransferResult, AppError> {
    let (session, connection) =
        connection_for_session(runtime, storage, crypto, &payload.session_id)?;
    let local_sources = collect_upload_sources(payload)?;
    if local_sources.len() > 1
        && payload
            .remote_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some()
    {
        return Err(AppError::Validation(
            "remotePath only supports a single localPath; use remoteDir for batch upload".into(),
        ));
    }

    let ssh_session = connect_ssh(&connection)?;
    let sftp = ssh_session
        .sftp()
        .map_err(|error| AppError::Ssh(error.to_string()))?;

    let explicit_remote_path = payload
        .remote_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let resolved_remote_dir = if explicit_remote_path.is_none() {
        Some(resolve_agent_remote_dir(
            &sftp,
            &session,
            payload.remote_dir.as_deref(),
        )?)
    } else {
        None
    };

    let mut stats = AgentTransferStats::default();
    let mut source_paths = Vec::new();
    let mut destination_paths = Vec::new();
    for local_source in local_sources {
        let metadata = fs::symlink_metadata(&local_source)?;
        let remote_destination = if let Some(remote_path) = explicit_remote_path {
            resolve_agent_remote_path(&sftp, remote_path)?
        } else {
            let source_name = local_source
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| AppError::Validation("local path must have a file name".into()))?;
            let remote_dir = resolved_remote_dir
                .as_deref()
                .ok_or_else(|| AppError::Validation("remoteDir is unavailable".into()))?;
            join_remote_path(&remote_dir, &normalize_remote_relative_path(source_name)?)
        };

        if metadata.is_dir() {
            upload_local_directory_to_remote(
                &sftp,
                &local_source,
                &remote_destination,
                &mut stats,
            )?;
        } else if metadata.is_file() {
            upload_local_file_to_remote(&sftp, &local_source, &remote_destination, &mut stats)?;
        } else {
            return Err(AppError::Validation(
                "local path must be a file or directory".into(),
            ));
        }

        source_paths.push(local_source.to_string_lossy().to_string());
        destination_paths.push(remote_destination);
    }

    Ok(AgentFileTransferResult {
        session_id: payload.session_id.clone(),
        source_path: source_paths.first().cloned().unwrap_or_default(),
        destination_path: destination_paths.first().cloned().unwrap_or_default(),
        source_paths,
        destination_paths,
        files: stats.files,
        directories: stats.directories,
        bytes: stats.bytes,
    })
}

fn download_agent_path(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    payload: &FileDownloadRequest,
) -> Result<AgentFileTransferResult, AppError> {
    let (_session, connection) =
        connection_for_session(runtime, storage, crypto, &payload.session_id)?;
    let requested_sources = collect_download_sources(payload)?;
    let is_batch_download = requested_sources.len() > 1;
    if requested_sources.len() > 1
        && payload
            .local_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some()
    {
        return Err(AppError::Validation(
            "localPath only supports a single path; use localDir for batch download".into(),
        ));
    }

    let ssh_session = connect_ssh(&connection)?;
    let sftp = ssh_session
        .sftp()
        .map_err(|error| AppError::Ssh(error.to_string()))?;

    let explicit_local_path = payload
        .local_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let base_dir = if explicit_local_path.is_none() {
        Some(
            payload
                .local_dir
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| storage.downloads_dir_path()),
        )
    } else {
        None
    };

    let mut stats = AgentTransferStats::default();
    let mut used_destinations = HashSet::new();
    let mut source_paths = Vec::new();
    let mut destination_paths = Vec::new();
    for requested_source in requested_sources {
        let remote_source = resolve_agent_remote_path(&sftp, &requested_source)?;
        let remote_stat = sftp
            .stat(Path::new(&remote_source))
            .map_err(|error| AppError::Ssh(error.to_string()))?;

        let mut local_destination = if let Some(local_path) = explicit_local_path {
            PathBuf::from(local_path)
        } else {
            let base_dir = base_dir
                .as_ref()
                .ok_or_else(|| AppError::Validation("localDir is unavailable".into()))?;
            let name = remote_file_name(&remote_source).unwrap_or_else(|| "download".into());
            base_dir.join(sanitize_local_file_name(&name, "download"))
        };
        if explicit_local_path.is_none() && is_batch_download {
            local_destination =
                unique_agent_local_destination(local_destination, &mut used_destinations);
        }

        if stat_is_dir(&remote_stat) {
            download_remote_directory_to_local(
                &sftp,
                &remote_source,
                &local_destination,
                &mut stats,
            )?;
        } else {
            download_remote_file_to_local(&sftp, &remote_source, &local_destination, &mut stats)?;
        }

        source_paths.push(remote_source);
        destination_paths.push(local_destination.to_string_lossy().to_string());
    }

    Ok(AgentFileTransferResult {
        session_id: payload.session_id.clone(),
        source_path: source_paths.first().cloned().unwrap_or_default(),
        destination_path: destination_paths.first().cloned().unwrap_or_default(),
        source_paths,
        destination_paths,
        files: stats.files,
        directories: stats.directories,
        bytes: stats.bytes,
    })
}

fn delete_agent_path_with_sftp(sftp: &Sftp, path: &str) -> Result<(), AppError> {
    let stat = sftp
        .lstat(Path::new(path))
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    if stat_is_symlink(&stat) {
        sftp.unlink(Path::new(path))
            .map_err(|error| AppError::Ssh(error.to_string()))?;
    } else if stat_is_dir(&stat) {
        // SFTP rmdir 只接受空目录；MCP 删除目录同样先递归清空，保持和界面文件管理一致。
        let entries = sftp
            .readdir(Path::new(path))
            .map_err(|error| AppError::Ssh(error.to_string()))?;
        for (entry_path, _entry_stat) in entries {
            let Some(name) = entry_path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if name == "." || name == ".." {
                continue;
            }

            let child_path = entry_path.to_string_lossy().replace('\\', "/");
            delete_agent_path_with_sftp(sftp, &child_path)?;
        }
        sftp.rmdir(Path::new(path))
            .map_err(|error| AppError::Ssh(error.to_string()))?;
    } else {
        sftp.unlink(Path::new(path))
            .map_err(|error| AppError::Ssh(error.to_string()))?;
    }

    Ok(())
}

fn write_agent_file(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    payload: &FileWriteRequest,
) -> Result<(), AppError> {
    let (_session, connection) =
        connection_for_session(runtime, storage, crypto, &payload.session_id)?;
    let ssh_session = connect_ssh(&connection)?;
    let sftp = ssh_session
        .sftp()
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    let remote_path = resolve_agent_remote_path(&sftp, &payload.path)?;
    let bytes = if let Some(content) = &payload.content {
        content.as_bytes().to_vec()
    } else if let Some(content_base64) = &payload.content_base64 {
        STANDARD
            .decode(content_base64)
            .map_err(|error| AppError::Validation(format!("invalid base64 content: {error}")))?
    } else {
        Vec::new()
    };
    if let Some(parent) = remote_parent_path(&remote_path) {
        ensure_remote_directory(&sftp, &parent)?;
    }
    let mut file = sftp
        .create(Path::new(&remote_path))
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    file.write_all(&bytes)?;
    Ok(())
}

fn delete_agent_file(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    payload: &FilePathRequest,
) -> Result<(), AppError> {
    let (_session, connection) =
        connection_for_session(runtime, storage, crypto, &payload.session_id)?;
    let ssh_session = connect_ssh(&connection)?;
    let sftp = ssh_session
        .sftp()
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    let remote_path = resolve_agent_remote_path(&sftp, &payload.path)?;
    delete_agent_path_with_sftp(&sftp, &remote_path)
}

fn rename_agent_file(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    payload: &FileRenameRequest,
) -> Result<(), AppError> {
    let (_session, connection) =
        connection_for_session(runtime, storage, crypto, &payload.session_id)?;
    let ssh_session = connect_ssh(&connection)?;
    let sftp = ssh_session
        .sftp()
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    let remote_path = resolve_agent_remote_path(&sftp, &payload.path)?;
    let new_remote_path = resolve_agent_remote_path(&sftp, &payload.new_path)?;
    sftp.rename(Path::new(&remote_path), Path::new(&new_remote_path), None)
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    Ok(())
}

fn mkdir_agent_file(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    payload: &FilePathRequest,
) -> Result<(), AppError> {
    let (_session, connection) =
        connection_for_session(runtime, storage, crypto, &payload.session_id)?;
    let ssh_session = connect_ssh(&connection)?;
    let sftp = ssh_session
        .sftp()
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    // MCP mkdir 支持多级目录，便于文件夹上传前由外部工具显式准备目标路径。
    let remote_path = resolve_agent_remote_path(&sftp, &payload.path)?;
    ensure_remote_directory(&sftp, &remote_path)?;
    Ok(())
}

fn join_remote_path(remote_dir: &str, file_name: &str) -> String {
    let base = normalize_remote_path(remote_dir);
    let name = normalize_remote_path(file_name)
        .trim_matches('/')
        .to_string();
    if base.is_empty() || base == "." {
        name
    } else if base == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", base.trim_end_matches('/'), name)
    }
}

fn stat_is_dir(stat: &ssh2::FileStat) -> bool {
    // SFTP perm 使用 POSIX mode 位；Windows 端 libc 不一定暴露这些常量，因此这里固定使用协议语义值。
    const S_IFMT: u32 = 0o170000;
    const S_IFDIR: u32 = 0o040000;
    stat.perm
        .map(|perm| (perm & S_IFMT) == S_IFDIR)
        .unwrap_or(false)
}

fn stat_is_symlink(stat: &ssh2::FileStat) -> bool {
    // 符号链接同样通过 POSIX mode 判断，避免平台条件编译影响远端文件识别。
    const S_IFMT: u32 = 0o170000;
    const S_IFLNK: u32 = 0o120000;
    stat.perm
        .map(|perm| (perm & S_IFMT) == S_IFLNK)
        .unwrap_or(false)
}

fn decode_request_body<T: for<'de> Deserialize<'de>>(body: &str) -> Result<T, AppError> {
    serde_json::from_str(body).map_err(AppError::from)
}

fn handle_http_request(
    stream: &mut TcpStream,
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    settings: &AgentBridgeSettings,
    token: &str,
) -> Result<(), AppError> {
    let request = read_http_request(stream)?;
    if !request_is_authorized(&request, token) {
        return write_http_json(
            stream,
            401,
            &json!({ "ok": false, "error": "unauthorized" }),
        );
    }

    let result = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/status") => {
            let status = bridge_status(runtime, storage, settings)?;
            serde_json::to_value(status).map_err(AppError::from)
        }
        ("GET", "/connections") => {
            let connections = list_connections(storage, crypto)?;
            serde_json::to_value(connections).map_err(AppError::from)
        }
        ("POST", "/sessions/open") => {
            let payload: OpenSessionRequest = decode_request_body(&request.body)?;
            let session = open_agent_session(runtime, storage, crypto, &payload.connection_id)?;
            serde_json::to_value(session).map_err(AppError::from)
        }
        ("POST", "/sessions/close") => {
            let payload: CloseSessionRequest = decode_request_body(&request.body)?;
            close_agent_session(runtime, &payload.session_id)?;
            Ok(json!({ "ok": true }))
        }
        ("POST", "/exec") => {
            let payload: RunCommandRequest = decode_request_body(&request.body)?;
            submit_action(
                runtime,
                storage,
                crypto,
                settings,
                AgentAction::RunCommand(payload),
            )
        }
        ("POST", "/files/list") => {
            let payload: FilePathRequest = decode_request_body(&request.body)?;
            serde_json::to_value(list_agent_files(runtime, storage, crypto, &payload)?)
                .map_err(AppError::from)
        }
        ("POST", "/files/read") => {
            let payload: FilePathRequest = decode_request_body(&request.body)?;
            serde_json::to_value(read_agent_file(runtime, storage, crypto, &payload)?)
                .map_err(AppError::from)
        }
        ("POST", "/files/write") => {
            let payload: FileWriteRequest = decode_request_body(&request.body)?;
            submit_action(
                runtime,
                storage,
                crypto,
                settings,
                AgentAction::FileWrite(payload),
            )
        }
        ("POST", "/files/upload") => {
            let payload: FileUploadRequest = decode_request_body(&request.body)?;
            submit_action(
                runtime,
                storage,
                crypto,
                settings,
                AgentAction::FileUpload(payload),
            )
        }
        ("POST", "/files/download") => {
            let payload: FileDownloadRequest = decode_request_body(&request.body)?;
            submit_action(
                runtime,
                storage,
                crypto,
                settings,
                AgentAction::FileDownload(payload),
            )
        }
        ("POST", "/files/delete") => {
            let payload: FilePathRequest = decode_request_body(&request.body)?;
            submit_action(
                runtime,
                storage,
                crypto,
                settings,
                AgentAction::FileDelete(payload),
            )
        }
        ("POST", "/files/rename") => {
            let payload: FileRenameRequest = decode_request_body(&request.body)?;
            submit_action(
                runtime,
                storage,
                crypto,
                settings,
                AgentAction::FileRename(payload),
            )
        }
        ("POST", "/files/mkdir") => {
            let payload: FilePathRequest = decode_request_body(&request.body)?;
            submit_action(
                runtime,
                storage,
                crypto,
                settings,
                AgentAction::FileMkdir(payload),
            )
        }
        _ => Err(AppError::NotFound(format!(
            "{} {}",
            request.method, request.path
        ))),
    };

    match result {
        Ok(value) => write_http_json(stream, 200, &json!({ "ok": true, "data": value })),
        Err(error) => write_http_json(
            stream,
            400,
            &json!({ "ok": false, "error": error.to_string() }),
        ),
    }
}

#[derive(Debug)]
struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: String,
}

fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, AppError> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let size = stream.read(&mut buffer)?;
        if size == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..size]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }

    let header_end = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| AppError::Validation("invalid http request".into()))?;
    let header_text = String::from_utf8_lossy(&bytes[..header_end]).into_owned();
    let mut lines = header_text.lines();
    let request_line = lines
        .next()
        .ok_or_else(|| AppError::Validation("missing http request line".into()))?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let headers = lines
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            Some((key.trim().to_ascii_lowercase(), value.trim().to_string()))
        })
        .collect::<HashMap<_, _>>();
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let body_start = header_end + 4;
    while bytes.len().saturating_sub(body_start) < content_length {
        let size = stream.read(&mut buffer)?;
        if size == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..size]);
    }
    let body_end = body_start + content_length.min(bytes.len().saturating_sub(body_start));
    let body = String::from_utf8_lossy(&bytes[body_start..body_end]).into_owned();

    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn request_is_authorized(request: &HttpRequest, token: &str) -> bool {
    request
        .headers
        .get("authorization")
        .map(|value| value == &format!("Bearer {token}"))
        .unwrap_or(false)
}

fn write_http_json(stream: &mut TcpStream, status: u16, body: &Value) -> Result<(), AppError> {
    let body_text = serde_json::to_string(body)?;
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Internal Server Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body_text.as_bytes().len(),
        body_text
    );
    stream.write_all(response.as_bytes())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_connection_drops_secrets() {
        let summary = sanitize_connection(ConnectionProfile {
            id: "c1".into(),
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
            note: Some("note".into()),
            tags: vec!["prod".into()],
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
            tags: Vec::new(),
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
        };
        assert!(should_auto_execute(&settings, "safe"));
        assert!(should_auto_execute(&settings, "prod"));
    }

    #[test]
    fn auto_execute_off_uses_connection_allowlist() {
        let settings = AgentBridgeSettings {
            enabled: true,
            auto_execute: false,
            allowed_connection_ids: vec!["safe".into()],
            default_timeout_sec: 60,
            max_output_bytes: 1024,
        };
        assert!(should_auto_execute(&settings, "safe"));
        assert!(!should_auto_execute(&settings, "prod"));
    }
}
