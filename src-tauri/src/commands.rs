use tauri::State;

use crate::{
    application::services::*, domain::entities::*, infrastructure::agent_bridge, interface::dto::*,
    state::AppState,
};

// ── Bootstrap ──

#[tauri::command]
pub fn bootstrap_state(state: State<'_, AppState>) -> Result<BootstrapState, String> {
    Ok(config_service::bootstrap_state(
        &state.storage,
        &state.crypto,
        &state.agent_bridge,
        &state.sessions,
    )?)
}

#[tauri::command]
pub fn save_app_settings(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    Ok(config_service::save_app_settings(
        &state.storage,
        &state.crypto,
        &state.agent_bridge,
        settings,
    )?)
}

// ── Connection ──

#[tauri::command]
pub fn test_connection(connection: ConnectionProfile) -> Result<bool, String> {
    Ok(connection_service::test_connection(&connection)?)
}

#[tauri::command]
pub fn create_connection(
    state: State<'_, AppState>,
    connection: ConnectionProfile,
) -> Result<ConnectionProfile, String> {
    Ok(connection_service::save_connection(
        &state.storage,
        &state.crypto,
        connection,
    )?)
}

#[tauri::command]
pub fn update_connection(
    state: State<'_, AppState>,
    connection: ConnectionProfile,
) -> Result<ConnectionProfile, String> {
    Ok(connection_service::save_connection(
        &state.storage,
        &state.crypto,
        connection,
    )?)
}

