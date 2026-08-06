//! Agent Bridge 远端文件子域。
//! 负责只读浏览、文本/二进制读取、审批后的写入，以及本地与远端之间的递归批量传输。

use std::{
    collections::HashSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use ssh2::Sftp;

use crate::{
    commands::connect_ssh, crypto::CryptoService, error::AppError, models::RemoteFileEntry,
    storage::StorageService,
};

use super::{
    connection_for_session, request_download_paths, request_upload_paths, AgentBridgeRuntime,
    AgentFileReadResult, AgentFileTransferResult, AgentSession, FileDownloadRequest,
    FilePathRequest, FileRenameRequest, FileUploadRequest, FileWriteRequest,
};

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

#[derive(Default)]
struct AgentTransferStats {
    files: usize,
    directories: usize,
    bytes: u64,
}

fn normalize_remote_path(path: &str) -> String {
    let normalized = path.trim().replace('\\', "/");
    if normalized.is_empty() {
        ".".into()
    } else {
        normalized
    }
}

fn remote_file_name(path: &str) -> Option<String> {
    normalize_remote_path(path)
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn sanitize_local_file_name(name: &str, fallback: &str) -> String {
    let sanitized = name
        .chars()
        .map(|character| {
            // Windows 下载目标不能包含这些保留字符；替换后仍保留原文件的大致可识别名称。
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>()
        .trim_matches(|character| matches!(character, ' ' | '.'))
        .to_string();
    if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized
    }
}

fn normalize_remote_relative_path(path: &str) -> Result<String, AppError> {
    let normalized = normalize_remote_path(path).trim_matches('/').to_string();
    if normalized.is_empty() {
        return Err(AppError::Validation(
            "remote path segment is required".into(),
        ));
    }

    let parts = normalized.split('/').collect::<Vec<_>>();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return Err(AppError::Validation(
            "remote relative path contains invalid segments".into(),
        ));
    }
    Ok(parts.join("/"))
}

fn resolve_agent_remote_path(sftp: &Sftp, path: &str) -> Result<String, AppError> {
    let normalized = normalize_remote_path(path);
    if normalized == "." || normalized == "~" {
        return sftp
            .realpath(Path::new("."))
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .map_err(|error| AppError::Ssh(error.to_string()));
    }

    if let Some(suffix) = normalized.strip_prefix("~/") {
        let home = sftp
            .realpath(Path::new("."))
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .map_err(|error| AppError::Ssh(error.to_string()))?;
        return Ok(join_remote_path(&home, suffix));
    }

    Ok(normalized)
}

fn resolve_agent_remote_dir(
    sftp: &Sftp,
    session: &AgentSession,
    remote_dir: Option<&str>,
) -> Result<String, AppError> {
    let requested = remote_dir.unwrap_or(&session.cwd);
    resolve_agent_remote_path(sftp, requested)
}

fn remote_parent_path(path: &str) -> Option<String> {
    let normalized = normalize_remote_path(path);
    let trimmed = normalized.trim_end_matches('/');
    let (parent, _) = trimmed.rsplit_once('/')?;
    if parent.is_empty() && trimmed.starts_with('/') {
        Some("/".into())
    } else if parent.is_empty() {
        Some(".".into())
    } else {
        Some(parent.to_string())
    }
}

fn ensure_remote_directory(sftp: &Sftp, path: &str) -> Result<(), AppError> {
    let normalized = normalize_remote_path(path);
    let trimmed = normalized.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == "/" {
        return Ok(());
    }

    let mut current = if trimmed.starts_with('/') {
        "/".to_string()
    } else {
        String::new()
    };
    for part in trimmed
        .trim_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
    {
        if part == "." {
            continue;
        }
        if part == ".." {
            return Err(AppError::Validation(
                "remote directory cannot contain ..".into(),
            ));
        }

        current = if current.is_empty() {
            part.to_string()
        } else if current == "/" {
            format!("/{part}")
        } else {
            format!("{current}/{part}")
        };

        match sftp.stat(Path::new(&current)) {
            Ok(stat) if stat_is_dir(&stat) => continue,
            Ok(_) => {
                return Err(AppError::Validation(format!(
                    "remote path {current} exists and is not a directory"
                )))
            }
            Err(_) => sftp
                .mkdir(Path::new(&current), 0o755)
                .map_err(|error| AppError::Ssh(error.to_string()))?,
        }
    }

    Ok(())
}

fn upload_local_file_to_remote(
    sftp: &Sftp,
    local_path: &Path,
    remote_path: &str,
    stats: &mut AgentTransferStats,
) -> Result<(), AppError> {
    if let Some(parent) = remote_parent_path(remote_path) {
        ensure_remote_directory(sftp, &parent)?;
    }

    let mut local_file = fs::File::open(local_path)?;
    let mut remote_file = sftp
        .create(Path::new(remote_path))
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    let copied = std::io::copy(&mut local_file, &mut remote_file)?;
    remote_file.flush()?;
    stats.files += 1;
    stats.bytes = stats.bytes.saturating_add(copied);
    Ok(())
}

fn upload_local_directory_to_remote(
    sftp: &Sftp,
    local_dir: &Path,
    remote_dir: &str,
    stats: &mut AgentTransferStats,
) -> Result<(), AppError> {
    ensure_remote_directory(sftp, remote_dir)?;
    stats.directories += 1;
    for entry in fs::read_dir(local_dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let local_child = entry.path();
        let child_name = entry.file_name().to_string_lossy().to_string();
        let remote_child =
            join_remote_path(remote_dir, &normalize_remote_relative_path(&child_name)?);

        if file_type.is_dir() {
            upload_local_directory_to_remote(sftp, &local_child, &remote_child, stats)?;
        } else if file_type.is_file() {
            upload_local_file_to_remote(sftp, &local_child, &remote_child, stats)?;
        }
        // 本地符号链接和特殊文件不上传，避免把链接目标或设备文件误传到远端。
    }
    Ok(())
}

fn download_remote_file_to_local(
    sftp: &Sftp,
    remote_path: &str,
    local_path: &Path,
    stats: &mut AgentTransferStats,
) -> Result<(), AppError> {
    if let Some(parent) = local_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut remote_file = sftp
        .open(Path::new(remote_path))
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    let mut local_file = fs::File::create(local_path)?;
    let copied = std::io::copy(&mut remote_file, &mut local_file)?;
    local_file.flush()?;
    stats.files += 1;
    stats.bytes = stats.bytes.saturating_add(copied);
    Ok(())
}

fn download_remote_directory_to_local(
    sftp: &Sftp,
    remote_dir: &str,
    local_dir: &Path,
    stats: &mut AgentTransferStats,
) -> Result<(), AppError> {
    fs::create_dir_all(local_dir)?;
    stats.directories += 1;
    let entries = sftp
        .readdir(Path::new(remote_dir))
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    for (entry_path, stat) in entries {
        let Some(name) = entry_path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if name == "." || name == ".." {
            continue;
        }

        let remote_child = entry_path.to_string_lossy().replace('\\', "/");
        let local_child = local_dir.join(sanitize_local_file_name(name, "item"));
        let target_stat = if stat_is_symlink(&stat) {
            sftp.stat(&entry_path).ok()
        } else {
            None
        };
        let is_directory = target_stat
            .as_ref()
            .map(stat_is_dir)
            .unwrap_or_else(|| stat_is_dir(&stat));

        if is_directory && !stat_is_symlink(&stat) {
            download_remote_directory_to_local(sftp, &remote_child, &local_child, stats)?;
        } else if !(stat_is_symlink(&stat) && is_directory) {
            // 符号链接目录不递归跟随，避免远端循环链接导致下载无限展开。
            download_remote_file_to_local(sftp, &remote_child, &local_child, stats)?;
        }
    }
    Ok(())
}

fn collect_upload_sources(payload: &FileUploadRequest) -> Result<Vec<PathBuf>, AppError> {
    let mut seen = HashSet::new();
    let mut sources = Vec::new();
    for path in request_upload_paths(payload) {
        let source = PathBuf::from(&path);
        // 批量参数可能由 MCP 客户端合并生成，按字符串去重即可避免重复上传同一路径。
        if seen.insert(source.to_string_lossy().to_string()) {
            sources.push(source);
        }
    }

    if sources.is_empty() {
        return Err(AppError::Validation(
            "localPath or localPaths is required".into(),
        ));
    }
    Ok(sources)
}

fn collect_download_sources(payload: &FileDownloadRequest) -> Result<Vec<String>, AppError> {
    let mut seen = HashSet::new();
    let mut sources = Vec::new();
    for path in request_download_paths(payload) {
        // 远端路径先按用户输入去重，后续仍会经过 resolve_agent_remote_path 处理 ~ 和相对路径。
        if seen.insert(path.clone()) {
            sources.push(path);
        }
    }

    if sources.is_empty() {
        return Err(AppError::Validation("path or paths is required".into()));
    }
    Ok(sources)
}

fn unique_agent_local_destination(destination: PathBuf, used: &mut HashSet<PathBuf>) -> PathBuf {
    if !destination.exists() && used.insert(destination.clone()) {
        return destination;
    }

    let parent = destination
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(PathBuf::new);
    let stem = destination
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let extension = destination.extension().and_then(|value| value.to_str());

    // 批量下载同名文件/文件夹时追加 Windows 常见的 " (n)" 后缀，避免覆盖用户已有内容。
    for index in 1..10_000 {
        let file_name = if let Some(extension) = extension {
            format!("{stem} ({index}).{extension}")
        } else {
            format!("{stem} ({index})")
        };
        let candidate = parent.join(file_name);
        if !candidate.exists() && used.insert(candidate.clone()) {
            return candidate;
        }
    }

    destination
}

pub(super) fn upload_agent_path(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    payload: &FileUploadRequest,
) -> Result<AgentFileTransferResult, AppError> {
    let (session, connection) =
        connection_for_session(runtime, storage, crypto, &payload.session_id)?;
    let local_sources = collect_upload_sources(payload)?;
    if local_sources.len() > 1
        && payload
            .remote_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some()
    {
        return Err(AppError::Validation(
            "remotePath only supports a single localPath; use remoteDir for batch upload".into(),
        ));
    }

    let ssh_session = connect_ssh(&connection)?;
    let sftp = ssh_session
        .sftp()
        .map_err(|error| AppError::Ssh(error.to_string()))?;

    let explicit_remote_path = payload
        .remote_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let resolved_remote_dir = if explicit_remote_path.is_none() {
        Some(resolve_agent_remote_dir(
            &sftp,
            &session,
            payload.remote_dir.as_deref(),
        )?)
    } else {
        None
    };

    let mut stats = AgentTransferStats::default();
    let mut source_paths = Vec::new();
    let mut destination_paths = Vec::new();
    for local_source in local_sources {
        let metadata = fs::symlink_metadata(&local_source)?;
        let remote_destination = if let Some(remote_path) = explicit_remote_path {
            resolve_agent_remote_path(&sftp, remote_path)?
        } else {
            let source_name = local_source
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| AppError::Validation("local path must have a file name".into()))?;
            let remote_dir = resolved_remote_dir
                .as_deref()
                .ok_or_else(|| AppError::Validation("remoteDir is unavailable".into()))?;
            join_remote_path(&remote_dir, &normalize_remote_relative_path(source_name)?)
        };

        if metadata.is_dir() {
            upload_local_directory_to_remote(
                &sftp,
                &local_source,
                &remote_destination,
                &mut stats,
            )?;
        } else if metadata.is_file() {
            upload_local_file_to_remote(&sftp, &local_source, &remote_destination, &mut stats)?;
        } else {
            return Err(AppError::Validation(
                "local path must be a file or directory".into(),
            ));
        }

        source_paths.push(local_source.to_string_lossy().to_string());
        destination_paths.push(remote_destination);
    }

    Ok(AgentFileTransferResult {
        session_id: payload.session_id.clone(),
        source_path: source_paths.first().cloned().unwrap_or_default(),
        destination_path: destination_paths.first().cloned().unwrap_or_default(),
        source_paths,
        destination_paths,
        files: stats.files,
        directories: stats.directories,
        bytes: stats.bytes,
    })
}

pub(super) fn download_agent_path(
    runtime: &AgentBridgeRuntime,
    storage: &StorageService,
    crypto: &CryptoService,
    payload: &FileDownloadRequest,
) -> Result<AgentFileTransferResult, AppError> {
    let (_session, connection) =
        connection_for_session(runtime, storage, crypto, &payload.session_id)?;
    let requested_sources = collect_download_sources(payload)?;
    let is_batch_download = requested_sources.len() > 1;
    if requested_sources.len() > 1
        && payload
            .local_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some()
    {
        return Err(AppError::Validation(
            "localPath only supports a single path; use localDir for batch download".into(),
        ));
    }

    let ssh_session = connect_ssh(&connection)?;
    let sftp = ssh_session
        .sftp()
        .map_err(|error| AppError::Ssh(error.to_string()))?;

    let explicit_local_path = payload
        .local_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let base_dir = if explicit_local_path.is_none() {
        Some(
            payload
                .local_dir
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| storage.downloads_dir_path()),
        )
    } else {
        None
    };

    let mut stats = AgentTransferStats::default();
    let mut used_destinations = HashSet::new();
    let mut source_paths = Vec::new();
    let mut destination_paths = Vec::new();
    for requested_source in requested_sources {
        let remote_source = resolve_agent_remote_path(&sftp, &requested_source)?;
        let remote_stat = sftp
            .stat(Path::new(&remote_source))
            .map_err(|error| AppError::Ssh(error.to_string()))?;

        let mut local_destination = if let Some(local_path) = explicit_local_path {
            PathBuf::from(local_path)
        } else {
            let base_dir = base_dir
                .as_ref()
                .ok_or_else(|| AppError::Validation("localDir is unavailable".into()))?;
            let name = remote_file_name(&remote_source).unwrap_or_else(|| "download".into());
            base_dir.join(sanitize_local_file_name(&name, "download"))
        };
        if explicit_local_path.is_none() && is_batch_download {
            local_destination =
                unique_agent_local_destination(local_destination, &mut used_destinations);
        }

        if stat_is_dir(&remote_stat) {
            download_remote_directory_to_local(
                &sftp,
                &remote_source,
                &local_destination,
                &mut stats,
            )?;
        } else {
            download_remote_file_to_local(&sftp, &remote_source, &local_destination, &mut stats)?;
        }

        source_paths.push(remote_source);
        destination_paths.push(local_destination.to_string_lossy().to_string());
    }

    Ok(AgentFileTransferResult {
        session_id: payload.session_id.clone(),
        source_path: source_paths.first().cloned().unwrap_or_default(),
        destination_path: destination_paths.first().cloned().unwrap_or_default(),
        source_paths,
        destination_paths,
        files: stats.files,
        directories: stats.directories,
        bytes: stats.bytes,
    })
}

