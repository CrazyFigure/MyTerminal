use std::fs;
use std::io::Write;
use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::domain::entities::{EditorDocument, RemoteFileEntry};
use crate::domain::services;
use crate::error::AppError;
use crate::infrastructure::crypto::CryptoService;
use crate::infrastructure::persistence::StorageService;
use crate::infrastructure::ssh::*;

/// List remote files at the given path.
pub fn list_remote_files(
    storage: &StorageService,
    crypto: &CryptoService,
    connection_id: String,
    path: String,
) -> Result<Vec<RemoteFileEntry>, AppError> {
    let connection =
        super::connection_service::ensure_connection_exists(storage, crypto, &connection_id)?;
    let session = connect_ssh(&connection)?;
    let (user_names, group_names) = load_remote_identity_maps(&session);
    let sftp = session.sftp().map_err(ssh_error)?;
    list_remote_entries(&sftp, &path, &user_names, &group_names)
}

/// Upload a file to a remote server (base64-encoded content).
pub fn upload_remote_file(
    storage: &StorageService,
    crypto: &CryptoService,
    connection_id: String,
    remote_dir: String,
    file_name: String,
    content_base64: String,
) -> Result<bool, AppError> {
    let connection =
        super::connection_service::ensure_connection_exists(storage, crypto, &connection_id)?;
    let session = connect_ssh(&connection)?;
    let sftp = session.sftp().map_err(ssh_error)?;
    let directory = resolve_remote_dir(&sftp, &remote_dir)?;
    let remote_path = services::join_remote_path(&directory, &file_name);
    let bytes = STANDARD
        .decode(content_base64)
        .map_err(|error| AppError::Validation(format!("invalid upload payload: {error}")))?;
    let mut remote_file = sftp.create(Path::new(&remote_path)).map_err(ssh_error)?;
    remote_file.write_all(&bytes).map_err(AppError::from)?;
    remote_file.flush().map_err(AppError::from)?;
    Ok(true)
}

/// Download a remote file to the local downloads directory.
pub fn download_remote_file(
    storage: &StorageService,
    crypto: &CryptoService,
    connection_id: String,
    path: String,
) -> Result<String, AppError> {
    let connection =
        super::connection_service::ensure_connection_exists(storage, crypto, &connection_id)?;
    let bytes = read_remote_file_bytes(&connection, &path)?;

    let downloads_dir = storage.downloads_dir_path();
    fs::create_dir_all(&downloads_dir)?;

    let file_name = services::remote_file_name(&path).unwrap_or_else(|| "download.bin".into());
    let destination = downloads_dir.join(file_name);
    fs::write(&destination, bytes)?;

    Ok(destination.to_string_lossy().to_string())
}

/// Delete a single remote file or directory.
pub fn delete_remote_path(
    storage: &StorageService,
    crypto: &CryptoService,
    connection_id: String,
    path: String,
) -> Result<bool, AppError> {
    let connection =
        super::connection_service::ensure_connection_exists(storage, crypto, &connection_id)?;
    let session = connect_ssh(&connection)?;
    let sftp = session.sftp().map_err(ssh_error)?;
    delete_remote_path_with_sftp(&sftp, &path)?;
    Ok(true)
}

/// Delete multiple remote files/dirs in a single SSH session.
pub fn delete_remote_paths(
    storage: &StorageService,
    crypto: &CryptoService,
    connection_id: String,
    paths: Vec<String>,
) -> Result<bool, AppError> {
    let connection =
        super::connection_service::ensure_connection_exists(storage, crypto, &connection_id)?;
    let session = connect_ssh(&connection)?;
    let sftp = session.sftp().map_err(ssh_error)?;
    for path in paths.iter().filter(|path| !path.trim().is_empty()) {
        delete_remote_path_with_sftp(&sftp, path)?;
    }
    Ok(true)
}

/// Rename a remote file or directory.
pub fn rename_remote_path(
    storage: &StorageService,
    crypto: &CryptoService,
    connection_id: String,
    path: String,
    new_path: String,
) -> Result<bool, AppError> {
    use std::path::Path;
    let connection =
        super::connection_service::ensure_connection_exists(storage, crypto, &connection_id)?;
    let session = connect_ssh(&connection)?;
    let sftp = session.sftp().map_err(ssh_error)?;
    let remote_path = services::normalize_remote_path(&path);
    let next_remote_path = services::normalize_remote_path(&new_path);
    sftp.rename(Path::new(&remote_path), Path::new(&next_remote_path), None)
        .map_err(ssh_error)?;
    Ok(true)
}

/// Load a remote file's content for the built-in editor.
pub fn load_editor_document(
    storage: &StorageService,
    crypto: &CryptoService,
    connection_id: String,
    path: String,
) -> Result<EditorDocument, AppError> {
    let connection =
        super::connection_service::ensure_connection_exists(storage, crypto, &connection_id)?;
    let bytes = match read_remote_file_bytes(&connection, &path) {
        Ok(bytes) => bytes,
        Err(error) => {
            if let Some(mut cached) = storage.load_editor_cache(&connection_id, &path)? {
                cached.dirty = true;
                return Ok(cached);
            }
            return Err(error);
        }
    };
    let document = EditorDocument {
        connection_id,
        path: path.clone(),
        content: String::from_utf8_lossy(&bytes).into_owned(),
        language: services::detect_language(&path),
        dirty: false,
    };
    storage.save_editor_cache(&document)?;
    Ok(document)
}

/// Save an editor document back to the remote server.
pub fn save_editor_document(
    storage: &StorageService,
    crypto: &CryptoService,
    connection_id: String,
    path: String,
    content: String,
) -> Result<bool, AppError> {
    let connection =
        super::connection_service::ensure_connection_exists(storage, crypto, &connection_id)?;
    write_remote_file_bytes(&connection, &path, content.as_bytes())?;

    let document = EditorDocument {
        connection_id,
        path: path.clone(),
        content,
        language: services::detect_language(&path),
        dirty: false,
    };
    storage.save_editor_cache(&document)?;
    Ok(true)
}
