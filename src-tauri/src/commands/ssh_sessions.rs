//! SSH 会话运行时：辅助连接缓存、SFTP 子系统和交互 Shell 事件循环。

use std::{
    collections::HashMap,
    io::{ErrorKind, Read, Write},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, RecvTimeoutError, TryRecvError},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use ssh2::{Channel, ExtendedData, Session, Sftp};

use crate::{
    error::AppError,
    models::ConnectionProfile,
    state::{AgentPtyState, AppState, AuxiliarySshSession, SessionControl, TerminalOutputQueue},
};

use super::{
    auxiliary_session_lock, connect_ssh, is_transient_transport_read_error,
    load_remote_identity_maps, lock_auxiliary_sessions, publish_agent_pty_progress, queue_cwd,
    queue_output, queue_session_status, queue_terminal_size, shell_cwd_sync_command, ssh_error,
    track_user_input_activity, write_channel_input, ShellOutputFilter, AUXILIARY_IDLE_TTL,
    AUXILIARY_IO_TIMEOUT, AUXILIARY_MAX_IDLE_SESSIONS, SSH_SHELL_IDLE_WAIT,
    SSH_SHELL_MAX_CONTROL_EVENTS_PER_TICK, SSH_SHELL_MAX_READS_PER_TICK,
    SSH_SHELL_MAX_WRITE_CHUNK_BYTES, SSH_SHELL_RETRY_WAIT,
};

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

pub(super) fn drop_auxiliary_session(state: &AppState, connection_id: &str) {
    if let Ok(mut sessions) = lock_auxiliary_sessions(state) {
        sessions.remove(connection_id);
    }
}

pub(super) fn clear_auxiliary_sessions(state: &AppState) {
    if let Ok(mut sessions) = lock_auxiliary_sessions(state) {
        sessions.clear();
    }
}

/// 保活守护线程每轮顺带执行的辅助连接淘汰：回收空闲超过 TTL 的连接，并在空闲连接过多时
/// 保留最近使用的若干个、淘汰其余最久未用者。只回收当前无人持有（Arc strong_count==1）
/// 且能立即 try_lock 的连接，避免误删正在进行文件/资源操作的活跃会话。
pub(super) fn evict_idle_auxiliary_sessions(state: &AppState) {
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
                idle.push((
                    id.clone(),
                    now.saturating_duration_since(guard.last_used_at),
                ));
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
            for (id, _) in survivors
                .iter()
                .take(survivors.len() - AUXILIARY_MAX_IDLE_SESSIONS)
            {
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

pub(super) fn with_auxiliary_session<T>(
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

pub(super) fn with_auxiliary_session_once<T>(
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

pub(super) fn auxiliary_sftp(session: &mut AuxiliarySshSession) -> Result<&Sftp, AppError> {
    if session.sftp.is_none() {
        // SFTP 子系统初始化成功后挂在辅助 SSH 会话上，目录切换不再重复打开子系统。
        session.sftp = Some(session.session.sftp().map_err(ssh_error)?);
    }

    session
        .sftp
        .as_ref()
        .ok_or_else(|| AppError::Validation("sftp session is unavailable".into()))
}

pub(super) fn auxiliary_identity_maps(
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
pub(super) fn ssh_socket_error_code(session: &Session) -> Option<libc::c_int> {
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
pub(super) fn ssh_socket_error_code(session: &Session) -> Option<libc::c_int> {
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
pub(super) fn ssh_socket_error_code(_session: &Session) -> Option<libc::c_int> {
    None
}

fn ssh_socket_error_hint(_session: &Session) -> String {
    match ssh_socket_error_code(_session) {
        Some(error_code) => format!("so_error={error_code}"),
        None => format!("so_error_unavailable={}", std::io::Error::last_os_error()),
    }
}

pub(super) fn spawn_shell_thread(
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
            if keepalive_secs > 0
                && last_keepalive_at.elapsed() >= Duration::from_secs(keepalive_secs)
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
