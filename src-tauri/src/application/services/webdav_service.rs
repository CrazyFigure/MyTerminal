use std::collections::HashMap;
use std::sync::Mutex;

use chrono::Utc;

use crate::domain::entities::{AppSettings, BootstrapState, ConnectionProfile, WebDavSettings};
use crate::error::AppError;
use crate::infrastructure::crypto::CryptoService;
use crate::infrastructure::persistence::StorageService;
use crate::infrastructure::webdav::WebDavService;
use crate::interface::dto::LocalConfigBundle;

/// Upload settings to WebDAV.
pub async fn upload_settings_to_webdav(
    storage: &StorageService,
    crypto: &CryptoService,
    webdav: &WebDavService,
) -> Result<String, AppError> {
    let settings = storage.load_settings(crypto)?;
    let remote_path = webdav.upload_settings(&settings, crypto).await?;
    Ok(remote_path)
}

/// List settings backups on WebDAV.
pub async fn list_settings_backups(
    storage: &StorageService,
    crypto: &CryptoService,
    webdav: &WebDavService,
) -> Result<Vec<String>, AppError> {
    let settings = storage.load_settings(crypto)?;
    let files = webdav.list_settings_backups(&settings.webdav).await?;
    Ok(files)
}

/// Test a WebDAV connection with the given settings.
pub async fn test_webdav_connection(
    webdav: &WebDavService,
    webdav_settings: WebDavSettings,
) -> Result<bool, AppError> {
    webdav.test_connection(&webdav_settings).await?;
    Ok(true)
}

/// Download settings from WebDAV and apply them locally.
pub async fn download_settings_from_webdav(
    storage: &StorageService,
    crypto: &CryptoService,
    webdav: &WebDavService,
    remote_path: String,
) -> Result<AppSettings, AppError> {
    let current_settings = storage.load_settings(crypto)?;
    storage.backup_existing_file(&storage.settings_file_path(), "settings")?;
    let downloaded = webdav
        .download_settings(&current_settings.webdav, &remote_path, crypto)
        .await?;
    storage.save_settings(&downloaded, crypto)?;
    Ok(downloaded)
}

/// Upload connections to WebDAV.
pub async fn upload_connections_to_webdav(
    storage: &StorageService,
    crypto: &CryptoService,
    webdav: &WebDavService,
) -> Result<String, AppError> {
    let settings = storage.load_settings(crypto)?;
    let connections = storage.load_connections(crypto)?;
    let remote_path = webdav
        .upload_connections(&settings, &connections, crypto)
        .await?;
    Ok(remote_path)
}

/// List connections backups on WebDAV.
pub async fn list_connections_backups(
    storage: &StorageService,
    crypto: &CryptoService,
    webdav: &WebDavService,
) -> Result<Vec<String>, AppError> {
    let settings = storage.load_settings(crypto)?;
    let files = webdav.list_connections_backups(&settings.webdav).await?;
    Ok(files)
}

/// Download connections from WebDAV and apply them locally.
pub async fn download_connections_from_webdav(
    storage: &StorageService,
    crypto: &CryptoService,
    webdav: &WebDavService,
    remote_path: String,
) -> Result<Vec<ConnectionProfile>, AppError> {
    let settings = storage.load_settings(crypto)?;
    storage.backup_existing_file(&storage.connections_file_path(), "connections")?;
    let connections = webdav
        .download_connections(&settings.webdav, &remote_path, crypto)
        .await?;
    storage.save_connections(&connections, crypto)?;
    Ok(connections)
}

/// Upload full config bundle to WebDAV.
pub async fn upload_config_to_webdav(
    storage: &StorageService,
    crypto: &CryptoService,
    webdav: &WebDavService,
) -> Result<String, AppError> {
    let settings = storage.load_settings(crypto)?;
    let connections = storage.load_connections(crypto)?;
    let history = storage.load_history()?;
    let tunnels = storage.load_tunnels()?;
    let bundle = LocalConfigBundle {
        schema_version: 1,
        exported_at: Utc::now().to_rfc3339(),
        settings: settings.clone(),
        connections,
        history,
        tunnels,
    };
    let remote_path = webdav
        .upload_config_bundle(&settings.webdav, &bundle)
        .await?;
    Ok(remote_path)
}

/// List config backups on WebDAV.
pub async fn list_config_backups(
    storage: &StorageService,
    crypto: &CryptoService,
    webdav: &WebDavService,
) -> Result<Vec<String>, AppError> {
    let settings = storage.load_settings(crypto)?;
    let files = webdav.list_config_backups(&settings.webdav).await?;
    Ok(files)
}

/// Download config bundle from WebDAV and apply locally.
pub async fn download_config_from_webdav(
    storage: &StorageService,
    crypto: &CryptoService,
    webdav: &WebDavService,
    sessions: &Mutex<HashMap<String, crate::state::RuntimeSession>>,
    tunnels: &Mutex<HashMap<String, crate::state::TunnelRuntime>>,
    remote_path: String,
) -> Result<BootstrapState, AppError> {
    let current_settings = storage.load_settings(crypto)?;
    let filename = remote_path.rsplit('/').next().unwrap_or(&remote_path);

    // Try merged format first (myterminal-config-*.enc.json)
    if filename.starts_with("myterminal-config") {
        let mut bundle = webdav
            .download_config_bundle(&current_settings.webdav, &remote_path)
            .await?;

        if bundle.schema_version > 1 {
            return Err(AppError::Validation(format!(
                "unsupported config schema version {}",
                bundle.schema_version
            )));
        }

        super::config_service::stop_all_runtimes(sessions, tunnels)?;

        storage.backup_existing_file(
            &storage.settings_file_path(),
            "settings-before-webdav-import",
        )?;
        storage.backup_existing_file(
            &storage.connections_file_path(),
            "connections-before-webdav-import",
        )?;
        storage
            .backup_existing_file(&storage.history_file_path(), "history-before-webdav-import")?;
        storage
            .backup_existing_file(&storage.tunnels_file_path(), "tunnels-before-webdav-import")?;

        for tunnel in &mut bundle.tunnels {
            tunnel.status = "stopped".into();
        }

        storage.save_settings(&bundle.settings, crypto)?;
        storage.save_connections(&bundle.connections, crypto)?;
        storage.save_history(&bundle.history)?;
        storage.save_tunnels(&bundle.tunnels)?;

        return Ok(BootstrapState {
            settings: bundle.settings,
            connections: bundle.connections,
            history: bundle.history,
            sessions: Vec::new(),
            tunnels: bundle.tunnels,
        });
    }

    // Legacy format: settings-*.enc.json or connections-*.enc.json
    super::config_service::stop_all_runtimes(sessions, tunnels)?;

    if filename.starts_with("settings") {
        storage.backup_existing_file(
            &storage.settings_file_path(),
            "settings-before-webdav-import",
        )?;
        let downloaded = webdav
            .download_settings(&current_settings.webdav, &remote_path, crypto)
            .await?;
        storage.save_settings(&downloaded, crypto)?;
    } else if filename.starts_with("connections") {
        storage.backup_existing_file(
            &storage.connections_file_path(),
            "connections-before-webdav-import",
        )?;
        let conns = webdav
            .download_connections(&current_settings.webdav, &remote_path, crypto)
            .await?;
        storage.save_connections(&conns, crypto)?;
    } else {
        return Err(AppError::Validation(format!(
            "unrecognized backup file: {filename}"
        )));
    }

    super::config_service::reload_bootstrap_state(storage, crypto, sessions)
}
