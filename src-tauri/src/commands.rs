use std::{
    collections::HashSet,
    io::{ErrorKind, Write},
    net::Shutdown,
    path::Path,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
        Arc, Condvar, MutexGuard,
    },
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use ssh2::{Channel, Session};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    agent_bridge,
    error::AppError,
    models::{
        AppSettings, BootstrapState,
        ConnectionProfile, HistoryEntry,
        HistoryEntryInput, LocalTerminalProfile, LocalTerminalSettings,
        SshProxyConfig,
        TerminalOutputChunk, TerminalSession, TunnelOpenRequest, TunnelRecord, TunnelUpdateRequest,
    },
    state::{
        AgentPtyPhase, AgentPtyState, AppState, AuxiliarySshSession, RuntimeSession,
        SessionControl, TerminalOutputQueue, TunnelRuntime, TunnelSshPool,
    },
};

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTransferSummary {
    // 批量传输按普通文件计数，目录本身单独计入 directories，便于前端给出简洁完成提示。
    files: usize,
    directories: usize,
    bytes: u64,
    destinations: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBridgeNotificationRequest {
    // 通知动作回传只带请求 id，前端收到后再调用现有审批接口，避免 toast 线程直接操作业务状态。
    request_id: String,
    title: String,
    body: String,
    approve_label: String,
    reject_label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentBridgeNotificationActionEvent {
    // 前端监听该事件后按 action_id 分派“接受/拒绝/打开面板”。
    request_id: String,
    action_id: String,
}

const AGENT_BRIDGE_NOTIFICATION_ACTION_EVENT: &str = "agent-bridge-notification-action";
const AGENT_BRIDGE_NOTIFICATION_APPROVE_ACTION_ID: &str = "approve-agent-request";
const AGENT_BRIDGE_NOTIFICATION_REJECT_ACTION_ID: &str = "reject-agent-request";

const SSH_CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
const SSH_IO_TIMEOUT: Duration = Duration::from_secs(20);
// 服务端 MaxStartups 限流或跳板桥刚建立时可能立即丢弃首个握手连接；banner 专属错误只短暂退避重试一次。
const SSH_BANNER_RETRY_DELAY: Duration = Duration::from_millis(300);
// Shell 主循环每轮最多处理的前端控制事件数；输入风暴下必须留出读 SSH 输出的机会。
const SSH_SHELL_MAX_CONTROL_EVENTS_PER_TICK: usize = 64;
// Shell 主循环每轮最多连续读 SSH 输出次数；既尽快排空远端回显，也避免长期占住线程。
const SSH_SHELL_MAX_READS_PER_TICK: usize = 32;
// 单轮最多写入远端 PTY 的输入字节数；限制写入爆发，给远端回显和窗口调整留出空间。
const SSH_SHELL_MAX_WRITE_CHUNK_BYTES: usize = 8192;
// 单次非阻塞写入预算；输入很长时分多轮推进，避免写路径压过读路径。
const SSH_SHELL_WRITE_BUDGET: Duration = Duration::from_millis(8);
// Shell 主循环空闲时最长等待控制通道的时间；有输入到达会立即唤醒，不再固定睡完整周期。
const SSH_SHELL_IDLE_WAIT: Duration = Duration::from_millis(5);
// libssh2 暂时不可写或 transport 抖动时的轻量退避，避免瞬时错误下空转烧 CPU。
const SSH_SHELL_RETRY_WAIT: Duration = Duration::from_millis(1);
// 每条 SSH session 上允许并发的隧道 channel 数；低于 OpenSSH 常见 MaxSessions 默认值，保留余量给服务端。
const TUNNEL_CHANNELS_PER_SSH_SESSION: usize = 8;
// 同一连接配置最多保留的隧道 SSH session 数，网页高并发时超过单 session channel 上限再扩容。
const TUNNEL_MAX_SSH_SESSIONS_PER_CONNECTION: usize = 4;
// 并发峰值过去后最多保留的空闲 session 数，兼顾后续访问速度和远端资源占用。
const TUNNEL_MAX_IDLE_SSH_SESSIONS_PER_CONNECTION: usize = 2;
// 隧道池等待新 session 或空闲 channel 的短周期；停止隧道时最多等待一个周期即可退出。
const TUNNEL_POOL_WAIT: Duration = Duration::from_millis(50);
// 隧道转发采用较大块读写，避免 8KB 小块和固定 sleep 把吞吐人为压低。
const TUNNEL_TRANSFER_BUFFER_BYTES: usize = 64 * 1024;
// 单方向待写缓冲上限。收紧到 256 KiB：慢读端由 TCP 背压自然限速，无需在进程内堆积 2 MiB；
// 大量并发 channel 时峰值和保留内存都随之下降。若吞吐测试证明不足再上调。
const TUNNEL_MAX_PENDING_BYTES: usize = 256 * 1024;
// 待写队列排空后若容量远超上限则收缩，避免一次突发把大容量 VecDeque 永久保留在每个 channel 上。
const TUNNEL_PENDING_SHRINK_THRESHOLD: usize = TUNNEL_MAX_PENDING_BYTES;
// 非阻塞转发只有在本轮没有任何进展时短暂退避，不能像旧实现那样每轮固定延迟。
const TUNNEL_TRANSFER_IDLE_WAIT: Duration = Duration::from_millis(1);
// 辅助会话（文件/运行状态/历史）阻塞操作超时；后台挂起导致连接静默失效时，切 tab 最多卡这么久即快速失败重连，而非默认握手期的 20 秒。
const AUXILIARY_IO_TIMEOUT: Duration = Duration::from_secs(10);
// 后台保活守护线程的最小轮询周期；保活间隔更小时以设置值为准，间隔为 0（关闭）时按此周期空转检查。
const KEEPALIVE_DAEMON_MIN_TICK: Duration = Duration::from_secs(10);
// SSH 隧道健康监控线程的轮询周期；每轮探测各运行中隧道底层 SSH 连接的可达性并在状态变化时回传前端。
const TUNNEL_MONITOR_TICK: Duration = Duration::from_secs(5);
// 隧道底层连接连续探测失败达到该次数才判定为异常，过滤单次网络抖动导致的误报；恢复则立即置回运行中。
const TUNNEL_UNHEALTHY_THRESHOLD: u32 = 2;
// 辅助 SSH/SFTP 连接空闲多久后回收；访问越多常驻资源越多，用 TTL 给“复用性能 vs 常驻内存”划边界。
const AUXILIARY_IDLE_TTL: Duration = Duration::from_secs(10 * 60);
// 允许常驻的空闲辅助连接上限；超过此数时优先回收最久未使用者，保留少量热连接以复用握手。
const AUXILIARY_MAX_IDLE_SESSIONS: usize = 4;

#[cfg(windows)]
const DEFAULT_LOCAL_SHELL_CANDIDATES: &[&str] = &[
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    "pwsh.exe",
    "powershell.exe",
];

#[cfg(windows)]
const WINDOWS_CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(not(windows))]
const DEFAULT_LOCAL_SHELL_CANDIDATES: &[&str] = &["bash", "sh"];

fn lock_sessions<'a>(
    state: &'a AppState,
) -> Result<MutexGuard<'a, std::collections::HashMap<String, RuntimeSession>>, AppError> {
    state
        .sessions
        .lock()
        .map_err(|_| AppError::Validation("session registry is unavailable".into()))
}

