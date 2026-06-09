use std::{
    collections::HashMap,
    env,
    fs,
    io::{ErrorKind, Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, TryRecvError},
        Arc, MutexGuard,
    },
    thread,
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{TimeZone, Utc};
use ssh2::{Channel, ExtendedData, Session, Sftp};
use tauri::State;

use crate::{
    error::AppError,
    models::{
        AppSettings, BootstrapState, ConnectionProfile, EditorDocument, HistoryEntry,
        HistoryEntryInput, LocalConfigBundle, RemoteFileEntry, RuntimeOverview,
        TerminalOutputChunk, TerminalSession, TunnelOpenRequest, TunnelRecord,
    },
    state::{AppState, RuntimeSession, SessionControl, TunnelRuntime},
};

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

fn queue_output(queue: &Arc<std::sync::Mutex<Vec<TerminalOutputChunk>>>, session_id: &str, content: impl Into<String>) {
    if let Ok(mut output) = queue.lock() {
        output.push(TerminalOutputChunk {
            session_id: session_id.to_string(),
            cwd: None,
            status: None,
            content: content.into(),
        });
    }
}

fn queue_session_status(
    queue: &Arc<std::sync::Mutex<Vec<TerminalOutputChunk>>>,
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
}

fn is_transient_transport_read_error(error: &std::io::Error) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    // libssh2 在非阻塞 PTY 读取时偶尔会把短暂底层读抖动包装成 transport read；未到 EOF 时先按瞬时错误重试。
    message.contains("transport read")
}

/// 目录同步标记使用 OSC 控制序列，终端可见内容会被后端过滤，仅把 cwd 元数据传给前端。
const CWD_SYNC_MARKER_PREFIX: &str = "\x1b]6973;MyTerminalCwd=";
const CWD_SYNC_MARKER_SUFFIX: char = '\x07';
const CWD_SYNC_SETUP_NAME: &str = "__myterminal_sync_cwd";

fn queue_cwd(queue: &Arc<std::sync::Mutex<Vec<TerminalOutputChunk>>>, session_id: &str, cwd: impl Into<String>) {
    if let Ok(mut output) = queue.lock() {
        output.push(TerminalOutputChunk {
            session_id: session_id.to_string(),
            cwd: Some(cwd.into()),
            status: None,
            content: String::new(),
        });
    }
}

/// 注入到交互 Shell 的目录同步与历史落盘钩子；bash/zsh 额外包装 cd/pushd/popd，其他 sh 通过 PS1 命令替换兜底。
fn shell_cwd_sync_command() -> String {
    [
        "__myterminal_sync_cwd(){ printf '\\033]6973;MyTerminalCwd=%s\\a' \"$PWD\"; }",
        "__myterminal_sync_history(){ if [ -n \"${ZSH_VERSION-}\" ]; then fc -AI 2>/dev/null || true; elif [ -n \"${BASH_VERSION-}\" ]; then history -a 2>/dev/null || true; fi; }",
        "__myterminal_sync_prompt(){ __myterminal_sync_history; __myterminal_sync_cwd; }",
        "if [ -n \"${BASH_VERSION-}${ZSH_VERSION-}\" ]; then cd(){ builtin cd \"$@\"; __myterminal_status=$?; __myterminal_sync_prompt; return $__myterminal_status; }; pushd(){ builtin pushd \"$@\"; __myterminal_status=$?; __myterminal_sync_prompt; return $__myterminal_status; }; popd(){ builtin popd \"$@\"; __myterminal_status=$?; __myterminal_sync_prompt; return $__myterminal_status; }; fi",
        "if [ -n \"${ZSH_VERSION-}\" ]; then autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd __myterminal_sync_prompt 2>/dev/null || PS1='$(__myterminal_sync_prompt)'\"$PS1\"",
        "elif [ -n \"${BASH_VERSION-}\" ]; then PROMPT_COMMAND=\"__myterminal_sync_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}\"",
        "else PS1='$(__myterminal_sync_prompt)'\"$PS1\"",
        "fi",
        "__myterminal_sync_prompt",
        "\n",
    ]
    .join("; ")
}

/// 记录跨 SSH 分片的半截 OSC 标记，保证 cwd 标记不泄漏到终端输出。
#[derive(Default)]
struct ShellOutputFilter {
    pending: String,
    suppress_setup_echo_line: bool,
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
                visible.push_str(&self.strip_cwd_sync_setup_echo(&before_marker));
                let value_start = marker_start + CWD_SYNC_MARKER_PREFIX.len();

