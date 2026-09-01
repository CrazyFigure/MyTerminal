//! 远端运行指标采集适配器。
//! 负责 Linux CPU、内存、存储、容器/Kubernetes 资源与连接明细的命令生成、解析和缓存会话调用。

use std::collections::HashMap;

use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StaticRuntimeInfo {
    pub os: String,
    pub primary_address: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CpuCounters {
    pub idle: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct RawCpuSample {
    pub aggregate_cpu: Option<CpuCounters>,
    pub cpu_cores: HashMap<String, CpuCounters>,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RawRuntimeSample {
    pub cpu_sample: RawCpuSample,
    pub memory: RuntimeMemoryMetric,
    pub storage: RuntimeStorageMetric,
    pub connections: RuntimeConnectionMetric,
    pub uptime_seconds: Option<u64>,
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

pub(crate) fn parse_memory_metric(contents: &str) -> RuntimeMemoryMetric {
    let total_kib = parse_meminfo_value(contents, "MemTotal:");
    let available_kib = parse_meminfo_value(contents, "MemAvailable:")
        .or_else(|| parse_meminfo_value(contents, "MemFree:"));

    let used_kib = match (total_kib, available_kib) {
        (Some(total), Some(available)) => Some(total.saturating_sub(available)),
        _ => None,
    };

    let percent = match (used_kib, total_kib) {
        (Some(used), Some(total)) if total > 0 => {
            Some(((used as f64 / total as f64) * 100.0).clamp(0.0, 100.0))
        }
        _ => None,
    };

    RuntimeMemoryMetric {
        percent,
        used_kib,
        total_kib,
    }
}

pub(crate) fn parse_storage_metric(contents: &str) -> RuntimeStorageMetric {
    // df -Pk / 输出通常第二行为挂载点 / 的用量统计
    let Some(line) = contents.lines().nth(1) else {
        return RuntimeStorageMetric {
            percent: None,
            mount: "/".into(),
            used_kib: None,
            total_kib: None,
        };
    };

    let parts = line.split_whitespace().collect::<Vec<_>>();
    if parts.len() < 5 {
        return RuntimeStorageMetric {
            percent: None,
            mount: "/".into(),
            used_kib: None,
            total_kib: None,
        };
    }

    let total_kib = parts.get(1).and_then(|s| s.parse::<u64>().ok());
    let used_kib = parts.get(2).and_then(|s| s.parse::<u64>().ok());
    let mount = parts.get(5).unwrap_or(&"/").to_string();

    let percent = match (used_kib, total_kib) {
        (Some(used), Some(total)) if total > 0 => {
            Some(((used as f64 / total as f64) * 100.0).clamp(0.0, 100.0))
        }
        _ => None,
    };

    RuntimeStorageMetric {
        percent,
        mount,
        used_kib,
        total_kib,
    }
}

pub(crate) fn parse_connection_metric(contents: &str) -> RuntimeConnectionMetric {
    let mut tcp_established = None;
    let mut ssh_established = None;

    for token in contents.split_whitespace() {
        if let Some(value) = token.strip_prefix("tcp=") {
            tcp_established = value.parse::<u64>().ok();
            continue;
        }

        if let Some(value) = token.strip_prefix("ssh=") {
            if value != "--" {
                ssh_established = value.parse::<u64>().ok();
            }
        }
    }

    RuntimeConnectionMetric {
        tcp_established,
        ssh_established,
    }
}

pub(crate) fn parse_uptime_seconds(contents: &str) -> Option<u64> {
    contents
        .split_whitespace()
        .next()?
        .split('.')
        .next()?
        .parse::<u64>()
        .ok()
}

fn parse_cpu_counters_line(line: &str) -> Option<(String, CpuCounters)> {
    let mut iter = line.split_whitespace();
    let name = iter.next()?.to_string();
    let values = iter
        .filter_map(|value| value.parse::<u64>().ok())
        .collect::<Vec<_>>();
    if values.len() < 4 {
        return None;
    }

    // /proc/stat 的 idle/iowait 属于空闲时间，其余字段都按总时间计入 CPU 采样窗口。
    let idle = values.get(3).copied().unwrap_or(0) + values.get(4).copied().unwrap_or(0);
    let total = values.iter().copied().sum::<u64>();
    Some((name, CpuCounters { idle, total }))
}

pub(crate) fn parse_raw_cpu_sample(contents: &str) -> RawCpuSample {
    let mut aggregate_cpu = None;
    let mut cpu_cores = HashMap::new();

    for line in contents.lines() {
        if let Some((name, counters)) = parse_cpu_counters_line(line) {
            if name == "cpu" {
                aggregate_cpu = Some(counters);
            } else if name.starts_with("cpu") {
                cpu_cores.insert(name, counters);
            }
        }
    }

    RawCpuSample {
        aggregate_cpu,
        cpu_cores,
    }
}

pub(crate) fn calculate_cpu_counter_percent(
    previous: &CpuCounters,
    current: &CpuCounters,
) -> Option<f64> {
    // 计数器倒退（远端重启/溢出）时返回 None，提示上层重建 baseline
    if current.total < previous.total || current.idle < previous.idle {
        return None;
    }

    let total_delta = current.total.saturating_sub(previous.total);
    let idle_delta = current.idle.saturating_sub(previous.idle);
    if total_delta == 0 {
        return None;
    }

    let busy_delta = total_delta.saturating_sub(idle_delta);
    Some(((busy_delta as f64 / total_delta as f64) * 100.0).clamp(0.0, 100.0))
}

pub(crate) fn calculate_cpu_delta(
    previous: Option<&RawCpuSample>,
    current: &RawCpuSample,
) -> (RuntimePercentMetric, Vec<RuntimeCpuCore>) {
    let Some(prev) = previous else {
        return (RuntimePercentMetric { percent: None }, Vec::new());
    };

    let aggregate_percent = match (&prev.aggregate_cpu, &current.aggregate_cpu) {
        (Some(p), Some(c)) => calculate_cpu_counter_percent(p, c),
        _ => None,
    };

    let mut cores = Vec::new();
    for (name, curr_counters) in &current.cpu_cores {
        if let Some(prev_counters) = prev.cpu_cores.get(name) {
            if let Some(percent) = calculate_cpu_counter_percent(prev_counters, curr_counters) {
                cores.push(RuntimeCpuCore {
                    name: name.replacen("cpu", "CPU ", 1),
                    percent,
                });
            }
        }
    }

    // 核心按数字自然排序，例如 CPU 0, CPU 1, CPU 2 ...
    cores.sort_by(|a, b| {
        let a_num = a
            .name
            .strip_prefix("CPU ")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(usize::MAX);
        let b_num = b
            .name
            .strip_prefix("CPU ")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(usize::MAX);
        a_num.cmp(&b_num).then_with(|| a.name.cmp(&b.name))
    });

    (
        RuntimePercentMetric {
            percent: aggregate_percent,
        },
        cores,
    )
}

/// 静态信息采集命令：在专用 SSH 会话建立后采一次。
pub(crate) fn runtime_static_info_command() -> &'static str {
    r#"sh -lc '
printf "__MYTERMINAL_OS__\n"
(uname -srmo 2>/dev/null || uname -a 2>/dev/null || true)
printf "\n__MYTERMINAL_HOSTIP__\n"
hostname -I 2>/dev/null || true
'"#
}

/// 单次动态采样命令：单次读取 /proc/stat，无 sleep 0.2。
pub(crate) fn runtime_dynamic_sample_command() -> &'static str {
    r#"sh -lc '
printf "__MYTERMINAL_CPUSTAT__\n"
grep -E "^cpu[0-9 ]" /proc/stat 2>/dev/null || true
printf "\n__MYTERMINAL_MEMINFO__\n"
cat /proc/meminfo 2>/dev/null || true
printf "\n__MYTERMINAL_DF__\n"
df -Pk / 2>/dev/null || true
printf "\n__MYTERMINAL_CONNECTIONS__\n"

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

printf "\n__MYTERMINAL_UPTIME__\n"
cat /proc/uptime 2>/dev/null || true
'"#
}

pub(crate) fn parse_static_runtime_info(sections: &HashMap<String, String>) -> StaticRuntimeInfo {
    let os = sections
        .get("OS")
        .filter(|contents| !contents.is_empty())
        .cloned()
        .unwrap_or_else(|| String::from("Unknown"));

    let primary_address = sections
        .get("HOSTIP")
        .and_then(|contents| contents.split_whitespace().next().map(ToString::to_string));

    StaticRuntimeInfo {
        os,
        primary_address,
    }
}

pub(crate) fn parse_dynamic_runtime_sample(
    sections: &HashMap<String, String>,
) -> RawRuntimeSample {
    let cpu_sample = sections
        .get("CPUSTAT")
        .map(|contents| parse_raw_cpu_sample(contents))
        .unwrap_or_default();

    let memory = sections
        .get("MEMINFO")
        .map(|contents| parse_memory_metric(contents))
        .unwrap_or_default();

    let storage = sections
        .get("DF")
        .map(|contents| parse_storage_metric(contents))
        .unwrap_or_default();

    let connections = sections
        .get("CONNECTIONS")
        .map(|contents| parse_connection_metric(contents))
        .unwrap_or_default();

    let uptime_seconds = sections
        .get("UPTIME")
        .and_then(|contents| parse_uptime_seconds(contents));

    RawRuntimeSample {
        cpu_sample,
        memory,
        storage,
        connections,
        uptime_seconds,
    }
}

pub(crate) fn build_runtime_overview_snapshot(
    static_info: &StaticRuntimeInfo,
    previous_cpu: Option<&RawCpuSample>,
    current_sample: &RawRuntimeSample,
    fallback_host: &str,
) -> RuntimeOverviewSnapshot {
    let (cpu, cpu_cores) = calculate_cpu_delta(previous_cpu, &current_sample.cpu_sample);

    RuntimeOverviewSnapshot {
        schema_version: 1,
        host: fallback_host.to_string(),
        os: static_info.os.clone(),
        primary_address: static_info.primary_address.clone(),
        captured_at: Utc::now().to_rfc3339(),
        cpu,
        cpu_cores,
        memory: current_sample.memory.clone(),
        storage: current_sample.storage.clone(),
        connections: current_sample.connections.clone(),
        uptime_seconds: current_sample.uptime_seconds,
    }
}

pub(crate) fn query_static_runtime_info_with_session(
    session: &Session,
) -> Result<StaticRuntimeInfo, AppError> {
    // Channel/transport 失败必须上抛给 worker 触发重连；命令内部已对单字段缺失使用 `|| true` 降级。
    let contents = exec_remote_command(session, runtime_static_info_command())?;
    let sections = parse_marked_sections(&contents);
    Ok(parse_static_runtime_info(&sections))
}

pub(crate) fn query_dynamic_runtime_sample_with_session(
    session: &Session,
) -> Result<RawRuntimeSample, AppError> {
    // 传输错误不能伪装成一份全空成功快照，否则 worker 永远不会丢弃失效 Session。
    let contents = exec_remote_command(session, runtime_dynamic_sample_command())?;
    let sections = parse_marked_sections(&contents);
    Ok(parse_dynamic_runtime_sample(&sections))
}

/// 构造连接明细采集命令。与运行状态概览不同，明细只在连接数行展开时按需执行。
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

/// 解码 /proc/net/tcp{,6} 的十六进制地址。
pub(super) fn decode_proc_net_address(value: &str) -> Option<String> {
    let (ip_hex, port_hex) = value.rsplit_once(':')?;
    let port = u16::from_str_radix(port_hex, 16).ok()?;

    let ip = match ip_hex.len() {
        8 => {
            let raw = u32::from_str_radix(ip_hex, 16).ok()?;
            Ipv4Addr::from(raw.swap_bytes()).to_string()
        }
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

fn address_matches_port(address: &str, port: u16) -> bool {
    address.ends_with(&format!(":{port}")) || address.ends_with(&format!(".{port}"))
}

pub(super) fn parse_connection_list(contents: &str) -> RuntimeConnectionList {
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

mod resource_usage;
pub(crate) use resource_usage::query_runtime_resource_usage_with_session;

// 进程/线程明细仍使用紧凑可读文本展示 RSS；概览的内存与存储保持纯数值 DTO。
fn format_kib(kib: u64) -> String {
    let gib = kib as f64 / 1024.0 / 1024.0;
    if gib >= 1.0 {
        format!("{gib:.1} GB")
    } else {
        format!("{:.0} MB", kib as f64 / 1024.0)
    }
}

pub(crate) fn query_runtime_connection_list_with_session(
    session: &Session,
) -> Result<RuntimeConnectionList, AppError> {
    match exec_remote_command(session, connection_list_command()) {
        Ok(contents) => Ok(parse_connection_list(&contents)),
        Err(error) => Ok(RuntimeConnectionList {
            captured_at: Utc::now().to_rfc3339(),
            error: Some(error.to_string()),
            ..Default::default()
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        RuntimeConnectionMetric, RuntimeCpuCore, RuntimeMemoryMetric, RuntimeOverviewEvent,
        RuntimeOverviewSnapshot, RuntimePercentMetric, RuntimeStorageMetric,
    };

    #[test]
    fn calculates_cpu_percent_from_two_samples() {
        let sample1 = CpuCounters {
            idle: 1000,
            total: 2000,
        };
        let sample2 = CpuCounters {
            idle: 1100,
            total: 2200,
        };
        // total_delta = 200, idle_delta = 100, busy_delta = 100 -> 50%
        let percent = calculate_cpu_counter_percent(&sample1, &sample2);
        assert_eq!(percent, Some(50.0));
    }

    #[test]
    fn pairs_cpu_cores_by_name() {
        let mut cores1 = HashMap::new();
        cores1.insert("cpu1".into(), CpuCounters { idle: 500, total: 1000 });
        cores1.insert("cpu0".into(), CpuCounters { idle: 400, total: 1000 });

        let mut cores2 = HashMap::new();
        cores2.insert("cpu0".into(), CpuCounters { idle: 450, total: 1100 }); // total delta 100, idle 50 -> 50%
        cores2.insert("cpu1".into(), CpuCounters { idle: 520, total: 1100 }); // total delta 100, idle 20 -> 80%

        let prev = RawCpuSample {
            aggregate_cpu: None,
            cpu_cores: cores1,
        };
        let curr = RawCpuSample {
            aggregate_cpu: None,
            cpu_cores: cores2,
        };

        let (_agg, core_list) = calculate_cpu_delta(Some(&prev), &curr);
        assert_eq!(core_list.len(), 2);
        assert_eq!(core_list[0].name, "CPU 0");
        assert_eq!(core_list[0].percent, 50.0);
        assert_eq!(core_list[1].name, "CPU 1");
        assert_eq!(core_list[1].percent, 80.0);
    }

    #[test]
    fn zero_delta_returns_none() {
        let sample = CpuCounters {
            idle: 1000,
            total: 2000,
        };
        assert_eq!(calculate_cpu_counter_percent(&sample, &sample), None);
    }

    #[test]
    fn counter_rollback_returns_none() {
        let sample1 = CpuCounters {
            idle: 2000,
            total: 4000,
        };
        let sample2 = CpuCounters {
            idle: 1000,
            total: 2000,
        };
        assert_eq!(calculate_cpu_counter_percent(&sample1, &sample2), None);
    }

    #[test]
    fn handles_added_and_removed_cores() {
        let mut cores1 = HashMap::new();
        cores1.insert("cpu0".into(), CpuCounters { idle: 100, total: 200 });
        cores1.insert("cpu1".into(), CpuCounters { idle: 100, total: 200 });

        let mut cores2 = HashMap::new();
        cores2.insert("cpu1".into(), CpuCounters { idle: 150, total: 300 });
        cores2.insert("cpu2".into(), CpuCounters { idle: 100, total: 200 }); // new core

        let prev = RawCpuSample {
            aggregate_cpu: None,
            cpu_cores: cores1,
        };
        let curr = RawCpuSample {
            aggregate_cpu: None,
            cpu_cores: cores2,
        };

        let (_agg, core_list) = calculate_cpu_delta(Some(&prev), &curr);
        // Only cpu1 has both before & after
        assert_eq!(core_list.len(), 1);
        assert_eq!(core_list[0].name, "CPU 1");
        assert_eq!(core_list[0].percent, 50.0);
    }

    #[test]
    fn parses_meminfo_with_fallback_to_memfree() {
        let meminfo_available = "MemTotal:       16384000 kB\nMemAvailable:    8192000 kB\n";
        let parsed = parse_memory_metric(meminfo_available);
        assert_eq!(parsed.total_kib, Some(16384000));
        assert_eq!(parsed.used_kib, Some(8192000));
        assert_eq!(parsed.percent, Some(50.0));

        let meminfo_free_fallback = "MemTotal:       16384000 kB\nMemFree:         4096000 kB\n";
        let parsed_fallback = parse_memory_metric(meminfo_free_fallback);
        assert_eq!(parsed_fallback.total_kib, Some(16384000));
        assert_eq!(parsed_fallback.used_kib, Some(12288000));
        assert_eq!(parsed_fallback.percent, Some(75.0));
    }

    #[test]
    fn handles_df_pk_invalid_output() {
        let invalid = "Filesystem\n";
        let metric = parse_storage_metric(invalid);
        assert_eq!(metric.percent, None);
        assert_eq!(metric.used_kib, None);
        assert_eq!(metric.total_kib, None);

        let valid = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000000 300000 700000 30% /\n";
        let metric_valid = parse_storage_metric(valid);
        assert_eq!(metric_valid.total_kib, Some(1000000));
        assert_eq!(metric_valid.used_kib, Some(300000));
        assert_eq!(metric_valid.percent, Some(30.0));
        assert_eq!(metric_valid.mount, "/");
    }

    #[test]
    fn parses_connection_metric_with_missing_ssh() {
        let text = "tcp=42 ssh=--";
        let metric = parse_connection_metric(text);
        assert_eq!(metric.tcp_established, Some(42));
        assert_eq!(metric.ssh_established, None);

        let text2 = "tcp=10 ssh=2";
        let metric2 = parse_connection_metric(text2);
        assert_eq!(metric2.tcp_established, Some(10));
        assert_eq!(metric2.ssh_established, Some(2));
    }

    #[test]
    fn parses_uptime_float_to_seconds() {
        let text = "350284.82 280123.12\n";
        assert_eq!(parse_uptime_seconds(text), Some(350284));
    }

    #[test]
    fn serializes_event_to_tagged_camelcase_json() {
        let snapshot = RuntimeOverviewSnapshot {
            schema_version: 1,
            host: "test.local".into(),
            os: "Linux 6.1".into(),
            primary_address: Some("192.168.1.100".into()),
            captured_at: "2026-09-01T12:00:00Z".into(),
            cpu: RuntimePercentMetric { percent: Some(25.5) },
            cpu_cores: vec![RuntimeCpuCore {
                name: "CPU 0".into(),
                percent: 25.5,
            }],
            memory: RuntimeMemoryMetric {
                percent: Some(40.0),
                used_kib: Some(4096),
                total_kib: Some(10240),
            },
            storage: RuntimeStorageMetric {
                percent: Some(60.0),
                mount: "/".into(),
                used_kib: Some(60000),
                total_kib: Some(100000),
            },
            connections: RuntimeConnectionMetric {
                tcp_established: Some(15),
                ssh_established: Some(2),
            },
            uptime_seconds: Some(3600),
        };

        let event = RuntimeOverviewEvent::Snapshot {
            subscription_id: "sub-123".into(),
            connection_id: "conn-abc".into(),
            sequence: 1,
            snapshot,
        };

        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""kind":"snapshot""#));
        assert!(json.contains(r#""subscriptionId":"sub-123""#));
        assert!(json.contains(r#""connectionId":"conn-abc""#));
        assert!(json.contains(r#""schemaVersion":1"#));
        assert!(json.contains(r#""primaryAddress":"192.168.1.100""#));
        assert!(json.contains(r#""usedKib":4096"#));
    }
}
