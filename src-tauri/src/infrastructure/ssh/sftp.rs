use chrono::{TimeZone, Utc};
use ssh2::{Session, Sftp};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;

use crate::{
    domain::entities::{
        ConnectionProfile, HistoryEntry, RemoteFileEntry, RuntimeCpuCore, RuntimeOverview,
    },
    domain::services,
    error::AppError,
};

use super::connection::{connect_ssh, ssh_error};

pub(crate) fn resolve_remote_dir(sftp: &Sftp, requested_path: &str) -> Result<String, AppError> {
    let trimmed = requested_path.trim();
    if trimmed.is_empty() || trimmed == "~" || trimmed == "." {
        return sftp
            .realpath(Path::new("."))
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .map_err(ssh_error);
    }

    Ok(services::normalize_remote_path(trimmed))
}

pub(crate) fn stat_is_dir(stat: &ssh2::FileStat) -> bool {
    stat.perm
        .map(|perm| (perm & 0o170_000) == 0o040_000)
        .unwrap_or(false)
}

pub(crate) fn modified_at(stat: &ssh2::FileStat) -> Option<String> {
    let timestamp = stat.mtime? as i64;
    chrono::DateTime::<Utc>::from_timestamp(timestamp, 0).map(|value| value.to_rfc3339())
}

pub(crate) fn stat_is_symlink(stat: &ssh2::FileStat) -> bool {
    stat.perm
        .map(|perm| (perm & 0o170000) == 0o120000)
        .unwrap_or(false)
}