fn lock_tunnels<'a>(
    state: &'a AppState,
) -> Result<MutexGuard<'a, std::collections::HashMap<String, TunnelRuntime>>, AppError> {
    state
        .tunnels
        .lock()
        .map_err(|_| AppError::Validation("tunnel registry is unavailable".into()))
}

fn lock_tunnel_ssh_pools<'a>(
    state: &'a AppState,
) -> Result<MutexGuard<'a, std::collections::HashMap<String, Arc<TunnelSshPool>>>, AppError> {
    state
        .tunnel_ssh_pools
        .lock()
        .map_err(|_| AppError::Validation("tunnel ssh pool registry is unavailable".into()))
}

fn lock_auxiliary_sessions<'a>(
    state: &'a AppState,
) -> Result<
    MutexGuard<'a, std::collections::HashMap<String, Arc<std::sync::Mutex<AuxiliarySshSession>>>>,
    AppError,
> {
    state
        .auxiliary_sessions
        .lock()
        .map_err(|_| AppError::Validation("auxiliary ssh registry is unavailable".into()))
}

fn auxiliary_session_lock(
    state: &AppState,
    connection_id: &str,
) -> Result<Arc<std::sync::Mutex<()>>, AppError> {
    let mut locks = state
        .auxiliary_session_locks
        .lock()
        .map_err(|_| AppError::Validation("auxiliary ssh lock registry is unavailable".into()))?;
    Ok(Arc::clone(
        locks
            .entry(connection_id.to_string())
            .or_insert_with(|| Arc::new(std::sync::Mutex::new(()))),
    ))
}

fn ensure_connection_exists(
    state: &AppState,
    connection_id: &str,
) -> Result<ConnectionProfile, AppError> {
    state
        .storage
        .load_connections(&state.crypto)?
        .into_iter()
        .find(|item| item.id == connection_id)
        .ok_or_else(|| AppError::NotFound(format!("connection {connection_id} not found")))
}

fn validate_tunnel_fields(tunnel: &TunnelRecord) -> Result<(), AppError> {
    // 隧道端点必须在保存前完整可识别；实际端口占用和 SSH 可达性留到启动监听时判断。
    if tunnel.connection_id.trim().is_empty() {
        return Err(AppError::Validation("tunnel connection is required".into()));
    }
    if tunnel.name.trim().is_empty() {
        return Err(AppError::Validation("tunnel name is required".into()));
    }
    if tunnel.bind_address.trim().is_empty() {
        return Err(AppError::Validation(
            "tunnel bind address is required".into(),
        ));
    }
    if tunnel.local_port == 0 || tunnel.remote_port == 0 {
        return Err(AppError::Validation(
            "tunnel ports must be between 1 and 65535".into(),
        ));
    }
    if tunnel.remote_host.trim().is_empty() {
        return Err(AppError::Validation(
            "tunnel remote host is required".into(),
        ));
    }

    Ok(())
}

