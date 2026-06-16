use std::{
    fs,
    io::ErrorKind,
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, MutexGuard,
    },
    thread,
    time::Duration,
};

use rand::RngCore;
use serde_json::json;

use crate::{
    domain::entities::now_rfc3339, domain::entities::AgentBridgeSettings, error::AppError,
    infrastructure::crypto::CryptoService, infrastructure::persistence::StorageService,
};

use super::server::{handle_http_request, write_http_json};
use super::types::*;

#[derive(Debug, Clone)]
pub struct AgentBridgeRuntime {
    pub requests: Arc<Mutex<std::collections::VecDeque<AgentBridgeRequest>>>,
    pub request_changed: Arc<Condvar>,
    pub sessions: Arc<Mutex<std::collections::HashMap<String, AgentSession>>>,
    pub(crate) server: Arc<Mutex<Option<AgentBridgeServer>>>,
}

impl AgentBridgeRuntime {
    pub fn new() -> Self {
        Self {
            requests: Arc::new(Mutex::new(std::collections::VecDeque::new())),
            request_changed: Arc::new(Condvar::new()),
            sessions: Arc::new(Mutex::new(std::collections::HashMap::new())),
            server: Arc::new(Mutex::new(None)),
        }
    }
}

impl Default for AgentBridgeRuntime {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) fn lock_requests<'a>(
    runtime: &'a AgentBridgeRuntime,
) -> Result<MutexGuard<'a, std::collections::VecDeque<AgentBridgeRequest>>, AppError> {
    runtime
        .requests
        .lock()
        .map_err(|_| AppError::Validation("agent bridge request queue is unavailable".into()))
}

pub(crate) fn lock_sessions<'a>(
    runtime: &'a AgentBridgeRuntime,
) -> Result<MutexGuard<'a, std::collections::HashMap<String, AgentSession>>, AppError> {
    runtime
        .sessions
        .lock()
        .map_err(|_| AppError::Validation("agent bridge session registry is unavailable".into()))
}

pub(crate) fn lock_server<'a>(
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
