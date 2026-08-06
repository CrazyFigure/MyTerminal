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
        Arc, Condvar, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use portable_pty::{CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use ssh2::{Channel, ExtendedData, MethodType, Session, Sftp};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    agent_bridge, agent_chat, agent_tools,
    error::AppError,
    models::{
        AgentConversation, AgentProvider, AgentRunOptions, AppSettings, BootstrapState,
        ConnectionProfile, EditorDocument, HistoryEntry,
        HistoryEntryInput, LocalTerminalProfile, LocalTerminalSettings,
        RemoteFileEntry, RuntimeConnectionList, RuntimeOverview, SshJumpHost, SshProxyConfig,
        RuntimeResourceUsage, RuntimeResourceUsageRequest, RuntimeStorageFiles,
        TerminalOutputChunk, TerminalSession, TunnelOpenRequest, TunnelRecord, TunnelUpdateRequest,
        UpdateCheckResult,
    },
    state::{
        AgentPtyPhase, AgentPtyState, AppState, AuxiliarySshSession, RuntimeSession,
        SessionControl, TerminalOutputQueue, TunnelRuntime, TunnelSshPool, TunnelSshPoolSession,
        TunnelSshPoolState,
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
// 服务端 MaxStartups 限流或跳板桥刚建立时可能立即丢弃首个握手连接；banner 专属错误只短暂退避重试一次。
const SSH_BANNER_RETRY_DELAY: Duration = Duration::from_millis(300);
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

    let protocol = connection.protocol.trim().to_ascii_lowercase();
    if protocol == "rdp" {
        // Windows 远程桌面只接受账号密码；SSH 私钥、跳板机和代理字段由前端保存时清空，此处不参与校验。
        return validate_ssh_auth_fields(
            "RDP connection",
            &connection.username,
            "password",
            &connection.password,
            None,
            None,
        );
    }
    if protocol != "ssh" {
        return Err(AppError::Validation(format!(
            "unsupported connection protocol: {protocol}"
        )));
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

fn normalize_connection_protocol_fields(connection: &mut ConnectionProfile) -> Result<(), AppError> {
    // 规范化必须在后端完成，避免 CLI、MCP 或手工 IPC 绕过前端后把 RDP 与 SSH 专属字段混存。
    match connection.protocol.trim().to_ascii_lowercase().as_str() {
        "ssh" => {
            connection.protocol = "ssh".into();
        }
        "rdp" => {
            connection.protocol = "rdp".into();
            connection.auth_method = "password".into();
            connection.private_key_path = None;
            connection.private_key_text = None;
            connection.passphrase = None;
            connection.jump_hosts.clear();
            connection.proxy = SshProxyConfig::default();
        }
        value => {
            return Err(AppError::Validation(format!(
                "unsupported connection protocol: {value}"
            )))
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

// 直连客户端：忽略系统代理。代理节点的数据中心 IP 常被 GitHub API 风控（403），
// 更新请求在代理失败时回退直连重试，避免把代理服务器的拒绝误报成 GitHub 限流。
fn build_direct_http_client(total_timeout: Duration) -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .no_proxy()
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
            cols: None,
            rows: None,
            content: String::new(),
        });
    }
    // 状态变化同样定向唤醒对应会话，避免多会话时每次事件都扫全部输出队列。
    let _ = app_handle.emit("terminal-output-ready", session_id);
}

/// PTY 尺寸只有在后端初建或 resize 真正成功后才进入同一输出队列，确保前端按严格时序重放原始控制流。
fn queue_terminal_size(
    queue: &Arc<std::sync::Mutex<TerminalOutputQueue>>,
    app_handle: &tauri::AppHandle,
    session_id: &str,
    cols: u16,
    rows: u16,
) {
    if let Ok(mut output) = queue.lock() {
        output.push_meta(TerminalOutputChunk {
            session_id: session_id.to_string(),
            cwd: None,
            status: None,
            cols: Some(cols),
            rows: Some(rows),
            content: String::new(),
        });
    }
    // 尺寸变化本身没有可见文本，也必须唤醒前端拉取，否则后台会话的下一段输出可能先绑定到旧尺寸。
    let _ = app_handle.emit("terminal-output-ready", session_id);
}

/// 把一条 AI 文件活动播报到该连接对应的终端标签里。
/// 文件类操作走 SFTP 不经过 PTY，用户在终端里看不到任何痕迹；
/// 这里补一行带浅粉色来源标记的提示，保证"AI 做了什么"始终可见。
pub(crate) fn announce_agent_activity(
    state: &AppState,
    app_handle: &tauri::AppHandle,
    connection_id: &str,
    text: &str,
) {
    // 找该连接下最近出现过提示符的标签；没有就不播报，不为了提示而强行开标签。
    let target = {
        let Ok(sessions) = lock_sessions(state) else {
            return;
        };
        sessions
            .values()
            .filter(|runtime| {
                runtime.session.kind == "ssh" && runtime.session.connection_id == connection_id
            })
            .filter_map(|runtime| {
                let pty = runtime.agent_pty.lock().ok()?;
                Some((pty.last_prompt_at, runtime.session.id.clone()))
            })
            .max_by_key(|(last_prompt_at, _)| *last_prompt_at)
            .map(|(_, id)| id)
    };
    let Some(terminal_session_id) = target else {
        return;
    };

    // 文件操作没有远端 Shell 回显，需要保留活动正文；超长内容截断，避免提示行刷满终端。
    let preview: String = text.chars().take(160).collect();
    let ellipsis = if text.chars().count() > 160 { "…" } else { "" };
    queue_agent_terminal_notice(
        state,
        app_handle,
        &terminal_session_id,
        format!(
            "\r\n{AGENT_COMMAND_ACCENT_SEQUENCE}[AI]{TERMINAL_STYLE_RESET_SEQUENCE} {preview}{ellipsis}\r\n"
        ),
    );
}

/// 以整行浅粉色展示 AI 实际执行的完整包装代码；远端 PTY 的机械回显由 ShellOutputFilter 隐藏，
/// 避免同一段代码重复出现，同时保证终端展示与真实执行内容完全一致。
pub(crate) fn announce_agent_command(
    state: &AppState,
    app_handle: &tauri::AppHandle,
    terminal_session_id: &str,
    command: &str,
) {
    queue_agent_terminal_notice(
        state,
        app_handle,
        terminal_session_id,
        format!(
            "\r\n{AGENT_COMMAND_ACCENT_SEQUENCE}[AI] {command}{TERMINAL_STYLE_RESET_SEQUENCE}\r\n"
        ),
    );
}

/// 向指定终端写入 AI 可见提示，并与随后到达的 PTY 输出共用同一条有序队列。
fn queue_agent_terminal_notice(
    state: &AppState,
    app_handle: &tauri::AppHandle,
    terminal_session_id: &str,
    content: String,
) {
    let Ok(sessions) = lock_sessions(state) else {
        return;
    };
    let Some(runtime) = sessions.get(terminal_session_id) else {
        return;
    };
    let output_queue = Arc::clone(&runtime.output_queue);
    drop(sessions);

    queue_output(&output_queue, app_handle, terminal_session_id, content);
}

/// 跟踪用户按键对当前输入行的影响：普通回车结束该行，奇数个行尾反斜杠后的回车仍属于同一条 Shell 续行。
/// agent 只在当前逻辑行干净且用户静默一段时间后才注入，避免在 PS2 等待态把命令拼到用户输入后面。
fn track_user_input_activity(
    agent_pty: &Arc<std::sync::Mutex<AgentPtyState>>,
    agent_pty_signal: &Arc<Condvar>,
    data: &[u8],
) {
    if data.is_empty() {
        return;
    }

    let Ok(mut pty) = agent_pty.lock() else {
        return;
    };

    pty.last_user_input_at = Some(Instant::now());
    for byte in data {
        match byte {
            b'\r' | b'\n' => {
                // Shell 只把奇数个行尾反斜杠中的最后一个用于续行；偶数个表示反斜杠自身已被转义。
                pty.user_line_dirty = pty.user_line_trailing_backslashes % 2 == 1;
                pty.user_line_trailing_backslashes = 0;
            }
            // Ctrl+C / Ctrl+U 明确放弃当前逻辑行。
            0x03 | 0x15 => {
                pty.user_line_dirty = false;
                pty.user_line_trailing_backslashes = 0;
            }
            // 退格至少可以精确撤销行尾反斜杠；其它位置仍保守保持 dirty，等待真实提示符复位。
            0x7f | 0x08 => {
                pty.user_line_trailing_backslashes =
                    pty.user_line_trailing_backslashes.saturating_sub(1);
            }
            b'\\' => {
                pty.user_line_dirty = true;
                pty.user_line_trailing_backslashes += 1;
            }
            // 其余可见字符与控制序列都可能在行内留下内容，同时终止“行尾连续反斜杠”计数。
            _ => {
                pty.user_line_dirty = true;
                pty.user_line_trailing_backslashes = 0;
            }
        }
    }

    drop(pty);
    agent_pty_signal.notify_all();
}

/// 把 shell 线程解析出的命令边界事件与提示符/TUI 状态同步到共享占用状态，并唤醒等待的命令层。
/// 只在这里写入 AgentPtyState，保证状态机的推进点唯一、易于推理。
fn publish_agent_pty_progress(
    agent_pty: &Arc<std::sync::Mutex<AgentPtyState>>,
    agent_pty_signal: &Arc<Condvar>,
    events: Vec<ShellCommandEvent>,
    alternate_screen_active: bool,
    prompt_arrived: bool,
    command_started: bool,
) {
    let Ok(mut pty) = agent_pty.lock() else {
        return;
    };

    pty.alternate_screen_active = alternate_screen_active;
    // 命令开始执行说明 shell 已离开提示符；用户跑 tail -f 这类长命令时会长期停在这个状态。
    if command_started {
        pty.at_prompt = false;
    }
    // 只在提示符标记真正到达的那一批复位：用户输入的回显同样发生在提示符状态下，
    // 若按“当前停在提示符”复位，用户敲到一半的命令会被误判成已提交，导致注入与其拼接。
    if prompt_arrived {
        pty.last_prompt_at = Some(Instant::now());
        pty.at_prompt = true;
        pty.user_line_dirty = false;
        pty.user_line_trailing_backslashes = 0;
    }

    for event in events {
        match event {
            ShellCommandEvent::Capable => {
                pty.command_boundary_ready = true;
            }
            ShellCommandEvent::Begin => {
                if pty.phase == AgentPtyPhase::AwaitingBegin {
                    pty.phase = AgentPtyPhase::Running;
                }
            }
            ShellCommandEvent::End {
                exit_code,
                captured,
                truncated,
            } => {
                if let Some(run) = pty.active.as_mut() {
                    run.exit_code = exit_code;
                    run.captured = captured;
                    run.truncated = truncated;
                    run.finished = true;
                }
                pty.phase = AgentPtyPhase::Idle;
            }
        }
    }

    drop(pty);
    agent_pty_signal.notify_all();
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
            cols: None,
            rows: None,
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
        // 命令边界协议：begin 由 bash PS0 / zsh preexec 在命令执行前发出，end 由提示符钩子带上一条命令的 exit code。
        // 两者之间的可见输出即该条命令的产物，agent 可见执行据此精确截取 stdout 与退出码。
        "__myterminal_sync_cmd_begin(){ printf '\\033]6973;MyTerminalCmdBegin=\\a'; }",
        "__myterminal_sync_cmd_end(){ printf '\\033]6973;MyTerminalCmdEnd=%s\\a' \"$1\"; }",
        // 能力标记只在 PS0/preexec 真正安装成功后发出；收不到它的会话一律回退隐藏 exec 通道。
        "__myterminal_report_cmd_capable(){ printf '\\033]6973;MyTerminalCmdCapable=1\\a'; }",
        "__myterminal_sync_history(){ if [ -n \"${ZSH_VERSION-}\" ]; then fc -AI 2>/dev/null || true; elif [ -n \"${BASH_VERSION-}\" ]; then history -a 2>/dev/null || true; fi; }",
        "__myterminal_clean_history(){ if [ -n \"${BASH_VERSION-}\" ]; then for __myterminal_history_id in $(history | sed -n '/__myterminal_sync_cwd/{s/^ *\\([0-9][0-9]*\\).*/\\1/p}' | sort -rn); do history -d \"$__myterminal_history_id\" 2>/dev/null || true; done; unset __myterminal_history_id; fi; }",
        "__myterminal_is_interactive(){ case $- in *i*) return 0;; *) return 1;; esac; }",
        "__myterminal_install_cwd_wrappers(){ if [ -n \"${BASH_VERSION-}${ZSH_VERSION-}\" ]; then cd(){ builtin cd \"$@\"; __myterminal_status=$?; __myterminal_is_interactive && __myterminal_sync_cwd; return $__myterminal_status; }; pushd(){ builtin pushd \"$@\"; __myterminal_status=$?; __myterminal_is_interactive && __myterminal_sync_cwd; return $__myterminal_status; }; popd(){ builtin popd \"$@\"; __myterminal_status=$?; __myterminal_is_interactive && __myterminal_sync_cwd; return $__myterminal_status; }; fi; }",
        // 退出码必须在函数体第一行捕获；bash dispatcher 会把真实状态作为 $1 显式传入，
        // 因为它在调用本函数前已经跑过用户原有的 PROMPT_COMMAND，此时 $? 已被覆盖。
        "__myterminal_sync_prompt(){ __myterminal_prompt_exit_status=$?; if [ -n \"${1-}\" ]; then __myterminal_prompt_exit_status=\"$1\"; fi; __myterminal_install_cwd_wrappers; __myterminal_sync_history; __myterminal_sync_cmd_end \"$__myterminal_prompt_exit_status\"; __myterminal_sync_prompt_boundary; }",
        // 让本会话命令在 history 文件中带真实执行时间戳：bash 只在命令入历史时 HISTTIMEFORMAT 非空才记录时间，故须会话级 export；zsh 须开启 EXTENDED_HISTORY。仅作用于当前 shell 进程，不写入用户配置文件，会话结束即失效。
        "if [ -n \"${BASH_VERSION-}\" ]; then export HISTTIMEFORMAT=\"%F %T \"; elif [ -n \"${ZSH_VERSION-}\" ]; then setopt EXTENDED_HISTORY 2>/dev/null || true; fi",
        "__myterminal_install_cwd_wrappers",
        // 命令开始钩子按 shell 分别安装：zsh 用 preexec，bash 用 PS0（4.4+ 才有，展开时机为命令读取后、执行前）。
        // 两者都安装成功才上报能力标记；bash 4.3 及以下、dash/ash/fish 收不到该标记，agent 自动回退隐藏通道。
        "if [ -n \"${ZSH_VERSION-}\" ]; then autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook preexec __myterminal_sync_cmd_begin 2>/dev/null && __myterminal_report_cmd_capable",
        "elif [ -n \"${BASH_VERSION-}\" ]; then case \"${BASH_VERSINFO[0]-0}.${BASH_VERSINFO[1]-0}\" in 4.[4-9]|4.[1-9][0-9]|[5-9].*|[1-9][0-9]*.*) PS0='$(__myterminal_sync_cmd_begin)'\"${PS0-}\"; export PS0; __myterminal_report_cmd_capable;; esac",
        "fi",
        "if [ -n \"${ZSH_VERSION-}\" ]; then autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd __myterminal_sync_prompt 2>/dev/null || PS1='$(__myterminal_sync_prompt)'\"$PS1\"",
        "elif [ -n \"${BASH_VERSION-}\" ]; then eval '__myterminal_sync_prompt_dispatch(){ local __myterminal_prompt_status=$? __myterminal_prompt_command; for __myterminal_prompt_command in \"${__myterminal_original_prompt_commands[@]-}\"; do [ -n \"$__myterminal_prompt_command\" ] || continue; if [ \"$__myterminal_prompt_status\" -eq 0 ]; then eval \"$__myterminal_prompt_command\"; else (exit \"$__myterminal_prompt_status\") || eval \"$__myterminal_prompt_command\"; fi; done; __myterminal_sync_prompt \"$__myterminal_prompt_status\"; return 0; }'; if declare -p PROMPT_COMMAND 2>/dev/null | grep -q '^declare -[^ ]*a[^ ]* '; then eval '__myterminal_original_prompt_commands=(\"${PROMPT_COMMAND[@]}\")'; elif [ -n \"${PROMPT_COMMAND-}\" ] && [ \"$PROMPT_COMMAND\" != \"__myterminal_sync_prompt_dispatch\" ]; then eval '__myterminal_original_prompt_commands=(\"$PROMPT_COMMAND\")'; else eval '__myterminal_original_prompt_commands=()'; fi; unset PROMPT_COMMAND; PROMPT_COMMAND=__myterminal_sync_prompt_dispatch; export PROMPT_COMMAND; export -f __myterminal_sync_cwd __myterminal_sync_prompt_boundary __myterminal_sync_cmd_begin __myterminal_sync_cmd_end __myterminal_report_cmd_capable __myterminal_sync_history __myterminal_is_interactive __myterminal_install_cwd_wrappers __myterminal_sync_prompt __myterminal_sync_prompt_dispatch cd pushd popd 2>/dev/null || true",
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

// libssh2 的 Session(-13) 表示 TCP 已连接但尚未收到合法 SSH banner；此阶段还没有进入密钥交换或认证。
fn is_ssh_banner_error(error: &AppError) -> bool {
    let AppError::Ssh(message) = error else {
        return false;
    };

    let normalized = message.to_ascii_lowercase();
    normalized.contains("failed getting banner") || normalized.contains("session(-13)")
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
    // SSH 辅助连接与 RDP 端口测试共享固定连接超时，避免不可达地址拖住 UI 刷新和测试连接。
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
    session.handshake().map_err(|error| {
        // 握手失败要保留当前阶段标签；多级跳板时仅显示最终目标会掩盖实际失败的那一跳。
        AppError::Ssh(format!("SSH handshake failed for {auth_host_label}: {error}"))
    })?;
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

// 默认算法与兼容算法的选择集中在一个连接尝试内；banner 重试必须重建 TCP/代理/跳板整条链路，不能复用已污染 Session。
fn connect_ssh_with_compatibility(
    connection: &ConnectionProfile,
) -> Result<Session, AppError> {
    match connect_ssh_once(connection, false) {
        Ok(session) => Ok(session),
        Err(error) if is_key_exchange_error(&error) => connect_ssh_once(connection, true),
        Err(error) => Err(error),
    }
}

// banner 诊断只包含定位所需的主机、端口与路由类型，不输出密码、密钥、代理账号等认证材料。
fn ssh_banner_failure_with_context(
    connection: &ConnectionProfile,
    error: &AppError,
) -> AppError {
    let reason = match error {
        AppError::Ssh(message) => message.as_str(),
        _ => return AppError::Ssh(error.to_string()),
    };
    let route = if connection.jump_hosts.is_empty() {
        if connection.proxy.enabled {
            "proxy route".to_string()
        } else {
            "direct route".to_string()
        }
    } else {
        format!("{} jump host(s)", connection.jump_hosts.len())
    };

    AppError::Ssh(format!(
        "SSH banner handshake failed for {}:{} via {} after one retry: {}. TCP connected, but the peer did not provide a valid SSH banner; verify the SSH service/port and server connection limits",
        connection.host.trim(),
        connection.port,
        route,
        reason
    ))
}

pub(crate) fn connect_ssh(connection: &ConnectionProfile) -> Result<Session, AppError> {
    // 所有 SSH 入口（界面、AI、文件和隧道）最终都会经过这里，防止 RDP 配置被误当作 SSH 发起握手。
    if !connection.protocol.trim().eq_ignore_ascii_case("ssh") {
        return Err(AppError::Validation(
            "this connection is not an SSH connection".into(),
        ));
    }
    validate_connection_profile(connection)?;
    match connect_ssh_with_compatibility(connection) {
        Ok(session) => Ok(session),
        Err(error) if is_ssh_banner_error(&error) => {
            thread::sleep(SSH_BANNER_RETRY_DELAY);
            match connect_ssh_with_compatibility(connection) {
                Ok(session) => Ok(session),
                Err(retry_error) if is_ssh_banner_error(&retry_error) => {
                    Err(ssh_banner_failure_with_context(connection, &retry_error))
                }
                Err(retry_error) => Err(retry_error),
            }
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod ssh_banner_error_tests {
    use super::*;

    #[test]
    fn recognizes_libssh2_banner_receive_errors_only() {
        assert!(is_ssh_banner_error(&AppError::Ssh(
            "[Session(-13)] Failed getting banner".into()
        )));
        assert!(!is_ssh_banner_error(&AppError::Ssh(
            "[Session(-8)] Unable to exchange encryption keys".into()
        )));
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
    // agent 可见执行占用状态；shell 线程是其唯一写入方。
    agent_pty: Arc<Mutex<AgentPtyState>>,
    agent_pty_signal: Arc<Condvar>,
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

        // 初始尺寸必须排在连接状态和首批 Shell 输出之前，缓存重放才能用创建 PTY 时的真实 120x32 解析启动内容。
        queue_terminal_size(&output_queue, &app_handle, &session_id, cols, rows);
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
                        // 只跟踪用户按键：据此判断当前行是否有未提交内容、用户是否正在输入。
                        track_user_input_activity(&agent_pty, &agent_pty_signal, data.as_bytes());
                        pending_input.extend_from_slice(data.as_bytes());
                    }
                    Ok(SessionControl::AgentInput(data)) => {
                        handled_control_event = true;
                        // agent 自己注入的命令不更新用户活跃度，否则下一条命令会白等一个静默窗口。
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
                    Ok(SessionControl::SetAgentCapture(armed)) => {
                        handled_control_event = true;
                        // 武装标志必须在 shell 线程内设置，才能保证与后续写入的命令严格有序。
                        output_filter.set_capture_armed(armed);
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
                        let parsed = output_filter.consume(&content);
                        if !parsed.visible.is_empty() {
                            queue_output(&output_queue, &app_handle, &session_id, parsed.visible);
                        }
                        for cwd in parsed.cwd_updates {
                            queue_cwd(&output_queue, &app_handle, &session_id, cwd);
                        }
                        // 命令边界事件与提示符/TUI 状态一起同步给命令层，驱动 agent 可见执行。
                        publish_agent_pty_progress(
                            &agent_pty,
                            &agent_pty_signal,
                            parsed.command_events,
                            output_filter.alternate_screen_active,
                            parsed.prompt_arrived,
                            parsed.command_started,
                        );
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
                            // 只在 libssh2 确认 resize 生效后入队；之前已读取的输出仍属于旧尺寸，时序不能提前。
                            queue_terminal_size(
                                &output_queue,
                                &app_handle,
                                &session_id,
                                cols,
                                rows,
                            );
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
                    track_user_input_activity(&agent_pty, &agent_pty_signal, data.as_bytes());
                    pending_input.extend_from_slice(data.as_bytes());
                }
                Ok(SessionControl::AgentInput(data)) => {
                    pending_input.extend_from_slice(data.as_bytes());
                }
                Ok(SessionControl::Resize { cols, rows }) => {
                    pending_resize = Some((cols, rows));
                }
                Ok(SessionControl::SetAgentCapture(armed)) => {
                    output_filter.set_capture_armed(armed);
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

        // 本地 PTY 同样先登记初始几何，避免启动输出在首次前端 resize 前被按当前窗口宽度错误重放。
        queue_terminal_size(&output_queue, &app_handle, &session_id, cols, rows);

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
                    // 只有 resize 成功才推进尺寸时间线；失败时后续输出仍必须按旧几何解释。
                    if pair
                        .master
                        .resize(PtySize {
                            rows,
                            cols,
                            pixel_width: 0,
                            pixel_height: 0,
                        })
                        .is_ok()
                    {
                        queue_terminal_size(
                            &output_queue,
                            &app_handle,
                            &session_id,
                            cols,
                            rows,
                        );
                    }
                }
                // 本地终端不承载 agent 可见执行，捕获武装与注入指令直接忽略。
                Ok(SessionControl::SetAgentCapture(_)) => {}
                Ok(SessionControl::AgentInput(_)) => {}
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

pub(super) fn stop_all_runtimes(state: &AppState) -> Result<(), AppError> {
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

/// 读取全部 AI 端点配置；API Key 明文下发（与 WebDAV 密码同一策略），前端可切换显示。
#[tauri::command]
pub fn list_agent_providers(state: State<'_, AppState>) -> Result<Vec<AgentProvider>, String> {
    Ok(state.storage.load_agent_providers(&state.crypto)?)
}

/// 保存 AI 端点配置。前端持有明文 Key（与 WebDAV 密码同一策略），可查看、修改或清空，
/// 因此以前端提交的值为准整体落盘；hasApiKey 标记按 Key 是否为空重新归一。
#[tauri::command]
pub fn save_agent_providers(
    state: State<'_, AppState>,
    providers: Vec<AgentProvider>,
) -> Result<Vec<AgentProvider>, String> {
    let normalized: Vec<AgentProvider> = providers
        .into_iter()
        .map(|mut provider| {
            provider.has_api_key = !provider.api_key.is_empty();
            provider
        })
        .collect();
    state
        .storage
        .save_agent_providers(&normalized, &state.crypto)?;
    Ok(normalized)
}

/// 读取全部 AI 对话历史，按更新时间倒序。
#[tauri::command]
pub fn list_agent_conversations(
    state: State<'_, AppState>,
) -> Result<Vec<AgentConversation>, String> {
    Ok(state.storage.load_agent_conversations()?)
}

/// 保存或更新一条对话。前端在每轮结束、以及切换/关闭对话时调用。
#[tauri::command]
pub fn save_agent_conversation(
    state: State<'_, AppState>,
    conversation: AgentConversation,
) -> Result<bool, String> {
    let mut list = state.storage.load_agent_conversations()?;
    match list.iter_mut().find(|item| item.id == conversation.id) {
        Some(existing) => *existing = conversation,
        None => list.push(conversation),
    }
    state.storage.save_agent_conversations(&list)?;
    Ok(true)
}

/// 删除一条对话。
#[tauri::command]
pub fn delete_agent_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<bool, String> {
    let list: Vec<AgentConversation> = state
        .storage
        .load_agent_conversations()?
        .into_iter()
        .filter(|item| item.id != conversation_id)
        .collect();
    state.storage.save_agent_conversations(&list)?;
    Ok(true)
}

/// 发起一轮内置 Agent 对话。工具执行、模型调用与 SSE 解析都在后台线程完成，
/// 增量通过 agent-chat-event 事件推给前端，命令本身立即返回。
#[tauri::command]
pub fn start_agent_chat(
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
    conversation_id: String,
    provider_id: String,
    model_id: String,
    history: Vec<agent_chat::ChatMessage>,
    options: Option<AgentRunOptions>,
) -> Result<bool, String> {
    let provider = state
        .storage
        .load_agent_providers(&state.crypto)?
        .into_iter()
        .find(|item| item.id == provider_id)
        .ok_or_else(|| AppError::NotFound(format!("agent provider {provider_id} not found")))?;
    if provider.api_key.trim().is_empty() {
        return Err(AppError::Validation("该端点尚未配置 API Key".into()).into());
    }

    let run_options = options.unwrap_or_default();
    let cancel_flag = state.agent_chat.register(&conversation_id);
    thread::spawn(move || {
        let app_state = app_handle.state::<AppState>();
        let settings = match app_state.storage.load_settings(&app_state.crypto) {
            Ok(settings) => settings,
            Err(error) => {
                emit_agent_chat_failure(&app_handle, &conversation_id, &error.to_string());
                app_state.agent_chat.finish(&conversation_id);
                return;
            }
        };

        let tools = agent_tools::build_tools();
        let mut messages = history;
        // 工具执行闭包复用 Bridge 的审批闸门，内置 Agent 与外部 MCP 授权策略完全一致。
        let execute = |call: &agent_chat::ChatToolCall| {
            agent_tools::execute_tool(
                &app_state.agent_bridge,
                &app_state.storage,
                &app_state.crypto,
                &settings.agent_bridge,
                &conversation_id,
                call,
            )
        };

        let outcome = agent_chat::run_chat_turn(
            &app_handle,
            &provider,
            &model_id,
            &conversation_id,
            &agent_tools::system_prompt(),
            &mut messages,
            &tools,
            &run_options,
            &cancel_flag,
            execute,
        );
        if let Err(error) = outcome {
            emit_agent_chat_failure(&app_handle, &conversation_id, &error.to_string());
        }
        app_state.agent_chat.finish(&conversation_id);
    });

    Ok(true)
}

/// 取消一轮进行中的对话；模型流与工具循环会在下一个安全点停止。
#[tauri::command]
pub fn cancel_agent_chat(state: State<'_, AppState>, conversation_id: String) -> Result<bool, String> {
    Ok(state.agent_chat.cancel(&conversation_id))
}

fn emit_agent_chat_failure(app_handle: &tauri::AppHandle, conversation_id: &str, message: &str) {
    let _ = app_handle.emit(
        agent_chat::AGENT_CHAT_EVENT,
        agent_chat::AgentChatEvent::Failed {
            conversation_id: conversation_id.to_string(),
            message: message.to_string(),
        },
    );
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
pub fn test_connection(mut connection: ConnectionProfile) -> Result<bool, String> {
    normalize_connection_protocol_fields(&mut connection)?;
    validate_connection_profile(&connection)?;
    if connection.protocol.trim().eq_ignore_ascii_case("rdp") {
        // RDP 没有轻量的账号认证探测接口；测试只确认 TCP 服务可达，真实凭据由 mstsc 完成认证。
        let stream = connect_tcp_direct(&connection.host, connection.port)?;
        let _ = stream.shutdown(Shutdown::Both);
        return Ok(true);
    }
    let _ = connect_ssh(&connection)?;
    Ok(true)
}

#[cfg(windows)]
fn rdp_client_address(connection: &ConnectionProfile) -> String {
    // 默认 3389 不写端口，确保 Windows 凭据目标使用系统最常见的 TERMSRV/host 形式；自定义端口保持显式。
    if connection.port == 3389 {
        let host = connection.host.trim();
        if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host.to_string()
        }
    } else {
        format_tcp_endpoint(&connection.host, connection.port)
    }
}

#[cfg(windows)]
fn write_rdp_session_credential(
    address: &str,
    username: &str,
    password: &str,
) -> Result<(), AppError> {
    use windows::{
        core::PWSTR,
        Win32::Security::Credentials::{
            CredWriteW, CREDENTIALW, CRED_PERSIST_SESSION, CRED_TYPE_GENERIC,
        },
    };

    // 直接调用 Windows Credential API，密码不会像 cmdkey.exe 那样短暂暴露在进程命令行中。
    let mut target = format!("TERMSRV/{address}")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut user = username
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut password_blob = password.encode_utf16().collect::<Vec<_>>();
    let password_blob_size = u32::try_from(password_blob.len().saturating_mul(2))
        .map_err(|_| AppError::Validation("RDP password is too long".into()))?;

    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target.as_mut_ptr()),
        CredentialBlobSize: password_blob_size,
        CredentialBlob: password_blob.as_mut_ptr().cast::<u8>(),
        // 仅保留到当前 Windows 登录会话结束，长期凭据仍只由 MyTerminal 的加密配置持有。
        Persist: CRED_PERSIST_SESSION,
        UserName: PWSTR(user.as_mut_ptr()),
        ..Default::default()
    };

    unsafe { CredWriteW(&credential, 0) }.map_err(|error| {
        AppError::Io(std::io::Error::other(format!(
            "failed to prepare Windows Remote Desktop credential: {error}"
        )))
    })
}

#[cfg(test)]
mod rdp_connection_tests {
    use super::*;

    fn rdp_connection(host: &str, port: u16) -> ConnectionProfile {
        serde_json::from_value(serde_json::json!({
            "id": "rdp-test",
            "protocol": "rdp",
            "name": "Windows Test",
            "host": host,
            "port": port,
            "username": "Administrator",
            "authMethod": "privateKey",
            "password": "secret",
            "privateKeyPath": "C:/should-not-remain",
            "jumpHosts": [{
                "id": "jump",
                "host": "10.0.0.1",
                "username": "root",
                "password": "jump-secret"
            }],
            "proxy": {
                "enabled": true,
                "type": "socks5",
                "host": "127.0.0.1",
                "port": 1080
            }
        }))
        .expect("RDP test profile should deserialize")
    }

    #[test]
    fn rdp_normalization_removes_ssh_only_fields() {
        let mut connection = rdp_connection("192.168.1.20", 3389);
        normalize_connection_protocol_fields(&mut connection)
            .expect("RDP connection should normalize");

        assert_eq!(connection.auth_method, "password");
        assert!(connection.private_key_path.is_none());
        assert!(connection.jump_hosts.is_empty());
        assert!(!connection.proxy.enabled);
        validate_connection_profile(&connection)
            .expect("normalized RDP connection should validate");
    }

    #[cfg(windows)]
    #[test]
    fn rdp_address_handles_default_port_custom_port_and_ipv6() {
        assert_eq!(
            rdp_client_address(&rdp_connection("server.local", 3389)),
            "server.local"
        );
        assert_eq!(
            rdp_client_address(&rdp_connection("server.local", 3390)),
            "server.local:3390"
        );
        assert_eq!(rdp_client_address(&rdp_connection("::1", 3389)), "[::1]");
        assert_eq!(rdp_client_address(&rdp_connection("::1", 3390)), "[::1]:3390");
    }
}

#[tauri::command]
pub fn open_rdp_connection(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<bool, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    validate_connection_profile(&connection)?;
    if !connection.protocol.trim().eq_ignore_ascii_case("rdp") {
        return Err(AppError::Validation(
            "this connection is not a Windows Remote Desktop connection".into(),
        )
        .into());
    }

    #[cfg(windows)]
    {
        let address = rdp_client_address(&connection);
        write_rdp_session_credential(&address, &connection.username, &connection.password)?;
        // mstsc 使用独立原生窗口；只传目标地址，账号密码通过当前登录会话的凭据存储读取。
        Command::new("mstsc.exe")
            .arg(format!("/v:{address}"))
            .creation_flags(WINDOWS_CREATE_NO_WINDOW)
            .spawn()
            .map_err(AppError::from)?;
        Ok(true)
    }

    #[cfg(not(windows))]
    {
        Err(AppError::Validation(
            "Windows Remote Desktop connections can only be opened on Windows".into(),
        )
        .into())
    }
}

#[tauri::command]
pub fn create_connection(
    state: State<'_, AppState>,
    mut connection: ConnectionProfile,
) -> Result<ConnectionProfile, String> {
    normalize_connection_protocol_fields(&mut connection)?;
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

// 连接明细只在连接数行展开后由前端按需调用，复用辅助会话读取网络表，不占用主终端会话。
#[tauri::command(async)]
pub fn fetch_runtime_connection_list(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<RuntimeConnectionList, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    Ok(query_runtime_connection_list_cached(&state, &connection)?)
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

// 请求 GitHub 最新 Release 元数据；use_system_proxy 决定是否读取 Windows 系统代理。
// 网络错误（代理不可达等）与 403（代理节点被风控）均由调用方决定是否回退直连重试。
async fn fetch_latest_release(use_system_proxy: bool) -> Result<reqwest::Response, String> {
    let client = if use_system_proxy {
        build_update_http_client(UPDATE_HTTP_READ_TIMEOUT)?
    } else {
        build_direct_http_client(UPDATE_HTTP_READ_TIMEOUT)?
    };
    // GitHub API 要求明确 User-Agent；这里仅读取最新 Release 元数据，并挑出后续可安装的 Windows 安装包。
    // 错误统一以 "update_error:{code}:{params}" 返回，由前端按界面语言翻译成完整文案，避免中英混杂。
    client
        .get("https://api.github.com/repos/CrazyFigure/MyTerminal/releases/latest")
        .header(reqwest::header::USER_AGENT, "MyTerminal")
        .send()
        .await
        .map_err(|err| format!("update_error:network:{err}"))
}

#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateCheckResult, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    // 更新提示返回给前端的 Release 页面地址，必须和 GitHub 仓库名保持一致。
    let release_url = "https://github.com/CrazyFigure/MyTerminal/releases/latest".to_string();

    // 首次请求走系统代理（用户代理软件常见）；代理节点 IP 常被 GitHub API 风控返回 403，
    // 或代理不可达导致网络错误，两种情况都回退直连重试一次，避免误报限流或网络故障。
    let mut response = match fetch_latest_release(true).await {
        Ok(response) => response,
        Err(_) => fetch_latest_release(false).await?,
    };
    if response.status() == reqwest::StatusCode::FORBIDDEN {
        response = fetch_latest_release(false).await?;
    }

    // 403 需区分两种情况：响应头 X-RateLimit-Remaining 为 0 才确认是 API 配额耗尽；
    // 否则（或该头缺失）多为代理或安全策略拦截，不应误报成限流。
    // 错误统一以 "update_error:{code}:{params}" 返回，由前端按界面语言翻译成完整文案。
    if response.status() == reqwest::StatusCode::FORBIDDEN {
        let rate_limited = response
            .headers()
            .get("x-ratelimit-remaining")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u32>().ok())
            == Some(0);
        if rate_limited {
            // 配额确认耗尽：附上配额重置时间戳（Unix 秒），由前端按当前语言格式化为可读时间。
            let reset_ts = response
                .headers()
                .get("x-ratelimit-reset")
                .and_then(|value| value.to_str().ok())
                .filter(|value| value.parse::<i64>().is_ok())
                .unwrap_or_default();
            return Err(if reset_ts.is_empty() {
                "update_error:rate_limited".to_string()
            } else {
                format!("update_error:rate_limited:{reset_ts}")
            });
        }
        return Err("update_error:forbidden".to_string());
    }

    let release = response
        .error_for_status()
        .map_err(|err| format!("update_error:http_status:{err}"))?
        .json::<GitHubReleaseResponse>()
        .await
        .map_err(|err| format!("update_error:parse:{err}"))?;

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

    // 安装包下载使用 GitHub Release 浏览器下载地址；完成写入后立即启动安装程序，交互式确认交给安装器自身处理。
    // 首次走系统代理，若被代理节点风控返回 403，回退直连重试一次（与检测更新的策略保持一致）。
    let client = build_update_http_client(UPDATE_INSTALLER_DOWNLOAD_TIMEOUT)?;
    if let Err(error) = download_update_installer(
        &app_handle,
        &client,
        normalized_url,
        &installer_path,
        installer_size,
    )
    .await
    {
        if error.to_string().contains("403") {
            let direct_client = build_direct_http_client(UPDATE_INSTALLER_DOWNLOAD_TIMEOUT)?;
            download_update_installer(
                &app_handle,
                &direct_client,
                normalized_url,
                &installer_path,
                installer_size,
            )
            .await?;
        } else {
            return Err(error.to_string());
        }
    }
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

// 本地配置与 WebDAV 同步独立成业务模块；命令名保持不变，仅调整 Rust 内部注册路径。
pub mod config_sync;

// Shell 输出协议作为领域对象独立维护；命令层只负责编排 PTY、队列和事件。
mod shell_output;
use shell_output::{
    ShellCommandEvent, ShellOutputFilter, AGENT_COMMAND_ACCENT_SEQUENCE,
    TERMINAL_STYLE_RESET_SEQUENCE,
};

// 远程访问适配器封装 SFTP、历史与运行指标采集；命令层只调用公开用例入口。
mod remote_access;
use remote_access::{
    normalize_remote_path,
    stat_is_dir,
    stat_is_symlink,
    load_remote_identity_maps,
    read_remote_file_bytes,
    write_remote_file_bytes,
    list_remote_entries_cached,
    query_runtime_overview_cached,
    query_runtime_resource_usage_cached,
    query_runtime_storage_files_cached,
    query_runtime_connection_list_cached,
    read_remote_shell_history_entries_cached,
    upload_remote_file_with_cache,
    upload_local_paths_with_cache,
    download_remote_file_with_cache,
    download_remote_paths_with_cache,
    delete_remote_path_with_cache,
    delete_remote_paths_with_cache,
    rename_remote_path_with_cache,
    copy_remote_paths_with_cache,
};
