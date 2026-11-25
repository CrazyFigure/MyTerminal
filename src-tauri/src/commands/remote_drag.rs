//! 远端文件/目录向桌面与本地资源管理器拖出下载的适配器。
//! Windows 下通过 Win32 OLE `DoDragDrop` 提供虚拟文件描述符（`CFSTR_FILEDESCRIPTORW` +
//! `CFSTR_FILECONTENTS`）与异步传输能力（`IDataObjectAsyncCapability`），让资源管理器在释放
//! 鼠标后于后台流式拉取远端文件并保留完整目录树，同时复用现有传输进度与取消机制。

use std::{
    collections::HashSet,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
};

use chrono::DateTime;
use ssh2::{Session, Sftp};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    error::AppError,
    models::ConnectionProfile,
    state::AppState,
};

use super::{
    connect_ssh, ensure_connection_exists,
    remote_access::{
        normalize_remote_path, remote_file_name, sanitize_local_file_name, stat_is_dir,
        stat_is_symlink, SftpTransferProgressSnapshot,
    },
    remote_files::{
        register_sftp_transfer, unregister_sftp_transfer, SftpTransferProgressEmitter,
    },
    AUXILIARY_IO_TIMEOUT,
};

const SFTP_DRAG_DOWNLOAD_STATE_EVENT: &str = "sftp-drag-download-state";
/// 单个 FILETIME 秒与 Unix 纪元（1970-01-01）相对 Windows 纪元（1601-01-01）的秒差。
const WINDOWS_TO_UNIX_EPOCH_SECS: i64 = 11_644_473_600;
const FILETIME_TICKS_PER_SEC: i64 = 10_000_000;
/// `FILEDESCRIPTORW::cFileName` 固定长度为 260 UTF-16 单元，保留末尾 NUL 后最多 259 个码元。
const MAX_WINDOWS_DESCRIPTOR_UTF16_LEN: usize = 259;

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDragEntryInput {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub is_symlink: Option<bool>,
    pub size: u64,
    pub modified_at: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDragOutcome {
    pub dropped: bool,
    pub started_async: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SftpDragDownloadStateEvent {
    transfer_id: String,
    title: String,
    status: &'static str,
    message: Option<String>,
}

/// 供 `CFSTR_FILEDESCRIPTORW` 与 `CFSTR_FILECONTENTS` 使用的扁平化远端条目描述。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RemoteDragDescriptor {
    pub remote_path: String,
    pub relative_path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime_secs: Option<i64>,
}

/// 解析 RFC3339 时间字符串为 Unix 秒时间戳，用于填充下载文件的写入时间。
pub(crate) fn parse_rfc3339_unix_seconds(value: Option<&str>) -> Option<i64> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }
    DateTime::parse_from_rfc3339(trimmed)
        .ok()
        .map(|dt| dt.timestamp())
}

/// 将 Unix 秒时间戳转为 Windows `FILETIME` 100ns 计数（早于 1601 年返回 None）。
pub(crate) fn unix_seconds_to_filetime_ticks(unix_secs: i64) -> Option<u64> {
    let adjusted = unix_secs.checked_add(WINDOWS_TO_UNIX_EPOCH_SECS)?;
    if adjusted < 0 {
        return None;
    }
    (adjusted as u64).checked_mul(FILETIME_TICKS_PER_SEC as u64)
}

/// 在同一父目录下为清洗后的文件名做大小写无关去重，防止远端大小写差异文件在 Windows 落盘冲突。
pub(crate) fn dedupe_sibling_name(raw_name: &str, used_lower: &mut HashSet<String>) -> String {
    let sanitized = sanitize_local_file_name(raw_name, "item");
    if used_lower.insert(sanitized.to_ascii_lowercase()) {
        return sanitized;
    }

    let path = Path::new(&sanitized);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("item");
    let extension = path.extension().and_then(|value| value.to_str());

    for index in 1..10_000 {
        let candidate = if let Some(ext) = extension {
            format!("{stem} ({index}).{ext}")
        } else {
            format!("{stem} ({index})")
        };
        if used_lower.insert(candidate.to_ascii_lowercase()) {
            return candidate;
        }
    }

    sanitized
}

/// 组装 Windows 虚拟文件描述符相对路径并校验 UTF-16 长度上限，防止路径被悄悄截断。
pub(crate) fn join_windows_relative_path(
    parent_relative: &str,
    child_name: &str,
) -> Result<String, AppError> {
    let relative = if parent_relative.is_empty() {
        child_name.to_string()
    } else {
        format!("{parent_relative}\\{child_name}")
    };
    if relative.encode_utf16().count() > MAX_WINDOWS_DESCRIPTOR_UTF16_LEN {
        return Err(AppError::Validation(format!(
            "dragged path exceeds Windows descriptor length limit: {relative}"
        )));
    }
    Ok(relative)
}

/// 当所有拖出项都是普通文件（非目录、非符号链接）时，直接用前端列表信息构造描述符，无需悬停阶段握手。
pub(crate) fn build_descriptors_without_sftp(
    entries: &[RemoteDragEntryInput],
) -> Result<Option<Vec<RemoteDragDescriptor>>, AppError> {
    if entries.is_empty()
        || entries
            .iter()
            .any(|entry| entry.is_dir || entry.is_symlink.unwrap_or(false))
    {
        return Ok(None);
    }

    let mut used_names = HashSet::new();
    let mut descriptors = Vec::with_capacity(entries.len());
    for entry in entries {
        let remote_path = normalize_remote_path(&entry.path);
        let fallback_name = remote_file_name(&remote_path).unwrap_or_else(|| "download".into());
        let raw_name = if entry.name.trim().is_empty() {
            fallback_name
        } else {
            entry.name.trim().to_string()
        };
        let safe_name = dedupe_sibling_name(&raw_name, &mut used_names);
        let relative_path = join_windows_relative_path("", &safe_name)?;
        descriptors.push(RemoteDragDescriptor {
            remote_path,
            relative_path,
            name: safe_name,
            is_dir: false,
            size: entry.size,
            mtime_secs: parse_rfc3339_unix_seconds(entry.modified_at.as_deref()),
        });
    }

    Ok(Some(descriptors))
}

