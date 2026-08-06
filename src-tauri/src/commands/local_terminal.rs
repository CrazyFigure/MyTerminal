//! 本地终端 PTY 适配器。

use std::{
    io::{ErrorKind, Read, Write},
    path::Path,
    sync::{mpsc, mpsc::RecvTimeoutError, Arc},
    thread,
    time::Duration,
};

use portable_pty::{CommandBuilder, PtySize};

use crate::{
    models::{LocalTerminalProfile, LocalTerminalSettings},
    state::{SessionControl, TerminalOutputQueue},
};

use super::{
    queue_output, queue_session_status, queue_terminal_size, DEFAULT_LOCAL_SHELL_CANDIDATES,
};

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
pub(super) fn should_force_claude_synchronized_output(command: &str) -> bool {
    matches!(
        extract_local_command_executable_name(command).as_deref(),
        Some("claude" | "claude-code")
    )
}

/// Qwen Code 使用独立的官方开关；只匹配直接启动命令，不能复用或全局扩散 Claude 的专用变量。
pub(super) fn should_force_qwen_synchronized_output(command: &str) -> bool {
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

pub(super) fn spawn_local_terminal_thread(
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
                        queue_terminal_size(&output_queue, &app_handle, &session_id, cols, rows);
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
