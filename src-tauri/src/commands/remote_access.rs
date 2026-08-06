//! 辅助 SSH/SFTP 远程访问适配器。
//! 负责远程文件递归操作、Shell 历史解析以及系统/容器运行指标采集。

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    net::{Ipv4Addr, Ipv6Addr},
    path::{Path, PathBuf},
};

use chrono::{TimeZone, Utc};
use ssh2::{Session, Sftp};

use crate::{
    error::AppError,
    models::{
        ConnectionProfile, HistoryEntry, RemoteFileEntry, RuntimeConnectionItem,
        RuntimeConnectionList, RuntimeCpuCore, RuntimeOverview, RuntimeResourceUsage,
        RuntimeResourceUsageItem, RuntimeResourceUsageRequest, RuntimeStorageFileItem,
        RuntimeStorageFiles,
    },
    state::AppState,
};

use super::{
    auxiliary_identity_maps, auxiliary_sftp, ssh_error, with_auxiliary_session,
    with_auxiliary_session_once, FileTransferSummary,
};

// Linux/容器运行指标独立于 SFTP 文件传输；对命令层继续暴露原有缓存查询入口。
mod runtime_metrics;
pub(super) use runtime_metrics::{
    query_runtime_connection_list_cached, query_runtime_overview_cached,
    query_runtime_resource_usage_cached, query_runtime_storage_files_cached,
};
#[cfg(test)]
use runtime_metrics::{
    connection_list_command, decode_proc_net_address, parse_connection_counts,
    parse_connection_list, runtime_overview_command,
};

pub(super) fn normalize_remote_path(path: &str) -> String {
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
            // Windows 本地下载路径不能包含这些保留字符；远端文件名遇到它们时用下划线保留可落盘性。
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
        return Err(AppError::Validation("remote file name is required".into()));
    }

    // 上传相对路径只能表达目录结构，不能携带 . 或 .. 跳转，避免文件夹上传写出当前目标目录。
    let parts = normalized.split('/').collect::<Vec<_>>();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return Err(AppError::Validation(
            "remote upload path contains invalid segments".into(),
        ));
    }

    Ok(parts.join("/"))
}

fn join_remote_path(remote_dir: &str, file_name: &str) -> String {
    let base = normalize_remote_path(remote_dir);
    let name = normalize_remote_path(file_name)
        .trim_matches('/')
        .to_string();
    if base == "." || base.is_empty() {
        name
    } else if base == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", base.trim_end_matches('/'), name)
    }
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
            Err(_) => sftp.mkdir(Path::new(&current), 0o755).map_err(ssh_error)?,
        }
    }

    Ok(())
}

fn write_remote_file_with_sftp(
    sftp: &Sftp,
    remote_path: &str,
    bytes: &[u8],
) -> Result<(), AppError> {
    if let Some(parent) = remote_parent_path(remote_path) {
        ensure_remote_directory(sftp, &parent)?;
    }

    let mut remote_file = sftp.create(Path::new(remote_path)).map_err(ssh_error)?;
    remote_file.write_all(bytes).map_err(AppError::from)?;
    remote_file.flush().map_err(AppError::from)?;
    Ok(())
}

fn resolve_remote_dir(sftp: &Sftp, requested_path: &str) -> Result<String, AppError> {
    let trimmed = requested_path.trim();
    if trimmed.is_empty() || trimmed == "~" || trimmed == "." {
        return sftp
            .realpath(Path::new("."))
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .map_err(ssh_error);
    }

    Ok(normalize_remote_path(trimmed))
}

pub(super) fn stat_is_dir(stat: &ssh2::FileStat) -> bool {
    stat.perm
        .map(|perm| (perm & 0o170000) == 0o040000)
        .unwrap_or(false)
}

fn modified_at(stat: &ssh2::FileStat) -> Option<String> {
    let timestamp = stat.mtime? as i64;
    chrono::DateTime::<Utc>::from_timestamp(timestamp, 0).map(|value| value.to_rfc3339())
}

pub(super) fn stat_is_symlink(stat: &ssh2::FileStat) -> bool {
    stat.perm
        .map(|perm| (perm & 0o170000) == 0o120000)
        .unwrap_or(false)
}

