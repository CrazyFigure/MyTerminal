//! 内置 Agent 的工具集与系统提示词。
//!
//! 工具实现全部复用 agent_bridge 已有的能力，并经由同一个 `submit_action` 审批闸门，
//! 因此内置 Agent 与外部 MCP 客户端遵守完全一致的授权策略与审批 UI，不存在“后门”。

use serde_json::{json, Value};

use crate::{
    agent_bridge::{self, AgentBridgeRuntime},
    agent_chat::{ChatTool, ChatToolCall, ChatToolResult},
    crypto::CryptoService,
    models::AgentBridgeSettings,
    storage::StorageService,
};

/// 内置 Agent 的系统提示词。
/// 需要让模型准确理解本软件的概念模型（连接 / 会话 / 终端标签）与工具选择策略，
/// 否则它会退化成“什么都用 shell 拼”，既低效又容易踩审批。
pub fn system_prompt() -> String {
    r#"你是 MyTerminal 内置的运维助手。MyTerminal 是一款 SSH 终端管理器，用户在其中保存了若干 SSH 连接，并可以打开终端标签与远程主机交互。

## 你的能力与边界

- 你通过工具操作用户已保存的 SSH 连接。MyTerminal 会自动使用保存好的密码、密钥、跳板机和代理配置，你不需要也无法自己登录 SSH。
- 你不知道任何主机的密码或密钥，也不应该向用户索要。
- 你的命令默认在**用户可见的终端标签**里执行：用户会实时看到你输入的命令和远端的回显。若目标连接当前没有打开的终端标签，MyTerminal 会自动新开一个。
- 当远端 Shell 不支持命令边界协议（例如 bash 低于 4.4 且非 zsh）、终端正在运行 vim/top 这类全屏程序，或用户正在输入时，命令会自动回退到后台通道执行。工具返回的 `executionMode` 字段会如实告诉你本次走的是 `terminal`（可见）还是 `exec`（后台），`fallbackReason` 会说明回退原因。不要向用户谎称命令一定可见。

## 会话标识

- 先调用 `list_connections` 查看可用连接。
- 后续所有工具的 `sessionId` 参数，直接传 `list_connections` 返回的连接 `id` 即可；唯一的连接名称也可以。
- 不要传 IP、主机名或用户名。

## 工具选择策略

- 新建或覆盖远端小文件，直接用 `file_write`，不要用 `echo`/`cat` 拼 shell 命令——那样容易被引号和转义坑到。
- 上传本机文件或文件夹用 `file_upload` 的 `localPath`/`localPaths`，不要把文件内容转成 base64 塞进命令。
- 查看目录用 `file_list`，读文件用 `file_read`，都比 `ls`/`cat` 更可靠且不占用终端。
- 只有真正需要执行程序、查看运行状态或做变更时才用 `run_command`。

## 完成任务，而不是只做第一步

- 你处在一个循环里：每次回复可以调用工具，工具结果会回传给你，直到你不再调用工具才算这一轮结束。
- **把用户的任务做完再停下。** 用户说"新增文件 new.txt"，就要真的把文件创建出来并确认存在，而不是只 `pwd` 或 `ls` 看一眼就回复。
- 不要在没有完成任务时就输出总结性回复。如果还需要下一步动作，就继续调用工具。
- 只有在任务确实完成、或遇到必须由用户决定的问题时，才结束回合。
- 如果某一步失败且你无法自行解决，明确说清卡在哪里、你已经尝试了什么，不要假装成功。

## 安全与沟通

- 涉及删除、覆盖、重启服务、修改系统配置等不可逆操作时，先用一两句话说明你要做什么、影响是什么，再执行。
- 根据用户的授权设置，部分操作会弹出审批卡片等待用户确认。被拒绝是正常结果，不要反复重试同一条命令，应当询问用户意图。
- 命令失败时先读取报错定位原因，不要盲目换写法重试。
- 用简体中文回复。先给结论，再给必要的细节；不要复述你调用了哪些工具的流水账。
"#
    .to_string()
}

