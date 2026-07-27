//! 内置 Agent 聊天内核：统一的消息模型 + 三种接口协议适配 + 工具调用循环。
//!
//! 设计要点：
//! 1. API Key 只在后端内存与加密文件之间流转，永不下发到 WebView。
//! 2. 三种协议（anthropic / openai-chat / openai-responses）在内部收敛为同一套消息与工具模型，
//!    只有请求构造与 SSE 解析按协议分派，工具循环本身完全共用。
//! 3. 增量文本通过 Tauri 事件按节流推送给前端，与终端输出的“事件唤醒”范式保持一致。

use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::{
    error::AppError,
    models::{AgentProvider, AgentRunOptions},
};

/// 前端接收增量的事件名；payload 为 AgentChatEvent。
pub const AGENT_CHAT_EVENT: &str = "agent-chat-event";
/// 增量文本的推送节流间隔，避免每个 token 都过一次 IPC。
const DELTA_FLUSH_INTERVAL: Duration = Duration::from_millis(50);
/// 单轮对话最多允许的工具调用轮次，防止模型陷入死循环无限消耗额度。
const MAX_TOOL_ITERATIONS: usize = 24;
/// HTTP 连接与整体超时；流式回复可能很长，整体超时给足。
const CHAT_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const CHAT_TOTAL_TIMEOUT: Duration = Duration::from_secs(1800);

/// 一条对话消息的角色。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    User,
    Assistant,
}

/// 模型请求的一次工具调用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatToolCall {
    /// 协议原生的调用 id，回传结果时必须原样带回。
    pub id: String,
    pub name: String,
    /// 工具入参；流式场景下由分片 JSON 拼接而成。
    pub arguments: Value,
}

/// 一条工具执行结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatToolResult {
    pub tool_call_id: String,
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub is_error: bool,
}

/// 统一的对话消息模型；三种协议都由它转换而来。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: ChatRole,
    #[serde(default)]
    pub content: String,
    /// 助手回合请求的工具调用。
    #[serde(default)]
    pub tool_calls: Vec<ChatToolCall>,
    /// 用户回合携带的工具执行结果。
    #[serde(default)]
    pub tool_results: Vec<ChatToolResult>,
}

/// 暴露给模型的工具定义。
#[derive(Debug, Clone)]
pub struct ChatTool {
    pub name: String,
    pub description: String,
    /// JSON Schema 描述的入参结构。
    pub input_schema: Value,
}

/// 推送给前端的流式事件。
#[derive(Debug, Clone, Serialize)]
// rename_all 只改变体名，字段名必须用 rename_all_fields 单独转成 camelCase，
// 否则前端读到的 conversationId 永远是 undefined，事件会被整体丢弃。
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentChatEvent {
    /// 助手文本增量。
    TextDelta { conversation_id: String, text: String },
    /// 模型决定调用工具。
    ToolCall {
        conversation_id: String,
        id: String,
        name: String,
        arguments: Value,
    },
    /// 工具执行完毕。
    ToolResult {
        conversation_id: String,
        id: String,
        name: String,
        content: String,
        is_error: bool,
    },
    /// 本轮结束。
    Completed {
        conversation_id: String,
        stop_reason: String,
    },
    /// 上下文超限已自动压缩；如实告知用户，避免它以为模型"忘了"之前的事。
    Compacted {
        conversation_id: String,
        /// 被折叠成摘要的消息条数。
        dropped_messages: usize,
    },
    /// 出错终止。
    Failed {
        conversation_id: String,
        message: String,
    },
}

/// 一次模型调用返回的结果。
#[derive(Debug, Default)]
struct ModelTurn {
    text: String,
    tool_calls: Vec<ChatToolCall>,
    stop_reason: String,
}

/// 粗略估算一段文本的 token 数。
/// 不引入 tokenizer 依赖：中文约 1 字 1 token，英文约 4 字符 1 token，取两者的保守估计。
/// 只用于决定何时压缩，偏大一点只会更早压缩，不会导致真正溢出。
fn estimate_tokens(text: &str) -> usize {
    let chars = text.chars().count();
    let ascii = text.chars().filter(char::is_ascii).count();
    let non_ascii = chars - ascii;
    non_ascii + ascii.div_ceil(3)
}

