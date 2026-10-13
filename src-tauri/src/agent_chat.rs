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
    models::{AgentConversation, AgentProvider, AgentRunOptions},
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    #[default]
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
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    /// 用户回合附带的图片或本地文本文件。
    #[serde(default)]
    pub attachments: Vec<ChatAttachment>,
    /// Anthropic 助手回合的原始内容块（含 thinking / redacted_thinking 及签名）。
    /// 开启思考时，工具循环里的助手回合必须把这些块原样回传，否则模型丢失推理甚至直接报错；
    /// 只在本轮工具循环内存在，不下发前端、不落盘，下一轮发言时自然丢弃。
    #[serde(skip)]
    pub native_blocks: Vec<Value>,
    /// OpenAI 兼容端点（DeepSeek、Kimi 等思考模型）返回的 reasoning_content，工具循环内同样需要回传。
    #[serde(skip)]
    pub reasoning_content: String,
}

/// 用户消息附带的附件；图片只在多模态模型下以原生图片块下发，文本文件统一展开成带来源标注的文本。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ChatAttachment {
    Image {
        name: String,
        #[serde(default)]
        path: String,
        media_type: String,
        /// 不带 data: 前缀的 base64 图片数据。
        data: String,
    },
    Text {
        name: String,
        #[serde(default)]
        path: String,
        content: String,
        #[serde(default)]
        truncated: bool,
    },
}

/// 单张图片在上下文估算中的保守 token 占用；前端已把长边缩到 1568px 以内。
const IMAGE_TOKEN_ESTIMATE: usize = 1600;

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
    /// Anthropic 原始内容块，按到达顺序保存，供工具循环原样回放。
    native_blocks: Vec<Value>,
    /// OpenAI 兼容端点的思考内容（reasoning_content）。
    reasoning: String,
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
        for attachment in &message.attachments {
            total += match attachment {
                ChatAttachment::Image { .. } => IMAGE_TOKEN_ESTIMATE,
                ChatAttachment::Text { content, path, .. } => {
                    estimate_tokens(content) + estimate_tokens(path) + 16
                }
            };
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
        // 附件原文随折叠一起丢弃，只留下“给过什么文件”的线索，模型需要时可请用户重新提供。
        for attachment in &message.attachments {
            match attachment {
                ChatAttachment::Image { name, .. } => {
                    summary.push_str(&format!("- 用户附带了图片 {name}\n"))
                }
                ChatAttachment::Text { name, path, .. } => {
                    let source = if path.is_empty() { name } else { path };
                    summary.push_str(&format!("- 用户附带了文件 {source}\n"))
                }
            }
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
            attachments: Vec::new(),
            ..Default::default()
        },
    );
    // 摘要改写了历史前缀，此前产生的 thinking 块与新前缀不再匹配，回放会被视为篡改，统一退回普通渲染。
    for message in history.iter_mut() {
        message.native_blocks.clear();
    }
    dropped_count
}