/// 构造暴露给模型的工具清单。描述里写清“何时用”，而不只是“是什么”，
/// 这对工具触发率的影响远大于单纯罗列功能。
pub fn build_tools() -> Vec<ChatTool> {
    let session_id_schema = json!({
        "type": "string",
        "description": "目标连接：传 list_connections 返回的连接 id，或唯一的连接名称。不要传 IP 或主机名。"
    });

    vec![
        ChatTool {
            name: "list_connections".into(),
            description: "列出 MyTerminal 中保存的全部 SSH 连接与分组。任何远程操作前先调用它拿到连接 id。".into(),
            input_schema: json!({ "type": "object", "properties": {} }),
        },
        ChatTool {
            name: "run_command".into(),
            description: "在远端执行 shell 命令。默认在用户可见的终端标签里执行，用户能实时看到过程。适合执行程序、查看服务状态或做变更；读文件和列目录请改用 file_read / file_list。".into(),
            input_schema: json!({
                "type": "object",
                "required": ["sessionId", "command"],
                "properties": {
                    "sessionId": session_id_schema,
                    "command": { "type": "string", "description": "要执行的完整命令。" },
                    "cwd": { "type": "string", "description": "执行目录；命令在子 shell 中运行，不会改变用户终端的当前目录。" },
                    "timeoutSec": { "type": "number", "description": "超时秒数，超时会向终端发送 Ctrl+C 中止。" }
                }
            }),
        },
        ChatTool {
            name: "file_list".into(),
            description: "列出远端目录内容。比执行 ls 更可靠，且不占用用户终端。".into(),
            input_schema: json!({
                "type": "object",
                "required": ["sessionId", "path"],
                "properties": { "sessionId": session_id_schema, "path": { "type": "string" } }
            }),
        },
        ChatTool {
            name: "file_read".into(),
            description: "读取远端文件内容。UTF-8 文本返回 content，二进制返回 contentBase64。比 cat 更可靠。".into(),
            input_schema: json!({
                "type": "object",
                "required": ["sessionId", "path"],
                "properties": { "sessionId": session_id_schema, "path": { "type": "string" } }
            }),
        },
        ChatTool {
            name: "file_write".into(),
            description: "写入远端文件。新建或覆盖小文件时必须用它，不要用 echo/cat 拼 shell 命令。".into(),
            input_schema: json!({
                "type": "object",
                "required": ["sessionId", "path"],
                "properties": {
                    "sessionId": session_id_schema,
                    "path": { "type": "string" },
                    "content": { "type": "string", "description": "UTF-8 文本内容。" },
                    "contentBase64": { "type": "string", "description": "二进制内容的 base64 编码。" }
                }
            }),
        },
        ChatTool {
            name: "file_upload".into(),
            description: "把本机文件或文件夹上传到远端，由 MyTerminal 通过 SFTP 传输。不要自己执行 scp，也不要把文件内容转成 base64。".into(),
            input_schema: json!({
                "type": "object",
                "required": ["sessionId"],
                "properties": {
                    "sessionId": session_id_schema,
                    "localPath": { "type": "string", "description": "单个本机文件或文件夹路径。" },
                    "localPaths": { "type": "array", "items": { "type": "string" }, "description": "多个本机路径。" },
                    "remoteDir": { "type": "string", "description": "远端目标目录；批量上传用它。" },
                    "remotePath": { "type": "string", "description": "单个源路径的完整远端目标路径。" }
                }
            }),
        },
        ChatTool {
            name: "file_download".into(),
            description: "把远端文件或文件夹下载到本机。".into(),
            input_schema: json!({
                "type": "object",
                "required": ["sessionId"],
                "properties": {
                    "sessionId": session_id_schema,
                    "path": { "type": "string", "description": "单个远端路径。" },
                    "paths": { "type": "array", "items": { "type": "string" }, "description": "多个远端路径。" },
                    "localDir": { "type": "string", "description": "本机目标目录；未提供时使用 MyTerminal 下载目录。" },
                    "localPath": { "type": "string", "description": "单个远端路径的完整本机目标路径。" }
                }
            }),
        },
        ChatTool {
            name: "file_mkdir".into(),
            description: "在远端创建目录（含多级父目录）。".into(),
            input_schema: json!({
                "type": "object",
                "required": ["sessionId", "path"],
                "properties": { "sessionId": session_id_schema, "path": { "type": "string" } }
            }),
        },
        ChatTool {
            name: "file_rename".into(),
            description: "重命名或移动远端路径。".into(),
            input_schema: json!({
                "type": "object",
                "required": ["sessionId", "path", "newPath"],
                "properties": {
                    "sessionId": session_id_schema,
                    "path": { "type": "string" },
                    "newPath": { "type": "string" }
                }
            }),
        },
        ChatTool {
            name: "file_delete".into(),
            description: "递归删除远端文件或文件夹。不可逆操作，执行前先向用户说明。".into(),
            input_schema: json!({
                "type": "object",
                "required": ["sessionId", "path"],
                "properties": { "sessionId": session_id_schema, "path": { "type": "string" } }
            }),
        },
    ]
}