/// 估算整段历史加系统提示词的 token 占用。
fn estimate_history_tokens(system_prompt: &str, history: &[ChatMessage]) -> usize {
    let mut total = estimate_tokens(system_prompt);
    for message in history {
        total += estimate_tokens(&message.content);
        for call in &message.tool_calls {
            total += estimate_tokens(&call.name) + estimate_tokens(&call.arguments.to_string());
        }
        for result in &message.tool_results {
            total += estimate_tokens(&result.content);
        }
        // 每条消息的角色、分隔符等固定开销。
        total += 8;
    }
    total
}

/// 把较早的对话折叠成一段文字摘要，保留最近若干轮原文。
///
/// 采用本地摘要而非再调一次模型：压缩发生在上下文已经吃紧时，
/// 此时再发一次完整历史去生成摘要，很可能当场超限。
fn compact_history(history: &mut Vec<ChatMessage>) -> usize {
    // 至少保留最近 6 条原文，太少会让模型丢失当前任务的直接上下文。
    const KEEP_RECENT: usize = 6;
    if history.len() <= KEEP_RECENT + 2 {
        return 0;
    }

    let split = history.len() - KEEP_RECENT;
    let dropped: Vec<ChatMessage> = history.drain(..split).collect();
    let dropped_count = dropped.len();

    let mut summary = String::from("【以下是本次对话较早内容的摘要，原文已因上下文长度限制折叠】\n");
    for message in &dropped {
        let role = match message.role {
            ChatRole::User => "用户",
            ChatRole::Assistant => "助手",
        };
        let text = message.content.trim();
        if !text.is_empty() {
            // 每条只留首段，长文本截断，摘要本身不能又把上下文撑爆。
            let line: String = text.chars().take(200).collect();
            summary.push_str(&format!("- {role}：{line}\n"));
        }
        for call in &message.tool_calls {
            summary.push_str(&format!("- 助手调用了工具 {}\n", call.name));
        }
        for result in &message.tool_results {
            let status = if result.is_error { "失败" } else { "成功" };
            summary.push_str(&format!("- 工具 {} 执行{}\n", result.name, status));
        }
    }

    // 摘要以用户回合注入：它是"提供给模型的既有事实"，不是模型自己说过的话。
    history.insert(
        0,
        ChatMessage {
            role: ChatRole::User,
            content: summary,
            tool_calls: Vec::new(),
            tool_results: Vec::new(),
        },
    );
    dropped_count
}