// 递归删除属于 SFTP 适配器内部规则；符号链接只删链接本身，目录则先清空再 rmdir。
fn delete_remote_path_with_sftp(sftp: &Sftp, path: &str) -> Result<(), AppError> {
    let remote_path = normalize_remote_path(path);
    let stat = sftp.lstat(Path::new(&remote_path)).map_err(ssh_error)?;
    if stat_is_symlink(&stat) {
        sftp.unlink(Path::new(&remote_path)).map_err(ssh_error)?;
    } else if stat_is_dir(&stat) {
        for (entry_path, _entry_stat) in
            sftp.readdir(Path::new(&remote_path)).map_err(ssh_error)?
        {
            let Some(name) = entry_path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if name == "." || name == ".." {
                continue;
            }
            let child_path = entry_path.to_string_lossy().replace('\\', "/");
            delete_remote_path_with_sftp(sftp, &child_path)?;
        }
        sftp.rmdir(Path::new(&remote_path)).map_err(ssh_error)?;
    } else {
        sftp.unlink(Path::new(&remote_path)).map_err(ssh_error)?;
    }
    Ok(())
}

/// 将 SFTP mode 转为类似 ls -l 的权限文本，方便文件管理器按列展示。
fn format_permissions(stat: &ssh2::FileStat) -> Option<String> {
    let perm = stat.perm?;
    let kind = match perm & 0o170000 {
        0o040000 => 'd',
        0o120000 => 'l',
        0o100000 => '-',
        0o010000 => 'p',
        0o020000 => 'c',
        0o060000 => 'b',
        0o140000 => 's',
        _ => '-',
    };

    let mut value = String::with_capacity(10);
    value.push(kind);

    // 三组权限位按 owner/group/other 顺序转换，特殊位暂不展示，保持表格稳定可读。
    for bit in [
        0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001,
    ] {
        let symbol = match bit {
            0o400 | 0o040 | 0o004 => 'r',
            0o200 | 0o020 | 0o002 => 'w',
            _ => 'x',
        };
        value.push(if perm & bit != 0 { symbol } else { '-' });
    }

    Some(value)
}

/// 远端账号映射来自 passwd/group 文本，按 id 建索引用于把 SFTP 的 uid/gid 转成可读名称。
fn parse_identity_map(contents: &str, id_index: usize) -> HashMap<u32, String> {
    let mut identities = HashMap::new();

    for line in contents.lines() {
        let parts = line.split(':').collect::<Vec<_>>();
        if parts.len() <= id_index {
            continue;
        }

        let name = parts[0].trim();
        let Ok(id) = parts[id_index].trim().parse::<u32>() else {
            continue;
        };
        if !name.is_empty() {
            identities.insert(id, name.to_string());
        }
    }

    identities
}

/// SFTP 通常只返回数字 uid/gid；这里优先用远端账号表映射为名称，查不到再用数字兜底。
fn stat_owner_group(
    stat: &ssh2::FileStat,
    user_names: &HashMap<u32, String>,
    group_names: &HashMap<u32, String>,
) -> (Option<String>, Option<String>) {
    (
        stat.uid.map(|value| {
            user_names
                .get(&value)
                .cloned()
                .unwrap_or_else(|| value.to_string())
        }),
        stat.gid.map(|value| {
            group_names
                .get(&value)
                .cloned()
                .unwrap_or_else(|| value.to_string())
        }),
    )
}

/// 多项远端信息合并到一次 exec 后用标记分段解析，减少反复开 SSH channel 带来的刷新延迟。
fn parse_marked_sections(contents: &str) -> HashMap<String, String> {
    let mut sections = HashMap::new();
    let mut current_key: Option<String> = None;

    for line in contents.lines() {
        if let Some(key) = line
            .trim()
            .strip_prefix("__MYTERMINAL_")
            .and_then(|value| value.strip_suffix("__"))
        {
            current_key = Some(key.to_string());
            sections.entry(key.to_string()).or_insert_with(String::new);
            continue;
        }

        if let Some(key) = current_key.as_ref() {
            let section = sections.entry(key.clone()).or_insert_with(String::new);
            if !section.is_empty() {
                section.push('\n');
            }
            section.push_str(line);
        }
    }

    sections
        .into_iter()
        .map(|(key, value)| (key, value.trim().to_string()))
        .collect()
}