/// 非阻塞写入：在短时间预算内尽量写入，返回实际写入的字节数。
/// 不会长时间阻塞 shell 线程，允许读写在主循环中自然交替；真实 I/O 错误则上抛让会话退出。
fn write_channel_input(channel: &mut Channel, data: &[u8]) -> Result<usize, AppError> {
    if data.is_empty() {
        return Ok(0);
    }
    let started_at = Instant::now();
    let mut written = 0;
    while written < data.len() {
        if started_at.elapsed() > SSH_SHELL_WRITE_BUDGET {
            break;
        }
        match channel.write(&data[written..]) {
            Ok(0) => {
                thread::sleep(Duration::from_millis(1));
            }
            Ok(size) => {
                written += size;
            }
            Err(error) if is_transient_channel_write_error(&error) => {
                // 非阻塞模式下所有写入错误都视为暂时无法继续；
                // 跳出让 read 先执行，下轮主循环再重试写入。
                break;
            }
            Err(error) => return Err(AppError::from(error)),
        }
    }

    // 尝试 flush 已写入的数据，不阻塞
    if written > 0 {
        match channel.flush() {
            Ok(()) => {}
            Err(error) if is_transient_channel_write_error(&error) => {}
            Err(error) => return Err(AppError::from(error)),
        }
    }

    Ok(written)
}

fn is_transient_channel_write_error(error: &std::io::Error) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    // libssh2 的非阻塞写入经常把 EAGAIN/WouldBlock 包成 Other 或 Session(-37)，连续退格时要按瞬时错误重试。
    matches!(
        error.kind(),
        ErrorKind::WouldBlock | ErrorKind::Interrupted | ErrorKind::TimedOut
    ) || message.contains("would block")
        || message.contains("eagain")
        || message.contains("session(-37)")
        || message.contains("temporarily unavailable")
        || message.contains("try again")
        || message.contains("transport read")
        || message.contains("transport write")
        || message.contains("socket send")
        || message.contains("socket write")
}

mod shell_runtime;
pub(crate) use shell_runtime::{announce_agent_activity, announce_agent_command};
use shell_runtime::{
    detect_language, is_transient_ssh_error, is_transient_transport_read_error,
    publish_agent_pty_progress, queue_cwd, queue_output, queue_session_status, queue_terminal_size,
    shell_cwd_sync_command, track_user_input_activity,
};

mod runtime_daemons;
pub use runtime_daemons::{
    prepare_agent_bridge_startup, shutdown_app_backends, spawn_keepalive_daemon,
    spawn_tunnel_monitor,
};
use runtime_daemons::stop_all_runtimes;

pub(super) fn bootstrap_from_storage(state: &AppState) -> Result<BootstrapState, AppError> {
    let sessions = lock_sessions(state)?
        .values()
        .map(|item| item.session.clone())
        .collect();

    Ok(BootstrapState {
        settings: state.storage.load_settings(&state.crypto)?,
        local_terminals: state.storage.load_local_terminals()?,
        connections: state.storage.load_connections(&state.crypto)?,
        history: state.storage.load_history()?,
        sessions,
        tunnels: state.storage.load_tunnels()?,
    })
}

