//! Agent Bridge 的本地 HTTP Broker 适配器。
//! 负责 Bearer 鉴权、请求解析、JSON 响应和外部/内置 Agent 共用的动作路由。

use std::{
    collections::HashMap,
    io::{Read, Write},
    net::TcpStream,
    time::Duration,
};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    crypto::CryptoService, error::AppError, models::AgentBridgeSettings, storage::StorageService,
};

use super::{
    bridge_status, close_agent_session, list_agent_files, list_connections, open_agent_session,
    read_agent_file, submit_action, AgentAction, AgentActionContext, AgentBridgeRuntime,
    CloseSessionRequest, FileDownloadRequest, FilePathRequest, FileRenameRequest,
    FileUploadRequest, FileWriteRequest, OpenSessionRequest, RunCommandRequest,
};

fn decode_request_body<T: for<'de> Deserialize<'de>>(body: &str) -> Result<T, AppError> {
    serde_json::from_str(body).map_err(AppError::from)
}

/// Agent 动作的统一分派表：外部 MCP（经 HTTP Broker）与内置 Agent 都走这里。
/// 单一入口保证两条路径共享同一套审批闸门、会话解析与错误语义，不会出现绕过授权的“后门”。
pub fn dispatch_agent_action(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    settings: &AgentBridgeSettings,
    route: &str,
    body: &Value,
) -> Result<Value, AppError> {
    dispatch_agent_action_with_context(runtime, storage, crypto, settings, route, body, None)
}

/// 带来源上下文的统一分派入口；仅内置 AI 对话使用上下文，以便审批回到原对话内展示。
pub fn dispatch_agent_action_with_context(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    settings: &AgentBridgeSettings,
    route: &str,
    body: &Value,
    context: Option<&AgentActionContext<'_>>,
) -> Result<Value, AppError> {
    match route {
        "/sessions/open" => {
            let payload: OpenSessionRequest = decode_action_payload(body)?;
            serde_json::to_value(open_agent_session(runtime, storage, crypto, &payload)?)
                .map_err(AppError::from)
        }
        "/sessions/close" => {
            let payload: CloseSessionRequest = decode_action_payload(body)?;
            close_agent_session(runtime, &payload.session_id)?;
            Ok(json!({ "ok": true }))
        }
        "/exec" => {
            let payload: RunCommandRequest = decode_action_payload(body)?;
            submit_action(
                runtime,
                storage,
                crypto,
                settings,
                AgentAction::RunCommand(payload),
                context,
            )
        }
        // 只读操作不入审批队列，与既有行为保持一致。
        "/files/list" => {
            let payload: FilePathRequest = decode_action_payload(body)?;
            serde_json::to_value(list_agent_files(runtime, storage, crypto, &payload)?)
                .map_err(AppError::from)
        }
        "/files/read" => {
            let payload: FilePathRequest = decode_action_payload(body)?;
            serde_json::to_value(read_agent_file(runtime, storage, crypto, &payload)?)
                .map_err(AppError::from)
        }
        "/files/write" => {
            let payload: FileWriteRequest = decode_action_payload(body)?;
            submit_action(
                runtime,
                storage,
                crypto,
                settings,
                AgentAction::FileWrite(payload),
                context,
            )
        }
        "/files/upload" => {
            let payload: FileUploadRequest = decode_action_payload(body)?;
            submit_action(
                runtime,
                storage,
                crypto,
                settings,
                AgentAction::FileUpload(payload),
                context,
            )
        }
        "/files/download" => {
            let payload: FileDownloadRequest = decode_action_payload(body)?;
            submit_action(
                runtime,
                storage,
                crypto,
                settings,
                AgentAction::FileDownload(payload),
                context,
            )
        }
        "/files/delete" => {
            let payload: FilePathRequest = decode_action_payload(body)?;
            submit_action(
                runtime,
                storage,
                crypto,
                settings,
                AgentAction::FileDelete(payload),
                context,
            )
        }
        "/files/rename" => {
            let payload: FileRenameRequest = decode_action_payload(body)?;
            submit_action(
                runtime,
                storage,
                crypto,
                settings,
                AgentAction::FileRename(payload),
                context,
            )
        }
        "/files/mkdir" => {
            let payload: FilePathRequest = decode_action_payload(body)?;
            submit_action(
                runtime,
                storage,
                crypto,
                settings,
                AgentAction::FileMkdir(payload),
                context,
            )
        }
        other => Err(AppError::NotFound(format!("POST {other}"))),
    }
}

