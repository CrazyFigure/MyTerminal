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
    auxiliary_identity_maps, auxiliary_sftp, delete_remote_path_with_sftp, ssh_error,
    with_auxiliary_session, with_auxiliary_session_once, FileTransferSummary,
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

fn parse_meminfo_value(contents: &str, key: &str) -> Option<u64> {
    contents.lines().find_map(|line| {
        line.strip_prefix(key).and_then(|rest| {
            rest.split_whitespace()
                .next()
                .and_then(|value| value.parse::<u64>().ok())
        })
    })
}

fn format_kib(kib: u64) -> String {
    let gib = kib as f64 / 1024.0 / 1024.0;
    if gib >= 1.0 {
        format!("{gib:.1} GB")
    } else {
        format!("{:.0} MB", kib as f64 / 1024.0)
    }
}

fn format_uptime(seconds: u64) -> String {
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

fn parse_connection_counts(contents: &str) -> Option<String> {
    let mut tcp_count = None;
    let mut ssh_count = None;

    for token in contents.split_whitespace() {
        if let Some(value) = token.strip_prefix("tcp=") {
            tcp_count = value.parse::<u64>().ok();
            continue;
        }

        if let Some(value) = token.strip_prefix("ssh=") {
            ssh_count = value.parse::<u64>().ok();
        }
    }

    // SSH 数量缺失表示远端无法可靠识别当前 sshd 端口，必须展示不可用，不能用 0 混淆真实结果。
    tcp_count.map(|tcp| {
        let ssh = ssh_count
            .map(|count| count.to_string())
            .unwrap_or_else(|| String::from("--"));
        format!("TCP {tcp} / SSH {ssh}")
    })
}

/// 构造运行状态采集命令。SSH 端口必须从最终远端会话的环境变量中读取，不能使用客户端配置端口：
/// 跳板机、NAT 或端口转发会让连接入口端口与目标机 sshd 实际监听端口不同。
fn runtime_overview_command() -> &'static str {
    r#"sh -lc '
printf "__MYTERMINAL_OS__\n"
(uname -srmo 2>/dev/null || uname -a 2>/dev/null || true)
printf "\n__MYTERMINAL_CPUSTAT__\n"
(grep -E "^cpu[0-9 ]" /proc/stat 2>/dev/null; sleep 0.2; grep -E "^cpu[0-9 ]" /proc/stat 2>/dev/null) || true
printf "\n__MYTERMINAL_MEMINFO__\n"
cat /proc/meminfo 2>/dev/null || true
printf "\n__MYTERMINAL_DF__\n"
df -Pk / 2>/dev/null || true
printf "\n__MYTERMINAL_CONNECTIONS__\n"

# SSH_CONNECTION 的第 4 段是最终 sshd 实际接收连接的本地端口；SSH_CLIENT 第 3 段作为兼容兜底。
ssh_port=""
if [ -n "${SSH_CONNECTION:-}" ]; then
  set -- $SSH_CONNECTION
  [ "$#" -ge 4 ] && ssh_port="$4"
fi
if [ -z "$ssh_port" ] && [ -n "${SSH_CLIENT:-}" ]; then
  set -- $SSH_CLIENT
  [ "$#" -ge 3 ] && ssh_port="$3"
fi
case "$ssh_port" in
  ""|*[!0-9]*) ssh_port="" ;;
esac

connection_total=""
connection_ssh=""
if [ -r /proc/net/tcp ] || [ -r /proc/net/tcp6 ]; then
  port_hex=""
  [ -n "$ssh_port" ] && port_hex=$(printf "%04X" "$ssh_port" 2>/dev/null || printf "")
  total=0
  ssh=""
  [ -n "$port_hex" ] && ssh=0
  for file in /proc/net/tcp /proc/net/tcp6; do
    [ -r "$file" ] || continue
    while read sl local_addr remote_addr state rest; do
      [ "$sl" = "sl" ] && continue
      [ "$state" = "01" ] || continue
      total=$((total + 1))
      if [ -n "$port_hex" ]; then
        case "$local_addr" in
          *":$port_hex") ssh=$((ssh + 1)) ;;
        esac
      fi
    done < "$file"
  done
  connection_total=$total
  connection_ssh=$ssh