/// SFTP 文件属性不带用户名，文件管理刷新时额外读取一次远端账号表，失败时保持数字 uid/gid 兜底。
pub(super) fn load_remote_identity_maps(
    session: &Session,
) -> (HashMap<u32, String>, HashMap<u32, String>) {
    let sections = exec_remote_command(
        session,
        "sh -lc 'printf \"__MYTERMINAL_PASSWD__\\n\"; (getent passwd 2>/dev/null || cat /etc/passwd 2>/dev/null || true); printf \"\\n__MYTERMINAL_GROUP__\\n\"; (getent group 2>/dev/null || cat /etc/group 2>/dev/null || true)'",
    )
    .map(|contents| parse_marked_sections(&contents))
    .unwrap_or_default();

    let user_names = sections
        .get("PASSWD")
        .map(|contents| parse_identity_map(contents, 2))
        .unwrap_or_default();
    let group_names = sections
        .get("GROUP")
        .map(|contents| parse_identity_map(contents, 2))
        .unwrap_or_default();

    (user_names, group_names)
}

fn exec_remote_command(session: &Session, command: &str) -> Result<String, AppError> {
    let mut channel = session.channel_session().map_err(ssh_error)?;
    channel.exec(command).map_err(ssh_error)?;

    let mut output = String::new();
    channel.read_to_string(&mut output)?;

    let mut stderr = String::new();
    let _ = channel.stderr().read_to_string(&mut stderr);
    let _ = channel.wait_close();

    let trimmed = output.trim();
    if !trimmed.is_empty() {
        return Ok(trimmed.to_string());
    }

    let stderr_trimmed = stderr.trim();
    if !stderr_trimmed.is_empty() {
        return Err(AppError::Ssh(stderr_trimmed.to_string()));
    }

    Ok(String::new())
}

fn parse_history_timestamp(seconds: &str) -> Option<String> {
    let timestamp = seconds.trim().parse::<i64>().ok()?;
    Utc.timestamp_opt(timestamp, 0)
        .single()
        .map(|value| value.to_rfc3339())
}

fn parse_zsh_extended_history(line: &str) -> Option<(Option<String>, String)> {
    let rest = line.strip_prefix(": ")?;
    let (timestamp, remainder) = rest.split_once(':')?;
    let (_duration, command) = remainder.split_once(';')?;
    Some((parse_history_timestamp(timestamp), command.to_string()))
}

fn is_internal_history_command(command: &str) -> bool {
    let trimmed = command.trim();
    trimmed.contains("__myterminal_sync_") || trimmed.contains("MyTerminalCwd=")
}

fn parse_remote_history(connection_id: &str, contents: &str, limit: usize) -> Vec<HistoryEntry> {
    let mut entries = Vec::new();
    let mut pending_timestamp: Option<String> = None;

    for line in contents.lines() {
        let normalized_line = line.trim_end_matches('\r');
        if normalized_line.is_empty() {
            continue;
        }

        if let Some(timestamp) = normalized_line
            .strip_prefix('#')
            .and_then(parse_history_timestamp)
        {
            pending_timestamp = Some(timestamp);
            continue;
        }

        let (timestamp, command) = parse_zsh_extended_history(normalized_line)
            .unwrap_or_else(|| (pending_timestamp.take(), normalized_line.to_string()));
        pending_timestamp = None;

        let command = command.trim();
        if command.is_empty() || is_internal_history_command(command) {
            continue;
        }

        entries.push(HistoryEntry {
            id: uuid::Uuid::new_v4().to_string(),
            connection_id: Some(connection_id.to_string()),
            command: command.to_string(),
            // history 文件无时间戳时留空，前端据此显示占位符；不再回退到读取时刻，避免所有命令显示成同一刷新时间。
            executed_at: timestamp.unwrap_or_default(),
        });
    }

    // 远端历史文件按旧到新存储，界面历史列表沿用最新命令在上的展示顺序。
    entries.into_iter().rev().take(limit.max(1)).collect()
}

fn read_remote_shell_history_entries_with_session(
    connection: &ConnectionProfile,
    session: &Session,
    limit: usize,
) -> Result<Vec<HistoryEntry>, AppError> {
    let remote_limit = limit.clamp(1, 500);
    // 远端 history 是 shell 内置，独立 exec 不一定能读取交互会话内存；这里读取历史文件，
    // 并依赖交互 Shell 的 prompt 钩子先执行 history -a / fc -AI，把当前会话命令落盘。
    let command = format!(
        "sh -lc 'limit={remote_limit}; seen=\"\"; for file in \"${{HISTFILE:-}}\" \"$HOME/.zsh_history\" \"$HOME/.bash_history\"; do [ -n \"$file\" ] || continue; case \":$seen:\" in *:\"$file\":*) continue;; esac; seen=\"$seen:$file\"; [ -r \"$file\" ] || continue; tail -n \"$limit\" \"$file\" 2>/dev/null; done'"
    );
    let contents = exec_remote_command(session, &command)?;
    Ok(parse_remote_history(
        &connection.id,
        &contents,
        remote_limit,
    ))
}