/// 把 JSON 参数解析成具体动作负载；错误信息保留字段名，便于模型自行纠正入参。
fn decode_action_payload<T: for<'de> Deserialize<'de>>(body: &Value) -> Result<T, AppError> {
    serde_json::from_value(body.clone())
        .map_err(|error| AppError::Validation(format!("invalid tool arguments: {error}")))
}

pub(super) fn handle_http_request(
    stream: &mut TcpStream,
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    settings: &AgentBridgeSettings,
    token: &str,
) -> Result<(), AppError> {
    let request = read_http_request(stream)?;
    if !request_is_authorized(&request, token) {
        return write_http_json(
            stream,
            401,
            &json!({ "ok": false, "error": "unauthorized" }),
        );
    }

    let result = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/status") => {
            let status = bridge_status(runtime, storage, settings)?;
            serde_json::to_value(status).map_err(AppError::from)
        }
        ("GET", "/connections") => {
            let connections = list_connections(storage, crypto)?;
            serde_json::to_value(connections).map_err(AppError::from)
        }
        ("POST", "/sessions/open") => {
            let payload: OpenSessionRequest = decode_request_body(&request.body)?;
            let session = open_agent_session(runtime, storage, crypto, &payload)?;
            serde_json::to_value(session).map_err(AppError::from)
        }
        ("POST", "/sessions/close") => {
            let payload: CloseSessionRequest = decode_request_body(&request.body)?;
            close_agent_session(runtime, &payload.session_id)?;
            Ok(json!({ "ok": true }))
        }
        // 其余 POST 路由与内置 Agent 共用同一张分派表，保证两条入口的审批与语义完全一致。
        ("POST", path) => {
            let body: Value = if request.body.trim().is_empty() {
                json!({})
            } else {
                serde_json::from_str(&request.body)?
            };
            dispatch_agent_action(runtime, storage, crypto, settings, path, &body)
        }
        _ => Err(AppError::NotFound(format!(
            "{} {}",
            request.method, request.path
        ))),
    };

    match result {
        Ok(value) => write_http_json(stream, 200, &json!({ "ok": true, "data": value })),
        Err(error) => write_http_json(
            stream,
            400,
            &json!({ "ok": false, "error": error.to_string() }),
        ),
    }
}

#[derive(Debug)]
struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: String,
}

fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, AppError> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 4096];
    loop {
        let size = stream.read(&mut buffer)?;
        if size == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..size]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }

    let header_end = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| AppError::Validation("invalid http request".into()))?;
    let header_text = String::from_utf8_lossy(&bytes[..header_end]).into_owned();
    let mut lines = header_text.lines();
    let request_line = lines
        .next()
        .ok_or_else(|| AppError::Validation("missing http request line".into()))?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let headers = lines
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            Some((key.trim().to_ascii_lowercase(), value.trim().to_string()))
        })
        .collect::<HashMap<_, _>>();
    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let body_start = header_end + 4;
    while bytes.len().saturating_sub(body_start) < content_length {
        let size = stream.read(&mut buffer)?;
        if size == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..size]);
    }
    let body_end = body_start + content_length.min(bytes.len().saturating_sub(body_start));
    let body = String::from_utf8_lossy(&bytes[body_start..body_end]).into_owned();

    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn request_is_authorized(request: &HttpRequest, token: &str) -> bool {
    request
        .headers
        .get("authorization")
        .map(|value| value == &format!("Bearer {token}"))
        .unwrap_or(false)
}

pub(super) fn write_http_json(
    stream: &mut TcpStream,
    status: u16,
    body: &Value,
) -> Result<(), AppError> {
    let body_text = serde_json::to_string(body)?;
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Internal Server Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body_text.as_bytes().len(),
        body_text
    );
    stream.write_all(response.as_bytes())?;
    Ok(())
}
