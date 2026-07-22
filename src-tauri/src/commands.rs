use std::{
    collections::{HashMap, HashSet, VecDeque},
    env, fs,
    io::{ErrorKind, Read, Write},
    net::{IpAddr, Shutdown, TcpListener, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, RecvTimeoutError, TryRecvError},
        Arc, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{TimeZone, Utc};
use portable_pty::{CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use ssh2::{Channel, ExtendedData, MethodType, Session, Sftp};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    agent_bridge,
    error::AppError,
    models::{
        AppSettings, BootstrapState, ConnectionProfile, EditorDocument, HistoryEntry,
        HistoryEntryInput, LocalConfigBundle, LocalTerminalProfile, LocalTerminalSettings,
        RemoteFileEntry, RuntimeCpuCore, RuntimeOverview, SshJumpHost, SshProxyConfig,
        RuntimeResourceUsage, RuntimeResourceUsageItem, RuntimeResourceUsageRequest,
        RuntimeStorageFileItem, RuntimeStorageFiles,
        TerminalOutputChunk, TerminalSession, TunnelOpenRequest, TunnelRecord, TunnelUpdateRequest,
        UpdateCheckResult, WebDavSettings,
    },
    state::{
        AppState, AuxiliarySshSession, RuntimeSession, SessionControl, TerminalOutputQueue,
        TunnelRuntime, TunnelSshPool, TunnelSshPoolSession, TunnelSshPoolState,
    },
};

#[derive(Debug, Deserialize)]
struct GitHubReleaseResponse {
    tag_name: String,
    name: Option<String>,
    html_url: String,
    published_at: Option<String>,
    body: Option<String>,
    #[serde(default)]
    assets: Vec<GitHubReleaseAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubReleaseAsset {
    name: String,
    browser_download_url: String,
    size: Option<u64>,
}

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
// 更新检查和安装包下载要快速失败，避免 GitHub 直连或代理异常时设置页长时间停在处理中。
const UPDATE_HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
// 增加更新包数据读取的超时时间，提升慢速网络环境下的连接稳定性
const UPDATE_HTTP_READ_TIMEOUT: Duration = Duration::from_secs(40);
// 极大调高下载超时上限至 600 秒（10分钟），确保在慢速网络下也能完整下载安装包
const UPDATE_INSTALLER_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
const UPDATE_DOWNLOAD_PROGRESS_EVENT: &str = "myterminal-update-download-progress";
const UPDATE_DOWNLOAD_PROGRESS_THROTTLE: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDownloadProgressEvent {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    percent: Option<u32>,
}
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

fn validate_ssh_auth_fields(
    label: &str,
    username: &str,
    auth_method: &str,
    password: &str,
    private_key_path: Option<&str>,
    private_key_text: Option<&str>,
) -> Result<(), AppError> {
    // 主机和每级跳板机都复用同一套认证约束，避免 IPC 或旧配置绕过前端校验后保存出不可连接的链路。
    if username.trim().is_empty() {
        return Err(AppError::Validation(format!(
            "{label} username is required"
        )));
    }

    if auth_method.trim().eq_ignore_ascii_case("privateKey") {
        if non_empty_trimmed(private_key_path).is_none()
            && non_empty_trimmed(private_key_text).is_none()
        {
            return Err(AppError::Validation(format!(
                "{label} private key authentication requires a key path or pasted key content"
            )));
        }
    } else if password.trim().is_empty() {
        return Err(AppError::Validation(format!(
            "{label} password authentication requires a password"
        )));
    }

    Ok(())
}

fn validate_connection_profile(connection: &ConnectionProfile) -> Result<(), AppError> {
    // 连接配置会被前端、MCP/CLI 和历史数据共同使用；后端保存前必须做最终兜底校验。
    if connection.name.trim().is_empty() {
        return Err(AppError::Validation("connection name is required".into()));
    }
    if connection.host.trim().is_empty() {
        return Err(AppError::Validation("connection host is required".into()));
    }
    if connection.port == 0 {
        return Err(AppError::Validation(
            "connection port must be between 1 and 65535".into(),
        ));
    }
    validate_ssh_auth_fields(
        "connection",
        &connection.username,
        &connection.auth_method,
        &connection.password,
        connection.private_key_path.as_deref(),
        connection.private_key_text.as_deref(),
    )?;

    for (index, jump_host) in connection.jump_hosts.iter().enumerate() {
        let label = format!("jump host {}", index + 1);
        if jump_host.host.trim().is_empty() {
            return Err(AppError::Validation(format!("{label} host is required")));
        }
        if jump_host.port == 0 {
            return Err(AppError::Validation(format!(
                "{label} port must be between 1 and 65535"
            )));
        }
        validate_ssh_auth_fields(
            &label,
            &jump_host.username,
            &jump_host.auth_method,
            &jump_host.password,
            jump_host.private_key_path.as_deref(),
            jump_host.private_key_text.as_deref(),
        )?;
    }

    if connection.proxy.enabled {
        if connection.proxy.host.trim().is_empty() {
            return Err(AppError::Validation("proxy host is required".into()));
        }
        if connection.proxy.port == 0 {
            return Err(AppError::Validation(
                "proxy port must be between 1 and 65535".into(),
            ));
        }

        match connection
            .proxy
            .proxy_type
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "http" | "https" | "http-connect" | "socks5" | "socks" => {}
            value => {
                return Err(AppError::Validation(format!(
                    "unsupported proxy type: {value}"
                )))
            }
        }
    }

    Ok(())
}

fn parse_version_parts(version: &str) -> Option<Vec<u64>> {
    let normalized = version
        .trim()
        .trim_start_matches('v')
        .trim_start_matches('V');
    let core = normalized.split(['-', '+']).next().unwrap_or(normalized);
    let mut parts = Vec::new();
    for segment in core.split('.') {
        if segment.is_empty() {
            return None;
        }
        parts.push(segment.parse::<u64>().ok()?);
    }
    Some(parts)
}

fn is_newer_version(latest: &str, current: &str) -> bool {
    // GitHub tag 只做保守语义版本比较；遇到非数字标签不提示更新，避免误报。
    let Some(mut latest_parts) = parse_version_parts(latest) else {
        return false;
    };
    let Some(mut current_parts) = parse_version_parts(current) else {
        return false;
    };

    let len = latest_parts.len().max(current_parts.len());
    latest_parts.resize(len, 0);
    current_parts.resize(len, 0);
    latest_parts > current_parts
}

fn installer_asset_score(asset_name: &str) -> i32 {
    let normalized = asset_name.to_ascii_lowercase();
    if !(normalized.ends_with(".exe") || normalized.ends_with(".msi")) {
        return -1;
    }

    let mut score = 10;
    if normalized.ends_with(".exe") {
        score += 8;
    }
    if normalized.contains("setup") || normalized.contains("installer") {
        score += 6;
    }
    if normalized.contains("windows")
        || normalized.contains("win")
        || normalized.contains("pc-windows")
    {
        score += 5;
    }
    if normalized.contains("x64") || normalized.contains("amd64") {
        score += 3;
    }
    if normalized.contains("nsis") {
        score += 2;
    }
    if normalized.ends_with(".msi") {
        score += 1;
    }
    score
}

fn select_update_installer_asset(assets: &[GitHubReleaseAsset]) -> Option<GitHubReleaseAsset> {
    // Release 里可能同时包含校验文件、压缩包和安装器，这里优先选择 Windows 可直接启动的安装包。
    assets
        .iter()
        .filter_map(|asset| {
            let score = installer_asset_score(&asset.name);
            (score >= 0).then_some((score, asset))
        })
        .max_by_key(|(score, _)| *score)
        .map(|(_, asset)| asset.clone())
}

fn sanitize_asset_file_name(asset_name: &str) -> String {
    let sanitized: String = asset_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    if sanitized.trim_matches('_').is_empty() {
        "MyTerminal-update.exe".into()
    } else {
        sanitized
    }
}

fn is_valid_update_download_url(url: &str) -> bool {
    let normalized = url.trim().to_ascii_lowercase();
    (normalized.starts_with("https://") || normalized.starts_with("http://"))
        && (normalized.ends_with(".exe") || normalized.ends_with(".msi"))
        && !normalized.chars().any(|character| character.is_control())
}

fn build_update_http_client(total_timeout: Duration) -> Result<reqwest::Client, AppError> {
    // 更新相关请求必须尊重系统代理；Cargo 特性启用后，默认 Client 会读取 Windows 代理和代理环境变量。
    reqwest::Client::builder()
        .connect_timeout(UPDATE_HTTP_CONNECT_TIMEOUT)
        .read_timeout(UPDATE_HTTP_READ_TIMEOUT)
        .timeout(total_timeout)
        .build()
        .map_err(AppError::from)
}

fn installer_path_matches_expected_size(
    path: &Path,
    expected_size: Option<u64>,
) -> Result<bool, AppError> {
    // Release 元数据有文件大小时必须严格匹配，避免复用之前中断留下的半截安装包。
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(AppError::from(error)),
    };
    if !metadata.is_file() {
        return Ok(false);
    }

    // 少数 Release 可能缺少 size 字段；此时只复用非空文件，仍避免 0 字节缓存导致安装失败。
    Ok(expected_size
        .map(|size| metadata.len() == size)
        .unwrap_or(metadata.len() > 0))
}

async fn download_update_installer(
    app_handle: &AppHandle,
    client: &reqwest::Client,
    download_url: &str,
    installer_path: &Path,
    expected_size: Option<u64>,
) -> Result<(), AppError> {
    // 临时文件完整落盘后才替换正式安装包，避免下载中断时污染下次可复用的缓存。
    let temp_installer_path = installer_path.with_extension(format!(
        "{}.download",
        installer_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("tmp")
    ));
    match fs::remove_file(&temp_installer_path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(AppError::from(error)),
    }

    let mut response = client
        .get(download_url)
        .header(reqwest::header::USER_AGENT, "MyTerminal")
        .send()
        .await
        .map_err(AppError::from)?
        .error_for_status()
        .map_err(AppError::from)?;
    let mut temp_file = fs::File::create(&temp_installer_path).map_err(AppError::from)?;
    let mut downloaded_size = 0_u64;
    let mut last_progress_emit = Instant::now();

    while let Some(chunk) = response.chunk().await.map_err(AppError::from)? {
        // 下载过程中持续校验大小上界，防止错误地址返回 HTML 或其它大文件时继续写入。
        downloaded_size += chunk.len() as u64;
        if expected_size.is_some_and(|size| downloaded_size > size) {
            return Err(AppError::Validation(
                "downloaded update installer is larger than expected".into(),
            ));
        }
        temp_file.write_all(&chunk).map_err(AppError::from)?;

        // 按固定间隔向前端推送下载进度，避免高频 chunk 事件占用过多通信带宽。
        if last_progress_emit.elapsed() >= UPDATE_DOWNLOAD_PROGRESS_THROTTLE {
            let percent = expected_size.map(|size| {
                ((downloaded_size as f64 / size as f64) * 100.0).min(100.0).round() as u32
            });
            let _ = app_handle.emit(
                UPDATE_DOWNLOAD_PROGRESS_EVENT,
                &UpdateDownloadProgressEvent {
                    downloaded_bytes: downloaded_size,
                    total_bytes: expected_size,
                    percent,
                },
            );
            last_progress_emit = Instant::now();
        }
    }
    temp_file.flush().map_err(AppError::from)?;
    drop(temp_file);

    // 下载结束时再推送一次完整进度，让前端进度条到达 100%。
    let _ = app_handle.emit(
        UPDATE_DOWNLOAD_PROGRESS_EVENT,
        &UpdateDownloadProgressEvent {
            downloaded_bytes: downloaded_size,
            total_bytes: expected_size,
            percent: expected_size.map(|size| ((downloaded_size as f64 / size as f64) * 100.0).min(100.0).round() as u32),
        },
    );

    // 下载结束后再次校验精确大小，确保启动安装器前拿到的是完整 Release 资产。
    if expected_size.is_some_and(|size| downloaded_size != size) {
        return Err(AppError::Validation(
            "downloaded update installer size does not match release metadata".into(),
        ));
    }
    if downloaded_size == 0 {
        return Err(AppError::Validation(
            "downloaded update installer is empty".into(),
        ));
    }

    match fs::remove_file(installer_path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(AppError::from(error)),
    }
    fs::rename(&temp_installer_path, installer_path).map_err(AppError::from)?;
    Ok(())
}

fn spawn_update_installer(path: &Path) -> std::io::Result<()> {
    // Windows MSI 需要交给 msiexec 启动；EXE 安装包则直接执行，避免检测到更新后按钮无响应。
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let mut child = if extension == "msi" {
        Command::new("msiexec.exe").arg("/i").arg(path).spawn()?
    } else if extension == "exe" {
        Command::new(path).spawn()?
    } else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "不支持的安装包格式",
        ));
    };

    // 验证进程是否成功启动（等待 100ms 检查是否立即退出）
    std::thread::sleep(std::time::Duration::from_millis(100));
    match child.try_wait()? {
        Some(status) if !status.success() => Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("安装器启动失败，退出码：{}", status.code().unwrap_or(-1)),
        )),
        _ => Ok(()),
    }
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

fn queue_output(
    queue: &Arc<std::sync::Mutex<TerminalOutputQueue>>,
    app_handle: &tauri::AppHandle,
    session_id: &str,
    content: impl Into<String>,
) {
    if let Ok(mut output) = queue.lock() {
        // 内容分片走有界入队：自动合并相邻内容并在超限时淘汰最旧内容。
        output.push_content(session_id, content.into());
    }
    // 数据入队后立即通知前端拉取当前会话，替代全局定时轮询，实现低延迟回显。
    let _ = app_handle.emit("terminal-output-ready", session_id);
}

fn queue_session_status(
    queue: &Arc<std::sync::Mutex<TerminalOutputQueue>>,
    app_handle: &tauri::AppHandle,
    session_id: &str,
    status: impl Into<String>,
) {
    if let Ok(mut output) = queue.lock() {
        output.push_meta(TerminalOutputChunk {
            session_id: session_id.to_string(),
            cwd: None,
            // 连接状态只交给前端标签栏展示，不再写入终端可见内容。
            status: Some(status.into()),
            content: String::new(),
        });
    }
    // 状态变化同样定向唤醒对应会话，避免多会话时每次事件都扫全部输出队列。
    let _ = app_handle.emit("terminal-output-ready", session_id);
}

fn is_transient_transport_read_error(error: &std::io::Error) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    // libssh2 非阻塞模式下 channel.read() 可能因 transport 层正在处理写入而返回多种瞬时错误；
    // 未到 EOF 时统一按瞬时错误重试，避免快速输入时误判断连。
    message.contains("transport read")
        || message.contains("transport write")
        || message.contains("session(-37)")
        || message.contains("would block")
        || message.contains("eagain")
        || message.contains("temporarily unavailable")
        || message.contains("try again")
        || message.contains("socket send")
        || message.contains("socket write")
}

fn is_transient_ssh_error(error: &impl std::fmt::Display) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    // direct-tcpip 非阻塞建连和 EOF 发送可能把 EAGAIN 包装成 ssh2::Error；这些都应继续轮询。
    message.contains("would block")
        || message.contains("eagain")
        || message.contains("session(-37)")
        || message.contains("temporarily unavailable")
        || message.contains("try again")
        || message.contains("transport read")
        || message.contains("transport write")
        || message.contains("socket send")
        || message.contains("socket write")
}

/// 目录同步标记使用 OSC 控制序列，终端可见内容会被后端过滤，仅把 cwd 元数据传给前端。
const CWD_SYNC_MARKER_PREFIX: &str = "\x1b]6973;MyTerminalCwd=";
/// 提示符标记只由 precmd/PROMPT_COMMAND/PS1 发出；与 cd 中途的 cwd 更新分开，才能安全修正提示符行边界。
const PROMPT_CWD_SYNC_MARKER_PREFIX: &str = "\x1b]6973;MyTerminalPromptCwd=";
const CWD_SYNC_MARKER_SUFFIX: char = '\x07';
const CWD_SYNC_SETUP_NAME: &str = "__myterminal_sync_cwd";
const CWD_SYNC_HISTORY_PREP_TOKEN: &str = "HIST_IGNORE_SPACE";
/// 部分命令行工具会在绘制进度时隐藏光标，异常返回 shell 时可能漏发恢复序列；提示符边界需要兜底恢复。
const TERMINAL_CURSOR_HIDE_SEQUENCE: &str = "\x1b[?25l";
const TERMINAL_CURSOR_SHOW_SEQUENCE: &str = "\x1b[?25h";
/// 光标控制序列长度固定为 6 字节，保留前一分片末尾 5 字节即可识别跨 SSH 分片的半截序列。
const TERMINAL_CURSOR_CONTROL_TAIL_BYTES: usize = TERMINAL_CURSOR_HIDE_SEQUENCE.len() - 1;

fn queue_cwd(
    queue: &Arc<std::sync::Mutex<TerminalOutputQueue>>,
    app_handle: &tauri::AppHandle,
    session_id: &str,
    cwd: impl Into<String>,
) {
    if let Ok(mut output) = queue.lock() {
        output.push_meta(TerminalOutputChunk {
            session_id: session_id.to_string(),
            cwd: Some(cwd.into()),
            status: None,
            content: String::new(),
        });
    }
    // cwd 元数据只影响当前会话，事件 payload 直接携带 session_id 供前端定向拉取。
    let _ = app_handle.emit("terminal-output-ready", session_id);
}