#[tauri::command]
pub fn bootstrap_state(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<BootstrapState, String> {
    // 前端 AI 执行列表改为事件驱动，启动时先登记 AppHandle，后续 broker 线程即可主动通知请求变化。
    agent_bridge::set_app_handle(&state.agent_bridge, app_handle)?;
    let settings = state.storage.load_settings(&state.crypto)?;
    // React StrictMode 或页面恢复可能重复触发 bootstrap；只确保 Broker 已启动，
    // 不在配置未变化时重启监听器，避免把正在执行的 MCP 请求重置为 os error 10054。
    agent_bridge::ensure_server(
        &state.agent_bridge,
        &state.storage,
        &state.crypto,
        &settings.agent_bridge,
    )?;
    Ok(bootstrap_from_storage(&state)?)
}

#[tauri::command]
pub fn save_app_settings(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    agent_bridge::set_app_handle(&state.agent_bridge, app_handle)?;
    state.storage.save_settings(&settings, &state.crypto)?;
    // 保活间隔热更新：后台守护线程和交互终端下一轮即读到新值，无需重连会话。
    state
        .ssh_keepalive_interval_sec
        .store(settings.ssh_keepalive_interval_sec as u64, Ordering::Relaxed);
    agent_bridge::sync_server(
        &state.agent_bridge,
        &state.storage,
        &state.crypto,
        &settings.agent_bridge,
    )?;
    Ok(settings)
}

#[tauri::command]
pub fn load_local_terminal_settings(
    state: State<'_, AppState>,
) -> Result<LocalTerminalSettings, String> {
    Ok(state.storage.load_local_terminals()?)
}

#[tauri::command]
pub fn save_local_terminal_settings(
    state: State<'_, AppState>,
    settings: LocalTerminalSettings,
) -> Result<LocalTerminalSettings, String> {
    // 本地终端配置包含本机目录和 shell 路径，只写入 local-terminals.json，不进入 WebDAV 同步包。
    state.storage.save_local_terminals(&settings)?;
    Ok(state.storage.load_local_terminals()?)
}

#[tauri::command(async)]
pub fn list_system_fonts() -> Result<Vec<String>, String> {
    // 字体设置下拉需要覆盖本机已安装的全部字体，交由平台原生方式枚举，失败时返回空列表由前端补齐推荐字体。
    Ok(enumerate_system_fonts()?)
}

#[cfg(windows)]
fn enumerate_system_fonts() -> Result<Vec<String>, AppError> {
    // 字体名取自 WPF SystemFontFamilies（DirectWrite），得到 WebView2 前端真正用于匹配的完整 typographic
    // 族名，不受 GDI 32 字符 LF_FACESIZE 截断（如 "Maple Mono Normal NF CN" 这类超长 Nerd 字体名）。
    // 再用 GDI EnumFontFamiliesEx 读取字符集，识别"只有符号字符集（SYMBOL_CHARSET）"的纯图标字体
    // （Wingdings/Marlett 等，在终端只会显示成方块）并从列表剔除；Nerd 等含正常字符集的字体全部保留。
    // 强制 UTF-8 输出，保证中文字体名不乱码。
    let script = r#"[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Add-Type -AssemblyName PresentationCore
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class FontSym {
    const int SYMBOL_CHARSET = 2;
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct LOGFONT {
        public int lfHeight; public int lfWidth; public int lfEscapement; public int lfOrientation;
        public int lfWeight; public byte lfItalic; public byte lfUnderline; public byte lfStrikeOut;
        public byte lfCharSet; public byte lfOutPrecision; public byte lfClipPrecision; public byte lfQuality;
        public byte lfPitchAndFamily;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string lfFaceName;
    }
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)]
    static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
    delegate int EnumProc(ref LOGFONT lf, IntPtr tm, uint type, IntPtr p);
    [DllImport("gdi32.dll", CharSet=CharSet.Unicode)]
    static extern int EnumFontFamiliesEx(IntPtr hdc, ref LOGFONT lf, EnumProc cb, IntPtr p, uint flags);
    // 记录每个字体族是否出现过非符号字符集；@ 开头是竖排变体，终端用不到，直接跳过。
    static Dictionary<string, bool> hasText = new Dictionary<string, bool>();
    static int Callback(ref LOGFONT lf, IntPtr tm, uint type, IntPtr p) {
        string name = lf.lfFaceName;
        if (string.IsNullOrEmpty(name) || name[0] == '@') return 1;
        bool prev; hasText.TryGetValue(name, out prev);
        hasText[name] = prev || lf.lfCharSet != SYMBOL_CHARSET;
        return 1;
    }
    // 返回"仅符号字符集"的字体名集合（图标字体名较短，不会触及 GDI 32 字符截断）。
    public static HashSet<string> SymbolOnly() {
        IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
        LOGFONT lf = new LOGFONT(); lf.lfCharSet = 1; // DEFAULT_CHARSET
        EnumFontFamiliesEx(dc, ref lf, Callback, IntPtr.Zero, 0);
        DeleteDC(dc);
        var s = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var kv in hasText) if (!kv.Value) s.Add(kv.Key);
        return s;
    }
}
'@
$symbol = [FontSym]::SymbolOnly()
[System.Windows.Media.Fonts]::SystemFontFamilies | ForEach-Object { $_.Source } | Where-Object { -not $symbol.Contains($_) }"#;
    let output = Command::new("powershell")
        .creation_flags(WINDOWS_CREATE_NO_WINDOW)
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script])
        .output()
        .map_err(AppError::from)?;
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(dedupe_font_names(text.lines().map(str::to_string)))
}

#[cfg(not(windows))]
fn enumerate_system_fonts() -> Result<Vec<String>, AppError> {
    // 非 Windows 平台使用 fontconfig 的 fc-list 读取字体族名；不可用时回退空列表由前端补齐推荐字体。
    let Ok(output) = Command::new("fc-list").args([":", "family"]).output() else {
        return Ok(Vec::new());
    };
    let text = String::from_utf8_lossy(&output.stdout);
    // fc-list 每行形如 "Family A,Family B"，取首个别名即可。
    Ok(dedupe_font_names(
        text.lines()
            .filter_map(|line| line.split(',').next().map(str::to_string)),
    ))
}

// 统一去除空白、按小写去重并按字母排序，得到稳定可展示的字体族列表。
fn dedupe_font_names(names: impl Iterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut result: Vec<String> = names
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty() && seen.insert(name.to_lowercase()))
        .collect();
    result.sort_by_key(|name| name.to_lowercase());
    result
}

#[tauri::command]
pub fn open_ssh_session(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    connection_id: String,
) -> Result<TerminalSession, String> {
    // 命令层返回值本身会驱动前端登记标签，这里不需要额外广播事件。
    Ok(start_ssh_session(&state, &app_handle, &connection_id, false)?)
}