/// 读取已落盘对话绑定的端点与模型。
///
/// 只有本会话里至少有一条模型真正给出的回复（正文或工具调用）才算绑定：
/// 首轮请求失败时前端会移除空的助手占位，用户仍可换模型重试；接续复制来的历史不算本会话的回复。
/// 规则与前端 isConversationBound 保持一致。
pub fn conversation_binding(conversation: &AgentConversation) -> Option<(&str, &str)> {
    if conversation.provider_id.is_empty() || conversation.model_id.is_empty() {
        return None;
    }
    let inherited = conversation
        .continued_from
        .as_ref()
        .and_then(|origin| origin.get("messageCount"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let replied = conversation
        .messages
        .as_array()
        .map(|items| {
            items.iter().skip(inherited).any(|message| {
                let is_assistant = message.get("role").and_then(Value::as_str) == Some("assistant");
                let has_text = message
                    .get("content")
                    .and_then(Value::as_str)
                    .is_some_and(|text| !text.trim().is_empty());
                let has_tools = message
                    .get("toolCalls")
                    .and_then(Value::as_array)
                    .is_some_and(|calls| !calls.is_empty());
                is_assistant && (has_text || has_tools)
            })
        })
        .unwrap_or(false);
    replied.then_some((
        conversation.provider_id.as_str(),
        conversation.model_id.as_str(),
    ))
}

/// 校验对话与端点/模型的绑定：一条对话一旦与某个端点的某个模型说过话，就不能换端点或模型继续。
///
/// 不同模型对同一段历史的理解、工具调用 ID 格式和思考内容都不通用，混用会让上下文语义失真；
/// 需要换模型时，前端以会话 ID 接续出一条新对话，绑定关系始终一对一。
/// `bound` 为已落盘对话记录的端点与模型；旧存档未记录绑定（空串）时视为未绑定。
pub fn ensure_conversation_binding(
    bound: Option<(&str, &str)>,
    provider_id: &str,
    model_id: &str,
) -> Result<(), AppError> {
    let Some((bound_provider, bound_model)) = bound else {
        return Ok(());
    };
    if bound_provider.is_empty() || bound_model.is_empty() {
        return Ok(());
    }
    if bound_provider == provider_id && bound_model == model_id {
        return Ok(());
    }
    Err(AppError::Validation(format!(
        "该对话已绑定模型 {bound_model}，不能在同一对话中切换端点或模型。请在历史对话中右键选择“在新对话中接续”。"
    )))
}

/// 把文本附件展开成带来源标注的文本块；路径保持 Windows 原样写法，便于模型在回复中准确引用。
fn render_text_attachment(name: &str, path: &str, content: &str, truncated: bool) -> String {
    let source = if path.is_empty() {
        format!("name=\"{name}\"")
    } else {
        format!("path=\"{path}\"")
    };
    let note = if truncated {
        "\n（文件较大，以上仅为开头部分）"
    } else {
        ""
    };
    format!("<attachment {source}>\n{content}\n</attachment>{note}")
}

/// 用户回合的协议无关拆分：文本（含文本附件与图片占位）与需要原生下发的图片列表。
///
/// 非多模态模型收到图片会直接报 400，这里退化成文字占位，让模型知道用户给过图片但当前看不到。
fn split_user_content(message: &ChatMessage, multimodal: bool) -> (String, Vec<(&str, &str)>) {
    let mut sections: Vec<String> = Vec::new();
    let mut images: Vec<(&str, &str)> = Vec::new();
    for attachment in &message.attachments {
        match attachment {
            ChatAttachment::Text {
                name,
                path,
                content,
                truncated,
            } => sections.push(render_text_attachment(name, path, content, *truncated)),
            ChatAttachment::Image {
                name,
                media_type,
                data,
                ..
            } => {
                if multimodal {
                    images.push((media_type.as_str(), data.as_str()));
                } else {
                    sections.push(format!(
                        "[用户附带了图片 {name}，当前模型未开启多模态输入，已省略]"
                    ));
                }
            }
        }
    }
    if !message.content.is_empty() {
        sections.push(message.content.clone());
    }
    (sections.join("\n\n"), images)
}

/// Anthropic 要求 tool_use id 只含字母、数字、下划线与连字符；
/// 从其它协议接续来的历史可能带别的字符，这里统一替换，调用与结果两侧映射保持一致。
fn sanitize_anthropic_tool_id(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "toolu_unknown".into()
    } else {
        cleaned
    }
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
    // 本轮对话里探测到的端点参数差异（如需改用 max_completion_tokens、不支持某档 effort），
    // 后续每次工具循环请求都直接沿用，不必每轮都先撞一次 400。
    let mut adaptation = RequestAdaptation::default();

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
            model.multimodal,
            conversation_id,
            system_prompt,
            history,
            tools,
            options,
            cancel_flag,
            &mut adaptation,
        )?;

        // 助手回合必须完整入历史（含工具调用与思考块），否则下一轮模型看不到自己刚才的决定。
        history.push(ChatMessage {
            role: ChatRole::Assistant,
            content: turn.text.clone(),
            tool_calls: turn.tool_calls.clone(),
            tool_results: Vec::new(),
            attachments: Vec::new(),
            native_blocks: turn.native_blocks.clone(),
            reasoning_content: turn.reasoning.clone(),
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
            attachments: Vec::new(),
            ..Default::default()
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
    multimodal: bool,
    conversation_id: &str,
    system_prompt: &str,
    history: &[ChatMessage],
    tools: &[ChatTool],
    options: &AgentRunOptions,
    cancel_flag: &Arc<AtomicBool>,
    adaptation: &mut RequestAdaptation,
) -> Result<ModelTurn, AppError> {
    let protocol = provider.protocol.as_str();
    let request = BodyRequest {
        model_id,
        max_tokens,
        multimodal,
        system_prompt,
        history,
        tools,
        effort: effort_for_protocol(protocol, options.effort.as_api_value()),
    };
    let (url, mut body) = match protocol {
        "anthropic" => (
            join_url(&provider.base_url, "/v1/messages"),
            build_anthropic_body(&request),
        ),
        "openai-chat" => (
            join_url(&provider.base_url, "/v1/chat/completions"),
            build_openai_chat_body(&request),
        ),
        "openai-responses" => (
            join_url(&provider.base_url, "/v1/responses"),
            build_openai_responses_body(&request),
        ),
        other => {
            return Err(AppError::Validation(format!(
                "unsupported agent protocol: {other}"
            )))
        }
    };

    // 先套用本轮已探测到的参数差异，再发送；仍被拒时按报错内容逐项退让后重试。
    for fix in &adaptation.fixes {
        apply_body_fix(protocol, &mut body, fix);
    }
    let mut auth_flipped = false;
    for _ in 0..MAX_ADAPT_ATTEMPTS {
        let use_bearer = protocol != "anthropic"
            || adaptation
                .anthropic_bearer
                .unwrap_or(provider.auth_style == "bearer");
        let mut request = client.post(&url).json(&body);
        request = if use_bearer {
            request.header("authorization", format!("Bearer {}", provider.api_key))
        } else {
            request.header("x-api-key", &provider.api_key)
        };
        if protocol == "anthropic" {
            // Anthropic 协议无论哪种认证都必须带版本头。
            request = request.header("anthropic-version", "2023-06-01");
        }

        let response = request.send().map_err(AppError::from)?;
        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            return consume_sse_stream(
                response,
                protocol,
                &provider.name,
                app_handle,
                conversation_id,
                cancel_flag,
            );
        }
        let detail = response.text().unwrap_or_default();

        if let Some(fix) = detect_body_fix(protocol, &body, status, &detail) {
            apply_body_fix(protocol, &mut body, &fix);
            adaptation.fixes.push(fix);
            continue;
        }
        // 认证方式为“自动”时，x-api-key 被拒就换 Bearer 再试一次（多数中转只认 Bearer），反之亦然。
        if protocol == "anthropic"
            && matches!(status, 401 | 403)
            && provider.auth_style.is_empty()
            && !auth_flipped
        {
            auth_flipped = true;
            adaptation.anthropic_bearer = Some(!use_bearer);
            continue;
        }
        return Err(describe_http_error(provider, protocol, status, &detail, &body));
    }

    Err(AppError::Validation(format!(
        "{} 多次调整请求参数后仍被拒绝，请检查端点配置。",
        provider.name
    )))
}

/// 单次请求最多因参数不兼容自动调整重试的次数；每次只退让一项，足够覆盖 effort、thinking、输出上限等组合。
const MAX_ADAPT_ATTEMPTS: usize = 6;

/// 一轮对话内累积的端点适配结论，后续工具循环请求直接沿用。
#[derive(Debug, Default)]
struct RequestAdaptation {
    fixes: Vec<BodyFix>,
    /// Anthropic 协议在“自动认证”下探测出的认证头；None 表示按端点配置。
    anthropic_bearer: Option<bool>,
}

/// 针对端点报错可自动做的请求体退让。不同端点（官方、各家兼容层、中转）对参数的支持差异很大，
/// 与其让用户去读 400 报文，不如按报错内容精确地改一项再试。
#[derive(Debug, Clone, PartialEq, Eq)]
enum BodyFix {
    /// OpenAI 推理模型不接受 max_tokens，要求改用 max_completion_tokens。
    UseMaxCompletionTokens,
    /// 输出上限超出端点允许范围且无法得知上限时，去掉该字段交给端点默认值。
    DropOutputLimit,
    /// Anthropic 报出了模型允许的最大输出 token，按它收紧（该协议 max_tokens 必填，不能直接去掉）。
    CapMaxTokens(u64),
    /// 模型不支持 xhigh/max 等较高档位时退到 high。
    LowerEffort,
    /// 模型不支持思考强度参数。
    DropEffort,
    /// 模型不支持 adaptive thinking（如 Haiku 4.5 等旧模型）。
    DropThinking,
}

/// 各协议中思考强度字段的位置。
fn effort_pointer(protocol: &str) -> &'static str {
    match protocol {
        "anthropic" => "/output_config/effort",
        "openai-chat" => "/reasoning_effort",
        _ => "/reasoning/effort",
    }
}