/// 注入到交互 Shell 的目录同步与历史落盘钩子；启动期会隐藏 setup 回显、规避新历史写入，并清理 bash 内存里的旧注入项。
fn shell_cwd_sync_command() -> String {
    // 目录同步依赖远端 shell 主动回传 PWD；Bash 子 shell 会继承可导出的标量 dispatcher 与函数，避免用户进入 bash 后 cd 不再联动。
    // cd/pushd/popd 包装函数只在交互 shell 中触发同步，避免非交互脚本继承函数后把 OSC 标记写入普通命令输出。
    // dispatcher 通过 OR-list 左项恢复失败状态，既让旧 hook 读取原 `$?`，又避免 errtrace 把内部状态构造误报成第二次 ERR。
    let setup_command = [
        "__myterminal_sync_cwd(){ printf '\\033]6973;MyTerminalCwd=%s\\a' \"$PWD\"; }",
        "__myterminal_sync_prompt_boundary(){ printf '\\033]6973;MyTerminalPromptCwd=%s\\a' \"$PWD\"; }",
        "__myterminal_sync_history(){ if [ -n \"${ZSH_VERSION-}\" ]; then fc -AI 2>/dev/null || true; elif [ -n \"${BASH_VERSION-}\" ]; then history -a 2>/dev/null || true; fi; }",
        "__myterminal_clean_history(){ if [ -n \"${BASH_VERSION-}\" ]; then for __myterminal_history_id in $(history | sed -n '/__myterminal_sync_cwd/{s/^ *\\([0-9][0-9]*\\).*/\\1/p}' | sort -rn); do history -d \"$__myterminal_history_id\" 2>/dev/null || true; done; unset __myterminal_history_id; fi; }",
        "__myterminal_is_interactive(){ case $- in *i*) return 0;; *) return 1;; esac; }",
        "__myterminal_install_cwd_wrappers(){ if [ -n \"${BASH_VERSION-}${ZSH_VERSION-}\" ]; then cd(){ builtin cd \"$@\"; __myterminal_status=$?; __myterminal_is_interactive && __myterminal_sync_cwd; return $__myterminal_status; }; pushd(){ builtin pushd \"$@\"; __myterminal_status=$?; __myterminal_is_interactive && __myterminal_sync_cwd; return $__myterminal_status; }; popd(){ builtin popd \"$@\"; __myterminal_status=$?; __myterminal_is_interactive && __myterminal_sync_cwd; return $__myterminal_status; }; fi; }",
        "__myterminal_sync_prompt(){ __myterminal_install_cwd_wrappers; __myterminal_sync_history; __myterminal_sync_prompt_boundary; }",
        // 让本会话命令在 history 文件中带真实执行时间戳：bash 只在命令入历史时 HISTTIMEFORMAT 非空才记录时间，故须会话级 export；zsh 须开启 EXTENDED_HISTORY。仅作用于当前 shell 进程，不写入用户配置文件，会话结束即失效。
        "if [ -n \"${BASH_VERSION-}\" ]; then export HISTTIMEFORMAT=\"%F %T \"; elif [ -n \"${ZSH_VERSION-}\" ]; then setopt EXTENDED_HISTORY 2>/dev/null || true; fi",
        "__myterminal_install_cwd_wrappers",
        "if [ -n \"${ZSH_VERSION-}\" ]; then autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd __myterminal_sync_prompt 2>/dev/null || PS1='$(__myterminal_sync_prompt)'\"$PS1\"",
        "elif [ -n \"${BASH_VERSION-}\" ]; then eval '__myterminal_sync_prompt_dispatch(){ local __myterminal_prompt_status=$? __myterminal_prompt_command; for __myterminal_prompt_command in \"${__myterminal_original_prompt_commands[@]-}\"; do [ -n \"$__myterminal_prompt_command\" ] || continue; if [ \"$__myterminal_prompt_status\" -eq 0 ]; then eval \"$__myterminal_prompt_command\"; else (exit \"$__myterminal_prompt_status\") || eval \"$__myterminal_prompt_command\"; fi; done; __myterminal_sync_prompt; return 0; }'; if declare -p PROMPT_COMMAND 2>/dev/null | grep -q '^declare -[^ ]*a[^ ]* '; then eval '__myterminal_original_prompt_commands=(\"${PROMPT_COMMAND[@]}\")'; elif [ -n \"${PROMPT_COMMAND-}\" ] && [ \"$PROMPT_COMMAND\" != \"__myterminal_sync_prompt_dispatch\" ]; then eval '__myterminal_original_prompt_commands=(\"$PROMPT_COMMAND\")'; else eval '__myterminal_original_prompt_commands=()'; fi; unset PROMPT_COMMAND; PROMPT_COMMAND=__myterminal_sync_prompt_dispatch; export PROMPT_COMMAND; export -f __myterminal_sync_cwd __myterminal_sync_prompt_boundary __myterminal_sync_history __myterminal_is_interactive __myterminal_install_cwd_wrappers __myterminal_sync_prompt __myterminal_sync_prompt_dispatch cd pushd popd 2>/dev/null || true",
        "else PS1='$(__myterminal_sync_prompt)'\"$PS1\"",
        "fi",
        "__myterminal_clean_history",
        "__myterminal_sync_prompt",
    ]
    .join("; ");

    [
        // 先让常见交互 Shell 忽略空格开头的历史项，再用空格前缀注入真正的 setup 命令，避免用户按上键翻到内部协议。
        " HISTCONTROL=\"${HISTCONTROL:+$HISTCONTROL:}ignorespace\"; setopt HIST_IGNORE_SPACE 2>/dev/null || true\n".to_string(),
        format!(" {setup_command}\n"),
    ]
    .concat()
}

/// ANSI 状态跟踪只用于判断当前行是否已有可见内容；跨分片忽略 CSI/OSC 参数，避免颜色码被误判成正文。
#[derive(Clone, Copy)]
enum TerminalVisibleLineEscapeState {
    Ground,
    Escape,
    Csi,
    String,
    StringEscape,
}

impl Default for TerminalVisibleLineEscapeState {
    fn default() -> Self {
        Self::Ground
    }
}

/// 找到两类同步标记中最先出现的一类；提示符标记额外携带“即将绘制 PS1”的边界语义。
fn find_next_shell_sync_marker(value: &str) -> Option<(usize, &'static str, bool)> {
    [
        (CWD_SYNC_MARKER_PREFIX, false),
        (PROMPT_CWD_SYNC_MARKER_PREFIX, true),
    ]
    .into_iter()
    .filter_map(|(prefix, is_prompt)| {
        value
            .find(prefix)
            .map(|index| (index, prefix, is_prompt))
    })
    .min_by_key(|(index, _, _)| *index)
}

/// 输出分片末尾可能只包含任一标记的前半截；保留最长匹配，下一分片到达后再统一解析。
fn trailing_shell_sync_marker_prefix_len(value: &str) -> usize {
    let mut keep = 0;
    for marker_prefix in [CWD_SYNC_MARKER_PREFIX, PROMPT_CWD_SYNC_MARKER_PREFIX] {
        for (index, _) in marker_prefix.char_indices().skip(1) {
            let prefix = &marker_prefix[..index];
            if value.ends_with(prefix) {
                keep = keep.max(prefix.len());
            }
        }
    }
    keep
}

/// 记录跨 SSH 分片的半截 OSC 标记和当前可见行状态，保证同步协议不泄漏且提示符总能从干净新行开始。
struct ShellOutputFilter {
    pending: String,
    suppress_setup_echo_line: bool,
    suppress_initial_setup_echo: bool,
    cursor_hidden_by_remote_output: bool,
    cursor_control_tail: String,
    visible_line_dirty: bool,
    visible_line_position_uncertain: bool,
    visible_line_escape_state: TerminalVisibleLineEscapeState,
    visible_line_csi_parameters: String,
}

impl Default for ShellOutputFilter {
    fn default() -> Self {
        Self {
            pending: String::new(),
            suppress_setup_echo_line: false,
            suppress_initial_setup_echo: true,
            cursor_hidden_by_remote_output: false,
            cursor_control_tail: String::new(),
            visible_line_dirty: false,
            visible_line_position_uncertain: false,
            visible_line_escape_state: TerminalVisibleLineEscapeState::default(),
            visible_line_csi_parameters: String::new(),
        }
    }
}

impl ShellOutputFilter {
    /// 解析普通终端输出和目录同步标记；返回值第一项写入终端，第二项更新文件管理 cwd。
    fn consume(&mut self, content: &str) -> (String, Vec<String>) {
        self.pending.push_str(content);
        let mut visible = String::new();
        let mut cwd_updates = Vec::new();

        loop {
            if let Some((marker_start, marker_prefix, is_prompt_marker)) =
                find_next_shell_sync_marker(&self.pending)
            {
                let before_marker = self.pending[..marker_start].to_string();
                self.push_filtered_visible(&mut visible, &before_marker);
                let value_start = marker_start + marker_prefix.len();

                if let Some(value_end) = self.pending[value_start..].find(CWD_SYNC_MARKER_SUFFIX) {
                    let cwd = self.pending[value_start..value_start + value_end]
                        .trim()
                        .to_string();
                    if !cwd.is_empty() {
                        cwd_updates.push(cwd);
                    }
                    // 第一次 cwd 标记说明启动注入已执行完毕；之后如果用户历史里出现内部函数名，不能再隐藏 readline 的重绘输出。
                    self.suppress_initial_setup_echo = false;
                    if is_prompt_marker {
                        self.prepare_prompt_line(&mut visible);
                        self.restore_cursor_at_prompt_boundary(&mut visible);
                    }
                    let remainder_start =
                        value_start + value_end + CWD_SYNC_MARKER_SUFFIX.len_utf8();
                    self.pending = self.pending[remainder_start..].to_string();
                    continue;
                }

                self.pending = self.pending[marker_start..].to_string();
                break;
            }

            let keep = trailing_shell_sync_marker_prefix_len(&self.pending);

            let drain_len = self.pending.len().saturating_sub(keep);
            let drainable = self.pending[..drain_len].to_string();
            self.push_filtered_visible(&mut visible, &drainable);
            self.pending = self.pending[drain_len..].to_string();
            break;
        }

        (visible, cwd_updates)
    }

    /// 写入真正要交给 xterm 的内容，并同步跟踪远端是否把光标切到隐藏状态。
    fn push_filtered_visible(&mut self, visible: &mut String, value: &str) {
        let filtered = self.strip_cwd_sync_setup_echo(value);
        if filtered.is_empty() {
            return;
        }

        self.track_cursor_visibility_sequences(&filtered);
        self.track_visible_line_state(&filtered);
        visible.push_str(&filtered);
    }

    /// 跟踪真正交给 xterm 的文本：LF 完成当前行，CR 只回到行首而不会抹掉进度文本，ANSI 参数不算可见内容。
    fn track_visible_line_state(&mut self, value: &str) {
        for byte in value.bytes() {
            self.visible_line_escape_state = match self.visible_line_escape_state {
                TerminalVisibleLineEscapeState::Ground => match byte {
                    b'\x1b' => TerminalVisibleLineEscapeState::Escape,
                    b'\n' => {
                        // 光标曾被定位/恢复到旧区域时，LF 可能落入已有正文行；只有顺序输出位置才可判定新行干净。
                        self.visible_line_dirty = self.visible_line_position_uncertain;
                        TerminalVisibleLineEscapeState::Ground
                    }
                    // CR/退格只移动光标，屏幕上的旧字符仍存在；Tab 会占据视觉位置，应视作非空行。
                    b'\r' | b'\x08' => TerminalVisibleLineEscapeState::Ground,
                    b'\t' => {
                        self.visible_line_dirty = true;
                        TerminalVisibleLineEscapeState::Ground
                    }
                    0x00..=0x1f | 0x7f => TerminalVisibleLineEscapeState::Ground,
                    _ => {
                        self.visible_line_dirty = true;
                        TerminalVisibleLineEscapeState::Ground
                    }
                },
                TerminalVisibleLineEscapeState::Escape => match byte {
                    b'[' => {
                        self.visible_line_csi_parameters.clear();
                        TerminalVisibleLineEscapeState::Csi
                    }
                    b']' | b'P' | b'_' | b'^' => TerminalVisibleLineEscapeState::String,
                    b'\x1b' => TerminalVisibleLineEscapeState::Escape,
                    // DECRC、IND、RI 会回到或进入可能已有正文的行，保守标脏可避免后续 2K 抹掉内容。
                    b'8' | b'D' | b'M' => {
                        self.visible_line_dirty = true;
                        self.visible_line_position_uncertain = true;
                        TerminalVisibleLineEscapeState::Ground
                    }
                    // NEL 在顺序输出时进入干净新行；位置不确定时目标行可能已有正文，RIS 才能无条件复位。
                    b'E' => {
                        self.visible_line_dirty = self.visible_line_position_uncertain;
                        TerminalVisibleLineEscapeState::Ground
                    }
                    b'c' => {
                        self.visible_line_dirty = false;
                        self.visible_line_position_uncertain = false;
                        TerminalVisibleLineEscapeState::Ground
                    }
                    _ => TerminalVisibleLineEscapeState::Ground,
                },
                TerminalVisibleLineEscapeState::Csi => {
                    if (0x40..=0x7e).contains(&byte) {
                        let has_private_prefix = self
                            .visible_line_csi_parameters
                            .starts_with(['?', '>', '<', '=']);
                        let first_parameter = self
                            .visible_line_csi_parameters
                            .trim_start_matches(['?', '>', '<', '='])
                            .split(';')
                            .next()
                            .and_then(|value| value.parse::<u16>().ok());
                        // 光标定位可能在 LF 后重新回到已有正文行；保守标脏可多留一行，但绝不能让提示符清掉最后一行输出。
                        if !has_private_prefix
                            && ((byte == b'J' && first_parameter == Some(2))
                                || (byte == b'K' && first_parameter == Some(2)))
                        {
                            // ED 2 与 EL 2 已明确清掉当前屏/当前行；ED 3 只清 scrollback，不能把正文误判为空。
                            self.visible_line_dirty = false;
                            if byte == b'J' {
                                self.visible_line_position_uncertain = false;
                            }
                        } else if byte == b'l'
                            && self.visible_line_csi_parameters.starts_with('?')
                            && matches!(first_parameter, Some(47 | 1047 | 1049))
                        {
                            // 退出 alternate screen 会恢复主缓冲区和旧光标，当前行可能已有启动命令或正文。
                            self.visible_line_dirty = true;
                            self.visible_line_position_uncertain = true;
                        } else if matches!(
                            byte,
                            b'A' | b'B'
                                | b'C'
                                | b'D'
                                | b'E'
                                | b'F'
                                | b'G'
                                | b'H'
                                | b'a'
                                | b'd'
                                | b'e'
                                | b'f'
                                | b'r'
                                | b's'
                                | b'u'
                        ) {
                            self.visible_line_dirty = true;
                            self.visible_line_position_uncertain = true;
                        }
                        self.visible_line_csi_parameters.clear();
                        TerminalVisibleLineEscapeState::Ground
                    } else if byte == b'\x1b' {
                        self.visible_line_csi_parameters.clear();
                        TerminalVisibleLineEscapeState::Escape
                    } else {
                        // 参数和中间字节只用于识别完整清屏/清行；设置硬上限，异常长控制串不能无限占用内存。
                        if self.visible_line_csi_parameters.len() < 32
                            && (0x20..=0x3f).contains(&byte)
                        {
                            self.visible_line_csi_parameters.push(byte as char);
                        }
                        TerminalVisibleLineEscapeState::Csi
                    }
                }
                TerminalVisibleLineEscapeState::String => match byte {
                    b'\x07' => TerminalVisibleLineEscapeState::Ground,
                    b'\x1b' => TerminalVisibleLineEscapeState::StringEscape,
                    _ => TerminalVisibleLineEscapeState::String,
                },
                TerminalVisibleLineEscapeState::StringEscape => match byte {
                    b'\\' => TerminalVisibleLineEscapeState::Ground,
                    b'\x1b' => TerminalVisibleLineEscapeState::StringEscape,
                    _ => TerminalVisibleLineEscapeState::String,
                },
            };
        }
    }

    /// 解析远端输出中的光标显示/隐藏控制序列；只记录最后一次状态，实际序列仍原样交给 xterm。
    fn track_cursor_visibility_sequences(&mut self, value: &str) {
        let combined = format!("{}{}", self.cursor_control_tail, value);
        let last_hide = combined.rfind(TERMINAL_CURSOR_HIDE_SEQUENCE);
        let last_show = combined.rfind(TERMINAL_CURSOR_SHOW_SEQUENCE);

        match (last_hide, last_show) {
            (Some(hide_index), Some(show_index)) => {
                self.cursor_hidden_by_remote_output = hide_index > show_index;
            }
            (Some(_), None) => {
                self.cursor_hidden_by_remote_output = true;
            }
            (None, Some(_)) => {
                self.cursor_hidden_by_remote_output = false;
            }
            (None, None) => {}
        }

        self.cursor_control_tail =
            keep_trailing_utf8_by_bytes(&combined, TERMINAL_CURSOR_CONTROL_TAIL_BYTES);
    }

    /// shell 提示符即将出现时若远端遗漏了恢复光标，则补发一次 show cursor，避免后续输入看不到插入点。
    fn restore_cursor_at_prompt_boundary(&mut self, visible: &mut String) {
        if !self.cursor_hidden_by_remote_output {
            return;
        }

        visible.push_str(TERMINAL_CURSOR_SHOW_SEQUENCE);
        self.cursor_hidden_by_remote_output = false;
        self.cursor_control_tail.clear();
    }

    /// 真正的 shell 提示符出现前保留未换行正文，再清空新提示符行；既修复 cat 粘连，也清掉动态重绘留下的 `ted` 等尾巴。
    fn prepare_prompt_line(&mut self, visible: &mut String) {
        if self.visible_line_dirty {
            if self.visible_line_position_uncertain {
                // 光标可能位于旧屏幕任意行；先恢复全屏滚动区并下移到底部，再 LF 滚出新空行，避免 2K 删除下一行正文。
                visible.push_str("\x1b[r\x1b[999B");
            }
            visible.push_str("\r\n");
        }
        // marker 位于 PROMPT_COMMAND/precmd/PS1 开头，此时清行不会删除提示符，只会移除旧进度行或 resize 重绘残留。
        visible.push_str("\r\x1b[2K");
        self.visible_line_dirty = false;
        self.visible_line_position_uncertain = false;
        self.visible_line_escape_state = TerminalVisibleLineEscapeState::Ground;
        self.visible_line_csi_parameters.clear();
    }

    /// 过滤我方注入命令的回显，避免用户在终端里看到同步协议细节。
    fn strip_cwd_sync_setup_echo(&mut self, value: &str) -> String {
        let mut visible = String::new();

        for line in value.split_inclusive('\n') {
            let is_initial_setup_echo = self.suppress_initial_setup_echo
                && (line.contains(CWD_SYNC_SETUP_NAME)
                    || line.contains(CWD_SYNC_HISTORY_PREP_TOKEN));
            if is_initial_setup_echo {
                self.suppress_setup_echo_line = true;
            }

            if !self.suppress_setup_echo_line {
                visible.push_str(line);
            }

            if line.ends_with('\n') {
                self.suppress_setup_echo_line = false;
            }
        }

        visible
    }
}

/// 按 UTF-8 字符边界保留字符串末尾若干字节，避免中文输出被光标序列探测逻辑截断到非法边界。
fn keep_trailing_utf8_by_bytes(value: &str, max_bytes: usize) -> String {
    let mut tail = String::new();
    for ch in value.chars().rev() {
        if tail.len() + ch.len_utf8() > max_bytes {
            break;
        }
        tail.insert(0, ch);
    }
    tail
}

#[cfg(test)]
mod shell_output_filter_tests {
    use super::*;

    fn cwd_marker(cwd: &str) -> String {
        format!("{CWD_SYNC_MARKER_PREFIX}{cwd}{CWD_SYNC_MARKER_SUFFIX}")
    }

    fn prompt_marker(cwd: &str) -> String {
        format!("{PROMPT_CWD_SYNC_MARKER_PREFIX}{cwd}{CWD_SYNC_MARKER_SUFFIX}")
    }

    #[test]
    fn build_remote_copy_command_quotes_sources_and_target() {
        let sources = vec!["/ology/hello.txt".to_string(), "/ology/ology dir".to_string()];
        let command = build_remote_copy_command(&sources, "/backup").expect("command should build");
        // -- 终止选项，源与目标各自单引号包裹，空格路径不会被拆分。
        assert_eq!(
            command,
            "cp -rp -- '/ology/hello.txt' '/ology/ology dir' '/backup' && printf ok"
        );
    }

    #[test]
    fn dedupe_font_names_trims_dedupes_and_sorts() {
        let names = [
            "  JetBrains Mono ",
            "Microsoft YaHei",
            "jetbrains mono",
            "",
            "Cascadia Mono",
        ]
        .into_iter()
        .map(str::to_string);
        // 去空白、按小写去重（保留首次出现的大小写）、按字母排序。
        assert_eq!(
            dedupe_font_names(names),
            vec![
                "Cascadia Mono".to_string(),
                "JetBrains Mono".to_string(),
                "Microsoft YaHei".to_string(),
            ]
        );
    }

