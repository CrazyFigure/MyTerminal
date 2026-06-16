use ssh2::{Channel, ExtendedData, Session};
use std::{
    io::{ErrorKind, Read, Write},
    sync::{
        mpsc::{self, TryRecvError},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use crate::{
    domain::entities::TerminalOutputChunk, domain::services, error::AppError, state::SessionControl,
};

use super::connection::ssh_error;

pub(crate) fn write_channel_input(channel: &mut Channel, data: &[u8]) -> Result<(), AppError> {
    let started_at = Instant::now();
    let mut written = 0;
    while written < data.len() {
        match channel.write(&data[written..]) {
            Ok(0) => {
                if started_at.elapsed() > Duration::from_secs(12) {
                    return Err(AppError::Validation(
                        "terminal input write timed out".into(),
                    ));
                }
                thread::sleep(Duration::from_millis(5));
            }
            Ok(size) => {
                written += size;
            }
            Err(error) if is_transient_channel_write_error(&error) => {
                if started_at.elapsed() > Duration::from_secs(12) {
                    return Err(AppError::from(error));
                }
                thread::sleep(Duration::from_millis(5));
            }
            Err(error) => return Err(AppError::from(error)),
        }
    }

    loop {
        match channel.flush() {
            Ok(()) => return Ok(()),
            Err(error) if is_transient_channel_write_error(&error) => {
                if started_at.elapsed() > Duration::from_secs(12) {
                    return Err(AppError::from(error));
                }
                thread::sleep(Duration::from_millis(5));
            }
            Err(error) => return Err(AppError::from(error)),
        }
    }
}

pub(crate) fn is_transient_channel_write_error(error: &std::io::Error) -> bool {
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

pub(crate) fn queue_output(
    queue: &Arc<std::sync::Mutex<Vec<TerminalOutputChunk>>>,
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
}

pub(crate) fn queue_session_status(
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

pub(crate) fn is_transient_transport_read_error(error: &std::io::Error) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    // libssh2 在非阻塞 PTY 读取时偶尔会把短暂底层读抖动包装成 transport read；未到 EOF 时先按瞬时错误重试。
    message.contains("transport read")
}

/// 目录同步标记使用 OSC 控制序列，终端可见内容会被后端过滤，仅把 cwd 元数据传给前端。
pub(crate) const CWD_SYNC_MARKER_PREFIX: &str = "\x1b]6973;MyTerminalCwd=";
pub(crate) const CWD_SYNC_MARKER_SUFFIX: char = '\x07';
pub(crate) const CWD_SYNC_SETUP_NAME: &str = "__myterminal_sync_cwd";

pub(crate) fn queue_cwd(
    queue: &Arc<std::sync::Mutex<Vec<TerminalOutputChunk>>>,
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
}

/// 记录跨 SSH 分片的半截 OSC 标记，保证 cwd 标记不泄漏到终端输出。
#[derive(Default)]
pub(crate) struct ShellOutputFilter {
    pending: String,
    suppress_setup_echo_line: bool,
}

impl ShellOutputFilter {
    /// 解析普通终端输出和目录同步标记；返回值第一项写入终端，第二项更新文件管理 cwd。
    pub(crate) fn consume(&mut self, content: &str) -> (String, Vec<String>) {
        self.pending.push_str(content);
        let mut visible = String::new();
        let mut cwd_updates = Vec::new();

        loop {
            if let Some(marker_start) = self.pending.find(CWD_SYNC_MARKER_PREFIX) {
                let before_marker = self.pending[..marker_start].to_string();
                visible.push_str(&self.strip_cwd_sync_setup_echo(&before_marker));
                let value_start = marker_start + CWD_SYNC_MARKER_PREFIX.len();

                if let Some(value_end) = self.pending[value_start..].find(CWD_SYNC_MARKER_SUFFIX) {
                    let cwd = self.pending[value_start..value_start + value_end]
                        .trim()
                        .to_string();
                    if !cwd.is_empty() {
                        cwd_updates.push(cwd);
                    }
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

pub(crate) fn handle_shell_control(
    channel: &mut Channel,
    control: SessionControl,
) -> Result<bool, AppError> {
    match control {
        SessionControl::Input(data) => {
            // libssh2 非阻塞 channel 在粘贴或连续 Backspace 时可能短暂 WouldBlock；这里分片重试，避免误判为会话断开。
            write_channel_input(channel, data.as_bytes())?;
            Ok(false)
        }
        SessionControl::Resize { cols, rows } => {
            if let Err(error) = channel.request_pty_size(cols.into(), rows.into(), Some(0), Some(0))
            {
                let message = error.to_string().to_ascii_lowercase();
                // 非阻塞 PTY 调整尺寸偶尔会撞上 libssh2 的短暂 busy 状态；尺寸下一次变化还会同步，不能因此断开会话。
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
            Ok(false)
        }
        SessionControl::Close => {
            let _ = channel.close();
            Ok(true)
        }
    }
}

pub(crate) fn flush_pending_shell_input(
    channel: &mut Channel,
    pending_input: &mut String,
) -> Result<(), AppError> {
    if pending_input.is_empty() {
        return Ok(());
    }

    // 同一轮事件循环内的按键合并成一个 channel 写入，降低连续 Backspace/粘贴时的 SSH 写入压力。
    let data = std::mem::take(pending_input);
    write_channel_input(channel, data.as_bytes())
}

pub(crate) fn is_recoverable_terminal_write_error(error: &AppError) -> bool {
    // 非阻塞 SSH channel 在远端同时大量输出和本地快速输入时可能暂时写不进去，保留会话比立刻断开更符合终端预期。
    match error {
        AppError::Io(error) => is_transient_channel_write_error(error),
        AppError::Validation(message) | AppError::Ssh(message) => {
            let normalized = message.to_ascii_lowercase();
            normalized.contains("terminal input write timed out")
                || normalized.contains("session(-37)")
                || normalized.contains("would block")
                || normalized.contains("eagain")
                || normalized.contains("temporarily unavailable")
                || normalized.contains("try again")
                || normalized.contains("transport write")
                || normalized.contains("socket write")
        }
        _ => false,
    }
}

pub(crate) fn spawn_shell_thread(
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
        let _ = channel.write_all(services::shell_cwd_sync_command().as_bytes());
        let _ = channel.flush();

        ssh_session.set_blocking(false);

        queue_session_status(&output_queue, &session_id, "connected");

        let mut buffer = [0_u8; 8192];
        // 终端输出可能把 OSC 同步标记拆成多段，过滤器负责跨分片拼接与隐藏。
        let mut output_filter = ShellOutputFilter::default();
        // transport read 可能是短暂底层读抖动；连续超过阈值才认为会话异常，避免终端误断开。
        let mut transient_read_errors = 0_usize;
        let mut transient_error_started_at: Option<Instant> = None;
        let mut pending_input = String::new();
        let mut last_keepalive_at = Instant::now();
        loop {
            loop {
                match control_rx.try_recv() {
                    Ok(SessionControl::Input(data)) => {
                        pending_input.push_str(&data);
                        if pending_input.len() >= 4096 {
                            let retry_input = pending_input.clone();
                            if let Err(error) =
                                flush_pending_shell_input(&mut channel, &mut pending_input)
                            {
                                if is_recoverable_terminal_write_error(&error) {
                                    pending_input = retry_input;
                                    break;
                                }
                                queue_session_status(&output_queue, &session_id, "error");
                                return;
                            }
                        }
                    }
                    Ok(SessionControl::Close) => {
                        let _ = channel.close();
                        return;
                    }
                    Ok(control) => {
                        let retry_input = pending_input.clone();
                        if let Err(error) =
                            flush_pending_shell_input(&mut channel, &mut pending_input)
                        {
                            if is_recoverable_terminal_write_error(&error) {
                                pending_input = retry_input;
                                break;
                            }
                            queue_session_status(&output_queue, &session_id, "error");
                            return;
                        }
                        match handle_shell_control(&mut channel, control) {
                            Ok(true) => return,
                            Ok(false) => {}
                            Err(_) => {
                                queue_session_status(&output_queue, &session_id, "error");
                                return;
                            }
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return,
                }
            }

            let retry_input = pending_input.clone();
            if let Err(error) = flush_pending_shell_input(&mut channel, &mut pending_input) {
                if is_recoverable_terminal_write_error(&error) {
                    pending_input = retry_input;
                    thread::sleep(Duration::from_millis(20));
                } else {
                    queue_session_status(&output_queue, &session_id, "error");
                    return;
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
                    transient_error_started_at = None;
                    let content = String::from_utf8_lossy(&buffer[..size]).into_owned();
                    let (visible_content, cwd_updates) = output_filter.consume(&content);
                    if !visible_content.is_empty() {
                        queue_output(&output_queue, &session_id, visible_content);
                    }
                    for cwd in cwd_updates {
                        queue_cwd(&output_queue, &session_id, cwd);
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                    ) => {}
                Err(error) if is_transient_transport_read_error(&error) && !channel.eof() => {
                    transient_read_errors += 1;
                    let started_at = transient_error_started_at.get_or_insert_with(Instant::now);
                    // transport read 在网络抖动或远端短暂无输出时可能连续出现；这里按时间窗口容忍，避免 400ms 内误判掉线。
                    if transient_read_errors > 160 || started_at.elapsed() > Duration::from_secs(8)
                    {
                        queue_session_status(&output_queue, &session_id, "error");
                        let _ = channel.close();
                        return;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                Err(_) => {
                    queue_session_status(&output_queue, &session_id, "error");
                    let _ = channel.close();
                    return;
                }
            }

            if last_keepalive_at.elapsed() >= Duration::from_secs(20) {
                // 交互会话长时间无输出时主动发送 SSH keepalive，不向终端写入可见内容。
                let _ = ssh_session.keepalive_send();
                last_keepalive_at = Instant::now();
            }

            thread::sleep(Duration::from_millis(16));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── ShellOutputFilter tests ──

    #[test]
    fn test_filter_normal_text_passthrough() {
        let mut filter = ShellOutputFilter::default();
        let (visible, cwd_updates) = filter.consume("hello world\n");
        assert_eq!(visible, "hello world\n");
        assert!(cwd_updates.is_empty());
    }

    #[test]
    fn test_filter_cwd_marker_extraction() {
        let mut filter = ShellOutputFilter::default();
        let input = "output before\x1b]6973;MyTerminalCwd=/home/user\x07output after".to_string();
        let (visible, cwd_updates) = filter.consume(&input);
        assert_eq!(visible, "output beforeoutput after");
        assert_eq!(cwd_updates, vec!["/home/user"]);
    }

    #[test]
    fn test_filter_cwd_marker_at_start() {
        let mut filter = ShellOutputFilter::default();
        let input = "\x1b]6973;MyTerminalCwd=/root\x07".to_string();
        let (visible, cwd_updates) = filter.consume(&input);
        assert_eq!(visible, "");
        assert_eq!(cwd_updates, vec!["/root"]);
    }

    #[test]
    fn test_filter_partial_cwd_marker_across_chunks() {
        let mut filter = ShellOutputFilter::default();
        // First chunk: partial marker prefix
        let (visible, cwd_updates) = filter.consume("before \x1b]6973;MyTerm");
        assert_eq!(visible, "before ");
        assert!(cwd_updates.is_empty());

        // Second chunk: remainder of marker
        let (visible, cwd_updates) = filter.consume("inalCwd=/var/log\x07after");
        assert_eq!(visible, "after");
        assert_eq!(cwd_updates, vec!["/var/log"]);
    }

    #[test]
    fn test_filter_just_marker_prefix() {
        let mut filter = ShellOutputFilter::default();
        let (visible, cwd_updates) = filter.consume("prefix \x1b]6973;MyTerminalCwd=");
        assert_eq!(visible, "prefix ");
        assert!(cwd_updates.is_empty());
    }

    #[test]
    fn test_filter_multiple_cwd_markers() {
        let mut filter = ShellOutputFilter::default();
        let input =
            "a\x1b]6973;MyTerminalCwd=/first\x07b\x1b]6973;MyTerminalCwd=/second\x07c".to_string();
        let (visible, cwd_updates) = filter.consume(&input);
        assert_eq!(visible, "abc");
        assert_eq!(cwd_updates, vec!["/first", "/second"]);
    }

    #[test]
    fn test_filter_strip_setup_echo() {
        let mut filter = ShellOutputFilter::default();
        let input =
            "before\n__myterminal_sync_cwd\nmiddle\n__myterminal_sync_prompt\nafter".to_string();
        let (visible, _) = filter.consume(&input);
        // The setup lines should be filtered out
        assert!(!visible.contains("__myterminal_sync_cwd"));
    }

    #[test]
    fn test_filter_cwd_marker_with_trailing_content() {
        let mut filter = ShellOutputFilter::default();
        let input = "\x1b]6973;MyTerminalCwd=/tmp\x07".to_string();
        let (visible, cwd_updates) = filter.consume(&input);
        assert!(visible.is_empty());
        assert_eq!(cwd_updates, vec!["/tmp"]);
    }

    #[test]
    fn test_filter_empty_input() {
        let mut filter = ShellOutputFilter::default();
        let (visible, cwd_updates) = filter.consume("");
        assert!(visible.is_empty());
        assert!(cwd_updates.is_empty());
    }

    #[test]
    fn test_filter_only_non_marker_text() {
        let mut filter = ShellOutputFilter::default();
        let (visible, cwd_updates) = filter.consume("line1\nline2\nline3\n");
        assert_eq!(visible, "line1\nline2\nline3\n");
        assert!(cwd_updates.is_empty());
    }

    #[test]
    fn test_filter_cwd_marker_trimmed_path() {
        let mut filter = ShellOutputFilter::default();
        let input = "\x1b]6973;MyTerminalCwd=  /spaced/path  \x07text".to_string();
        let (visible, cwd_updates) = filter.consume(&input);
        assert_eq!(visible, "text");
        assert_eq!(cwd_updates, vec!["/spaced/path"]);
    }
}
