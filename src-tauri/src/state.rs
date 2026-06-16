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
}

#[derive(Debug, Clone)]
pub struct TunnelRuntime {
    pub stop_flag: Arc<AtomicBool>,
}

#[derive(Debug)]
pub struct AppState {
    pub storage: StorageService,
    pub crypto: CryptoService,
    pub webdav: WebDavService,
    pub agent_bridge: AgentBridgeRuntime,
    pub sessions: Mutex<HashMap<String, RuntimeSession>>,
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
            tunnels: Mutex::new(HashMap::new()),
        })
    }
}
