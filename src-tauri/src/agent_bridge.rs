use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{ErrorKind, Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
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
use ssh2::Session;

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
pub struct FileRenameRequest {
    pub session_id: String,
    pub path: String,
    pub new_path: String,
}

#[derive(Debug, Clone)]
pub enum AgentAction {
    RunCommand(RunCommandRequest),
    FileWrite(FileWriteRequest),
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
    remove_discovery(storage);
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
    settings.auto_execute
        && settings
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
    let bytes = if let Some(content) = &payload.content {
        content.as_bytes().to_vec()
    } else if let Some(content_base64) = &payload.content_base64 {
        STANDARD
            .decode(content_base64)
            .map_err(|error| AppError::Validation(format!("invalid base64 content: {error}")))?
    } else {
        Vec::new()
    };
    let mut file = sftp
        .create(Path::new(&payload.path))
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
    let stat = sftp
        .stat(Path::new(&payload.path))
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    if stat_is_dir(&stat) {
        sftp.rmdir(Path::new(&payload.path))
            .map_err(|error| AppError::Ssh(error.to_string()))?;
    } else {
        sftp.unlink(Path::new(&payload.path))
            .map_err(|error| AppError::Ssh(error.to_string()))?;
    }
    Ok(())
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
    sftp.rename(Path::new(&payload.path), Path::new(&payload.new_path), None)
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
    sftp.mkdir(Path::new(&payload.path), 0o755)
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    Ok(())
}

fn join_remote_path(remote_dir: &str, file_name: &str) -> String {
    let base = remote_dir.trim_end_matches('/');
    if base.is_empty() || base == "." {
        file_name.to_string()
    } else if base == "/" {
        format!("/{file_name}")
    } else {
        format!("{base}/{file_name}")
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
    fn auto_execute_requires_enabled_connection() {
        let settings = AgentBridgeSettings {
            enabled: true,
            auto_execute: true,
            allowed_connection_ids: vec!["safe".into()],
            default_timeout_sec: 60,
            max_output_bytes: 1024,
        };
        assert!(should_auto_execute(&settings, "safe"));
        assert!(!should_auto_execute(&settings, "prod"));
    }
}
