//! Agent Bridge 与内置 AI 对话的 Tauri 命令适配层。
//! 仅负责参数接收、后台线程调度和事件转发，审批与工具执行规则仍复用 Agent Bridge 领域服务。

use std::thread;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    agent_bridge, agent_chat, agent_tools,
    error::AppError,
    models::{AgentConversation, AgentProvider, AgentRunOptions},
    state::AppState,
};

use super::{
    prepare_agent_bridge_startup, AgentBridgeNotificationActionEvent,
    AgentBridgeNotificationRequest, AGENT_BRIDGE_NOTIFICATION_ACTION_EVENT,
    AGENT_BRIDGE_NOTIFICATION_APPROVE_ACTION_ID, AGENT_BRIDGE_NOTIFICATION_REJECT_ACTION_ID,
};

#[tauri::command]
pub fn agent_bridge_status(
    state: State<'_, AppState>,
) -> Result<agent_bridge::AgentBridgeStatus, String> {
    let settings = state.storage.load_settings(&state.crypto)?;
    Ok(agent_bridge::bridge_status(
        &state.agent_bridge,
        &state.storage,
        &settings.agent_bridge,
    )?)
}

#[tauri::command]
pub fn list_agent_bridge_requests(
    state: State<'_, AppState>,
) -> Result<Vec<agent_bridge::AgentBridgeRequest>, String> {
    Ok(agent_bridge::list_requests(&state.agent_bridge)?)
}

/// 读取全部 AI 端点配置；API Key 明文下发（与 WebDAV 密码同一策略），前端可切换显示。
#[tauri::command]
pub fn list_agent_providers(state: State<'_, AppState>) -> Result<Vec<AgentProvider>, String> {
    Ok(state.storage.load_agent_providers(&state.crypto)?)
}

/// 保存 AI 端点配置。前端持有明文 Key（与 WebDAV 密码同一策略），可查看、修改或清空，
/// 因此以前端提交的值为准整体落盘；hasApiKey 标记按 Key 是否为空重新归一。
#[tauri::command]
pub fn save_agent_providers(
    state: State<'_, AppState>,
    providers: Vec<AgentProvider>,
) -> Result<Vec<AgentProvider>, String> {
    let normalized: Vec<AgentProvider> = providers
        .into_iter()
        .map(|mut provider| {
            provider.has_api_key = !provider.api_key.is_empty();
            provider
        })
        .collect();
    state
        .storage
        .save_agent_providers(&normalized, &state.crypto)?;
    Ok(normalized)
}

/// 读取全部 AI 对话历史，按更新时间倒序。
#[tauri::command]
pub fn list_agent_conversations(
    state: State<'_, AppState>,
) -> Result<Vec<AgentConversation>, String> {
    Ok(state.storage.load_agent_conversations()?)
}

/// 保存或更新一条对话。前端在每轮结束、以及切换/关闭对话时调用。
#[tauri::command]
pub fn save_agent_conversation(
    state: State<'_, AppState>,
    conversation: AgentConversation,
) -> Result<bool, String> {
    let mut list = state.storage.load_agent_conversations()?;
    match list.iter_mut().find(|item| item.id == conversation.id) {
        Some(existing) => *existing = conversation,
        None => list.push(conversation),
    }
    state.storage.save_agent_conversations(&list)?;
    Ok(true)
}

/// 删除一条对话。
#[tauri::command]
pub fn delete_agent_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<bool, String> {
    let list: Vec<AgentConversation> = state
        .storage
        .load_agent_conversations()?
        .into_iter()
        .filter(|item| item.id != conversation_id)
        .collect();
    state.storage.save_agent_conversations(&list)?;
    Ok(true)
}

/// 发起一轮内置 Agent 对话。工具执行、模型调用与 SSE 解析都在后台线程完成，
/// 增量通过 agent-chat-event 事件推给前端，命令本身立即返回。
#[tauri::command]
pub fn start_agent_chat(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    conversation_id: String,
    provider_id: String,
    model_id: String,
    history: Vec<agent_chat::ChatMessage>,
    options: Option<AgentRunOptions>,
) -> Result<bool, String> {
    let provider = state
        .storage
        .load_agent_providers(&state.crypto)?
        .into_iter()
        .find(|item| item.id == provider_id)
        .ok_or_else(|| AppError::NotFound(format!("agent provider {provider_id} not found")))?;
    if provider.api_key.trim().is_empty() {
        return Err(AppError::Validation("该端点尚未配置 API Key".into()).into());
    }

    let run_options = options.unwrap_or_default();
    let cancel_flag = state.agent_chat.register(&conversation_id);
    thread::spawn(move || {
        let app_state = app_handle.state::<AppState>();
        let settings = match app_state.storage.load_settings(&app_state.crypto) {
            Ok(settings) => settings,
            Err(error) => {
                emit_agent_chat_failure(&app_handle, &conversation_id, &error.to_string());
                app_state.agent_chat.finish(&conversation_id);
                return;
            }
        };

        let tools = agent_tools::build_tools();
        let mut messages = history;
        // 工具执行闭包复用 Bridge 的审批闸门，内置 Agent 与外部 MCP 授权策略完全一致。
        let execute = |call: &agent_chat::ChatToolCall| {
            agent_tools::execute_tool(
                &app_state.agent_bridge,
                &app_state.storage,
                &app_state.crypto,
                &settings.agent_bridge,
                &conversation_id,
                call,
            )
        };

        let outcome = agent_chat::run_chat_turn(
            &app_handle,
            &provider,
            &model_id,
            &conversation_id,
            &agent_tools::system_prompt(),
            &mut messages,
            &tools,
            &run_options,
            &cancel_flag,
            execute,
        );
        if let Err(error) = outcome {
            emit_agent_chat_failure(&app_handle, &conversation_id, &error.to_string());
        }
        app_state.agent_chat.finish(&conversation_id);
    });

    Ok(true)
}