/// 驱动一轮完整对话：反复调用模型、执行工具、回填结果，直到模型不再请求工具。
///
/// `cancel_flag` 置位后在下一个安全点停止；`execute_tool` 内部应复用现有审批闸门。
/// 工具回调用泛型而非 trait object：整轮对话都跑在同一个线程里，
/// 不需要 Send + Sync 约束，调用方因此可以直接捕获 Tauri 的 State 守卫。
#[allow(clippy::too_many_arguments)]
pub fn run_chat_turn<F>(
    app_handle: &AppHandle,
    provider: &AgentProvider,
    model_id: &str,
    conversation_id: &str,
    system_prompt: &str,
    history: &mut Vec<ChatMessage>,
    tools: &[ChatTool],
    options: &AgentRunOptions,
    cancel_flag: &Arc<AtomicBool>,
    execute_tool: F,
) -> Result<(), AppError>
where
    F: Fn(&ChatToolCall) -> ChatToolResult,
{
    let model = provider
        .models
        .iter()
        .find(|item| item.id == model_id)
        .cloned()
        .ok_or_else(|| AppError::Validation(format!("model {model_id} is not configured")))?;
    let client = build_chat_client()?;
    // 压缩阈值按上下文窗口折算成 token 数；比例做钳制，防止配置成 0 或 >1 导致每轮都压缩。
    let compact_limit = (model.context_window as f32
        * options.compact_threshold.clamp(0.1, 0.95)) as usize;

    for _ in 0..MAX_TOOL_ITERATIONS {
        // 每轮请求前检查上下文占用：工具结果往往很长，一轮之内就可能逼近上限。
        if options.auto_compact && estimate_history_tokens(system_prompt, history) > compact_limit {
            let dropped = compact_history(history);
            if dropped > 0 {
                emit_event(
                    app_handle,
                    AgentChatEvent::Compacted {
                        conversation_id: conversation_id.to_string(),
                        dropped_messages: dropped,
                    },
                );
            }
        }

        if cancel_flag.load(Ordering::Relaxed) {
            emit_event(
                app_handle,
                AgentChatEvent::Completed {
                    conversation_id: conversation_id.to_string(),
                    stop_reason: "cancelled".into(),
                },
            );
            return Ok(());
        }

        let turn = request_model_turn(
            &client,
            app_handle,
            provider,
            &model.id,
            model.max_tokens,
            conversation_id,
            system_prompt,
            history,
            tools,
            options,
            cancel_flag,
        )?;

        // 助手回合必须完整入历史（含工具调用），否则下一轮模型看不到自己刚才的决定。
        history.push(ChatMessage {
            role: ChatRole::Assistant,
            content: turn.text.clone(),
            tool_calls: turn.tool_calls.clone(),
            tool_results: Vec::new(),
        });

        if turn.tool_calls.is_empty() {
            emit_event(
                app_handle,
                AgentChatEvent::Completed {
                    conversation_id: conversation_id.to_string(),
                    stop_reason: turn.stop_reason,
                },
            );
            return Ok(());
        }

        let mut tool_results = Vec::with_capacity(turn.tool_calls.len());
        for call in &turn.tool_calls {
            emit_event(
                app_handle,
                AgentChatEvent::ToolCall {
                    conversation_id: conversation_id.to_string(),
                    id: call.id.clone(),
                    name: call.name.clone(),
                    arguments: call.arguments.clone(),
                },
            );

            let result = if cancel_flag.load(Ordering::Relaxed) {
                ChatToolResult {
                    tool_call_id: call.id.clone(),
                    name: call.name.clone(),
                    content: "用户已取消本次操作。".into(),
                    is_error: true,
                }
            } else {
                execute_tool(call)
            };

            emit_event(
                app_handle,
                AgentChatEvent::ToolResult {
                    conversation_id: conversation_id.to_string(),
                    id: result.tool_call_id.clone(),
                    name: result.name.clone(),
                    content: result.content.clone(),
                    is_error: result.is_error,
                },
            );
            tool_results.push(result);
        }

        // 全部工具结果放在同一个用户回合里回传，符合三种协议的并行工具调用约定。
        history.push(ChatMessage {
            role: ChatRole::User,
            content: String::new(),
            tool_calls: Vec::new(),
            tool_results,
        });
    }

    Err(AppError::Validation(format!(
        "agent exceeded {MAX_TOOL_ITERATIONS} tool iterations without finishing"
    )))
}

/// 复用与更新检查一致的客户端构造：尊重系统代理、rustls、分层超时。
fn build_chat_client() -> Result<reqwest::blocking::Client, AppError> {
    reqwest::blocking::Client::builder()
        .connect_timeout(CHAT_CONNECT_TIMEOUT)
        .timeout(CHAT_TOTAL_TIMEOUT)
        .build()
        .map_err(AppError::from)
}

