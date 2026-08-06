//! 系统进程、容器与 Kubernetes 资源明细的规范化、解析、排序和远程查询。

use super::*;

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

pub(super) fn query_runtime_resource_usage_with_session(
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
