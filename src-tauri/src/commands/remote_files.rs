use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};

use crate::{
    error::AppError,
    models::{EditorDocument, RemoteFileEntry},
    state::AppState,
};

use super::{
    detect_language, ensure_connection_exists,
    remote_access::{
        copy_remote_paths_with_cache, create_remote_entry_with_cache,
        delete_remote_path_with_cache, delete_remote_paths_with_cache,
        download_remote_file_with_cache, download_remote_paths_with_cache,
        list_remote_entries_cached, read_remote_file_bytes, rename_remote_path_with_cache,
        upload_local_paths_with_cache, upload_remote_file_with_cache, write_remote_file_bytes,
        SftpTransferProgressSnapshot,
    },
    FileTransferSummary,
};

const SFTP_TRANSFER_PROGRESS_EVENT: &str = "sftp-transfer-progress";
const SFTP_PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const SFTP_PROGRESS_EMIT_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SftpTransferProgressEvent {
    transfer_id: String,
    direction: String,
    phase: String,
    transferred_bytes: u64,
    total_bytes: u64,
    files: usize,
    directories: usize,
}

// 命令层进度发射器每个复制分片都检查取消，但只按时间/字节阈值通知 WebView，避免高频 setState 抢占终端渲染。
struct SftpTransferProgressEmitter {
    app: AppHandle,
    transfer_id: String,
    direction: String,
    cancellation: Arc<AtomicBool>,
    last_phase: &'static str,
    last_emitted_bytes: u64,
    last_emitted_at: Instant,
}

impl SftpTransferProgressEmitter {
    fn new(
        app: AppHandle,
        transfer_id: String,
        direction: &str,
        cancellation: Arc<AtomicBool>,
    ) -> Self {
        Self {
            app,
            transfer_id,
            direction: direction.to_string(),
            cancellation,
            last_phase: "",
            last_emitted_bytes: 0,
            last_emitted_at: Instant::now() - SFTP_PROGRESS_EMIT_INTERVAL,
        }
    }

    fn report(&mut self, snapshot: SftpTransferProgressSnapshot) -> Result<(), AppError> {
        if self.cancellation.load(Ordering::Acquire) {
            return Err(AppError::Validation("SFTP transfer cancelled".into()));
        }

        let phase_changed = self.last_phase != snapshot.phase;
        let byte_threshold_reached = snapshot
            .transferred_bytes
            .saturating_sub(self.last_emitted_bytes)
            >= SFTP_PROGRESS_EMIT_BYTES;
        let time_threshold_reached = self.last_emitted_at.elapsed() >= SFTP_PROGRESS_EMIT_INTERVAL;
        let completed = snapshot.total_bytes > 0
            && snapshot.transferred_bytes >= snapshot.total_bytes
            && self.last_emitted_bytes < snapshot.total_bytes;
        if !phase_changed && !byte_threshold_reached && !time_threshold_reached && !completed {
            return Ok(());
        }

        let payload = SftpTransferProgressEvent {
            transfer_id: self.transfer_id.clone(),
            direction: self.direction.clone(),
            phase: snapshot.phase.to_string(),
            transferred_bytes: snapshot.transferred_bytes,
            total_bytes: snapshot.total_bytes,
            files: snapshot.files,
            directories: snapshot.directories,
        };
        // WebView 临时重载或已经关闭时不应反向中断正在进行的文件传输。
        let _ = self.app.emit(SFTP_TRANSFER_PROGRESS_EVENT, payload);
        self.last_phase = snapshot.phase;
        self.last_emitted_bytes = snapshot.transferred_bytes;
        self.last_emitted_at = Instant::now();
        Ok(())
    }
}

// 注册任务时拒绝重复 ID，完成后由命令入口统一移除，保证取消表不会随历史任务增长。
fn register_sftp_transfer(
    state: &AppState,
    transfer_id: &str,
) -> Result<Arc<AtomicBool>, AppError> {
    let normalized_id = transfer_id.trim();
    if normalized_id.is_empty() {
        return Err(AppError::Validation("SFTP transfer id is required".into()));
    }
    let mut transfers = state
        .sftp_transfer_cancellations
        .lock()
        .map_err(|_| AppError::Validation("SFTP transfer registry is unavailable".into()))?;
    if transfers.contains_key(normalized_id) {
        return Err(AppError::Validation(format!(
            "SFTP transfer already exists: {normalized_id}"
        )));
    }
    let cancellation = Arc::new(AtomicBool::new(false));
    transfers.insert(normalized_id.to_string(), Arc::clone(&cancellation));
    Ok(cancellation)
}

fn unregister_sftp_transfer(state: &AppState, transfer_id: &str) {
    if let Ok(mut transfers) = state.sftp_transfer_cancellations.lock() {
        transfers.remove(transfer_id.trim());
    }
}

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
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    remote_dir: String,
    local_paths: Vec<String>,
    transfer_id: String,
) -> Result<FileTransferSummary, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    let cancellation = register_sftp_transfer(&state, &transfer_id)?;
    let mut emitter =
        SftpTransferProgressEmitter::new(app, transfer_id.clone(), "upload", cancellation);
    let result =
        upload_local_paths_with_cache(&state, &connection, &remote_dir, &local_paths, |snapshot| {
            emitter.report(snapshot)
        });
    unregister_sftp_transfer(&state, &transfer_id);
    Ok(result?)
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
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    paths: Vec<String>,
    local_dir: Option<String>,
    transfer_id: String,
) -> Result<FileTransferSummary, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    let cancellation = register_sftp_transfer(&state, &transfer_id)?;
    let mut emitter =
        SftpTransferProgressEmitter::new(app, transfer_id.clone(), "download", cancellation);
    let result = download_remote_paths_with_cache(
        &state,
        &connection,
        &paths,
        local_dir.as_deref(),
        |snapshot| emitter.report(snapshot),
    );
    unregister_sftp_transfer(&state, &transfer_id);
    Ok(result?)
}

// 取消命令只翻转原子标记，不能等待辅助 SFTP 锁，否则长传输期间按钮会失去响应。
#[tauri::command]
pub fn cancel_sftp_transfer(
    state: State<'_, AppState>,
    transfer_id: String,
) -> Result<bool, String> {
    let transfers = state
        .sftp_transfer_cancellations
        .lock()
        .map_err(|_| AppError::Validation("SFTP transfer registry is unavailable".into()))?;
    if let Some(cancellation) = transfers.get(transfer_id.trim()) {
        cancellation.store(true, Ordering::Release);
        return Ok(true);
    }
    Ok(false)
}

// 空白区右键新建统一进入后端校验；同名目标存在时明确失败，禁止静默覆盖。
#[tauri::command(async)]
pub fn create_remote_entry(
    state: State<'_, AppState>,
    connection_id: String,
    remote_dir: String,
    name: String,
    is_directory: bool,
) -> Result<String, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    Ok(create_remote_entry_with_cache(
        &state,
        &connection,
        &remote_dir,
        &name,
        is_directory,
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