/// 按协议构造请求、发起流式调用并解析出一次完整的模型回合。
#[allow(clippy::too_many_arguments)]
fn request_model_turn(
    client: &reqwest::blocking::Client,
    app_handle: &AppHandle,
    provider: &AgentProvider,
    model_id: &str,
    max_tokens: u32,
    conversation_id: &str,
    system_prompt: &str,
    history: &[ChatMessage],
    tools: &[ChatTool],
    options: &AgentRunOptions,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<ModelTurn, AppError> {
    let protocol = provider.protocol.as_str();
    let effort = options.effort.as_api_value();
    let (url, body) = match protocol {
        "anthropic" => (
            join_url(&provider.base_url, "/v1/messages"),
            build_anthropic_body(model_id, max_tokens, system_prompt, history, tools, effort),
        ),
        "openai-chat" => (
            join_url(&provider.base_url, "/v1/chat/completions"),
            build_openai_chat_body(model_id, max_tokens, system_prompt, history, tools, effort),
        ),
        "openai-responses" => (
            join_url(&provider.base_url, "/v1/responses"),
            build_openai_responses_body(model_id, max_tokens, system_prompt, history, tools, effort),
        ),
        other => {
            return Err(AppError::Validation(format!(
                "unsupported agent protocol: {other}"
            )))
        }
    };

    let mut request = client.post(url).json(&body);
    request = match protocol {
        // Anthropic 用 x-api-key 且必须带版本头；其余两种走标准 Bearer。
        "anthropic" => request
            .header("x-api-key", &provider.api_key)
            .header("anthropic-version", "2023-06-01"),
        _ => request.header("authorization", format!("Bearer {}", provider.api_key)),
    };

    let response = request.send().map_err(AppError::from)?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().unwrap_or_default();
        // 400/404 最常见的原因是接口协议选错（例如把 Chat Completions 端点配成了 Responses），
        // 光把原始报文抛给用户很难自行判断，这里补一句可操作的排查提示。
        let hint = if matches!(status.as_u16(), 400 | 404 | 422) {
            format!(
                "\n提示：请确认端点「{}」的接口协议是否选对（当前为 {}），以及服务地址是否指向该协议对应的路径。",
                provider.name, protocol
            )
        } else if status.as_u16() == 401 || status.as_u16() == 403 {
            "\n提示：请检查 API Key 是否正确、是否有该模型的访问权限。".to_string()
        } else {
            String::new()
        };
        return Err(AppError::Validation(format!(
            "{} 返回 {}：{}{}",
            provider.name,
            status.as_u16(),
            truncate_for_message(&detail),
            hint
        )));
    }

    consume_sse_stream(
        response,
        protocol,
        app_handle,
        conversation_id,
        cancel_flag,
    )
}