fn list_remote_entries(
    sftp: &Sftp,
    requested_path: &str,
    user_names: &HashMap<u32, String>,
    group_names: &HashMap<u32, String>,
) -> Result<Vec<RemoteFileEntry>, AppError> {
    let remote_dir = resolve_remote_dir(sftp, requested_path)?;
    let mut entries = sftp
        .readdir(Path::new(&remote_dir))
        .map_err(ssh_error)?
        .into_iter()
        .filter_map(|(path, stat)| {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .map(|value| value.to_string())?;

            if name == "." || name == ".." {
                return None;
            }

            // 符号链接本身不是目录，但目标可能是目录；跟随 stat 成功时用目标类型决定能否进入。
            let is_symlink = stat_is_symlink(&stat);
            let target_stat = if is_symlink {
                sftp.stat(&path).ok()
            } else {
                None
            };
            let is_dir = target_stat
                .as_ref()
                .map(stat_is_dir)
                .unwrap_or_else(|| stat_is_dir(&stat));
            let (owner, group) = stat_owner_group(&stat, user_names, group_names);
            Some(RemoteFileEntry {
                name,
                path: path.to_string_lossy().replace('\\', "/"),
                is_dir,
                is_symlink,
                size: stat.size.unwrap_or(0),
                modified_at: modified_at(&stat),
                permissions: format_permissions(&stat),
                owner,
                group,
            })
        })
        .collect::<Vec<_>>();

    entries.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    Ok(entries)
}

/// 远程文件可直接进入 Monaco 编辑的字节上限。超过后拒绝加载并提示下载，避免大文件在
/// Rust/IPC/React/Monaco 中多份复制造成内存峰值和渲染阻塞。
const MAX_EDITABLE_FILE_BYTES: u64 = 10 * 1024 * 1024;

pub(super) fn read_remote_file_bytes(
    state: &AppState,
    connection: &ConnectionProfile,
    path: &str,
) -> Result<Vec<u8>, AppError> {
    with_auxiliary_session(state, connection, |auxiliary| {
        let sftp = auxiliary_sftp(auxiliary)?;
        let remote_path = normalize_remote_path(path);
        // 读取前先 stat 拿到文件大小，超过可编辑上限直接拒绝，避免把几十 MB 内容 read_to_end 后
        // 再经 IPC、React、Monaco 多份复制，导致峰值内存达到文件大小的数倍并阻塞渲染。
        // ponytail: 目前是单一硬上限（10 MiB 一刀切）。后续如需 2–10 MiB“只读预览/下载/强制打开”
        // 的分级交互，可在此返回大小元数据并由前端选择，而不是直接拒绝。
        if let Ok(stat) = sftp.stat(Path::new(&remote_path)) {
            if let Some(size) = stat.size {
                if size > MAX_EDITABLE_FILE_BYTES {
                    return Err(AppError::Validation(format!(
                        "文件大小 {:.1} MiB 超过编辑器上限 {} MiB，请下载后在本地打开。",
                        size as f64 / (1024.0 * 1024.0),
                        MAX_EDITABLE_FILE_BYTES / (1024 * 1024)
                    )));
                }
            }
        }
        let mut remote_file = sftp.open(Path::new(&remote_path)).map_err(ssh_error)?;
        let mut bytes = Vec::new();
        remote_file.read_to_end(&mut bytes)?;
        Ok(bytes)
    })
}

pub(super) fn write_remote_file_bytes(
    state: &AppState,
    connection: &ConnectionProfile,
    path: &str,
    bytes: &[u8],
) -> Result<(), AppError> {
    with_auxiliary_session_once(state, connection, |auxiliary| {
        let sftp = auxiliary_sftp(auxiliary)?;
        let remote_path = normalize_remote_path(path);
        write_remote_file_with_sftp(sftp, &remote_path, bytes)
    })
}

