use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{ErrorKind, Read, Write},
    net::{IpAddr, Shutdown, TcpListener, TcpStream, ToSocketAddrs},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError, TryRecvError},
        Arc, MutexGuard,
    },
    thread,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{TimeZone, Utc};
use portable_pty::{CommandBuilder, PtySize};
use serde::Deserialize;
use ssh2::{Channel, ExtendedData, MethodType, Session, Sftp};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    agent_bridge,
    error::AppError,
    models::{
        AppSettings, BootstrapState, ConnectionProfile, EditorDocument, HistoryEntry,
        HistoryEntryInput, LocalConfigBundle, LocalTerminalProfile, LocalTerminalSettings,
        RemoteFileEntry, RuntimeCpuCore, RuntimeOverview, SshJumpHost, SshProxyConfig,
        TerminalOutputChunk, TerminalSession, TunnelOpenRequest, TunnelRecord,
        TunnelUpdateRequest, UpdateCheckResult, WebDavSettings,
    },
    state::{AppState, AuxiliarySshSession, RuntimeSession, SessionControl, TunnelRuntime},
};

#[derive(Debug, Deserialize)]
struct GitHubReleaseResponse {
    tag_name: String,
    name: Option<String>,
    html_url: String,
    published_at: Option<String>,
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

const SSH_CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
const SSH_IO_TIMEOUT: Duration = Duration::from_secs(20);
// 更新检查和安装包下载要快速失败，避免 GitHub 直连或代理异常时设置页长时间停在处理中。
const UPDATE_HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
// Release 下载通常只有几 MB，读超时用于识别连接已建立但后续没有数据的卡死场景。
const UPDATE_HTTP_READ_TIMEOUT: Duration = Duration::from_secs(15);
// 安装包总下载时长设置为人可接受的上限；超时后让用户检查代理或稍后重试。
const UPDATE_INSTALLER_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(45);
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

#[cfg(windows)]
const DEFAULT_LOCAL_SHELL_CANDIDATES: &[&str] = &[
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    "pwsh.exe",
    "powershell.exe",
];

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

    while let Some(chunk) = response.chunk().await.map_err(AppError::from)? {
        // 下载过程中持续校验大小上界，防止错误地址返回 HTML 或其它大文件时继续写入。
        downloaded_size += chunk.len() as u64;
        if expected_size.is_some_and(|size| downloaded_size > size) {
            return Err(AppError::Validation(
                "downloaded update installer is larger than expected".into(),
            ));
        }
        temp_file.write_all(&chunk).map_err(AppError::from)?;
    }
    temp_file.flush().map_err(AppError::from)?;
    drop(temp_file);

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
    queue: &Arc<std::sync::Mutex<Vec<TerminalOutputChunk>>>,
    app_handle: &tauri::AppHandle,
    session_id: &str,
    content: impl Into<String>,
) {
    if let Ok(mut output) = queue.lock() {
        output.push(TerminalOutputChunk {
            session_id: session_id.to_string(),
            cwd: None,
            status: None,
            content: content.into(),
        });
    }
    // 数据入队后立即通知前端拉取当前会话，替代全局定时轮询，实现低延迟回显。
    let _ = app_handle.emit("terminal-output-ready", session_id);
}

