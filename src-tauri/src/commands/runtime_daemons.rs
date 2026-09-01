use crate::state::RuntimeOverviewMonitorControl;

use super::*;

pub(super) fn stop_all_runtimes(state: &AppState) -> Result<(), AppError> {
    let mut sessions = lock_sessions(state)?;
    for runtime in sessions.drain().map(|(_, runtime)| runtime) {
        runtime.stop_flag.store(true, Ordering::Relaxed);
        let _ = runtime.control_tx.send(SessionControl::Close);
    }
    drop(sessions);
    clear_auxiliary_sessions(state);
    clear_runtime_detail_sessions(state);

    if let Ok(mut monitors) = state.runtime_overview_monitors.lock() {
        for (_, runtime) in monitors.drain() {
            let _ = runtime.control_tx.send(RuntimeOverviewMonitorControl::Stop);
        }
    }

    let mut tunnels = lock_tunnels(state)?;
    for runtime in tunnels.drain().map(|(_, runtime)| runtime) {
        runtime.stop_flag.store(true, Ordering::Relaxed);
    }
    drop(tunnels);
    clear_tunnel_ssh_pools(state);
    Ok(())
}

#[cfg(windows)]
fn terminate_myterminal_cli_processes() -> Result<(), AppError> {
    let script = "Get-CimInstance Win32_Process -Filter \"name like 'myterminal-cli%.exe'\" | \
         Where-Object { \
             ($_.Name -eq 'myterminal-cli.exe' -or $_.Name -like 'myterminal-cli-*.exe') -and \
             $_.CommandLine -match '(?i)(?:^|\\s)mcp\\s+--stdio(?:\\s|$)' \
         } | \
         ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";

    // MCP stdio 进程由 Codex/Claude 等外部客户端启动，可执行文件可能来自安装目录、
    // 开发 target 目录或带 target-triple 后缀的 sidecar，不能再用主程序旁的固定路径筛选。
    // 同时校验进程名和完整 `mcp --stdio` 参数，避免影响正在执行普通 CLI 命令的进程。
    // 发布版主进程没有控制台，关闭应用时启动 PowerShell 必须隐藏窗口，避免退出瞬间闪出黑框。
    Command::new("powershell")
        .creation_flags(WINDOWS_CREATE_NO_WINDOW)
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .status()
        .map(|_| ())
        .map_err(AppError::from)
}

#[cfg(not(windows))]
fn terminate_myterminal_cli_processes() -> Result<(), AppError> {
    // 非 Windows 平台暂不主动扫进程；MCP stdio 客户端正常关闭 stdin 时 CLI 会自然退出。
    Ok(())
}

pub fn prepare_agent_bridge_startup() -> Result<(), AppError> {
    // 每次启用 MCP Bridge 前先关闭旧 stdio 后端，确保客户端重新连接到新编译/新配置的 CLI。
    terminate_myterminal_cli_processes()
}