/// 打开 SSH 终端会话的可复用实现；Tauri 命令与 agent 可见执行共用同一条路径。
/// `announce` 为 true 时额外广播 terminal-session-opened，让前端登记由后端自行创建的标签。
pub(crate) fn start_ssh_session(
    state: &AppState,
    app_handle: &tauri::AppHandle,
    connection_id: &str,
    announce: bool,
) -> Result<TerminalSession, AppError> {
    let connection = ensure_connection_exists(state, connection_id)?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let output_queue = Arc::new(std::sync::Mutex::new(TerminalOutputQueue::new()));
    let (control_tx, control_rx) = mpsc::channel();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let agent_pty = Arc::new(std::sync::Mutex::new(AgentPtyState::default()));
    let agent_pty_signal = Arc::new(Condvar::new());

    let runtime = RuntimeSession {
        session: TerminalSession {
            id: session_id.clone(),
            kind: "ssh".into(),
            connection_id: connection.id.clone(),
            local_profile_id: None,
            local_command: None,
            title: format!("{}@{}", connection.username, connection.host),
            status: "connecting".into(),
            cwd: Some("~".into()),
        },
        cols: 120,
        rows: 32,
        output_queue: Arc::clone(&output_queue),
        control_tx: control_tx.clone(),
        stop_flag: Arc::clone(&stop_flag),
        agent_pty: Arc::clone(&agent_pty),
        agent_pty_signal: Arc::clone(&agent_pty_signal),
    };

    let session = runtime.session.clone();
    lock_sessions(state)?.insert(session.id.clone(), runtime);
    if announce {
        // 后端自行创建的标签不经过前端 openSession 返回值，必须主动广播才能出现在标签栏。
        let _ = app_handle.emit("terminal-session-opened", &session);
    }

    let thread_session_id = session_id.clone();
    let thread_output_queue = Arc::clone(&output_queue);
    let thread_app_handle = app_handle.clone();
    // 交互终端保活间隔跟随全局设置热更新，克隆共享原子给 shell 线程。
    let keepalive_interval = Arc::clone(&state.ssh_keepalive_interval_sec);
    thread::spawn(move || {
        // SSH 握手和认证放到后台线程，前端先获得 connecting 标签，避免打开连接时主交互等待网络。
        match connect_ssh(&connection) {
            Ok(ssh_session) => {
                if stop_flag.load(Ordering::Relaxed) {
                    return;
                }
                let app_state = thread_app_handle.state::<AppState>();
                let Ok(sessions) = lock_sessions(&app_state) else {
                    return;
                };
                let Some(runtime) = sessions.get(&thread_session_id) else {
                    return;
                };
                let (cols, rows) = (runtime.cols, runtime.rows);
                drop(sessions);
                spawn_shell_thread(
                    thread_session_id,
                    ssh_session,
                    cols,
                    rows,
                    thread_output_queue,
                    control_rx,
                    thread_app_handle,
                    keepalive_interval,
                    agent_pty,
                    agent_pty_signal,
                );
            }
            Err(error) => {
                queue_session_status(
                    &thread_output_queue,
                    &thread_app_handle,
                    &thread_session_id,
                    "error",
                );
                queue_output(
                    &thread_output_queue,
                    &thread_app_handle,
                    &thread_session_id,
                    format!("\r\n连接失败：{error}\r\n"),
                );
            }
        }
    });

    Ok(session)
}

#[tauri::command]
pub fn open_local_terminal_session(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    profile: LocalTerminalProfile,
) -> Result<TerminalSession, String> {
    let cwd = profile.cwd.trim();
    if cwd.is_empty() {
        return Err(AppError::Validation("local terminal directory is required".into()).into());
    }
    if !Path::new(cwd).is_dir() {
        return Err(
            AppError::Validation(format!("local terminal directory not found: {cwd}")).into(),
        );
    }
    let command = profile.command.trim();

    let mut settings = state.storage.load_local_terminals()?;
    let now = Utc::now().to_rfc3339();
    let mut next_profile = profile.clone();
    if next_profile.id.trim().is_empty() {
        next_profile.id = uuid::Uuid::new_v4().to_string();
    }
    next_profile.cwd = cwd.to_string();
    next_profile.command = command.to_string();
    next_profile.last_used_at = now;
    if next_profile.title.trim().is_empty() {
        next_profile.title = if next_profile.command.is_empty() {
            next_profile.cwd.clone()
        } else {
            format!("{} · {}", next_profile.command, next_profile.cwd)
        };
    }

    // 历史目录以目录为主，重新打开同一路径时只更新最近命令并移动到列表顶部。
    settings.profiles.retain(|item| {
        !item.cwd.eq_ignore_ascii_case(&next_profile.cwd) && item.id != next_profile.id
    });
    settings.profiles.insert(0, next_profile.clone());
    state.storage.save_local_terminals(&settings)?;
    let settings = state.storage.load_local_terminals()?;

    let session_id = uuid::Uuid::new_v4().to_string();
    let output_queue = Arc::new(std::sync::Mutex::new(TerminalOutputQueue::new()));
    let (control_tx, control_rx) = mpsc::channel();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let runtime = RuntimeSession {
        session: TerminalSession {
            id: session_id.clone(),
            kind: "local".into(),
            connection_id: String::new(),
            local_profile_id: Some(next_profile.id.clone()),
            local_command: Some(next_profile.command.clone()),
            title: next_profile.title.clone(),
            status: "connecting".into(),
            cwd: Some(next_profile.cwd.clone()),
        },
        cols: 120,
        rows: 32,
        output_queue: Arc::clone(&output_queue),
        control_tx: control_tx.clone(),
        stop_flag: Arc::clone(&stop_flag),
        // 本地终端不承载 agent 可见执行（agent 只操作 SSH 连接），占用状态保持默认空闲即可。
        agent_pty: Arc::new(std::sync::Mutex::new(AgentPtyState::default())),
        agent_pty_signal: Arc::new(Condvar::new()),
    };

    let session = runtime.session.clone();
    lock_sessions(&state)?.insert(session.id.clone(), runtime);
    spawn_local_terminal_thread(
        session_id,
        settings,
        next_profile,
        120,
        32,
        output_queue,
        control_rx,
        app_handle,
    );
    Ok(session)
}

