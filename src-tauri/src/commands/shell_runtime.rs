//! Shell 输出队列、Agent 可见进度、用户输入跟踪与 cwd 同步协议辅助。

use super::*;

pub(super) fn queue_output(
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

pub(super) fn queue_session_status(
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
pub(super) fn queue_terminal_size(
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
    let ellipsis = if text.chars().count() > 160 {
        "…"
    } else {
        ""
    };
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
pub(super) fn queue_agent_terminal_notice(
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
pub(super) fn track_user_input_activity(
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
pub(super) fn publish_agent_pty_progress(
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

pub(super) fn is_transient_transport_read_error(error: &std::io::Error) -> bool {
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

pub(super) fn is_transient_ssh_error(error: &impl std::fmt::Display) -> bool {
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

pub(super) fn queue_cwd(
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
pub(super) fn shell_cwd_sync_command() -> String {
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

pub(super) fn detect_language(path: &str) -> String {
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