elif command -v ss >/dev/null 2>&1; then
  connection_total=$(ss -Htan state established 2>/dev/null | wc -l | tr -d " ")
  if [ -n "$ssh_port" ]; then
    connection_ssh=$(ss -Htan state established 2>/dev/null | grep -Ec ":$ssh_port[[:space:]]" 2>/dev/null || true)
  fi
elif command -v netstat >/dev/null 2>&1; then
  connection_total=$(netstat -tan 2>/dev/null | grep -c "ESTABLISHED" 2>/dev/null || true)
  if [ -n "$ssh_port" ]; then
    connection_ssh=$(netstat -tan 2>/dev/null | grep "ESTABLISHED" 2>/dev/null | grep -Ec "[:.]$ssh_port[[:space:]]" 2>/dev/null || true)
  fi
fi

# 当前采集命令本身就在 SSH 会话中执行，识别到端口却统计为 0 说明网络表不可见或被隔离，应标记不可用。
[ "$connection_ssh" = "0" ] && connection_ssh=""
if [ -n "$connection_total" ]; then
  printf "tcp=%s" "$connection_total"
  if [ -n "$connection_ssh" ]; then
    printf " ssh=%s\n" "$connection_ssh"
  else
    printf " ssh=--\n"
  fi
fi

printf "\n__MYTERMINAL_HOSTIP__\n"
hostname -I 2>/dev/null || true
printf "\n__MYTERMINAL_UPTIME__\n"
cat /proc/uptime 2>/dev/null || true
'"#
}

/// 构造连接明细采集命令。与运行状态概览不同，明细只在连接数行展开时按需执行，
/// 因此这里可以输出完整的 ESTABLISHED 地址对；输出行数受 limit 限制，避免连接数
/// 上万的主机把展开刷新变成大流量传输。sshd 端口识别逻辑与概览保持一致：必须取
/// 最终 sshd 注入的会话环境，跳板机和端口映射下客户端配置端口并不可靠。
fn connection_list_command() -> &'static str {
    r#"sh -lc '
limit=200
ssh_port=""
if [ -n "${SSH_CONNECTION:-}" ]; then
  set -- $SSH_CONNECTION
  [ "$#" -ge 4 ] && ssh_port="$4"
fi
if [ -z "$ssh_port" ] && [ -n "${SSH_CLIENT:-}" ]; then
  set -- $SSH_CLIENT
  [ "$#" -ge 3 ] && ssh_port="$3"
fi
case "$ssh_port" in
  ""|*[!0-9]*) ssh_port="" ;;
esac

if [ -r /proc/net/tcp ] || [ -r /proc/net/tcp6 ]; then
  total=0
  shown=0
  for file in /proc/net/tcp /proc/net/tcp6; do
    [ -r "$file" ] || continue
    while read sl local_addr remote_addr state rest; do
      [ "$sl" = "sl" ] && continue
      [ "$state" = "01" ] || continue
      total=$((total + 1))
      if [ "$shown" -lt "$limit" ]; then
        printf "conn hex %s %s\n" "$local_addr" "$remote_addr"
        shown=$((shown + 1))
      fi
    done < "$file"
  done
  [ -n "$ssh_port" ] && printf "ssh_port=%s\n" "$ssh_port"
  printf "total=%s\n" "$total"
elif command -v ss >/dev/null 2>&1; then
  [ -n "$ssh_port" ] && printf "ssh_port=%s\n" "$ssh_port"
  ss -Htan state established 2>/dev/null | head -n "$limit" | while read recq sendq local_addr remote_addr rest; do
    [ -n "$local_addr" ] && printf "conn plain %s %s\n" "$local_addr" "$remote_addr"
  done || true
  printf "total=%s\n" "$(ss -Htan state established 2>/dev/null | wc -l | tr -d " ")"
elif command -v netstat >/dev/null 2>&1; then
  [ -n "$ssh_port" ] && printf "ssh_port=%s\n" "$ssh_port"
  netstat -tan 2>/dev/null | grep "ESTABLISHED" | head -n "$limit" | while read proto recq sendq local_addr remote_addr rest; do
    [ -n "$local_addr" ] && printf "conn plain %s %s\n" "$local_addr" "$remote_addr"
  done || true
  printf "total=%s\n" "$(netstat -tan 2>/dev/null | grep -c "ESTABLISHED" 2>/dev/null || true)"
