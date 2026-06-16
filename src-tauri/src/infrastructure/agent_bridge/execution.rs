use std::{
    io::{ErrorKind, Read, Write},
    path::Path,
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use serde_json::json;
use ssh2::Session;

use crate::{
    domain::entities::{AgentBridgeSettings, ConnectionProfile, RemoteFileEntry},
    domain::services::join_remote_path,
    error::AppError,
    infrastructure::crypto::CryptoService,
    infrastructure::persistence::StorageService,
    infrastructure::ssh::{connect_ssh, stat_is_dir, stat_is_symlink},
};

use super::runtime::{lock_sessions, AgentBridgeRuntime};
use super::types::*;
use crate::domain::entities::now_rfc3339;
use serde_json::Value;

pub fn execute_action(
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
            Ok(json!({ "ok": true }))
        }
        AgentAction::FileDelete(payload) => {
            delete_agent_file(runtime, storage, crypto, payload)?;
            Ok(json!({ "ok": true }))
        }
        AgentAction::FileRename(payload) => {
            rename_agent_file(runtime, storage, crypto, payload)?;
            Ok(json!({ "ok": true }))
        }
        AgentAction::FileMkdir(payload) => {
            mkdir_agent_file(runtime, storage, crypto, payload)?;
            Ok(json!({ "ok": true }))
        }
    }
}

pub fn list_connections(
    storage: &StorageService,
    crypto: &CryptoService,
) -> Result<AgentConnectionList, AppError> {
    let connections = storage
        .load_connections(crypto)?
        .into_iter()
        .map(sanitize_connection)
        .collect::<Vec<_>>();
    let settings = storage.load_settings(crypto)?;
    let groups = build_group_tree(&settings.connection_groups, &connections);
    Ok(AgentConnectionList {
        groups,
        connections,
    })
}

fn sanitize_connection(connection: ConnectionProfile) -> AgentConnectionSummary {
    AgentConnectionSummary {
        id: connection.id,
        name: connection.name,
        group_path: connection.group_path,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        tags: connection.tags,
        note: connection.note,
    }
}

pub fn build_group_tree(
    group_paths: &[String],
    connections: &[AgentConnectionSummary],
) -> Vec<AgentConnectionGroupNode> {
    let mut paths = group_paths.to_vec();
    for connection in connections {
        if let Some(path) = connection
            .group_path
            .as_ref()
            .filter(|value| !value.is_empty())
        {
            if !paths.contains(path) {
                paths.push(path.clone());
            }
        }
    }
    paths.sort();
    paths.dedup();
    build_group_children("", &paths, connections)
}

fn build_group_children(
    parent: &str,
    paths: &[String],
    connections: &[AgentConnectionSummary],
) -> Vec<AgentConnectionGroupNode> {
    let mut nodes = Vec::new();
    for path in paths {
        let (node_parent, name) = path.rsplit_once('/').unwrap_or(("", path.as_str()));
        if node_parent != parent {
            continue;
        }
        let children = build_group_children(path, paths, connections);
        let group_connections = connections
            .iter()
            .filter(|connection| connection.group_path.as_deref() == Some(path.as_str()))
            .cloned()
            .collect();
        nodes.push(AgentConnectionGroupNode {
            name: name.to_string(),
            path: path.clone(),
            children,
            connections: group_connections,
        });
    }
    nodes
}

pub fn open_agent_session(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    connection_id: &str,
) -> Result<AgentSession, AppError> {
    let connection = find_connection(storage, crypto, connection_id)?;
    let session = AgentSession {
        id: uuid::Uuid::new_v4().to_string(),
        connection_id: connection.id.clone(),
        title: format!("{}@{}", connection.username, connection.host),
        cwd: "~".into(),
        opened_at: now_rfc3339(),
    };
    lock_sessions(runtime)?.insert(session.id.clone(), session.clone());
    Ok(session)
}

pub fn close_agent_session(
    runtime: &AgentBridgeRuntime,
    session_id: &str,
) -> Result<bool, AppError> {
    lock_sessions(runtime)?.remove(session_id);
    Ok(true)
}

fn find_connection(
    storage: &StorageService,
    crypto: &CryptoService,
    connection_id: &str,
) -> Result<ConnectionProfile, AppError> {
    storage
        .load_connections(crypto)?
        .into_iter()
        .find(|connection| connection.id == connection_id)
        .ok_or_else(|| AppError::NotFound(format!("connection {connection_id} not found")))
}

fn connection_for_session(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    session_id: &str,
) -> Result<(AgentSession, ConnectionProfile), AppError> {
    let session = lock_sessions(runtime)?
        .get(session_id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("agent session {session_id} not found")))?;
    let connection = find_connection(storage, crypto, &session.connection_id)?;
    Ok((session, connection))
}