                if let Some(value_end) = self.pending[value_start..].find(CWD_SYNC_MARKER_SUFFIX) {
                    let cwd = self.pending[value_start..value_start + value_end].trim().to_string();
                    if !cwd.is_empty() {
                        cwd_updates.push(cwd);
                    }
                    let remainder_start = value_start + value_end + CWD_SYNC_MARKER_SUFFIX.len_utf8();
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
            visible.push_str(&self.strip_cwd_sync_setup_echo(&drainable));
            self.pending = self.pending[drain_len..].to_string();
            break;
        }

        (visible, cwd_updates)
    }

    /// 过滤我方注入命令的回显，避免用户在终端里看到同步协议细节。
    fn strip_cwd_sync_setup_echo(&mut self, value: &str) -> String {
        let mut visible = String::new();

        for line in value.split_inclusive('\n') {
            if line.contains(CWD_SYNC_SETUP_NAME) {
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

fn authenticate_ssh_session(
    session: &Session,
    connection: &ConnectionProfile,
) -> Result<(), AppError> {
    let auth_method = connection.auth_method.trim();

    if auth_method.eq_ignore_ascii_case("privateKey") {
        let passphrase = non_empty_trimmed(connection.passphrase.as_deref());

        if let Some(private_key_text) = non_empty_trimmed(connection.private_key_text.as_deref()) {
            session
                .userauth_pubkey_memory(&connection.username, None, private_key_text, passphrase)
                .map_err(ssh_error)?;
            return Ok(());
        }

        let private_key_path = non_empty_trimmed(connection.private_key_path.as_deref())
            .ok_or_else(|| {
                AppError::Validation(
                    "private key authentication requires a key path or pasted key content"
                        .into(),
                )
            })?;

        session
            .userauth_pubkey_file(
                &connection.username,
                None,
                &expand_home_path(private_key_path),
                passphrase,
            )
            .map_err(ssh_error)?;

        return Ok(());
    }

    let password = connection.password.trim();
    if password.is_empty() {
        return Err(AppError::Validation(
            "password authentication requires a password".into(),
        ));
    }

    session
        .userauth_password(&connection.username, password)
        .map_err(ssh_error)?;

    Ok(())
}

fn connect_ssh(connection: &ConnectionProfile) -> Result<Session, AppError> {
    let address = format!("{}:{}", connection.host, connection.port);
    let tcp = TcpStream::connect(address)?;
    tcp.set_read_timeout(Some(Duration::from_secs(30)))?;
    tcp.set_write_timeout(Some(Duration::from_secs(30)))?;

    let mut session = Session::new().map_err(ssh_error)?;
    session.set_tcp_stream(tcp);
    session.handshake().map_err(ssh_error)?;
    authenticate_ssh_session(&session, connection)?;

    if !session.authenticated() {
        return Err(AppError::Validation(format!(
            "authentication failed for {}@{}",
            connection.username, connection.host
        )));
    }

    Ok(session)
}

fn handle_shell_control(
    channel: &mut Channel,
    control: SessionControl,
) -> Result<bool, AppError> {
    match control {
        SessionControl::Input(data) => {
            channel.write_all(data.as_bytes())?;
            channel.flush()?;
            Ok(false)
        }
        SessionControl::Resize { cols, rows } => {
            channel
                .request_pty_size(cols.into(), rows.into(), Some(0), Some(0))
                .map_err(ssh_error)?;
            Ok(false)
        }
        SessionControl::Close => {
            let _ = channel.close();
            Ok(true)
        }
    }
}

fn spawn_shell_thread(
    session_id: String,
    ssh_session: Session,
    cols: u16,
    rows: u16,
    output_queue: Arc<std::sync::Mutex<Vec<TerminalOutputChunk>>>,
    control_rx: mpsc::Receiver<SessionControl>,
) {
    thread::spawn(move || {
        let mut channel = match ssh_session.channel_session() {
            Ok(channel) => channel,
            Err(_) => {
                queue_session_status(&output_queue, &session_id, "error");
                return;
            }
        };

        let _ = channel.handle_extended_data(ExtendedData::Merge);
        if channel
            .request_pty("xterm", None, Some((cols.into(), rows.into(), 0, 0)))
            .is_err()
        {
            queue_session_status(&output_queue, &session_id, "error");
            return;
        }

        if channel.shell().is_err() {
            queue_session_status(&output_queue, &session_id, "error");
            return;
        }

        // Shell 启动后立即写入目录同步钩子，后续 cd/pushd/popd 后由提示符周期回传真实 PWD。
        let _ = channel.write_all(shell_cwd_sync_command().as_bytes());
        let _ = channel.flush();

        ssh_session.set_blocking(false);

        queue_session_status(&output_queue, &session_id, "connected");

        let mut buffer = [0_u8; 8192];
        // 终端输出可能把 OSC 同步标记拆成多段，过滤器负责跨分片拼接与隐藏。
        let mut output_filter = ShellOutputFilter::default();
        // transport read 可能是短暂底层读抖动；连续超过阈值才认为会话异常，避免终端误断开。
        let mut transient_read_errors = 0_usize;
        loop {
            loop {
                match control_rx.try_recv() {
                    Ok(control) => match handle_shell_control(&mut channel, control) {
                        Ok(true) => return,
                        Ok(false) => {}
                        Err(_) => {
                            queue_session_status(&output_queue, &session_id, "error");
                            return;
                        }
                    },
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return,
                }
            }

            match channel.read(&mut buffer) {
                Ok(0) => {
                    if channel.eof() {
                        queue_session_status(&output_queue, &session_id, "closed");
                        let _ = channel.close();
                        return;
                    }
                }
                Ok(size) => {
                    transient_read_errors = 0;
                    let content = String::from_utf8_lossy(&buffer[..size]).into_owned();
                    let (visible_content, cwd_updates) = output_filter.consume(&content);
                    if !visible_content.is_empty() {
                        queue_output(&output_queue, &session_id, visible_content);
                    }
                    for cwd in cwd_updates {
                        queue_cwd(&output_queue, &session_id, cwd);
                    }
                }
                Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted) => {}
                Err(error) if is_transient_transport_read_error(&error) && !channel.eof() && transient_read_errors < 8 => {
                    transient_read_errors += 1;
                    thread::sleep(Duration::from_millis(50));
                }
                Err(_) => {
                    queue_session_status(&output_queue, &session_id, "error");
                    let _ = channel.close();
                    return;
                }
            }

            thread::sleep(Duration::from_millis(16));
        }
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

fn join_remote_path(remote_dir: &str, file_name: &str) -> String {
    let base = normalize_remote_path(remote_dir);
    let name = normalize_remote_path(file_name).trim_matches('/').to_string();
    if base == "." || base.is_empty() {
        name
    } else if base == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", base.trim_end_matches('/'), name)
    }
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
    for bit in [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001] {
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
        stat.uid
            .map(|value| user_names.get(&value).cloned().unwrap_or_else(|| value.to_string())),
        stat.gid
            .map(|value| group_names.get(&value).cloned().unwrap_or_else(|| value.to_string())),
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

fn read_remote_shell_history_entries(
    connection: &ConnectionProfile,
    limit: usize,
) -> Result<Vec<HistoryEntry>, AppError> {
    let session = connect_ssh(connection)?;
    let remote_limit = limit.clamp(1, 500);
    // 远端 history 是 shell 内置，独立 exec 不一定能读取交互会话内存；这里读取历史文件，
    // 并依赖交互 Shell 的 prompt 钩子先执行 history -a / fc -AI，把当前会话命令落盘。
    let command = format!(
        "sh -lc 'limit={remote_limit}; seen=\"\"; for file in \"${{HISTFILE:-}}\" \"$HOME/.zsh_history\" \"$HOME/.bash_history\"; do [ -n \"$file\" ] || continue; case \":$seen:\" in *:\"$file\":*) continue;; esac; seen=\"$seen:$file\"; [ -r \"$file\" ] || continue; tail -n \"$limit\" \"$file\" 2>/dev/null; done'"
    );
    let contents = exec_remote_command(&session, &command)?;
    Ok(parse_remote_history(&connection.id, &contents, remote_limit))
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

fn parse_cpu_percent(contents: &str) -> Option<f64> {
    let mut samples = contents.lines().filter_map(parse_cpu_sample);
    let (idle_before, total_before) = samples.next()?;
    let (idle_after, total_after) = samples.next()?;
    let idle_delta = idle_after.saturating_sub(idle_before);
    let total_delta = total_after.saturating_sub(total_before);
    if total_delta == 0 {
        return None;
    }

    Some(((total_delta.saturating_sub(idle_delta)) as f64 / total_delta as f64) * 100.0)
}

fn query_runtime_overview(connection: &ConnectionProfile) -> Result<RuntimeOverview, AppError> {
    let session = connect_ssh(connection)?;
    // 运行状态一次性读取所有需要的远端文本，避免 CPU/内存/磁盘等指标各自开 channel 导致刷新发慢。
    let sections = exec_remote_command(
        &session,
        "sh -lc 'printf \"__MYTERMINAL_OS__\\n\"; (uname -srmo 2>/dev/null || uname -a 2>/dev/null || true); printf \"\\n__MYTERMINAL_CPUSTAT__\\n\"; (grep \"^cpu \" /proc/stat 2>/dev/null; sleep 0.2; grep \"^cpu \" /proc/stat 2>/dev/null) || true; printf \"\\n__MYTERMINAL_MEMINFO__\\n\"; cat /proc/meminfo 2>/dev/null || true; printf \"\\n__MYTERMINAL_DF__\\n\"; df -Pk / 2>/dev/null || true; printf \"\\n__MYTERMINAL_HOSTIP__\\n\"; hostname -I 2>/dev/null || true; printf \"\\n__MYTERMINAL_UPTIME__\\n\"; cat /proc/uptime 2>/dev/null || true'",
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
            Some(format!("{} / {} ({percent:.0}%)", format_kib(used), format_kib(total)))
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
            Some(format!("{} / {} ({})", format_kib(used), format_kib(total), parts[4]))
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
            let is_dir = target_stat.as_ref().map(stat_is_dir).unwrap_or_else(|| stat_is_dir(&stat));
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

fn read_remote_file_bytes(connection: &ConnectionProfile, path: &str) -> Result<Vec<u8>, AppError> {
    let session = connect_ssh(connection)?;
    let sftp = session.sftp().map_err(ssh_error)?;
    let remote_path = normalize_remote_path(path);
    let mut remote_file = sftp.open(Path::new(&remote_path)).map_err(ssh_error)?;
    let mut bytes = Vec::new();
    remote_file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn write_remote_file_bytes(
    connection: &ConnectionProfile,
    path: &str,
    bytes: &[u8],
) -> Result<(), AppError> {
    let session = connect_ssh(connection)?;
    let sftp = session.sftp().map_err(ssh_error)?;
    let remote_path = normalize_remote_path(path);
    let mut remote_file = sftp.create(Path::new(&remote_path)).map_err(ssh_error)?;
    remote_file.write_all(bytes)?;
    remote_file.flush()?;
    Ok(())
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

fn spawn_tunnel_listener(connection: ConnectionProfile, tunnel: TunnelRecord, stop_flag: Arc<AtomicBool>) -> Result<(), AppError> {
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
                        forward_single_connection(connection, remote_host, remote_port, stream, stop);
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
        let _ = runtime.control_tx.send(SessionControl::Close);
    }
    drop(sessions);

    let mut tunnels = lock_tunnels(state)?;
    for runtime in tunnels.drain().map(|(_, runtime)| runtime) {
        runtime.stop_flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

fn bootstrap_from_storage(state: &AppState) -> Result<BootstrapState, AppError> {
    let sessions = lock_sessions(state)?
        .values()
        .map(|item| item.session.clone())
        .collect();

    Ok(BootstrapState {
        settings: state.storage.load_settings(&state.crypto)?,
        connections: state.storage.load_connections(&state.crypto)?,
        history: state.storage.load_history()?,
        sessions,
        tunnels: state.storage.load_tunnels()?,
    })
}

#[tauri::command]
pub fn bootstrap_state(state: State<'_, AppState>) -> Result<BootstrapState, String> {
    Ok(bootstrap_from_storage(&state)?)
}

#[tauri::command]
pub fn save_app_settings(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    state.storage.save_settings(&settings, &state.crypto)?;
    Ok(settings)
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
    let mut connections = state.storage.load_connections(&state.crypto)?;
    connections.retain(|item| item.id != connection.id);
    connections.insert(0, connection.clone());
    state.storage.save_connections(&connections, &state.crypto)?;
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
    let mut connections = state.storage.load_connections(&state.crypto)?;
    connections.retain(|item| item.id != connection_id);
    state.storage.save_connections(&connections, &state.crypto)?;

    let mut sessions = lock_sessions(&state)?;
    let session_ids = sessions
        .iter()
        .filter_map(|(session_id, runtime)| {
            (runtime.session.connection_id == connection_id).then(|| session_id.clone())
        })
        .collect::<Vec<_>>();

    for session_id in session_ids {
        if let Some(runtime) = sessions.remove(&session_id) {
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
    connection_id: String,
) -> Result<TerminalSession, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    let ssh_session = connect_ssh(&connection)?;
    let session_id = uuid::Uuid::new_v4().to_string();
    let output_queue = Arc::new(std::sync::Mutex::new(Vec::<TerminalOutputChunk>::new()));
    let (control_tx, control_rx) = mpsc::channel();

    let runtime = RuntimeSession {
        session: TerminalSession {
            id: session_id.clone(),
            connection_id: connection.id.clone(),
            title: format!("{}@{}", connection.username, connection.host),
            status: "connected".into(),
            cwd: Some("~".into()),
        },
        cols: 120,
        rows: 32,
        output_queue: Arc::clone(&output_queue),
        control_tx: control_tx.clone(),
    };

    spawn_shell_thread(
        session_id,
        ssh_session,
        runtime.cols,
        runtime.rows,
        output_queue,
        control_rx,
    );

    let session = runtime.session.clone();
    lock_sessions(&state)?.insert(session.id.clone(), runtime);
    Ok(session)
}

#[tauri::command]
pub fn close_ssh_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<bool, String> {
    if let Some(runtime) = lock_sessions(&state)?.remove(&session_id) {
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
    let session = connect_ssh(&connection)?;
    let (user_names, group_names) = load_remote_identity_maps(&session);
    let sftp = session.sftp().map_err(ssh_error)?;
    list_remote_entries(&sftp, &path, &user_names, &group_names).map_err(Into::into)
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
    let session = connect_ssh(&connection)?;
    let sftp = session.sftp().map_err(ssh_error)?;
    let directory = resolve_remote_dir(&sftp, &remote_dir)?;
    let remote_path = join_remote_path(&directory, &file_name);
    let bytes = STANDARD
        .decode(content_base64)
        .map_err(|error| AppError::Validation(format!("invalid upload payload: {error}")))?;
    write_remote_file_bytes(&connection, &remote_path, &bytes)?;
    Ok(true)
}

#[tauri::command]
pub fn download_remote_file(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<String, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    let bytes = read_remote_file_bytes(&connection, &path)?;

    let downloads_dir = state.storage.downloads_dir_path();
    fs::create_dir_all(&downloads_dir).map_err(|error| AppError::from(error).to_string())?;

    let file_name = remote_file_name(&path).unwrap_or_else(|| "download.bin".into());
    let destination = downloads_dir.join(file_name);
    fs::write(&destination, bytes).map_err(|error| AppError::from(error).to_string())?;

    Ok(destination.to_string_lossy().to_string())
}

#[tauri::command]
pub fn delete_remote_path(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<bool, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    let session = connect_ssh(&connection)?;
    let sftp = session.sftp().map_err(ssh_error)?;
    let remote_path = normalize_remote_path(&path);
    let stat = sftp.stat(Path::new(&remote_path)).map_err(ssh_error)?;
    if stat_is_dir(&stat) {
        sftp.rmdir(Path::new(&remote_path)).map_err(ssh_error)?;
    } else {
        sftp.unlink(Path::new(&remote_path)).map_err(ssh_error)?;
    }
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
    let session = connect_ssh(&connection)?;
    let sftp = session.sftp().map_err(ssh_error)?;
    let remote_path = normalize_remote_path(&path);
    let next_remote_path = normalize_remote_path(&new_path);
    sftp.rename(Path::new(&remote_path), Path::new(&next_remote_path), None)
        .map_err(ssh_error)?;
    Ok(true)
}

#[tauri::command]
pub fn load_editor_document(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<EditorDocument, String> {
    let connection = ensure_connection_exists(&state, &connection_id)?;
    let bytes = match read_remote_file_bytes(&connection, &path) {
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
    write_remote_file_bytes(&connection, &path, content.as_bytes())?;

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
    Ok(query_runtime_overview(&connection)?)
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

    let connection = ensure_connection_exists(&state, &connection_id)?;
    let tunnel = TunnelRecord {
        id: uuid::Uuid::new_v4().to_string(),
        connection_id,
        name,
        bind_address,
        local_port,
        remote_host,
        remote_port,
        status: "running".into(),
    };

    let stop_flag = Arc::new(AtomicBool::new(false));
    spawn_tunnel_listener(connection, tunnel.clone(), Arc::clone(&stop_flag))?;

    let mut tunnels = state.storage.load_tunnels()?;
    tunnels.retain(|item| item.id != tunnel.id);
    tunnels.insert(0, tunnel.clone());
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
pub fn start_tunnel(
    state: State<'_, AppState>,
    tunnel_id: String,
) -> Result<TunnelRecord, String> {
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
pub fn close_tunnel(
    state: State<'_, AppState>,
    tunnel_id: String,
) -> Result<bool, String> {
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
    read_remote_shell_history_entries(&connection, limit.unwrap_or(100)).map_err(Into::into)
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
pub fn export_local_config(state: State<'_, AppState>) -> Result<String, String> {
    let bundle = LocalConfigBundle {
        schema_version: 1,
        exported_at: Utc::now().to_rfc3339(),
        settings: state.storage.load_settings(&state.crypto)?,
        connections: state.storage.load_connections(&state.crypto)?,
        history: state.storage.load_history()?,
        tunnels: state.storage.load_tunnels()?,
    };

    let export_dir = state.storage.exports_dir_path();
    fs::create_dir_all(&export_dir).map_err(|error| AppError::from(error).to_string())?;
    let timestamp = Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let path = export_dir.join(format!("myterminal-config-{timestamp}.json"));
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

    state
        .storage
        .backup_existing_file(&state.storage.settings_file_path(), "settings-before-local-import")?;
    state
        .storage
        .backup_existing_file(&state.storage.connections_file_path(), "connections-before-local-import")?;
    state
        .storage
        .backup_existing_file(&state.storage.history_file_path(), "history-before-local-import")?;
    state
        .storage
        .backup_existing_file(&state.storage.tunnels_file_path(), "tunnels-before-local-import")?;

    for tunnel in &mut bundle.tunnels {
        tunnel.status = "stopped".into();
    }

    state.storage.save_settings(&bundle.settings, &state.crypto)?;
    state
        .storage
        .save_connections(&bundle.connections, &state.crypto)?;
    state.storage.save_history(&bundle.history)?;
    state.storage.save_tunnels(&bundle.tunnels)?;

    Ok(bootstrap_from_storage(&state)?)
}

#[tauri::command]
pub async fn upload_settings_to_webdav(state: State<'_, AppState>) -> Result<bool, String> {
    let settings = state.storage.load_settings(&state.crypto)?;
    state.webdav.upload_settings(&settings, &state.crypto).await?;
    Ok(true)
}

#[tauri::command]
pub async fn download_settings_from_webdav(
    state: State<'_, AppState>,
) -> Result<AppSettings, String> {
    let current_settings = state.storage.load_settings(&state.crypto)?;
    state
        .storage
        .backup_existing_file(&state.storage.settings_file_path(), "settings")?;
    let downloaded = state
        .webdav
        .download_settings(&current_settings.webdav, &state.crypto)
        .await?;
    state.storage.save_settings(&downloaded, &state.crypto)?;
    Ok(downloaded)
}

#[tauri::command]
pub async fn upload_connections_to_webdav(state: State<'_, AppState>) -> Result<bool, String> {
    let settings = state.storage.load_settings(&state.crypto)?;
    let connections = state.storage.load_connections(&state.crypto)?;
    state
        .webdav
        .upload_connections(&settings, &connections, &state.crypto)
        .await?;
    Ok(true)
}

#[tauri::command]
pub async fn download_connections_from_webdav(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionProfile>, String> {
    let settings = state.storage.load_settings(&state.crypto)?;
    state
        .storage
        .backup_existing_file(&state.storage.connections_file_path(), "connections")?;
    let connections = state
        .webdav
        .download_connections(&settings.webdav, &state.crypto)
        .await?;
    state.storage.save_connections(&connections, &state.crypto)?;
    Ok(connections)
}