/// 读取 SSE 流并按协议解析增量，边解析边把文本增量节流推给前端。
fn consume_sse_stream(
    response: reqwest::blocking::Response,
    protocol: &str,
    app_handle: &AppHandle,
    conversation_id: &str,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<ModelTurn, AppError> {
    use std::io::{BufRead, BufReader};

    let mut turn = ModelTurn::default();
    // 工具入参在三种协议里都是分片 JSON 文本，需按调用序号累积后再统一解析。
    let mut partial_tool_args: Vec<(String, String, String)> = Vec::new();
    let mut pending_delta = String::new();
    let mut last_flush = Instant::now();

    let reader = BufReader::new(response);
    for line in reader.lines() {
        if cancel_flag.load(Ordering::Relaxed) {
            break;
        }

        let line = line.map_err(AppError::from)?;
        let Some(payload) = line.strip_prefix("data:") else {
            continue;
        };
        let payload = payload.trim();
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(payload) else {
            continue;
        };

        match protocol {
            "anthropic" => {
                parse_anthropic_event(&event, &mut turn, &mut partial_tool_args, &mut pending_delta)
            }
            "openai-chat" => {
                parse_openai_chat_event(&event, &mut turn, &mut partial_tool_args, &mut pending_delta)
            }
            _ => parse_openai_responses_event(
                &event,
                &mut turn,
                &mut partial_tool_args,
                &mut pending_delta,
            ),
        }

        // 按固定间隔推送增量，既保证观感连续又不让每个 token 都过一次 IPC。
        if !pending_delta.is_empty() && last_flush.elapsed() >= DELTA_FLUSH_INTERVAL {
            flush_delta(app_handle, conversation_id, &mut pending_delta);
            last_flush = Instant::now();
        }
    }

    if !pending_delta.is_empty() {
        flush_delta(app_handle, conversation_id, &mut pending_delta);
    }

    // 收尾：把累积的分片参数解析成结构化 JSON。解析失败时保留原文，便于排查而非静默丢弃。
    for (id, name, raw) in partial_tool_args {
        let arguments = serde_json::from_str::<Value>(raw.trim())
            .unwrap_or_else(|_| json!({ "__raw": raw }));
        turn.tool_calls.push(ChatToolCall {
            id,
            name,
            arguments,
        });
    }

    Ok(turn)
}

fn flush_delta(app_handle: &AppHandle, conversation_id: &str, pending: &mut String) {
    let text = std::mem::take(pending);
    emit_event(
        app_handle,
        AgentChatEvent::TextDelta {
            conversation_id: conversation_id.to_string(),
            text,
        },
    );
}

/// 解析 Anthropic Messages API 的流式事件。
fn parse_anthropic_event(
    event: &Value,
    turn: &mut ModelTurn,
    partial_tool_args: &mut Vec<(String, String, String)>,
    pending_delta: &mut String,
) {
    match event.get("type").and_then(Value::as_str) {
        Some("content_block_start") => {
            let block = event.get("content_block");
            if block.and_then(|b| b.get("type")).and_then(Value::as_str) == Some("tool_use") {
                let id = block
                    .and_then(|b| b.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let name = block
                    .and_then(|b| b.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                partial_tool_args.push((id, name, String::new()));
            }
        }
        Some("content_block_delta") => {
            let delta = event.get("delta");
            match delta.and_then(|d| d.get("type")).and_then(Value::as_str) {
                Some("text_delta") => {
                    if let Some(text) = delta.and_then(|d| d.get("text")).and_then(Value::as_str) {
                        turn.text.push_str(text);
                        pending_delta.push_str(text);
                    }
                }
                Some("input_json_delta") => {
                    if let Some(chunk) = delta
                        .and_then(|d| d.get("partial_json"))
                        .and_then(Value::as_str)
                    {
                        if let Some(last) = partial_tool_args.last_mut() {
                            last.2.push_str(chunk);
                        }
                    }
                }
                _ => {}
            }
        }
        Some("message_delta") => {
            if let Some(reason) = event
                .pointer("/delta/stop_reason")
                .and_then(Value::as_str)
            {
                turn.stop_reason = reason.to_string();
            }
        }
        _ => {}
    }
}

/// 解析 OpenAI Chat Completions 的流式事件。
fn parse_openai_chat_event(
    event: &Value,
    turn: &mut ModelTurn,
    partial_tool_args: &mut Vec<(String, String, String)>,
    pending_delta: &mut String,
) {
    let Some(choice) = event.pointer("/choices/0") else {
        return;
    };
    if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
        turn.stop_reason = reason.to_string();
    }
    let Some(delta) = choice.get("delta") else {
        return;
    };

    if let Some(text) = delta.get("content").and_then(Value::as_str) {
        turn.text.push_str(text);
        pending_delta.push_str(text);
    }

    let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) else {
        return;
    };
    for call in calls {
        // index 决定分片归属；同一个 index 的多次增量拼成一次完整调用。
        let index = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        while partial_tool_args.len() <= index {
            partial_tool_args.push((String::new(), String::new(), String::new()));
        }
        let slot = &mut partial_tool_args[index];
        if let Some(id) = call.get("id").and_then(Value::as_str) {
            slot.0 = id.to_string();
        }
        if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
            slot.1 = name.to_string();
        }
        if let Some(chunk) = call.pointer("/function/arguments").and_then(Value::as_str) {
            slot.2.push_str(chunk);
        }
    }
}