/// 执行一次工具调用并把结果转成模型可读的文本。
/// 全部经由 agent_bridge 的公共入口，因此审批闸门、连接解析与串行化行为与 MCP 完全一致。
pub fn execute_tool(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    settings: &AgentBridgeSettings,
    conversation_id: &str,
    call: &ChatToolCall,
) -> ChatToolResult {
    let outcome = dispatch_tool(
        runtime,
        storage,
        crypto,
        settings,
        conversation_id,
        call,
    );
    match outcome {
        Ok(value) => ChatToolResult {
            tool_call_id: call.id.clone(),
            name: call.name.clone(),
            content: serde_json::to_string_pretty(&value)
                .unwrap_or_else(|_| "{}".to_string()),
            is_error: false,
        },
        Err(message) => ChatToolResult {
            tool_call_id: call.id.clone(),
            name: call.name.clone(),
            // 错误如实回给模型，让它据此调整，而不是伪装成成功。
            content: message,
            is_error: true,
        },
    }
}

fn dispatch_tool(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    settings: &AgentBridgeSettings,
    conversation_id: &str,
    call: &ChatToolCall,
) -> Result<Value, String> {
    // 复用 Broker 的统一入口，保证与 MCP 路径共享审批、串行化与错误语义。
    let route = match call.name.as_str() {
        "list_connections" => return agent_bridge::list_connections(storage, crypto)
            .map_err(|error| error.to_string())
            .and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())),
        "run_command" => "/exec",
        "file_list" => "/files/list",
        "file_read" => "/files/read",
        "file_write" => "/files/write",
        "file_upload" => "/files/upload",
        "file_download" => "/files/download",
        "file_delete" => "/files/delete",
        "file_rename" => "/files/rename",
        "file_mkdir" => "/files/mkdir",
        other => return Err(format!("未知工具：{other}")),
    };

    // 对话与工具调用 ID 一并进入审批队列，前端才能把审批准确放回发起它的工具卡片。
    let context = agent_bridge::AgentActionContext {
        conversation_id,
        tool_call_id: &call.id,
    };
    agent_bridge::dispatch_agent_action_with_context(
        runtime,
        storage,
        crypto,
        settings,
        route,
        &call.arguments,
        Some(&context),
    )
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_list_covers_every_dispatch_route() {
        let tools = build_tools();
        // 工具清单与分派表必须一一对应，避免模型调用到没有实现的工具。
        for tool in &tools {
            assert!(
                !tool.description.is_empty(),
                "tool {} must document when to use it",
                tool.name
            );
            assert_eq!(tool.input_schema["type"], "object");
        }
        assert!(tools.iter().any(|tool| tool.name == "run_command"));
        assert!(tools.iter().any(|tool| tool.name == "file_write"));
    }

    #[test]
    fn system_prompt_states_visibility_and_session_rules() {
        let prompt = system_prompt();
        // 提示词必须讲清可见执行语义与 sessionId 约定，否则模型会误导用户或传错参数。
        assert!(prompt.contains("executionMode"));
        assert!(prompt.contains("list_connections"));
        assert!(prompt.contains("file_write"));
    }
}
