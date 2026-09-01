//! 运行监控事件推送服务与监控明细命令。
//! 负责概览监控 Worker 线程的生命周期、独占 SSH 会话管理、控制指令折叠与定向 Webview 事件推送。

use std::{
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread,
    time::Duration,
};

use tauri::{AppHandle, Emitter, EventTarget, State, WebviewWindow};
use uuid::Uuid;

use crate::{
    commands::{
        connect_ssh, drop_runtime_detail_session,
        remote_access::{
            build_runtime_overview_snapshot, query_dynamic_runtime_sample_with_session,
            query_runtime_connection_list_with_session, query_runtime_resource_usage_with_session,
            query_static_runtime_info_with_session, RawCpuSample, StaticRuntimeInfo,
        },
        with_runtime_detail_session,
    },
    error::AppError,
    models::{
        ConnectionProfile, RuntimeConnectionList, RuntimeOverviewEvent, RuntimeResourceUsage,
        RuntimeResourceUsageRequest,
    },
    state::{AppState, RuntimeOverviewMonitorControl, RuntimeOverviewMonitorRuntime},
};

const DEFAULT_OVERVIEW_INTERVAL: Duration = Duration::from_millis(1000);
const SESSION_IO_TIMEOUT: Duration = Duration::from_secs(4);

fn load_connection(state: &AppState, connection_id: &str) -> Result<ConnectionProfile, AppError> {
    state
        .storage
        .load_connections(&state.crypto)?
        .into_iter()
        .find(|c| c.id == connection_id)
        .ok_or_else(|| AppError::NotFound(format!("connection '{connection_id}' not found")))
}

fn calculate_backoff(consecutive_errors: u32, interval: Duration) -> Duration {
    let backoff_secs = match consecutive_errors {
        0 | 1 => 1,
        2 => 2,
        3 => 4,
        4 => 8,
        5 => 15,
        _ => 30,
    };
    Duration::from_secs(backoff_secs)
        .max(interval)
        .min(Duration::from_secs(30))
}

