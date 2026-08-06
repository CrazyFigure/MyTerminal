//! 本地配置导入导出与 WebDAV 同步命令。
//! 该模块复用父模块的运行时停止和状态重载流程，保证恢复配置时的既有行为不变。

use std::{fs, path::PathBuf};

use chrono::Utc;
use tauri::State;

use crate::{
    error::AppError,
    models::{AppSettings, BootstrapState, ConnectionProfile, LocalConfigBundle, WebDavSettings},
    state::AppState,
};

use super::{bootstrap_from_storage, stop_all_runtimes};

#[tauri::command]
// 本地配置导出写入用户选择的位置；空路径用于兼容旧调用，回落到默认导出目录。
pub fn export_local_config(
    state: State<'_, AppState>,
    target_path: String,
) -> Result<String, String> {
    let bundle = LocalConfigBundle {
        schema_version: 1,
        exported_at: Utc::now().to_rfc3339(),
        settings: state.storage.load_settings(&state.crypto)?,
        connections: state.storage.load_connections(&state.crypto)?,
        history: state.storage.load_history()?,
        tunnels: state.storage.load_tunnels()?,
        // AI 端点含明文 API Key，与连接密码一样随导出文件明文保存。
        agent_providers: Some(state.storage.load_agent_providers(&state.crypto)?),
    };

    let normalized_path = target_path.trim();
    // 导出路径优先来自系统保存对话框；兼容旧调用时才回落到默认导出目录。
    let path = if normalized_path.is_empty() {
        let export_dir = state.storage.exports_dir_path();
        let timestamp = Utc::now().format("%Y%m%d-%H%M%S").to_string();
        export_dir.join(format!("myterminal-config-{timestamp}.json"))
    } else {
        PathBuf::from(normalized_path)
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| AppError::from(error).to_string())?;
    }
    let payload = serde_json::to_string_pretty(&bundle).map_err(AppError::from)?;
    fs::write(&path, payload).map_err(|error| AppError::from(error).to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn import_local_config(
    state: State<'_, AppState>,
    content: String,
) -> Result<BootstrapState, String> {
    let mut bundle: LocalConfigBundle = serde_json::from_str(&content).map_err(AppError::from)?;
    if bundle.schema_version > 1 {
        return Err(AppError::Validation(format!(
            "unsupported local config schema version {}",
            bundle.schema_version
        ))
        .into());
    }

    stop_all_runtimes(&state)?;

    state.storage.backup_existing_file(
        &state.storage.settings_file_path(),
        "settings-before-local-import",
    )?;
    state.storage.backup_existing_file(
        &state.storage.connections_file_path(),
        "connections-before-local-import",
    )?;
    state.storage.backup_existing_file(
        &state.storage.history_file_path(),
        "history-before-local-import",
    )?;
    state.storage.backup_existing_file(
        &state.storage.tunnels_file_path(),
        "tunnels-before-local-import",
    )?;
    if bundle.agent_providers.is_some() {
        state.storage.backup_existing_file(
            &state.storage.agent_providers_file_path(),
            "agent-providers-before-local-import",
        )?;
    }

    for tunnel in &mut bundle.tunnels {
        tunnel.status = "stopped".into();
    }

    state
        .storage
        .save_settings(&bundle.settings, &state.crypto)?;
    state
        .storage
        .save_connections(&bundle.connections, &state.crypto)?;
    state.storage.save_history(&bundle.history)?;
    state.storage.save_tunnels(&bundle.tunnels)?;
    // 旧版备份没有 AI 端点字段，缺省时保留本地端点不动。
    if let Some(providers) = bundle.agent_providers {
        state
            .storage
            .save_agent_providers(&providers, &state.crypto)?;
    }

    Ok(bootstrap_from_storage(&state)?)
}

#[tauri::command]
pub async fn upload_settings_to_webdav(state: State<'_, AppState>) -> Result<String, String> {
    let settings = state.storage.load_settings(&state.crypto)?;
    let remote_path = state
        .webdav
        .upload_settings(&settings, &state.crypto)
        .await?;
    Ok(remote_path)
}

#[tauri::command]
pub async fn list_settings_backups(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let settings = state.storage.load_settings(&state.crypto)?;
    let files = state.webdav.list_settings_backups(&settings.webdav).await?;
    Ok(files)
}

#[tauri::command]
// WebDAV 测试只校验当前草稿配置的连通性，不会把草稿写入本地设置。
pub async fn test_webdav_connection(
    state: State<'_, AppState>,
    webdav: WebDavSettings,
) -> Result<bool, String> {
    state.webdav.test_connection(&webdav).await?;
    Ok(true)
}

#[tauri::command]
pub async fn download_settings_from_webdav(
    state: State<'_, AppState>,
    remote_path: String,
) -> Result<AppSettings, String> {
    let current_settings = state.storage.load_settings(&state.crypto)?;
    state
        .storage
        .backup_existing_file(&state.storage.settings_file_path(), "settings")?;
    let downloaded = state
        .webdav
        .download_settings(&current_settings.webdav, &remote_path, &state.crypto)
        .await?;
    state.storage.save_settings(&downloaded, &state.crypto)?;
    Ok(downloaded)
}

#[tauri::command]
pub async fn upload_connections_to_webdav(state: State<'_, AppState>) -> Result<String, String> {
    let settings = state.storage.load_settings(&state.crypto)?;
    let connections = state.storage.load_connections(&state.crypto)?;
    let remote_path = state
        .webdav
        .upload_connections(&settings, &connections, &state.crypto)
        .await?;
    Ok(remote_path)
}

#[tauri::command]
pub async fn list_connections_backups(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let settings = state.storage.load_settings(&state.crypto)?;
    let files = state
        .webdav
        .list_connections_backups(&settings.webdav)
        .await?;
    Ok(files)
}

#[tauri::command]
pub async fn download_connections_from_webdav(
    state: State<'_, AppState>,
    remote_path: String,
) -> Result<Vec<ConnectionProfile>, String> {
    let settings = state.storage.load_settings(&state.crypto)?;
    state
        .storage
        .backup_existing_file(&state.storage.connections_file_path(), "connections")?;
    let connections = state
        .webdav
        .download_connections(&settings.webdav, &remote_path, &state.crypto)
        .await?;
    state
        .storage
        .save_connections(&connections, &state.crypto)?;
    Ok(connections)
}

#[tauri::command]
/// 合并上传所有配置到 WebDAV，与本地导出使用相同的 LocalConfigBundle 结构。
pub async fn upload_config_to_webdav(state: State<'_, AppState>) -> Result<String, String> {
    let settings = state.storage.load_settings(&state.crypto)?;
    let connections = state.storage.load_connections(&state.crypto)?;
    let history = state.storage.load_history()?;
    let tunnels = state.storage.load_tunnels()?;
    let bundle = LocalConfigBundle {
        schema_version: 1,
        exported_at: Utc::now().to_rfc3339(),
        settings: settings.clone(),
        connections,
        history,
        tunnels,
        // AI 端点含明文 API Key，与 WebDAV 密码一样随配置包明文上传。
        agent_providers: Some(state.storage.load_agent_providers(&state.crypto)?),
    };
    let remote_path = state
        .webdav
        .upload_config_bundle(&settings.webdav, &bundle)
        .await?;
    Ok(remote_path)
}

#[tauri::command]
pub async fn list_config_backups(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let settings = state.storage.load_settings(&state.crypto)?;
    let files = state.webdav.list_config_backups(&settings.webdav).await?;
    Ok(files)
}

#[tauri::command]
/// 从 WebDAV 下载配置包并覆盖本地数据。
/// 优先尝试合并格式（LocalConfigBundle），若失败则兼容旧格式：
/// - settings-*.enc.json：只覆盖应用设置
/// - connections-*.enc.json：只覆盖 SSH 连接
pub async fn download_config_from_webdav(
    state: State<'_, AppState>,
    remote_path: String,
) -> Result<BootstrapState, String> {
    let current_settings = state.storage.load_settings(&state.crypto)?;
    let filename = remote_path.rsplit('/').next().unwrap_or(&remote_path);

    // 先尝试合并格式（myterminal-config-*.enc.json）
    if filename.starts_with("myterminal-config") {
        let mut bundle = state
            .webdav
            .download_config_bundle(&current_settings.webdav, &remote_path)
            .await
            .map_err(|error| error.to_string())?;

        if bundle.schema_version > 1 {
            return Err(AppError::Validation(format!(
                "unsupported config schema version {}",
                bundle.schema_version
            ))
            .to_string());
        }

        stop_all_runtimes(&state)?;

        state.storage.backup_existing_file(
            &state.storage.settings_file_path(),
            "settings-before-webdav-import",
        )?;
        state.storage.backup_existing_file(
            &state.storage.connections_file_path(),
            "connections-before-webdav-import",
        )?;
        state.storage.backup_existing_file(
            &state.storage.history_file_path(),
            "history-before-webdav-import",
        )?;
        state.storage.backup_existing_file(
            &state.storage.tunnels_file_path(),
            "tunnels-before-webdav-import",
        )?;
        if bundle.agent_providers.is_some() {
            state.storage.backup_existing_file(
                &state.storage.agent_providers_file_path(),
                "agent-providers-before-webdav-import",
            )?;
        }

        for tunnel in &mut bundle.tunnels {
            tunnel.status = "stopped".into();
        }

        state
            .storage
            .save_settings(&bundle.settings, &state.crypto)?;
        state
            .storage
            .save_connections(&bundle.connections, &state.crypto)?;
        state.storage.save_history(&bundle.history)?;
        state.storage.save_tunnels(&bundle.tunnels)?;
        // 旧版备份没有 AI 端点字段，缺省时保留本地端点不动。
        if let Some(providers) = bundle.agent_providers {
            state
                .storage
                .save_agent_providers(&providers, &state.crypto)?;
        }

        return Ok(bootstrap_from_storage(&state)?);
    }

    // 兼容旧格式：settings-*.enc.json 或 connections-*.enc.json
    stop_all_runtimes(&state)?;

    if filename.starts_with("settings") {
        state.storage.backup_existing_file(
            &state.storage.settings_file_path(),
            "settings-before-webdav-import",
        )?;
        let downloaded = state
            .webdav
            .download_settings(&current_settings.webdav, &remote_path, &state.crypto)
            .await
            .map_err(|error| error.to_string())?;
        state.storage.save_settings(&downloaded, &state.crypto)?;
    } else if filename.starts_with("connections") {
        state.storage.backup_existing_file(
            &state.storage.connections_file_path(),
            "connections-before-webdav-import",
        )?;
        let connections = state
            .webdav
            .download_connections(&current_settings.webdav, &remote_path, &state.crypto)
            .await
            .map_err(|error| error.to_string())?;
        state
            .storage
            .save_connections(&connections, &state.crypto)?;
    } else {
        return Err(
            AppError::Validation(format!("unrecognized backup file: {filename}")).to_string(),
        );
    }

    Ok(bootstrap_from_storage(&state)?)
}