/// 按协议映射思考强度：OpenAI 系列没有 max 档，最高为 xhigh。
fn effort_for_protocol<'a>(protocol: &str, effort: Option<&'a str>) -> Option<&'a str> {
    match (protocol, effort) {
        ("openai-chat" | "openai-responses", Some("max")) => Some("xhigh"),
        _ => effort,
    }
}

/// 根据 HTTP 报错判断能否通过调整请求体解决；只返回确实会改变请求体的修正，避免原样重试死循环。
fn detect_body_fix(protocol: &str, body: &Value, status: u16, detail: &str) -> Option<BodyFix> {
    if !matches!(status, 400 | 422) {
        return None;
    }
    let lower = detail.to_ascii_lowercase();
    let has = |pointer: &str| body.pointer(pointer).is_some();
    let effort = body.pointer(effort_pointer(protocol)).and_then(Value::as_str);
    let mentions_effort = lower.contains("effort");

    match protocol {
        "openai-chat" => {
            if lower.contains("max_completion_tokens") && has("/max_tokens") {
                return Some(BodyFix::UseMaxCompletionTokens);
            }
            if (lower.contains("max_tokens") || lower.contains("max_completion_tokens"))
                && (has("/max_tokens") || has("/max_completion_tokens"))
            {
                return Some(BodyFix::DropOutputLimit);
            }
        }
        "openai-responses" => {
            if lower.contains("max_output_tokens") && has("/max_output_tokens") {
                return Some(BodyFix::DropOutputLimit);
            }
            // 非推理模型（如 gpt-4o）会拒绝整个 reasoning 对象。
            if lower.contains("reasoning") && !mentions_effort && has("/reasoning") {
                return Some(BodyFix::DropEffort);
            }
        }
        "anthropic" => {
            if lower.contains("max_tokens") {
                if let Some(limit) = parse_max_tokens_limit(detail) {
                    if body.get("max_tokens").and_then(Value::as_u64) != Some(limit) {
                        return Some(BodyFix::CapMaxTokens(limit));
                    }
                }
            }
            if lower.contains("thinking") && !mentions_effort && has("/thinking") {
                return Some(BodyFix::DropThinking);
            }
        }
        _ => {}
    }

    if mentions_effort {
        return match effort {
            Some("xhigh" | "max") => Some(BodyFix::LowerEffort),
            Some(_) => Some(BodyFix::DropEffort),
            None => None,
        };
    }
    None
}