    #[test]
    fn build_remote_copy_command_escapes_single_quote() {
        let sources = vec!["/ology/it's here".to_string()];
        let command = build_remote_copy_command(&sources, "/tmp").expect("command should build");
        // 文件名中的单引号必须转义成 '\'' 序列，避免提前闭合引号导致命令注入或解析错乱。
        assert_eq!(command, "cp -rp -- '/ology/it'\\''s here' '/tmp' && printf ok");
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
    fn restores_cursor_when_prompt_marker_arrives_after_hidden_cursor() {
        let mut filter = ShellOutputFilter::default();
        let input = format!(
            "docker progress{TERMINAL_CURSOR_HIDE_SEQUENCE}{}",
            prompt_marker("/ology/ology-server")
        );

        let (visible, cwd_updates) = filter.consume(&input);

        assert_eq!(cwd_updates, vec!["/ology/ology-server".to_string()]);
        assert_eq!(
            visible,
            format!(
                "docker progress{TERMINAL_CURSOR_HIDE_SEQUENCE}\r\n\r\x1b[2K{TERMINAL_CURSOR_SHOW_SEQUENCE}"
            )
        );
    }

    #[test]
    fn does_not_duplicate_remote_cursor_restore_before_prompt_marker() {
        let mut filter = ShellOutputFilter::default();
        let input = format!(
            "{TERMINAL_CURSOR_HIDE_SEQUENCE}{TERMINAL_CURSOR_SHOW_SEQUENCE}{}",
            prompt_marker("/tmp")
        );

        let (visible, cwd_updates) = filter.consume(&input);

        assert_eq!(cwd_updates, vec!["/tmp".to_string()]);
        assert_eq!(visible.matches(TERMINAL_CURSOR_SHOW_SEQUENCE).count(), 1);
    }

    #[test]
    fn tracks_cursor_hide_sequence_split_across_output_chunks() {
        let mut filter = ShellOutputFilter::default();

        let (first_visible, _) = filter.consume("\x1b[?2");
        let (second_visible, _) = filter.consume("5l");
        let (prompt_visible, cwd_updates) = filter.consume(&prompt_marker("/split"));

        assert_eq!(first_visible, "\x1b[?2");
        assert_eq!(second_visible, "5l");
        assert_eq!(cwd_updates, vec!["/split".to_string()]);
        assert_eq!(
            prompt_visible,
            format!("\r\x1b[2K{TERMINAL_CURSOR_SHOW_SEQUENCE}")
        );
    }

    #[test]
    fn keeps_prompt_marker_without_cursor_restore_when_cursor_was_visible() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) = filter.consume(&prompt_marker("/visible"));

        assert_eq!(visible, "\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/visible".to_string()]);
    }

    #[test]
    fn moves_prompt_after_output_without_trailing_line_feed() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) = filter.consume(&format!("cat tail{}", prompt_marker("/cat")));

        assert_eq!(visible, "cat tail\r\n\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/cat".to_string()]);
    }

    #[test]
    fn preserves_carriage_return_progress_before_clearing_prompt_line() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) =
            filter.consume(&format!("Container Started\r{}", prompt_marker("/docker")));

        assert_eq!(visible, "Container Started\r\r\n\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/docker".to_string()]);
    }

    #[test]
    fn ansi_after_completed_line_does_not_insert_an_extra_blank_line() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) =
            filter.consume(&format!("done\r\n\x1b[0m{}", prompt_marker("/ansi")));

        assert_eq!(visible, "done\r\n\x1b[0m\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/ansi".to_string()]);
    }

    #[test]
    fn cwd_marker_inside_compound_command_does_not_break_the_output_line() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) =
            filter.consume(&format!("before{}after", cwd_marker("/middle")));

        assert_eq!(visible, "beforeafter");
        assert_eq!(cwd_updates, vec!["/middle".to_string()]);
    }

    #[test]
    fn keeps_both_marker_prefixes_private_when_split_across_chunks() {
        let mut filter = ShellOutputFilter::default();
        let cwd_split = CWD_SYNC_MARKER_PREFIX.len() - 3;

        let (cwd_prefix_visible, _) = filter.consume(&CWD_SYNC_MARKER_PREFIX[..cwd_split]);
        let (cwd_visible, cwd_updates) = filter.consume(&format!(
            "{}{}{}",
            &CWD_SYNC_MARKER_PREFIX[cwd_split..],
            "/cwd-split",
            CWD_SYNC_MARKER_SUFFIX
        ));

        assert_eq!(cwd_prefix_visible, "");
        assert_eq!(cwd_visible, "");
        assert_eq!(cwd_updates, vec!["/cwd-split".to_string()]);

        let prompt_split = PROMPT_CWD_SYNC_MARKER_PREFIX.len() - 4;
        let (prompt_prefix_visible, _) =
            filter.consume(&PROMPT_CWD_SYNC_MARKER_PREFIX[..prompt_split]);
        let (prompt_visible, prompt_updates) = filter.consume(&format!(
            "{}{}{}",
            &PROMPT_CWD_SYNC_MARKER_PREFIX[prompt_split..],
            "/prompt-split",
            CWD_SYNC_MARKER_SUFFIX
        ));

        assert_eq!(prompt_prefix_visible, "");
        assert_eq!(prompt_visible, "\r\x1b[2K");
        assert_eq!(prompt_updates, vec!["/prompt-split".to_string()]);
    }

    #[test]
    fn tracks_ansi_sequence_split_after_a_completed_line() {
        let mut filter = ShellOutputFilter::default();

        let (first_visible, _) = filter.consume("done\r\n\x1b[3");
        let (second_visible, _) = filter.consume("1m");
        let (prompt_visible, cwd_updates) = filter.consume(&prompt_marker("/ansi-split"));

        assert_eq!(first_visible, "done\r\n\x1b[3");
        assert_eq!(second_visible, "1m");
        assert_eq!(prompt_visible, "\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/ansi-split".to_string()]);
    }

    #[test]
    fn preserves_output_when_csi_moves_cursor_back_before_prompt() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) =
            filter.consume(&format!("done\r\n\x1b[1A{}", prompt_marker("/cursor-up")));

        assert_eq!(visible, "done\r\n\x1b[1A\x1b[r\x1b[999B\r\n\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/cursor-up".to_string()]);
    }

    #[test]
    fn clear_screen_keeps_the_next_prompt_on_the_first_clean_line() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) =
            filter.consume(&format!("old\r\n\x1b[H\x1b[2J{}", prompt_marker("/clear")));

        assert_eq!(visible, "old\r\n\x1b[H\x1b[2J\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/clear".to_string()]);
    }

    #[test]
    fn erased_progress_line_does_not_create_an_unneeded_blank_line() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) = filter.consume(&format!(
            "progress\r\x1b[2K{}",
            prompt_marker("/erased-progress")
        ));

        assert_eq!(visible, "progress\r\x1b[2K\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/erased-progress".to_string()]);
    }

    #[test]
    fn dec_cursor_restore_preserves_the_saved_output_line() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) =
            filter.consume(&format!("body\x1b7\r\n\x1b8{}", prompt_marker("/dec-restore")));

        assert_eq!(
            visible,
            "body\x1b7\r\n\x1b8\x1b[r\x1b[999B\r\n\r\x1b[2K"
        );
        assert_eq!(cwd_updates, vec!["/dec-restore".to_string()]);
    }

    #[test]
    fn erase_scrollback_does_not_mark_visible_body_as_cleared() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) =
            filter.consume(&format!("body\x1b[3J{}", prompt_marker("/scrollback")));

        assert_eq!(visible, "body\x1b[3J\r\n\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/scrollback".to_string()]);
    }

    #[test]
    fn alternate_screen_restore_preserves_the_main_buffer_line() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) = filter.consume(&format!(
            "\r\n\x1b[?1049l{}",
            prompt_marker("/alternate-screen")
        ));

        assert_eq!(
            visible,
            "\r\n\x1b[?1049l\x1b[r\x1b[999B\r\n\r\x1b[2K"
        );
        assert_eq!(cwd_updates, vec!["/alternate-screen".to_string()]);
    }

    #[test]
    fn line_feed_after_cursor_positioning_does_not_clear_an_existing_row() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) = filter.consume(&format!(
            "top\r\nvictim\x1b[1A\n{}",
            prompt_marker("/positioned-lf")
        ));

        assert_eq!(
            visible,
            "top\r\nvictim\x1b[1A\n\x1b[r\x1b[999B\r\n\r\x1b[2K"
        );
        assert_eq!(cwd_updates, vec!["/positioned-lf".to_string()]);
    }

    #[test]
    fn next_line_after_cursor_positioning_does_not_clear_an_existing_row() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) = filter.consume(&format!(
            "top\r\nvictim\x1b[1A\x1bE{}",
            prompt_marker("/positioned-nel")
        ));

        assert_eq!(
            visible,
            "top\r\nvictim\x1b[1A\x1bE\x1b[r\x1b[999B\r\n\r\x1b[2K"
        );
        assert_eq!(cwd_updates, vec!["/positioned-nel".to_string()]);
    }

    #[test]
    fn uncertain_cursor_moves_to_bottom_before_creating_prompt_line() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) = filter.consume(&format!(
            "one\r\ntwo\r\nthree\x1b[2A\n{}",
            prompt_marker("/three-lines")
        ));

        assert_eq!(
            visible,
            "one\r\ntwo\r\nthree\x1b[2A\n\x1b[r\x1b[999B\r\n\r\x1b[2K"
        );
        assert_eq!(cwd_updates, vec!["/three-lines".to_string()]);
    }

    #[test]
    fn private_erase_display_does_not_claim_the_visible_line_is_empty() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) =
            filter.consume(&format!("body\x1b[?2J{}", prompt_marker("/private-ed")));

        assert_eq!(visible, "body\x1b[?2J\r\n\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/private-ed".to_string()]);
    }

    #[test]
    fn decstbm_reset_preserves_body_after_moving_the_cursor_home() {
        let mut filter = ShellOutputFilter::default();

        // DECSTBM 即使不带参数也会把 xterm 光标移回 Home；提示符必须先转移到底部空行，不能清掉首行正文。
        let (visible, cwd_updates) =
            filter.consume(&format!("body\r\n\x1b[r{}", prompt_marker("/decstbm")));

        assert_eq!(visible, "body\r\n\x1b[r\x1b[r\x1b[999B\r\n\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/decstbm".to_string()]);
    }

    #[test]
    fn exports_bash_cwd_sync_hook_for_child_shells() {
        let command = shell_cwd_sync_command();

        assert!(command.contains("export PROMPT_COMMAND"));
        assert!(command.contains("export -f __myterminal_sync_cwd"));
        // 可导出的标量 dispatcher 在父 Shell 重放原数组/标量 hook 后再发 marker，尾分号不会与我方命令拼成 `;;`。
        assert!(command.contains("__myterminal_original_prompt_commands"));
        assert!(command.contains("^declare -[^ ]*a[^ ]* "));
        assert!(command.contains("PROMPT_COMMAND=__myterminal_sync_prompt_dispatch"));
        // dispatcher 只把原退出状态提供给旧 hook；自身必须成功返回，避免失败命令二次触发用户 ERR trap。
        assert!(command.contains(
            "else (exit \"$__myterminal_prompt_status\") || eval \"$__myterminal_prompt_command\"; fi"
        ));
        assert!(!command.contains(
            "; (exit \"$__myterminal_prompt_status\"); eval \"$__myterminal_prompt_command\";"
        ));
        assert!(command.contains("__myterminal_sync_prompt; return 0;"));
        assert!(!command.contains("return \"$__myterminal_prompt_status\""));
        assert!(!command.contains("$PROMPT_COMMAND;}__myterminal_sync_prompt"));
        assert!(command.contains("__myterminal_install_cwd_wrappers"));
        assert!(command.contains("cd pushd popd"));
        assert!(command.contains("case $- in *i*)"));
    }

    #[test]
    fn recognizes_direct_claude_commands_for_synchronized_output() {
        // 直接命令、脚本后缀、大小写、相对路径和 PowerShell 引号路径都必须命中 Claude 专用同步帧兜底。
        for command in [
            "claude",
            "CLAUDE.EXE --permission-mode manual",
            "./claude-code --continue",
            r#"& "C:\Tools\claude.cmd" --model sonnet"#,
            r#"& 'C:\Program Files\Claude\claude-code.ps1' --continue"#,
        ] {
            assert!(
                should_force_claude_synchronized_output(command),
                "command should enable synchronized output: {command}"
            );
        }
    }

    #[test]
    fn recognizes_only_direct_qwen_commands_for_its_own_synchronized_output() {
        // Qwen 必须使用自己的官方变量；直接脚本路径可命中，包管理器二次分发和相似名称不能猜测。
        for command in [
            "qwen",
            "QWEN-CODE.EXE --continue",
            r#"& "C:\Tools\qwen.cmd" --model coder"#,
        ] {
            assert!(
                should_force_qwen_synchronized_output(command),
                "command should enable Qwen synchronized output: {command}"
            );
        }
        for command in ["npx qwen", "qwen-helper", "claude", "codex"] {
            assert!(
                !should_force_qwen_synchronized_output(command),
                "command should keep Qwen environment unchanged: {command}"
            );
        }
    }

    #[test]
    fn leaves_indirect_or_unrelated_commands_unchanged() {
        // 无法可靠判断最终子进程的包装命令和名称相似项不能误注入 Claude 专用变量。
        for command in [
            "",
            "npx claude",
            "pnpm exec claude",
            "echo claude",
            "claude-helper",
            "not-claude.exe",
            "codex",
        ] {
            assert!(
                !should_force_claude_synchronized_output(command),
                "command should keep the default environment: {command}"
            );
        }
    }
}

fn ssh_error(error: impl std::fmt::Display) -> AppError {
    AppError::Ssh(error.to_string())
}

fn non_empty_trimmed(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn expand_home_path(raw_path: &str) -> PathBuf {
    let trimmed = raw_path.trim();
    if trimmed == "~" || trimmed.starts_with("~/") || trimmed.starts_with("~\\") {
        if let Some(home) = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")) {
            let mut expanded = PathBuf::from(home);
            if trimmed.len() > 2 {
                expanded.push(&trimmed[2..]);
            }
            return expanded;
        }
    }

    PathBuf::from(trimmed)
}

struct SshAuthConfig<'a> {
    username: &'a str,
    auth_method: &'a str,
    password: &'a str,
    private_key_path: Option<&'a str>,
    private_key_text: Option<&'a str>,
    passphrase: Option<&'a str>,
}

impl<'a> SshAuthConfig<'a> {
    fn from_connection(connection: &'a ConnectionProfile) -> Self {
        Self {
            username: &connection.username,
            auth_method: &connection.auth_method,
            password: &connection.password,
            private_key_path: connection.private_key_path.as_deref(),
            private_key_text: connection.private_key_text.as_deref(),
            passphrase: connection.passphrase.as_deref(),
        }
    }

    fn from_jump_host(jump_host: &'a SshJumpHost) -> Self {
        Self {
            username: &jump_host.username,
            auth_method: &jump_host.auth_method,
            password: &jump_host.password,
            private_key_path: jump_host.private_key_path.as_deref(),
            private_key_text: jump_host.private_key_text.as_deref(),
            passphrase: jump_host.passphrase.as_deref(),
        }
    }
}

fn authenticate_ssh_session(session: &Session, auth: &SshAuthConfig<'_>) -> Result<(), AppError> {
    let auth_method = auth.auth_method.trim();
    let username = auth.username.trim();

    if auth_method.eq_ignore_ascii_case("privateKey") {
        let passphrase = non_empty_trimmed(auth.passphrase);

        if let Some(private_key_text) = non_empty_trimmed(auth.private_key_text) {
            session
                .userauth_pubkey_memory(username, None, private_key_text, passphrase)
                .map_err(ssh_error)?;
            return Ok(());
        }

        let private_key_path = non_empty_trimmed(auth.private_key_path).ok_or_else(|| {
            AppError::Validation(
                "private key authentication requires a key path or pasted key content".into(),
            )
        })?;

        session
            .userauth_pubkey_file(
                username,
                None,
                &expand_home_path(private_key_path),
                passphrase,
            )
            .map_err(ssh_error)?;

        return Ok(());
    }

    let password = auth.password.trim();
    if password.is_empty() {
        return Err(AppError::Validation(
            "password authentication requires a password".into(),
        ));
    }

    session
        .userauth_password(username, password)
        .map_err(ssh_error)?;

    Ok(())
}

fn is_key_exchange_error(error: &AppError) -> bool {
    let AppError::Ssh(message) = error else {
        return false;
    };

    let normalized = message.to_ascii_lowercase();
    normalized.contains("unable to exchange encryption keys") || normalized.contains("session(-8)")
}

fn configure_ssh_compatibility_preferences(session: &Session) -> Result<(), AppError> {
    // 兼容模式只在默认密钥交换失败后启用：优先走稳定的 group14，再保留曲线、GEX 和旧算法兜底。
    let preferences = [
        (
            MethodType::Kex,
            "diffie-hellman-group14-sha256,diffie-hellman-group14-sha1,ecdh-sha2-nistp256,ecdh-sha2-nistp384,ecdh-sha2-nistp521,curve25519-sha256,curve25519-sha256@libssh.org,diffie-hellman-group-exchange-sha256,diffie-hellman-group-exchange-sha1,diffie-hellman-group1-sha1",
        ),
        (
            MethodType::HostKey,
            "ssh-ed25519,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521,rsa-sha2-512,rsa-sha2-256,ssh-rsa,ssh-dss",
        ),
        (
            MethodType::CryptCs,
            "aes256-ctr,aes192-ctr,aes128-ctr,aes256-gcm@openssh.com,aes128-gcm@openssh.com,aes256-cbc,aes192-cbc,aes128-cbc,3des-cbc",
        ),
        (
            MethodType::CryptSc,
            "aes256-ctr,aes192-ctr,aes128-ctr,aes256-gcm@openssh.com,aes128-gcm@openssh.com,aes256-cbc,aes192-cbc,aes128-cbc,3des-cbc",
        ),
        (
            MethodType::MacCs,
            "hmac-sha2-512,hmac-sha2-256,hmac-sha1,hmac-sha1-96,hmac-md5,hmac-md5-96",
        ),
        (
            MethodType::MacSc,
            "hmac-sha2-512,hmac-sha2-256,hmac-sha1,hmac-sha1-96,hmac-md5,hmac-md5-96",
        ),
    ];

    for (method_type, prefs) in preferences {
        session.method_pref(method_type, prefs).map_err(ssh_error)?;
    }

    Ok(())
}

fn format_tcp_endpoint(host: &str, port: u16) -> String {
    let trimmed = host.trim();
    // IPv6 字面量作为 host:port 使用时必须加方括号；普通域名、IPv4 和已带括号的 IPv6 保持原样。
    if trimmed.contains(':') && !trimmed.starts_with('[') {
        format!("[{trimmed}]:{port}")
    } else {
        format!("{trimmed}:{port}")
    }
}

fn strip_ipv6_brackets(host: &str) -> &str {
    let trimmed = host.trim();
    // 表单里允许用户按 URI 习惯填写 [::1]；SOCKS5 地址字段需要裸 IPv6 字节，不能保留方括号。
    trimmed
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(trimmed)
}

fn resolve_tcp_address(host: &str, port: u16) -> Result<Vec<std::net::SocketAddr>, AppError> {
    let address = format_tcp_endpoint(host, port);
    let addresses = address.to_socket_addrs()?.collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err(AppError::Io(std::io::Error::new(
            std::io::ErrorKind::AddrNotAvailable,
            format!("no resolved address for {address}"),
        )));
    }
    Ok(addresses)
}