/// 将 SFTP mode 转为类似 ls -l 的权限文本，方便文件管理器按列展示。
pub(crate) fn format_permissions(stat: &ssh2::FileStat) -> Option<String> {
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
pub(crate) fn parse_identity_map(contents: &str, id_index: usize) -> HashMap<u32, String> {
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
pub(crate) fn stat_owner_group(
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
pub(crate) fn parse_marked_sections(contents: &str) -> HashMap<String, String> {
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
pub(crate) fn load_remote_identity_maps(
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

pub(crate) fn exec_remote_command(session: &Session, command: &str) -> Result<String, AppError> {
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

pub(crate) fn parse_history_timestamp(seconds: &str) -> Option<String> {
    let timestamp = seconds.trim().parse::<i64>().ok()?;
    Utc.timestamp_opt(timestamp, 0)
        .single()
        .map(|value| value.to_rfc3339())
}

pub(crate) fn parse_zsh_extended_history(line: &str) -> Option<(Option<String>, String)> {
    let rest = line.strip_prefix(": ")?;
    let (timestamp, remainder) = rest.split_once(':')?;
    let (_duration, command) = remainder.split_once(';')?;
    Some((parse_history_timestamp(timestamp), command.to_string()))
}

pub(crate) fn is_internal_history_command(command: &str) -> bool {
    let trimmed = command.trim();
    trimmed.contains("__myterminal_sync_") || trimmed.contains("MyTerminalCwd=")
}

pub(crate) fn parse_remote_history(
    connection_id: &str,
    contents: &str,
    limit: usize,
) -> Vec<HistoryEntry> {
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
            executed_at: timestamp.unwrap_or_else(|| Utc::now().to_rfc3339()),
        });
    }

    // 远端历史文件按旧到新存储，界面历史列表沿用最新命令在上面的展示顺序。
    entries.into_iter().rev().take(limit.max(1)).collect()
}

pub(crate) fn read_remote_shell_history_entries(
    connection: &ConnectionProfile,
    limit: usize,
) -> Result<Vec<HistoryEntry>, AppError> {
    let session = connect_ssh(connection)?;
    let remote_limit = limit.clamp(1, 500);
    // 远端 history 是 shell 内置，独立 exec 不一定能读取交互会话内存；这里读取历史文件，
    // 并依赖交互 Shell 的 prompt 钩子先执行 history -a / fc -AI，把当前会话命令落盘。
    let command = format!(
        "sh -lc 'limit={remote_limit}; seen=\"\"; for file in \"${{HISTFILE:-}}\" \"$HOME/.zsh_history\" \"$HOME/.bash_history\"; do [ -n \"$file\" ] || continue; case \":$seen:\" in *:\"$file\":*) continue;; esac; seen=\"$seen:$file\"; [ -r \"$file\" ] || continue; tail -n \"$limit\" \"$file\" 2>/dev/null; done'"
    );
    let contents = exec_remote_command(&session, &command)?;
    Ok(parse_remote_history(
        &connection.id,
        &contents,
        remote_limit,
    ))
}

pub(crate) fn parse_meminfo_value(contents: &str, key: &str) -> Option<u64> {
    contents.lines().find_map(|line| {
        line.strip_prefix(key).and_then(|rest| {
            rest.split_whitespace()
                .next()
                .and_then(|value| value.parse::<u64>().ok())
        })
    })
}

pub(crate) fn format_kib(kib: u64) -> String {
    let gib = kib as f64 / 1024.0 / 1024.0;
    if gib >= 1.0 {
        format!("{gib:.1} GB")
    } else {
        format!("{:.0} MB", kib as f64 / 1024.0)
    }
}

pub(crate) fn format_uptime(seconds: u64) -> String {
    let days = seconds / 86_400;
    let hours = (seconds % 86_400) / 3_600;
    let minutes = (seconds % 3_600) / 60;

    if days > 0 {
        format!("{days}d {hours}h")
    } else if hours > 0 {
        format!("{hours}h {minutes}m")
    } else {
        format!("{minutes}m")
    }
}

pub(crate) fn parse_cpu_sample(line: &str) -> Option<(u64, u64)> {
    let values = line
        .split_whitespace()
        .skip(1)
        .filter_map(|value| value.parse::<u64>().ok())
        .collect::<Vec<_>>();
    if values.len() < 4 {
        return None;
    }

    // /proc/stat 的 idle/iowait 属于空闲时间，其余字段都按总时间计入 CPU 采样窗口。
    let idle = values.get(3).copied().unwrap_or(0) + values.get(4).copied().unwrap_or(0);
    let total = values.iter().copied().sum::<u64>();
    Some((idle, total))
}

// 解析 /proc/stat 中 cpu/cpuN 行，保留名称方便同时计算总 CPU 和各核心占用。
pub(crate) fn parse_named_cpu_sample(line: &str) -> Option<(String, u64, u64)> {
    let name = line.split_whitespace().next()?.to_string();
    let (idle, total) = parse_cpu_sample(line)?;
    Some((name, idle, total))
}

// 根据前后两次采样计算占用率，使用 saturating_sub 避免远端计数异常回退导致 panic。
pub(crate) fn calculate_cpu_percent(before: (u64, u64), after: (u64, u64)) -> Option<f64> {
    let idle_delta = after.0.saturating_sub(before.0);
    let total_delta = after.1.saturating_sub(before.1);
    if total_delta == 0 {
        return None;
    }

    Some(((total_delta.saturating_sub(idle_delta)) as f64 / total_delta as f64) * 100.0)
}

// 总 CPU 只读取 cpu 聚合行，输出给运行状态主行展示。
pub(crate) fn parse_cpu_percent(contents: &str) -> Option<f64> {
    let mut samples = contents
        .lines()
        .filter_map(parse_named_cpu_sample)
        .filter_map(|(name, idle, total)| (name == "cpu").then_some((idle, total)));
    calculate_cpu_percent(samples.next()?, samples.next()?)
}

// 各核心 CPU 使用同一段采样文本配对计算，前端点击 CPU 主行时再展开显示。
pub(crate) fn parse_cpu_core_percents(contents: &str) -> Vec<RuntimeCpuCore> {
    let mut before = HashMap::<String, (u64, u64)>::new();
    let mut cores = Vec::<RuntimeCpuCore>::new();

    for (name, idle, total) in contents.lines().filter_map(parse_named_cpu_sample) {
        if name == "cpu" {
            continue;
        }
        if let Some(previous) = before.remove(&name) {
            if let Some(percent) = calculate_cpu_percent(previous, (idle, total)) {
                cores.push(RuntimeCpuCore {
                    name: name.replacen("cpu", "CPU ", 1),
                    percent,
                });
            }
        } else {
            before.insert(name, (idle, total));
        }
    }

    cores
}

pub(crate) fn query_runtime_overview(
    connection: &ConnectionProfile,
) -> Result<RuntimeOverview, AppError> {
    let session = connect_ssh(connection)?;
    // 运行状态一次性读取所有需要的远端文本，避免 CPU/内存/磁盘等指标各自开 channel 导致刷新发慢。
    let sections = exec_remote_command(
        &session,
        "sh -lc 'printf \"__MYTERMINAL_OS__\\n\"; (uname -srmo 2>/dev/null || uname -a 2>/dev/null || true); printf \"\\n__MYTERMINAL_CPUSTAT__\\n\"; (grep -E \"^cpu[0-9 ]\" /proc/stat 2>/dev/null; sleep 0.2; grep -E \"^cpu[0-9 ]\" /proc/stat 2>/dev/null) || true; printf \"\\n__MYTERMINAL_MEMINFO__\\n\"; cat /proc/meminfo 2>/dev/null || true; printf \"\\n__MYTERMINAL_DF__\\n\"; df -Pk / 2>/dev/null || true; printf \"\\n__MYTERMINAL_HOSTIP__\\n\"; hostname -I 2>/dev/null || true; printf \"\\n__MYTERMINAL_UPTIME__\\n\"; cat /proc/uptime 2>/dev/null || true'",
    )
    .map(|contents| parse_marked_sections(&contents))
    .unwrap_or_default();

    let os = sections
        .get("OS")
        .filter(|contents| !contents.is_empty())
        .cloned()
        .unwrap_or_else(|| String::from("Unknown"));

    let cpu = sections
        .get("CPUSTAT")
        .and_then(|contents| parse_cpu_percent(contents).map(|percent| format!("{percent:.0}%")))
        .unwrap_or_else(|| String::from("--"));
    let cpu_cores = sections
        .get("CPUSTAT")
        .map(|contents| parse_cpu_core_percents(contents))
        .unwrap_or_default();

    let memory = sections
        .get("MEMINFO")
        .and_then(|contents| {
            let total = parse_meminfo_value(contents, "MemTotal:")?;
            let available = parse_meminfo_value(contents, "MemAvailable:")
                .or_else(|| parse_meminfo_value(contents, "MemFree:"))?;
            let used = total.saturating_sub(available);
            let percent = if total > 0 {
                (used as f64 / total as f64) * 100.0
            } else {
                0.0
            };
            Some(format!(
                "{} / {} ({percent:.0}%)",
                format_kib(used),
                format_kib(total)
            ))
        })
        .unwrap_or_else(|| String::from("--"));

    let storage = sections
        .get("DF")
        .and_then(|contents| {
            let line = contents.lines().nth(1)?;
            let parts = line.split_whitespace().collect::<Vec<_>>();
            if parts.len() < 5 {
                return None;
            }
            let total = parts[1].parse::<u64>().ok()?;
            let used = parts[2].parse::<u64>().ok()?;
            Some(format!(
                "{} / {} ({})",
                format_kib(used),
                format_kib(total),
                parts[4]
            ))
        })
        .unwrap_or_else(|| String::from("--"));

    let network = sections
        .get("HOSTIP")
        .and_then(|contents| contents.split_whitespace().next().map(ToString::to_string))
        .unwrap_or_else(|| connection.host.clone());

    let uptime = sections
        .get("UPTIME")
        .and_then(|contents| {
            contents
                .split_whitespace()
                .next()
                .and_then(|value| value.split('.').next())
                .and_then(|value| value.parse::<u64>().ok())
                .map(format_uptime)
        })
        .unwrap_or_else(|| String::from("--"));

    Ok(RuntimeOverview {
        host: connection.host.clone(),
        os,
        cpu,
        cpu_cores,
        memory,
        storage,
        network,
        uptime,
    })
}

pub(crate) fn list_remote_entries(
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

pub(crate) fn read_remote_file_bytes(
    connection: &ConnectionProfile,
    path: &str,
) -> Result<Vec<u8>, AppError> {
    let session = connect_ssh(connection)?;
    let sftp = session.sftp().map_err(ssh_error)?;
    let remote_path = services::normalize_remote_path(path);
    let mut remote_file = sftp.open(Path::new(&remote_path)).map_err(ssh_error)?;
    let mut bytes = Vec::new();
    remote_file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

pub(crate) fn write_remote_file_bytes(
    connection: &ConnectionProfile,
    path: &str,
    bytes: &[u8],
) -> Result<(), AppError> {
    let session = connect_ssh(connection)?;
    let sftp = session.sftp().map_err(ssh_error)?;
    let remote_path = services::normalize_remote_path(path);
    let mut remote_file = sftp.create(Path::new(&remote_path)).map_err(ssh_error)?;
    remote_file.write_all(bytes)?;
    remote_file.flush()?;
    Ok(())
}

pub(crate) fn delete_remote_path_with_sftp(sftp: &Sftp, path: &str) -> Result<(), AppError> {
    let remote_path = services::normalize_remote_path(path);
    let stat = sftp.stat(Path::new(&remote_path)).map_err(ssh_error)?;
    if stat_is_dir(&stat) {
        sftp.rmdir(Path::new(&remote_path)).map_err(ssh_error)?;
    } else {
        sftp.unlink(Path::new(&remote_path)).map_err(ssh_error)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── stat_is_dir ──

    #[test]
    fn test_stat_is_dir_directory_perm() {
        let stat = ssh2::FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: Some(0o040755),
            atime: None,
            mtime: None,
        };
        assert!(stat_is_dir(&stat));
    }

    #[test]
    fn test_stat_is_dir_regular_file() {
        let stat = ssh2::FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: Some(0o100644),
            atime: None,
            mtime: None,
        };
        assert!(!stat_is_dir(&stat));
    }

    #[test]
    fn test_stat_is_dir_symlink() {
        let stat = ssh2::FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: Some(0o120777),
            atime: None,
            mtime: None,
        };
        assert!(!stat_is_dir(&stat));
    }

    #[test]
    fn test_stat_is_dir_no_perm() {
        let stat = ssh2::FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: None,
            atime: None,
            mtime: None,
        };
        assert!(!stat_is_dir(&stat));
    }

    // ── stat_is_symlink ──

    #[test]
    fn test_stat_is_symlink_symlink_perm() {
        let stat = ssh2::FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: Some(0o120777),
            atime: None,
            mtime: None,
        };
        assert!(stat_is_symlink(&stat));
    }

    #[test]
    fn test_stat_is_symlink_regular_file() {
        let stat = ssh2::FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: Some(0o100644),
            atime: None,
            mtime: None,
        };
        assert!(!stat_is_symlink(&stat));
    }

    #[test]
    fn test_stat_is_symlink_no_perm() {
        let stat = ssh2::FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: None,
            atime: None,
            mtime: None,
        };
        assert!(!stat_is_symlink(&stat));
    }

    // ── format_permissions ──

    #[test]
    fn test_format_permissions_directory() {
        let stat = ssh2::FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: Some(0o040755),
            atime: None,
            mtime: None,
        };
        let result = format_permissions(&stat);
        assert_eq!(result.as_deref(), Some("drwxr-xr-x"));
    }

    #[test]
    fn test_format_permissions_file() {
        let stat = ssh2::FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: Some(0o100644),
            atime: None,
            mtime: None,
        };
        let result = format_permissions(&stat);
        assert_eq!(result.as_deref(), Some("-rw-r--r--"));
    }

    #[test]
    fn test_format_permissions_symlink() {
        let stat = ssh2::FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: Some(0o120777),
            atime: None,
            mtime: None,
        };
        let result = format_permissions(&stat);
        assert_eq!(result.as_deref(), Some("lrwxrwxrwx"));
    }

    #[test]
    fn test_format_permissions_no_perm() {
        let stat = ssh2::FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: None,
            atime: None,
            mtime: None,
        };
        assert!(format_permissions(&stat).is_none());
    }

    // ── parse_identity_map ──

    #[test]
    fn test_parse_identity_map_basic() {
        let contents =
            "root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n";
        let map = parse_identity_map(contents, 2);
        assert_eq!(map.get(&0).map(String::as_str), Some("root"));
        assert_eq!(map.get(&1).map(String::as_str), Some("daemon"));
    }

    #[test]
    fn test_parse_identity_map_invalid_line() {
        let contents = "invalid\nroot:x:0:0:root:/root:/bin/bash\n";
        let map = parse_identity_map(contents, 2);
        assert_eq!(map.get(&0).map(String::as_str), Some("root"));
    }

    #[test]
    fn test_parse_identity_map_empty() {
        let contents = "";
        let map = parse_identity_map(contents, 2);
        assert!(map.is_empty());
    }

    // ── parse_marked_sections ──

    #[test]
    fn test_parse_marked_sections_basic() {
        let contents = "__MYTERMINAL_OS__\nLinux\n__MYTERMINAL_CPU__\nIntel\n";
        let sections = parse_marked_sections(contents);
        assert_eq!(sections.get("OS").map(String::as_str), Some("Linux"));
        assert_eq!(sections.get("CPU").map(String::as_str), Some("Intel"));
    }

    #[test]
    fn test_parse_marked_sections_empty() {
        let sections = parse_marked_sections("");
        assert!(sections.is_empty());
    }

    #[test]
    fn test_parse_marked_sections_multiline() {
        let contents = "__MYTERMINAL_DATA__\nline1\nline2\n";
        let sections = parse_marked_sections(contents);
        assert_eq!(
            sections.get("DATA").map(String::as_str),
            Some("line1\nline2")
        );
    }

    // ── parse_history_timestamp ──

    #[test]
    fn test_parse_history_timestamp_valid() {
        let result = parse_history_timestamp("1700000000");
        assert!(result.is_some());
        let ts = result.unwrap();
        assert!(ts.contains("T"));
        assert!(ts.ends_with("Z") || ts.contains('+'));
    }

    #[test]
    fn test_parse_history_timestamp_invalid() {
        assert!(parse_history_timestamp("not-a-number").is_none());
    }

    #[test]
    fn test_parse_history_timestamp_empty() {
        assert!(parse_history_timestamp("").is_none());
    }

    // ── parse_zsh_extended_history ──

    #[test]
    fn test_parse_zsh_extended_history_valid() {
        let result = parse_zsh_extended_history(": 1700000000:0;ls -la");
        assert!(result.is_some());
        let (ts, cmd) = result.unwrap();
        assert!(ts.is_some());
        assert_eq!(cmd, "ls -la");
    }

    #[test]
    fn test_parse_zsh_extended_history_no_prefix() {
        assert!(parse_zsh_extended_history("ls -la").is_none());
    }

    #[test]
    fn test_parse_zsh_extended_history_malformed() {
        assert!(parse_zsh_extended_history(": 1700000000").is_none());
    }

    // ── is_internal_history_command ──

    #[test]
    fn test_is_internal_history_command_sync_cwd() {
        assert!(is_internal_history_command("__myterminal_sync_cwd"));
    }

    #[test]
    fn test_is_internal_history_command_myterminal() {
        assert!(is_internal_history_command("MyTerminalCwd=/home"));
    }

    #[test]
    fn test_is_internal_history_command_normal() {
        assert!(!is_internal_history_command("ls -la"));
    }

    #[test]
    fn test_is_internal_history_command_empty() {
        assert!(!is_internal_history_command(""));
    }

    // ── parse_meminfo_value ──

    #[test]
    fn test_parse_meminfo_value_found() {
        let contents = "MemTotal:       16384000 kB\nMemFree:        8000000 kB\n";
        assert_eq!(parse_meminfo_value(contents, "MemTotal:"), Some(16384000));
        assert_eq!(parse_meminfo_value(contents, "MemFree:"), Some(8000000));
    }

    #[test]
    fn test_parse_meminfo_value_not_found() {
        let contents = "MemTotal: 12345 kB\n";
        assert!(parse_meminfo_value(contents, "NotFound:").is_none());
    }

    #[test]
    fn test_parse_meminfo_value_empty() {
        assert!(parse_meminfo_value("", "MemTotal:").is_none());
    }

    // ── format_kib ──

    #[test]
    fn test_format_kib_gib() {
        let result = format_kib(2_097_152); // 2 GiB
        assert!(result.contains("2.0"));
        assert!(result.contains("GB"));
    }

    #[test]
    fn test_format_kib_mib() {
        let result = format_kib(1024); // 1 MiB
        assert!(result.contains("1"));
        assert!(result.contains("MB"));
        assert!(!result.contains("GB"));
    }

    #[test]
    fn test_format_kib_zero() {
        let result = format_kib(0);
        assert!(result.contains("0"));
        assert!(result.contains("MB"));
    }

    // ── format_uptime ──

    #[test]
    fn test_format_uptime_days() {
        let result = format_uptime(90000); // 1d 1h
        assert_eq!(result, "1d 1h");
    }

    #[test]
    fn test_format_uptime_hours() {
        let result = format_uptime(3660); // 1h 1m
        assert_eq!(result, "1h 1m");
    }

    #[test]
    fn test_format_uptime_minutes() {
        let result = format_uptime(300); // 5m
        assert_eq!(result, "5m");
    }

    #[test]
    fn test_format_uptime_zero() {
        let result = format_uptime(0);
        assert_eq!(result, "0m");
    }

    // ── parse_cpu_sample ──

    #[test]
    fn test_parse_cpu_sample_valid() {
        let result = parse_cpu_sample("cpu  100 200 300 400 500 600 700 800 900 1000");
        assert!(result.is_some());
        let (idle, total) = result.unwrap();
        // idle = values[3] + values[4] = 400 + 500 = 900
        assert_eq!(idle, 900);
        // total = sum of all values
        assert_eq!(total, 5500);
    }

    #[test]
    fn test_parse_cpu_sample_too_few_fields() {
        let result = parse_cpu_sample("cpu  100 200");
        assert!(result.is_none());
    }

    #[test]
    fn test_parse_cpu_sample_empty() {
        let result = parse_cpu_sample("");
        assert!(result.is_none());
    }

    // ── calculate_cpu_percent ──

    #[test]
    fn test_calculate_cpu_percent_normal() {
        let before = (900, 5500);
        let after = (1800, 11000);
        let result = calculate_cpu_percent(before, after);
        assert!(result.is_some());
        let pct = result.unwrap();
        // idle_delta = 900, total_delta = 5500
        // (5500 - 900) / 5500 * 100 ≈ 83.636
        assert!((pct - 83.636).abs() < 0.01);
    }

    #[test]
    fn test_calculate_cpu_percent_idle_only() {
        let before = (100, 100);
        let after = (200, 200);
        let result = calculate_cpu_percent(before, after);
        assert!(result.is_some());
        assert!((result.unwrap() - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_calculate_cpu_percent_no_delta() {
        let before = (100, 500);
        let after = (100, 500);
        assert!(calculate_cpu_percent(before, after).is_none());
    }

    // ── modified_at ──

    #[test]
    fn test_modified_at_valid() {
        let stat = ssh2::FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: None,
            atime: None,
            mtime: Some(1700000000),
        };
        let result = modified_at(&stat);
        assert!(result.is_some());
        assert!(result.unwrap().contains("2023"));
    }

    #[test]
    fn test_modified_at_no_mtime() {
        let stat = ssh2::FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: None,
            atime: None,
            mtime: None,
        };
        assert!(modified_at(&stat).is_none());
    }
}