/// 后台 SSH 保活守护线程：周期性向辅助会话与隧道池会话发送协议级 keepalive，
/// 避免它们在应用后台运行时被服务端/NAT 因空闲回收。交互终端在自己的 shell 循环里保活，此处不处理。
/// 只有进程未被系统挂起时才生效；Windows 后台节流挂起整个进程时无线程可运行，属于系统层限制。
pub fn spawn_keepalive_daemon(app_handle: tauri::AppHandle) {
    thread::spawn(move || loop {
        // 每轮读取最新保活间隔（0=关闭）；用 clamp 出一个不小于最小周期的睡眠时长。
        let interval_sec = {
            let state = app_handle.state::<AppState>();
            if state.is_shutting_down.load(Ordering::Relaxed) {
                return;
            }
            state.ssh_keepalive_interval_sec.load(Ordering::Relaxed)
        };

        let sleep_for = if interval_sec == 0 {
            KEEPALIVE_DAEMON_MIN_TICK
        } else {
            Duration::from_secs(interval_sec).max(KEEPALIVE_DAEMON_MIN_TICK)
        };
        thread::sleep(sleep_for);

        let state = app_handle.state::<AppState>();
        if state.is_shutting_down.load(Ordering::Relaxed) {
            return;
        }
        // 无论保活是否开启，每轮都顺带回收空闲超时或超量的辅助连接与监控明细连接，收敛长时间运行的常驻内存。
        evict_idle_auxiliary_sessions(&state);
        evict_idle_runtime_detail_sessions(&state);
        // 间隔为 0 表示用户关闭了保活，本轮不再发 keepalive，仅保持线程存活等待重新开启。
        if state.ssh_keepalive_interval_sec.load(Ordering::Relaxed) == 0 {
            continue;
        }

        // 辅助会话：先克隆出 Arc 列表再逐个 try_lock，避免长时间占用注册表锁；
        // 会话正被文件/状态操作持有时直接跳过，keepalive 可等下一轮。
        let auxiliary = {
            match state.auxiliary_sessions.lock() {
                Ok(map) => map.values().cloned().collect::<Vec<_>>(),
                Err(_) => Vec::new(),
            }
        };
        for session in auxiliary {
            if let Ok(guard) = session.try_lock() {
                let _ = guard.session.keepalive_send();
            }
        }

        // 监控明细会话保活
        let detail_sessions = {
            match state.runtime_detail_sessions.lock() {
                Ok(map) => map.values().cloned().collect::<Vec<_>>(),
                Err(_) => Vec::new(),
            }
        };
        for session in detail_sessions {
            if let Ok(guard) = session.try_lock() {
                let _ = guard.session.keepalive_send();
            }
        }

        // 隧道池会话：在池锁内克隆 Session 句柄（ssh2::Session 是同一底层连接的句柄克隆），
        // 释放池锁后再发 keepalive，避免持池锁做网络调用阻塞 checkout/release。
        let pool_sessions = {
            let mut collected: Vec<Session> = Vec::new();
            if let Ok(pools) = state.tunnel_ssh_pools.lock() {
                for pool in pools.values() {
                    if let Ok(inner) = pool.inner.lock() {
                        for slot in &inner.sessions {
                            if !slot.failed {
                                collected.push(slot.session.clone());
                            }
                        }
                    }
                }
            }
            collected
        };
        for session in pool_sessions {
            let _ = session.keepalive_send();
        }
    });
}

/// SSH 隧道健康监控线程：为每个“有运行中隧道”的连接维持一条独立探测 SSH 连接（与转发池分离，
/// 避免干扰按需扩缩的转发会话），周期性探测底层 SSH 可达性；状态在“运行中/异常”之间变化时更新持久化
/// 并 emit "tunnel-status-changed"，使前端隧道面板实时反映真实连接状态。掉线后下一轮重连成功即自动恢复。
pub fn spawn_tunnel_monitor(app_handle: tauri::AppHandle) {
    thread::spawn(move || {
        // 每连接一条探测会话；仅本监控线程访问，无需加锁。
        let mut probes: std::collections::HashMap<String, Session> =
            std::collections::HashMap::new();
        // 每连接底层探测的连续失败计数，用于阈值去抖。
        let mut fail_counts: std::collections::HashMap<String, u32> =
            std::collections::HashMap::new();
        // 每连接最近一次上报给前端的期望状态，仅在变化时写盘与 emit。
        let mut last_reported: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        loop {
            thread::sleep(TUNNEL_MONITOR_TICK);
            let state = app_handle.state::<AppState>();
            if state.is_shutting_down.load(Ordering::Relaxed) {
                return;
            }
            monitor_tunnel_health(
                &app_handle,
                &state,
                &mut probes,
                &mut fail_counts,
                &mut last_reported,
            );
        }
    });
}

