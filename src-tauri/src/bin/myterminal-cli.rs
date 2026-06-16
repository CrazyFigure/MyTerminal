use std::{
    collections::HashMap,
    env, fs,
    io::{self, BufRead, Read, Write},
    net::TcpStream,
    path::PathBuf,
};

use serde_json::{json, Value};

use myterminal::{error::AppError, infrastructure::agent_bridge::types::AgentBridgeDiscovery};

#[derive(Debug, Clone, Copy)]
enum McpFraming {
    JsonLine,
    ContentLength,
}

#[derive(Debug, Clone)]
struct BrokerClient {
    port: u16,
    token: String,
}

fn main() {
    let is_mcp_mode = env::args().nth(1).as_deref() == Some("mcp");
    let exit_code = match run_cli() {
        Ok(()) => 0,
        Err(error) => {
            if is_mcp_mode {
                eprintln!("{}", error);
            } else {
                print_json(&json!({ "ok": false, "error": error.to_string() }));
            }
            1
        }
    };
    std::process::exit(exit_code);
}

fn run_cli() -> Result<(), AppError> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.first().map(String::as_str) == Some("mcp") {
        run_mcp_stdio()?;
        return Ok(());
    }

    let client = BrokerClient::discover()?;
    let response = match args.as_slice() {
        [command, subcommand, ..] if command == "bridge" && subcommand == "status" => {
            client.get("/status")?
        }
        [command, subcommand, ..] if command == "connections" && subcommand == "list" => {
            client.get("/connections")?
        }
        [command, subcommand, rest @ ..] if command == "session" && subcommand == "open" => {
            let connection_id = required_option(rest, "--connection")?;
            client.post("/sessions/open", &json!({ "connectionId": connection_id }))?
        }
        [command, subcommand, rest @ ..] if command == "session" && subcommand == "close" => {
            let session_id = required_option(rest, "--session")?;
            client.post("/sessions/close", &json!({ "sessionId": session_id }))?
        }
        [command, rest @ ..] if command == "exec" => {
            let session_id = required_option(rest, "--session")?;
            let cwd = option_value(rest, "--cwd");
            let timeout_sec =
                option_value(rest, "--timeout").and_then(|value| value.parse::<u64>().ok());
            let command_text = command_after_separator(rest)?;
            client.post(
                "/exec",
                &json!({
                    "sessionId": session_id,
                    "cwd": cwd,
                    "timeoutSec": timeout_sec,
                    "command": command_text,
                }),
            )?
        }
        [command, subcommand, rest @ ..] if command == "file" && subcommand == "list" => {
            let session_id = required_option(rest, "--session")?;
            let path = required_option(rest, "--path")?;
            client.post(
                "/files/list",
                &json!({ "sessionId": session_id, "path": path }),
            )?
        }
        [command, subcommand, rest @ ..] if command == "file" && subcommand == "read" => {
            let session_id = required_option(rest, "--session")?;
            let path = required_option(rest, "--path")?;
            client.post(
                "/files/read",
                &json!({ "sessionId": session_id, "path": path }),
            )?
        }
        [command, subcommand, rest @ ..] if command == "file" && subcommand == "write" => {
            let session_id = required_option(rest, "--session")?;
            let path = required_option(rest, "--path")?;
            let content = option_value(rest, "--content").unwrap_or_default();
            client.post(
                "/files/write",
                &json!({ "sessionId": session_id, "path": path, "content": content }),
            )?
        }
        [command, subcommand, rest @ ..] if command == "file" && subcommand == "delete" => {
            let session_id = required_option(rest, "--session")?;
            let path = required_option(rest, "--path")?;
            client.post(
                "/files/delete",
                &json!({ "sessionId": session_id, "path": path }),
            )?
        }
        [command, subcommand, rest @ ..] if command == "file" && subcommand == "rename" => {
            let session_id = required_option(rest, "--session")?;
            let path = required_option(rest, "--path")?;
            let new_path = required_option(rest, "--new-path")?;
            client.post(
                "/files/rename",
                &json!({ "sessionId": session_id, "path": path, "newPath": new_path }),
            )?
        }
        [command, subcommand, rest @ ..] if command == "file" && subcommand == "mkdir" => {
            let session_id = required_option(rest, "--session")?;
            let path = required_option(rest, "--path")?;
            client.post(
                "/files/mkdir",
                &json!({ "sessionId": session_id, "path": path }),
            )?
        }
        _ => {
            return Err(AppError::Validation(
                "usage: myterminal-cli bridge status --json | connections list --json | session open/close | exec | file ...".into(),
            ));
        }
    };

    print_json(&response);
    Ok(())
}