/// 含目录或符号链接时通过 SFTP 递归展开所有子目录和文件，保持与批量下载一致的符号链接防循环策略。
pub(crate) fn collect_drag_descriptors_with_sftp<F>(
    sftp: &Sftp,
    entries: &[RemoteDragEntryInput],
    on_scan: &mut F,
) -> Result<Vec<RemoteDragDescriptor>, AppError>
where
    F: FnMut(u64, usize, usize) -> Result<(), AppError>,
{
    let mut descriptors = Vec::new();
    let mut used_top_names = HashSet::new();
    let mut total_bytes = 0_u64;
    let mut file_count = 0_usize;
    let mut dir_count = 0_usize;

    for entry in entries {
        let remote_path = normalize_remote_path(&entry.path);
        let fallback_name = remote_file_name(&remote_path).unwrap_or_else(|| "download".into());
        let raw_name = if entry.name.trim().is_empty() {
            fallback_name
        } else {
            entry.name.trim().to_string()
        };
        let safe_name = dedupe_sibling_name(&raw_name, &mut used_top_names);
        collect_remote_drag_node(
            sftp,
            &remote_path,
            "",
            &safe_name,
            &mut descriptors,
            &mut total_bytes,
            &mut file_count,
            &mut dir_count,
            on_scan,
        )?;
    }

    Ok(descriptors)
}

#[allow(clippy::too_many_arguments)]
fn collect_remote_drag_node<F>(
    sftp: &Sftp,
    remote_path: &str,
    parent_relative: &str,
    safe_name: &str,
    descriptors: &mut Vec<RemoteDragDescriptor>,
    total_bytes: &mut u64,
    file_count: &mut usize,
    dir_count: &mut usize,
    on_scan: &mut F,
) -> Result<(), AppError>
where
    F: FnMut(u64, usize, usize) -> Result<(), AppError>,
{
    on_scan(*total_bytes, *file_count, *dir_count)?;
    let remote_ref = Path::new(remote_path);
    let link_stat = sftp
        .lstat(remote_ref)
        .map_err(super::ssh_error)?;
    let target_stat = if stat_is_symlink(&link_stat) {
        Some(sftp.stat(remote_ref).map_err(super::ssh_error)?)
    } else {
        None
    };
    let effective_stat = target_stat.as_ref().unwrap_or(&link_stat);
    let is_directory = stat_is_dir(effective_stat);
    if stat_is_symlink(&link_stat) && is_directory {
        return Err(AppError::Validation(
            "remote directory symlinks cannot be dragged recursively".into(),
        ));
    }

    let relative_path = join_windows_relative_path(parent_relative, safe_name)?;
    let mtime_secs = effective_stat.mtime.map(|value| value as i64);

    if is_directory {
        *dir_count += 1;
        descriptors.push(RemoteDragDescriptor {
            remote_path: remote_path.to_string(),
            relative_path: relative_path.clone(),
            name: safe_name.to_string(),
            is_dir: true,
            size: 0,
            mtime_secs,
        });

        let mut used_children = HashSet::new();
        let children = sftp.readdir(remote_ref).map_err(super::ssh_error)?;
        for (child_path, child_stat) in children {
            let Some(child_name) = child_path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if child_name == "." || child_name == ".." {
                continue;
            }
            let child_remote = child_path.to_string_lossy().replace('\\', "/");
            let child_target = if stat_is_symlink(&child_stat) {
                sftp.stat(&child_path).ok()
            } else {
                None
            };
            let child_effective = child_target.as_ref().unwrap_or(&child_stat);
            let child_is_dir = stat_is_dir(child_effective);
            // 文件夹内部遇到目录符号链接直接跳过，避免循环链接导致无限展开。
            if stat_is_symlink(&child_stat) && child_is_dir {
                continue;
            }
            let safe_child = dedupe_sibling_name(child_name, &mut used_children);
            collect_remote_drag_node(
                sftp,
                &child_remote,
                &relative_path,
                &safe_child,
                descriptors,
                total_bytes,
                file_count,
                dir_count,
                on_scan,
            )?;
        }
    } else {
        let file_size = effective_stat.size.unwrap_or(0);
        *file_count += 1;
        *total_bytes = total_bytes.saturating_add(file_size);
        descriptors.push(RemoteDragDescriptor {
            remote_path: remote_path.to_string(),
            relative_path,
            name: safe_name.to_string(),
            is_dir: false,
            size: file_size,
            mtime_secs,
        });
    }

    Ok(())
}

/// 远端拖出下载入口：在桌面端调起系统原生拖拽会话并等待释放后返回。
#[tauri::command(async)]
pub async fn start_remote_file_drag(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    entries: Vec<RemoteDragEntryInput>,
    transfer_id: String,
    title: String,
) -> Result<RemoteDragOutcome, String> {
    if entries.is_empty() {
        return Err(AppError::Validation("at least one remote entry is required".into()).into());
    }
    let connection = ensure_connection_exists(&state, &connection_id)?;

    #[cfg(windows)]
    {
        windows_ole::start_drag(app, connection, entries, transfer_id, title)
            .await
            .map_err(Into::into)
    }

    #[cfg(not(windows))]
    {
        let _ = (app, connection, entries, transfer_id, title);
        Ok(RemoteDragOutcome {
            dropped: false,
            started_async: false,
        })
    }
}

#[cfg(windows)]
mod windows_ole {
    use super::*;
    use std::{
        ffi::c_void,
        io::{Read, Seek, SeekFrom},
        mem::{size_of, ManuallyDrop},
        ptr,
        thread,
    };