fn connect_tcp_direct(host: &str, port: u16) -> Result<TcpStream, AppError> {
    // 所有 SSH 辅助连接都共享固定连接超时，避免不可达地址拖住 UI 刷新和测试连接。
    let mut last_error = None;
    for socket_address in resolve_tcp_address(host, port)? {
        match TcpStream::connect_timeout(&socket_address, SSH_CONNECT_TIMEOUT) {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error),
        }
    }

    Err(AppError::Io(last_error.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::AddrNotAvailable,
            "no reachable TCP address",
        )
    })))
}

fn read_http_proxy_response(stream: &mut TcpStream) -> Result<String, AppError> {
    let mut response = Vec::new();
    let mut buffer = [0_u8; 1];
    while response.len() < 16 * 1024 {
        let read = stream.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        response.push(buffer[0]);
        if response.ends_with(b"\r\n\r\n") {
            break;
        }
    }

    String::from_utf8(response)
        .map_err(|error| AppError::Validation(format!("invalid HTTP proxy response: {error}")))
}

fn connect_http_proxy(
    proxy: &SshProxyConfig,
    target_host: &str,
    target_port: u16,
) -> Result<TcpStream, AppError> {
    let mut stream = connect_tcp_direct(&proxy.host, proxy.port)?;
    stream.set_read_timeout(Some(SSH_CONNECT_TIMEOUT))?;
    stream.set_write_timeout(Some(SSH_CONNECT_TIMEOUT))?;

    let target = format_tcp_endpoint(target_host, target_port);
    let mut request =
        format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Connection: Keep-Alive\r\n");
    if let Some(username) = non_empty_trimmed(proxy.username.as_deref()) {
        let password = proxy.password.as_deref().unwrap_or("");
        let credentials = STANDARD.encode(format!("{username}:{password}"));
        request.push_str(&format!("Proxy-Authorization: Basic {credentials}\r\n"));
    }
    request.push_str("\r\n");
    stream.write_all(request.as_bytes())?;
    stream.flush()?;

    let response = read_http_proxy_response(&mut stream)?;
    let status_line = response.lines().next().unwrap_or("");
    let status_ok = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|status| status.parse::<u16>().ok())
        .is_some_and(|status| (200..300).contains(&status));
    if !status_ok {
        return Err(AppError::Ssh(format!(
            "HTTP proxy CONNECT failed: {}",
            status_line.trim()
        )));
    }

    stream.set_read_timeout(None)?;
    stream.set_write_timeout(None)?;
    Ok(stream)
}

fn socks5_write_address(stream: &mut TcpStream, host: &str, port: u16) -> Result<(), AppError> {
    let normalized_host = strip_ipv6_brackets(host);
    if let Ok(ip) = normalized_host.parse::<IpAddr>() {
        match ip {
            IpAddr::V4(value) => {
                stream.write_all(&[0x01])?;
                stream.write_all(&value.octets())?;
            }
            IpAddr::V6(value) => {
                stream.write_all(&[0x04])?;
                stream.write_all(&value.octets())?;
            }
        }
    } else {
        let bytes = normalized_host.as_bytes();
        if bytes.len() > u8::MAX as usize {
            return Err(AppError::Validation(
                "SOCKS5 target host is too long".into(),
            ));
        }
        stream.write_all(&[0x03, bytes.len() as u8])?;
        stream.write_all(bytes)?;
    }

    stream.write_all(&port.to_be_bytes())?;
    Ok(())
}

fn socks5_read_address(stream: &mut TcpStream, atyp: u8) -> Result<(), AppError> {
    match atyp {
        0x01 => {
            let mut addr = [0_u8; 4];
            stream.read_exact(&mut addr)?;
        }
        0x03 => {
            let mut len = [0_u8; 1];
            stream.read_exact(&mut len)?;
            let mut addr = vec![0_u8; len[0] as usize];
            stream.read_exact(&mut addr)?;
        }
        0x04 => {
            let mut addr = [0_u8; 16];
            stream.read_exact(&mut addr)?;
        }
        value => {
            return Err(AppError::Ssh(format!(
                "SOCKS5 proxy returned unsupported address type {value}"
            )))
        }
    }

    let mut port = [0_u8; 2];
    stream.read_exact(&mut port)?;
    Ok(())
}

fn connect_socks5_proxy(
    proxy: &SshProxyConfig,
    target_host: &str,
    target_port: u16,
) -> Result<TcpStream, AppError> {
    let mut stream = connect_tcp_direct(&proxy.host, proxy.port)?;
    stream.set_read_timeout(Some(SSH_CONNECT_TIMEOUT))?;
    stream.set_write_timeout(Some(SSH_CONNECT_TIMEOUT))?;

    let has_credentials = non_empty_trimmed(proxy.username.as_deref()).is_some();
    let methods: &[u8] = if has_credentials {
        &[0x00, 0x02]
    } else {
        &[0x00]
    };
    stream.write_all(&[0x05, methods.len() as u8])?;
    stream.write_all(methods)?;
    stream.flush()?;

    let mut selection = [0_u8; 2];
    stream.read_exact(&mut selection)?;
    if selection[0] != 0x05 {
        return Err(AppError::Ssh(
            "SOCKS5 proxy returned invalid version".into(),
        ));
    }

    if selection[1] == 0x02 {
        let username = proxy.username.as_deref().unwrap_or("");
        let password = proxy.password.as_deref().unwrap_or("");
        if username.len() > u8::MAX as usize || password.len() > u8::MAX as usize {
            return Err(AppError::Validation(
                "SOCKS5 username or password is too long".into(),
            ));
        }
        stream.write_all(&[0x01, username.len() as u8])?;
        stream.write_all(username.as_bytes())?;
        stream.write_all(&[password.len() as u8])?;
        stream.write_all(password.as_bytes())?;
        stream.flush()?;
        let mut auth_response = [0_u8; 2];
        stream.read_exact(&mut auth_response)?;
        if auth_response != [0x01, 0x00] {
            return Err(AppError::Ssh(
                "SOCKS5 proxy username/password authentication failed".into(),
            ));
        }
    } else if selection[1] != 0x00 {
        return Err(AppError::Ssh(format!(
            "SOCKS5 proxy did not accept supported authentication method: {}",
            selection[1]
        )));
    }

    stream.write_all(&[0x05, 0x01, 0x00])?;
    socks5_write_address(&mut stream, target_host, target_port)?;
    stream.flush()?;

    let mut header = [0_u8; 4];
    stream.read_exact(&mut header)?;
    if header[0] != 0x05 || header[1] != 0x00 {
        return Err(AppError::Ssh(format!(
            "SOCKS5 proxy CONNECT failed with reply code {}",
            header[1]
        )));
    }
    socks5_read_address(&mut stream, header[3])?;

    stream.set_read_timeout(None)?;
    stream.set_write_timeout(None)?;
    Ok(stream)
}

fn connect_first_hop(
    proxy: &SshProxyConfig,
    target_host: &str,
    target_port: u16,
) -> Result<TcpStream, AppError> {
    if !proxy.enabled {
        return connect_tcp_direct(target_host, target_port);
    }
    if proxy.host.trim().is_empty() {
        return Err(AppError::Validation("proxy host is required".into()));
    }

    match proxy.proxy_type.trim().to_ascii_lowercase().as_str() {
        "http" | "https" | "http-connect" => connect_http_proxy(proxy, target_host, target_port),
        "socks5" | "socks" => connect_socks5_proxy(proxy, target_host, target_port),
        value => Err(AppError::Validation(format!(
            "unsupported proxy type: {value}"
        ))),
    }
}

fn prepare_ssh_tcp_stream(tcp: &TcpStream) -> Result<(), AppError> {
    // 交互终端输入是大量小包，必须关闭 Nagle，避免连续字符/退格被 TCP 合并后成批回显。
    tcp.set_nodelay(true)?;
    // 底层 socket 必须先切到 OS 非阻塞：libssh2 的阻塞 API 会自行 wait_socket，
    // 交互 Shell 的非阻塞 API 才能稳定收到 EAGAIN/WouldBlock，而不是 transport read。
    tcp.set_nonblocking(true)?;
    Ok(())
}

struct JumpBridge {
    local_host: String,
    local_port: u16,
    stop_flag: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl Drop for JumpBridge {
    fn drop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        // 唤醒非阻塞 accept 循环，让会话结束时临时本地监听能及时退出。
        let _ = TcpStream::connect((self.local_host.as_str(), self.local_port));
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

struct SshTransport {
    stream: TcpStream,
    // 跳板桥接守卫必须跟随最终 SSH Session 生命周期，否则本地 loopback 转发会提前释放。
    _bridges: Vec<JumpBridge>,
}

impl Drop for SshTransport {
    fn drop(&mut self) {
        // 最终 SSH 会话释放时先关闭本地 socket，再释放跳板监听守卫，确保代理转发线程尽快收到 EOF。
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}

#[cfg(unix)]
impl std::os::fd::AsRawFd for SshTransport {
    fn as_raw_fd(&self) -> std::os::fd::RawFd {
        self.stream.as_raw_fd()
    }
}

#[cfg(windows)]
impl std::os::windows::io::AsRawSocket for SshTransport {
    fn as_raw_socket(&self) -> std::os::windows::io::RawSocket {
        self.stream.as_raw_socket()
    }
}

fn establish_ssh_session(
    transport: SshTransport,
    auth: &SshAuthConfig<'_>,
    auth_host_label: &str,
    compatibility_mode: bool,
) -> Result<Session, AppError> {
    // 不在 TCP socket 上设 SO_RCVTIMEO/SO_SNDTIMEO：
    // Windows 上 socket timeout 与非阻塞模式冲突，recv()/send() 超时后返回 WSAETIMEDOUT，
    // libssh2 不认识这个错误码，包装成 "transport read" 错误导致非阻塞会话卡死。
    // 改用 libssh2 自身的 session.set_timeout() 控制阻塞操作（握手/认证）超时。
    prepare_ssh_tcp_stream(&transport.stream)?;
    let mut session = Session::new().map_err(ssh_error)?;
    session.set_timeout(SSH_IO_TIMEOUT.as_millis() as u32);
    session.set_tcp_stream(transport);
    if compatibility_mode {
        configure_ssh_compatibility_preferences(&session)?;
    }
    session.handshake().map_err(ssh_error)?;
    authenticate_ssh_session(&session, auth)?;

    if !session.authenticated() {
        return Err(AppError::Validation(format!(
            "authentication failed for {}@{}",
            auth.username.trim(),
            auth_host_label
        )));
    }

    // 认证完成后再启用底层 keepalive，避免影响部分 SSH 服务端的密钥交换阶段兼容性。
    session.set_keepalive(false, 20);

    Ok(session)
}

#[derive(Default)]
struct TunnelPendingBytes {
    // 非阻塞写可能只能消费部分数据，剩余字节必须排队，避免网页响应或请求体被截断。
    bytes: VecDeque<u8>,
}

impl TunnelPendingBytes {
    fn len(&self) -> usize {
        self.bytes.len()
    }

    fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    fn push(&mut self, data: &[u8]) {
        self.bytes.extend(data.iter().copied());
    }

    fn front_chunk(&self, max_len: usize) -> &[u8] {
        let (front, back) = self.bytes.as_slices();
        let chunk = if front.is_empty() { back } else { front };
        &chunk[..chunk.len().min(max_len)]
    }

    fn consume(&mut self, amount: usize) {
        let amount = amount.min(self.bytes.len());
        if amount > 0 {
            let _ = self.bytes.drain(..amount);
        }
        // 队列排空后若底层容量因突发扩得过大则收回，避免每个 channel 长期占用大缓冲。
        if self.bytes.is_empty() && self.bytes.capacity() > TUNNEL_PENDING_SHRINK_THRESHOLD {
            self.bytes.shrink_to(TUNNEL_PENDING_SHRINK_THRESHOLD);
        }
    }
}

fn is_transient_socket_error(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::WouldBlock | ErrorKind::Interrupted | ErrorKind::TimedOut
    )
}

fn open_direct_tcpip_channel(
    session: &Session,
    remote_host: &str,
    remote_port: u16,
    stop_flag: &AtomicBool,
) -> Result<Option<Channel>, AppError> {
    let started_at = Instant::now();
    loop {
        if stop_flag.load(Ordering::Relaxed) {
            return Ok(None);
        }

        match session.channel_direct_tcpip(remote_host, remote_port, None) {
            Ok(channel) => return Ok(Some(channel)),
            Err(error) if is_transient_ssh_error(&error) => {
                if started_at.elapsed() > SSH_IO_TIMEOUT {
                    return Err(AppError::Ssh(format!(
                        "tunnel channel open timed out for {remote_host}:{remote_port}"
                    )));
                }
                thread::sleep(TUNNEL_TRANSFER_IDLE_WAIT);
            }
            Err(error) => return Err(ssh_error(error)),
        }
    }
}

fn close_tunnel_channel(mut channel: Channel) {
    // 非阻塞 close 可能短暂 EAGAIN；短重试能让服务端尽快回收 channel，又不拖住隧道线程。
    for _ in 0..8 {
        match channel.close() {
            Ok(()) => break,
            Err(error) if is_transient_ssh_error(&error) => {
                thread::sleep(TUNNEL_TRANSFER_IDLE_WAIT);
            }
            Err(_) => break,
        }
    }
}

fn proxy_tcp_stream(
    mut local_stream: TcpStream,
    mut channel: Channel,
    stop_flag: Arc<AtomicBool>,
) -> bool {
    let _ = local_stream.set_nodelay(true);
    let _ = local_stream.set_nonblocking(true);

    let mut to_remote = TunnelPendingBytes::default();
    let mut to_local = TunnelPendingBytes::default();
    let mut local_buffer = vec![0_u8; TUNNEL_TRANSFER_BUFFER_BYTES];
    let mut remote_buffer = vec![0_u8; TUNNEL_TRANSFER_BUFFER_BYTES];
    let mut local_read_closed = false;
    let mut remote_read_closed = false;
    let mut remote_eof_sent = false;
    let mut local_write_shutdown = false;
    let mut session_reusable = true;

    while !stop_flag.load(Ordering::Relaxed) {
        let mut made_progress = false;
        let mut wrote_remote = false;

        while !to_remote.is_empty() {
            let chunk = to_remote.front_chunk(TUNNEL_TRANSFER_BUFFER_BYTES);
            let chunk_len = chunk.len();
            match channel.write(chunk) {
                Ok(0) => break,
                Ok(size) => {
                    to_remote.consume(size.min(chunk_len));
                    made_progress = true;
                    wrote_remote = true;
                }
                Err(error) if is_transient_channel_write_error(&error) => break,
                Err(_) => {
                    session_reusable = false;
                    break;
                }
            }
        }

        if !session_reusable {
            break;
        }

        if wrote_remote {
            match channel.flush() {
                Ok(()) => {}
                Err(error) if is_transient_channel_write_error(&error) => {}
                Err(_) => {
                    session_reusable = false;
                    break;
                }
            }
        }

        if local_read_closed && to_remote.is_empty() && !remote_eof_sent {
            match channel.send_eof() {
                Ok(()) => {
                    remote_eof_sent = true;
                    made_progress = true;
                }
                Err(error) if is_transient_ssh_error(&error) => {}
                Err(_) => {
                    session_reusable = false;
                    break;
                }
            }
        }

        while !to_local.is_empty() {
            let chunk = to_local.front_chunk(TUNNEL_TRANSFER_BUFFER_BYTES);
            let chunk_len = chunk.len();
            match local_stream.write(chunk) {
                Ok(0) => break,
                Ok(size) => {
                    to_local.consume(size.min(chunk_len));
                    made_progress = true;
                }
                Err(error) if is_transient_socket_error(&error) => break,
                Err(_) => {
                    // 本地浏览器提前关闭连接属于正常网页行为，不应丢弃可复用 SSH session。
                    local_read_closed = true;
                    to_local.consume(to_local.len());
                    break;
                }
            }
        }

        if remote_read_closed && to_local.is_empty() && !local_write_shutdown {
            let _ = local_stream.shutdown(Shutdown::Write);
            local_write_shutdown = true;
            made_progress = true;
        }

        while !local_read_closed && to_remote.len() < TUNNEL_MAX_PENDING_BYTES {
            let remaining_capacity = TUNNEL_MAX_PENDING_BYTES - to_remote.len();
            let read_len = local_buffer.len().min(remaining_capacity);
            match local_stream.read(&mut local_buffer[..read_len]) {
                Ok(0) => {
                    local_read_closed = true;
                    made_progress = true;
                    break;
                }
                Ok(size) => {
                    to_remote.push(&local_buffer[..size]);
                    made_progress = true;
                    if size < read_len {
                        break;
                    }
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) if is_transient_socket_error(&error) => break,
                Err(_) => {
                    // 本地端异常断开时尽快给远端 EOF，让 HTTP keep-alive 连接能释放。
                    local_read_closed = true;
                    made_progress = true;
                    break;
                }
            }
        }

        while !remote_read_closed && to_local.len() < TUNNEL_MAX_PENDING_BYTES {
            let remaining_capacity = TUNNEL_MAX_PENDING_BYTES - to_local.len();
            let read_len = remote_buffer.len().min(remaining_capacity);
            match channel.read(&mut remote_buffer[..read_len]) {
                Ok(0) => {
                    if channel.eof() {
                        remote_read_closed = true;
                        made_progress = true;
                    }
                    break;
                }
                Ok(size) => {
                    to_local.push(&remote_buffer[..size]);
                    made_progress = true;
                    if size < read_len {
                        break;
                    }
                }
                Err(error) if is_transient_channel_write_error(&error) => break,
                Err(_) => {
                    session_reusable = false;
                    break;
                }
            }
        }

        if !session_reusable {
            break;
        }

        if local_read_closed && remote_read_closed && to_remote.is_empty() && to_local.is_empty() {
            break;
        }

        if !made_progress {
            thread::sleep(TUNNEL_TRANSFER_IDLE_WAIT);
        }
    }

    if stop_flag.load(Ordering::Relaxed) {
        session_reusable = false;
    }
    close_tunnel_channel(channel);
    session_reusable
}

fn spawn_jump_bridge(
    session: Session,
    target_host: String,
    target_port: u16,
) -> Result<JumpBridge, AppError> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    listener.set_nonblocking(true)?;
    let local_port = listener.local_addr()?.port();
    let local_host = "127.0.0.1".to_string();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let thread_stop_flag = Arc::clone(&stop_flag);

    let handle = thread::spawn(move || {
        // 跳板桥只服务后续 SSH TCP 流；切到非阻塞后，双向转发不会因单侧 read 卡住同一 session 的写入。
        session.set_blocking(false);
        session.set_timeout(0);
        while !thread_stop_flag.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((local_stream, _)) => {
                    if thread_stop_flag.load(Ordering::SeqCst) {
                        let _ = local_stream.shutdown(Shutdown::Both);
                        break;
                    }
                    let channel = match open_direct_tcpip_channel(
                        &session,
                        &target_host,
                        target_port,
                        &thread_stop_flag,
                    ) {
                        Ok(Some(channel)) => channel,
                        Ok(None) => {
                            let _ = local_stream.shutdown(Shutdown::Both);
                            break;
                        }
                        Err(_) => {
                            let _ = local_stream.shutdown(Shutdown::Both);
                            continue;
                        }
                    };
                    let bridge_stop = Arc::clone(&thread_stop_flag);
                    thread::spawn(move || {
                        if !proxy_tcp_stream(local_stream, channel, bridge_stop) {
                            // 单条桥接流失败只影响当前连接；外层 listener 继续接收后续重连。
                        }
                    });
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(20));
                }
                Err(_) => break,
            }
        }
    });

    Ok(JumpBridge {
        local_host,
        local_port,
        stop_flag,
        handle: Some(handle),
    })
}