pub(super) fn list_remote_entries_cached(
    state: &AppState,
    connection: &ConnectionProfile,
    path: &str,
) -> Result<Vec<RemoteFileEntry>, AppError> {
    with_auxiliary_session(state, connection, |auxiliary| {
        let (user_names, group_names) = auxiliary_identity_maps(auxiliary);
        let sftp = auxiliary_sftp(auxiliary)?;
        list_remote_entries(sftp, path, &user_names, &group_names)
    })
}

pub(super) fn read_remote_shell_history_entries_cached(
    state: &AppState,
    connection: &ConnectionProfile,
    limit: usize,
) -> Result<Vec<HistoryEntry>, AppError> {
    with_auxiliary_session(state, connection, |auxiliary| {
        read_remote_shell_history_entries_with_session(connection, &auxiliary.session, limit)
    })
}

pub(super) fn upload_remote_file_with_cache(
    state: &AppState,
    connection: &ConnectionProfile,
    remote_dir: &str,
    file_name: &str,
    bytes: &[u8],
) -> Result<(), AppError> {
    with_auxiliary_session_once(state, connection, |auxiliary| {
        let sftp = auxiliary_sftp(auxiliary)?;
        let directory = resolve_remote_dir(sftp, remote_dir)?;
        let remote_name = normalize_remote_relative_path(file_name)?;
        let remote_path = join_remote_path(&directory, &remote_name);
        write_remote_file_with_sftp(sftp, &remote_path, bytes)
    })
}

pub(super) fn upload_local_paths_with_cache(
    state: &AppState,
    connection: &ConnectionProfile,
    remote_dir: &str,
    local_paths: &[String],
) -> Result<FileTransferSummary, AppError> {
    with_auxiliary_session_once(state, connection, |auxiliary| {
        let sftp = auxiliary_sftp(auxiliary)?;
        let directory = resolve_remote_dir(sftp, remote_dir)?;
        let mut summary = FileTransferSummary::default();

        // 桌面拖放会直接给本机路径；批量上传复用同一条 SFTP 连接，逐项创建远端根目录或文件。
        for local_path in local_paths
            .iter()
            .map(|path| path.trim())
            .filter(|path| !path.is_empty())
        {
            let source = PathBuf::from(local_path);
            let source_name = source
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| AppError::Validation(format!("invalid local path: {local_path}")))?;
            let remote_name = normalize_remote_relative_path(source_name)?;
            let remote_path = join_remote_path(&directory, &remote_name);
            upload_local_path_to_remote(sftp, &source, &remote_path, &mut summary)?;
            summary.destinations.push(remote_path);
        }

        Ok(summary)
    })
}

pub(super) fn download_remote_file_with_cache(
    state: &AppState,
    connection: &ConnectionProfile,
    path: &str,
) -> Result<String, AppError> {
    let downloads_dir = state.storage.downloads_dir_path();
    fs::create_dir_all(&downloads_dir)?;
    with_auxiliary_session_once(state, connection, |auxiliary| {
        let sftp = auxiliary_sftp(auxiliary)?;
        let remote_path = normalize_remote_path(path);
        let remote_stat = sftp.stat(Path::new(&remote_path)).map_err(ssh_error)?;
        let file_name = remote_file_name(&remote_path).unwrap_or_else(|| "download".into());
        let destination = downloads_dir.join(sanitize_local_file_name(&file_name, "download"));
        let mut summary = FileTransferSummary::default();
        if stat_is_dir(&remote_stat) {
            download_remote_directory_to_local(sftp, &remote_path, &destination, &mut summary)?;
        } else {
            download_remote_file_to_local(sftp, &remote_path, &destination, &mut summary)?;
        }

        Ok(destination.to_string_lossy().to_string())
    })
}

pub(super) fn download_remote_paths_with_cache(
    state: &AppState,
    connection: &ConnectionProfile,
    paths: &[String],
    local_dir: Option<&str>,
) -> Result<FileTransferSummary, AppError> {
    let base_dir = local_dir
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| state.storage.downloads_dir_path());
    fs::create_dir_all(&base_dir)?;

    with_auxiliary_session_once(state, connection, |auxiliary| {
        let sftp = auxiliary_sftp(auxiliary)?;
        let mut used_destinations = HashSet::new();
        let mut summary = FileTransferSummary::default();
        // 多路径下载只建立一次 SFTP 会话；同名文件自动追加序号，避免后下载项覆盖先下载项。
        for path in paths
            .iter()
            .map(|path| path.trim())
            .filter(|path| !path.is_empty())
        {
            let remote_path = normalize_remote_path(path);
            let file_name = remote_file_name(&remote_path).unwrap_or_else(|| "download".into());
            let destination = unique_local_destination(
                base_dir.join(sanitize_local_file_name(&file_name, "download")),
                &mut used_destinations,
            );
            download_remote_path_to_local(sftp, &remote_path, &destination, &mut summary)?;
            summary
                .destinations
                .push(destination.to_string_lossy().to_string());
        }

        Ok(summary)
    })
}