/// 解析 OpenAI Responses API 的流式事件。
fn parse_openai_responses_event(
    event: &Value,
    turn: &mut ModelTurn,
    partial_tool_args: &mut Vec<(String, String, String)>,
    pending_delta: &mut String,
) {
    match event.get("type").and_then(Value::as_str) {
        Some("response.output_text.delta") => {
            if let Some(text) = event.get("delta").and_then(Value::as_str) {
                turn.text.push_str(text);
                pending_delta.push_str(text);
            }
        }
        Some("response.output_item.added") => {
            let item = event.get("item");
            if item.and_then(|i| i.get("type")).and_then(Value::as_str) == Some("function_call") {
                let id = item
                    .and_then(|i| i.get("call_id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let name = item
                    .and_then(|i| i.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                partial_tool_args.push((id, name, String::new()));
            }
        }
        Some("response.function_call_arguments.delta") => {
            if let Some(chunk) = event.get("delta").and_then(Value::as_str) {
                if let Some(last) = partial_tool_args.last_mut() {
                    last.2.push_str(chunk);
                }
            }
        }
        Some("response.completed") => {
            turn.stop_reason = "completed".into();
        }
        _ => {}
    }
}

/// 构造 Anthropic Messages API 请求体。
fn build_anthropic_body(
    model_id: &str,
    max_tokens: u32,
    system_prompt: &str,
    history: &[ChatMessage],
    tools: &[ChatTool],
    effort: Option<&str>,
) -> Value {
    let messages: Vec<Value> = history
        .iter()
        .map(|message| {
            let mut blocks: Vec<Value> = Vec::new();
            // 工具结果必须排在同一用户回合的最前面，符合 Anthropic 对 tool_result 的位置约定。
            for result in &message.tool_results {
                blocks.push(json!({
                    "type": "tool_result",
                    "tool_use_id": result.tool_call_id,
                    "content": result.content,
                    "is_error": result.is_error,
                }));
            }
            if !message.content.is_empty() {
                blocks.push(json!({ "type": "text", "text": message.content }));
            }
            for call in &message.tool_calls {
                blocks.push(json!({
                    "type": "tool_use",
                    "id": call.id,
                    "name": call.name,
                    "input": call.arguments,
                }));
            }
            if blocks.is_empty() {
                blocks.push(json!({ "type": "text", "text": "" }));
            }
            json!({
                "role": match message.role { ChatRole::User => "user", ChatRole::Assistant => "assistant" },
                "content": blocks,
            })
        })
        .collect();

    let mut body = json!({
        "model": model_id,
        "max_tokens": max_tokens,
        "stream": true,
        "messages": messages,
    });
    if !system_prompt.is_empty() {
        body["system"] = json!(system_prompt);
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools
            .iter()
            .map(|tool| json!({
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.input_schema,
            }))
            .collect::<Vec<_>>());
    }
    // effort 位于 output_config 内，且需配合 adaptive thinking 才有意义。
    if let Some(effort) = effort {
        body["output_config"] = json!({ "effort": effort });
        body["thinking"] = json!({ "type": "adaptive" });
    }
    body
}

/// 构造 OpenAI Chat Completions 请求体。
fn build_openai_chat_body(
    model_id: &str,
    max_tokens: u32,
    system_prompt: &str,
    history: &[ChatMessage],
    tools: &[ChatTool],
    effort: Option<&str>,
) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    if !system_prompt.is_empty() {
        messages.push(json!({ "role": "system", "content": system_prompt }));
    }

    for message in history {
        // 工具结果在该协议里是独立的 role:"tool" 消息，必须先于后续用户内容发出。
        for result in &message.tool_results {
            messages.push(json!({
                "role": "tool",
                "tool_call_id": result.tool_call_id,
                "content": result.content,
            }));
        }

        match message.role {
            ChatRole::Assistant => {
                let mut entry = json!({ "role": "assistant" });
                entry["content"] = if message.content.is_empty() {
                    Value::Null
                } else {
                    json!(message.content)
                };
                if !message.tool_calls.is_empty() {
                    entry["tool_calls"] = json!(message
                        .tool_calls
                        .iter()
                        .map(|call| json!({
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": call.arguments.to_string(),
                            },
                        }))
                        .collect::<Vec<_>>());
                }
                messages.push(entry);
            }
            ChatRole::User => {
                if !message.content.is_empty() {
                    messages.push(json!({ "role": "user", "content": message.content }));
                }
            }
        }
    }

    let mut body = json!({
        "model": model_id,
        "max_tokens": max_tokens,
        "stream": true,
        "messages": messages,
    });
    if !tools.is_empty() {
        body["tools"] = json!(tools
            .iter()
            .map(|tool| json!({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.input_schema,
                },
            }))
            .collect::<Vec<_>>());
    }
    // OpenAI 推理模型用顶层 reasoning_effort；非推理模型会忽略该字段。
    if let Some(effort) = effort {
        body["reasoning_effort"] = json!(effort);
    }
    body
}