fn jump_host_label(jump_host: &SshJumpHost) -> String {
    jump_host
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&jump_host.host)
        .to_string()
}

fn connect_ssh_once(
    connection: &ConnectionProfile,
    compatibility_mode: bool,
) -> Result<Session, AppError> {
    if connection.jump_hosts.is_empty() {
        let tcp = connect_first_hop(&connection.proxy, &connection.host, connection.port)?;
        return establish_ssh_session(
            SshTransport {
                stream: tcp,
                _bridges: Vec::new(),
            },
            &SshAuthConfig::from_connection(connection),
            &connection.host,
            compatibility_mode,
        );
    }

    let first_jump = &connection.jump_hosts[0];
    let first_tcp = connect_first_hop(&connection.proxy, &first_jump.host, first_jump.port)?;
    let first_label = jump_host_label(first_jump);
    let mut current_session = establish_ssh_session(
        SshTransport {
            stream: first_tcp,
            _bridges: Vec::new(),
        },
        &SshAuthConfig::from_jump_host(first_jump),
        &first_label,
        compatibility_mode,
    )?;

    let mut bridges = Vec::new();
    for jump_host in connection.jump_hosts.iter().skip(1) {
        let bridge = spawn_jump_bridge(current_session, jump_host.host.clone(), jump_host.port)?;
        let local_host = bridge.local_host.clone();
        let local_port = bridge.local_port;
        bridges.push(bridge);
        let tcp = connect_tcp_direct(&local_host, local_port)?;
        let jump_label = jump_host_label(jump_host);
        current_session = establish_ssh_session(
            SshTransport {
                stream: tcp,
                _bridges: Vec::new(),
            },
            &SshAuthConfig::from_jump_host(jump_host),
            &jump_label,
            compatibility_mode,
        )?;
    }

    let target_bridge =
        spawn_jump_bridge(current_session, connection.host.clone(), connection.port)?;
    let target_host = target_bridge.local_host.clone();
    let target_port = target_bridge.local_port;
    bridges.push(target_bridge);
    let tcp = connect_tcp_direct(&target_host, target_port)?;

    establish_ssh_session(
        SshTransport {
            stream: tcp,
            _bridges: bridges,
        },
        &SshAuthConfig::from_connection(connection),
        &connection.host,
        compatibility_mode,
    )
}

pub(crate) fn connect_ssh(connection: &ConnectionProfile) -> Result<Session, AppError> {
    validate_connection_profile(connection)?;
    match connect_ssh_once(connection, false) {
        Ok(session) => Ok(session),
        Err(error) if is_key_exchange_error(&error) => connect_ssh_once(connection, true),
        Err(error) => Err(error),
    }
}

struct TunnelSessionLease {
    // lease 归还时需要回到原池更新 active channel 计数。
    pool: Arc<TunnelSshPool>,
    // 池内 session ID，避免 Vec 扩缩容后使用下标归还错误。
    session_id: u64,
    // ssh2::Session 是同一底层连接的句柄克隆；channel 结束后由 Drop 自动归还计数。
    session: Session,
    // transport 级错误会污染整个 SSH session，此时归还时应从池里剔除。
    reusable: bool,
}

impl TunnelSessionLease {
    fn session(&self) -> &Session {
        &self.session
    }

    fn discard(&mut self) {
        self.reusable = false;
    }
}

impl Drop for TunnelSessionLease {
    fn drop(&mut self) {
        self.pool.release_session(self.session_id, self.reusable);
    }
}

impl TunnelSshPool {
    fn new(connection: ConnectionProfile) -> Self {
        Self {
            connection,
            inner: Mutex::new(TunnelSshPoolState {
                sessions: Vec::new(),
                connecting_sessions: 0,
                next_session_id: 1,
                closed: false,
            }),
            available: std::sync::Condvar::new(),
        }
    }

    fn checkout(
        self: &Arc<Self>,
        stop_flag: &AtomicBool,
    ) -> Result<Option<TunnelSessionLease>, AppError> {
        loop {
            if stop_flag.load(Ordering::Relaxed) {
                return Ok(None);
            }

            let mut state = self
                .inner
                .lock()
                .map_err(|_| AppError::Validation("tunnel ssh pool is unavailable".into()))?;
            if state.closed {
                return Ok(None);
            }

            if let Some(slot) = state
                .sessions
                .iter_mut()
                .find(|slot| !slot.failed && slot.active_channels < TUNNEL_CHANNELS_PER_SSH_SESSION)
            {
                slot.active_channels += 1;
                return Ok(Some(TunnelSessionLease {
                    pool: Arc::clone(self),
                    session_id: slot.id,
                    session: slot.session.clone(),
                    reusable: true,
                }));
            }

            let total_sessions = state.sessions.len() + state.connecting_sessions;
            let should_connect = state.connecting_sessions == 0
                && total_sessions < TUNNEL_MAX_SSH_SESSIONS_PER_CONNECTION;
            if should_connect {
                state.connecting_sessions += 1;
                drop(state);

                let connect_result = self.connect_session();
                let mut state = self
                    .inner
                    .lock()
                    .map_err(|_| AppError::Validation("tunnel ssh pool is unavailable".into()))?;
                state.connecting_sessions = state.connecting_sessions.saturating_sub(1);

                let session = match connect_result {
                    Ok(session) => session,
                    Err(error) => {
                        self.available.notify_all();
                        return Err(error);
                    }
                };

                if state.closed || stop_flag.load(Ordering::Relaxed) {
                    self.available.notify_all();
                    return Ok(None);
                }

                let session_id = state.next_session_id;
                state.next_session_id = state.next_session_id.saturating_add(1);
                state.sessions.push(TunnelSshPoolSession {
                    id: session_id,
                    session: session.clone(),
                    active_channels: 1,
                    failed: false,
                });
                self.available.notify_all();
                return Ok(Some(TunnelSessionLease {
                    pool: Arc::clone(self),
                    session_id,
                    session,
                    reusable: true,
                }));
            }

            let (next_state, _) = self
                .available
                .wait_timeout(state, TUNNEL_POOL_WAIT)
                .map_err(|_| AppError::Validation("tunnel ssh pool wait failed".into()))?;
            drop(next_state);
        }
    }

    fn connect_session(&self) -> Result<Session, AppError> {
        let session = connect_ssh(&self.connection)?;
        // 隧道 channel 使用自己的非阻塞轮询泵，不能让 libssh2 阻塞读占住同一 session 的全局锁。
        session.set_blocking(false);
        session.set_timeout(0);
        Ok(session)
    }

    fn release_session(&self, session_id: u64, reusable: bool) {
        let Ok(mut state) = self.inner.lock() else {
            return;
        };

        if let Some(slot) = state.sessions.iter_mut().find(|slot| slot.id == session_id) {
            slot.active_channels = slot.active_channels.saturating_sub(1);
            if !reusable {
                slot.failed = true;
            }
        }

        state
            .sessions
            .retain(|slot| !(slot.failed && slot.active_channels == 0));

        if !state.closed {
            let mut idle_kept = 0_usize;
            state.sessions.retain(|slot| {
                if slot.active_channels > 0 {
                    true
                } else {
                    idle_kept += 1;
                    idle_kept <= TUNNEL_MAX_IDLE_SSH_SESSIONS_PER_CONNECTION
                }
            });
        }

        self.available.notify_all();
    }

    fn close(&self) {
        if let Ok(mut state) = self.inner.lock() {
            state.closed = true;
            state.sessions.clear();
            self.available.notify_all();
        }
    }
}

fn get_or_create_tunnel_ssh_pool(
    state: &AppState,
    connection: &ConnectionProfile,
) -> Result<Arc<TunnelSshPool>, AppError> {
    let mut pools = lock_tunnel_ssh_pools(state)?;
    if let Some(pool) = pools.get(&connection.id) {
        return Ok(Arc::clone(pool));
    }

    // 池按连接配置快照创建；连接编辑会关闭旧池，新隧道自然使用新配置。
    let pool = Arc::new(TunnelSshPool::new(connection.clone()));
    pools.insert(connection.id.clone(), Arc::clone(&pool));
    Ok(pool)
}

fn drop_tunnel_ssh_pool(state: &AppState, connection_id: &str) {
    if let Ok(mut pools) = lock_tunnel_ssh_pools(state) {
        if let Some(pool) = pools.remove(connection_id) {
            pool.close();
        }
    }
}

fn clear_tunnel_ssh_pools(state: &AppState) {
    if let Ok(mut pools) = lock_tunnel_ssh_pools(state) {
        for pool in pools.drain().map(|(_, pool)| pool) {
            pool.close();
        }
    }
}

fn cleanup_unused_tunnel_ssh_pool(state: &AppState, connection_id: &str) -> Result<(), AppError> {
    let has_running_tunnel = lock_tunnels(state)?
        .values()
        .any(|runtime| runtime.connection_id == connection_id);
    if !has_running_tunnel {
        drop_tunnel_ssh_pool(state, connection_id);
    }
    Ok(())
}

fn stop_connection_tunnel_runtimes(state: &AppState, connection_id: &str) -> Result<(), AppError> {
    let mut tunnel_runtime = lock_tunnels(state)?;
    let tunnel_ids = tunnel_runtime
        .iter()
        .filter_map(|(tunnel_id, runtime)| {
            (runtime.connection_id == connection_id).then(|| tunnel_id.clone())
        })
        .collect::<Vec<_>>();

    for tunnel_id in tunnel_ids {
        if let Some(runtime) = tunnel_runtime.remove(&tunnel_id) {
            runtime.stop_flag.store(true, Ordering::Relaxed);
        }
    }
    drop(tunnel_runtime);

    drop_tunnel_ssh_pool(state, connection_id);
    Ok(())
}

fn mark_connection_tunnels_stopped(state: &AppState, connection_id: &str) -> Result<(), AppError> {
    let mut tunnels = state.storage.load_tunnels()?;
    let mut changed = false;
    for tunnel in &mut tunnels {
        if tunnel.connection_id == connection_id && tunnel.status == "running" {
            tunnel.status = "stopped".into();
            changed = true;
        }
    }

    if changed {
        state.storage.save_tunnels(&tunnels)?;
    }
    Ok(())
}

fn get_or_connect_auxiliary_session(
    state: &AppState,
    connection: &ConnectionProfile,
) -> Result<Arc<std::sync::Mutex<AuxiliarySshSession>>, AppError> {
    if let Some(cached) = lock_auxiliary_sessions(state)?.get(&connection.id).cloned() {
        return Ok(cached);
    }

    let connect_lock = auxiliary_session_lock(state, &connection.id)?;
    let _connect_guard = connect_lock
        .lock()
        .map_err(|_| AppError::Validation("auxiliary ssh connect lock is unavailable".into()))?;
    if let Some(cached) = lock_auxiliary_sessions(state)?.get(&connection.id).cloned() {
        return Ok(cached);
    }

    // 辅助会话独立于交互 PTY；连接建立可能较慢，仅锁住当前连接，避免同一连接并发重复握手。
    let session = connect_ssh(connection)?;
    // 收紧辅助会话阻塞超时：后台挂起导致连接静默失效时，读操作最多等 AUXILIARY_IO_TIMEOUT 即报错，
    // 触发 with_auxiliary_session 的丢弃重连，切 tab 不再干等握手期的 20 秒。
    session.set_timeout(AUXILIARY_IO_TIMEOUT.as_millis() as u32);
    let cached = Arc::new(std::sync::Mutex::new(AuxiliarySshSession {
        session,
        sftp: None,
        user_names: None,
        group_names: None,
        last_used_at: std::time::Instant::now(),
    }));

    let mut sessions = lock_auxiliary_sessions(state)?;
    let entry = sessions
        .entry(connection.id.clone())
        .or_insert_with(|| Arc::clone(&cached));
    Ok(Arc::clone(entry))
}

fn drop_auxiliary_session(state: &AppState, connection_id: &str) {
    if let Ok(mut sessions) = lock_auxiliary_sessions(state) {
        sessions.remove(connection_id);
    }
}

fn clear_auxiliary_sessions(state: &AppState) {
    if let Ok(mut sessions) = lock_auxiliary_sessions(state) {
        sessions.clear();
    }
}

/// 保活守护线程每轮顺带执行的辅助连接淘汰：回收空闲超过 TTL 的连接，并在空闲连接过多时
/// 保留最近使用的若干个、淘汰其余最久未用者。只回收当前无人持有（Arc strong_count==1）
/// 且能立即 try_lock 的连接，避免误删正在进行文件/资源操作的活跃会话。
fn evict_idle_auxiliary_sessions(state: &AppState) {
    let mut removed_ids: Vec<String> = Vec::new();
    if let Ok(mut sessions) = state.auxiliary_sessions.lock() {
        let now = Instant::now();
        // 候选：无外部持有者且未被占用的空闲连接，连同其空闲时长，供 TTL 与数量上限判定。
        let mut idle: Vec<(String, Duration)> = Vec::new();
        for (id, session) in sessions.iter() {
            // strong_count>1 说明有操作线程已克隆出 Arc 正在或即将使用，跳过不回收。
            if Arc::strong_count(session) > 1 {
                continue;
            }
            // try_lock 失败说明正被持有；能锁住才读取 last_used_at 判定空闲时长。
            if let Ok(guard) = session.try_lock() {
                idle.push((id.clone(), now.saturating_duration_since(guard.last_used_at)));
            }
        }

        // 先按 TTL 回收长时间空闲的连接。
        for (id, idle_for) in &idle {
            if *idle_for >= AUXILIARY_IDLE_TTL {
                removed_ids.push(id.clone());
            }
        }

        // 再按数量上限回收：TTL 未到但空闲连接数仍超过上限时，淘汰最久未用的直到回落到上限。
        let mut survivors: Vec<&(String, Duration)> = idle
            .iter()
            .filter(|(id, _)| !removed_ids.contains(id))
            .collect();
        if survivors.len() > AUXILIARY_MAX_IDLE_SESSIONS {
            // 空闲时长降序：最久未用的排在前面优先淘汰。
            survivors.sort_by(|a, b| b.1.cmp(&a.1));
            for (id, _) in survivors.iter().take(survivors.len() - AUXILIARY_MAX_IDLE_SESSIONS) {
                removed_ids.push(id.clone());
            }
        }

        for id in &removed_ids {
            sessions.remove(id);
        }
    }

    // 同步清理已无对应会话、且无人持有的连接锁，避免连接 ID 长期在锁表里积累。
    if !removed_ids.is_empty() {
        if let Ok(mut locks) = state.auxiliary_session_locks.lock() {
            if let Ok(sessions) = state.auxiliary_sessions.lock() {
                locks.retain(|id, lock| {
                    // 会话仍在或仍有等待者（strong_count>1）时保留该锁。
                    sessions.contains_key(id) || Arc::strong_count(lock) > 1
                });
            }
        }
    }
}

fn with_auxiliary_session<T>(
    state: &AppState,
    connection: &ConnectionProfile,
    operation: impl Fn(&mut AuxiliarySshSession) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let cached = get_or_connect_auxiliary_session(state, connection)?;
    {
        let mut session = cached
            .lock()
            .map_err(|_| AppError::Validation("auxiliary ssh session is unavailable".into()))?;
        // 记录访问时刻，供保活守护线程按空闲 TTL 判定回收；活跃连接不会被误淘汰。
        session.last_used_at = std::time::Instant::now();
        match operation(&mut session) {
            Ok(value) => return Ok(value),
            Err(error @ (AppError::Ssh(_) | AppError::Io(_))) => {
                // 复用连接可能被远端空闲回收；读类操作先丢弃旧缓存，下面用新会话自动重试一次。
                drop(session);
                drop_auxiliary_session(state, &connection.id);
                let refreshed = get_or_connect_auxiliary_session(state, connection)?;
                let mut refreshed_session = refreshed.lock().map_err(|_| {
                    AppError::Validation("auxiliary ssh session is unavailable".into())
                })?;
                return operation(&mut refreshed_session).map_err(|retry_error| {
                    if matches!(retry_error, AppError::Ssh(_) | AppError::Io(_)) {
                        retry_error
                    } else {
                        error
                    }
                });
            }
            Err(error) => return Err(error),
        }
    }
}

fn with_auxiliary_session_once<T>(
    state: &AppState,
    connection: &ConnectionProfile,
    operation: impl FnOnce(&mut AuxiliarySshSession) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let cached = get_or_connect_auxiliary_session(state, connection)?;
    let mut session = cached
        .lock()
        .map_err(|_| AppError::Validation("auxiliary ssh session is unavailable".into()))?;
    // 记录访问时刻，供保活守护线程按空闲 TTL 判定回收。
    session.last_used_at = std::time::Instant::now();
    let result = operation(&mut session);
    if result
        .as_ref()
        .err()
        .is_some_and(|error| matches!(error, AppError::Ssh(_) | AppError::Io(_)))
    {
        drop(session);
        drop_auxiliary_session(state, &connection.id);
    }
    result
}

fn auxiliary_sftp(session: &mut AuxiliarySshSession) -> Result<&Sftp, AppError> {
    if session.sftp.is_none() {
        // SFTP 子系统初始化成功后挂在辅助 SSH 会话上，目录切换不再重复打开子系统。
        session.sftp = Some(session.session.sftp().map_err(ssh_error)?);
    }

    session
        .sftp
        .as_ref()
        .ok_or_else(|| AppError::Validation("sftp session is unavailable".into()))
}

fn auxiliary_identity_maps(
    session: &mut AuxiliarySshSession,
) -> (HashMap<u32, String>, HashMap<u32, String>) {
    if session.user_names.is_none() || session.group_names.is_none() {
        // 账号表远端变化频率很低，缓存后可避免目录切换时重复 exec 读取 passwd/group。
        let (user_names, group_names) = load_remote_identity_maps(&session.session);
        session.user_names = Some(user_names);
        session.group_names = Some(group_names);
    }

    (
        session.user_names.clone().unwrap_or_default(),
        session.group_names.clone().unwrap_or_default(),
    )
}

/// 调整远端 PTY 尺寸；libssh2 非阻塞忙碌时返回 false，让 shell 主循环保留目标尺寸下轮重试。
fn request_shell_pty_size(channel: &mut Channel, cols: u16, rows: u16) -> Result<bool, AppError> {
    if let Err(error) = channel.request_pty_size(cols.into(), rows.into(), Some(0), Some(0)) {
        let message = error.to_string().to_ascii_lowercase();
        // 非阻塞 PTY 调整尺寸偶尔会撞上 libssh2 的短暂 busy 状态；尺寸是状态值，不能丢，调用方要重试。
        if message.contains("session(-37)")
            || message.contains("would block")
            || message.contains("eagain")
            || message.contains("temporarily unavailable")
            || message.contains("try again")
        {
            return Ok(false);
        }
        return Err(ssh_error(error));
    }
    Ok(true)
}

/// 非阻塞刷新：写入尽可能多的 pending_input，未写完的部分保留在原地等下轮主循环重试。
fn flush_pending_shell_input(
    channel: &mut Channel,
    pending_input: &mut Vec<u8>,
) -> Result<usize, AppError> {
    if pending_input.is_empty() {
        return Ok(0);
    }

    // 单轮只推进一小段输入，避免用户高速输入时 write 路径长期占用 libssh2 transport。
    let write_len = pending_input.len().min(SSH_SHELL_MAX_WRITE_CHUNK_BYTES);
    let written = write_channel_input(channel, &pending_input[..write_len])?;
    if written >= pending_input.len() {
        pending_input.clear();
    } else if written > 0 {
        // 保留未写完的字节，下轮事件循环继续尝试；按字节缓冲避免 UTF-8 分片写入后切 String 崩溃。
        pending_input.drain(..written);
    }

    Ok(written)
}