#[tauri::command]
pub fn delete_connection(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<bool, String> {
    Ok(connection_service::delete_connection(
        &state.storage,
        &state.crypto,
        &state.sessions,
        &state.tunnels,
        connection_id,
    )?)
}

// ── Session ──

#[tauri::command]
pub fn open_ssh_session(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<TerminalSession, String> {
    Ok(session_service::open_ssh_session(
        &state.storage,
        &state.crypto,
        &state.sessions,
        connection_id,
    )?)
}

#[tauri::command]
pub fn close_ssh_session(state: State<'_, AppState>, session_id: String) -> Result<bool, String> {
    Ok(session_service::close_ssh_session(
        &state.sessions,
        session_id,
    )?)
}

#[tauri::command]
pub fn write_terminal_input(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<bool, String> {
    Ok(session_service::write_terminal_input(
        &state.sessions,
        session_id,
        data,
    )?)
}

#[tauri::command]
pub fn read_terminal_output(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<TerminalOutputChunk>, String> {
    Ok(session_service::read_terminal_output(
        &state.sessions,
        session_id,
    )?)
}

#[tauri::command]
pub fn resize_terminal(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<bool, String> {
    Ok(session_service::resize_terminal(
        &state.sessions,
        session_id,
        cols,
        rows,
    )?)
}

// ── File ──

#[tauri::command]
pub fn list_remote_files(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<Vec<RemoteFileEntry>, String> {
    Ok(file_service::list_remote_files(
        &state.storage,
        &state.crypto,
        connection_id,
        path,
    )?)
}

#[tauri::command]
pub fn upload_remote_file(
    state: State<'_, AppState>,
    connection_id: String,
    remote_dir: String,
    file_name: String,
    content_base64: String,
) -> Result<bool, String> {
    Ok(file_service::upload_remote_file(
        &state.storage,
        &state.crypto,
        connection_id,
        remote_dir,
        file_name,
        content_base64,
    )?)
}

#[tauri::command]
pub fn download_remote_file(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<String, String> {
    Ok(file_service::download_remote_file(
        &state.storage,
        &state.crypto,
        connection_id,
        path,
    )?)
}

#[tauri::command]
pub fn delete_remote_path(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<bool, String> {
    Ok(file_service::delete_remote_path(
        &state.storage,
        &state.crypto,
        connection_id,
        path,
    )?)
}

#[tauri::command]
pub fn delete_remote_paths(
    state: State<'_, AppState>,
    connection_id: String,
    paths: Vec<String>,
) -> Result<bool, String> {
    Ok(file_service::delete_remote_paths(
        &state.storage,
        &state.crypto,
        connection_id,
        paths,
    )?)
}

#[tauri::command]
pub fn rename_remote_path(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
    new_path: String,
) -> Result<bool, String> {
    Ok(file_service::rename_remote_path(
        &state.storage,
        &state.crypto,
        connection_id,
        path,
        new_path,
    )?)
}

#[tauri::command]
pub fn load_editor_document(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<EditorDocument, String> {
    Ok(file_service::load_editor_document(
        &state.storage,
        &state.crypto,
        connection_id,
        path,
    )?)
}

#[tauri::command]
pub fn save_editor_document(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
    content: String,
) -> Result<bool, String> {
    Ok(file_service::save_editor_document(
        &state.storage,
        &state.crypto,
        connection_id,
        path,
        content,
    )?)
}

// ── Tunnel ──

#[tauri::command]
pub fn list_tunnels(state: State<'_, AppState>) -> Result<Vec<TunnelRecord>, String> {
    Ok(tunnel_service::list_tunnels(&state.storage)?)
}

#[tauri::command]
pub fn fetch_runtime_overview(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<RuntimeOverview, String> {
    Ok(config_service::fetch_runtime_overview(
        &state.storage,
        &state.crypto,
        connection_id,
    )?)
}

#[tauri::command]
pub fn open_tunnel(
    state: State<'_, AppState>,
    request: TunnelOpenRequest,
) -> Result<TunnelRecord, String> {
    Ok(tunnel_service::open_tunnel(
        &state.storage,
        &state.crypto,
        request,
    )?)
}

#[tauri::command]
pub fn update_tunnel(
    state: State<'_, AppState>,
    request: TunnelUpdateRequest,
) -> Result<TunnelRecord, String> {
    Ok(tunnel_service::update_tunnel(
        &state.storage,
        &state.crypto,
        &state.tunnels,
        request,
    )?)
}

#[tauri::command]
pub fn start_tunnel(state: State<'_, AppState>, tunnel_id: String) -> Result<TunnelRecord, String> {
    Ok(tunnel_service::start_tunnel(
        &state.storage,
        &state.crypto,
        &state.tunnels,
        tunnel_id,
    )?)
}

#[tauri::command]
pub fn close_tunnel(state: State<'_, AppState>, tunnel_id: String) -> Result<bool, String> {
    Ok(tunnel_service::close_tunnel(
        &state.storage,
        &state.tunnels,
        tunnel_id,
    )?)
}

// ── History ──

#[tauri::command]
pub fn read_remote_shell_history(
    state: State<'_, AppState>,
    connection_id: String,
    limit: Option<usize>,
) -> Result<Vec<HistoryEntry>, String> {
    Ok(history_service::read_remote_shell_history(
        &state.storage,
        &state.crypto,
        connection_id,
        limit,
    )?)
}

#[tauri::command]
pub fn append_command_history(
    state: State<'_, AppState>,
    entry: HistoryEntryInput,
) -> Result<HistoryEntry, String> {
    Ok(history_service::append_command_history(
        &state.storage,
        entry,
    )?)
}

#[tauri::command]
pub fn get_command_suggestions(
    state: State<'_, AppState>,
    connection_id: Option<String>,
    prefix: String,
    limit: usize,
) -> Result<Vec<String>, String> {
    Ok(history_service::get_command_suggestions(
        &state.storage,
        connection_id,
        prefix,
        limit,
    )?)
}

// ── Update ──

#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateCheckResult, String> {
    Ok(update_service::check_for_updates().await?)
}

#[tauri::command]
pub async fn download_and_install_update(
    download_url: String,
    asset_name: String,
) -> Result<String, String> {
    Ok(update_service::download_and_install_update(download_url, asset_name).await?)
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<bool, String> {
    Ok(update_service::open_external_url(url)?)
}

// ── WebDAV ──

#[tauri::command]
pub async fn upload_settings_to_webdav(state: State<'_, AppState>) -> Result<String, String> {
    Ok(
        webdav_service::upload_settings_to_webdav(&state.storage, &state.crypto, &state.webdav)
            .await?,
    )
}

#[tauri::command]
pub async fn list_settings_backups(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(webdav_service::list_settings_backups(&state.storage, &state.crypto, &state.webdav).await?)
}

#[tauri::command]
pub async fn test_webdav_connection(
    state: State<'_, AppState>,
    webdav: WebDavSettings,
) -> Result<bool, String> {
    Ok(webdav_service::test_webdav_connection(&state.webdav, webdav).await?)
}

#[tauri::command]
pub async fn download_settings_from_webdav(
    state: State<'_, AppState>,
    remote_path: String,
) -> Result<AppSettings, String> {
    Ok(webdav_service::download_settings_from_webdav(
        &state.storage,
        &state.crypto,
        &state.webdav,
        remote_path,
    )
    .await?)
}

#[tauri::command]
pub async fn upload_connections_to_webdav(state: State<'_, AppState>) -> Result<String, String> {
    Ok(
        webdav_service::upload_connections_to_webdav(&state.storage, &state.crypto, &state.webdav)
            .await?,
    )
}

#[tauri::command]
pub async fn list_connections_backups(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(
        webdav_service::list_connections_backups(&state.storage, &state.crypto, &state.webdav)
            .await?,
    )
}

#[tauri::command]
pub async fn download_connections_from_webdav(
    state: State<'_, AppState>,
    remote_path: String,
) -> Result<Vec<ConnectionProfile>, String> {
    Ok(webdav_service::download_connections_from_webdav(
        &state.storage,
        &state.crypto,
        &state.webdav,
        remote_path,
    )
    .await?)
}

#[tauri::command]
pub async fn upload_config_to_webdav(state: State<'_, AppState>) -> Result<String, String> {
    Ok(
        webdav_service::upload_config_to_webdav(&state.storage, &state.crypto, &state.webdav)
            .await?,
    )
}

#[tauri::command]
pub async fn list_config_backups(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(webdav_service::list_config_backups(&state.storage, &state.crypto, &state.webdav).await?)
}

#[tauri::command]
pub async fn download_config_from_webdav(
    state: State<'_, AppState>,
    remote_path: String,
) -> Result<BootstrapState, String> {
    Ok(webdav_service::download_config_from_webdav(
        &state.storage,
        &state.crypto,
        &state.webdav,
        &state.sessions,
        &state.tunnels,
        remote_path,
    )
    .await?)
}

// ── Agent Bridge ──

#[tauri::command]
pub fn agent_bridge_status(
    state: State<'_, AppState>,
) -> Result<agent_bridge::AgentBridgeStatus, String> {
    Ok(agent_bridge_service::agent_bridge_status(
        &state.storage,
        &state.crypto,
        &state.agent_bridge,
    )?)
}

#[tauri::command]
pub fn list_agent_bridge_requests(
    state: State<'_, AppState>,
) -> Result<Vec<agent_bridge::AgentBridgeRequest>, String> {
    Ok(agent_bridge_service::list_agent_bridge_requests(
        &state.agent_bridge,
    )?)
}

#[tauri::command]
pub fn approve_agent_bridge_request(
    state: State<'_, AppState>,
    request_id: String,
    edited_command: Option<String>,
) -> Result<bool, String> {
    Ok(agent_bridge_service::approve_agent_bridge_request(
        &state.storage,
        &state.crypto,
        &state.agent_bridge,
        request_id,
        edited_command,
    )?)
}

#[tauri::command]
pub fn reject_agent_bridge_request(
    state: State<'_, AppState>,
    request_id: String,
    reason: Option<String>,
) -> Result<bool, String> {
    Ok(agent_bridge_service::reject_agent_bridge_request(
        &state.agent_bridge,
        request_id,
        reason,
    )?)
}

#[tauri::command]
pub fn clear_agent_bridge_requests(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(agent_bridge_service::clear_agent_bridge_requests(
        &state.agent_bridge,
    )?)
}

#[tauri::command]
pub fn set_agent_bridge_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<agent_bridge::AgentBridgeStatus, String> {
    Ok(agent_bridge_service::set_agent_bridge_enabled(
        &state.storage,
        &state.crypto,
        &state.agent_bridge,
        enabled,
    )?)
}

#[tauri::command]
pub fn reset_agent_bridge_token(
    state: State<'_, AppState>,
) -> Result<agent_bridge::AgentBridgeStatus, String> {
    Ok(agent_bridge_service::reset_agent_bridge_token(
        &state.storage,
        &state.crypto,
        &state.agent_bridge,
    )?)
}

// ── Config Export/Import ──

#[tauri::command]
pub fn export_local_config(
    state: State<'_, AppState>,
    target_path: String,
) -> Result<String, String> {
    Ok(config_service::export_local_config(
        &state.storage,
        &state.crypto,
        target_path,
    )?)
}

#[tauri::command]
pub fn import_local_config(
    state: State<'_, AppState>,
    content: String,
) -> Result<BootstrapState, String> {
    Ok(config_service::import_local_config(
        &state.storage,
        &state.crypto,
        &state.sessions,
        &state.tunnels,
        content,
    )?)
}