/// 构造 OpenAI Responses API 请求体。
fn build_openai_responses_body(
    model_id: &str,
    max_tokens: u32,
    system_prompt: &str,
    history: &[ChatMessage],
    tools: &[ChatTool],
    effort: Option<&str>,
) -> Value {
    let mut input: Vec<Value> = Vec::new();

    for message in history {
        // Responses 协议用独立的 function_call_output 条目回传工具结果。
        for result in &message.tool_results {
            input.push(json!({
                "type": "function_call_output",
                "call_id": result.tool_call_id,
                "output": result.content,
            }));
        }

        match message.role {
            ChatRole::Assistant => {
                if !message.content.is_empty() {
                    input.push(json!({
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": message.content }],
                    }));
                }
                for call in &message.tool_calls {
                    input.push(json!({
                        "type": "function_call",
                        "call_id": call.id,
                        "name": call.name,
                        "arguments": call.arguments.to_string(),
                    }));
                }
            }
            ChatRole::User => {
                if !message.content.is_empty() {
                    input.push(json!({
                        "role": "user",
                        "content": [{ "type": "input_text", "text": message.content }],
                    }));
                }
            }
        }
    }

    // Responses 要求 input 非空，否则返回 missing_required_parameter。
    // 正常流程下历史不可能为空，这里只是最后一道防线，避免把必然失败的请求发出去。
    if input.is_empty() {
        input.push(json!({
            "role": "user",
            "content": [{ "type": "input_text", "text": "继续" }],
        }));
    }

    let mut body = json!({
        "model": model_id,
        "max_output_tokens": max_tokens,
        "stream": true,
        "input": input,
    });
    if !system_prompt.is_empty() {
        body["instructions"] = json!(system_prompt);
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools
            .iter()
            .map(|tool| json!({
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.input_schema,
            }))
            .collect::<Vec<_>>());
    }
    // Responses 协议把思考强度放在 reasoning 对象里。
    if let Some(effort) = effort {
        body["reasoning"] = json!({ "effort": effort });
    }
    body
}

/// 拼接基址与路径，容忍用户填写时多写或少写斜杠，也允许直接填完整端点。
fn join_url(base_url: &str, path: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    // 用户已经填到具体端点时不再追加路径，避免拼出 /v1/messages/v1/messages。
    if trimmed.ends_with(path) {
        return trimmed.to_string();
    }
    // 很多代理服务的文档给的地址就带 /v1（如 https://x.com/v1），
    // 直接追加会拼成 /v1/v1/messages。这里剥掉重复的版本段再拼。
    if let Some(version) = path.strip_prefix('/').and_then(|p| p.split('/').next()) {
        let version_suffix = format!("/{version}");
        if trimmed.ends_with(&version_suffix) {
            let base = &trimmed[..trimmed.len() - version_suffix.len()];
            return format!("{base}{path}");
        }
    }
    format!("{trimmed}{path}")
}

/// 错误正文可能很长，截断后再拼进提示，避免把整页 HTML 塞给用户。
fn truncate_for_message(value: &str) -> String {
    const MAX: usize = 500;
    let trimmed = value.trim();
    if trimmed.len() <= MAX {
        return trimmed.to_string();
    }
    let mut cut = MAX;
    while cut > 0 && !trimmed.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &trimmed[..cut])
}

fn emit_event(app_handle: &AppHandle, event: AgentChatEvent) {
    let _ = app_handle.emit(AGENT_CHAT_EVENT, event);
}

/// 运行中的对话注册表：保存取消标志，供前端随时中止一轮对话。
#[derive(Debug, Default)]
pub struct AgentChatRuntime {
    running: Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>,
}

