use std::{
    thread,
    time::{Duration, Instant},
};

use serde_json::Value;

use crate::{
    domain::entities::AgentBridgeSettings, error::AppError, infrastructure::crypto::CryptoService,
    infrastructure::persistence::StorageService,
};

use super::execution::execute_action;
use super::runtime::{lock_requests, lock_sessions, AgentBridgeRuntime};
use super::types::*;
use crate::domain::entities::now_rfc3339;

const AGENT_BRIDGE_HISTORY_LIMIT: usize = 120;
const AGENT_BRIDGE_APPROVAL_WAIT_SEC: u64 = 3600;

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

pub fn submit_action(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::entities::AgentBridgeSettings;

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
