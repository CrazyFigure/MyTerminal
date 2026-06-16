use crate::error::AppError;
use crate::infrastructure::agent_bridge::{self, AgentBridgeRuntime};
use crate::infrastructure::crypto::CryptoService;
use crate::infrastructure::persistence::StorageService;

/// Get the current agent bridge status.
pub fn agent_bridge_status(
    storage: &StorageService,
    crypto: &CryptoService,
    agent_bridge: &AgentBridgeRuntime,
) -> Result<agent_bridge::AgentBridgeStatus, AppError> {
    let settings = storage.load_settings(crypto)?;
    agent_bridge::bridge_status(agent_bridge, storage, &settings.agent_bridge)
}

/// List pending and historical agent bridge requests.
pub fn list_agent_bridge_requests(
    agent_bridge: &AgentBridgeRuntime,
) -> Result<Vec<agent_bridge::AgentBridgeRequest>, AppError> {
    agent_bridge::list_requests(agent_bridge)
}

/// Approve a pending agent bridge request, optionally with an edited command.
pub fn approve_agent_bridge_request(
    storage: &StorageService,
    crypto: &CryptoService,
    agent_bridge: &AgentBridgeRuntime,
    request_id: String,
    edited_command: Option<String>,
) -> Result<bool, AppError> {
    let settings = storage.load_settings(crypto)?;
    agent_bridge::approve_request(
        agent_bridge,
        storage,
        crypto,
        &settings.agent_bridge,
        &request_id,
        edited_command,
    )
}

/// Reject a pending agent bridge request.
pub fn reject_agent_bridge_request(
    agent_bridge: &AgentBridgeRuntime,
    request_id: String,
    reason: Option<String>,
) -> Result<bool, AppError> {
    agent_bridge::reject_request(agent_bridge, &request_id, reason)
}

/// Clear finished (non-pending, non-running) agent bridge requests.
pub fn clear_agent_bridge_requests(agent_bridge: &AgentBridgeRuntime) -> Result<bool, AppError> {
    agent_bridge::clear_finished_requests(agent_bridge)
}

/// Enable or disable the agent bridge server.
pub fn set_agent_bridge_enabled(
    storage: &StorageService,
    crypto: &CryptoService,
    agent_bridge: &AgentBridgeRuntime,
    enabled: bool,
) -> Result<agent_bridge::AgentBridgeStatus, AppError> {
    let mut settings = storage.load_settings(crypto)?;
    settings.agent_bridge.enabled = enabled;
    storage.save_settings(&settings, crypto)?;
    agent_bridge::sync_server(agent_bridge, storage, crypto, &settings.agent_bridge)?;
    agent_bridge::bridge_status(agent_bridge, storage, &settings.agent_bridge)
}

/// Reset the agent bridge authentication token.
pub fn reset_agent_bridge_token(
    storage: &StorageService,
    crypto: &CryptoService,
    agent_bridge: &AgentBridgeRuntime,
) -> Result<agent_bridge::AgentBridgeStatus, AppError> {
    let settings = storage.load_settings(crypto)?;
    agent_bridge::stop_server(agent_bridge, storage)?;
    agent_bridge::reset_agent_bridge_token(storage)?;
    agent_bridge::sync_server(agent_bridge, storage, crypto, &settings.agent_bridge)?;
    agent_bridge::bridge_status(agent_bridge, storage, &settings.agent_bridge)
}
