//! Agent Bridge 审批请求状态机。
//! 负责请求建模、排队、等待、批准/拒绝、执行和最终结果归并，不承载 HTTP 协议细节。

use super::*;

pub fn list_requests(runtime: &AgentBridgeRuntime) -> Result<Vec<AgentBridgeRequest>, AppError> {
    Ok(lock_requests(runtime)?.iter().cloned().collect())
}

pub fn clear_finished_requests(runtime: &AgentBridgeRuntime) -> Result<bool, AppError> {
    let mut requests = lock_requests(runtime)?;
    requests.retain(|request| request.status == "pending" || request.status == "running");
    runtime.request_changed.notify_all();
    emit_requests_changed(runtime);
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
    emit_requests_changed(runtime);
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
    runtime.request_changed.notify_all();
    emit_requests_changed(runtime);

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
    emit_requests_changed(runtime);
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

fn push_trimmed_path(paths: &mut Vec<String>, value: Option<&str>) {
    if let Some(trimmed) = value.map(str::trim).filter(|value| !value.is_empty()) {
        paths.push(trimmed.to_string());
    }
}

pub(super) fn request_upload_paths(payload: &FileUploadRequest) -> Vec<String> {
    let mut paths = Vec::new();
    // 先保留旧字段 localPath，再追加新字段 localPaths，方便旧 MCP 客户端平滑升级。
    push_trimmed_path(&mut paths, payload.local_path.as_deref());
    for path in &payload.local_paths {
        push_trimmed_path(&mut paths, Some(path));
    }
    paths
}

pub(super) fn request_download_paths(payload: &FileDownloadRequest) -> Vec<String> {
    let mut paths = Vec::new();
    // 先保留旧字段 path，再追加新字段 paths，方便旧 MCP 客户端平滑升级。
    push_trimmed_path(&mut paths, payload.path.as_deref());
    for path in &payload.paths {
        push_trimmed_path(&mut paths, Some(path));
    }
    paths
}

fn request_first_upload_path(payload: &FileUploadRequest) -> Option<String> {
    request_upload_paths(payload).into_iter().next()
}

fn request_first_download_path(payload: &FileDownloadRequest) -> Option<String> {
    request_download_paths(payload).into_iter().next()
}

fn transfer_request_preview(action: &str, paths: &[String]) -> String {
    if paths.is_empty() {
        return format!("{action}：未提供路径。");
    }

    // 审批卡片只放有限路径，避免一次批量传输把底部面板撑得很长。
    let mut lines = vec![format!("{action}：{} 个路径。", paths.len())];
    for path in paths.iter().take(8) {
        lines.push(format!("- {path}"));
    }
    if paths.len() > 8 {
        lines.push(format!("... 另有 {} 个路径", paths.len() - 8));
    }
    lines.join("\n")
}

fn enqueue_request(
    runtime: &AgentBridgeRuntime,
    action: AgentAction,
    session: &AgentSession,
    context: Option<&AgentActionContext<'_>>,
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
        AgentAction::FileUpload(payload) => (
            "file_upload".to_string(),
            None,
            request_first_upload_path(payload),
            payload
                .remote_path
                .clone()
                .or_else(|| payload.remote_dir.clone()),
            Some(transfer_request_preview(
                "上传本地文件或文件夹到远端",
                &request_upload_paths(payload),
            )),
        ),
        AgentAction::FileDownload(payload) => (
            "file_download".to_string(),
            None,
            request_first_download_path(payload),
            payload
                .local_path
                .clone()
                .or_else(|| payload.local_dir.clone()),
            Some(transfer_request_preview(
                "下载远端文件或文件夹到本地",
                &request_download_paths(payload),
            )),
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
    {
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
            conversation_id: context.map(|value| value.conversation_id.to_string()),
            tool_call_id: context.map(|value| value.tool_call_id.to_string()),
            action,
        });
        while requests.len() > AGENT_BRIDGE_HISTORY_LIMIT {
            requests.pop_back();
        }
    }
    runtime.request_changed.notify_all();
    emit_requests_changed(runtime);
    // 内置对话审批保留在当前窗口上下文；只有外部 MCP 请求需要强制把主窗口带到前台。
    if context.is_none() {
        focus_external_approval_window(runtime);
    }
    Ok(id)
}

pub(super) fn should_auto_execute(settings: &AgentBridgeSettings, connection_id: &str) -> bool {
    // 自动执行开关开启时表示用户信任当前 MCP 客户端对全部连接执行；关闭时退回连接白名单。
    if settings.auto_execute {
        return true;
    }

    settings
        .allowed_connection_ids
        .iter()
        .any(|allowed| allowed == connection_id)
}