impl AgentChatRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记一轮对话并返回其取消标志。
    pub fn register(&self, conversation_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut running) = self.running.lock() {
            running.insert(conversation_id.to_string(), Arc::clone(&flag));
        }
        flag
    }

    pub fn finish(&self, conversation_id: &str) {
        if let Ok(mut running) = self.running.lock() {
            running.remove(conversation_id);
        }
    }

    /// 置位取消标志；对话会在下一个安全点停止。
    pub fn cancel(&self, conversation_id: &str) -> bool {
        let Ok(running) = self.running.lock() else {
            return false;
        };
        match running.get(conversation_id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_url_normalizes_slashes_and_full_endpoints() {
        assert_eq!(
            join_url("https://api.anthropic.com", "/v1/messages"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            join_url("https://api.anthropic.com/", "/v1/messages"),
            "https://api.anthropic.com/v1/messages"
        );
        // 用户直接填完整端点时不重复追加路径。
        assert_eq!(
            join_url("https://api.anthropic.com/v1/messages", "/v1/messages"),
            "https://api.anthropic.com/v1/messages"
        );
        // 代理服务文档常给带 /v1 的地址，不能拼成 /v1/v1/...
        assert_eq!(
            join_url("https://proxy.example.com/v1", "/v1/chat/completions"),
            "https://proxy.example.com/v1/chat/completions"
        );
        assert_eq!(
            join_url("https://proxy.example.com/v1/", "/v1/responses"),
            "https://proxy.example.com/v1/responses"
        );
        // 路径里含 v1 的子路由（如 /api/v1）同样只剥最后一段版本号。
        assert_eq!(
            join_url("https://proxy.example.com/api/v1", "/v1/messages"),
            "https://proxy.example.com/api/v1/messages"
        );
    }

    #[test]
    fn anthropic_stream_collects_text_and_tool_calls() {
        let mut turn = ModelTurn::default();
        let mut partial = Vec::new();
        let mut pending = String::new();

        for event in [
            json!({ "type": "content_block_delta", "delta": { "type": "text_delta", "text": "查看" } }),
            json!({ "type": "content_block_start", "content_block": { "type": "tool_use", "id": "toolu_1", "name": "run_command" } }),
            json!({ "type": "content_block_delta", "delta": { "type": "input_json_delta", "partial_json": "{\"command\":" } }),
            json!({ "type": "content_block_delta", "delta": { "type": "input_json_delta", "partial_json": "\"ls\"}" } }),
            json!({ "type": "message_delta", "delta": { "stop_reason": "tool_use" } }),
        ] {
            parse_anthropic_event(&event, &mut turn, &mut partial, &mut pending);
        }

        assert_eq!(turn.text, "查看");
        assert_eq!(turn.stop_reason, "tool_use");
        // 分片 JSON 必须拼接完整后才能解析。
        assert_eq!(partial.len(), 1);
        assert_eq!(partial[0].1, "run_command");
        assert_eq!(partial[0].2, "{\"command\":\"ls\"}");
    }

    #[test]
    fn openai_chat_stream_merges_tool_call_fragments_by_index() {
        let mut turn = ModelTurn::default();
        let mut partial = Vec::new();
        let mut pending = String::new();

        for event in [
            json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "call_1", "function": { "name": "run_command", "arguments": "{\"cmd\"" } }] } }] }),
            json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": ":\"ls\"}" } }] } }] }),
            json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] }),
        ] {
            parse_openai_chat_event(&event, &mut turn, &mut partial, &mut pending);
        }

        assert_eq!(turn.stop_reason, "tool_calls");
        assert_eq!(partial.len(), 1);
        assert_eq!(partial[0].0, "call_1");
        assert_eq!(partial[0].2, "{\"cmd\":\"ls\"}");
    }

    #[test]
    fn openai_responses_stream_collects_function_call() {
        let mut turn = ModelTurn::default();
        let mut partial = Vec::new();
        let mut pending = String::new();

        for event in [
            json!({ "type": "response.output_text.delta", "delta": "好的" }),
            json!({ "type": "response.output_item.added", "item": { "type": "function_call", "call_id": "fc_1", "name": "file_read" } }),
            json!({ "type": "response.function_call_arguments.delta", "delta": "{\"path\":\"/tmp/a\"}" }),
            json!({ "type": "response.completed" }),
        ] {
            parse_openai_responses_event(&event, &mut turn, &mut partial, &mut pending);
        }

        assert_eq!(turn.text, "好的");
        assert_eq!(turn.stop_reason, "completed");
        assert_eq!(partial[0].0, "fc_1");
        assert_eq!(partial[0].2, "{\"path\":\"/tmp/a\"}");
    }

    #[test]
    fn anthropic_body_places_tool_results_before_text() {
        let history = vec![ChatMessage {
            role: ChatRole::User,
            content: String::new(),
            tool_calls: Vec::new(),
            tool_results: vec![ChatToolResult {
                tool_call_id: "toolu_1".into(),
                name: "run_command".into(),
                content: "ok".into(),
                is_error: false,
            }],
        }];
        let body = build_anthropic_body("claude-opus-5", 1024, "system", &history, &[], None);

        let blocks = body.pointer("/messages/0/content").and_then(Value::as_array).unwrap();
        assert_eq!(blocks[0]["type"], "tool_result");
        assert_eq!(body["system"], "system");
        // 流式必须开启，否则长回复会撞上 HTTP 超时。
        assert_eq!(body["stream"], true);
    }
}