#[cfg(windows)]
fn ssh_socket_error_code(session: &Session) -> Option<libc::c_int> {
    use std::os::windows::io::AsRawSocket;

    // Windows 版 libc 未公开 WinSock 的 SOL_SOCKET/SO_ERROR 常量；这里使用 WinSock 固定值读取底层 socket 状态。
    const WINDOWS_SOL_SOCKET: libc::c_int = 0xffff;
    const WINDOWS_SO_ERROR: libc::c_int = 0x1007;

    let mut error_code = 0 as libc::c_int;
    let mut option_len = std::mem::size_of::<libc::c_int>() as libc::c_int;
    let result = unsafe {
        libc::getsockopt(
            session.as_raw_socket() as libc::SOCKET,
            WINDOWS_SOL_SOCKET,
            WINDOWS_SO_ERROR,
            &mut error_code as *mut _ as *mut libc::c_char,
            &mut option_len,
        )
    };

    if result == 0 {
        Some(error_code)
    } else {
        None
    }
}

#[cfg(unix)]
fn ssh_socket_error_code(session: &Session) -> Option<libc::c_int> {
    use std::os::fd::AsRawFd;

    let mut error_code = 0 as libc::c_int;
    let mut option_len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            session.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_ERROR,
            &mut error_code as *mut _ as *mut libc::c_void,
            &mut option_len,
        )
    };

    if result == 0 {
        Some(error_code)
    } else {
        None
    }
}

#[cfg(not(any(unix, windows)))]
fn ssh_socket_error_code(_session: &Session) -> Option<libc::c_int> {
    None
}

fn ssh_socket_error_hint(_session: &Session) -> String {
    match ssh_socket_error_code(_session) {
        Some(error_code) => format!("so_error={error_code}"),
        None => format!("so_error_unavailable={}", std::io::Error::last_os_error()),
    }
}