fn delete_agent_path_with_sftp(sftp: &Sftp, path: &str) -> Result<(), AppError> {
    let stat = sftp
        .lstat(Path::new(path))
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    if stat_is_symlink(&stat) {
        sftp.unlink(Path::new(path))
            .map_err(|error| AppError::Ssh(error.to_string()))?;
    } else if stat_is_dir(&stat) {
        // SFTP rmdir 只接受空目录；MCP 删除目录同样先递归清空，保持和界面文件管理一致。
        let entries = sftp
            .readdir(Path::new(path))
            .map_err(|error| AppError::Ssh(error.to_string()))?;
        for (entry_path, _entry_stat) in entries {
            let Some(name) = entry_path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if name == "." || name == ".." {
                continue;
            }

            let child_path = entry_path.to_string_lossy().replace('\\', "/");
            delete_agent_path_with_sftp(sftp, &child_path)?;
        }
        sftp.rmdir(Path::new(path))
            .map_err(|error| AppError::Ssh(error.to_string()))?;
    } else {
        sftp.unlink(Path::new(path))
            .map_err(|error| AppError::Ssh(error.to_string()))?;
    }

    Ok(())
}

pub(super) fn write_agent_file(
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
    let remote_path = resolve_agent_remote_path(&sftp, &payload.path)?;
    let bytes = if let Some(content) = &payload.content {
        content.as_bytes().to_vec()
    } else if let Some(content_base64) = &payload.content_base64 {
        STANDARD
            .decode(content_base64)
            .map_err(|error| AppError::Validation(format!("invalid base64 content: {error}")))?
    } else {
        Vec::new()
    };
    if let Some(parent) = remote_parent_path(&remote_path) {
        ensure_remote_directory(&sftp, &parent)?;
    }
    let mut file = sftp
        .create(Path::new(&remote_path))
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    file.write_all(&bytes)?;
    Ok(())
}