pub(super) fn submit_action(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    settings: &AgentBridgeSettings,
    action: AgentAction,
    context: Option<&AgentActionContext<'_>>,
) -> Result<Value, AppError> {
    let session = session_for_action(runtime, storage, crypto, &action)?;
    if should_auto_execute(settings, &session.connection_id) {
        return execute_action(runtime, storage, crypto, settings, &action)
            .and_then(|value| serde_json::to_value(value).map_err(AppError::from));
    }

    let request_id = enqueue_request(runtime, action, &session, context)?;
    wait_for_request_result(runtime, &request_id)
}

fn session_for_action(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    action: &AgentAction,
) -> Result<AgentSession, AppError> {
    let session_id = match action {
        AgentAction::RunCommand(payload) => &payload.session_id,
        AgentAction::FileWrite(payload) => &payload.session_id,
        AgentAction::FileUpload(payload) => &payload.session_id,
        AgentAction::FileDownload(payload) => &payload.session_id,
        AgentAction::FileDelete(payload) => &payload.session_id,
        AgentAction::FileRename(payload) => &payload.session_id,
        AgentAction::FileMkdir(payload) => &payload.session_id,
    };
    resolve_agent_session(runtime, storage, crypto, session_id)
}

fn execute_action(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    settings: &AgentBridgeSettings,
    action: &AgentAction,
) -> Result<Value, AppError> {
    match action {
        AgentAction::RunCommand(payload) => serde_json::to_value(run_agent_command(
            runtime, storage, crypto, settings, payload,
        )?)
        .map_err(AppError::from),
        AgentAction::FileWrite(payload) => {
            write_agent_file(runtime, storage, crypto, payload)?;
            announce_file_action(
                runtime,
                storage,
                crypto,
                &payload.session_id,
                "写入文件",
                &payload.path,
            );
            Ok(json!({ "ok": true }))
        }
        AgentAction::FileUpload(payload) => {
            let result = upload_agent_path(runtime, storage, crypto, payload)?;
            announce_file_action(
                runtime,
                storage,
                crypto,
                &payload.session_id,
                "上传",
                &result.destination_path,
            );
            serde_json::to_value(result).map_err(AppError::from)
        }
        AgentAction::FileDownload(payload) => {
            let result = download_agent_path(runtime, storage, crypto, payload)?;
            announce_file_action(
                runtime,
                storage,
                crypto,
                &payload.session_id,
                "下载",
                &result.source_path,
            );
            serde_json::to_value(result).map_err(AppError::from)
        }
        AgentAction::FileDelete(payload) => {
            delete_agent_file(runtime, storage, crypto, payload)?;
            announce_file_action(
                runtime,
                storage,
                crypto,
                &payload.session_id,
                "删除",
                &payload.path,
            );
            Ok(json!({ "ok": true }))
        }
        AgentAction::FileRename(payload) => {
            rename_agent_file(runtime, storage, crypto, payload)?;
            announce_file_action(
                runtime,
                storage,
                crypto,
                &payload.session_id,
                "重命名",
                &format!("{} -> {}", payload.path, payload.new_path),
            );
            Ok(json!({ "ok": true }))
        }
        AgentAction::FileMkdir(payload) => {
            mkdir_agent_file(runtime, storage, crypto, payload)?;
            announce_file_action(
                runtime,
                storage,
                crypto,
                &payload.session_id,
                "创建目录",
                &payload.path,
            );
            Ok(json!({ "ok": true }))
        }
    }
}

/// 文件类操作走 SFTP，不经过 PTY，用户在终端里看不到任何痕迹。
/// 这里把动作播报到该连接的终端标签，保证 AI 的每一步都留下可见记录。
fn announce_file_action(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    session_id: &str,
    action: &str,
    target: &str,
) {
    let Some(app_handle) = runtime.app_handle.lock().ok().and_then(|h| h.clone()) else {
        return;
    };
    // 解析出连接 id；失败说明会话本身有问题，此时静默跳过播报即可，不影响主流程。
    let Ok(session) = resolve_agent_session(runtime, storage, crypto, session_id) else {
        return;
    };
    let state = app_handle.state::<AppState>();
    commands::announce_agent_activity(
        &state,
        &app_handle,
        &session.connection_id,
        &format!("{action}：{target}"),
    );
}