fi
'"#
}

/// 解码 /proc/net/tcp{,6} 的十六进制地址。IP 按内核 %08X 输出规则逐字翻转回网络序
/// （IPv4 一组、IPv6 四组），端口始终是大端十六进制；输出统一为 ip:port 文本。
fn decode_proc_net_address(value: &str) -> Option<String> {
    let (ip_hex, port_hex) = value.rsplit_once(':')?;
    let port = u16::from_str_radix(port_hex, 16).ok()?;

    let ip = match ip_hex.len() {
        // /proc/net/tcp 的 IPv4 是主机字节序，swap_bytes 翻回网络序即为真实地址。
        8 => {
            let raw = u32::from_str_radix(ip_hex, 16).ok()?;
            Ipv4Addr::from(raw.swap_bytes()).to_string()
        }
        // /proc/net/tcp6 按 4 个 32 位字输出，每个字都是主机字节序，需要逐字翻转；
        // 展示加方括号，否则 ::1:22 这类地址无法区分主机部分和端口。
        32 => {
            let mut octets = [0u8; 16];
            for group in 0..4 {
                let word = u32::from_str_radix(ip_hex.get(group * 8..group * 8 + 8)?, 16).ok()?;
                octets[group * 4..group * 4 + 4].copy_from_slice(&word.swap_bytes().to_be_bytes());
            }
            format!("[{}]", Ipv6Addr::from(octets))
        }
        _ => return None,
    };

    Some(format!("{ip}:{port}"))
}

// 判断地址文本的端口是否命中；兼容 ss/netstat 的 ip:port、旧式 ip.port 以及 [::1]:port 写法。
fn address_matches_port(address: &str, port: u16) -> bool {
    address.ends_with(&format!(":{port}")) || address.ends_with(&format!(".{port}"))
}

fn parse_connection_list(contents: &str) -> RuntimeConnectionList {
    // 先收集已解码的地址对；ssh_port/total 元信息在远端输出里位于 conn 行之后，
    // 必须读完所有行才能回填 is_ssh，不能在单次遍历里边读边标记。
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut total = 0usize;
    let mut ssh_port: Option<u16> = None;

    for line in contents.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("total=") {
            total = value.parse().unwrap_or(0);
            continue;
        }
        if let Some(value) = line.strip_prefix("ssh_port=") {
            ssh_port = value.parse().ok();
            continue;
        }

        let Some(entry) = line.strip_prefix("conn ") else {
            continue;
        };
        let mut parts = entry.split_whitespace();
        let (Some(encoding), Some(local_raw), Some(remote_raw)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };

        // hex 来自 /proc/net/tcp，需要解码；plain 来自 ss/netstat，地址已是可读文本。
        let pair = match encoding {
            "hex" => {
                let (Some(local), Some(remote)) = (
                    decode_proc_net_address(local_raw),
                    decode_proc_net_address(remote_raw),
                ) else {
                    continue;
                };
                (local, remote)
            }
            "plain" => (local_raw.to_string(), remote_raw.to_string()),
            _ => continue,
        };
        pairs.push(pair);
    }

    let mut items: Vec<RuntimeConnectionItem> = pairs
        .into_iter()
        .map(|(local, remote)| {
            let is_ssh = ssh_port.is_some_and(|port| address_matches_port(&local, port));
            RuntimeConnectionItem {
                local,
                remote,
                is_ssh,
            }
        })
        .collect();

    // SSH 管理连接置顶，其余按本地地址排序，让展开列表在多次刷新间保持稳定顺序。
    items.sort_by(|left, right| {
        right
            .is_ssh
            .cmp(&left.is_ssh)
            .then_with(|| left.local.cmp(&right.local))
            .then_with(|| left.remote.cmp(&right.remote))
    });

    RuntimeConnectionList {
        items,
        total,
        captured_at: Utc::now().to_rfc3339(),
        error: None,
    }
}