    use windows::{
        core::{implement, BOOL, HRESULT, PWSTR},
        Win32::{
            Foundation::{
                DATA_S_SAMEFORMATETC, DRAGDROP_S_CANCEL, DRAGDROP_S_DROP,
                DRAGDROP_S_USEDEFAULTCURSORS, DV_E_FORMATETC, E_ABORT, E_FAIL, E_NOTIMPL,
                E_POINTER, FILETIME, HGLOBAL, OLE_E_ADVISENOTSUPPORTED, STG_E_INVALIDFUNCTION,
                S_FALSE, S_OK,
            },
            Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL},
            System::{
                Com::{
                    CoTaskMemAlloc, IAdviseSink, IBindCtx, IDataObject, IDataObject_Impl,
                    IEnumFORMATETC, IEnumSTATDATA, ISequentialStream_Impl, IStream, IStream_Impl,
                    DATADIR_GET, DVASPECT_CONTENT, FORMATETC, LOCKTYPE, STATFLAG,
                    STATFLAG_NONAME, STATSTG, STGC, STGMEDIUM, STGMEDIUM_0, STREAM_SEEK,
                    STREAM_SEEK_CUR, STREAM_SEEK_END, STREAM_SEEK_SET, STGTY_STREAM,
                    TYMED_HGLOBAL, TYMED_ISTREAM,
                },
                DataExchange::RegisterClipboardFormatW,
                Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT},
                Ole::{DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, OleUninitialize, ReleaseStgMedium, DROPEFFECT, DROPEFFECT_COPY},
                SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS},
            },
            UI::Shell::{
                IDataObjectAsyncCapability, IDataObjectAsyncCapability_Impl,
                SHCreateStdEnumFmtEtc, CFSTR_FILECONTENTS, CFSTR_FILEDESCRIPTORW, FD_ATTRIBUTES,
                FD_FILESIZE, FD_PROGRESSUI, FD_UNICODE, FD_WRITESTIME, FILEDESCRIPTORW,
            },
        },
    };

    const SFTP_STREAM_CHUNK_BYTES: usize = 64 * 1024;
    const COPYENGINE_E_USER_CANCELLED: HRESULT = HRESULT(0x8027_0000_u32 as i32);

    struct OpenWorkerFile {
        item_index: usize,
        file: ssh2::File,
        offset: u64,
    }

    enum WorkerCommand {
        ResolveDescriptors {
            entries: Vec<RemoteDragEntryInput>,
            reply: mpsc::Sender<Result<Vec<RemoteDragDescriptor>, AppError>>,
        },
        ReadChunk {
            item_index: usize,
            remote_path: String,
            max_bytes: usize,
            offset: u64,
            total_bytes: u64,
            total_files: usize,
            total_dirs: usize,
            reply: mpsc::Sender<Result<Vec<u8>, AppError>>,
        },
        Shutdown,
    }

    /// 跨 COM 线程与 SFTP 单线程工作器之间的共享协调状态。
    struct DragTransferShared {
        app: AppHandle,
        transfer_id: String,
        title: String,
        cancellation: Arc<AtomicBool>,
        entries: Vec<RemoteDragEntryInput>,
        descriptors: Mutex<Option<Vec<RemoteDragDescriptor>>>,
        summary: Mutex<(u64, usize, usize)>,
        started: AtomicBool,
        finished: AtomicBool,
        worker_tx: mpsc::Sender<WorkerCommand>,
    }

    impl DragTransferShared {
        fn new(
            app: AppHandle,
            connection: ConnectionProfile,
            entries: Vec<RemoteDragEntryInput>,
            transfer_id: String,
            title: String,
        ) -> Arc<Self> {
            let cancellation = Arc::new(AtomicBool::new(false));
            let (worker_tx, worker_rx) = mpsc::channel::<WorkerCommand>();
            spawn_drag_worker(
                app.clone(),
                connection,
                transfer_id.clone(),
                Arc::clone(&cancellation),
                worker_rx,
            );

            Arc::new(Self {
                app,
                transfer_id,
                title,
                cancellation,
                entries,
                descriptors: Mutex::new(None),
                summary: Mutex::new((0, 0, 0)),
                started: AtomicBool::new(false),
                finished: AtomicBool::new(false),
                worker_tx,
            })
        }

        fn ensure_started(&self) {
            if self.started.swap(true, Ordering::AcqRel) {
                return;
            }

            let state = self.app.state::<AppState>();
            if let Ok(token) = register_sftp_transfer(&state, &self.transfer_id) {
                if let Ok(mut guard) = state.sftp_transfer_cancellations.lock() {
                    guard.insert(self.transfer_id.clone(), Arc::clone(&self.cancellation));
                }
                let _ = token;
            }

            let _ = self.app.emit(
                SFTP_DRAG_DOWNLOAD_STATE_EVENT,
                SftpDragDownloadStateEvent {
                    transfer_id: self.transfer_id.clone(),
                    title: self.title.clone(),
                    status: "started",
                    message: None,
                },
            );
        }

        fn resolve_descriptors(&self) -> Result<Vec<RemoteDragDescriptor>, AppError> {
            {
                let guard = self
                    .descriptors
                    .lock()
                    .map_err(|_| AppError::Validation("drag descriptor cache poisoned".into()))?;
                if let Some(cached) = guard.as_ref() {
                    return Ok(cached.clone());
                }
            }

            let items = match build_descriptors_without_sftp(&self.entries)? {
                Some(fast_items) => fast_items,
                None => {
                    let (reply_tx, reply_rx) = mpsc::channel();
                    self.worker_tx
                        .send(WorkerCommand::ResolveDescriptors {
                            entries: self.entries.clone(),
                            reply: reply_tx,
                        })
                        .map_err(|_| AppError::Validation("drag transfer worker exited".into()))?;
                    reply_rx
                        .recv()
                        .map_err(|_| AppError::Validation("drag transfer worker dropped reply".into()))??
                }
            };

            let total_bytes = items.iter().filter(|item| !item.is_dir).map(|item| item.size).sum();
            let total_files = items.iter().filter(|item| !item.is_dir).count();
            let total_dirs = items.iter().filter(|item| item.is_dir).count();
            if let Ok(mut summary) = self.summary.lock() {
                *summary = (total_bytes, total_files, total_dirs);
            }

            let mut guard = self
                .descriptors
                .lock()
                .map_err(|_| AppError::Validation("drag descriptor cache poisoned".into()))?;
            if let Some(cached) = guard.as_ref() {
                return Ok(cached.clone());
            }
            *guard = Some(items.clone());
            Ok(items)
        }

        fn totals(&self) -> (u64, usize, usize) {
            self.summary.lock().map(|guard| *guard).unwrap_or((0, 0, 0))
        }

        fn read_chunk(
            &self,
            item_index: usize,
            remote_path: &str,
            offset: u64,
            max_bytes: usize,
        ) -> Result<Vec<u8>, AppError> {
            if self.cancellation.load(Ordering::Acquire) {
                return Err(AppError::Validation("SFTP transfer cancelled".into()));
            }
            let (total_bytes, total_files, total_dirs) = self.totals();
            let (reply_tx, reply_rx) = mpsc::channel();
            self.worker_tx
                .send(WorkerCommand::ReadChunk {
                    item_index,
                    remote_path: remote_path.to_string(),
                    max_bytes,
                    offset,
                    total_bytes,
                    total_files,
                    total_dirs,
                    reply: reply_tx,
                })
                .map_err(|_| AppError::Validation("drag transfer worker exited".into()))?;
            reply_rx
                .recv()
                .map_err(|_| AppError::Validation("drag transfer worker dropped reply".into()))?
        }

        fn finish(&self, hresult: HRESULT) {
            if self.finished.swap(true, Ordering::AcqRel) {
                return;
            }
            let _ = self.worker_tx.send(WorkerCommand::Shutdown);

            if !self.started.load(Ordering::Acquire) {
                return;
            }

            let state = self.app.state::<AppState>();
            unregister_sftp_transfer(&state, &self.transfer_id);

            let cancelled = self.cancellation.load(Ordering::Acquire)
                || hresult == E_ABORT
                || hresult == COPYENGINE_E_USER_CANCELLED;
            let (status, message) = if cancelled {
                ("cancelled", None)
            } else if hresult.is_ok() {
                ("completed", None)
            } else {
                (
                    "error",
                    Some(format!("Windows copy failed (0x{:08x})", hresult.0 as u32)),
                )
            };

            let _ = self.app.emit(
                SFTP_DRAG_DOWNLOAD_STATE_EVENT,
                SftpDragDownloadStateEvent {
                    transfer_id: self.transfer_id.clone(),
                    title: self.title.clone(),
                    status,
                    message,
                },
            );
        }
    }

    /// 为拖出工作线程按需建立并复用独占的 SFTP 会话。
    fn ensure_worker_sftp<'a>(
        pair: &'a mut Option<(Session, Sftp)>,
        connection: &ConnectionProfile,
    ) -> Result<&'a Sftp, AppError> {
        if pair.is_none() {
            let session = connect_ssh(connection)?;
            session.set_timeout(AUXILIARY_IO_TIMEOUT.as_millis() as u32);
            let sftp = session.sftp().map_err(super::super::ssh_error)?;
            *pair = Some((session, sftp));
        }
        Ok(&pair.as_ref().expect("sftp initialized").1)
    }

    /// 独占一条 SFTP 会话的串行后台工作线程，避免把非线程安全的 `ssh2::File` 跨 COM 线程传递。
    fn spawn_drag_worker(
        app: AppHandle,
        connection: ConnectionProfile,
        transfer_id: String,
        cancellation: Arc<AtomicBool>,
        rx: mpsc::Receiver<WorkerCommand>,
    ) {
        thread::spawn(move || {
            let mut session_pair: Option<(Session, Sftp)> = None;
            let mut open_file: Option<OpenWorkerFile> = None;
            let mut transferred_bytes = 0_u64;
            let mut emitter =
                SftpTransferProgressEmitter::new(app, transfer_id, "download", Arc::clone(&cancellation));

            while let Ok(command) = rx.recv() {
                match command {
                    WorkerCommand::ResolveDescriptors { entries, reply } => {
                        let result = ensure_worker_sftp(&mut session_pair, &connection).and_then(|sftp| {
                            collect_drag_descriptors_with_sftp(
                                sftp,
                                &entries,
                                &mut |total_bytes, files, directories| {
                                    emitter.report(SftpTransferProgressSnapshot {
                                        phase: "preparing",
                                        transferred_bytes: 0,
                                        total_bytes,
                                        files,
                                        directories,
                                    })
                                },
                            )
                        });
                        let _ = reply.send(result);
                    }
                    WorkerCommand::ReadChunk {
                        item_index,
                        remote_path,
                        max_bytes,
                        offset,
                        total_bytes,
                        total_files,
                        total_dirs,
                        reply,
                    } => {
                        let result = (|| -> Result<Vec<u8>, AppError> {
                            if cancellation.load(Ordering::Acquire) {
                                return Err(AppError::Validation("SFTP transfer cancelled".into()));
                            }
                            let sftp = ensure_worker_sftp(&mut session_pair, &connection)?;
                            let needs_open = open_file
                                .as_ref()
                                .is_none_or(|current| current.item_index != item_index);
                            if needs_open {
                                open_file = None;
                                let file = sftp
                                    .open(Path::new(&remote_path))
                                    .map_err(super::super::ssh_error)?;
                                open_file = Some(OpenWorkerFile {
                                    item_index,
                                    file,
                                    offset: 0,
                                });
                            }

                            let active = open_file.as_mut().expect("open file ready");
                            if active.offset != offset {
                                if active.file.seek(SeekFrom::Start(offset)).is_err() {
                                    let mut reopened = sftp
                                        .open(Path::new(&remote_path))
                                        .map_err(super::super::ssh_error)?;
                                    if offset > 0 {
                                        reopened.seek(SeekFrom::Start(offset))?;
                                    }
                                    active.file = reopened;
                                }
                                active.offset = offset;
                            }

                            let target_len = max_bytes.min(SFTP_STREAM_CHUNK_BYTES * 8);
                            let mut output = Vec::with_capacity(target_len);
                            let mut buffer = [0_u8; SFTP_STREAM_CHUNK_BYTES];
                            while output.len() < target_len {
                                emitter.report(SftpTransferProgressSnapshot {
                                    phase: "transferring",
                                    transferred_bytes,
                                    total_bytes,
                                    files: total_files,
                                    directories: total_dirs,
                                })?;
                                let to_read = (target_len - output.len()).min(buffer.len());
                                let read = active.file.read(&mut buffer[..to_read])?;
                                if read == 0 {
                                    break;
                                }
                                output.extend_from_slice(&buffer[..read]);
                                active.offset = active.offset.saturating_add(read as u64);
                                transferred_bytes = transferred_bytes.saturating_add(read as u64);
                            }

                            emitter.report(SftpTransferProgressSnapshot {
                                phase: "transferring",
                                transferred_bytes,
                                total_bytes,
                                files: total_files,
                                directories: total_dirs,
                            })?;
                            Ok(output)
                        })();
                        let _ = reply.send(result);
                    }
                    WorkerCommand::Shutdown => {
                        // 先释放文件句柄再释放 SFTP/Session，避免析构顺序倒挂。
                        drop(open_file.take());
                        drop(session_pair.take());
                        break;
                    }
                }
            }
        });
    }

    #[implement(IDropSource)]
    struct RemoteFilesDropSource;

    impl IDropSource_Impl for RemoteFilesDropSource_Impl {
        fn QueryContinueDrag(
            &self,
            fescapepressed: BOOL,
            grfkeystate: MODIFIERKEYS_FLAGS,
        ) -> HRESULT {
            if fescapepressed.as_bool() {
                return DRAGDROP_S_CANCEL;
            }
            if (grfkeystate.0 & MK_LBUTTON.0) == 0 {
                return DRAGDROP_S_DROP;
            }
            S_OK
        }

        fn GiveFeedback(&self, _dweffect: DROPEFFECT) -> HRESULT {
            DRAGDROP_S_USEDEFAULTCURSORS
        }
    }

    #[implement(IStream)]
    struct RemoteFileStream {
        item_index: usize,
        remote_path: String,
        name: String,
        file_size: u64,
        mtime: FILETIME,
        offset: Mutex<u64>,
        shared: Arc<DragTransferShared>,
    }

    impl ISequentialStream_Impl for RemoteFileStream_Impl {
        fn Read(&self, pv: *mut c_void, cb: u32, pcbread: *mut u32) -> HRESULT {
            if pv.is_null() {
                return E_POINTER;
            }
            if !pcbread.is_null() {
                unsafe { *pcbread = 0 };
            }
            if cb == 0 {
                return S_OK;
            }

            let Ok(mut offset_guard) = self.offset.lock() else {
                return E_FAIL;
            };
            if *offset_guard >= self.file_size {
                return S_FALSE;
            }

            let remaining = (self.file_size - *offset_guard).min(cb as u64) as usize;
            let chunk = match self.shared.read_chunk(
                self.item_index,
                &self.remote_path,
                *offset_guard,
                remaining,
            ) {
                Ok(bytes) => bytes,
                Err(_) if self.shared.cancellation.load(Ordering::Acquire) => return E_ABORT,
                Err(_) => return E_FAIL,
            };

            let read_len = chunk.len().min(cb as usize);
            if read_len > 0 {
                unsafe {
                    ptr::copy_nonoverlapping(chunk.as_ptr(), pv as *mut u8, read_len);
                }
                *offset_guard = offset_guard.saturating_add(read_len as u64);
            }
            if !pcbread.is_null() {
                unsafe { *pcbread = read_len as u32 };
            }
            if read_len == cb as usize {
                S_OK
            } else {
                S_FALSE
            }
        }

        fn Write(&self, _pv: *const c_void, _cb: u32, _pcbwritten: *mut u32) -> HRESULT {
            STG_E_INVALIDFUNCTION
        }
    }

    impl IStream_Impl for RemoteFileStream_Impl {
        fn Seek(
            &self,
            dlibmove: i64,
            dworigin: STREAM_SEEK,
            plibnewposition: *mut u64,
        ) -> windows_core::Result<()> {
            let mut offset_guard = self.offset.lock().map_err(|_| E_FAIL)?;
            let base: i128 = match dworigin {
                STREAM_SEEK_SET => 0,
                STREAM_SEEK_CUR => *offset_guard as i128,
                STREAM_SEEK_END => self.file_size as i128,
                _ => return Err(STG_E_INVALIDFUNCTION.into()),
            };
            let next = base + dlibmove as i128;
            if next < 0 {
                return Err(STG_E_INVALIDFUNCTION.into());
            }
            *offset_guard = next as u64;
            if !plibnewposition.is_null() {
                unsafe { *plibnewposition = *offset_guard };
            }
            Ok(())
        }

        fn SetSize(&self, _libnewsize: u64) -> windows_core::Result<()> {
            Err(STG_E_INVALIDFUNCTION.into())
        }

        fn CopyTo(
            &self,
            _pstm: windows_core::Ref<'_, IStream>,
            _cb: u64,
            _pcbread: *mut u64,
            _pcbwritten: *mut u64,
        ) -> windows_core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn Commit(&self, _grfcommitflags: &STGC) -> windows_core::Result<()> {
            Ok(())
        }

        fn Revert(&self) -> windows_core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn LockRegion(&self, _liboffset: u64, _cb: u64, _dwlocktype: &LOCKTYPE) -> windows_core::Result<()> {
            Err(STG_E_INVALIDFUNCTION.into())
        }

        fn UnlockRegion(&self, _liboffset: u64, _cb: u64, _dwlocktype: u32) -> windows_core::Result<()> {
            Err(STG_E_INVALIDFUNCTION.into())
        }

        fn Stat(&self, pstatstg: *mut STATSTG, grfstatflag: &STATFLAG) -> windows_core::Result<()> {
            if pstatstg.is_null() {
                return Err(E_POINTER.into());
            }
            let mut stat = STATSTG {
                r#type: STGTY_STREAM.0 as u32,
                cbSize: self.file_size,
                mtime: self.mtime,
                ..Default::default()
            };
            if (grfstatflag.0 & STATFLAG_NONAME.0) == 0 {
                let wide: Vec<u16> = self.name.encode_utf16().chain(std::iter::once(0)).collect();
                let byte_len = wide.len() * size_of::<u16>();
                let ptr = unsafe { CoTaskMemAlloc(byte_len) } as *mut u16;
                if !ptr.is_null() {
                    unsafe { ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len()) };
                    stat.pwcsName = PWSTR(ptr);
                }
            }
            unsafe { *pstatstg = stat };
            Ok(())
        }

        fn Clone(&self) -> windows_core::Result<IStream> {
            Err(E_NOTIMPL.into())
        }
    }

    #[implement(IDataObject, IDataObjectAsyncCapability)]
    struct RemoteFilesDataObject {
        cf_file_descriptor_w: u16,
        cf_file_contents: u16,
        shared: Arc<DragTransferShared>,
        async_mode: AtomicBool,
        in_operation: AtomicBool,
        extra_data: Mutex<Vec<(u16, STGMEDIUM)>>,
    }

    impl RemoteFilesDataObject {
        fn new(shared: Arc<DragTransferShared>) -> Self {
            let cf_file_descriptor_w = unsafe { RegisterClipboardFormatW(CFSTR_FILEDESCRIPTORW) } as u16;
            let cf_file_contents = unsafe { RegisterClipboardFormatW(CFSTR_FILECONTENTS) } as u16;
            Self {
                cf_file_descriptor_w,
                cf_file_contents,
                shared,
                async_mode: AtomicBool::new(true),
                in_operation: AtomicBool::new(false),
                extra_data: Mutex::new(Vec::new()),
            }
        }

        fn build_file_group_descriptor_hglobal(
            &self,
            descriptors: &[RemoteDragDescriptor],
        ) -> windows_core::Result<HGLOBAL> {
            let header_size = size_of::<u32>();
            let item_size = size_of::<FILEDESCRIPTORW>();
            let total_size = header_size + descriptors.len() * item_size;
            let hglobal = unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, total_size) }?;
            let lock_ptr = unsafe { GlobalLock(hglobal) } as *mut u8;
            if lock_ptr.is_null() {
                return Err(E_FAIL.into());
            }

            unsafe {
                let count = descriptors.len() as u32;
                ptr::copy_nonoverlapping(&count as *const u32 as *const u8, lock_ptr, header_size);
                let items_ptr = lock_ptr.add(header_size) as *mut FILEDESCRIPTORW;
                for (index, item) in descriptors.iter().enumerate() {
                    let fd = descriptor_to_win32(item);
                    ptr::write_unaligned(items_ptr.add(index), fd);
                }
                let _ = GlobalUnlock(hglobal);
            }
            Ok(hglobal)
        }
    }

    impl Drop for RemoteFilesDataObject {
        fn drop(&mut self) {
            if let Ok(mut items) = self.extra_data.lock() {
                for (_, mut medium) in items.drain(..) {
                    unsafe { ReleaseStgMedium(&mut medium) };
                }
            }
            if !self.in_operation.load(Ordering::Acquire) {
                self.shared.finish(S_OK);
            }
        }
    }

    fn descriptor_to_win32(item: &RemoteDragDescriptor) -> FILEDESCRIPTORW {
        let mut fd = FILEDESCRIPTORW::default();
        let mut flags = FD_ATTRIBUTES.0 | FD_UNICODE.0;
        fd.dwFileAttributes = if item.is_dir {
            FILE_ATTRIBUTE_DIRECTORY.0
        } else {
            flags |= FD_FILESIZE.0 | FD_PROGRESSUI.0;
            fd.nFileSizeHigh = (item.size >> 32) as u32;
            fd.nFileSizeLow = item.size as u32;
            FILE_ATTRIBUTE_NORMAL.0
        };
        if let Some(ticks) = item.mtime_secs.and_then(unix_seconds_to_filetime_ticks) {
            flags |= FD_WRITESTIME.0;
            fd.ftLastWriteTime = FILETIME {
                dwLowDateTime: ticks as u32,
                dwHighDateTime: (ticks >> 32) as u32,
            };
        }
        fd.dwFlags = flags as u32;
        // 先在对齐的栈数组中编码 UTF-16 文件名，再整体赋值避免 packed 结构体未对齐引用。
        let mut file_name = [0_u16; 260];
        for (slot, unit) in file_name
            .iter_mut()
            .zip(item.relative_path.encode_utf16())
        {
            *slot = unit;
        }
        fd.cFileName = file_name;
        fd
    }

    fn ticks_to_filetime(mtime_secs: Option<i64>) -> FILETIME {
        match mtime_secs.and_then(unix_seconds_to_filetime_ticks) {
            Some(ticks) => FILETIME {
                dwLowDateTime: ticks as u32,
                dwHighDateTime: (ticks >> 32) as u32,
            },
            None => FILETIME::default(),
        }
    }

    fn clone_hglobal_medium(source: &STGMEDIUM) -> windows_core::Result<STGMEDIUM> {
        if (source.tymed & TYMED_HGLOBAL.0 as u32) == 0 {
            return Err(DV_E_FORMATETC.into());
        }
        let src_handle = unsafe { source.u.hGlobal };
        let size = unsafe { GlobalSize(src_handle) };
        if size == 0 {
            return Err(DV_E_FORMATETC.into());
        }
        let src_ptr = unsafe { GlobalLock(src_handle) } as *const u8;
        if src_ptr.is_null() {
            return Err(E_FAIL.into());
        }
        let dst_handle = unsafe { GlobalAlloc(GMEM_MOVEABLE, size) };
        let result = match dst_handle {
            Ok(dst) => {
                let dst_ptr = unsafe { GlobalLock(dst) } as *mut u8;
                if dst_ptr.is_null() {
                    Err(E_FAIL.into())
                } else {
                    unsafe {
                        ptr::copy_nonoverlapping(src_ptr, dst_ptr, size);
                        let _ = GlobalUnlock(dst);
                    }
                    Ok(STGMEDIUM {
                        tymed: TYMED_HGLOBAL.0 as u32,
                        u: STGMEDIUM_0 { hGlobal: dst },
                        pUnkForRelease: ManuallyDrop::new(None),
                    })
                }
            }
            Err(err) => Err(err),
        };
        unsafe {
            let _ = GlobalUnlock(src_handle);
        }
        result
    }

    impl IDataObject_Impl for RemoteFilesDataObject_Impl {
        fn GetData(&self, pformatetcin: *const FORMATETC) -> windows_core::Result<STGMEDIUM> {
            if pformatetcin.is_null() {
                return Err(E_POINTER.into());
            }
            let fmt = unsafe { &*pformatetcin };
            if fmt.dwAspect != DVASPECT_CONTENT.0 {
                return Err(DV_E_FORMATETC.into());
            }

            if fmt.cfFormat == self.cf_file_descriptor_w {
                if (fmt.tymed & TYMED_HGLOBAL.0 as u32) == 0 {
                    return Err(DV_E_FORMATETC.into());
                }
                let descriptors = self
                    .shared
                    .resolve_descriptors()
                    .map_err(|_| windows_core::Error::from(E_FAIL))?;
                let hglobal = self.build_file_group_descriptor_hglobal(&descriptors)?;
                return Ok(STGMEDIUM {
                    tymed: TYMED_HGLOBAL.0 as u32,
                    u: STGMEDIUM_0 { hGlobal: hglobal },
                    pUnkForRelease: ManuallyDrop::new(None),
                });
            }

            if fmt.cfFormat == self.cf_file_contents {
                if (fmt.tymed & TYMED_ISTREAM.0 as u32) == 0 || fmt.lindex < 0 {
                    return Err(DV_E_FORMATETC.into());
                }
                let descriptors = self
                    .shared
                    .resolve_descriptors()
                    .map_err(|_| windows_core::Error::from(E_FAIL))?;
                let index = fmt.lindex as usize;
                let Some(item) = descriptors.get(index) else {
                    return Err(DV_E_FORMATETC.into());
                };
                if item.is_dir {
                    return Err(DV_E_FORMATETC.into());
                }

                self.shared.ensure_started();
                let stream: IStream = RemoteFileStream {
                    item_index: index,
                    remote_path: item.remote_path.clone(),
                    name: item.name.clone(),
                    file_size: item.size,
                    mtime: ticks_to_filetime(item.mtime_secs),
                    offset: Mutex::new(0),
                    shared: Arc::clone(&self.shared),
                }
                .into();

                return Ok(STGMEDIUM {
                    tymed: TYMED_ISTREAM.0 as u32,
                    u: STGMEDIUM_0 {
                        pstm: ManuallyDrop::new(Some(stream)),
                    },
                    pUnkForRelease: ManuallyDrop::new(None),
                });
            }

            if let Ok(extra) = self.extra_data.lock() {
                if let Some((_, medium)) = extra.iter().find(|(cf, _)| *cf == fmt.cfFormat) {
                    return clone_hglobal_medium(medium);
                }
            }

            Err(DV_E_FORMATETC.into())
        }

        fn GetDataHere(
            &self,
            _pformatetc: *const FORMATETC,
            _pmedium: *mut STGMEDIUM,
        ) -> windows_core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
            if pformatetc.is_null() {
                return E_POINTER;
            }
            let fmt = unsafe { &*pformatetc };
            if fmt.dwAspect != DVASPECT_CONTENT.0 {
                return DV_E_FORMATETC;
            }
            if fmt.cfFormat == self.cf_file_descriptor_w
                && (fmt.tymed & TYMED_HGLOBAL.0 as u32) != 0
            {
                return S_OK;
            }
            if fmt.cfFormat == self.cf_file_contents
                && (fmt.tymed & TYMED_ISTREAM.0 as u32) != 0
            {
                return S_OK;
            }
            if let Ok(extra) = self.extra_data.lock() {
                if extra
                    .iter()
                    .any(|(cf, medium)| *cf == fmt.cfFormat && (medium.tymed & fmt.tymed) != 0)
                {
                    return S_OK;
                }
            }
            DV_E_FORMATETC
        }

        fn GetCanonicalFormatEtc(
            &self,
            _pformatectin: *const FORMATETC,
            pformatetcout: *mut FORMATETC,
        ) -> HRESULT {
            if !pformatetcout.is_null() {
                unsafe { (*pformatetcout).ptd = ptr::null_mut() };
            }
            DATA_S_SAMEFORMATETC
        }

        fn SetData(
            &self,
            pformatetc: *const FORMATETC,
            pmedium: *const STGMEDIUM,
            frelease: BOOL,
        ) -> windows_core::Result<()> {
            if pformatetc.is_null() || pmedium.is_null() {
                return Err(E_POINTER.into());
            }
            if !frelease.as_bool() {
                return Err(E_NOTIMPL.into());
            }
            let fmt = unsafe { &*pformatetc };
            let medium = unsafe { (*pmedium).clone() };
            let mut extra = self.extra_data.lock().map_err(|_| E_FAIL)?;
            if let Some(pos) = extra.iter().position(|(cf, _)| *cf == fmt.cfFormat) {
                let (_, mut old) = extra.remove(pos);
                unsafe { ReleaseStgMedium(&mut old) };
            }
            extra.push((fmt.cfFormat, medium));
            Ok(())
        }

        fn EnumFormatEtc(&self, dwdirection: u32) -> windows_core::Result<IEnumFORMATETC> {
            if dwdirection != DATADIR_GET.0 as u32 {
                return Err(E_NOTIMPL.into());
            }
            let formats = [
                FORMATETC {
                    cfFormat: self.cf_file_descriptor_w,
                    ptd: ptr::null_mut(),
                    dwAspect: DVASPECT_CONTENT.0,
                    lindex: -1,
                    tymed: TYMED_HGLOBAL.0 as u32,
                },
                FORMATETC {
                    cfFormat: self.cf_file_contents,
                    ptd: ptr::null_mut(),
                    dwAspect: DVASPECT_CONTENT.0,
                    lindex: -1,
                    tymed: TYMED_ISTREAM.0 as u32,
                },
            ];
            unsafe { SHCreateStdEnumFmtEtc(&formats) }
        }

        fn DAdvise(
            &self,
            _pformatetc: *const FORMATETC,
            _advf: u32,
            _padvsink: windows_core::Ref<'_, IAdviseSink>,
        ) -> windows_core::Result<u32> {
            Err(OLE_E_ADVISENOTSUPPORTED.into())
        }

        fn DUnadvise(&self, _dwconnection: u32) -> windows_core::Result<()> {
            Err(OLE_E_ADVISENOTSUPPORTED.into())
        }

        fn EnumDAdvise(&self) -> windows_core::Result<IEnumSTATDATA> {
            Err(OLE_E_ADVISENOTSUPPORTED.into())
        }
    }

    impl IDataObjectAsyncCapability_Impl for RemoteFilesDataObject_Impl {
        fn SetAsyncMode(&self, fdoopasync: BOOL) -> windows_core::Result<()> {
            self.async_mode.store(fdoopasync.as_bool(), Ordering::Release);
            Ok(())
        }

        fn GetAsyncMode(&self) -> windows_core::Result<BOOL> {
            Ok(BOOL::from(self.async_mode.load(Ordering::Acquire)))
        }

        fn StartOperation(
            &self,
            _pbcreserved: windows_core::Ref<'_, IBindCtx>,
        ) -> windows_core::Result<()> {
            self.in_operation.store(true, Ordering::Release);
            self.shared.ensure_started();
            Ok(())
        }

        fn InOperation(&self) -> windows_core::Result<BOOL> {
            Ok(BOOL::from(self.in_operation.load(Ordering::Acquire)))
        }

        fn EndOperation(
            &self,
            hresult: HRESULT,
            _pbcreserved: windows_core::Ref<'_, IBindCtx>,
            _dweffects: u32,
        ) -> windows_core::Result<()> {
            self.in_operation.store(false, Ordering::Release);
            self.shared.finish(hresult);
            Ok(())
        }
    }

    pub async fn start_drag(
        app: AppHandle,
        connection: ConnectionProfile,
        entries: Vec<RemoteDragEntryInput>,
        transfer_id: String,
        title: String,
    ) -> Result<RemoteDragOutcome, AppError> {
        let (done_tx, done_rx) = mpsc::channel::<Result<RemoteDragOutcome, AppError>>();
        let dispatch_app = app.clone();
        app.run_on_main_thread(move || {
            let outcome = run_ole_drag_on_main_thread(
                dispatch_app,
                connection,
                entries,
                transfer_id,
                title,
            );
            let _ = done_tx.send(outcome);
        })
        .map_err(|error| AppError::Validation(format!("failed to schedule drag on UI thread: {error}")))?;

        tauri::async_runtime::spawn_blocking(move || {
            done_rx
                .recv()
                .map_err(|_| AppError::Validation("drag session interrupted".into()))?
        })
        .await
        .map_err(|error| AppError::Validation(format!("drag join error: {error}")))?
    }

    fn run_ole_drag_on_main_thread(
        app: AppHandle,
        connection: ConnectionProfile,
        entries: Vec<RemoteDragEntryInput>,
        transfer_id: String,
        title: String,
    ) -> Result<RemoteDragOutcome, AppError> {
        let ole_initialized = unsafe { OleInitialize(None) }.is_ok();
        let shared = DragTransferShared::new(app, connection, entries, transfer_id, title);
        let data_object: IDataObject = RemoteFilesDataObject::new(Arc::clone(&shared)).into();
        let drop_source: IDropSource = RemoteFilesDropSource.into();
        let async_cap: Option<IDataObjectAsyncCapability> =
            windows_core::Interface::cast(&data_object).ok();

        let mut effect = DROPEFFECT::default();
        let hr = unsafe { DoDragDrop(&data_object, &drop_source, DROPEFFECT_COPY, &mut effect) };

        let started_async = async_cap
            .as_ref()
            .and_then(|cap| unsafe { cap.InOperation().ok() })
            .is_some_and(|flag| flag.as_bool());

        // 若未进入异步后台复制（例如取消或由同步目标处理），释放前在此回收工作线程。
        if !started_async {
            shared.finish(if hr == DRAGDROP_S_DROP { S_OK } else { E_ABORT });
        }

        if ole_initialized {
            unsafe { OleUninitialize() };
        }

        Ok(RemoteDragOutcome {
            dropped: hr == DRAGDROP_S_DROP,
            started_async,
        })
    }

    #[cfg(test)]
    pub(super) fn file_group_descriptor_layout_size() -> (usize, usize) {
        use windows::Win32::UI::Shell::FILEGROUPDESCRIPTORW;
        (
            size_of::<FILEGROUPDESCRIPTORW>(),
            size_of::<u32>() + size_of::<FILEDESCRIPTORW>(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_file(path: &str, name: &str, size: u64) -> RemoteDragEntryInput {
        RemoteDragEntryInput {
            path: path.to_string(),
            name: name.to_string(),
            is_dir: false,
            is_symlink: Some(false),
            size,
            modified_at: Some("2026-06-15T08:30:00Z".to_string()),
        }
    }

    #[test]
    fn builds_fast_descriptors_for_regular_files_with_windows_sanitization() {
        let entries = vec![
            sample_file("/srv/report:1.txt", "report:1.txt", 128),
            sample_file("/srv/report_1.txt", "report_1.txt", 256),
        ];

        let descriptors = build_descriptors_without_sftp(&entries)
            .expect("should validate")
            .expect("files-only selection should skip SFTP scan");

        assert_eq!(descriptors.len(), 2);
        assert_eq!(descriptors[0].relative_path, "report_1.txt");
        assert_eq!(descriptors[0].size, 128);
        assert_eq!(descriptors[1].relative_path, "report_1 (1).txt");
        assert_eq!(descriptors[1].size, 256);
        assert!(descriptors[0].mtime_secs.is_some());
    }

    #[test]
    fn requires_sftp_scan_when_selection_contains_directory_or_symlink() {
        let mut dir = sample_file("/srv/logs", "logs", 0);
        dir.is_dir = true;
        let result = build_descriptors_without_sftp(&[dir]).expect("should succeed");
        assert!(result.is_none());

        let mut link = sample_file("/srv/latest", "latest", 0);
        link.is_symlink = Some(true);
        let result = build_descriptors_without_sftp(&[link]).expect("should succeed");
        assert!(result.is_none());
    }

    #[test]
    fn dedupes_case_insensitive_windows_sibling_names() {
        let mut used = HashSet::new();
        assert_eq!(dedupe_sibling_name("README.md", &mut used), "README.md");
        assert_eq!(dedupe_sibling_name("readme.md", &mut used), "readme (1).md");
        assert_eq!(dedupe_sibling_name("Readme.md", &mut used), "Readme (2).md");
    }

    #[test]
    fn rejects_overlong_windows_descriptor_relative_path() {
        let long_name = "a".repeat(MAX_WINDOWS_DESCRIPTOR_UTF16_LEN + 1);
        assert!(join_windows_relative_path("", &long_name).is_err());
        assert_eq!(
            join_windows_relative_path("folder", "child.txt").unwrap(),
            "folder\\child.txt"
        );
    }

    #[test]
    fn converts_unix_timestamp_to_windows_filetime_ticks() {
        // 1970-01-01T00:00:00Z 对应 11644473600 * 10^7 ticks
        assert_eq!(
            unix_seconds_to_filetime_ticks(0),
            Some(116_444_736_000_000_000)
        );
        assert_eq!(unix_seconds_to_filetime_ticks(-20_000_000_000), None);
        assert_eq!(parse_rfc3339_unix_seconds(Some("1970-01-01T00:00:00Z")), Some(0));
        assert_eq!(parse_rfc3339_unix_seconds(Some("invalid")), None);
    }

    #[cfg(windows)]
    #[test]
    fn win32_file_group_descriptor_layout_matches_packed_header_plus_item() {
        let (actual, expected) = windows_ole::file_group_descriptor_layout_size();
        assert_eq!(actual, expected);
    }
}