fn queue_session_status(
    queue: &Arc<std::sync::Mutex<Vec<TerminalOutputChunk>>>,
    app_handle: &tauri::AppHandle,
    session_id: &str,
    status: impl Into<String>,
) {
    if let Ok(mut output) = queue.lock() {
        output.push(TerminalOutputChunk {
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

/// 目录同步标记使用 OSC 控制序列，终端可见内容会被后端过滤，仅把 cwd 元数据传给前端。
const CWD_SYNC_MARKER_PREFIX: &str = "\x1b]6973;MyTerminalCwd=";
const CWD_SYNC_MARKER_SUFFIX: char = '\x07';
const CWD_SYNC_SETUP_NAME: &str = "__myterminal_sync_cwd";
const CWD_SYNC_HISTORY_PREP_TOKEN: &str = "HIST_IGNORE_SPACE";
/// 部分命令行工具会在绘制进度时隐藏光标，异常返回 shell 时可能漏发恢复序列；提示符边界需要兜底恢复。
const TERMINAL_CURSOR_HIDE_SEQUENCE: &str = "\x1b[?25l";
const TERMINAL_CURSOR_SHOW_SEQUENCE: &str = "\x1b[?25h";
/// 光标控制序列长度固定为 6 字节，保留前一分片末尾 5 字节即可识别跨 SSH 分片的半截序列。
const TERMINAL_CURSOR_CONTROL_TAIL_BYTES: usize = TERMINAL_CURSOR_HIDE_SEQUENCE.len() - 1;

fn queue_cwd(
    queue: &Arc<std::sync::Mutex<Vec<TerminalOutputChunk>>>,
    app_handle: &tauri::AppHandle,
    session_id: &str,
    cwd: impl Into<String>,
) {
    if let Ok(mut output) = queue.lock() {
        output.push(TerminalOutputChunk {
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
    // 目录同步依赖远端 shell 主动回传 PWD；Bash 子 shell 会继承导出的函数和 PROMPT_COMMAND，避免用户进入 bash 后 cd 不再联动。
    // cd/pushd/popd 包装函数只在交互 shell 中触发同步，避免非交互脚本继承函数后把 OSC 标记写入普通命令输出。
    let setup_command = [
        "__myterminal_sync_cwd(){ printf '\\033]6973;MyTerminalCwd=%s\\a' \"$PWD\"; }",
        "__myterminal_sync_history(){ if [ -n \"${ZSH_VERSION-}\" ]; then fc -AI 2>/dev/null || true; elif [ -n \"${BASH_VERSION-}\" ]; then history -a 2>/dev/null || true; fi; }",
        "__myterminal_clean_history(){ if [ -n \"${BASH_VERSION-}\" ]; then for __myterminal_history_id in $(history | sed -n '/__myterminal_sync_cwd/{s/^ *\\([0-9][0-9]*\\).*/\\1/p}' | sort -rn); do history -d \"$__myterminal_history_id\" 2>/dev/null || true; done; unset __myterminal_history_id; fi; }",
        "__myterminal_is_interactive(){ case $- in *i*) return 0;; *) return 1;; esac; }",
        "__myterminal_install_cwd_wrappers(){ if [ -n \"${BASH_VERSION-}${ZSH_VERSION-}\" ]; then cd(){ builtin cd \"$@\"; __myterminal_status=$?; __myterminal_is_interactive && __myterminal_sync_prompt; return $__myterminal_status; }; pushd(){ builtin pushd \"$@\"; __myterminal_status=$?; __myterminal_is_interactive && __myterminal_sync_prompt; return $__myterminal_status; }; popd(){ builtin popd \"$@\"; __myterminal_status=$?; __myterminal_is_interactive && __myterminal_sync_prompt; return $__myterminal_status; }; fi; }",
        "__myterminal_sync_prompt(){ __myterminal_install_cwd_wrappers; __myterminal_sync_history; __myterminal_sync_cwd; }",
        "__myterminal_install_cwd_wrappers",
        "if [ -n \"${ZSH_VERSION-}\" ]; then autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd __myterminal_sync_prompt 2>/dev/null || PS1='$(__myterminal_sync_prompt)'\"$PS1\"",
        "elif [ -n \"${BASH_VERSION-}\" ]; then PROMPT_COMMAND=\"__myterminal_sync_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}\"; export PROMPT_COMMAND; export -f __myterminal_sync_cwd __myterminal_sync_history __myterminal_is_interactive __myterminal_install_cwd_wrappers __myterminal_sync_prompt cd pushd popd 2>/dev/null || true",
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

/// 记录跨 SSH 分片的半截 OSC 标记，保证 cwd 标记不泄漏到终端输出。
struct ShellOutputFilter {
    pending: String,
    suppress_setup_echo_line: bool,
    suppress_initial_setup_echo: bool,
    cursor_hidden_by_remote_output: bool,
    cursor_control_tail: String,
}

impl Default for ShellOutputFilter {
    fn default() -> Self {
        Self {
            pending: String::new(),
            suppress_setup_echo_line: false,
            suppress_initial_setup_echo: true,
            cursor_hidden_by_remote_output: false,
            cursor_control_tail: String::new(),
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
            if let Some(marker_start) = self.pending.find(CWD_SYNC_MARKER_PREFIX) {
                let before_marker = self.pending[..marker_start].to_string();
                self.push_filtered_visible(&mut visible, &before_marker);
                let value_start = marker_start + CWD_SYNC_MARKER_PREFIX.len();

                if let Some(value_end) = self.pending[value_start..].find(CWD_SYNC_MARKER_SUFFIX) {
                    let cwd = self.pending[value_start..value_start + value_end]
                        .trim()
                        .to_string();
                    if !cwd.is_empty() {
                        cwd_updates.push(cwd);
                    }
                    // 第一次 cwd 标记说明启动注入已执行完毕；之后如果用户历史里出现内部函数名，不能再隐藏 readline 的重绘输出。
                    self.suppress_initial_setup_echo = false;
                    self.restore_cursor_at_prompt_boundary(&mut visible);
                    let remainder_start =
                        value_start + value_end + CWD_SYNC_MARKER_SUFFIX.len_utf8();
                    self.pending = self.pending[remainder_start..].to_string();
                    continue;
                }

                self.pending = self.pending[marker_start..].to_string();
                break;
            }

            let keep = CWD_SYNC_MARKER_PREFIX
                .char_indices()
                .skip(1)
                .filter_map(|(index, _)| {
                    let prefix = &CWD_SYNC_MARKER_PREFIX[..index];
                    self.pending.ends_with(prefix).then_some(prefix.len())
                })
                .max()
                .unwrap_or(0);

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
        visible.push_str(&filtered);
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

    #[test]
    fn restores_cursor_when_prompt_marker_arrives_after_hidden_cursor() {
        let mut filter = ShellOutputFilter::default();
        let input = format!(
            "docker progress{TERMINAL_CURSOR_HIDE_SEQUENCE}{}",
            cwd_marker("/ology/ology-server")
        );

        let (visible, cwd_updates) = filter.consume(&input);

        assert_eq!(cwd_updates, vec!["/ology/ology-server".to_string()]);
        assert_eq!(
            visible,
            format!(
                "docker progress{TERMINAL_CURSOR_HIDE_SEQUENCE}{TERMINAL_CURSOR_SHOW_SEQUENCE}"
            )
        );
    }

    #[test]
    fn does_not_duplicate_remote_cursor_restore_before_prompt_marker() {
        let mut filter = ShellOutputFilter::default();
        let input = format!(
            "{TERMINAL_CURSOR_HIDE_SEQUENCE}{TERMINAL_CURSOR_SHOW_SEQUENCE}{}",
            cwd_marker("/tmp")
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
        let (prompt_visible, cwd_updates) = filter.consume(&cwd_marker("/split"));

        assert_eq!(first_visible, "\x1b[?2");
        assert_eq!(second_visible, "5l");
        assert_eq!(cwd_updates, vec!["/split".to_string()]);
        assert_eq!(prompt_visible, TERMINAL_CURSOR_SHOW_SEQUENCE);
    }

    #[test]
    fn keeps_prompt_marker_without_cursor_restore_when_cursor_was_visible() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) = filter.consume(&cwd_marker("/visible"));

        assert_eq!(visible, "");
        assert_eq!(cwd_updates, vec!["/visible".to_string()]);
    }

    #[test]
    fn exports_bash_cwd_sync_hook_for_child_shells() {
        let command = shell_cwd_sync_command();

        assert!(command.contains("export PROMPT_COMMAND"));
        assert!(command.contains("export -f __myterminal_sync_cwd"));
        assert!(command.contains("__myterminal_install_cwd_wrappers"));
        assert!(command.contains("cd pushd popd"));
        assert!(command.contains("case $- in *i*)"));
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

fn proxy_tcp_stream(mut left: TcpStream, mut right: Channel) -> Result<(), AppError> {
    let mut left_to_right = left.try_clone()?;
    let mut right_to_left = right.clone();
    let copy_to_right = thread::spawn(move || {
        let _ = std::io::copy(&mut left_to_right, &mut right);
        let _ = left_to_right.shutdown(Shutdown::Both);
    });

    let _ = std::io::copy(&mut right_to_left, &mut left);
    let _ = left.shutdown(Shutdown::Both);
    let _ = copy_to_right.join();
    Ok(())
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
        while !thread_stop_flag.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((local_stream, _)) => {
                    if thread_stop_flag.load(Ordering::SeqCst) {
                        let _ = local_stream.shutdown(Shutdown::Both);
                        break;
                    }
                    let Ok(channel) = session.channel_direct_tcpip(&target_host, target_port, None)
                    else {
                        let _ = local_stream.shutdown(Shutdown::Both);
                        continue;
                    };
                    thread::spawn(move || {
                        let _ = proxy_tcp_stream(local_stream, channel);
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
    let cached = Arc::new(std::sync::Mutex::new(AuxiliarySshSession {
        session,
        sftp: None,
        user_names: None,
        group_names: None,
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
fn ssh_socket_error_hint(session: &Session) -> String {
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
        format!("so_error={error_code}")
    } else {
        format!("so_error_unavailable={}", std::io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn ssh_socket_error_hint(session: &Session) -> String {
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
        format!("so_error={error_code}")
    } else {
        format!("so_error_unavailable={}", std::io::Error::last_os_error())
    }
}

#[cfg(not(any(unix, windows)))]
fn ssh_socket_error_hint(_session: &Session) -> String {
    "so_error=unsupported_platform".into()
}

fn spawn_shell_thread(
    session_id: String,
    ssh_session: Session,
    cols: u16,
    rows: u16,
    output_queue: Arc<std::sync::Mutex<Vec<TerminalOutputChunk>>>,
    control_rx: mpsc::Receiver<SessionControl>,
    app_handle: tauri::AppHandle,
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
                        break;
                    }
                    Err(error) if is_transient_transport_read_error(&error) && !channel.eof() => {
                        read_transport_error = true;
                        transient_read_errors += 1;
                        let started_at =
                            transient_error_started_at.get_or_insert_with(Instant::now);
                        // 前几次错误时打印详细诊断，包含 socket SO_ERROR，帮助确认是否为连接重置/超时。
                        if transient_read_errors <= 3 || transient_read_errors % 2000 == 0 {
                            let dirs = ssh_session.block_directions();
                            let socket_hint = ssh_socket_error_hint(&ssh_session);
                            eprintln!(
                                "[SSH-DIAG] transport read error #{transient_read_errors}: error={error}, block_directions={dirs:?}, pending_input_len={}, {socket_hint}",
                                pending_input.len(),
                            );
                        }
                        // transport read 表示底层 receive 已失败；此轮不要继续写入，否则 write 会再次 drain incoming flow 并放大错误。
                        if started_at.elapsed() > Duration::from_secs(30) {
                            eprintln!("[SSH-DIAG] transient read error limit hit: count={transient_read_errors}, elapsed={:?}, last_error={error:?}, {}", started_at.elapsed(), ssh_socket_error_hint(&ssh_session));
                            queue_session_status(&output_queue, &app_handle, &session_id, "error");
                            let _ = channel.close();
                            return;
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

            if last_keepalive_at.elapsed() >= Duration::from_secs(20) {
                // 交互会话长时间无输出时主动发送 SSH keepalive，不向终端写入可见内容。
                let _ = ssh_session.keepalive_send();
                last_keepalive_at = Instant::now();
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
    output_queue: Arc<std::sync::Mutex<Vec<TerminalOutputChunk>>>,
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
                            queue_output(&reader_queue, &reader_app_handle, &reader_session_id, content);
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
                    if writer.write_all(data.as_bytes()).and_then(|_| writer.flush()).is_err() {
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
            executed_at: timestamp.unwrap_or_else(|| Utc::now().to_rfc3339()),
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
    let sections = exec_remote_command(
        session,
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

fn read_remote_file_bytes(
    state: &AppState,
    connection: &ConnectionProfile,
    path: &str,
) -> Result<Vec<u8>, AppError> {
    with_auxiliary_session(state, connection, |auxiliary| {
        let sftp = auxiliary_sftp(auxiliary)?;
        let remote_path = normalize_remote_path(path);
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
    connection: ConnectionProfile,
    remote_host: String,
    remote_port: u16,
    mut local_stream: TcpStream,
    stop_flag: Arc<AtomicBool>,
) {
    let Ok(ssh_session) = connect_ssh(&connection) else {
        return;
    };

    let Ok(mut channel) = ssh_session.channel_direct_tcpip(&remote_host, remote_port, None) else {
        return;
    };

    let _ = local_stream.set_read_timeout(Some(Duration::from_millis(80)));
    let _ = local_stream.set_write_timeout(Some(Duration::from_millis(80)));

    let mut local_buffer = [0_u8; 8192];
    let mut remote_buffer = [0_u8; 8192];
    let mut local_closed = false;
    let mut remote_closed = false;

    while !stop_flag.load(Ordering::Relaxed) && !(local_closed && remote_closed) {
        match local_stream.read(&mut local_buffer) {
            Ok(0) => {
                local_closed = true;
                let _ = channel.send_eof();
            }
            Ok(size) => {
                let _ = channel.write_all(&local_buffer[..size]);
                let _ = channel.flush();
            }
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => break,
        }

        match channel.read(&mut remote_buffer) {
            Ok(0) => {
                if channel.eof() {
                    remote_closed = true;
                }
            }
            Ok(size) => {
                let _ = local_stream.write_all(&remote_buffer[..size]);
                let _ = local_stream.flush();
            }
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => break,
        }

        thread::sleep(Duration::from_millis(8));
    }

    let _ = channel.close();
}

fn spawn_tunnel_listener(
    connection: ConnectionProfile,
    tunnel: TunnelRecord,
    stop_flag: Arc<AtomicBool>,
) -> Result<(), AppError> {
    let listener = TcpListener::bind((tunnel.bind_address.as_str(), tunnel.local_port))?;
    listener.set_nonblocking(true)?;

    thread::spawn(move || {
        while !stop_flag.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((stream, _)) => {
                    let connection = connection.clone();
                    let remote_host = tunnel.remote_host.clone();
                    let remote_port = tunnel.remote_port;
                    let stop = Arc::clone(&stop_flag);
                    thread::spawn(move || {
                        forward_single_connection(
                            connection,
                            remote_host,
                            remote_port,
                            stream,
                            stop,
                        );
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
    Command::new("powershell")
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
    agent_bridge::sync_server(
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
    let output_queue = Arc::new(std::sync::Mutex::new(Vec::<TerminalOutputChunk>::new()));
    let (control_tx, control_rx) = mpsc::channel();
    let stop_flag = Arc::new(AtomicBool::new(false));

    let runtime = RuntimeSession {
        session: TerminalSession {
            id: session_id.clone(),
            kind: "ssh".into(),
            connection_id: connection.id.clone(),
            local_profile_id: None,
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
        return Err(AppError::Validation(format!("local terminal directory not found: {cwd}")).into());
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
    let output_queue = Arc::new(std::sync::Mutex::new(Vec::<TerminalOutputChunk>::new()));
    let (control_tx, control_rx) = mpsc::channel();
    let stop_flag = Arc::new(AtomicBool::new(false));
    let runtime = RuntimeSession {
        session: TerminalSession {
            id: session_id.clone(),
            kind: "local".into(),
            connection_id: String::new(),
            local_profile_id: Some(next_profile.id.clone()),
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

    Ok(output.drain(..).collect())
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
pub fn list_remote_files(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<Vec<RemoteFileEntry>, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    list_remote_entries_cached(&state, &connection, &path).map_err(Into::into)
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
pub fn download_remote_file(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<String, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    Ok(download_remote_file_with_cache(&state, &connection, &path)?)
}

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
pub fn load_editor_document(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<EditorDocument, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    let bytes = match read_remote_file_bytes(&state, &connection, &path) {
        Ok(bytes) => bytes,
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

#[tauri::command]
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

#[tauri::command]
pub fn fetch_runtime_overview(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<RuntimeOverview, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    Ok(query_runtime_overview_cached(&state, &connection)?)
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

    if let Some(runtime) = lock_tunnels(&state)?.remove(&tunnel.id) {
        // 编辑端点会让旧监听参数失效，先停旧监听，再把新配置以停止状态落盘。
        runtime.stop_flag.store(true, Ordering::Relaxed);
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

    if let Some(runtime) = lock_tunnels(&state)?.remove(&tunnel_id) {
        runtime.stop_flag.store(true, Ordering::Relaxed);
    }

    let mut tunnel = tunnels[index].clone();
    let connection = ensure_connection_exists(&state, &tunnel.connection_id)?;
    let stop_flag = Arc::new(AtomicBool::new(false));
    spawn_tunnel_listener(connection, tunnel.clone(), Arc::clone(&stop_flag))?;

    tunnel.status = "running".into();
    tunnels[index] = tunnel.clone();
    state.storage.save_tunnels(&tunnels)?;
    lock_tunnels(&state)?.insert(
        tunnel.id.clone(),
        TunnelRuntime {
            stop_flag: Arc::clone(&stop_flag),
        },
    );

    Ok(tunnel)
}

#[tauri::command]
pub fn close_tunnel(state: State<'_, AppState>, tunnel_id: String) -> Result<bool, String> {
    if let Some(runtime) = lock_tunnels(&state)?.remove(&tunnel_id) {
        runtime.stop_flag.store(true, Ordering::Relaxed);
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

#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateCheckResult, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    // 更新提示返回给前端的 Release 页面地址，必须和 GitHub 仓库名保持一致。
    let release_url = "https://github.com/CrazyFigure/MyTerminal/releases/latest".to_string();
    let client = build_update_http_client(UPDATE_HTTP_READ_TIMEOUT)?;
    // GitHub API 要求明确 User-Agent；这里仅读取最新 Release 元数据，并挑出后续可安装的 Windows 安装包。
    let release = client
        .get("https://api.github.com/repos/CrazyFigure/MyTerminal/releases/latest")
        .header(reqwest::header::USER_AGENT, "MyTerminal")
        .send()
        .await
        .map_err(AppError::from)?
        .error_for_status()
        .map_err(AppError::from)?
        .json::<GitHubReleaseResponse>()
        .await
        .map_err(AppError::from)?;

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
    })
}

#[tauri::command]
pub async fn download_and_install_update(
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
    download_update_installer(&client, normalized_url, &installer_path, installer_size).await?;
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