pub fn run_agent_command(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    settings: &AgentBridgeSettings,
    payload: &RunCommandRequest,
) -> Result<AgentCommandResult, AppError> {
    let (session, connection) =
        connection_for_session(runtime, storage, crypto, &payload.session_id)?;
    let ssh_session = connect_ssh(&connection)?;
    let cwd = payload.cwd.clone().unwrap_or_else(|| session.cwd.clone());
    let timeout = Duration::from_secs(
        payload
            .timeout_sec
            .unwrap_or(settings.default_timeout_sec as u64)
            .clamp(1, 3600),
    );
    let command = command_with_cwd(&payload.command, &cwd);
    exec_agent_command(
        ssh_session,
        &session,
        command,
        payload.command.clone(),
        cwd,
        timeout,
        settings.max_output_bytes.max(1024),
    )
}

fn command_with_cwd(command: &str, cwd: &str) -> String {
    let trimmed_cwd = cwd.trim();
    if trimmed_cwd.is_empty() || trimmed_cwd == "~" {
        command.to_string()
    } else {
        format!("cd {} && {}", shell_quote(trimmed_cwd), command)
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn append_bounded(target: &mut Vec<u8>, input: &[u8], max_output_bytes: usize) -> bool {
    if target.len() >= max_output_bytes {
        return true;
    }
    let remaining = max_output_bytes - target.len();
    if input.len() > remaining {
        target.extend_from_slice(&input[..remaining]);
        true
    } else {
        target.extend_from_slice(input);
        false
    }
}

fn exec_agent_command(
    ssh_session: Session,
    session: &AgentSession,
    wrapped_command: String,
    original_command: String,
    cwd: String,
    timeout: Duration,
    max_output_bytes: usize,
) -> Result<AgentCommandResult, AppError> {
    let run_id = uuid::Uuid::new_v4().to_string();
    let started_at = now_rfc3339();
    let mut channel = ssh_session
        .channel_session()
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    channel
        .exec(&wrapped_command)
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    ssh_session.set_blocking(false);

    let started = Instant::now();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut truncated = false;
    let mut stdout_buffer = [0_u8; 8192];
    let mut stderr_buffer = [0_u8; 8192];
    let mut timed_out = false;

    loop {
        match channel.read(&mut stdout_buffer) {
            Ok(0) => {}
            Ok(size) => {
                truncated |= append_bounded(&mut stdout, &stdout_buffer[..size], max_output_bytes);
            }
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                ) => {}
            Err(error) => return Err(AppError::Io(error)),
        }

        {
            let mut stderr_stream = channel.stderr();
            match stderr_stream.read(&mut stderr_buffer) {
                Ok(0) => {}
                Ok(size) => {
                    truncated |=
                        append_bounded(&mut stderr, &stderr_buffer[..size], max_output_bytes);
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                    ) => {}
                Err(error) => return Err(AppError::Io(error)),
            }
        }

        if channel.eof() {
            break;
        }

        if started.elapsed() >= timeout {
            timed_out = true;
            let _ = channel.close();
            break;
        }

        thread::sleep(Duration::from_millis(30));
    }

    let _ = channel.wait_close();
    let exit_code = channel.exit_status().ok();
    let mut status = if timed_out { "timeout" } else { "completed" }.to_string();
    if !timed_out && exit_code.unwrap_or(0) != 0 {
        status = "failed".into();
    }

    Ok(AgentCommandResult {
        run_id,
        session_id: session.id.clone(),
        connection_id: session.connection_id.clone(),
        command: original_command,
        cwd,
        status,
        exit_code,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        truncated,
        started_at,
        finished_at: now_rfc3339(),
    })
}

pub fn list_agent_files(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    payload: &FilePathRequest,
) -> Result<Vec<RemoteFileEntry>, AppError> {
    let (_session, connection) =
        connection_for_session(runtime, storage, crypto, &payload.session_id)?;
    let ssh_session = connect_ssh(&connection)?;
    let sftp = ssh_session
        .sftp()
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    let entries = sftp
        .readdir(Path::new(&payload.path))
        .map_err(|error| AppError::Ssh(error.to_string()))?;

    Ok(entries
        .into_iter()
        .filter_map(|(path, stat)| {
            let name = path.file_name()?.to_string_lossy().to_string();
            if name == "." || name == ".." {
                return None;
            }
            let remote_path = join_remote_path(&payload.path, &name);
            Some(RemoteFileEntry {
                name,
                path: remote_path,
                is_dir: stat_is_dir(&stat),
                is_symlink: stat_is_symlink(&stat),
                size: stat.size.unwrap_or(0),
                modified_at: stat.mtime.map(|mtime| {
                    chrono::DateTime::<Utc>::from_timestamp(mtime as i64, 0)
                        .unwrap_or_else(Utc::now)
                        .to_rfc3339()
                }),
                permissions: None,
                owner: stat.uid.map(|uid| uid.to_string()),
                group: stat.gid.map(|gid| gid.to_string()),
            })
        })
        .collect())
}

pub fn read_agent_file(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    payload: &FilePathRequest,
) -> Result<AgentFileReadResult, AppError> {
    let (_session, connection) =
        connection_for_session(runtime, storage, crypto, &payload.session_id)?;
    let ssh_session = connect_ssh(&connection)?;
    let sftp = ssh_session
        .sftp()
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    let mut file = sftp
        .open(Path::new(&payload.path))
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let size = bytes.len();
    match String::from_utf8(bytes) {
        Ok(content) => Ok(AgentFileReadResult {
            session_id: payload.session_id.clone(),
            path: payload.path.clone(),
            encoding: "utf-8".into(),
            content: Some(content),
            content_base64: None,
            size,
        }),
        Err(error) => Ok(AgentFileReadResult {
            session_id: payload.session_id.clone(),
            path: payload.path.clone(),
            encoding: "base64".into(),
            content: None,
            content_base64: Some(STANDARD.encode(error.into_bytes())),
            size,
        }),
    }
}

fn write_agent_file(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    payload: &FileWriteRequest,
) -> Result<(), AppError> {
    let (_session, connection) =
        connection_for_session(runtime, storage, crypto, &payload.session_id)?;
    let ssh_session = connect_ssh(&connection)?;
    let sftp = ssh_session
        .sftp()
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    let bytes = if let Some(content) = &payload.content {
        content.as_bytes().to_vec()
    } else if let Some(content_base64) = &payload.content_base64 {
        STANDARD
            .decode(content_base64)
            .map_err(|error| AppError::Validation(format!("invalid base64 content: {error}")))?
    } else {
        Vec::new()
    };
    let mut file = sftp
        .create(Path::new(&payload.path))
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    file.write_all(&bytes)?;
    Ok(())
}

fn delete_agent_file(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    payload: &FilePathRequest,
) -> Result<(), AppError> {
    let (_session, connection) =
        connection_for_session(runtime, storage, crypto, &payload.session_id)?;
    let ssh_session = connect_ssh(&connection)?;
    let sftp = ssh_session
        .sftp()
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    let stat = sftp
        .stat(Path::new(&payload.path))
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    if stat_is_dir(&stat) {
        sftp.rmdir(Path::new(&payload.path))
            .map_err(|error| AppError::Ssh(error.to_string()))?;
    } else {
        sftp.unlink(Path::new(&payload.path))
            .map_err(|error| AppError::Ssh(error.to_string()))?;
    }
    Ok(())
}

fn rename_agent_file(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    payload: &FileRenameRequest,
) -> Result<(), AppError> {
    let (_session, connection) =
        connection_for_session(runtime, storage, crypto, &payload.session_id)?;
    let ssh_session = connect_ssh(&connection)?;
    let sftp = ssh_session
        .sftp()
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    sftp.rename(Path::new(&payload.path), Path::new(&payload.new_path), None)
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    Ok(())
}

fn mkdir_agent_file(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    payload: &FilePathRequest,
) -> Result<(), AppError> {
    let (_session, connection) =
        connection_for_session(runtime, storage, crypto, &payload.session_id)?;
    let ssh_session = connect_ssh(&connection)?;
    let sftp = ssh_session
        .sftp()
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    sftp.mkdir(Path::new(&payload.path), 0o755)
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::entities::ConnectionProfile;

    #[test]
    fn sanitize_connection_drops_secrets() {
        let summary = sanitize_connection(ConnectionProfile {
            id: "c1".into(),
            name: "prod".into(),
            group_path: Some("ops/prod".into()),
            host: "10.0.0.2".into(),
            port: 22,
            username: "root".into(),
            auth_method: "password".into(),
            password: "secret".into(),
            private_key_path: Some("C:/key".into()),
            private_key_text: Some("PRIVATE".into()),
            passphrase: Some("pass".into()),
            note: Some("note".into()),
            tags: vec!["prod".into()],
        });
        let serialized = serde_json::to_string(&summary).unwrap();
        assert!(serialized.contains("10.0.0.2"));
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("PRIVATE"));
        assert!(!serialized.contains("pass"));
    }

    #[test]
    fn group_tree_keeps_nested_groups() {
        let connections = vec![AgentConnectionSummary {
            id: "c1".into(),
            name: "web".into(),
            group_path: Some("prod/web".into()),
            host: "10.0.0.3".into(),
            port: 22,
            username: "root".into(),
            tags: Vec::new(),
            note: None,
        }];
        let tree = build_group_tree(&["prod".into(), "prod/web".into()], &connections);
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].children.len(), 1);
        assert_eq!(tree[0].children[0].connections.len(), 1);
    }
}