fn run_overview_monitor_worker(
    app_handle: AppHandle,
    webview_label: String,
    subscription_id: String,
    connection: ConnectionProfile,
    interval: Duration,
    control_rx: Receiver<RuntimeOverviewMonitorControl>,
) {
    let mut session: Option<ssh2::Session> = None;
    let mut static_info: Option<StaticRuntimeInfo> = None;
    let mut previous_cpu: Option<RawCpuSample> = None;
    let mut sequence: u64 = 0;
    let mut paused = false;
    let mut consecutive_errors: u32 = 0;
    let mut immediate_refresh = true;

    loop {
        // 1. 等待下一次调度或控制消息
        let mut force_sample = immediate_refresh;
        immediate_refresh = false;

        if !force_sample {
            if paused {
                match control_rx.recv() {
                    Ok(ctrl) => {
                        let (should_stop, new_paused, refresh) = fold_controls(ctrl, &control_rx);
                        if should_stop {
                            break;
                        }
                        paused = new_paused.unwrap_or(paused);
                        if refresh {
                            force_sample = true;
                        }
                    }
                    Err(_) => break, // Channel closed
                }
            } else {
                let wait_duration = if consecutive_errors > 0 {
                    calculate_backoff(consecutive_errors, interval)
                } else {
                    interval
                };

                match control_rx.recv_timeout(wait_duration) {
                    Ok(ctrl) => {
                        let (should_stop, new_paused, refresh) = fold_controls(ctrl, &control_rx);
                        if should_stop {
                            break;
                        }
                        paused = new_paused.unwrap_or(paused);
                        if refresh {
                            force_sample = true;
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        // 正常轮询周期超时
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        }

        if paused && !force_sample {
            continue;
        }

        // 2. 检查并建立概览独占 SSH 会话及静态信息采集
        if session.is_none() {
            match connect_ssh(&connection) {
                Ok(new_session) => {
                    new_session.set_timeout(SESSION_IO_TIMEOUT.as_millis() as u32);
                    match query_static_runtime_info_with_session(&new_session) {
                        Ok(info) => {
                            static_info = Some(info);
                            session = Some(new_session);
                        }
                        Err(err) => {
                            consecutive_errors = consecutive_errors.saturating_add(1);
                            sequence = sequence.saturating_add(1);
                            let retry_in_ms =
                                calculate_backoff(consecutive_errors, interval).as_millis() as u64;
                            let event = RuntimeOverviewEvent::Error {
                                subscription_id: subscription_id.clone(),
                                connection_id: connection.id.clone(),
                                sequence,
                                attempted_at: chrono::Utc::now().to_rfc3339(),
                                message: format!("Failed to query static system info: {err}"),
                                retry_in_ms,
                            };
                            let _ = app_handle.emit_to(
                                EventTarget::labeled(&webview_label),
                                "runtime-overview-updated",
                                &event,
                            );
                            continue;
                        }
                    }
                }
                Err(err) => {
                    consecutive_errors = consecutive_errors.saturating_add(1);
                    sequence = sequence.saturating_add(1);
                    let retry_in_ms =
                        calculate_backoff(consecutive_errors, interval).as_millis() as u64;
                    let event = RuntimeOverviewEvent::Error {
                        subscription_id: subscription_id.clone(),
                        connection_id: connection.id.clone(),
                        sequence,
                        attempted_at: chrono::Utc::now().to_rfc3339(),
                        message: format!("SSH connection failed: {err}"),
                        retry_in_ms,
                    };
                    let _ = app_handle.emit_to(
                        EventTarget::labeled(&webview_label),
                        "runtime-overview-updated",
                        &event,
                    );
                    continue;
                }
            }
        }

        // 3. 执行单次无 sleep 动态采样
        let active_session = match session.as_ref() {
            Some(s) => s,
            None => continue,
        };

        match query_dynamic_runtime_sample_with_session(active_session) {
            Ok(sample) => {
                consecutive_errors = 0;
                sequence = sequence.saturating_add(1);
                let static_ref = static_info.as_ref().expect("static info exists");
                let snapshot = build_runtime_overview_snapshot(
                    static_ref,
                    previous_cpu.as_ref(),
                    &sample,
                    &connection.host,
                );
                previous_cpu = Some(sample.cpu_sample);

                let event = RuntimeOverviewEvent::Snapshot {
                    subscription_id: subscription_id.clone(),
                    connection_id: connection.id.clone(),
                    sequence,
                    snapshot,
                };
                let _ = app_handle.emit_to(
                    EventTarget::labeled(&webview_label),
                    "runtime-overview-updated",
                    &event,
                );
            }
            Err(err) => {
                consecutive_errors = consecutive_errors.saturating_add(1);
                sequence = sequence.saturating_add(1);
                // 采样失败（如连接中断），丢弃 session 触发重连
                session = None;
                static_info = None;
                previous_cpu = None;

                let retry_in_ms =
                    calculate_backoff(consecutive_errors, interval).as_millis() as u64;
                let event = RuntimeOverviewEvent::Error {
                    subscription_id: subscription_id.clone(),
                    connection_id: connection.id.clone(),
                    sequence,
                    attempted_at: chrono::Utc::now().to_rfc3339(),
                    message: format!("Runtime sample failed: {err}"),
                    retry_in_ms,
                };
                let _ = app_handle.emit_to(
                    EventTarget::labeled(&webview_label),
                    "runtime-overview-updated",
                    &event,
                );
            }
        }
    }
}

/// 排空并折叠控制队列中的所有积压事件：
/// - Stop 优先级最高，一票否决
/// - Pause / Resume 保留最后一次状态
/// - Refresh 折叠为单次立即执行
fn fold_controls(
    first: RuntimeOverviewMonitorControl,
    rx: &Receiver<RuntimeOverviewMonitorControl>,
) -> (bool, Option<bool>, bool) {
    let mut should_stop = false;
    let mut last_pause_state = None;
    let mut should_refresh = false;

    let mut process_msg = |msg: RuntimeOverviewMonitorControl| match msg {
        RuntimeOverviewMonitorControl::Stop => should_stop = true,
        RuntimeOverviewMonitorControl::Pause => last_pause_state = Some(true),
        RuntimeOverviewMonitorControl::Resume => last_pause_state = Some(false),
        RuntimeOverviewMonitorControl::Refresh => should_refresh = true,
    };

    process_msg(first);

    while let Ok(msg) = rx.try_recv() {
        process_msg(msg);
    }

    (should_stop, last_pause_state, should_refresh)
}

#[tauri::command]
pub async fn start_runtime_overview_monitor(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    window: WebviewWindow,
    connection_id: String,
    subscription_id: String,
    generation: u64,
) -> Result<(), String> {
    let connection = load_connection(&state, &connection_id)?;
    let webview_label = window.label().to_string();
    // 订阅 ID 由前端 effect 预先生成；拒绝非法值，避免空 ID 让旧 cleanup 误操作当前 worker。
    Uuid::parse_str(&subscription_id)
        .map_err(|_| AppError::Validation("invalid runtime monitor subscription id".into()))?;

    // 停止并清理该 Webview 已有的旧 worker
    let mut monitors = state
        .runtime_overview_monitors
        .lock()
        .map_err(|_| AppError::Validation("runtime monitor map unavailable".into()))?;

    // async command 可能乱序完成；较旧 effect 的迟到 start 必须直接忽略，不能替换已登记的新 worker。
    if monitors
        .get(&webview_label)
        .is_some_and(|runtime| runtime.generation > generation)
    {
        return Ok(());
    }

    if let Some(old_runtime) = monitors.remove(&webview_label) {
        let _ = old_runtime
            .control_tx
            .send(RuntimeOverviewMonitorControl::Stop);
    }

    let (control_tx, control_rx) = mpsc::channel();
    let worker_sub_id = subscription_id.clone();
    let worker_webview_label = webview_label.clone();
    let worker_app = app_handle.clone();

    thread::Builder::new()
        .name(format!("runtime-monitor-{}", webview_label))
        .spawn(move || {
            run_overview_monitor_worker(
                worker_app,
                worker_webview_label,
                worker_sub_id,
                connection,
                DEFAULT_OVERVIEW_INTERVAL,
                control_rx,
            );
        })
        .map_err(AppError::Io)?;

    monitors.insert(
        webview_label,
        RuntimeOverviewMonitorRuntime {
            subscription_id: subscription_id.clone(),
            generation,
            connection_id,
            control_tx,
        },
    );

    Ok(())
}

#[tauri::command]
pub async fn set_runtime_overview_monitor_paused(
    state: State<'_, AppState>,
    window: WebviewWindow,
    subscription_id: String,
    paused: bool,
) -> Result<(), String> {
    let webview_label = window.label();
    let monitors = state
        .runtime_overview_monitors
        .lock()
        .map_err(|_| AppError::Validation("runtime monitor map unavailable".into()))?;

    if let Some(runtime) = monitors
        .get(webview_label)
        .filter(|runtime| runtime.subscription_id == subscription_id)
    {
        let ctrl = if paused {
            RuntimeOverviewMonitorControl::Pause
        } else {
            RuntimeOverviewMonitorControl::Resume
        };
        runtime
            .control_tx
            .send(ctrl)
            .map_err(|_| AppError::Validation("runtime monitor worker is unavailable".into()))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn refresh_runtime_overview_monitor(
    state: State<'_, AppState>,
    window: WebviewWindow,
    subscription_id: String,
) -> Result<(), String> {
    let webview_label = window.label();
    let monitors = state
        .runtime_overview_monitors
        .lock()
        .map_err(|_| AppError::Validation("runtime monitor map unavailable".into()))?;

    let runtime = monitors
        .get(webview_label)
        .filter(|runtime| runtime.subscription_id == subscription_id)
        .ok_or_else(|| AppError::NotFound("runtime monitor subscription is not active".into()))?;
    runtime
        .control_tx
        .send(RuntimeOverviewMonitorControl::Refresh)
        .map_err(|_| AppError::Validation("runtime monitor worker is unavailable".into()))?;

    Ok(())
}

#[tauri::command]
pub async fn stop_runtime_overview_monitor(
    state: State<'_, AppState>,
    window: WebviewWindow,
    subscription_id: String,
) -> Result<(), String> {
    let webview_label = window.label();
    let mut monitors = state
        .runtime_overview_monitors
        .lock()
        .map_err(|_| AppError::Validation("runtime monitor map unavailable".into()))?;

    // StrictMode/HMR 的旧 cleanup 只能移除自己的订阅，绝不能按 Webview label 直接停止后来建立的新 worker。
    let matches_current = monitors
        .get(webview_label)
        .is_some_and(|runtime| runtime.subscription_id == subscription_id);
    if matches_current {
        if let Some(runtime) = monitors.remove(webview_label) {
            let _ = runtime.control_tx.send(RuntimeOverviewMonitorControl::Stop);
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn get_runtime_resource_usage(
    state: State<'_, AppState>,
    connection_id: String,
    request: RuntimeResourceUsageRequest,
) -> Result<RuntimeResourceUsage, String> {
    let connection = load_connection(&state, &connection_id)?;
    Ok(with_runtime_detail_session(
        &state,
        &connection,
        |detail| query_runtime_resource_usage_with_session(&detail.session, &request),
    )?)
}

#[tauri::command]
pub async fn get_runtime_connection_list(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<RuntimeConnectionList, String> {
    let connection = load_connection(&state, &connection_id)?;
    Ok(with_runtime_detail_session(
        &state,
        &connection,
        |detail| query_runtime_connection_list_with_session(&detail.session),
    )?)
}

/// 所有展开明细收起或 RuntimeSidebar 卸载时立即移出缓存；正在执行的查询持有 Arc，会在返回后自然关闭。
#[tauri::command]
pub fn release_runtime_detail_session(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<bool, String> {
    drop_runtime_detail_session(&state, &connection_id);
    Ok(true)
}