pub(super) fn delete_agent_file(
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
    let remote_path = resolve_agent_remote_path(&sftp, &payload.path)?;
    delete_agent_path_with_sftp(&sftp, &remote_path)
}

pub(super) fn rename_agent_file(
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
    let remote_path = resolve_agent_remote_path(&sftp, &payload.path)?;
    let new_remote_path = resolve_agent_remote_path(&sftp, &payload.new_path)?;
    sftp.rename(Path::new(&remote_path), Path::new(&new_remote_path), None)
        .map_err(|error| AppError::Ssh(error.to_string()))?;
    Ok(())
}

pub(super) fn mkdir_agent_file(
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
    // MCP mkdir 支持多级目录，便于文件夹上传前由外部工具显式准备目标路径。
    let remote_path = resolve_agent_remote_path(&sftp, &payload.path)?;
    ensure_remote_directory(&sftp, &remote_path)?;
    Ok(())
}

fn join_remote_path(remote_dir: &str, file_name: &str) -> String {
    let base = normalize_remote_path(remote_dir);
    let name = normalize_remote_path(file_name)
        .trim_matches('/')
        .to_string();
    if base.is_empty() || base == "." {
        name
    } else if base == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", base.trim_end_matches('/'), name)
    }
}

fn stat_is_dir(stat: &ssh2::FileStat) -> bool {
    // SFTP perm 使用 POSIX mode 位；Windows 端 libc 不一定暴露这些常量，因此这里固定使用协议语义值。
    const S_IFMT: u32 = 0o170000;
    const S_IFDIR: u32 = 0o040000;
    stat.perm
        .map(|perm| (perm & S_IFMT) == S_IFDIR)
        .unwrap_or(false)
}

fn stat_is_symlink(stat: &ssh2::FileStat) -> bool {
    // 符号链接同样通过 POSIX mode 判断，避免平台条件编译影响远端文件识别。
    const S_IFMT: u32 = 0o170000;
    const S_IFLNK: u32 = 0o120000;
    stat.perm
        .map(|perm| (perm & S_IFMT) == S_IFLNK)
        .unwrap_or(false)
}
