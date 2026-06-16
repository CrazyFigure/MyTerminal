use std::collections::HashMap;
use std::sync::{atomic::Ordering, Mutex};

use crate::domain::entities::ConnectionProfile;
use crate::error::AppError;
use crate::infrastructure::persistence::StorageService;
use crate::infrastructure::ssh::*;
use crate::state::{RuntimeSession, SessionControl, TunnelRuntime};

/// Ensure the given connection_id exists in storage, returning the profile.
pub fn ensure_connection_exists(
    storage: &StorageService,
    crypto: &crate::infrastructure::crypto::CryptoService,
    connection_id: &str,
) -> Result<ConnectionProfile, AppError> {
    storage
        .load_connections(crypto)?
        .into_iter()
        .find(|item| item.id == connection_id)
        .ok_or_else(|| AppError::NotFound(format!("connection {connection_id} not found")))
}

/// Test whether an SSH connection can be established with the given profile.
pub fn test_connection(connection: &ConnectionProfile) -> Result<bool, AppError> {
    let _ = connect_ssh(connection)?;
    Ok(true)
}

/// Create or update a connection profile.
pub fn save_connection(
    storage: &StorageService,
    crypto: &crate::infrastructure::crypto::CryptoService,
    connection: ConnectionProfile,
) -> Result<ConnectionProfile, AppError> {
    let mut connections = storage.load_connections(crypto)?;
    connections.retain(|item| item.id != connection.id);
    connections.insert(0, connection.clone());
    storage.save_connections(&connections, crypto)?;
    Ok(connection)
}

/// Delete a connection and all associated sessions and tunnels.
pub fn delete_connection(
    storage: &StorageService,
    crypto: &crate::infrastructure::crypto::CryptoService,
    sessions: &Mutex<HashMap<String, RuntimeSession>>,
    tunnels: &Mutex<HashMap<String, TunnelRuntime>>,
    connection_id: String,
) -> Result<bool, AppError> {
    let mut connections = storage.load_connections(crypto)?;
    connections.retain(|item| item.id != connection_id);
    storage.save_connections(&connections, crypto)?;

    let mut session_map = sessions
        .lock()
        .map_err(|_| AppError::Validation("session registry is unavailable".into()))?;
    let session_ids = session_map
        .iter()
        .filter(|(_, runtime)| runtime.session.connection_id == connection_id)
        .map(|(session_id, _)| session_id.clone())
        .collect::<Vec<_>>();
    for session_id in session_ids {
        if let Some(runtime) = session_map.remove(&session_id) {
            let _ = runtime.control_tx.send(SessionControl::Close);
        }
    }
    drop(session_map);

    let persisted_tunnels = storage.load_tunnels()?;
    let tunnel_ids = persisted_tunnels
        .iter()
        .filter(|tunnel| tunnel.connection_id == connection_id)
        .map(|tunnel| tunnel.id.clone())
        .collect::<Vec<_>>();

    let mut tunnel_map = tunnels
        .lock()
        .map_err(|_| AppError::Validation("tunnel registry is unavailable".into()))?;
    for tunnel_id in tunnel_ids {
        if let Some(runtime) = tunnel_map.remove(&tunnel_id) {
            runtime.stop_flag.store(true, Ordering::Relaxed);
        }
    }
    drop(tunnel_map);

    let mut tunnel_records = persisted_tunnels;
    tunnel_records.retain(|item| item.connection_id != connection_id);
    storage.save_tunnels(&tunnel_records)?;

    Ok(true)
}
