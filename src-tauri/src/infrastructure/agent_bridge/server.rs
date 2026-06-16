use std::{
    collections::HashMap,
    io::{Read, Write},
    net::TcpStream,
    time::Duration,
};

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::AppError;

use super::execution::{
    close_agent_session, list_agent_files, list_connections, open_agent_session, read_agent_file,
};
use super::request::submit_action;
use super::runtime::{bridge_status, AgentBridgeRuntime};
use super::types::*;

fn decode_request_body<T: for<'de> Deserialize<'de>>(body: &str) -> Result<T, AppError> {
    serde_json::from_str(body).map_err(AppError::from)
}

pub fn handle_http_request(
    stream: &mut TcpStream,
    runtime: &AgentBridgeRuntime,
    storage: &crate::infrastructure::persistence::StorageService,
    crypto: &crate::infrastructure::crypto::CryptoService,
    settings: &crate::domain::entities::AgentBridgeSettings,
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
            let session = open_agent_session(runtime, storage, crypto, &payload.connection_id)?;
            serde_json::to_value(session).map_err(AppError::from)
        }
        ("POST", "/sessions/close") => {
            let payload: CloseSessionRequest = decode_request_body(&request.body)?;
            close_agent_session(runtime, &payload.session_id)?;
            Ok(json!({ "ok": true }))
        }
        ("POST", "/exec") => {
            let payload: RunCommandRequest = decode_request_body(&request.body)?;
            submit_action(
                runtime,
                storage,
                crypto,
                settings,
                AgentAction::RunCommand(payload),
            )
        }
        ("POST", "/files/list") => {
            let payload: FilePathRequest = decode_request_body(&request.body)?;
            serde_json::to_value(list_agent_files(runtime, storage, crypto, &payload)?)
                .map_err(AppError::from)
        }
        ("POST", "/files/read") => {
            let payload: FilePathRequest = decode_request_body(&request.body)?;
            serde_json::to_value(read_agent_file(runtime, storage, crypto, &payload)?)
                .map_err(AppError::from)
        }
        ("POST", "/files/write") => {
            let payload: FileWriteRequest = decode_request_body(&request.body)?;
            submit_action(
                runtime,
                storage,
                crypto,
                settings,
                AgentAction::FileWrite(payload),
            )
        }
        ("POST", "/files/delete") => {
            let payload: FilePathRequest = decode_request_body(&request.body)?;
            submit_action(
                runtime,
                storage,
                crypto,
                settings,
                AgentAction::FileDelete(payload),
            )
        }
        ("POST", "/files/rename") => {
            let payload: FileRenameRequest = decode_request_body(&request.body)?;
            submit_action(
                runtime,
                storage,
                crypto,
                settings,
                AgentAction::FileRename(payload),
            )
        }
        ("POST", "/files/mkdir") => {
            let payload: FilePathRequest = decode_request_body(&request.body)?;
            submit_action(
                runtime,
                storage,
                crypto,
                settings,
                AgentAction::FileMkdir(payload),
            )
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

pub fn write_http_json(stream: &mut TcpStream, status: u16, body: &Value) -> Result<(), AppError> {
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
        body_text.len(),
        body_text
    );
    stream.write_all(response.as_bytes())?;
    Ok(())
}