pub(super) fn delete_remote_path_with_cache(
    state: &AppState,
    connection: &ConnectionProfile,
    path: &str,
) -> Result<(), AppError> {
    with_auxiliary_session_once(state, connection, |auxiliary| {
        let sftp = auxiliary_sftp(auxiliary)?;
        delete_remote_path_with_sftp(sftp, path)
    })
}

pub(super) fn delete_remote_paths_with_cache(
    state: &AppState,
    connection: &ConnectionProfile,
    paths: &[String],
) -> Result<(), AppError> {
    with_auxiliary_session_once(state, connection, |auxiliary| {
        let sftp = auxiliary_sftp(auxiliary)?;
        // 批量删除复用同一个 SFTP 会话，避免多选删除时为每个文件重复握手导致界面卡顿。
        for path in paths.iter().filter(|path| !path.trim().is_empty()) {
            delete_remote_path_with_sftp(sftp, path)?;
        }
        Ok(())
    })
}

pub(super) fn rename_remote_path_with_cache(
    state: &AppState,
    connection: &ConnectionProfile,
    path: &str,
    new_path: &str,
) -> Result<(), AppError> {
    with_auxiliary_session_once(state, connection, |auxiliary| {
        let sftp = auxiliary_sftp(auxiliary)?;
        let remote_path = normalize_remote_path(path);
        let next_remote_path = normalize_remote_path(new_path);
        sftp.rename(Path::new(&remote_path), Path::new(&next_remote_path), None)
            .map_err(ssh_error)
    })
}

