use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use crate::domain::entities::TunnelRecord;
use crate::domain::services;
use crate::error::AppError;
use crate::infrastructure::crypto::CryptoService;
use crate::infrastructure::persistence::StorageService;
use crate::infrastructure::ssh::*;
use crate::interface::dto::{TunnelOpenRequest, TunnelUpdateRequest};
use crate::state::TunnelRuntime;

fn lock_tunnels(
    tunnels: &Mutex<HashMap<String, TunnelRuntime>>,
) -> Result<std::sync::MutexGuard<'_, HashMap<String, TunnelRuntime>>, AppError> {
    tunnels
        .lock()
        .map_err(|_| AppError::Validation("tunnel registry is unavailable".into()))
}

/// List all tunnel records from storage.
pub fn list_tunnels(storage: &StorageService) -> Result<Vec<TunnelRecord>, AppError> {
    storage.load_tunnels()
}

/// Create a new tunnel record (stopped by default).
pub fn open_tunnel(
    storage: &StorageService,
    crypto: &CryptoService,
    request: TunnelOpenRequest,
) -> Result<TunnelRecord, AppError> {
    let TunnelOpenRequest {
        connection_id,
        name,
        bind_address,
        local_port,
        remote_host,
        remote_port,
    } = request;

    let _ = super::connection_service::ensure_connection_exists(storage, crypto, &connection_id)?;
    let tunnel = TunnelRecord {
        id: uuid::Uuid::new_v4().to_string(),
        connection_id,
        name: name.trim().into(),
        bind_address: bind_address.trim().into(),
        local_port,
        remote_host: remote_host.trim().into(),
        remote_port,
        status: "stopped".into(),
    };
    services::validate_tunnel_fields(
        &tunnel.connection_id,
        &tunnel.name,
        &tunnel.bind_address,
        tunnel.local_port,
        &tunnel.remote_host,
        tunnel.remote_port,
    )?;

    let mut tunnels = storage.load_tunnels()?;
    tunnels.retain(|item| item.id != tunnel.id);
    tunnels.insert(0, tunnel.clone());
    storage.save_tunnels(&tunnels)?;
    Ok(tunnel)
}

/// Update an existing tunnel record (stops it if running).
pub fn update_tunnel(
    storage: &StorageService,
    crypto: &CryptoService,
    tunnels_mutex: &Mutex<HashMap<String, TunnelRuntime>>,
    request: TunnelUpdateRequest,
) -> Result<TunnelRecord, AppError> {
    let TunnelUpdateRequest {
        id,
        connection_id,
        name,
        bind_address,
        local_port,
        remote_host,
        remote_port,
    } = request;

    let _ = super::connection_service::ensure_connection_exists(storage, crypto, &connection_id)?;
    let mut tunnel = TunnelRecord {
        id,
        connection_id,
        name: name.trim().into(),
        bind_address: bind_address.trim().into(),
        local_port,
        remote_host: remote_host.trim().into(),
        remote_port,
        status: "stopped".into(),
    };
    services::validate_tunnel_fields(
        &tunnel.connection_id,
        &tunnel.name,
        &tunnel.bind_address,
        tunnel.local_port,
        &tunnel.remote_host,
        tunnel.remote_port,
    )?;

    let mut tunnels = storage.load_tunnels()?;
    let Some(index) = tunnels.iter().position(|item| item.id == tunnel.id) else {
        return Err(AppError::NotFound(format!(
            "tunnel {} not found",
            tunnel.id
        )));
    };

    if let Some(runtime) = lock_tunnels(tunnels_mutex)?.remove(&tunnel.id) {
        runtime.stop_flag.store(true, Ordering::Relaxed);
    }

    tunnel.status = "stopped".into();
    tunnels[index] = tunnel.clone();
    storage.save_tunnels(&tunnels)?;
    Ok(tunnel)
}

/// Start a tunnel (spawns listener thread).
pub fn start_tunnel(
    storage: &StorageService,
    crypto: &CryptoService,
    tunnels_mutex: &Mutex<HashMap<String, TunnelRuntime>>,
    tunnel_id: String,
) -> Result<TunnelRecord, AppError> {
    let mut tunnels = storage.load_tunnels()?;
    let Some(index) = tunnels.iter().position(|item| item.id == tunnel_id) else {
        return Err(AppError::NotFound(format!("tunnel {tunnel_id} not found")));
    };

    if let Some(runtime) = lock_tunnels(tunnels_mutex)?.remove(&tunnel_id) {
        runtime.stop_flag.store(true, Ordering::Relaxed);
    }

    let mut tunnel = tunnels[index].clone();
    let connection = super::connection_service::ensure_connection_exists(
        storage,
        crypto,
        &tunnel.connection_id,
    )?;
    let stop_flag = Arc::new(AtomicBool::new(false));
    spawn_tunnel_listener(connection, tunnel.clone(), Arc::clone(&stop_flag))?;

    tunnel.status = "running".into();
    tunnels[index] = tunnel.clone();
    storage.save_tunnels(&tunnels)?;
    lock_tunnels(tunnels_mutex)?.insert(
        tunnel.id.clone(),
        TunnelRuntime {
            stop_flag: Arc::clone(&stop_flag),
        },
    );

    Ok(tunnel)
}

/// Close a tunnel (stops listener).
pub fn close_tunnel(
    storage: &StorageService,
    tunnels_mutex: &Mutex<HashMap<String, TunnelRuntime>>,
    tunnel_id: String,
) -> Result<bool, AppError> {
    if let Some(runtime) = lock_tunnels(tunnels_mutex)?.remove(&tunnel_id) {
        runtime.stop_flag.store(true, Ordering::Relaxed);
    }

    let mut tunnels = storage.load_tunnels()?;
    for tunnel in &mut tunnels {
        if tunnel.id == tunnel_id {
            tunnel.status = "stopped".into();
        }
    }
    storage.save_tunnels(&tunnels)?;
    Ok(true)
}