fn parse_cpu_sample(line: &str) -> Option<(u64, u64)> {
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
fn parse_named_cpu_sample(line: &str) -> Option<(String, u64, u64)> {
    let name = line.split_whitespace().next()?.to_string();
    let (idle, total) = parse_cpu_sample(line)?;
    Some((name, idle, total))
}

// 根据前后两次采样计算占用率，使用 saturating_sub 避免远端计数异常回退导致 panic。
fn calculate_cpu_percent(before: (u64, u64), after: (u64, u64)) -> Option<f64> {
    let idle_delta = after.0.saturating_sub(before.0);
    let total_delta = after.1.saturating_sub(before.1);
    if total_delta == 0 {
        return None;
    }

    Some(((total_delta.saturating_sub(idle_delta)) as f64 / total_delta as f64) * 100.0)
}

// 总 CPU 只读取 cpu 聚合行，输出给运行状态主行展示。
fn parse_cpu_percent(contents: &str) -> Option<f64> {
    let mut samples = contents
        .lines()
        .filter_map(parse_named_cpu_sample)
        .filter_map(|(name, idle, total)| (name == "cpu").then_some((idle, total)));
    calculate_cpu_percent(samples.next()?, samples.next()?)
}

// 各核心 CPU 使用同一段采样文本配对计算，前端点击 CPU 主行时再展开显示。
fn parse_cpu_core_percents(contents: &str) -> Vec<RuntimeCpuCore> {
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

fn query_runtime_overview_with_session(
    connection: &ConnectionProfile,
    session: &Session,
) -> Result<RuntimeOverview, AppError> {
    // 运行状态一次性读取所有需要的远端文本，避免 CPU/内存/磁盘等指标各自开 channel 导致刷新发慢。
    let sections = exec_remote_command(session, runtime_overview_command())
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
            let total = parse_meminfo_value(&contents, "MemTotal:")?;
            let available = parse_meminfo_value(&contents, "MemAvailable:")
                .or_else(|| parse_meminfo_value(&contents, "MemFree:"))?;
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

    let connections = sections
        .get("CONNECTIONS")
        .and_then(|contents| parse_connection_counts(contents))
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
        connections,
        network,
        uptime,
    })
}

fn normalize_runtime_resource_source(source: &str) -> &str {
    match source {
        "docker" | "compose" => "docker",
        "podman" => "podman",
        "kubernetes" => "kubernetes",
        _ => "system",
    }
}

fn normalize_runtime_resource_metric(metric: &str) -> &str {
    if metric == "cpu" {
        "cpu"
    } else {
        "memory"
    }
}

fn normalize_runtime_resource_target(target: &str) -> &str {
    if target == "thread" {
        "thread"
    } else {
        "process"
    }
}

fn parse_number_token(token: &str) -> Option<f64> {
    token
        .trim()
        .trim_end_matches('%')
        .replace(',', "")
        .parse::<f64>()
        .ok()
}

fn format_percent_value(value: Option<f64>) -> String {
    value
        .map(|percent| format!("{percent:.1}%"))
        .unwrap_or_else(|| String::from("--"))
}

fn split_whitespace_prefix(line: &str, field_count: usize) -> Option<(Vec<&str>, &str)> {
    let mut fields = Vec::with_capacity(field_count);
    let mut rest = line.trim_start();

    for _ in 0..field_count {
        if rest.is_empty() {
            return None;
        }
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        fields.push(&rest[..end]);
        rest = rest[end..].trim_start();
    }

    Some((fields, rest))
}

fn parse_memory_quantity_bytes(value: &str) -> Option<f64> {
    let token = value
        .split('/')
        .next()
        .unwrap_or(value)
        .trim()
        .trim_end_matches('B');
    let number_end = token
        .char_indices()
        .find_map(|(index, ch)| (!ch.is_ascii_digit() && ch != '.').then_some(index))
        .unwrap_or(token.len());
    let number = token[..number_end].parse::<f64>().ok()?;
    let unit = token[number_end..].trim().to_ascii_lowercase();
    let multiplier = match unit.as_str() {
        "ki" | "k" => 1024.0,
        "mi" | "m" => 1024.0 * 1024.0,
        "gi" | "g" => 1024.0 * 1024.0 * 1024.0,
        "ti" | "t" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => 1.0,
    };

    Some(number * multiplier)
}