/// 用单引号包裹并转义 shell 参数，供组装 cp 命令时防止空格及特殊字符被再次解析。
fn shell_single_quote(value: &str) -> String {
    // POSIX 单引号内只需把每个单引号替换成 '\'' 序列即可安全传参。
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// 组装服务端 cp 命令：-r 递归复制目录、-p 保留权限时间，`--` 终止选项防止以 - 开头的文件名被当作参数。
/// 追加 `&& printf ok` 让成功时输出非空，从而与真正失败区分（个别系统 -p 保留属性会向 stderr 输出告警）。
/// 全部源为空时返回 None，调用方据此跳过执行。
fn build_remote_copy_command(sources: &[String], target: &str) -> Option<String> {
    let mut quoted_sources = String::new();
    for source in sources.iter().filter(|item| !item.trim().is_empty()) {
        quoted_sources.push(' ');
        quoted_sources.push_str(&shell_single_quote(&normalize_remote_path(source)));
    }
    if quoted_sources.is_empty() {
        return None;
    }
    Some(format!(
        "cp -rp --{} {} && printf ok",
        quoted_sources,
        shell_single_quote(target)
    ))
}

pub(super) fn copy_remote_paths_with_cache(
    state: &AppState,
    connection: &ConnectionProfile,
    sources: &[String],
    target_dir: &str,
) -> Result<(), AppError> {
    with_auxiliary_session_once(state, connection, |auxiliary| {
        // 目标目录可能是 ~ 或 .，先用 SFTP realpath 解析成绝对路径，保证 cp 落点与列表视图一致。
        let target = {
            let sftp = auxiliary_sftp(auxiliary)?;
            resolve_remote_dir(sftp, target_dir)?
        };
        // 远端到远端复制直接走服务器本地 cp，避免经客户端下载再上传，大目录也高效。
        // ponytail: 粘贴到源文件所在目录会因 cp 同名自拷贝报错（已知上限）；如需“生成副本”可后续在目标名追加后缀。
        let Some(command) = build_remote_copy_command(sources, &target) else {
            return Ok(());
        };
        exec_remote_command(&auxiliary.session, &command).map(|_| ())
    })
}

fn upload_local_file_to_remote(
    sftp: &Sftp,
    local_path: &Path,
    remote_path: &str,
    summary: &mut FileTransferSummary,
) -> Result<(), AppError> {
    if let Some(parent) = remote_parent_path(remote_path) {
        ensure_remote_directory(sftp, &parent)?;
    }

    let mut local_file = fs::File::open(local_path)?;
    let mut remote_file = sftp.create(Path::new(remote_path)).map_err(ssh_error)?;
    let copied = std::io::copy(&mut local_file, &mut remote_file)?;
    remote_file.flush()?;
    summary.files += 1;
    summary.bytes = summary.bytes.saturating_add(copied);
    Ok(())
}

fn upload_local_directory_to_remote(
    sftp: &Sftp,
    local_dir: &Path,
    remote_dir: &str,
    summary: &mut FileTransferSummary,
) -> Result<(), AppError> {
    ensure_remote_directory(sftp, remote_dir)?;
    summary.directories += 1;

    for entry in fs::read_dir(local_dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let child_name = entry.file_name().to_string_lossy().to_string();
        let remote_child =
            join_remote_path(remote_dir, &normalize_remote_relative_path(&child_name)?);
        let local_child = entry.path();

        if file_type.is_dir() {
            upload_local_directory_to_remote(sftp, &local_child, &remote_child, summary)?;
        } else if file_type.is_file() {
            upload_local_file_to_remote(sftp, &local_child, &remote_child, summary)?;
        }
        // 本地符号链接和设备等特殊文件不上传，避免把未知目标或不可复制内容写到远端。
    }

    Ok(())
}

fn upload_local_path_to_remote(
    sftp: &Sftp,
    local_path: &Path,
    remote_path: &str,
    summary: &mut FileTransferSummary,
) -> Result<(), AppError> {
    let metadata = fs::symlink_metadata(local_path)?;
    if metadata.is_dir() {
        upload_local_directory_to_remote(sftp, local_path, remote_path, summary)
    } else if metadata.is_file() {
        upload_local_file_to_remote(sftp, local_path, remote_path, summary)
    } else {
        Err(AppError::Validation(format!(
            "local path {} is not a regular file or directory",
            local_path.to_string_lossy()
        )))
    }
}

fn download_remote_file_to_local(
    sftp: &Sftp,
    remote_path: &str,
    local_path: &Path,
    summary: &mut FileTransferSummary,
) -> Result<(), AppError> {
    if let Some(parent) = local_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut remote_file = sftp.open(Path::new(remote_path)).map_err(ssh_error)?;
    let mut local_file = fs::File::create(local_path)?;
    let copied = std::io::copy(&mut remote_file, &mut local_file)?;
    local_file.flush()?;
    summary.files += 1;
    summary.bytes = summary.bytes.saturating_add(copied);
    Ok(())
}

fn download_remote_directory_to_local(
    sftp: &Sftp,
    remote_dir: &str,
    local_dir: &Path,
    summary: &mut FileTransferSummary,
) -> Result<(), AppError> {
    fs::create_dir_all(local_dir)?;
    summary.directories += 1;
    let entries = sftp.readdir(Path::new(remote_dir)).map_err(ssh_error)?;
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
            download_remote_directory_to_local(sftp, &remote_child, &local_child, summary)?;
        } else if !(stat_is_symlink(&stat) && is_directory) {
            // 符号链接目录不递归跟随，避免远端循环链接导致下载无限展开；普通文件和文件链接按目标内容下载。
            download_remote_file_to_local(sftp, &remote_child, &local_child, summary)?;
        }
    }

    Ok(())
}