impl BrokerClient {
    fn discover() -> Result<Self, AppError> {
        let discovery_path = find_discovery_path().ok_or_else(|| {
            AppError::Validation(
                "MyTerminal AI Bridge is not running. Enable it in Settings > AI Connection, or set MYTERMINAL_DATA_DIR."
                    .into(),
            )
        })?;
        let raw = fs::read_to_string(discovery_path)?;
        let discovery: AgentBridgeDiscovery = serde_json::from_str(&raw)?;
        Ok(Self {
            port: discovery.port,
            token: discovery.token,
        })
    }

    fn get(&self, path: &str) -> Result<Value, AppError> {
        self.request("GET", path, None)
    }

    fn post(&self, path: &str, body: &Value) -> Result<Value, AppError> {
        self.request("POST", path, Some(body))
    }

    fn request(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value, AppError> {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).map_err(|error| {
            AppError::Validation(format!("failed to connect MyTerminal AI Bridge: {error}"))
        })?;
        let body_text = body
            .map(serde_json::to_string)
            .transpose()?
            .unwrap_or_default();
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            self.port,
            self.token,
            body_text.len(),
            body_text
        );
        stream.write_all(request.as_bytes())?;
        read_http_response(&mut stream)
    }
}

fn find_discovery_path() -> Option<PathBuf> {
    // 外部 MCP 客户端可通过环境变量明确指定数据目录，适合安装后不从项目根目录启动的场景。
    if let Ok(data_dir) = env::var("MYTERMINAL_DATA_DIR") {
        let path = PathBuf::from(data_dir).join("agent-bridge-discovery.json");
        if path.exists() {
            return Some(path);
        }
    }

    // 默认沿当前目录和 CLI 可执行文件目录向上查找，兼容开发态 target/debug 与项目根目录分离。
    for base in discovery_search_roots() {
        for ancestor in base.ancestors() {
            let path = ancestor
                .join(".myterminal-data")
                .join("agent-bridge-discovery.json");
            if path.exists() {
                return Some(path);
            }
        }
    }

    None
}

fn discovery_search_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(current_dir) = env::current_dir() {
        roots.push(current_dir);
    }
    if let Ok(exe_path) = env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            roots.push(parent.to_path_buf());
        }
    }
    roots
}

fn read_http_response(stream: &mut TcpStream) -> Result<Value, AppError> {
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes)?;
    let header_end = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| AppError::Validation("invalid broker response".into()))?;
    let body = String::from_utf8_lossy(&bytes[header_end + 4..]).into_owned();
    serde_json::from_str(&body).map_err(AppError::from)
}

fn print_json(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".into())
    );
}

fn option_value(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
}

fn required_option(args: &[String], name: &str) -> Result<String, AppError> {
    option_value(args, name).ok_or_else(|| AppError::Validation(format!("{name} is required")))
}

fn command_after_separator(args: &[String]) -> Result<String, AppError> {
    let separator = args
        .iter()
        .position(|value| value == "--")
        .ok_or_else(|| AppError::Validation("command separator -- is required".into()))?;
    let command = args[separator + 1..].join(" ");
    if command.trim().is_empty() {
        return Err(AppError::Validation("command is required".into()));
    }
    Ok(command)
}

fn run_mcp_stdio() -> Result<(), AppError> {
    let stdin = io::stdin();
    let mut reader = io::BufReader::new(stdin.lock());
    loop {
        let Some((message, framing)) = read_mcp_message(&mut reader)? else {
            break;
        };
        trace_mcp_event("recv", &message);
        if let Some(response) = handle_mcp_message(message)? {
            trace_mcp_event("send", &response);
            write_mcp_message(&response, framing)?;
        }
    }
    Ok(())
}