/// 把一项修正应用到请求体上。
fn apply_body_fix(protocol: &str, body: &mut Value, fix: &BodyFix) {
    // 降档要按 JSON 指针改嵌套字段，先单独处理，避免与下面的对象可变借用冲突。
    if *fix == BodyFix::LowerEffort {
        if let Some(slot) = body.pointer_mut(effort_pointer(protocol)) {
            if matches!(slot.as_str(), Some("xhigh" | "max")) {
                *slot = json!("high");
            }
        }
        return;
    }
    let Some(object) = body.as_object_mut() else {
        return;
    };
    match fix {
        BodyFix::UseMaxCompletionTokens => {
            if let Some(value) = object.remove("max_tokens") {
                object.insert("max_completion_tokens".into(), value);
            }
        }
        BodyFix::DropOutputLimit => {
            object.remove("max_tokens");
            object.remove("max_completion_tokens");
            object.remove("max_output_tokens");
        }
        BodyFix::CapMaxTokens(limit) => {
            object.insert("max_tokens".into(), json!(limit));
        }
        BodyFix::LowerEffort => {}
        BodyFix::DropEffort => match protocol {
            "anthropic" => {
                object.remove("output_config");
            }
            "openai-chat" => {
                object.remove("reasoning_effort");
            }
            _ => {
                object.remove("reasoning");
            }
        },
        BodyFix::DropThinking => {
            object.remove("thinking");
        }
    }
}

/// 从 Anthropic 的报错里取出允许的最大输出 token，例如
/// “max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens”。
fn parse_max_tokens_limit(detail: &str) -> Option<u64> {
    let start = detail.find("max_tokens")?;
    let rest = &detail[start..];
    let after = &rest[rest.find('>')? + 1..];
    let digits: String = after
        .trim_start()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok().filter(|limit| *limit > 0)
}

/// 生成面向用户的 HTTP 错误说明：原始报文截断后附上可操作的排查提示。
fn describe_http_error(
    provider: &AgentProvider,
    protocol: &str,
    status: u16,
    detail: &str,
    body: &Value,
) -> AppError {
    let lower = detail.to_ascii_lowercase();
    let sends_image = body.to_string().contains("base64,") || body.to_string().contains("\"base64\"");
    // 400/404 最常见的原因是接口协议选错（例如把 Chat Completions 端点配成了 Responses），
    // 光把原始报文抛给用户很难自行判断，这里补一句可操作的排查提示。
    let hint = if sends_image && (lower.contains("image") || lower.contains("vision")) {
        "\n提示：该模型可能不支持图片输入，请在“设置 → AI 助手”中关闭它的多模态开关，或换用支持图片的模型。"
            .to_string()
    } else if matches!(status, 400 | 404 | 422) {
        format!(
            "\n提示：请确认端点「{}」的接口协议是否选对（当前为 {}），以及服务地址是否指向该协议对应的路径。",
            provider.name, protocol
        )
    } else if status == 401 || status == 403 {
        "\n提示：请检查 API Key 是否正确、是否有该模型的访问权限；中转服务通常需要把认证方式设为 Bearer。"
            .to_string()
    } else {
        String::new()
    };
    AppError::Validation(format!(
        "{} 返回 {}：{}{}",
        provider.name,
        status,
        truncate_for_message(detail),
        hint
    ))
}

/// 流式过程中端点返回的错误事件（如 Anthropic 的 overloaded、Responses 的 response.failed）。
fn stream_error_message(event: &Value) -> Option<String> {
    let kind = event.get("type").and_then(Value::as_str);
    let error = match kind {
        Some("error") => event.get("error").unwrap_or(event),
        Some("response.failed") => event.pointer("/response/error")?,
        // Chat Completions 兼容层常把错误包在 data 里的 error 对象中。
        _ => event.get("error").filter(|value| value.is_object())?,
    };
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| error.to_string());
    Some(message)
}

/// 读取 SSE 流并按协议解析增量，边解析边把文本增量节流推给前端。
fn consume_sse_stream(
    response: reqwest::blocking::Response,
    protocol: &str,
    provider_name: &str,
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
        // 流中途的错误事件必须中止本轮，否则会把半截回复当成正常完成。
        if let Some(message) = stream_error_message(&event) {
            if !pending_delta.is_empty() {
                flush_delta(app_handle, conversation_id, &mut pending_delta);
            }
            return Err(AppError::Validation(format!(
                "{provider_name} 在输出过程中返回错误：{}",
                truncate_for_message(&message)
            )));
        }

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
        // Anthropic 原始块里的 tool_use 入参在流中是分片文本，这里回填成解析后的对象，回放时与调用一致。
        for block in turn.native_blocks.iter_mut() {
            if block.get("type").and_then(Value::as_str) == Some("tool_use")
                && block.get("id").and_then(Value::as_str) == Some(id.as_str())
            {
                block["input"] = arguments.clone();
            }
        }
        turn.tool_calls.push(ChatToolCall {
            id,
            name,
            arguments,
        });
    }

    Ok(turn)
}

