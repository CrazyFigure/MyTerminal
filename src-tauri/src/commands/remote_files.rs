use base64::{engine::general_purpose::STANDARD, Engine as _};
use tauri::State;

use crate::{
    error::AppError,
    models::{EditorDocument, RemoteFileEntry},
    state::AppState,
};

use super::{
    detect_language, ensure_connection_exists,
    remote_access::{
        copy_remote_paths_with_cache, delete_remote_path_with_cache,
        delete_remote_paths_with_cache, download_remote_file_with_cache,
        download_remote_paths_with_cache, list_remote_entries_cached, read_remote_file_bytes,
        rename_remote_path_with_cache, upload_local_paths_with_cache,
        upload_remote_file_with_cache, write_remote_file_bytes,
    },
    FileTransferSummary,
};

// 远端文件命令属于阻塞 SFTP 适配器；所有公开入口都使用 async 命令调度，避免网络往返冻结 Tauri 主线程。
#[tauri::command(async)]
pub fn list_remote_files(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<Vec<RemoteFileEntry>, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    list_remote_entries_cached(&state, &connection, &path).map_err(Into::into)
}

#[tauri::command(async)]
pub fn upload_remote_file(
    state: State<'_, AppState>,
    connection_id: String,
    remote_dir: String,
    file_name: String,
    content_base64: String,
) -> Result<bool, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    let bytes = STANDARD
        .decode(content_base64)
        .map_err(|error| AppError::Validation(format!("invalid upload payload: {error}")))?;
    // 上传复用当前辅助 SFTP 连接，避免一次传输重复握手导致远端连接抖动。
    upload_remote_file_with_cache(&state, &connection, &remote_dir, &file_name, &bytes)?;
    Ok(true)
}

#[tauri::command(async)]
pub fn upload_local_paths(
    state: State<'_, AppState>,
    connection_id: String,
    remote_dir: String,
    local_paths: Vec<String>,
) -> Result<FileTransferSummary, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    Ok(upload_local_paths_with_cache(
        &state,
        &connection,
        &remote_dir,
        &local_paths,
    )?)
}

#[tauri::command(async)]
pub fn download_remote_file(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<String, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    Ok(download_remote_file_with_cache(&state, &connection, &path)?)
}

#[tauri::command(async)]
pub fn download_remote_paths(
    state: State<'_, AppState>,
    connection_id: String,
    paths: Vec<String>,
    local_dir: Option<String>,
) -> Result<FileTransferSummary, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    Ok(download_remote_paths_with_cache(
        &state,
        &connection,
        &paths,
        local_dir.as_deref(),
    )?)
}

#[tauri::command(async)]
pub fn delete_remote_path(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<bool, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    delete_remote_path_with_cache(&state, &connection, &path)?;
    Ok(true)
}

// 批量删除只建立一次辅助会话，逐项完成后由前端统一刷新目录。
#[tauri::command(async)]
pub fn delete_remote_paths(
    state: State<'_, AppState>,
    connection_id: String,
    paths: Vec<String>,
) -> Result<bool, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    delete_remote_paths_with_cache(&state, &connection, &paths)?;
    Ok(true)
}

// 远端内部复制在服务器侧完成，避免大目录经客户端中转。
#[tauri::command(async)]
pub fn copy_remote_paths(
    state: State<'_, AppState>,
    connection_id: String,
    sources: Vec<String>,
    target_dir: String,
) -> Result<bool, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    copy_remote_paths_with_cache(&state, &connection, &sources, &target_dir)?;
    Ok(true)
}

#[tauri::command(async)]
pub fn rename_remote_path(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
    new_path: String,
) -> Result<bool, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    rename_remote_path_with_cache(&state, &connection, &path, &new_path)?;
    Ok(true)
}

// 编辑器优先读取远端；仅网络类失败允许回退缓存，确定性的文件超限必须直接反馈给用户。
#[tauri::command(async)]
pub fn load_editor_document(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<EditorDocument, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    let bytes = match read_remote_file_bytes(&state, &connection, &path) {
        Ok(bytes) => bytes,
        Err(error @ AppError::Validation(_)) => return Err(error.into()),
        Err(error) => {
            if let Some(mut cached) = state.storage.load_editor_cache(&connection_id, &path)? {
                cached.dirty = true;
                return Ok(cached);
            }
            return Err(error.into());
        }
    };
    let document = EditorDocument {
        connection_id,
        path: path.clone(),
        content: String::from_utf8_lossy(&bytes).into_owned(),
        language: detect_language(&path),
        dirty: false,
    };
    state.storage.save_editor_cache(&document)?;
    Ok(document)
}

#[tauri::command(async)]
pub fn save_editor_document(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
    content: String,
) -> Result<bool, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    write_remote_file_bytes(&state, &connection, &path, content.as_bytes())?;

    let document = EditorDocument {
        connection_id,
        path: path.clone(),
        content,
        language: detect_language(&path),
        dirty: false,
    };
    state.storage.save_editor_cache(&document)?;
    Ok(true)
}
