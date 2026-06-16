use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};

use crate::domain::entities::{TerminalOutputChunk, TerminalSession};
use crate::error::AppError;
use crate::infrastructure::crypto::CryptoService;
use crate::infrastructure::persistence::StorageService;
use crate::infrastructure::ssh::*;
use crate::state::{RuntimeSession, SessionControl};

fn lock_sessions(
    sessions: &Mutex<HashMap<String, RuntimeSession>>,
) -> Result<std::sync::MutexGuard<'_, HashMap<String, RuntimeSession>>, AppError> {
    sessions
        .lock()
        .map_err(|_| AppError::Validation("session registry is unavailable".into()))
}

/// Open a new SSH terminal session and spawn its shell thread.
pub fn open_ssh_session(
    storage: &StorageService,
    crypto: &CryptoService,
    sessions: &Mutex<HashMap<String, RuntimeSession>>,
    connection_id: String,
) -> Result<TerminalSession, AppError> {
    let connection =
        super::connection_service::ensure_connection_exists(storage, crypto, &connection_id)?;
    let ssh_session = connect_ssh(&connection)?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let output_queue = Arc::new(std::sync::Mutex::new(Vec::<TerminalOutputChunk>::new()));
    let (control_tx, control_rx) = mpsc::channel();

    let runtime = RuntimeSession {
        session: TerminalSession {
            id: session_id.clone(),
            connection_id: connection.id.clone(),
            title: format!("{}@{}", connection.username, connection.host),
            status: "connected".into(),
            cwd: Some("~".into()),
        },
        cols: 120,
        rows: 32,
        output_queue: Arc::clone(&output_queue),
        control_tx: control_tx.clone(),
    };

    spawn_shell_thread(
        session_id,
        ssh_session,
        runtime.cols,
        runtime.rows,
        output_queue,
        control_rx,
    );

    let session = runtime.session.clone();
    lock_sessions(sessions)?.insert(session.id.clone(), runtime);
    Ok(session)
}

/// Close an SSH terminal session.
pub fn close_ssh_session(
    sessions: &Mutex<HashMap<String, RuntimeSession>>,
    session_id: String,
) -> Result<bool, AppError> {
    if let Some(runtime) = lock_sessions(sessions)?.remove(&session_id) {
        let _ = runtime.control_tx.send(SessionControl::Close);
    }
    Ok(true)
}

/// Write data (terminal input) to a session.
pub fn write_terminal_input(
    sessions: &Mutex<HashMap<String, RuntimeSession>>,
    session_id: String,
    data: String,
) -> Result<bool, AppError> {
    let session_map = lock_sessions(sessions)?;
    let runtime = session_map
        .get(&session_id)
        .ok_or_else(|| AppError::NotFound(format!("session {session_id} not found")))?;
    runtime
        .control_tx
        .send(SessionControl::Input(data))
        .map_err(|_| AppError::Validation("failed to send terminal input".into()))?;
    Ok(true)
}

/// Drain all pending output chunks from a session.
pub fn read_terminal_output(
    sessions: &Mutex<HashMap<String, RuntimeSession>>,
    session_id: String,
) -> Result<Vec<TerminalOutputChunk>, AppError> {
    let session_map = lock_sessions(sessions)?;
    let runtime = session_map
        .get(&session_id)
        .ok_or_else(|| AppError::NotFound(format!("session {session_id} not found")))?;
    let mut output = runtime
        .output_queue
        .lock()
        .map_err(|_| AppError::Validation("terminal output buffer is unavailable".into()))?;
    Ok(output.drain(..).collect())
}

/// Resize a terminal session.
pub fn resize_terminal(
    sessions: &Mutex<HashMap<String, RuntimeSession>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<bool, AppError> {
    let mut session_map = lock_sessions(sessions)?;
    let runtime = session_map
        .get_mut(&session_id)
        .ok_or_else(|| AppError::NotFound(format!("session {session_id} not found")))?;
    runtime.cols = cols;
    runtime.rows = rows;
    runtime
        .control_tx
        .send(SessionControl::Resize { cols, rows })
        .map_err(|_| AppError::Validation("failed to resize terminal".into()))?;
    Ok(true)
}