fn trace_mcp_event(direction: &str, value: &Value) {
    let Ok(path) = env::var("MYTERMINAL_MCP_TRACE") else {
        return;
    };

    // Trace 只记录 MCP 方法和 id，不写参数正文，避免连接信息或命令内容进入诊断日志。
    let event = json!({
        "direction": direction,
        "id": value.get("id").cloned().unwrap_or(Value::Null),
        "method": value.get("method").and_then(Value::as_str),
    });
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", event);
    }
}

fn read_mcp_message(reader: &mut impl BufRead) -> Result<Option<(Value, McpFraming)>, AppError> {
    let mut headers = HashMap::new();
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line)?;
        if read == 0 {
            return Ok(None);
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            // 有些 shell 管道会在 JSON-RPC 消息后留下额外空行；头部尚未开始时要忽略，避免污染 MCP stdout。
            if headers.is_empty() {
                continue;
            }
            break;
        }
        if headers.is_empty() && trimmed.starts_with('{') {
            // MCP 标准 stdio 使用 NDJSON：每行一个完整 JSON-RPC 消息；Claude Code 采用这种分帧。
            let message = serde_json::from_str(trimmed)?;
            return Ok(Some((message, McpFraming::JsonLine)));
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            headers.insert(key.to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or_else(|| AppError::Validation("missing MCP Content-Length".into()))?;
    let mut body = vec![0_u8; content_length];
    reader.read_exact(&mut body)?;
    Ok(Some((
        serde_json::from_slice(&body)?,
        McpFraming::ContentLength,
    )))
}

fn write_mcp_message(value: &Value, framing: McpFraming) -> Result<(), AppError> {
    let body = json_ascii_bytes(value)?;
    let mut stdout = io::stdout().lock();
    match framing {
        McpFraming::JsonLine => {
            // NDJSON 响应必须保持单行，serde_json 已将字符串内部换行转义为 \n。
            stdout.write_all(&body)?;
            stdout.write_all(b"\n")?;
        }
        McpFraming::ContentLength => {
            // 兼容少数使用 LSP 风格 Content-Length 的 MCP 客户端，按输入分帧方式回包。
            write!(stdout, "Content-Length: {}\r\n\r\n", body.len())?;
            stdout.write_all(&body)?;
        }
    }
    stdout.flush()?;
    Ok(())
}

fn json_ascii_bytes(value: &Value) -> Result<Vec<u8>, AppError> {
    // MCP 的 Content-Length 按字节计数；把非 ASCII 字符转成 \uXXXX 可以兼容按字符串长度切包的客户端实现。
    let text = serde_json::to_string(value)?;
    let mut escaped = String::with_capacity(text.len());
    for ch in text.chars() {
        if ch.is_ascii() {
            escaped.push(ch);
            continue;
        }

        let code = ch as u32;
        if code <= 0xffff {
            escaped.push_str(&format!("\\u{code:04x}"));
        } else {
            // 超出 BMP 的字符需要写成 UTF-16 代理对，保持 JSON 字符串可被标准解析器还原。
            let value = code - 0x1_0000;
            let high = 0xd800 + ((value >> 10) & 0x3ff);
            let low = 0xdc00 + (value & 0x3ff);
            escaped.push_str(&format!("\\u{high:04x}\\u{low:04x}"));
        }
    }
    Ok(escaped.into_bytes())
}

fn handle_mcp_message(message: Value) -> Result<Option<Value>, AppError> {
    let id = message.get("id").cloned();
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if id.is_none() {
        return Ok(None);
    }
    let id = id.unwrap();
    let response = match method {
        "initialize" => {
            // MCP 客户端会带上自己支持的协议版本；回显该版本可避免新版客户端把服务端判成旧协议。
            let protocol_version = message
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2024-11-05");
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "protocolVersion": protocol_version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": "myterminal-ai-bridge", "version": env!("CARGO_PKG_VERSION") }
                }
            })
        }
        "tools/list" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "tools": mcp_tools() }
        }),
        "resources/list" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "resources": [] }
        }),
        "prompts/list" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "prompts": [] }
        }),
        "ping" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {}
        }),
        "shutdown" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {}
        }),
        "tools/call" => {
            let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
            call_mcp_tool(id, params)?
        }
        _ => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("unknown method {method}") }
        }),
    };
    Ok(Some(response))
}