/// 把流式增量追加到原始内容块的字符串字段上；字段缺失时新建。
fn append_json_text(block: &mut Value, field: &str, chunk: &str) {
    let mut current = block
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    current.push_str(chunk);
    block[field] = json!(current);
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
            let Some(block) = event.get("content_block") else {
                return;
            };
            if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                let id = block
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let name = block
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                partial_tool_args.push((id, name, String::new()));
            }
            // 每个内容块按到达顺序记录原样副本（thinking、redacted_thinking、text、tool_use），
            // 后续增量逐块补齐，工具循环回放时顺序与签名都与模型产出一致。
            turn.native_blocks.push(block.clone());
        }
        Some("content_block_delta") => {
            let delta = event.get("delta");
            let block = turn.native_blocks.last_mut();
            match delta.and_then(|d| d.get("type")).and_then(Value::as_str) {
                Some("text_delta") => {
                    if let Some(text) = delta.and_then(|d| d.get("text")).and_then(Value::as_str) {
                        turn.text.push_str(text);
                        pending_delta.push_str(text);
                        if let Some(block) = block {
                            append_json_text(block, "text", text);
                        }
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
                Some("thinking_delta") => {
                    if let (Some(block), Some(text)) = (
                        block,
                        delta.and_then(|d| d.get("thinking")).and_then(Value::as_str),
                    ) {
                        append_json_text(block, "thinking", text);
                    }
                }
                Some("signature_delta") => {
                    if let (Some(block), Some(signature)) = (
                        block,
                        delta.and_then(|d| d.get("signature")).and_then(Value::as_str),
                    ) {
                        append_json_text(block, "signature", signature);
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
    // DeepSeek、Kimi、通义等思考模型通过 reasoning_content 输出思考过程，工具循环内需要原样回传。
    if let Some(reasoning) = delta.get("reasoning_content").and_then(Value::as_str) {
        turn.reasoning.push_str(reasoning);
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

/// 三种协议共用的请求体输入，避免每个构造函数都拖一长串位置参数。
struct BodyRequest<'a> {
    model_id: &'a str,
    max_tokens: u32,
    /// 当前模型是否接受图片输入；关闭时图片附件退化为文字占位。
    multimodal: bool,
    system_prompt: &'a str,
    history: &'a [ChatMessage],
    tools: &'a [ChatTool],
    effort: Option<&'a str>,
}

/// 构造 Anthropic Messages API 请求体。
fn build_anthropic_body(request: &BodyRequest) -> Value {
    let BodyRequest {
        model_id,
        max_tokens,
        multimodal,
        system_prompt,
        history,
        tools,
        effort,
    } = *request;
    let messages: Vec<Value> = history
        .iter()
        .map(|message| {
            // 本轮工具循环产生的助手回合原样回放（含 thinking 签名），只剔除空文本块——API 不接受空 text。
            if message.role == ChatRole::Assistant && !message.native_blocks.is_empty() {
                let blocks: Vec<Value> = message
                    .native_blocks
                    .iter()
                    .filter(|block| {
                        block.get("type").and_then(Value::as_str) != Some("text")
                            || block
                                .get("text")
                                .and_then(Value::as_str)
                                .is_some_and(|text| !text.is_empty())
                    })
                    .cloned()
                    .collect();
                if !blocks.is_empty() {
                    return json!({ "role": "assistant", "content": blocks });
                }
            }
            let mut blocks: Vec<Value> = Vec::new();
            // 工具结果必须排在同一用户回合的最前面，符合 Anthropic 对 tool_result 的位置约定。
            for result in &message.tool_results {
                blocks.push(json!({
                    "type": "tool_result",
                    "tool_use_id": sanitize_anthropic_tool_id(&result.tool_call_id),
                    "content": result.content,
                    "is_error": result.is_error,
                }));
            }
            let (text, images) = match message.role {
                ChatRole::User => split_user_content(message, multimodal),
                ChatRole::Assistant => (message.content.clone(), Vec::new()),
            };
            // 图片排在文字之前，是 Anthropic 推荐的多模态排布，模型对“看图回答”的理解更稳定。
            for (media_type, data) in images {
                blocks.push(json!({
                    "type": "image",
                    "source": { "type": "base64", "media_type": media_type, "data": data },
                }));
            }
            if !text.is_empty() {
                blocks.push(json!({ "type": "text", "text": text }));
            }
            for call in &message.tool_calls {
                blocks.push(json!({
                    "type": "tool_use",
                    "id": sanitize_anthropic_tool_id(&call.id),
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
fn build_openai_chat_body(request: &BodyRequest) -> Value {
    let BodyRequest {
        model_id,
        max_tokens,
        multimodal,
        system_prompt,
        history,
        tools,
        effort,
    } = *request;
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
                // 只在端点确实返回过思考内容时回传，官方 OpenAI 不会出现该字段，避免多余字段被严格校验拒绝。
                if !message.reasoning_content.is_empty() {
                    entry["reasoning_content"] = json!(message.reasoning_content);
                }
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
                let (text, images) = split_user_content(message, multimodal);
                if images.is_empty() {
                    if !text.is_empty() {
                        messages.push(json!({ "role": "user", "content": text }));
                    }
                } else {
                    // 带图片时 content 改为分段数组；纯文本仍保持字符串，兼容只认字符串的旧代理。
                    let mut parts: Vec<Value> = Vec::new();
                    if !text.is_empty() {
                        parts.push(json!({ "type": "text", "text": text }));
                    }
                    for (media_type, data) in images {
                        parts.push(json!({
                            "type": "image_url",
                            "image_url": { "url": format!("data:{media_type};base64,{data}") },
                        }));
                    }
                    messages.push(json!({ "role": "user", "content": parts }));
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
fn build_openai_responses_body(request: &BodyRequest) -> Value {
    let BodyRequest {
        model_id,
        max_tokens,
        multimodal,
        system_prompt,
        history,
        tools,
        effort,
    } = *request;
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
                let (text, images) = split_user_content(message, multimodal);
                let mut parts: Vec<Value> = Vec::new();
                if !text.is_empty() {
                    parts.push(json!({ "type": "input_text", "text": text }));
                }
                for (media_type, data) in images {
                    parts.push(json!({
                        "type": "input_image",
                        "image_url": format!("data:{media_type};base64,{data}"),
                    }));
                }
                if !parts.is_empty() {
                    input.push(json!({ "role": "user", "content": parts }));
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
    // 资源路径（去掉 /v1 的部分），如 /chat/completions、/messages、/responses。
    let resource = path.strip_prefix("/v1").unwrap_or(path);
    // 已填到不带 /v1 的完整端点（智谱 /api/paas/v4/chat/completions、Gemini /v1beta/openai/chat/completions）。
    if resource != path && trimmed.ends_with(resource) {
        return trimmed.to_string();
    }
    // 很多服务的基址自带版本段（/v1、/v3、/v4、/v1beta）或兼容层前缀（Gemini 的 /openai），
    // 直接追加会拼成 /v1/v1/... 或 /v4/v1/...，此时只补资源路径。
    let last_segment = trimmed.rsplit('/').next().unwrap_or_default();
    if is_version_segment(last_segment) || last_segment == "openai" {
        return format!("{trimmed}{resource}");
    }
    format!("{trimmed}{path}")
}

/// 形如 v1、v4、v1beta、v2alpha 的版本路径段。
fn is_version_segment(segment: &str) -> bool {
    let mut chars = segment.chars();
    chars.next() == Some('v')
        && chars.next().is_some_and(|ch| ch.is_ascii_digit())
        && segment.chars().all(|ch| ch.is_ascii_alphanumeric())
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
        // 其它版本号与兼容层前缀只补资源路径。
        assert_eq!(
            join_url("https://open.bigmodel.cn/api/paas/v4", "/v1/chat/completions"),
            "https://open.bigmodel.cn/api/paas/v4/chat/completions"
        );
        assert_eq!(
            join_url(
                "https://generativelanguage.googleapis.com/v1beta/openai",
                "/v1/chat/completions"
            ),
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
        );
        // 已填到不带 /v1 的完整端点时原样使用。
        assert_eq!(
            join_url("https://ark.example.com/api/v3/chat/completions", "/v1/chat/completions"),
            "https://ark.example.com/api/v3/chat/completions"
        );
        assert_eq!(join_url("https://api.deepseek.com", "/v1/chat/completions"), "https://api.deepseek.com/v1/chat/completions");
    }

    #[test]
    fn body_fixes_follow_endpoint_error_messages() {
        let mut chat = json!({ "model": "o3", "max_tokens": 16000, "reasoning_effort": "xhigh" });
        let fix = detect_body_fix(
            "openai-chat",
            &chat,
            400,
            "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
        )
        .unwrap();
        assert_eq!(fix, BodyFix::UseMaxCompletionTokens);
        apply_body_fix("openai-chat", &mut chat, &fix);
        assert_eq!(chat["max_completion_tokens"], 16000);
        assert!(chat.get("max_tokens").is_none());

        // 不支持的思考档位先降到 high，仍不支持再整体去掉。
        let fix = detect_body_fix("openai-chat", &chat, 400, "Invalid value for reasoning_effort").unwrap();
        assert_eq!(fix, BodyFix::LowerEffort);
        apply_body_fix("openai-chat", &mut chat, &fix);
        assert_eq!(chat["reasoning_effort"], "high");
        let fix = detect_body_fix("openai-chat", &chat, 400, "Invalid value for reasoning_effort").unwrap();
        apply_body_fix("openai-chat", &mut chat, &fix);
        assert!(chat.get("reasoning_effort").is_none());
        // 已经没有可退让的字段时不再给出修正，避免原样重试。
        assert_eq!(detect_body_fix("openai-chat", &chat, 400, "reasoning_effort bad"), None);

        let mut anthropic = json!({
            "max_tokens": 128000,
            "thinking": { "type": "adaptive" },
            "output_config": { "effort": "max" }
        });
        let fix = detect_body_fix(
            "anthropic",
            &anthropic,
            400,
            "max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens for claude-haiku-4-5",
        )
        .unwrap();
        assert_eq!(fix, BodyFix::CapMaxTokens(64000));
        apply_body_fix("anthropic", &mut anthropic, &fix);
        assert_eq!(anthropic["max_tokens"], 64000);
        let fix = detect_body_fix("anthropic", &anthropic, 400, "thinking type adaptive is not supported").unwrap();
        assert_eq!(fix, BodyFix::DropThinking);
        // 鉴权、限流等非参数类错误不做调整。
        assert_eq!(detect_body_fix("anthropic", &anthropic, 429, "effort"), None);
    }

    #[test]
    fn anthropic_stream_keeps_thinking_blocks_for_tool_loop_replay() {
        let mut turn = ModelTurn::default();
        let mut partial = Vec::new();
        let mut pending = String::new();
        for event in [
            json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "", "signature": "" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "thinking_delta", "thinking": "想一想" } }),
            json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "signature_delta", "signature": "sig==" } }),
            json!({ "type": "content_block_start", "index": 1, "content_block": { "type": "tool_use", "id": "toolu_9", "name": "run_command", "input": {} } }),
            json!({ "type": "content_block_delta", "index": 1, "delta": { "type": "input_json_delta", "partial_json": "{\"command\":\"ls\"}" } }),
        ] {
            parse_anthropic_event(&event, &mut turn, &mut partial, &mut pending);
        }
        assert_eq!(turn.native_blocks[0]["thinking"], "想一想");
        assert_eq!(turn.native_blocks[0]["signature"], "sig==");

        // 回放时 thinking 块排在 tool_use 前且保持签名。
        turn.native_blocks[1]["input"] = json!({ "command": "ls" });
        let history = vec![ChatMessage {
            role: ChatRole::Assistant,
            tool_calls: vec![ChatToolCall {
                id: "toolu_9".into(),
                name: "run_command".into(),
                arguments: json!({ "command": "ls" }),
            }],
            native_blocks: turn.native_blocks.clone(),
            ..Default::default()
        }];
        let body = build_anthropic_body(&body_request(&history, false));
        let blocks = body.pointer("/messages/0/content").and_then(Value::as_array).unwrap();
        assert_eq!(blocks[0]["type"], "thinking");
        assert_eq!(blocks[0]["signature"], "sig==");
        assert_eq!(blocks[1]["input"]["command"], "ls");
    }

    #[test]
    fn stream_error_events_are_detected_per_protocol() {
        assert_eq!(
            stream_error_message(&json!({ "type": "error", "error": { "type": "overloaded_error", "message": "Overloaded" } })),
            Some("Overloaded".into())
        );
        assert_eq!(
            stream_error_message(&json!({ "type": "response.failed", "response": { "error": { "message": "boom" } } })),
            Some("boom".into())
        );
        assert_eq!(stream_error_message(&json!({ "type": "content_block_delta" })), None);
        assert_eq!(stream_error_message(&json!({ "choices": [] })), None);
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
            attachments: Vec::new(),
            ..Default::default()
        }];
        let body = build_anthropic_body(&body_request(&history, false));

        let blocks = body.pointer("/messages/0/content").and_then(Value::as_array).unwrap();
        assert_eq!(blocks[0]["type"], "tool_result");
        assert_eq!(body["system"], "system");
        // 流式必须开启，否则长回复会撞上 HTTP 超时。
        assert_eq!(body["stream"], true);
    }

    fn body_request(history: &[ChatMessage], multimodal: bool) -> BodyRequest<'_> {
        BodyRequest {
            model_id: "model-x",
            max_tokens: 1024,
            multimodal,
            system_prompt: "system",
            history,
            tools: &[],
            effort: None,
        }
    }

    fn user_with_attachments() -> Vec<ChatMessage> {
        vec![ChatMessage {
            role: ChatRole::User,
            content: "看看这个报错".into(),
            tool_calls: Vec::new(),
            tool_results: Vec::new(),
            attachments: vec![
                ChatAttachment::Text {
                    name: "app.log".into(),
                    path: "C:\\logs\\app.log".into(),
                    content: "ERROR boom".into(),
                    truncated: false,
                },
                ChatAttachment::Image {
                    name: "shot.png".into(),
                    path: String::new(),
                    media_type: "image/png".into(),
                    data: "AAAA".into(),
                },
            ],
            ..Default::default()
        }]
    }

    #[test]
    fn multimodal_images_use_native_blocks_for_every_protocol() {
        let history = user_with_attachments();
        let request = body_request(&history, true);

        let anthropic = build_anthropic_body(&request);
        let blocks = anthropic.pointer("/messages/0/content").and_then(Value::as_array).unwrap();
        assert_eq!(blocks[0]["type"], "image");
        assert_eq!(blocks[0]["source"]["data"], "AAAA");
        // 文本附件保留 Windows 原始路径，并排在用户正文之前。
        let text = blocks[1]["text"].as_str().unwrap();
        assert!(text.starts_with("<attachment path=\"C:\\logs\\app.log\">"));
        assert!(text.ends_with("看看这个报错"));

        let chat = build_openai_chat_body(&request);
        let parts = chat.pointer("/messages/1/content").and_then(Value::as_array).unwrap();
        assert_eq!(parts[1]["type"], "image_url");
        assert_eq!(parts[1]["image_url"]["url"], "data:image/png;base64,AAAA");

        let responses = build_openai_responses_body(&request);
        let parts = responses.pointer("/input/0/content").and_then(Value::as_array).unwrap();
        assert_eq!(parts[1]["type"], "input_image");
    }

    #[test]
    fn text_only_models_get_image_placeholders_instead_of_blocks() {
        let history = user_with_attachments();
        let request = body_request(&history, false);

        let anthropic = build_anthropic_body(&request);
        let blocks = anthropic.pointer("/messages/0/content").and_then(Value::as_array).unwrap();
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0]["text"].as_str().unwrap().contains("[用户附带了图片 shot.png"));

        // Chat Completions 无图时保持字符串 content，兼容只认字符串的旧代理。
        let chat = build_openai_chat_body(&request);
        assert!(chat.pointer("/messages/1/content").unwrap().is_string());
    }

    #[test]
    fn anthropic_tool_ids_from_other_protocols_are_sanitized_consistently() {
        let history = vec![
            ChatMessage {
                role: ChatRole::Assistant,
                content: String::new(),
                tool_calls: vec![ChatToolCall {
                    id: "call:abc.1".into(),
                    name: "run_command".into(),
                    arguments: json!({}),
                }],
                tool_results: Vec::new(),
                attachments: Vec::new(),
                ..Default::default()
            },
            ChatMessage {
                role: ChatRole::User,
                content: String::new(),
                tool_calls: Vec::new(),
                tool_results: vec![ChatToolResult {
                    tool_call_id: "call:abc.1".into(),
                    name: "run_command".into(),
                    content: "ok".into(),
                    is_error: false,
                }],
                attachments: Vec::new(),
                ..Default::default()
            },
        ];
        let body = build_anthropic_body(&body_request(&history, false));
        assert_eq!(body.pointer("/messages/0/content/0/id").unwrap(), "call_abc_1");
        assert_eq!(body.pointer("/messages/1/content/0/tool_use_id").unwrap(), "call_abc_1");
    }

    #[test]
    fn conversation_binding_rejects_switching_model_or_endpoint() {
        assert!(ensure_conversation_binding(None, "p1", "m1").is_ok());
        // 旧存档没有记录绑定，首次发送时直接绑定。
        assert!(ensure_conversation_binding(Some(("", "")), "p1", "m1").is_ok());
        assert!(ensure_conversation_binding(Some(("p1", "m1")), "p1", "m1").is_ok());
        assert!(ensure_conversation_binding(Some(("p1", "m1")), "p1", "m2").is_err());
        assert!(ensure_conversation_binding(Some(("p1", "m1")), "p2", "m1").is_err());
    }

    #[test]
    fn conversation_binding_requires_an_own_assistant_reply() {
        let conversation = |messages: Value, continued_from: Option<Value>| AgentConversation {
            id: "c1".into(),
            title: "t".into(),
            updated_at: 0,
            provider_id: "p1".into(),
            model_id: "m1".into(),
            messages,
            continued_from,
        };
        // 首轮失败只剩用户提问：允许换模型重试。
        let failed = conversation(json!([{ "role": "user", "content": "hi", "toolCalls": [] }]), None);
        assert_eq!(conversation_binding(&failed), None);
        // 只有空的助手占位（请求进行中）同样不算绑定。
        let pending = conversation(
            json!([
                { "role": "user", "content": "hi", "toolCalls": [] },
                { "role": "assistant", "content": "", "toolCalls": [] }
            ]),
            None,
        );
        assert_eq!(conversation_binding(&pending), None);
        let replied = conversation(
            json!([
                { "role": "user", "content": "hi", "toolCalls": [] },
                { "role": "assistant", "content": "", "toolCalls": [{ "id": "t1" }] }
            ]),
            None,
        );
        assert_eq!(conversation_binding(&replied), Some(("p1", "m1")));
        // 接续来的助手回复属于来源会话，不能让新会话提前锁定。
        let continued = conversation(
            json!([
                { "role": "user", "content": "hi", "toolCalls": [] },
                { "role": "assistant", "content": "old answer", "toolCalls": [] },
                { "role": "user", "content": "continue", "toolCalls": [] }
            ]),
            Some(json!({ "id": "c0", "title": "old", "messageCount": 2 })),
        );
        assert_eq!(conversation_binding(&continued), None);
    }

    #[test]
    fn compact_history_keeps_attachment_hints_and_drops_payloads() {
        let mut history: Vec<ChatMessage> = Vec::new();
        history.extend(user_with_attachments());
        for index in 0..8 {
            history.push(ChatMessage {
                role: if index % 2 == 0 { ChatRole::Assistant } else { ChatRole::User },
                content: format!("turn {index}"),
                tool_calls: Vec::new(),
                tool_results: Vec::new(),
                attachments: Vec::new(),
                ..Default::default()
            });
        }
        let dropped = compact_history(&mut history);
        assert_eq!(dropped, 3);
        assert!(history[0].attachments.is_empty());
        assert!(history[0].content.contains("用户附带了文件 C:\\logs\\app.log"));
        assert!(history[0].content.contains("用户附带了图片 shot.png"));
    }
}