fn parse_cpu_quantity_value(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if let Some(milli) = trimmed.strip_suffix('m') {
        return milli.parse::<f64>().ok().map(|value| value / 1000.0);
    }
    trimmed.parse::<f64>().ok()
}

fn runtime_resource_sort_value(item: &RuntimeResourceUsageItem, metric: &str) -> f64 {
    if metric == "cpu" {
        item.cpu_percent
            .or_else(|| parse_cpu_quantity_value(&item.cpu))
            .unwrap_or(-1.0)
    } else {
        item.memory_percent
            .or_else(|| parse_memory_quantity_bytes(&item.memory))
            .unwrap_or(-1.0)
    }
}

fn rank_runtime_resource_items(
    mut items: Vec<RuntimeResourceUsageItem>,
    metric: &str,
    limit: usize,
) -> Vec<RuntimeResourceUsageItem> {
    // 远端命令输出可能没有稳定排序，统一在后端按用户选择的 CPU/内存口径排序并截断。
    items.sort_by(|left, right| {
        runtime_resource_sort_value(right, metric)
            .partial_cmp(&runtime_resource_sort_value(left, metric))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    items
        .into_iter()
        .take(limit)
        .enumerate()
        .map(|(index, mut item)| {
            item.rank = index + 1;
            item
        })
        .collect()
}

fn parse_system_resource_usage(
    contents: &str,
    metric: &str,
    target: &str,
    limit: usize,
) -> RuntimeResourceUsage {
    let mut items = Vec::<RuntimeResourceUsageItem>::new();
    for line in contents.lines().filter(|line| !line.trim().is_empty()) {
        if target == "thread" {
            let Some((fields, detail)) = split_whitespace_prefix(line, 6) else {
                continue;
            };
            let cpu_percent = parse_number_token(fields[3]);
            let memory_percent = parse_number_token(fields[4]);
            let rss = fields[5].parse::<u64>().unwrap_or(0);
            items.push(RuntimeResourceUsageItem {
                rank: 0,
                id: format!("{}/{}", fields[0], fields[1]),
                name: fields[2].to_string(),
                context: format!("PID {} / TID {}", fields[0], fields[1]),
                cpu: format_percent_value(cpu_percent),
                memory: format_kib(rss),
                detail: if detail.is_empty() {
                    fields[2].to_string()
                } else {
                    detail.to_string()
                },
                cpu_percent,
                memory_percent,
            });
            continue;
        }

        let Some((fields, detail)) = split_whitespace_prefix(line, 5) else {
            continue;
        };
        let cpu_percent = parse_number_token(fields[2]);
        let memory_percent = parse_number_token(fields[3]);
        let rss = fields[4].parse::<u64>().unwrap_or(0);
        items.push(RuntimeResourceUsageItem {
            rank: 0,
            id: fields[0].to_string(),
            name: fields[1].to_string(),
            context: format!("PID {}", fields[0]),
            cpu: format_percent_value(cpu_percent),
            memory: format_kib(rss),
            detail: if detail.is_empty() {
                fields[1].to_string()
            } else {
                detail.to_string()
            },
            cpu_percent,
            memory_percent,
        });
    }

    RuntimeResourceUsage {
        source: String::from("system"),
        metric: metric.to_string(),
        target: target.to_string(),
        items: rank_runtime_resource_items(items, metric, limit),
        captured_at: Utc::now().to_rfc3339(),
        error: None,
    }
}

fn parse_container_resource_usage(
    contents: &str,
    metric: &str,
    target: &str,
    limit: usize,
    source: &str,
    context: &str,
) -> RuntimeResourceUsage {
    // Docker 与 Podman 命令统一输出五列管道格式；解析时保留真实来源，供前端显示当前采集引擎。
    let mut items = Vec::<RuntimeResourceUsageItem>::new();
    for line in contents.lines().filter(|line| !line.trim().is_empty()) {
        let parts = line.split('|').map(str::trim).collect::<Vec<_>>();
        if parts.len() < 5 {
            continue;
        }
        let cpu_percent = parse_number_token(parts[2]);
        let memory_percent = parse_number_token(parts[4]);
        let memory = parts[3].split('/').next().unwrap_or(parts[3]).trim();
        items.push(RuntimeResourceUsageItem {
            rank: 0,
            id: parts[0].to_string(),
            name: parts[1].to_string(),
            context: context.to_string(),
            cpu: parts[2].to_string(),
            memory: memory.to_string(),
            detail: parts[3].to_string(),
            cpu_percent,
            memory_percent,
        });
    }

    RuntimeResourceUsage {
        source: source.to_string(),
        metric: metric.to_string(),
        target: target.to_string(),
        items: rank_runtime_resource_items(items, metric, limit),
        captured_at: Utc::now().to_rfc3339(),
        error: None,
    }
}

fn parse_kubernetes_resource_usage(
    contents: &str,
    metric: &str,
    target: &str,
    limit: usize,
) -> RuntimeResourceUsage {
    let mut items = Vec::<RuntimeResourceUsageItem>::new();
    for line in contents.lines().filter(|line| !line.trim().is_empty()) {
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.len() < 4 {
            continue;
        }
        items.push(RuntimeResourceUsageItem {
            rank: 0,
            id: format!("{}/{}", parts[0], parts[1]),
            name: parts[1].to_string(),
            context: parts[0].to_string(),
            cpu: parts[2].to_string(),
            memory: parts[3].to_string(),
            detail: format!("namespace {}", parts[0]),
            cpu_percent: parse_cpu_quantity_value(parts[2]),
            memory_percent: None,
        });
    }

    RuntimeResourceUsage {
        source: String::from("kubernetes"),
        metric: metric.to_string(),
        target: target.to_string(),
        items: rank_runtime_resource_items(items, metric, limit),
        captured_at: Utc::now().to_rfc3339(),
        error: None,
    }
}

fn query_system_resource_usage_with_session(
    session: &Session,
    metric: &str,
    target: &str,
    limit: usize,
) -> Result<RuntimeResourceUsage, AppError> {
    let sort_field = if metric == "cpu" { "pcpu" } else { "rss" };
    // ps 只在内存行展开时执行；线程模式读取 LWP，进程模式读取 PID，避免常规刷新额外消耗远端资源。
    // 不读取完整 args，减少遍历 /proc/cmdline 和传输长命令行的成本；列表悬浮信息用 comm 兜底即可。
    let command = if target == "thread" {
        format!(
            "sh -lc 'LC_ALL=C ps -eLo pid=,lwp=,comm=,pcpu=,pmem=,rss= --sort=-{sort_field} 2>/dev/null | head -n {limit}'"
        )
    } else {
        format!(
            "sh -lc 'LC_ALL=C ps -eo pid=,comm=,pcpu=,pmem=,rss= --sort=-{sort_field} 2>/dev/null | head -n {limit}'"
        )
    };
    let contents = exec_remote_command(session, &command).unwrap_or_default();
    Ok(parse_system_resource_usage(
        &contents, metric, target, limit,
    ))
}

fn query_docker_resource_usage_with_session(
    session: &Session,
    metric: &str,
    target: &str,
    limit: usize,
) -> Result<RuntimeResourceUsage, AppError> {
    // Docker stats 覆盖普通 Docker 和 Docker Compose 容器，按容器粒度展示资源占用。
    let command = r#"sh -lc 'command -v docker >/dev/null 2>&1 || exit 0; if command -v timeout >/dev/null 2>&1; then timeout 3s docker stats --no-stream --format "{{.Container}}|{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}" 2>/dev/null || true; else docker stats --no-stream --format "{{.Container}}|{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}" 2>/dev/null || true; fi'"#;
    let contents = exec_remote_command(session, command).unwrap_or_default();
    Ok(parse_container_resource_usage(
        &contents, metric, target, limit, "docker", "Docker",
    ))
}

fn query_podman_resource_usage_with_session(
    session: &Session,
    metric: &str,
    target: &str,
    limit: usize,
) -> Result<RuntimeResourceUsage, AppError> {
    // Podman 模板字段与 Docker 的容器 ID 字段不同，主动适配后再复用统一的容器统计解析格式。
    let command = r#"sh -lc 'command -v podman >/dev/null 2>&1 || exit 0; if command -v timeout >/dev/null 2>&1; then timeout 3s podman stats --no-stream --format "{{.ID}}|{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}" 2>/dev/null || true; else podman stats --no-stream --format "{{.ID}}|{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}" 2>/dev/null || true; fi'"#;
    let contents = exec_remote_command(session, command).unwrap_or_default();
    Ok(parse_container_resource_usage(
        &contents, metric, target, limit, "podman", "Podman",
    ))
}

fn query_kubernetes_resource_usage_with_session(
    session: &Session,
    metric: &str,
    target: &str,
    limit: usize,
) -> Result<RuntimeResourceUsage, AppError> {
    // kubectl top 依赖远端已配置 kubeconfig 和 metrics-server；不可用时保持空结果，由前端提示。
    let contents = exec_remote_command(
        session,
        "sh -lc 'command -v kubectl >/dev/null 2>&1 || exit 0; if command -v timeout >/dev/null 2>&1; then timeout 3s kubectl top pods -A --no-headers 2>/dev/null || true; else kubectl top pods -A --no-headers 2>/dev/null || true; fi'",
    )
    .unwrap_or_default();
    Ok(parse_kubernetes_resource_usage(
        &contents, metric, target, limit,
    ))
}

fn query_runtime_resource_usage_with_session(
    session: &Session,
    request: &RuntimeResourceUsageRequest,
) -> Result<RuntimeResourceUsage, AppError> {
    let source = normalize_runtime_resource_source(&request.source);
    let metric = normalize_runtime_resource_metric(&request.metric);
    let target = normalize_runtime_resource_target(&request.target);
    let limit = request.limit.clamp(1, 20);

    let usage = match source {
        "system" => query_system_resource_usage_with_session(session, metric, target, limit)?,
        "docker" => query_docker_resource_usage_with_session(session, metric, target, limit)?,
        "podman" => query_podman_resource_usage_with_session(session, metric, target, limit)?,
        "kubernetes" => {
            query_kubernetes_resource_usage_with_session(session, metric, target, limit)?
        }
        _ => query_system_resource_usage_with_session(session, metric, target, limit)?,
    };

    if usage.items.is_empty() {
        Ok(RuntimeResourceUsage {
            error: Some(String::from("No resource usage data available.")),
            ..usage
        })
    } else {
        Ok(usage)
    }
}

#[cfg(test)]
mod runtime_resource_usage_tests {
    use super::{normalize_runtime_resource_source, parse_container_resource_usage};

    #[test]
    fn normalizes_podman_without_falling_back_to_system() {
        // Podman 必须保留独立来源，否则保存后的设置会误走系统进程采集分支。
        assert_eq!(normalize_runtime_resource_source("podman"), "podman");
    }

    #[test]
    fn parses_and_ranks_podman_container_stats() {
        // 模拟 Podman Go 模板的五列输出，验证来源、上下文和按内存占用排序均保持正确。
        let contents = concat!(
            "small|worker|2.00%|64MiB / 1GiB|6.25%\n",
            "large|api|8.50%|256MiB / 1GiB|25.00%\n",
        );
        let usage =
            parse_container_resource_usage(contents, "memory", "process", 2, "podman", "Podman");

        assert_eq!(usage.source, "podman");
        assert_eq!(usage.items.len(), 2);
        assert_eq!(usage.items[0].id, "large");
        assert_eq!(usage.items[0].context, "Podman");
        assert_eq!(usage.items[0].rank, 1);
    }
}

// 解析 `du -k` 的单行输出，保留带空格的路径并把 KiB 转成前端可读大小。
fn parse_runtime_storage_file_line(line: &str, index: usize) -> Option<RuntimeStorageFileItem> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let (size_text, path_text) = trimmed.split_once(char::is_whitespace)?;
    let size_kib = size_text.trim().parse::<u64>().ok()?;
    let path = path_text.trim().to_string();
    if path.is_empty() {
        return None;
    }

    // 远端路径统一按 Unix 分隔符处理；根目录文件或异常路径缺少文件名时用完整路径兜底。
    let name = path
        .rsplit('/')
        .find(|segment| !segment.is_empty())
        .unwrap_or(path.as_str())
        .to_string();

    Some(RuntimeStorageFileItem {
        rank: index + 1,
        name,
        path,
        size: format_kib(size_kib),
        size_kib,
    })
}

// 汇总远端最大文件扫描结果；解析失败的行直接丢弃，避免一行异常拖垮整个面板。
fn parse_runtime_storage_files(contents: &str) -> RuntimeStorageFiles {
    RuntimeStorageFiles {
        items: contents
            .lines()
            .enumerate()
            .filter_map(|(index, line)| parse_runtime_storage_file_line(line, index))
            .collect(),
        captured_at: Utc::now().to_rfc3339(),
        error: None,
    }
}

fn query_runtime_storage_files_with_session(
    session: &Session,
) -> Result<RuntimeStorageFiles, AppError> {
    // 存储行展示的是根文件系统用量，因此最大文件扫描也限制在 / 所在文件系统，避免跨挂载点扫全机。
    // 优先用 GNU find 的 %k 直接输出文件占用块数，减少为每个文件执行 du 的开销；不支持时再退回 du。
    // timeout 只限制扫描阶段，扫描超时后仍把已发现的部分结果交给 sort/head，避免界面误报“没有文件”。
    // 列表只取前 6 个大文件，降低远端排序输出和左侧栏渲染成本。
    // 辅助 SSH 会话读超时是 10 秒，这里把远端扫描压到 4 秒，给 sort/head 和网络传输留下余量。
    let command = r#"sh -lc 'limit=6; scan_timeout=4; command -v timeout >/dev/null 2>&1 || exit 0; if find / -maxdepth 0 -printf "" >/dev/null 2>&1; then { timeout "$scan_timeout" find / -xdev -type f -printf "%k\t%p\n" 2>/dev/null || true; } else { timeout "$scan_timeout" find / -xdev -type f -exec du -k {} + 2>/dev/null || true; } fi | sort -rn | head -n "$limit"'"#;
    let contents = match exec_remote_command(session, command) {
        Ok(contents) => contents,
        Err(error) => {
            return Ok(RuntimeStorageFiles {
                items: Vec::new(),
                captured_at: Utc::now().to_rfc3339(),
                error: Some(error.to_string()),
            });
        }
    };
    Ok(parse_runtime_storage_files(&contents))
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

pub(super) fn query_runtime_overview_cached(
    state: &AppState,
    connection: &ConnectionProfile,
) -> Result<RuntimeOverview, AppError> {
    with_auxiliary_session(state, connection, |auxiliary| {
        query_runtime_overview_with_session(connection, &auxiliary.session)
    })
}

pub(super) fn query_runtime_resource_usage_cached(
    state: &AppState,
    connection: &ConnectionProfile,
    request: &RuntimeResourceUsageRequest,
) -> Result<RuntimeResourceUsage, AppError> {
    with_auxiliary_session(state, connection, |auxiliary| {
        query_runtime_resource_usage_with_session(&auxiliary.session, request)
    })
}

// 复用辅助 SSH 会话执行最大文件扫描，避免展开存储明细时占用主终端会话。
pub(super) fn query_runtime_storage_files_cached(
    state: &AppState,
    connection: &ConnectionProfile,
) -> Result<RuntimeStorageFiles, AppError> {
    with_auxiliary_session(state, connection, |auxiliary| {
        query_runtime_storage_files_with_session(&auxiliary.session)
    })
}

fn query_runtime_connection_list_with_session(
    session: &Session,
) -> Result<RuntimeConnectionList, AppError> {
    match exec_remote_command(session, connection_list_command()) {
        Ok(contents) => Ok(parse_connection_list(&contents)),
        // 与存储明细一致：采集失败把错误带回前端占位区展示，保留旧列表，避免一次抖动清空界面。
        Err(error) => Ok(RuntimeConnectionList {
            captured_at: Utc::now().to_rfc3339(),
            error: Some(error.to_string()),
            ..Default::default()
        }),
    }
}

// 连接明细只在连接数行展开时按需执行，复用辅助会话，避免占用主终端会话或每次常规刷新都读网络表。
pub(super) fn query_runtime_connection_list_cached(
    state: &AppState,
    connection: &ConnectionProfile,
) -> Result<RuntimeConnectionList, AppError> {
    with_auxiliary_session(state, connection, |auxiliary| {
        query_runtime_connection_list_with_session(&auxiliary.session)
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