fn monitor_tunnel_health(
    app_handle: &tauri::AppHandle,
    state: &AppState,
    probes: &mut std::collections::HashMap<String, Session>,
    fail_counts: &mut std::collections::HashMap<String, u32>,
    last_reported: &mut std::collections::HashMap<String, String>,
) {
    // 收集当前有运行中隧道的连接 ID（去重）；仅这些连接需要健康探测。
    let connection_ids: Vec<String> = match state.tunnels.lock() {
        Ok(runtimes) => {
            let mut ids: Vec<String> = runtimes
                .values()
                .map(|runtime| runtime.connection_id.clone())
                .collect();
            ids.sort();
            ids.dedup();
            ids
        }
        Err(_) => return,
    };

    // 清理已无运行隧道的连接：丢弃探测会话（关闭底层 SSH）与相关计数缓存。
    probes.retain(|connection_id, _| connection_ids.contains(connection_id));
    fail_counts.retain(|connection_id, _| connection_ids.contains(connection_id));
    last_reported.retain(|connection_id, _| connection_ids.contains(connection_id));

    for connection_id in connection_ids {
        // 复用隧道池保存的连接配置快照，避免重复从磁盘解密；池缺失（异常）时跳过本轮。
        let connection = match lock_tunnel_ssh_pools(state) {
            Ok(pools) => pools
                .get(&connection_id)
                .map(|pool| pool.connection.clone()),
            Err(_) => None,
        };
        let Some(connection) = connection else {
            continue;
        };

        let healthy = probe_tunnel_connection(probes, &connection_id, &connection);
        let fails = fail_counts.entry(connection_id.clone()).or_insert(0);
        if healthy {
            *fails = 0;
        } else {
            *fails = fails.saturating_add(1);
        }
        // 连续失败达到阈值判为异常；否则视为运行中（含单次抖动后立即恢复）。
        let desired = if *fails >= TUNNEL_UNHEALTHY_THRESHOLD {
            "error"
        } else {
            "running"
        };

        if last_reported.get(&connection_id).map(String::as_str) != Some(desired) {
            last_reported.insert(connection_id.clone(), desired.to_string());
            update_and_emit_tunnel_status(app_handle, state, &connection_id, desired);
        }
    }
}

/// 探测某连接底层 SSH 是否可达：已有探测会话则发协议 keepalive 并检查底层 socket 错误码，
/// 会话失效则丢弃并立即尝试重新握手（既作断连检测，也作恢复检测）。
fn probe_tunnel_connection(
    probes: &mut std::collections::HashMap<String, Session>,
    connection_id: &str,
    connection: &ConnectionProfile,
) -> bool {
    if let Some(session) = probes.get(connection_id) {
        // keepalive_send 可能瞬时失败，不据此判定；以底层 socket 非零错误码作为断连的可靠信号。
        let _ = session.keepalive_send();
        let dead = matches!(ssh_socket_error_code(session), Some(code) if code != 0);
        if !dead {
            return true;
        }
        probes.remove(connection_id);
    }
    match connect_ssh(connection) {
        Ok(session) => {
            probes.insert(connection_id.to_string(), session);
            true
        }
        Err(_) => false,
    }
}

/// 把某连接下处于运行/异常态的隧道统一切换为目标状态，落盘并逐条 emit "tunnel-status-changed"。
/// 已 stopped 的隧道不受影响（用户已手动停止）。
fn update_and_emit_tunnel_status(
    app_handle: &tauri::AppHandle,
    state: &AppState,
    connection_id: &str,
    next_status: &str,
) {
    let mut tunnels = match state.storage.load_tunnels() {
        Ok(tunnels) => tunnels,
        Err(_) => return,
    };
    let mut changed: Vec<TunnelRecord> = Vec::new();
    for tunnel in &mut tunnels {
        if tunnel.connection_id == connection_id
            && (tunnel.status == "running" || tunnel.status == "error")
            && tunnel.status != next_status
        {
            tunnel.status = next_status.to_string();
            changed.push(tunnel.clone());
        }
    }
    if changed.is_empty() {
        return;
    }
    let _ = state.storage.save_tunnels(&tunnels);
    for tunnel in changed {
        let _ = app_handle.emit("tunnel-status-changed", tunnel);
    }
}

pub fn shutdown_app_backends(state: &AppState) -> Result<(), AppError> {
    // 退出清理先停 MyTerminal 自己的 SSH 会话和隧道，再停 MCP Bridge 和外部 CLI 后端。
    let mut first_error: Option<AppError> = None;
    if let Err(error) = stop_all_runtimes(state) {
        first_error = Some(error);
    }
    if let Err(error) = agent_bridge::stop_server(&state.agent_bridge, &state.storage) {
        if first_error.is_none() {
            first_error = Some(error);
        }
    }
    if let Err(error) = terminate_myterminal_cli_processes() {
        if first_error.is_none() {
            first_error = Some(error);
        }
    }

    if let Some(error) = first_error {
        Err(error)
    } else {
        Ok(())
    }
}