fn unique_local_destination(destination: PathBuf, used: &mut HashSet<PathBuf>) -> PathBuf {
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

fn download_remote_path_to_local(
    sftp: &Sftp,
    remote_path: &str,
    destination: &Path,
    summary: &mut FileTransferSummary,
) -> Result<(), AppError> {
    let remote_stat = sftp.stat(Path::new(remote_path)).map_err(ssh_error)?;
    if stat_is_dir(&remote_stat) {
        download_remote_directory_to_local(sftp, remote_path, destination, summary)
    } else {
        download_remote_file_to_local(sftp, remote_path, destination, summary)
    }
}

#[cfg(test)]
mod remote_access_command_tests {
    use super::*;

    #[test]
    fn build_remote_copy_command_quotes_sources_and_target() {
        let sources = vec![
            "/ology/hello.txt".to_string(),
            "/ology/ology dir".to_string(),
        ];
        let command = build_remote_copy_command(&sources, "/backup").expect("command should build");
        // -- 终止选项，源与目标各自单引号包裹，空格路径不会被拆分。
        assert_eq!(
            command,
            "cp -rp -- '/ology/hello.txt' '/ology/ology dir' '/backup' && printf ok"
        );
    }

    #[test]
    fn build_remote_copy_command_escapes_single_quote() {
        let sources = vec!["/ology/it's here".to_string()];
        let command = build_remote_copy_command(&sources, "/tmp").expect("command should build");
        // 文件名中的单引号必须转义成 '\'' 序列，避免提前闭合引号导致命令注入或解析错乱。
        assert_eq!(
            command,
            "cp -rp -- '/ology/it'\\''s here' '/tmp' && printf ok"
        );
    }

    #[test]
    fn build_remote_copy_command_returns_none_for_empty_sources() {
        let sources = vec!["   ".to_string(), String::new()];
        assert!(build_remote_copy_command(&sources, "/tmp").is_none());
    }

    #[test]
    fn parses_available_tcp_and_ssh_connection_counts() {
        // 正常采集结果必须同时保留 TCP 总数和最终 sshd 端口对应的连接数。
        assert_eq!(
            parse_connection_counts("tcp=18 ssh=2"),
            Some("TCP 18 / SSH 2".to_string())
        );
    }

    #[test]
    fn marks_ssh_connection_count_unavailable_instead_of_zero() {
        // 端口无法识别或网络表不可见时远端返回 --，前端展示也不能回退成误导性的 SSH 0。
        assert_eq!(
            parse_connection_counts("tcp=18 ssh=--"),
            Some("TCP 18 / SSH --".to_string())
        );
    }

    #[test]
    fn runtime_overview_discovers_the_final_remote_ssh_port() {
        let command = runtime_overview_command();
        // 跳板和端口映射场景必须依据最终 sshd 注入的会话环境，不能再嵌入客户端 connection.port。
        assert!(command.contains("SSH_CONNECTION"));
        assert!(command.contains("SSH_CLIENT"));
        assert!(command.contains("[ \"$connection_ssh\" = \"0\" ] && connection_ssh=\"\""));
    }

    #[test]
    fn decodes_proc_net_hex_addresses_to_readable_ip_port() {
        // IPv4 按主机字节序输出，0100007F 翻回网络序即 127.0.0.1；端口 0016 为大端 22。
        assert_eq!(
            decode_proc_net_address("0100007F:0016"),
            Some("127.0.0.1:22".to_string())
        );
        // IPv6 回环按 4 个 32 位字输出，只有最后一字 01000000 携带真实字节 00000001。
        assert_eq!(
            decode_proc_net_address("00000000000000000000000001000000:0016"),
            Some("[::1]:22".to_string())
        );
        assert_eq!(decode_proc_net_address("GGGG:0016"), None);
    }

    #[test]
    fn parses_connection_list_marks_ssh_and_keeps_total() {
        let contents = "conn hex 0100007F:0016 0200007F:D431\n\
                        conn hex 0100A8C0:1F90 0201A8C0:C350\n\
                        conn plain 10.0.0.5:43210 10.0.0.9:3306\n\
                        ssh_port=22\n\
                        total=3";
        let list = parse_connection_list(contents);
        // SSH 管理连接必须置顶，方便展开后第一眼定位当前会话。
        assert_eq!(list.total, 3);
        assert_eq!(list.items.len(), 3);
        assert_eq!(list.items[0].local, "127.0.0.1:22");
        assert_eq!(list.items[0].remote, "127.0.0.2:54321");
        assert!(list.items[0].is_ssh);
        // 非 SSH 连接按本地地址字典序排列。
        assert_eq!(list.items[1].local, "10.0.0.5:43210");
        assert!(!list.items[1].is_ssh);
        assert_eq!(list.items[2].local, "192.168.0.1:8080");
        assert_eq!(list.items[2].remote, "192.168.1.2:50000");
        assert!(!list.items[2].is_ssh);
    }

    #[test]
    fn connection_list_command_caps_output_and_detects_ssh_port() {
        let command = connection_list_command();
        // 输出上限与 sshd 端口识别是明细命令的两条硬性约束，测试防止后续修改意外破坏。
        assert!(command.contains("limit=200"));
        assert!(command.contains("SSH_CONNECTION"));
        assert!(command.contains("conn hex %s %s"));
    }
}