fn spawn_shell_thread(
    session_id: String,
    ssh_session: Session,
    cols: u16,
    rows: u16,
    output_queue: Arc<std::sync::Mutex<TerminalOutputQueue>>,
    control_rx: mpsc::Receiver<SessionControl>,
    app_handle: tauri::AppHandle,
    // 保活间隔（秒，0=关闭）由设置驱动；交互终端每轮读取，实现设置热更新。
    keepalive_interval_sec: Arc<AtomicU64>,
) {
    thread::spawn(move || {
        let mut channel = match ssh_session.channel_session() {
            Ok(channel) => channel,
            Err(e) => {
                eprintln!("[SSH-DIAG] channel_session failed: {e:?}");
                queue_session_status(&output_queue, &app_handle, &session_id, "error");
                return;
            }
        };

        let _ = channel.handle_extended_data(ExtendedData::Merge);
        if channel
            .request_pty("xterm", None, Some((cols.into(), rows.into(), 0, 0)))
            .is_err()
        {
            queue_session_status(&output_queue, &app_handle, &session_id, "error");
            return;
        }

        if channel.shell().is_err() {
            queue_session_status(&output_queue, &app_handle, &session_id, "error");
            return;
        }

        // Shell 启动后立即写入目录同步钩子，后续 cd/pushd/popd 后由提示符周期回传真实 PWD。
        let _ = channel.write_all(shell_cwd_sync_command().as_bytes());
        let _ = channel.flush();

        ssh_session.set_blocking(false);
        // libssh2 session 超时设为 0 表示不超时，由我们自己的主循环控制。
        ssh_session.set_timeout(0);

        queue_session_status(&output_queue, &app_handle, &session_id, "connected");

        let mut buffer = [0_u8; 8192];
        // 终端输出可能把 OSC 同步标记拆成多段，过滤器负责跨分片拼接与隐藏。
        let mut output_filter = ShellOutputFilter::default();
        // transport read 可能是短暂底层读抖动；连续超过阈值才认为会话异常，避免终端误断开。
        let mut transient_read_errors = 0_usize;
        let mut transient_error_started_at: Option<Instant> = None;
        // pending_input 保存尚未写入远端 PTY 的原始字节；不能用 String 按字节裁剪，避免 UTF-8 分片时越界。
        let mut pending_input = Vec::<u8>::new();
        // pending_resize 保存远端 PTY 目标尺寸；request_pty_size 瞬时 busy 时必须重试，避免长行编辑按旧列宽重绘。
        let mut pending_resize: Option<(u16, u16)> = None;
        let mut last_keepalive_at = Instant::now();
        loop {
            // 本轮是否处理过前端控制事件；用于决定末尾是立即继续，还是进入可被输入唤醒的空闲等待。
            let mut handled_control_event = false;
            for _ in 0..SSH_SHELL_MAX_CONTROL_EVENTS_PER_TICK {
                match control_rx.try_recv() {
                    Ok(SessionControl::Input(data)) => {
                        handled_control_event = true;
                        pending_input.extend_from_slice(data.as_bytes());
                    }
                    Ok(SessionControl::Close) => {
                        let _ = channel.close();
                        return;
                    }
                    Ok(SessionControl::Resize { cols, rows }) => {
                        handled_control_event = true;
                        pending_resize = Some((cols, rows));
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return,
                }
            }

            // 先排空一批远端输出，再写入新输入；持续高速输入时也不能饿死 SSH read/window adjust。
            let mut read_transport_error = false;
            // 本轮读到过远端输出时不要进入睡眠，马上继续读下一批，降低 echo 到 xterm 的等待时间。
            let mut read_made_progress = false;
            for _ in 0..SSH_SHELL_MAX_READS_PER_TICK {
                match channel.read(&mut buffer) {
                    Ok(0) => {
                        if channel.eof() {
                            queue_session_status(&output_queue, &app_handle, &session_id, "closed");
                            let _ = channel.close();
                            return;
                        }
                        break;
                    }
                    Ok(size) => {
                        read_made_progress = true;
                        transient_read_errors = 0;
                        transient_error_started_at = None;
                        let content = String::from_utf8_lossy(&buffer[..size]).into_owned();
                        let (visible_content, cwd_updates) = output_filter.consume(&content);
                        if !visible_content.is_empty() {
                            queue_output(&output_queue, &app_handle, &session_id, visible_content);
                        }
                        for cwd in cwd_updates {
                            queue_cwd(&output_queue, &app_handle, &session_id, cwd);
                        }
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                        ) =>
                    {
                        transient_read_errors = 0;
                        transient_error_started_at = None;
                        break;
                    }
                    Err(error) if is_transient_transport_read_error(&error) && !channel.eof() => {
                        transient_read_errors += 1;
                        let socket_error_code = ssh_socket_error_code(&ssh_session);
                        // so_error=0 时通常只是 libssh2 非阻塞读暂无数据，按 WouldBlock 处理，避免增加输入延迟。
                        if socket_error_code == Some(0) {
                            transient_read_errors = 0;
                            transient_error_started_at = None;
                            break;
                        }

                        read_transport_error = true;
                        let started_at =
                            transient_error_started_at.get_or_insert_with(Instant::now);
                        let socket_hint = socket_error_code
                            .map(|code| format!("so_error={code}"))
                            .unwrap_or_else(|| ssh_socket_error_hint(&ssh_session));
                        // 非 0 socket 错误代表底层连接已异常，直接结束；无法读取 socket 状态时仍给短暂重试窗口。
                        if socket_error_code.is_some()
                            || started_at.elapsed() > Duration::from_secs(5)
                        {
                            eprintln!("[SSH-DIAG] transport read failed: count={transient_read_errors}, elapsed={:?}, last_error={error:?}, {socket_hint}", started_at.elapsed());
                            queue_session_status(&output_queue, &app_handle, &session_id, "error");
                            let _ = channel.close();
                            return;
                        }
                        if transient_read_errors <= 3 || transient_read_errors % 200 == 0 {
                            let dirs = ssh_session.block_directions();
                            eprintln!(
                                "[SSH-DIAG] transport read retry #{transient_read_errors}: error={error}, block_directions={dirs:?}, pending_input_len={}, {socket_hint}",
                                pending_input.len(),
                            );
                        }
                        break;
                    }
                    Err(catch_all_err) => {
                        if !channel.eof() {
                            read_transport_error = true;
                            transient_read_errors += 1;
                            let started_at =
                                transient_error_started_at.get_or_insert_with(Instant::now);
                            if started_at.elapsed() <= Duration::from_secs(30) {
                                if transient_read_errors <= 3 || transient_read_errors % 2000 == 0 {
                                    eprintln!(
                                        "[SSH-DIAG] catch-all read retry: count={transient_read_errors}, error={catch_all_err:?}, {}",
                                        ssh_socket_error_hint(&ssh_session),
                                    );
                                }
                                break;
                            }
                        }
                        eprintln!("[SSH-DIAG] catch-all read error, eof={}, count={transient_read_errors}, error={catch_all_err:?}, {}", channel.eof(), ssh_socket_error_hint(&ssh_session));
                        queue_session_status(&output_queue, &app_handle, &session_id, "error");
                        let _ = channel.close();
                        return;
                    }
                }
            }

            // 非阻塞刷新：读侧正常时才写入，写不完的留给下轮；读侧异常时暂停写入避免放大 transport 错误。
            let mut resized_pty = false;
            let mut written_input_bytes = 0_usize;
            if !read_transport_error {
                if let Some((cols, rows)) = pending_resize {
                    match request_shell_pty_size(&mut channel, cols, rows) {
                        Ok(true) => {
                            resized_pty = true;
                            pending_resize = None;
                        }
                        Ok(false) => {}
                        Err(error) => {
                            eprintln!("[SSH-DIAG] resize pty failed: {error:?}");
                            queue_session_status(&output_queue, &app_handle, &session_id, "error");
                            let _ = channel.close();
                            return;
                        }
                    }
                }

                match flush_pending_shell_input(&mut channel, &mut pending_input) {
                    Ok(written) => {
                        written_input_bytes = written;
                    }
                    Err(error) => {
                        eprintln!(
                            "[SSH-DIAG] flush pending input failed: {error:?}, {}",
                            ssh_socket_error_hint(&ssh_session),
                        );
                        queue_session_status(&output_queue, &app_handle, &session_id, "error");
                        let _ = channel.close();
                        return;
                    }
                }
            }

            // 交互会话长时间无输出时主动发送 SSH keepalive，不向终端写入可见内容。
            // 间隔完全由用户设置驱动（0=关闭）；发送后顺带检查底层 socket 错误码，及时发现静默断开（半开 TCP）。
            // 因此断连检测速度 = 保活间隔：调小则更快发现掉线，关闭（0）则不做主动探测（RST/正常关闭仍由读循环即时捕获）。
            let keepalive_secs = keepalive_interval_sec.load(Ordering::Relaxed);
            if keepalive_secs > 0 && last_keepalive_at.elapsed() >= Duration::from_secs(keepalive_secs)
            {
                // keepalive_send 在非阻塞模式下可能返回 WouldBlock 等瞬时错误，不能据此判定断连；
                // 它只负责驱动一次协议流量，真正的存活判定交给底层 socket 错误码（与 transport 错误处理一致）。
                let _ = ssh_session.keepalive_send();
                last_keepalive_at = Instant::now();
                if let Some(code) = ssh_socket_error_code(&ssh_session) {
                    if code != 0 {
                        eprintln!("[SSH-DIAG] keepalive detected dead socket: so_error={code}");
                        queue_session_status(&output_queue, &app_handle, &session_id, "error");
                        let _ = channel.close();
                        return;
                    }
                }
            }

            // 写入成功后立即回到 read 阶段等待远端 echo；读到输出或处理控制事件时也不额外睡眠。
            if written_input_bytes > 0 || resized_pty || read_made_progress || handled_control_event
            {
                thread::yield_now();
                continue;
            }

            if !pending_input.is_empty() || pending_resize.is_some() || transient_read_errors > 0 {
                thread::sleep(SSH_SHELL_RETRY_WAIT);
                continue;
            }

            // 空闲时等待控制通道，输入到达会立即唤醒 shell 线程；超时仅用于继续轮询远端输出。
            match control_rx.recv_timeout(SSH_SHELL_IDLE_WAIT) {
                Ok(SessionControl::Input(data)) => {
                    pending_input.extend_from_slice(data.as_bytes());
                }
                Ok(SessionControl::Resize { cols, rows }) => {
                    pending_resize = Some((cols, rows));
                }
                Ok(SessionControl::Close) => {
                    let _ = channel.close();
                    return;
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }
    });
}

fn resolve_local_shell_path(settings: &LocalTerminalSettings) -> String {
    let configured = settings.shell_path.trim();
    if !configured.is_empty() {
        return configured.to_string();
    }

    DEFAULT_LOCAL_SHELL_CANDIDATES
        .iter()
        .find(|candidate| {
            let path = Path::new(candidate);
            path.is_absolute() && path.exists() || !path.is_absolute()
        })
        .unwrap_or(&DEFAULT_LOCAL_SHELL_CANDIDATES[0])
        .to_string()
}

/// 从本地终端启动命令中提取首个可执行文件名，供宿主按目标 TUI 注入兼容环境变量。
/// 这里只解析直接执行形式：兼容 PowerShell 调用运算符、单双引号路径、Windows/Unix 路径和常见脚本后缀；
/// `npx claude` 等二次分发命令不猜测最终子进程，避免把 Claude 专用行为误施加给普通命令。
fn extract_local_command_executable_name(command: &str) -> Option<String> {
    let mut remaining = command.trim_start();
    if let Some(after_call_operator) = remaining.strip_prefix('&') {
        remaining = after_call_operator.trim_start();
    }
    if remaining.is_empty() {
        return None;
    }

    let executable = match remaining.chars().next()? {
        quote @ ('\'' | '"') => {
            let quoted = &remaining[quote.len_utf8()..];
            let closing_quote = quoted.find(quote)?;
            &quoted[..closing_quote]
        }
        _ => remaining.split_whitespace().next()?,
    };
    let file_name = executable
        .rsplit(['/', '\\'])
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let mut normalized = file_name.to_ascii_lowercase();
    for suffix in [".exe", ".cmd", ".bat", ".ps1"] {
        if let Some(without_suffix) = normalized.strip_suffix(suffix) {
            normalized = without_suffix.to_string();
            break;
        }
    }
    Some(normalized)
}

/// Claude 只有在直接作为本地启动命令时才启用同步帧兜底，避免污染普通 Shell、Codex 等其它会话。
fn should_force_claude_synchronized_output(command: &str) -> bool {
    matches!(
        extract_local_command_executable_name(command).as_deref(),
        Some("claude" | "claude-code")
    )
}

/// Qwen Code 使用独立的官方开关；只匹配直接启动命令，不能复用或全局扩散 Claude 的专用变量。
fn should_force_qwen_synchronized_output(command: &str) -> bool {
    matches!(
        extract_local_command_executable_name(command).as_deref(),
        Some("qwen" | "qwen-code")
    )
}

#[cfg(windows)]
fn build_local_terminal_command(shell_path: &str, command: &str) -> CommandBuilder {
    let shell_name = Path::new(shell_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(shell_path)
        .to_ascii_lowercase();
    let mut builder = CommandBuilder::new(shell_path);
    let trimmed_command = command.trim();
    if trimmed_command.is_empty() {
        return builder;
    }
    if shell_name.contains("powershell") || shell_name.contains("pwsh") {
        builder.args(["-NoLogo", "-NoExit", "-Command", command]);
    } else if shell_name == "cmd.exe" || shell_name == "cmd" {
        builder.args(["/K", command]);
    } else {
        builder.arg(command);
    }
    builder
}

#[cfg(not(windows))]
fn build_local_terminal_command(shell_path: &str, command: &str) -> CommandBuilder {
    let mut builder = CommandBuilder::new(shell_path);
    let trimmed_command = command.trim();
    if !trimmed_command.is_empty() {
        builder.args(["-lc", trimmed_command]);
    }
    builder
}

fn spawn_local_terminal_thread(
    session_id: String,
    settings: LocalTerminalSettings,
    profile: LocalTerminalProfile,
    cols: u16,
    rows: u16,
    output_queue: Arc<std::sync::Mutex<TerminalOutputQueue>>,
    control_rx: mpsc::Receiver<SessionControl>,
    app_handle: tauri::AppHandle,
) {
    thread::spawn(move || {
        let shell_path = resolve_local_shell_path(&settings);
        let pty_system = portable_pty::native_pty_system();
        let pair = match pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        }) {
            Ok(pair) => pair,
            Err(error) => {
                queue_session_status(&output_queue, &app_handle, &session_id, "error");
                queue_output(
                    &output_queue,
                    &app_handle,
                    &session_id,
                    format!("\r\n本地终端创建失败：{error}\r\n"),
                );
                return;
            }
        };

        let mut command = build_local_terminal_command(&shell_path, &profile.command);
        command.cwd(&profile.cwd);
        // AI CLI 通常会根据 TERM/COLORTERM 决定颜色和交互 UI，显式声明现代终端能力。
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        // 前端会响应标准 XTVERSION，但 Claude 2.1.129+ 的官方开关仍作为直接启动场景的兼容兜底，避免版本探测差异重现中间帧。
        if should_force_claude_synchronized_output(&profile.command) {
            command.env("CLAUDE_CODE_FORCE_SYNC_OUTPUT", "1");
        }
        // Qwen 默认只对少数终端品牌开启 DEC 2026；直接启动时使用它自己的官方开关，不能套用 Claude 环境变量。
        if should_force_qwen_synchronized_output(&profile.command) {
            command.env("QWEN_CODE_FORCE_SYNCHRONIZED_OUTPUT", "1");
        }

        let mut child = match pair.slave.spawn_command(command) {
            Ok(child) => child,
            Err(error) => {
                queue_session_status(&output_queue, &app_handle, &session_id, "error");
                queue_output(
                    &output_queue,
                    &app_handle,
                    &session_id,
                    format!("\r\n本地终端启动失败：{error}\r\n"),
                );
                return;
            }
        };
        drop(pair.slave);

        let mut reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(error) => {
                let _ = child.kill();
                queue_session_status(&output_queue, &app_handle, &session_id, "error");
                queue_output(
                    &output_queue,
                    &app_handle,
                    &session_id,
                    format!("\r\n本地终端读取失败：{error}\r\n"),
                );
                return;
            }
        };
        let mut writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let _ = child.kill();
                queue_session_status(&output_queue, &app_handle, &session_id, "error");
                queue_output(
                    &output_queue,
                    &app_handle,
                    &session_id,
                    format!("\r\n本地终端写入失败：{error}\r\n"),
                );
                return;
            }
        };

        queue_session_status(&output_queue, &app_handle, &session_id, "connected");

        let reader_queue = Arc::clone(&output_queue);
        let reader_app_handle = app_handle.clone();
        let reader_session_id = session_id.clone();
        let (reader_done_tx, reader_done_rx) = mpsc::channel();
        thread::spawn(move || {
            let mut buffer = [0_u8; 16384];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(size) => {
                        let content = String::from_utf8_lossy(&buffer[..size]).into_owned();
                        if !content.is_empty() {
                            queue_output(
                                &reader_queue,
                                &reader_app_handle,
                                &reader_session_id,
                                content,
                            );
                        }
                    }
                    Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            let _ = reader_done_tx.send(());
        });

        loop {
            if reader_done_rx.try_recv().is_ok() {
                break;
            }
            if matches!(child.try_wait(), Ok(Some(_))) {
                break;
            }

            match control_rx.recv_timeout(Duration::from_millis(8)) {
                Ok(SessionControl::Input(data)) => {
                    if writer
                        .write_all(data.as_bytes())
                        .and_then(|_| writer.flush())
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(SessionControl::Resize { cols, rows }) => {
                    let _ = pair.master.resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
                Ok(SessionControl::Close) => {
                    let _ = child.kill();
                    break;
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    let _ = child.kill();
                    break;
                }
            }
        }

        drop(writer);
        let _ = child.try_wait().or_else(|_| child.wait().map(Some));
        queue_session_status(&output_queue, &app_handle, &session_id, "closed");
    });
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

fn stat_is_dir(stat: &ssh2::FileStat) -> bool {
    stat.perm
        .map(|perm| (perm & 0o170000) == 0o040000)
        .unwrap_or(false)
}

fn modified_at(stat: &ssh2::FileStat) -> Option<String> {
    let timestamp = stat.mtime? as i64;
    chrono::DateTime::<Utc>::from_timestamp(timestamp, 0).map(|value| value.to_rfc3339())
}

fn stat_is_symlink(stat: &ssh2::FileStat) -> bool {
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
fn load_remote_identity_maps(session: &Session) -> (HashMap<u32, String>, HashMap<u32, String>) {
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
        let end = rest
            .find(char::is_whitespace)
            .unwrap_or(rest.len());
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
                detail: if detail.is_empty() { fields[2].to_string() } else { detail.to_string() },
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
            detail: if detail.is_empty() { fields[1].to_string() } else { detail.to_string() },
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

fn parse_docker_resource_usage(
    contents: &str,
    metric: &str,
    target: &str,
    limit: usize,
) -> RuntimeResourceUsage {
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
            context: String::from("Docker"),
            cpu: parts[2].to_string(),
            memory: memory.to_string(),
            detail: parts[3].to_string(),
            cpu_percent,
            memory_percent,
        });
    }

    RuntimeResourceUsage {
        source: String::from("docker"),
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
    Ok(parse_system_resource_usage(&contents, metric, target, limit))
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
    Ok(parse_docker_resource_usage(&contents, metric, target, limit))
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
    Ok(parse_kubernetes_resource_usage(&contents, metric, target, limit))
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
        "kubernetes" => query_kubernetes_resource_usage_with_session(session, metric, target, limit)?,
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

fn query_runtime_storage_files_with_session(session: &Session) -> Result<RuntimeStorageFiles, AppError> {
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

fn read_remote_file_bytes(
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

fn write_remote_file_bytes(
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

fn list_remote_entries_cached(
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

fn query_runtime_overview_cached(
    state: &AppState,
    connection: &ConnectionProfile,
) -> Result<RuntimeOverview, AppError> {
    with_auxiliary_session(state, connection, |auxiliary| {
        query_runtime_overview_with_session(connection, &auxiliary.session)
    })
}

fn query_runtime_resource_usage_cached(
    state: &AppState,
    connection: &ConnectionProfile,
    request: &RuntimeResourceUsageRequest,
) -> Result<RuntimeResourceUsage, AppError> {
    with_auxiliary_session(state, connection, |auxiliary| {
        query_runtime_resource_usage_with_session(&auxiliary.session, request)
    })
}

// 复用辅助 SSH 会话执行最大文件扫描，避免展开存储明细时占用主终端会话。
fn query_runtime_storage_files_cached(
    state: &AppState,
    connection: &ConnectionProfile,
) -> Result<RuntimeStorageFiles, AppError> {
    with_auxiliary_session(state, connection, |auxiliary| {
        query_runtime_storage_files_with_session(&auxiliary.session)
    })
}

fn read_remote_shell_history_entries_cached(
    state: &AppState,
    connection: &ConnectionProfile,
    limit: usize,
) -> Result<Vec<HistoryEntry>, AppError> {
    with_auxiliary_session(state, connection, |auxiliary| {
        read_remote_shell_history_entries_with_session(connection, &auxiliary.session, limit)
    })
}

fn upload_remote_file_with_cache(
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

fn upload_local_paths_with_cache(
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

fn download_remote_file_with_cache(
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

fn download_remote_paths_with_cache(
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

fn delete_remote_path_with_cache(
    state: &AppState,
    connection: &ConnectionProfile,
    path: &str,
) -> Result<(), AppError> {
    with_auxiliary_session_once(state, connection, |auxiliary| {
        let sftp = auxiliary_sftp(auxiliary)?;
        delete_remote_path_with_sftp(sftp, path)
    })
}

fn delete_remote_paths_with_cache(
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

fn rename_remote_path_with_cache(
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

fn copy_remote_paths_with_cache(
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

fn forward_single_connection(
    pool: Arc<TunnelSshPool>,
    remote_host: String,
    remote_port: u16,
    local_stream: TcpStream,
    stop_flag: Arc<AtomicBool>,
) {
    let Ok(Some(mut lease)) = pool.checkout(&stop_flag) else {
        return;
    };

    let channel =
        match open_direct_tcpip_channel(lease.session(), &remote_host, remote_port, &stop_flag) {
            Ok(Some(channel)) => channel,
            Ok(None) => return,
            Err(_) => {
                if stop_flag.load(Ordering::Relaxed) {
                    lease.discard();
                }
                return;
            }
        };

    if !proxy_tcp_stream(local_stream, channel, Arc::clone(&stop_flag))
        && !stop_flag.load(Ordering::Relaxed)
    {
        lease.discard();
    }
}

fn spawn_tunnel_listener(
    pool: Arc<TunnelSshPool>,
    tunnel: TunnelRecord,
    stop_flag: Arc<AtomicBool>,
) -> Result<(), AppError> {
    let listener = TcpListener::bind((tunnel.bind_address.as_str(), tunnel.local_port))?;
    listener.set_nonblocking(true)?;

    thread::spawn(move || {
        while !stop_flag.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let pool = Arc::clone(&pool);
                    let remote_host = tunnel.remote_host.clone();
                    let remote_port = tunnel.remote_port;
                    let stop = Arc::clone(&stop_flag);
                    thread::spawn(move || {
                        forward_single_connection(pool, remote_host, remote_port, stream, stop);
                    });
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(40));
                }
                Err(_) => break,
            }
        }
    });

    Ok(())
}

fn detect_language(path: &str) -> String {
    if path.ends_with(".rs") {
        "rust".into()
    } else if path.ends_with(".ts") || path.ends_with(".tsx") {
        "typescript".into()
    } else if path.ends_with(".json") {
        "json".into()
    } else if path.ends_with(".yml") || path.ends_with(".yaml") {
        "yaml".into()
    } else if path.ends_with(".conf") || path.ends_with(".ini") {
        "ini".into()
    } else if path.ends_with(".md") {
        "markdown".into()
    } else {
        "shell".into()
    }
}

fn stop_all_runtimes(state: &AppState) -> Result<(), AppError> {
    let mut sessions = lock_sessions(state)?;
    for runtime in sessions.drain().map(|(_, runtime)| runtime) {
        runtime.stop_flag.store(true, Ordering::Relaxed);
        let _ = runtime.control_tx.send(SessionControl::Close);
    }
    drop(sessions);
    clear_auxiliary_sessions(state);

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
    let mut cli_path = env::current_exe()?;
    cli_path.set_file_name("myterminal-cli.exe");
    let target = cli_path.to_string_lossy().replace('\'', "''");
    let script = format!(
        "$target = '{target}'; \
         Get-CimInstance Win32_Process -Filter \"name = 'myterminal-cli.exe'\" | \
         Where-Object {{ $_.ExecutablePath -eq $target }} | \
         ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}"
    );

    // 只清理当前安装/开发目录旁边的 CLI，避免误杀其他 MyTerminal 副本或同名调试程序。
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
        // 无论保活是否开启，每轮都顺带回收空闲超时或超量的辅助连接，收敛长时间运行的常驻内存。
        evict_idle_auxiliary_sessions(&state);
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
            Ok(pools) => pools.get(&connection_id).map(|pool| pool.connection.clone()),
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

fn bootstrap_from_storage(state: &AppState) -> Result<BootstrapState, AppError> {
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
pub fn agent_bridge_status(
    state: State<'_, AppState>,
) -> Result<agent_bridge::AgentBridgeStatus, String> {
    let settings = state.storage.load_settings(&state.crypto)?;
    Ok(agent_bridge::bridge_status(
        &state.agent_bridge,
        &state.storage,
        &settings.agent_bridge,
    )?)
}

#[tauri::command]
pub fn list_agent_bridge_requests(
    state: State<'_, AppState>,
) -> Result<Vec<agent_bridge::AgentBridgeRequest>, String> {
    Ok(agent_bridge::list_requests(&state.agent_bridge)?)
}

#[tauri::command]
pub fn approve_agent_bridge_request(
    state: State<'_, AppState>,
    request_id: String,
    edited_command: Option<String>,
) -> Result<bool, String> {
    let settings = state.storage.load_settings(&state.crypto)?;
    Ok(agent_bridge::approve_request(
        &state.agent_bridge,
        &state.storage,
        &state.crypto,
        &settings.agent_bridge,
        &request_id,
        edited_command,
    )?)
}

#[tauri::command]
pub fn reject_agent_bridge_request(
    state: State<'_, AppState>,
    request_id: String,
    reason: Option<String>,
) -> Result<bool, String> {
    Ok(agent_bridge::reject_request(
        &state.agent_bridge,
        &request_id,
        reason,
    )?)
}

#[tauri::command]
pub fn clear_agent_bridge_requests(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(agent_bridge::clear_finished_requests(&state.agent_bridge)?)
}

/// 创建带动作按钮的 MCP 审批系统通知；按钮回调只发送前端事件，审批状态仍由现有审批接口处理。
#[tauri::command]
pub fn show_agent_bridge_notification(
    app_handle: AppHandle,
    request: AgentBridgeNotificationRequest,
) -> Result<bool, String> {
    // 系统通知只负责展示 Windows toast 与捕获动作按钮，实际审批仍统一回到前端调用既有 MCP 审批命令。
    let mut notification = notify_rust::Notification::new();
    notification
        .summary(&request.title)
        .body(&request.body)
        .action(
            AGENT_BRIDGE_NOTIFICATION_APPROVE_ACTION_ID,
            &request.approve_label,
        )
        .action(
            AGENT_BRIDGE_NOTIFICATION_REJECT_ACTION_ID,
            &request.reject_label,
        );

    #[cfg(windows)]
    {
        // Windows toast 需要稳定的 AppUserModelID；沿用 Tauri 配置里的应用标识，和系统通知中心归属保持一致。
        notification.app_id(&app_handle.config().identifier);
    }

    let request_id = request.request_id;
    let event_app_handle = app_handle.clone();
    let handle = notification
        .show()
        .map_err(|error| format!("notification error: {error}"))?;

    thread::spawn(move || {
        // notify-rust 的动作等待是阻塞式；单独线程只负责把系统按钮动作转成前端事件。
        handle.wait_for_action(|action_id| {
            let _ = event_app_handle.emit(
                AGENT_BRIDGE_NOTIFICATION_ACTION_EVENT,
                AgentBridgeNotificationActionEvent {
                    request_id: request_id.clone(),
                    action_id: action_id.to_string(),
                },
            );
        });
    });

    Ok(true)
}

#[tauri::command]
pub fn set_agent_bridge_enabled(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<agent_bridge::AgentBridgeStatus, String> {
    agent_bridge::set_app_handle(&state.agent_bridge, app_handle)?;
    let mut settings = state.storage.load_settings(&state.crypto)?;
    settings.agent_bridge.enabled = enabled;
    state.storage.save_settings(&settings, &state.crypto)?;
    if enabled {
        prepare_agent_bridge_startup()?;
    }
    agent_bridge::sync_server(
        &state.agent_bridge,
        &state.storage,
        &state.crypto,
        &settings.agent_bridge,
    )?;
    Ok(agent_bridge::bridge_status(
        &state.agent_bridge,
        &state.storage,
        &settings.agent_bridge,
    )?)
}

#[tauri::command]
pub fn reset_agent_bridge_token(
    app_handle: AppHandle,
    state: State<'_, AppState>,
) -> Result<agent_bridge::AgentBridgeStatus, String> {
    agent_bridge::set_app_handle(&state.agent_bridge, app_handle)?;
    let settings = state.storage.load_settings(&state.crypto)?;
    agent_bridge::stop_server(&state.agent_bridge, &state.storage)?;
    agent_bridge::reset_agent_bridge_token(&state.storage)?;
    if settings.agent_bridge.enabled {
        prepare_agent_bridge_startup()?;
    }
    agent_bridge::sync_server(
        &state.agent_bridge,
        &state.storage,
        &state.crypto,
        &settings.agent_bridge,
    )?;
    Ok(agent_bridge::bridge_status(
        &state.agent_bridge,
        &state.storage,
        &settings.agent_bridge,
    )?)
}

#[tauri::command]
pub fn test_connection(connection: ConnectionProfile) -> Result<bool, String> {
    let _ = connect_ssh(&connection)?;
    Ok(true)
}

#[tauri::command]
pub fn create_connection(
    state: State<'_, AppState>,
    connection: ConnectionProfile,
) -> Result<ConnectionProfile, String> {
    validate_connection_profile(&connection)?;
    drop_auxiliary_session(&state, &connection.id);
    // 连接配置可能被同 ID 覆盖；旧隧道必须停止，避免后台继续使用旧主机、旧代理或旧凭据。
    stop_connection_tunnel_runtimes(&state, &connection.id)?;
    mark_connection_tunnels_stopped(&state, &connection.id)?;
    let mut connections = state.storage.load_connections(&state.crypto)?;
    connections.retain(|item| item.id != connection.id);
    connections.insert(0, connection.clone());
    state
        .storage
        .save_connections(&connections, &state.crypto)?;
    Ok(connection)
}

#[tauri::command]
pub fn update_connection(
    state: State<'_, AppState>,
    connection: ConnectionProfile,
) -> Result<ConnectionProfile, String> {
    create_connection(state, connection)
}

#[tauri::command]
pub fn delete_connection(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<bool, String> {
    drop_auxiliary_session(&state, &connection_id);
    let mut connections = state.storage.load_connections(&state.crypto)?;
    connections.retain(|item| item.id != connection_id);
    state
        .storage
        .save_connections(&connections, &state.crypto)?;

    let mut sessions = lock_sessions(&state)?;
    let session_ids = sessions
        .iter()
        .filter_map(|(session_id, runtime)| {
            (runtime.session.connection_id == connection_id).then(|| session_id.clone())
        })
        .collect::<Vec<_>>();

    for session_id in session_ids {
        if let Some(runtime) = sessions.remove(&session_id) {
            runtime.stop_flag.store(true, Ordering::Relaxed);
            let _ = runtime.control_tx.send(SessionControl::Close);
        }
    }
    drop(sessions);

    let persisted_tunnels = state.storage.load_tunnels()?;
    let tunnel_ids = persisted_tunnels
        .iter()
        .filter(|tunnel| tunnel.connection_id == connection_id)
        .map(|tunnel| tunnel.id.clone())
        .collect::<Vec<_>>();

    let mut tunnel_runtime = lock_tunnels(&state)?;
    for tunnel_id in tunnel_ids {
        if let Some(runtime) = tunnel_runtime.remove(&tunnel_id) {
            runtime.stop_flag.store(true, Ordering::Relaxed);
        }
    }
    drop(tunnel_runtime);
    drop_tunnel_ssh_pool(&state, &connection_id);

    let mut tunnels = persisted_tunnels;
    tunnels.retain(|item| item.connection_id != connection_id);
    state.storage.save_tunnels(&tunnels)?;

    Ok(true)
}

#[tauri::command]
pub fn open_ssh_session(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    connection_id: String,
) -> Result<TerminalSession, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let output_queue = Arc::new(std::sync::Mutex::new(TerminalOutputQueue::new()));
    let (control_tx, control_rx) = mpsc::channel();
    let stop_flag = Arc::new(AtomicBool::new(false));

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
    };

    let session = runtime.session.clone();
    lock_sessions(&state)?.insert(session.id.clone(), runtime);

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

// SFTP 目录列举走网络，用 (async) 移出主线程，避免文件管理刷新时冻结 UI。
#[tauri::command(async)]
pub fn list_remote_files(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<Vec<RemoteFileEntry>, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    list_remote_entries_cached(&state, &connection, &path).map_err(Into::into)
}

// 以下文件操作均走阻塞 SFTP 网络往返，统一用 (async) 移出主线程，操作期间不冻结终端与界面。
#[tauri::command(async)]
pub fn upload_remote_file(
    state: State<'_, AppState>,
    connection_id: String,
    remote_dir: String,
    file_name: String,
    content_base64: String,
) -> Result<bool, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    let bytes = STANDARD
        .decode(content_base64)
        .map_err(|error| AppError::Validation(format!("invalid upload payload: {error}")))?;
    // 上传已持有当前 SFTP 连接，直接在该连接上写入，避免一次上传重复建立 SSH/SFTP 导致远端连接抖动。
    upload_remote_file_with_cache(&state, &connection, &remote_dir, &file_name, &bytes)?;
    Ok(true)
}

#[tauri::command(async)]
pub fn upload_local_paths(
    state: State<'_, AppState>,
    connection_id: String,
    remote_dir: String,
    local_paths: Vec<String>,
) -> Result<FileTransferSummary, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    Ok(upload_local_paths_with_cache(
        &state,
        &connection,
        &remote_dir,
        &local_paths,
    )?)
}

#[tauri::command(async)]
pub fn download_remote_file(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<String, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    Ok(download_remote_file_with_cache(&state, &connection, &path)?)
}

#[tauri::command(async)]
pub fn download_remote_paths(
    state: State<'_, AppState>,
    connection_id: String,
    paths: Vec<String>,
    local_dir: Option<String>,
) -> Result<FileTransferSummary, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    Ok(download_remote_paths_with_cache(
        &state,
        &connection,
        &paths,
        local_dir.as_deref(),
    )?)
}

#[tauri::command(async)]
pub fn delete_remote_path(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<bool, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    delete_remote_path_with_cache(&state, &connection, &path)?;
    Ok(true)
}

// 单路径删除复用传入的 SFTP 句柄，供单删和批量删除共用同一套目录/文件判断规则。
fn delete_remote_path_with_sftp(sftp: &Sftp, path: &str) -> Result<(), AppError> {
    let remote_path = normalize_remote_path(path);
    let stat = sftp.lstat(Path::new(&remote_path)).map_err(ssh_error)?;
    if stat_is_symlink(&stat) {
        sftp.unlink(Path::new(&remote_path)).map_err(ssh_error)?;
    } else if stat_is_dir(&stat) {
        // SFTP rmdir 只能删除空目录；文件管理删除目录时先递归清空子项，再删除目录本身。
        for (entry_path, _entry_stat) in sftp.readdir(Path::new(&remote_path)).map_err(ssh_error)? {
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

#[tauri::command(async)]
// 批量删除只建立一次 SSH/SFTP 会话，逐项删除后由前端统一刷新目录。
pub fn delete_remote_paths(
    state: State<'_, AppState>,
    connection_id: String,
    paths: Vec<String>,
) -> Result<bool, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    delete_remote_paths_with_cache(&state, &connection, &paths)?;
    Ok(true)
}

#[tauri::command(async)]
// 远端内部复制：一次辅助会话即可完成多选源到目标目录的服务器本地 cp，复制大目录时避免客户端中转。
pub fn copy_remote_paths(
    state: State<'_, AppState>,
    connection_id: String,
    sources: Vec<String>,
    target_dir: String,
) -> Result<bool, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    copy_remote_paths_with_cache(&state, &connection, &sources, &target_dir)?;
    Ok(true)
}

#[tauri::command(async)]
pub fn rename_remote_path(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
    new_path: String,
) -> Result<bool, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    rename_remote_path_with_cache(&state, &connection, &path, &new_path)?;
    Ok(true)
}

#[tauri::command(async)]
pub fn load_editor_document(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<EditorDocument, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    let bytes = match read_remote_file_bytes(&state, &connection, &path) {
        Ok(bytes) => bytes,
        // 文件超限属于确定性拒绝，直接返回错误提示，不能回退到本地缓存草稿误导用户以为能编辑。
        Err(error @ AppError::Validation(_)) => return Err(error.into()),
        Err(error) => {
            if let Some(mut cached) = state.storage.load_editor_cache(&connection_id, &path)? {
                cached.dirty = true;
                return Ok(cached);
            }
            return Err(error.into());
        }
    };
    let document = EditorDocument {
        connection_id,
        path: path.clone(),
        content: String::from_utf8_lossy(&bytes).into_owned(),
        language: detect_language(&path),
        dirty: false,
    };
    state.storage.save_editor_cache(&document)?;
    Ok(document)
}

#[tauri::command(async)]
pub fn save_editor_document(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
    content: String,
) -> Result<bool, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    write_remote_file_bytes(&state, &connection, &path, content.as_bytes())?;

    let document = EditorDocument {
        connection_id,
        path: path.clone(),
        content,
        language: detect_language(&path),
        dirty: false,
    };
    state.storage.save_editor_cache(&document)?;
    Ok(true)
}

#[tauri::command]
pub fn list_tunnels(state: State<'_, AppState>) -> Result<Vec<TunnelRecord>, String> {
    Ok(state.storage.load_tunnels()?)
}

// 运行状态要跑多条远端命令，必须用 (async) 放到独立线程执行，避免阻塞主线程冻结整个 UI 和终端输入。
#[tauri::command(async)]
pub fn fetch_runtime_overview(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<RuntimeOverview, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    Ok(query_runtime_overview_cached(&state, &connection)?)
}

// 资源明细只在内存行展开时按需执行，避免常规运行状态刷新反复拉取进程、线程或容器列表。
#[tauri::command(async)]
pub fn fetch_runtime_resource_usage(
    state: State<'_, AppState>,
    connection_id: String,
    request: RuntimeResourceUsageRequest,
) -> Result<RuntimeResourceUsage, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    Ok(query_runtime_resource_usage_cached(&state, &connection, &request)?)
}

// 最大文件扫描可能触发较多磁盘遍历，仅在存储行展开后由前端按需调用。
#[tauri::command(async)]
pub fn fetch_runtime_storage_files(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<RuntimeStorageFiles, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    Ok(query_runtime_storage_files_cached(&state, &connection)?)
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

// 远程背景图最大下载体积，避免误填超大文件或非图片资源撑爆内存与 data URL。
const REMOTE_BACKGROUND_IMAGE_MAX_BYTES: usize = 20 * 1024 * 1024;

#[tauri::command]
pub async fn fetch_remote_background_image(url: String) -> Result<String, String> {
    let trimmed = url.trim();
    // 只处理 http(s) 远程地址；本地路径、data:、asset: 等由前端自行渲染，不该进后端下载。
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("仅支持 http(s) 远程图片地址".to_string());
    }

    // 走后端 reqwest 下载可绕开 WebView 自动附带的 tauri.localhost Referer，避免被图床防盗链拦截返回 403。
    let client = build_update_http_client(UPDATE_HTTP_READ_TIMEOUT)?;
    let response = client
        .get(trimmed)
        .header(reqwest::header::USER_AGENT, "Mozilla/5.0")
        .send()
        .await
        .map_err(|err| format!("背景图下载失败，请检查网络或链接是否有效。错误原因: {err}"))?;

    let response = response
        .error_for_status()
        .map_err(|err| format!("背景图请求返回错误状态: {err}"))?;

    // 响应头 Content-Type 仅作兜底：部分图床(如 haowallpaper)声称 jpeg 实际却是 webp，data URL 的 MIME 与真实字节不符时浏览器会拒绝渲染。
    let header_content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or(value).trim().to_string())
        .filter(|value| value.starts_with("image/"));

    let bytes = response
        .bytes()
        .await
        .map_err(|err| format!("背景图数据读取失败: {err}"))?;

    if bytes.is_empty() {
        return Err("背景图内容为空".to_string());
    }
    if bytes.len() > REMOTE_BACKGROUND_IMAGE_MAX_BYTES {
        return Err("背景图体积过大，请更换更小的图片".to_string());
    }

    // 以真实字节的魔术数字识别图片类型，避免服务器 Content-Type 与内容不符导致 data URL 无法渲染。
    let content_type = detect_image_mime(&bytes)
        .map(|mime| mime.to_string())
        .or(header_content_type)
        .unwrap_or_else(|| "image/jpeg".to_string());

    // 转成 data URL 返回；CSP 已允许 img-src data:，前端可直接用作 background-image。
    let encoded = STANDARD.encode(&bytes);
    Ok(format!("data:{content_type};base64,{encoded}"))
}

// 通过文件头魔术字节判断常见图片格式，返回标准 MIME；识别不出时返回 None 交由调用方兜底。
fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 12 {
        return None;
    }
    // JPEG: FF D8 FF
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    // GIF: "GIF8"
    if bytes.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    // WebP: "RIFF"...."WEBP"
    if bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    // BMP: "BM"
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    None
}

#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateCheckResult, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    // 更新提示返回给前端的 Release 页面地址，必须和 GitHub 仓库名保持一致。
    let release_url = "https://github.com/CrazyFigure/MyTerminal/releases/latest".to_string();
    let client = build_update_http_client(UPDATE_HTTP_READ_TIMEOUT)?;
    // GitHub API 要求明确 User-Agent；这里仅读取最新 Release 元数据，并挑出后续可安装的 Windows 安装包。
    let response = client
        .get("https://api.github.com/repos/CrazyFigure/MyTerminal/releases/latest")
        .header(reqwest::header::USER_AGENT, "MyTerminal")
        .send()
        .await
        .map_err(|err| format!("网络请求失败，检测更新超时或被重置。请检查网络连接或代理设置。错误原因: {err}"))?;

    // 针对 GitHub 接口返回 403 Forbidden 进行拦截，由于通常是 API Rate Limit 频率超限导致
    if response.status() == reqwest::StatusCode::FORBIDDEN {
        return Err("由于 GitHub 接口访问频率限制（Rate Limit Exceeded），当前 IP 暂时被 GitHub 拒绝对 API 的请求。您可以稍后再试，或者直接点击右上角「GitHub 仓库」前往 Release 页面手动下载新版本。".to_string());
    }

    let release = response
        .error_for_status()
        .map_err(|err| format!("HTTP 状态码错误: {err}"))?
        .json::<GitHubReleaseResponse>()
        .await
        .map_err(|err| format!("解析 Release 数据失败: {err}"))?;

    let latest_version = release.tag_name.trim_start_matches(['v', 'V']).to_string();
    let update_available = is_newer_version(&release.tag_name, &current_version);
    let installer_asset = select_update_installer_asset(&release.assets);
    Ok(UpdateCheckResult {
        current_version,
        latest_version,
        release_name: release.name,
        release_url: if release.html_url.is_empty() {
            release_url
        } else {
            release.html_url
        },
        published_at: release.published_at,
        update_available,
        installer_asset_name: installer_asset.as_ref().map(|asset| asset.name.clone()),
        installer_download_url: installer_asset
            .as_ref()
            .map(|asset| asset.browser_download_url.clone()),
        installer_size: installer_asset.and_then(|asset| asset.size),
        release_body: release.body,
    })
}

#[tauri::command]
pub async fn download_and_install_update(
    app_handle: AppHandle,
    download_url: String,
    asset_name: String,
    installer_size: Option<u64>,
) -> Result<String, String> {
    let normalized_url = download_url.trim();
    if !is_valid_update_download_url(normalized_url) {
        return Err(AppError::Validation("invalid update installer URL".into()).into());
    }

    let safe_file_name = sanitize_asset_file_name(&asset_name);
    let update_dir = env::temp_dir().join("MyTerminal-updates");
    fs::create_dir_all(&update_dir).map_err(|error| AppError::from(error).to_string())?;
    let installer_path: PathBuf = update_dir.join(safe_file_name);

    // 本地已有完整安装包时直接启动，避免用户重复点击时再次等待 GitHub 下载。
    if installer_path_matches_expected_size(&installer_path, installer_size)? {
        spawn_update_installer(&installer_path)
            .map_err(|error| AppError::from(error).to_string())?;
        return Ok(installer_path.to_string_lossy().to_string());
    }

    let client = build_update_http_client(UPDATE_INSTALLER_DOWNLOAD_TIMEOUT)?;
    // 安装包下载使用 GitHub Release 浏览器下载地址；完成写入后立即启动安装程序，交互式确认交给安装器自身处理。
    download_update_installer(&app_handle, &client, normalized_url, &installer_path, installer_size).await?;
    spawn_update_installer(&installer_path).map_err(|error| AppError::from(error).to_string())?;
    Ok(installer_path.to_string_lossy().to_string())
}

#[cfg(target_os = "windows")]
fn spawn_system_url_opener(url: &str) -> std::io::Result<()> {
    Command::new("explorer.exe").arg(url).spawn().map(|_| ())
}

#[cfg(target_os = "macos")]
fn spawn_system_url_opener(url: &str) -> std::io::Result<()> {
    Command::new("open").arg(url).spawn().map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_system_url_opener(url: &str) -> std::io::Result<()> {
    Command::new("xdg-open").arg(url).spawn().map(|_| ())
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<bool, String> {
    let normalized = url.trim();
    if !(normalized.starts_with("https://") || normalized.starts_with("http://")) {
        return Err(AppError::Validation("only http/https links can be opened".into()).into());
    }
    if normalized.chars().any(|character| character.is_control()) {
        return Err(AppError::Validation("link contains invalid control characters".into()).into());
    }

    // 外部链接只允许交给系统默认浏览器处理，不在 WebView 内弹新窗口，避免按钮点击无反馈。
    spawn_system_url_opener(normalized).map_err(|error| AppError::from(error).to_string())?;
    Ok(true)
}

#[tauri::command]
// 本地配置导出写入用户选择的位置；空路径用于兼容旧调用，回落到默认导出目录。
pub fn export_local_config(
    state: State<'_, AppState>,
    target_path: String,
) -> Result<String, String> {
    let bundle = LocalConfigBundle {
        schema_version: 1,
        exported_at: Utc::now().to_rfc3339(),
        settings: state.storage.load_settings(&state.crypto)?,
        connections: state.storage.load_connections(&state.crypto)?,
        history: state.storage.load_history()?,
        tunnels: state.storage.load_tunnels()?,
    };

    let normalized_path = target_path.trim();
    // 导出路径优先来自系统保存对话框；兼容旧调用时才回落到默认导出目录。
    let path = if normalized_path.is_empty() {
        let export_dir = state.storage.exports_dir_path();
        let timestamp = Utc::now().format("%Y%m%d-%H%M%S").to_string();
        export_dir.join(format!("myterminal-config-{timestamp}.json"))
    } else {
        PathBuf::from(normalized_path)
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| AppError::from(error).to_string())?;
    }
    let payload = serde_json::to_string_pretty(&bundle).map_err(AppError::from)?;
    fs::write(&path, payload).map_err(|error| AppError::from(error).to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn import_local_config(
    state: State<'_, AppState>,
    content: String,
) -> Result<BootstrapState, String> {
    let mut bundle: LocalConfigBundle = serde_json::from_str(&content).map_err(AppError::from)?;
    if bundle.schema_version > 1 {
        return Err(AppError::Validation(format!(
            "unsupported local config schema version {}",
            bundle.schema_version
        ))
        .into());
    }

    stop_all_runtimes(&state)?;

    state.storage.backup_existing_file(
        &state.storage.settings_file_path(),
        "settings-before-local-import",
    )?;
    state.storage.backup_existing_file(
        &state.storage.connections_file_path(),
        "connections-before-local-import",
    )?;
    state.storage.backup_existing_file(
        &state.storage.history_file_path(),
        "history-before-local-import",
    )?;
    state.storage.backup_existing_file(
        &state.storage.tunnels_file_path(),
        "tunnels-before-local-import",
    )?;

    for tunnel in &mut bundle.tunnels {
        tunnel.status = "stopped".into();
    }

    state
        .storage
        .save_settings(&bundle.settings, &state.crypto)?;
    state
        .storage
        .save_connections(&bundle.connections, &state.crypto)?;
    state.storage.save_history(&bundle.history)?;
    state.storage.save_tunnels(&bundle.tunnels)?;

    Ok(bootstrap_from_storage(&state)?)
}

#[tauri::command]
pub async fn upload_settings_to_webdav(state: State<'_, AppState>) -> Result<String, String> {
    let settings = state.storage.load_settings(&state.crypto)?;
    let remote_path = state
        .webdav
        .upload_settings(&settings, &state.crypto)
        .await?;
    Ok(remote_path)
}

#[tauri::command]
pub async fn list_settings_backups(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let settings = state.storage.load_settings(&state.crypto)?;
    let files = state.webdav.list_settings_backups(&settings.webdav).await?;
    Ok(files)
}

#[tauri::command]
// WebDAV 测试只校验当前草稿配置的连通性，不会把草稿写入本地设置。
pub async fn test_webdav_connection(
    state: State<'_, AppState>,
    webdav: WebDavSettings,
) -> Result<bool, String> {
    state.webdav.test_connection(&webdav).await?;
    Ok(true)
}

#[tauri::command]
pub async fn download_settings_from_webdav(
    state: State<'_, AppState>,
    remote_path: String,
) -> Result<AppSettings, String> {
    let current_settings = state.storage.load_settings(&state.crypto)?;
    state
        .storage
        .backup_existing_file(&state.storage.settings_file_path(), "settings")?;
    let downloaded = state
        .webdav
        .download_settings(&current_settings.webdav, &remote_path, &state.crypto)
        .await?;
    state.storage.save_settings(&downloaded, &state.crypto)?;
    Ok(downloaded)
}

#[tauri::command]
pub async fn upload_connections_to_webdav(state: State<'_, AppState>) -> Result<String, String> {
    let settings = state.storage.load_settings(&state.crypto)?;
    let connections = state.storage.load_connections(&state.crypto)?;
    let remote_path = state
        .webdav
        .upload_connections(&settings, &connections, &state.crypto)
        .await?;
    Ok(remote_path)
}

#[tauri::command]
pub async fn list_connections_backups(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let settings = state.storage.load_settings(&state.crypto)?;
    let files = state
        .webdav
        .list_connections_backups(&settings.webdav)
        .await?;
    Ok(files)
}

#[tauri::command]
pub async fn download_connections_from_webdav(
    state: State<'_, AppState>,
    remote_path: String,
) -> Result<Vec<ConnectionProfile>, String> {
    let settings = state.storage.load_settings(&state.crypto)?;
    state
        .storage
        .backup_existing_file(&state.storage.connections_file_path(), "connections")?;
    let connections = state
        .webdav
        .download_connections(&settings.webdav, &remote_path, &state.crypto)
        .await?;
    state
        .storage
        .save_connections(&connections, &state.crypto)?;
    Ok(connections)
}

#[tauri::command]
/// 合并上传所有配置到 WebDAV，与本地导出使用相同的 LocalConfigBundle 结构。
pub async fn upload_config_to_webdav(state: State<'_, AppState>) -> Result<String, String> {
    let settings = state.storage.load_settings(&state.crypto)?;
    let connections = state.storage.load_connections(&state.crypto)?;
    let history = state.storage.load_history()?;
    let tunnels = state.storage.load_tunnels()?;
    let bundle = LocalConfigBundle {
        schema_version: 1,
        exported_at: Utc::now().to_rfc3339(),
        settings: settings.clone(),
        connections,
        history,
        tunnels,
    };
    let remote_path = state
        .webdav
        .upload_config_bundle(&settings.webdav, &bundle)
        .await?;
    Ok(remote_path)
}

#[tauri::command]
pub async fn list_config_backups(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let settings = state.storage.load_settings(&state.crypto)?;
    let files = state.webdav.list_config_backups(&settings.webdav).await?;
    Ok(files)
}

#[tauri::command]
/// 从 WebDAV 下载配置包并覆盖本地数据。
/// 优先尝试合并格式（LocalConfigBundle），若失败则兼容旧格式：
/// - settings-*.enc.json：只覆盖应用设置
/// - connections-*.enc.json：只覆盖 SSH 连接
pub async fn download_config_from_webdav(
    state: State<'_, AppState>,
    remote_path: String,
) -> Result<BootstrapState, String> {
    let current_settings = state.storage.load_settings(&state.crypto)?;
    let filename = remote_path.rsplit('/').next().unwrap_or(&remote_path);

    // 先尝试合并格式（myterminal-config-*.enc.json）
    if filename.starts_with("myterminal-config") {
        let mut bundle = state
            .webdav
            .download_config_bundle(&current_settings.webdav, &remote_path)
            .await
            .map_err(|error| error.to_string())?;

        if bundle.schema_version > 1 {
            return Err(AppError::Validation(format!(
                "unsupported config schema version {}",
                bundle.schema_version
            ))
            .to_string());
        }

        stop_all_runtimes(&state)?;

        state.storage.backup_existing_file(
            &state.storage.settings_file_path(),
            "settings-before-webdav-import",
        )?;
        state.storage.backup_existing_file(
            &state.storage.connections_file_path(),
            "connections-before-webdav-import",
        )?;
        state.storage.backup_existing_file(
            &state.storage.history_file_path(),
            "history-before-webdav-import",
        )?;
        state.storage.backup_existing_file(
            &state.storage.tunnels_file_path(),
            "tunnels-before-webdav-import",
        )?;

        for tunnel in &mut bundle.tunnels {
            tunnel.status = "stopped".into();
        }

        state
            .storage
            .save_settings(&bundle.settings, &state.crypto)?;
        state
            .storage
            .save_connections(&bundle.connections, &state.crypto)?;
        state.storage.save_history(&bundle.history)?;
        state.storage.save_tunnels(&bundle.tunnels)?;

        return Ok(bootstrap_from_storage(&state)?);
    }

    // 兼容旧格式：settings-*.enc.json 或 connections-*.enc.json
    stop_all_runtimes(&state)?;

    if filename.starts_with("settings") {
        state.storage.backup_existing_file(
            &state.storage.settings_file_path(),
            "settings-before-webdav-import",
        )?;
        let downloaded = state
            .webdav
            .download_settings(&current_settings.webdav, &remote_path, &state.crypto)
            .await
            .map_err(|error| error.to_string())?;
        state.storage.save_settings(&downloaded, &state.crypto)?;
    } else if filename.starts_with("connections") {
        state.storage.backup_existing_file(
            &state.storage.connections_file_path(),
            "connections-before-webdav-import",
        )?;
        let connections = state
            .webdav
            .download_connections(&current_settings.webdav, &remote_path, &state.crypto)
            .await
            .map_err(|error| error.to_string())?;
        state
            .storage
            .save_connections(&connections, &state.crypto)?;
    } else {
        return Err(
            AppError::Validation(format!("unrecognized backup file: {filename}")).to_string(),
        );
    }

    Ok(bootstrap_from_storage(&state)?)
}
