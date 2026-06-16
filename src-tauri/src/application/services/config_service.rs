use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{atomic::Ordering, Mutex};

use chrono::Utc;

use crate::domain::entities::{AppSettings, BootstrapState, RuntimeOverview};
use crate::error::AppError;
use crate::infrastructure::agent_bridge::{self, AgentBridgeRuntime};
use crate::infrastructure::crypto::CryptoService;
use crate::infrastructure::persistence::StorageService;
use crate::infrastructure::ssh::query_runtime_overview;
use crate::interface::dto::LocalConfigBundle;
use crate::state::{RuntimeSession, SessionControl, TunnelRuntime};

use super::connection_service;

/// Reload bootstrap state from storage (without agent bridge sync).
pub fn reload_bootstrap_state(
    storage: &StorageService,
    crypto: &CryptoService,
    sessions: &Mutex<HashMap<String, RuntimeSession>>,
) -> Result<BootstrapState, AppError> {
    let session_list = sessions
        .lock()
        .map_err(|_| AppError::Validation("session registry is unavailable".into()))?
        .values()
        .map(|item| item.session.clone())
        .collect();

    Ok(BootstrapState {
        settings: storage.load_settings(crypto)?,
        connections: storage.load_connections(crypto)?,
        history: storage.load_history()?,
        sessions: session_list,
        tunnels: storage.load_tunnels()?,
    })
}

/// Load all data from storage and build the initial bootstrap state.
pub fn bootstrap_state(
    storage: &StorageService,
    crypto: &CryptoService,
    agent_bridge: &AgentBridgeRuntime,
    sessions: &Mutex<HashMap<String, RuntimeSession>>,
) -> Result<BootstrapState, AppError> {
    let settings = storage.load_settings(crypto)?;
    agent_bridge::sync_server(agent_bridge, storage, crypto, &settings.agent_bridge)?;
    reload_bootstrap_state(storage, crypto, sessions)
}

/// Save application settings and sync agent bridge.
pub fn save_app_settings(
    storage: &StorageService,
    crypto: &CryptoService,
    agent_bridge: &AgentBridgeRuntime,
    settings: AppSettings,
) -> Result<AppSettings, AppError> {
    storage.save_settings(&settings, crypto)?;
    agent_bridge::sync_server(agent_bridge, storage, crypto, &settings.agent_bridge)?;
    Ok(settings)
}

/// Stop all running sessions and tunnels.
pub fn stop_all_runtimes(
    sessions: &Mutex<HashMap<String, RuntimeSession>>,
    tunnels: &Mutex<HashMap<String, TunnelRuntime>>,
) -> Result<(), AppError> {
    let mut session_map = sessions
        .lock()
        .map_err(|_| AppError::Validation("session registry is unavailable".into()))?;
    for runtime in session_map.drain().map(|(_, runtime)| runtime) {
        let _ = runtime.control_tx.send(SessionControl::Close);
    }
    drop(session_map);

    let mut tunnel_map = tunnels
        .lock()
        .map_err(|_| AppError::Validation("tunnel registry is unavailable".into()))?;
    for runtime in tunnel_map.drain().map(|(_, runtime)| runtime) {
        runtime.stop_flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Export local configuration to a JSON file.
pub fn export_local_config(
    storage: &StorageService,
    crypto: &CryptoService,
    target_path: String,
) -> Result<String, AppError> {
    let bundle = LocalConfigBundle {
        schema_version: 1,
        exported_at: Utc::now().to_rfc3339(),
        settings: storage.load_settings(crypto)?,
        connections: storage.load_connections(crypto)?,
        history: storage.load_history()?,
        tunnels: storage.load_tunnels()?,
    };

    let normalized_path = target_path.trim();
    let path = if normalized_path.is_empty() {
        let export_dir = storage.exports_dir_path();
        let timestamp = Utc::now().format("%Y%m%d-%H%M%S").to_string();
        export_dir.join(format!("myterminal-config-{timestamp}.json"))
    } else {
        PathBuf::from(normalized_path)
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let payload = serde_json::to_string_pretty(&bundle).map_err(AppError::from)?;
    fs::write(&path, payload)?;
    Ok(path.to_string_lossy().to_string())
}

/// Import local configuration from a JSON string.
pub fn import_local_config(
    storage: &StorageService,
    crypto: &CryptoService,
    sessions: &Mutex<HashMap<String, RuntimeSession>>,
    tunnels: &Mutex<HashMap<String, TunnelRuntime>>,
    content: String,
) -> Result<BootstrapState, AppError> {
    let mut bundle: LocalConfigBundle = serde_json::from_str(&content).map_err(AppError::from)?;
    if bundle.schema_version > 1 {
        return Err(AppError::Validation(format!(
            "unsupported local config schema version {}",
            bundle.schema_version
        )));
    }

    stop_all_runtimes(sessions, tunnels)?;

    storage.backup_existing_file(
        &storage.settings_file_path(),
        "settings-before-local-import",
    )?;
    storage.backup_existing_file(
        &storage.connections_file_path(),
        "connections-before-local-import",
    )?;
    storage.backup_existing_file(&storage.history_file_path(), "history-before-local-import")?;
    storage.backup_existing_file(&storage.tunnels_file_path(), "tunnels-before-local-import")?;

    for tunnel in &mut bundle.tunnels {
        tunnel.status = "stopped".into();
    }

    storage.save_settings(&bundle.settings, crypto)?;
    storage.save_connections(&bundle.connections, crypto)?;
    storage.save_history(&bundle.history)?;
    storage.save_tunnels(&bundle.tunnels)?;

    Ok(BootstrapState {
        settings: bundle.settings,
        connections: bundle.connections,
        history: bundle.history,
        sessions: Vec::new(),
        tunnels: bundle.tunnels,
    })
}

/// Fetch runtime overview (CPU, memory, etc.) from a remote server.
pub fn fetch_runtime_overview(
    storage: &StorageService,
    crypto: &CryptoService,
    connection_id: String,
) -> Result<RuntimeOverview, AppError> {
    let connection = connection_service::ensure_connection_exists(storage, crypto, &connection_id)?;
    query_runtime_overview(&connection)
}