/// 取消一轮进行中的对话；模型流与工具循环会在下一个安全点停止。
#[tauri::command]
pub fn cancel_agent_chat(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<bool, String> {
    Ok(state.agent_chat.cancel(&conversation_id))
}

fn emit_agent_chat_failure(app_handle: &tauri::AppHandle, conversation_id: &str, message: &str) {
    let _ = app_handle.emit(
        agent_chat::AGENT_CHAT_EVENT,
        agent_chat::AgentChatEvent::Failed {
            conversation_id: conversation_id.to_string(),
            message: message.to_string(),
        },
    );
}

#[tauri::command]
pub fn approve_agent_bridge_request(
    state: State<'_, AppState>,
    request_id: String,
    edited_command: Option<String>,
) -> Result<bool, String> {
    let settings = state.storage.load_settings(&state.crypto)?;
    Ok(agent_bridge::approve_request(
        &state.agent_bridge,
        &state.storage,
        &state.crypto,
        &settings.agent_bridge,
        &request_id,
        edited_command,
    )?)
}

#[tauri::command]
pub fn reject_agent_bridge_request(
    state: State<'_, AppState>,
    request_id: String,
    reason: Option<String>,
) -> Result<bool, String> {
    Ok(agent_bridge::reject_request(
        &state.agent_bridge,
        &request_id,
        reason,
    )?)
}

#[tauri::command]
pub fn clear_agent_bridge_requests(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(agent_bridge::clear_finished_requests(&state.agent_bridge)?)
}

/// 创建带动作按钮的 MCP 审批系统通知；按钮回调只发送前端事件，审批状态仍由现有审批接口处理。
#[tauri::command]
pub fn show_agent_bridge_notification(
    app_handle: AppHandle,
    request: AgentBridgeNotificationRequest,
) -> Result<bool, String> {
    // 系统通知只负责展示 Windows toast 与捕获动作按钮，实际审批仍统一回到前端调用既有 MCP 审批命令。
    let mut notification = notify_rust::Notification::new();
    notification
        .summary(&request.title)
        .body(&request.body)
        .action(
            AGENT_BRIDGE_NOTIFICATION_APPROVE_ACTION_ID,
            &request.approve_label,
        )
        .action(
            AGENT_BRIDGE_NOTIFICATION_REJECT_ACTION_ID,
            &request.reject_label,
        );

    #[cfg(windows)]
    {
        // Windows toast 需要稳定的 AppUserModelID；沿用 Tauri 配置里的应用标识，和系统通知中心归属保持一致。
        notification.app_id(&app_handle.config().identifier);
    }

    let request_id = request.request_id;
    let event_app_handle = app_handle.clone();
    let handle = notification
        .show()
        .map_err(|error| format!("notification error: {error}"))?;

    thread::spawn(move || {
        // notify-rust 的动作等待是阻塞式；单独线程只负责把系统按钮动作转成前端事件。
        handle.wait_for_action(|action_id| {
            let _ = event_app_handle.emit(
                AGENT_BRIDGE_NOTIFICATION_ACTION_EVENT,
                AgentBridgeNotificationActionEvent {
                    request_id: request_id.clone(),
                    action_id: action_id.to_string(),
                },
            );
        });
    });

    Ok(true)
}

#[tauri::command]
pub fn set_agent_bridge_enabled(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<agent_bridge::AgentBridgeStatus, String> {
    agent_bridge::set_app_handle(&state.agent_bridge, app_handle)?;
    let mut settings = state.storage.load_settings(&state.crypto)?;
    settings.agent_bridge.enabled = enabled;
    state.storage.save_settings(&settings, &state.crypto)?;
    if enabled {
        prepare_agent_bridge_startup()?;
    }
    agent_bridge::sync_server(
        &state.agent_bridge,
        &state.storage,
        &state.crypto,
        &settings.agent_bridge,
    )?;
    Ok(agent_bridge::bridge_status(
        &state.agent_bridge,
        &state.storage,
        &settings.agent_bridge,
    )?)
}

#[tauri::command]
pub fn reset_agent_bridge_token(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<agent_bridge::AgentBridgeStatus, String> {
    agent_bridge::set_app_handle(&state.agent_bridge, app_handle)?;
    let settings = state.storage.load_settings(&state.crypto)?;
    agent_bridge::stop_server(&state.agent_bridge, &state.storage)?;
    agent_bridge::reset_agent_bridge_token(&state.storage)?;
    if settings.agent_bridge.enabled {
        prepare_agent_bridge_startup()?;
    }
    agent_bridge::sync_server(
        &state.agent_bridge,
        &state.storage,
        &state.crypto,
        &settings.agent_bridge,
    )?;
    Ok(agent_bridge::bridge_status(
        &state.agent_bridge,
        &state.storage,
        &settings.agent_bridge,
    )?)
}