fn mcp_tools() -> Value {
    json!([
        tool_schema(
            "myterminal_list_connections",
            "列出 MyTerminal 中的 SSH 分组树和脱敏连接信息。",
            json!({ "type": "object", "properties": {} })
        ),
        tool_schema(
            "myterminal_open_session",
            "打开一个 AI Bridge 会话。",
            json!({ "type": "object", "required": ["connectionId"], "properties": { "connectionId": { "type": "string" } } })
        ),
        tool_schema(
            "myterminal_close_session",
            "关闭一个 AI Bridge 会话。",
            json!({ "type": "object", "required": ["sessionId"], "properties": { "sessionId": { "type": "string" } } })
        ),
        tool_schema(
            "myterminal_run_command",
            "在远端通过独立 SSH exec channel 执行命令，默认需要 GUI 审批。",
            json!({ "type": "object", "required": ["sessionId", "command"], "properties": { "sessionId": { "type": "string" }, "command": { "type": "string" }, "cwd": { "type": "string" }, "timeoutSec": { "type": "number" } } })
        ),
        tool_schema(
            "myterminal_file_list",
            "列出远端目录。",
            json!({ "type": "object", "required": ["sessionId", "path"], "properties": { "sessionId": { "type": "string" }, "path": { "type": "string" } } })
        ),
        tool_schema(
            "myterminal_file_read",
            "读取远端文件，UTF-8 返回 content，二进制返回 contentBase64。",
            json!({ "type": "object", "required": ["sessionId", "path"], "properties": { "sessionId": { "type": "string" }, "path": { "type": "string" } } })
        ),
        tool_schema(
            "myterminal_file_write",
            "写入远端文件，默认需要 GUI 审批。",
            json!({ "type": "object", "required": ["sessionId", "path"], "properties": { "sessionId": { "type": "string" }, "path": { "type": "string" }, "content": { "type": "string" }, "contentBase64": { "type": "string" } } })
        ),
        tool_schema(
            "myterminal_file_delete",
            "删除远端文件或空目录，默认需要 GUI 审批。",
            json!({ "type": "object", "required": ["sessionId", "path"], "properties": { "sessionId": { "type": "string" }, "path": { "type": "string" } } })
        ),
        tool_schema(
            "myterminal_file_rename",
            "重命名或移动远端路径，默认需要 GUI 审批。",
            json!({ "type": "object", "required": ["sessionId", "path", "newPath"], "properties": { "sessionId": { "type": "string" }, "path": { "type": "string" }, "newPath": { "type": "string" } } })
        ),
        tool_schema(
            "myterminal_file_mkdir",
            "创建远端目录，默认需要 GUI 审批。",
            json!({ "type": "object", "required": ["sessionId", "path"], "properties": { "sessionId": { "type": "string" }, "path": { "type": "string" } } })
        )
    ])
}

fn tool_schema(name: &str, description: &str, input_schema: Value) -> Value {
    json!({ "name": name, "description": description, "inputSchema": input_schema })
}

fn call_mcp_tool(id: Value, params: Value) -> Result<Value, AppError> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::Validation("tool name is required".into()))?;
    let args = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let client = match BrokerClient::discover() {
        Ok(client) => client,
        Err(error) => return Ok(mcp_tool_error(id, error.to_string())),
    };
    let result = match name {
        "myterminal_list_connections" => client.get("/connections"),
        "myterminal_open_session" => client.post("/sessions/open", &args),
        "myterminal_close_session" => client.post("/sessions/close", &args),
        "myterminal_run_command" => client.post("/exec", &args),
        "myterminal_file_list" => client.post("/files/list", &args),
        "myterminal_file_read" => client.post("/files/read", &args),
        "myterminal_file_write" => client.post("/files/write", &args),
        "myterminal_file_delete" => client.post("/files/delete", &args),
        "myterminal_file_rename" => client.post("/files/rename", &args),
        "myterminal_file_mkdir" => client.post("/files/mkdir", &args),
        _ => Err(AppError::Validation(format!("unknown tool {name}"))),
    };
    match result {
        Ok(value) => Ok(mcp_tool_success(id, value)),
        Err(error) => Ok(mcp_tool_error(id, error.to_string())),
    }
}

fn mcp_tool_success(id: Value, value: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "content": [{ "type": "text", "text": serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".into()) }]
        }
    })
}

fn mcp_tool_error(id: Value, message: String) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "isError": true,
            "content": [{ "type": "text", "text": message }]
        }
    })
}
