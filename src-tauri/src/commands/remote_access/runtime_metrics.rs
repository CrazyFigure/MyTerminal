//! 远端运行指标采集适配器。
//! 负责 Linux CPU、内存、存储、容器/Kubernetes 资源与连接明细的命令生成、解析和缓存会话调用。

use super::*;

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

pub(super) fn parse_connection_counts(contents: &str) -> Option<String> {
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
pub(super) fn runtime_overview_command() -> &'static str {
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
pub(super) fn connection_list_command() -> &'static str {
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
pub(super) fn decode_proc_net_address(value: &str) -> Option<String> {
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

pub(super) fn parse_connection_list(contents: &str) -> RuntimeConnectionList {
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

mod resource_usage;
use resource_usage::query_runtime_resource_usage_with_session;

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

pub(in crate::commands) fn query_runtime_overview_cached(
    state: &AppState,
    connection: &ConnectionProfile,
) -> Result<RuntimeOverview, AppError> {
    with_auxiliary_session(state, connection, |auxiliary| {
        query_runtime_overview_with_session(connection, &auxiliary.session)
    })
}

pub(in crate::commands) fn query_runtime_resource_usage_cached(
    state: &AppState,
    connection: &ConnectionProfile,
    request: &RuntimeResourceUsageRequest,
) -> Result<RuntimeResourceUsage, AppError> {
    with_auxiliary_session(state, connection, |auxiliary| {
        query_runtime_resource_usage_with_session(&auxiliary.session, request)
    })
}

// 复用辅助 SSH 会话执行最大文件扫描，避免展开存储明细时占用主终端会话。
pub(in crate::commands) fn query_runtime_storage_files_cached(
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
pub(in crate::commands) fn query_runtime_connection_list_cached(
    state: &AppState,
    connection: &ConnectionProfile,
) -> Result<RuntimeConnectionList, AppError> {
    with_auxiliary_session(state, connection, |auxiliary| {
        query_runtime_connection_list_with_session(&auxiliary.session)
    })
}