#[tauri::command]
pub fn close_ssh_session(state: State<'_, AppState>, session_id: String) -> Result<bool, String> {
    if let Some(runtime) = lock_sessions(&state)?.remove(&session_id) {
        runtime.stop_flag.store(true, Ordering::Relaxed);
        let _ = runtime.control_tx.send(SessionControl::Close);
    }
    Ok(true)
}

#[tauri::command]
pub fn write_terminal_input(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<bool, String> {
    let sessions = lock_sessions(&state)?;
    let runtime = sessions
        .get(&session_id)
        .ok_or_else(|| AppError::NotFound(format!("session {session_id} not found")))?;

    runtime
        .control_tx
        .send(SessionControl::Input(data))
        .map_err(|_| AppError::Validation("failed to send terminal input".into()))?;

    Ok(true)
}

#[tauri::command]
pub fn read_terminal_output(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<TerminalOutputChunk>, String> {
    let sessions = lock_sessions(&state)?;
    let runtime = sessions
        .get(&session_id)
        .ok_or_else(|| AppError::NotFound(format!("session {session_id} not found")))?;

    let mut output = runtime
        .output_queue
        .lock()
        .map_err(|_| AppError::Validation("terminal output buffer is unavailable".into()))?;

    // take 交换出队列内容并按需补截断提示，随后立即释放锁，缩短读端持锁时间。
    Ok(output.take(&session_id))
}

#[tauri::command]
pub fn resize_terminal(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<bool, String> {
    let mut sessions = lock_sessions(&state)?;
    let runtime = sessions
        .get_mut(&session_id)
        .ok_or_else(|| AppError::NotFound(format!("session {session_id} not found")))?;

    runtime.cols = cols;
    runtime.rows = rows;
    runtime
        .control_tx
        .send(SessionControl::Resize { cols, rows })
        .map_err(|_| AppError::Validation("failed to resize terminal".into()))?;
    Ok(true)
}

#[tauri::command]
pub fn list_tunnels(state: State<'_, AppState>) -> Result<Vec<TunnelRecord>, String> {
    Ok(state.storage.load_tunnels()?)
}



#[tauri::command]
pub fn open_tunnel(
    state: State<'_, AppState>,
    request: TunnelOpenRequest,
) -> Result<TunnelRecord, String> {
    let TunnelOpenRequest {
        connection_id,
        name,
        bind_address,
        local_port,
        remote_host,
        remote_port,
    } = request;

    // 新增隧道只创建配置记录；本地端口监听在 start_tunnel 中启动，避免端口冲突阻塞保存。
    let _ = ensure_connection_exists(&state, &connection_id)?;
    let tunnel = TunnelRecord {
        id: uuid::Uuid::new_v4().to_string(),
        connection_id,
        name: name.trim().into(),
        bind_address: bind_address.trim().into(),
        local_port,
        remote_host: remote_host.trim().into(),
        remote_port,
        status: "stopped".into(),
    };
    validate_tunnel_fields(&tunnel)?;

    let mut tunnels = state.storage.load_tunnels()?;
    // 保存前校验本地端口是否冲突，避免多个隧道配置相同本地监听端口
    if tunnels.iter().any(|item| item.id != tunnel.id && item.local_port == tunnel.local_port) {
        return Err(AppError::Validation(format!("local port {} is already in use by another tunnel", tunnel.local_port)).into());
    }
    tunnels.retain(|item| item.id != tunnel.id);
    tunnels.insert(0, tunnel.clone());
    state.storage.save_tunnels(&tunnels)?;
    Ok(tunnel)
}

#[tauri::command]
pub fn update_tunnel(
    state: State<'_, AppState>,
    request: TunnelUpdateRequest,
) -> Result<TunnelRecord, String> {
    let TunnelUpdateRequest {
        id,
        connection_id,
        name,
        bind_address,
        local_port,
        remote_host,
        remote_port,
    } = request;

    // 编辑端点前先确认连接仍存在，避免留下指向已删除 SSH 配置的隧道记录。
    let _ = ensure_connection_exists(&state, &connection_id)?;
    let mut tunnel = TunnelRecord {
        id,
        connection_id,
        name: name.trim().into(),
        bind_address: bind_address.trim().into(),
        local_port,
        remote_host: remote_host.trim().into(),
        remote_port,
        status: "stopped".into(),
    };
    validate_tunnel_fields(&tunnel)?;

    let mut tunnels = state.storage.load_tunnels()?;
    let Some(index) = tunnels.iter().position(|item| item.id == tunnel.id) else {
        return Err(AppError::NotFound(format!("tunnel {} not found", tunnel.id)).into());
    };

    // 保存前校验本地端口是否冲突（排除自身）
    if tunnels.iter().any(|item| item.id != tunnel.id && item.local_port == tunnel.local_port) {
        return Err(AppError::Validation(format!("local port {} is already in use by another tunnel", tunnel.local_port)).into());
    }

    // 必须先把 MutexGuard 落到独立 let 上，让锁在分号处立即释放；
    // 否则 edition 2021 里 if let 判据中的临时 guard 会持有到块体结束，
    // 块内 cleanup_unused_tunnel_ssh_pool 再次 lock_tunnels() 即同锁重入死锁。
    let removed_runtime = lock_tunnels(&state)?.remove(&tunnel.id);
    if let Some(runtime) = removed_runtime {
        // 编辑端点会让旧监听参数失效，先停旧监听，再把新配置以停止状态落盘。
        runtime.stop_flag.store(true, Ordering::Relaxed);
        cleanup_unused_tunnel_ssh_pool(&state, &runtime.connection_id)?;
    }

    tunnel.status = "stopped".into();
    tunnels[index] = tunnel.clone();
    state.storage.save_tunnels(&tunnels)?;
    Ok(tunnel)
}

#[tauri::command]
pub fn start_tunnel(state: State<'_, AppState>, tunnel_id: String) -> Result<TunnelRecord, String> {
    let mut tunnels = state.storage.load_tunnels()?;
    let Some(index) = tunnels.iter().position(|item| item.id == tunnel_id) else {
        return Err(AppError::NotFound(format!("tunnel {tunnel_id} not found")).into());
    };

    // 先把 remove 结果落到 let，让判据里的 tunnels 锁在分号处释放，
    // 避免块内 cleanup_unused_tunnel_ssh_pool 再次 lock_tunnels() 造成同锁重入死锁。
    let removed_runtime = lock_tunnels(&state)?.remove(&tunnel_id);
    if let Some(runtime) = removed_runtime {
        runtime.stop_flag.store(true, Ordering::Relaxed);
        cleanup_unused_tunnel_ssh_pool(&state, &runtime.connection_id)?;
    }

    let mut tunnel = tunnels[index].clone();
    let connection = ensure_connection_exists(&state, &tunnel.connection_id)?;
    let stop_flag = Arc::new(AtomicBool::new(false));
    let pool = get_or_create_tunnel_ssh_pool(&state, &connection)?;
    if let Err(error) =
        spawn_tunnel_listener(Arc::clone(&pool), tunnel.clone(), Arc::clone(&stop_flag))
    {
        cleanup_unused_tunnel_ssh_pool(&state, &connection.id)?;
        return Err(error.into());
    }

    tunnel.status = "running".into();
    tunnels[index] = tunnel.clone();
    if let Err(error) = state.storage.save_tunnels(&tunnels) {
        stop_flag.store(true, Ordering::Relaxed);
        cleanup_unused_tunnel_ssh_pool(&state, &connection.id)?;
        return Err(error.into());
    }

    let runtime = TunnelRuntime {
        connection_id: tunnel.connection_id.clone(),
        stop_flag: Arc::clone(&stop_flag),
        pool,
    };
    match lock_tunnels(&state) {
        Ok(mut runtimes) => {
            runtimes.insert(tunnel.id.clone(), runtime);
        }
        Err(error) => {
            stop_flag.store(true, Ordering::Relaxed);
            cleanup_unused_tunnel_ssh_pool(&state, &connection.id)?;
            tunnels[index].status = "stopped".into();
            let _ = state.storage.save_tunnels(&tunnels);
            return Err(error.into());
        }
    }

    Ok(tunnel)
}

#[tauri::command]
pub fn close_tunnel(state: State<'_, AppState>, tunnel_id: String) -> Result<bool, String> {
    // 先把 remove 结果落到 let，让判据里的 tunnels 锁在分号处释放，
    // 避免块内 cleanup_unused_tunnel_ssh_pool 再次 lock_tunnels() 造成同锁重入死锁。
    let removed_runtime = lock_tunnels(&state)?.remove(&tunnel_id);
    if let Some(runtime) = removed_runtime {
        runtime.stop_flag.store(true, Ordering::Relaxed);
        cleanup_unused_tunnel_ssh_pool(&state, &runtime.connection_id)?;
    }

    let mut tunnels = state.storage.load_tunnels()?;
    for tunnel in &mut tunnels {
        if tunnel.id == tunnel_id {
            tunnel.status = "stopped".into();
        }
    }
    state.storage.save_tunnels(&tunnels)?;
    Ok(true)
}

#[tauri::command]
pub fn delete_tunnel(state: State<'_, AppState>, tunnel_id: String) -> Result<bool, String> {
    // 运行中的隧道先终止后台监听并回收连接池
    let removed_runtime = lock_tunnels(&state)?.remove(&tunnel_id);
    if let Some(runtime) = removed_runtime {
        runtime.stop_flag.store(true, Ordering::Relaxed);
        cleanup_unused_tunnel_ssh_pool(&state, &runtime.connection_id)?;
    }

    let mut tunnels = state.storage.load_tunnels()?;
    tunnels.retain(|item| item.id != tunnel_id);
    state.storage.save_tunnels(&tunnels)?;
    Ok(true)
}

// 读取远端 Shell 历史要跑远端命令，用 (async) 移出主线程，避免历史刷新时冻结 UI。
#[tauri::command(async)]
pub fn read_remote_shell_history(
    state: State<'_, AppState>,
    connection_id: String,
    limit: Option<usize>,
) -> Result<Vec<HistoryEntry>, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    read_remote_shell_history_entries_cached(&state, &connection, limit.unwrap_or(100))
        .map_err(Into::into)
}

#[tauri::command]
pub fn append_command_history(
    state: State<'_, AppState>,
    entry: HistoryEntryInput,
) -> Result<HistoryEntry, String> {
    let mut history = state.storage.load_history()?;
    let history_entry = if entry.id.is_none() && entry.executed_at.is_none() {
        HistoryEntry::new(entry.connection_id, entry.command)
    } else {
        HistoryEntry {
            id: entry.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            connection_id: entry.connection_id,
            command: entry.command,
            executed_at: entry.executed_at.unwrap_or_else(|| Utc::now().to_rfc3339()),
        }
    };
    history.insert(0, history_entry.clone());
    if history.len() > 500 {
        history.truncate(500);
    }
    state.storage.save_history(&history)?;
    Ok(history_entry)
}

#[tauri::command]
pub fn get_command_suggestions(
    state: State<'_, AppState>,
    connection_id: Option<String>,
    prefix: String,
    limit: usize,
) -> Result<Vec<String>, String> {
    let normalized = prefix.trim().to_lowercase();
    if normalized.is_empty() {
        return Ok(Vec::new());
    }

    let history = state.storage.load_history()?;
    let mut suggestions = Vec::new();
    for item in history {
        if let Some(expected_connection_id) = &connection_id {
            if item.connection_id.as_ref() != Some(expected_connection_id) {
                continue;
            }
        }

        if item.command.to_lowercase().starts_with(&normalized)
            && !suggestions.contains(&item.command)
        {
            suggestions.push(item.command);
        }

        if suggestions.len() >= limit.max(1) {
            break;
        }
    }
    Ok(suggestions)
}

// 本地配置与 WebDAV 同步独立成业务模块；命令名保持不变，仅调整 Rust 内部注册路径。
pub mod config_sync;
pub mod font_pack;
pub mod runtime_monitor;

// Shell 输出协议作为领域对象独立维护；命令层只负责编排 PTY、队列和事件。
mod shell_output;
use shell_output::{
    ShellCommandEvent, ShellOutputFilter, AGENT_COMMAND_ACCENT_SEQUENCE,
    TERMINAL_STYLE_RESET_SEQUENCE,
};

// 远程访问适配器封装 SFTP、历史与运行指标采集；命令层只调用公开用例入口。
pub(crate) mod remote_access;
use remote_access::{
    load_remote_identity_maps,
    read_remote_shell_history_entries_cached,
};

// 远端文件与编辑器命令作为独立应用服务导出；外部 Tauri 命令路径保持 commands::* 不变。
pub mod remote_files;

// 更新与外部资源访问由独立模块注册，Tauri 命令名称保持不变。
pub mod updates;

// Agent Bridge 与内置对话命令由独立适配层注册。
pub mod agent;

// 连接配置、RDP 与连接持久化命令由独立适配层注册。
pub mod connections;
use connections::validate_connection_profile;

// 本地 PTY 生命周期由独立适配器维护。
mod local_terminal;
use local_terminal::spawn_local_terminal_thread;

// SSH 传输适配器统一处理认证、代理、跳板与隧道连接池。
mod ssh_transport;
pub(crate) use ssh_transport::connect_ssh;
use ssh_transport::{
    ssh_error,
    non_empty_trimmed,
    format_tcp_endpoint,
    connect_tcp_direct,
    get_or_create_tunnel_ssh_pool,
    drop_tunnel_ssh_pool,
    clear_tunnel_ssh_pools,
    cleanup_unused_tunnel_ssh_pool,
    stop_connection_tunnel_runtimes,
    mark_connection_tunnels_stopped,
};
use ssh_transport::spawn_tunnel_listener;

// SSH 会话运行时维护辅助连接缓存与交互 Shell 循环。
mod ssh_sessions;
pub(crate) use ssh_sessions::{
    drop_auxiliary_session,
    clear_auxiliary_sessions,
    evict_idle_auxiliary_sessions,
    with_auxiliary_session,
    with_auxiliary_session_once,
    drop_runtime_detail_session,
    clear_runtime_detail_sessions,
    evict_idle_runtime_detail_sessions,
    with_runtime_detail_session,
    auxiliary_sftp,
    auxiliary_identity_maps,
    ssh_socket_error_code,
    spawn_shell_thread,
};
