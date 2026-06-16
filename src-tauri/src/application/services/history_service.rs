use chrono::Utc;

use crate::domain::entities::HistoryEntry;
use crate::error::AppError;
use crate::infrastructure::crypto::CryptoService;
use crate::infrastructure::persistence::StorageService;
use crate::infrastructure::ssh::read_remote_shell_history_entries;
use crate::interface::dto::HistoryEntryInput;

/// Read remote shell history entries from a server.
pub fn read_remote_shell_history(
    storage: &StorageService,
    crypto: &CryptoService,
    connection_id: String,
    limit: Option<usize>,
) -> Result<Vec<HistoryEntry>, AppError> {
    let connection =
        super::connection_service::ensure_connection_exists(storage, crypto, &connection_id)?;
    read_remote_shell_history_entries(&connection, limit.unwrap_or(100))
}

/// Append a command to local history.
pub fn append_command_history(
    storage: &StorageService,
    entry: HistoryEntryInput,
) -> Result<HistoryEntry, AppError> {
    let mut history = storage.load_history()?;
    let history_entry = if entry.id.is_none() && entry.executed_at.is_none() {
        HistoryEntry::new(entry.connection_id, entry.command)
    } else {
        HistoryEntry {
            id: entry.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            connection_id: entry.connection_id,
            command: entry.command,
            executed_at: entry.executed_at.unwrap_or_else(|| Utc::now().to_rfc3339()),
        }
    };
    history.insert(0, history_entry.clone());
    if history.len() > 500 {
        history.truncate(500);
    }
    storage.save_history(&history)?;
    Ok(history_entry)
}

/// Get command suggestions from history based on a prefix.
pub fn get_command_suggestions(
    storage: &StorageService,
    connection_id: Option<String>,
    prefix: String,
    limit: usize,
) -> Result<Vec<String>, AppError> {
    let normalized = prefix.trim().to_lowercase();
    if normalized.is_empty() {
        return Ok(Vec::new());
    }

    let history = storage.load_history()?;
    let mut suggestions = Vec::new();
    for item in history {
        if let Some(expected_connection_id) = &connection_id {
            if item.connection_id.as_ref() != Some(expected_connection_id) {
                continue;
            }
        }

        if item.command.to_lowercase().starts_with(&normalized)
            && !suggestions.contains(&item.command)
        {
            suggestions.push(item.command);
        }

        if suggestions.len() >= limit.max(1) {
            break;
        }
    }
    Ok(suggestions)
}
