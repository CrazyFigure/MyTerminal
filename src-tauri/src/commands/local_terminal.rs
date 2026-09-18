//! 本地终端 PTY 适配器。

use std::{
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    sync::{mpsc, mpsc::RecvTimeoutError, Arc},
    thread,
    time::Duration,
};

use portable_pty::{CommandBuilder, PtySize};

use crate::{
    models::{LocalTerminalProfile, LocalTerminalSettings, LocalTerminalShellConfig},
    state::{SessionControl, TerminalOutputQueue},
};

use super::{
    queue_output, queue_session_status, queue_terminal_size, DEFAULT_LOCAL_SHELL_CANDIDATES,
};

/// 本地终端启动目标：Shell 可执行文件、附加参数，以及作为参数交给 Shell 执行的预设命令。
struct LocalTerminalTarget {
    shell_path: String,
    shell_args: Vec<String>,
    /// 为空表示交互式打开 Shell；非空时作为命令传给 Shell 执行。
    run_command: String,
    /// 降级说明（例如引用的系统终端已失效）；非空时在会话首屏提示用户。
    notice: Option<String>,
}

/// 在用户已开启的系统终端中按 id 查找可用的 Shell 配置。
/// 开关关闭或命令为空的项视为不可用，避免已被用户隐藏的终端仍被静默使用。
fn find_enabled_shell<'a>(
    settings: &'a LocalTerminalSettings,
    id: &str,
) -> Option<&'a LocalTerminalShellConfig> {
    settings
        .shells
        .iter()
        .find(|shell| shell.id == id && shell.enabled && !shell.command.trim().is_empty())
}

/// 解析预设命令与交互式启动默认使用的系统终端。
/// 优先级：用户显式选择的默认终端 → 手动填写的 Shell 路径 → 已开启的第一个系统终端 → 系统探测兜底。
/// 显式选择优先于手动路径，保证下拉框始终能反映并覆盖实际生效的终端；手动路径仅在未选择时生效，
/// 以兼容历史上只填路径的配置。
fn resolve_default_shell(settings: &LocalTerminalSettings) -> (String, Vec<String>) {
    let selected_id = settings.default_shell_id.trim();
    if !selected_id.is_empty() {
        if let Some(shell) = find_enabled_shell(settings, selected_id) {
            return (shell.command.trim().to_string(), shell.args.clone());
        }
    }

    let configured = settings.shell_path.trim();
    if !configured.is_empty() {
        return (configured.to_string(), Vec::new());
    }

    // 用户已完成过系统终端检测时，直接采用已开启列表的第一项，彻底摆脱硬编码盘符路径。
    if let Some(shell) = settings
        .shells
        .iter()
        .find(|shell| shell.enabled && !shell.command.trim().is_empty())
    {
        return (shell.command.trim().to_string(), shell.args.clone());
    }

    (probe_default_shell_path(), Vec::new())
}

/// 未检测到任何系统终端时的最后兜底：按候选顺序探测真实存在的可执行文件。
/// 绝对路径以文件系统存在性为准；相对名交给系统 PATH 解析，避免旧实现里
/// `绝对 && 存在 || 非绝对` 的优先级问题在首个候选缺失时直接短落到相对名，
/// 既无法回退到 Windows PowerShell 也无法给出缺失信号。
fn probe_default_shell_path() -> String {
    for candidate in DEFAULT_LOCAL_SHELL_CANDIDATES {
        let path = Path::new(candidate);
        if path.is_absolute() {
            if path.is_file() {
                return (*candidate).to_string();
            }
            continue;
        }
        if resolve_executable_in_path(candidate).is_some() {
            return (*candidate).to_string();
        }
    }

    // 全部候选均未命中时返回首个候选，让启动阶段给出明确错误而不是静默使用错误终端。
    DEFAULT_LOCAL_SHELL_CANDIDATES
        .first()
        .copied()
        .unwrap_or_default()
        .to_string()
}

/// Windows 复用系统终端探测器里的 where.exe 查找，保持两处 PATH 语义完全一致。
#[cfg(windows)]
fn resolve_executable_in_path(executable: &str) -> Option<PathBuf> {
    super::shell_detector::find_executable_in_path(executable)
}

/// 类 Unix 系统按 PATH 逐目录查找，语义与 which 一致。
#[cfg(not(windows))]
fn resolve_executable_in_path(executable: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var)
        .map(|dir| dir.join(executable))
        .find(|candidate| candidate.is_file())
}

fn resolve_local_target(
    settings: &LocalTerminalSettings,
    profile_command: &str,
) -> LocalTerminalTarget {
    let trimmed = profile_command.trim();
    if let Some(shell_id) = trimmed.strip_prefix("shell:") {
        if let Some(shell) = settings.shells.iter().find(|shell| shell.id == shell_id) {
            return LocalTerminalTarget {
                shell_path: shell.command.trim().to_string(),
                shell_args: shell.args.clone(),
                run_command: String::new(),
                notice: None,
            };
        }
        // 引用的系统终端已被删除或尚未检测：提示并退回默认终端交互打开，
        // 不再把 "shell:xxx" 原样当作命令执行，避免输出一行无意义的启动失败。
        let (shell_path, shell_args) = resolve_default_shell(settings);
        return LocalTerminalTarget {
            shell_path,
            shell_args,
            run_command: String::new(),
            notice: Some(format!("未找到系统终端 {shell_id}，已改用默认终端打开。")),
        };
    }

    let (shell_path, shell_args) = resolve_default_shell(settings);
    LocalTerminalTarget {
        shell_path,
        shell_args,
        run_command: trimmed.to_string(),
        notice: None,
    }
}

/// 依据 Shell 主名返回“执行单条命令字符串”所需的参数开关。
/// 统一走命令字符串入口，避免把命令当作脚本文件名解析。
/// bash/sh/zsh/ksh 用 -lc 加载 profile（AI CLI 常装在 ~/.npm-global、nvm 等依赖 profile 的路径下），
/// 其余常见 Shell 只提供 -c 语义；返回 None 的终端（cmd / wsl / 未知终端）由调用方单独处理。
fn shell_command_flag(shell_stem: &str) -> Option<&'static str> {
    match shell_stem {
        "bash" | "sh" | "zsh" | "ksh" => Some("-lc"),
        "dash" | "ash" | "fish" | "csh" | "tcsh" | "nu" | "nushell" | "xonsh" | "elvish" => {
            Some("-c")
        }
        _ => None,
    }
}

/// 去掉 Windows 可执行文件后缀，让 shell_command_flag 只需匹配 Shell 主名。
fn strip_executable_suffix(shell_name: &str) -> String {
    shell_name
        .strip_suffix(".exe")
        .unwrap_or(shell_name)
        .to_ascii_lowercase()
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

/// 按 Shell 主名拼装“执行一条命令字符串”的启动参数。
/// 统一按可执行名分流而不是按构建平台分流：PowerShell 7 在 Linux/macOS 上同样存在，
/// 名字判定覆盖面更全，也不会因为平台条件编译漏掉某个终端。
fn build_local_terminal_command(
    shell_path: &str,
    shell_args: &[String],
    command: &str,
) -> CommandBuilder {
    let shell_name = Path::new(shell_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(shell_path)
        .to_ascii_lowercase();
    let mut builder = CommandBuilder::new(shell_path);
    if !shell_args.is_empty() {
        builder.args(shell_args);
    }
    let trimmed_command = command.trim();
    if trimmed_command.is_empty() {
        return builder;
    }
    let shell_stem = strip_executable_suffix(&shell_name);

    if shell_name.contains("powershell") || shell_name.contains("pwsh") {
        // PowerShell 5/7 统一走 -Command，并保留 -NoExit 让预设命令退出后仍停在会话里。
        builder.args(["-NoLogo", "-NoExit", "-Command", command]);
    } else if shell_stem == "cmd" {
        builder.args(["/K", command]);
    } else if shell_stem == "wsl" {
        // wsl.exe 是 exec 语义：整串命令会被当成单个可执行文件名（`dsh web` 必然 not found），
        // 因此显式交给发行版内的登录交互 bash 执行，PATH / profile 与用户日常一致。
        builder.args(["--", "bash", "-lic", command]);
    } else if let Some(flag) = shell_command_flag(&shell_stem) {
        // Git Bash 等 POSIX Shell 必须走命令字符串入口：直接透传会被当成脚本文件名读取而报错。
        builder.args([flag, command]);
    } else {
        apply_unknown_shell_command(&mut builder, command);
    }
    builder
}

/// 未识别终端的兜底：Windows 保持裸参数语义（mintty 等终端期望该形式），
/// 类 Unix 沿用历史上更通用的 -lc 命令字符串入口。
fn apply_unknown_shell_command(builder: &mut CommandBuilder, command: &str) {
    #[cfg(windows)]
    {
        builder.arg(command);
    }
    #[cfg(not(windows))]
    {
        builder.args(["-lc", command]);
    }
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
        let target = resolve_local_target(&settings, &profile.command);
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

        // 几何登记之后再提示降级说明，保证首屏文本按正确列宽回放。
        if let Some(notice) = target.notice.as_deref() {
            queue_output(
                &output_queue,
                &app_handle,
                &session_id,
                format!("\r\n{notice}\r\n"),
            );
        }

        let mut command = build_local_terminal_command(
            &target.shell_path,
            &target.shell_args,
            &target.run_command,
        );
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一个只包含默认终端解析相关字段的设置对象，其余字段用默认值填充。
    fn build_settings(
        default_shell_id: &str,
        shell_path: &str,
        shells: Vec<LocalTerminalShellConfig>,
    ) -> LocalTerminalSettings {
        LocalTerminalSettings {
            shell_path: shell_path.to_string(),
            default_shell_id: default_shell_id.to_string(),
            shells,
            ..Default::default()
        }
    }

    /// 构造系统终端配置；测试只关心 id、命令、参数与开关状态。
    fn build_shell(
        id: &str,
        command: &str,
        args: &[&str],
        enabled: bool,
    ) -> LocalTerminalShellConfig {
        LocalTerminalShellConfig {
            id: id.to_string(),
            name: id.to_string(),
            command: command.to_string(),
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
            icon: None,
            enabled,
        }
    }

    #[test]
    fn resolve_default_shell_prefers_explicit_selection() {
        let settings = build_settings(
            "wsl-ubuntu",
            "C:\\manual\\sh.exe",
            vec![
                build_shell("pwsh-7", "C:\\pwsh.exe", &[], true),
                build_shell("wsl-ubuntu", "C:\\wsl.exe", &["-d", "Ubuntu"], true),
            ],
        );

        let (path, args) = resolve_default_shell(&settings);
        assert_eq!(path, "C:\\wsl.exe");
        // 系统终端自带的参数必须一并生效，否则 WSL 会落到默认发行版。
        assert_eq!(args, vec!["-d".to_string(), "Ubuntu".to_string()]);
    }

    #[test]
    fn resolve_default_shell_skips_disabled_selection() {
        let settings = build_settings(
            "pwsh-7",
            "C:\\manual\\sh.exe",
            vec![build_shell("pwsh-7", "C:\\pwsh.exe", &[], false)],
        );

        // 关闭的系统终端不再生效，回落到手动填写的路径。
        let (path, args) = resolve_default_shell(&settings);
        assert_eq!(path, "C:\\manual\\sh.exe");
        assert!(args.is_empty());
    }

    #[test]
    fn resolve_default_shell_falls_back_to_first_enabled_shell() {
        let settings = build_settings(
            "",
            "",
            vec![
                build_shell("pwsh-7", "C:\\pwsh.exe", &[], false),
                build_shell("git-bash", "C:\\git\\bash.exe", &[], true),
            ],
        );

        let (path, _) = resolve_default_shell(&settings);
        assert_eq!(path, "C:\\git\\bash.exe");
    }

    #[test]
    fn resolve_default_shell_prefers_manual_path_over_shell_list() {
        let settings = build_settings(
            "",
            "C:\\custom\\cmd.exe",
            vec![build_shell("git-bash", "C:\\git\\bash.exe", &[], true)],
        );

        let (path, _) = resolve_default_shell(&settings);
        assert_eq!(path, "C:\\custom\\cmd.exe");
    }

    #[test]
    fn resolve_local_target_passes_preset_command_to_default_shell() {
        let settings = build_settings(
            "pwsh-7",
            "",
            vec![build_shell("pwsh-7", "C:\\pwsh.exe", &[], true)],
        );

        let target = resolve_local_target(&settings, "  claude --model sonnet  ");
        assert_eq!(target.shell_path, "C:\\pwsh.exe");
        assert_eq!(target.run_command, "claude --model sonnet");
        assert!(target.notice.is_none());
    }

    #[test]
    fn resolve_local_target_degrades_when_shell_reference_missing() {
        let settings = build_settings(
            "pwsh-7",
            "",
            vec![build_shell("pwsh-7", "C:\\pwsh.exe", &[], true)],
        );

        // 引用已失效的系统终端时必须退回交互式默认终端，并把 "shell:xxx" 变成可见提示而不是待执行命令。
        let target = resolve_local_target(&settings, "shell:removed-shell");
        assert_eq!(target.shell_path, "C:\\pwsh.exe");
        assert!(target.run_command.is_empty());
        assert!(target.notice.unwrap().contains("removed-shell"));
    }

    #[test]
    fn strip_executable_suffix_normalizes_windows_names() {
        assert_eq!(strip_executable_suffix("Bash.EXE"), "bash");
        assert_eq!(strip_executable_suffix("pwsh"), "pwsh");
    }

    /// 把 CommandBuilder 的完整 argv 转成便于断言的字符串列表。
    fn argv_of(builder: &CommandBuilder) -> Vec<String> {
        builder
            .get_argv()
            .iter()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn build_command_adapts_to_common_shells() {
        // 覆盖列表与「系统终端」检测结果对齐：PowerShell 7/5、CMD、Git Bash、WSL、Nushell，以及类 Unix 的 fish。
        let cases: [(&str, &[&str], &[&str]); 8] = [
            (
                "pwsh.exe",
                &[],
                &["-NoLogo", "-NoExit", "-Command", "dsh web"],
            ),
            (
                "powershell.exe",
                &[],
                &["-NoLogo", "-NoExit", "-Command", "dsh web"],
            ),
            ("cmd.exe", &[], &["/K", "dsh web"]),
            ("bash.exe", &[], &["-lc", "dsh web"]),
            ("sh.exe", &[], &["-lc", "dsh web"]),
            ("nu.exe", &[], &["-c", "dsh web"]),
            (
                "wsl.exe",
                &["-d", "Ubuntu"],
                &["-d", "Ubuntu", "--", "bash", "-lic", "dsh web"],
            ),
            ("/usr/bin/fish", &[], &["-c", "dsh web"]),
        ];

        for (path, extra_args, tail) in cases {
            let shell_args: Vec<String> = extra_args.iter().map(|arg| (*arg).to_string()).collect();
            // 前后空白必须被裁剪，否则命令字符串会原样带进 shell 参数。
            let builder = build_local_terminal_command(path, &shell_args, "  dsh web  ");

            let mut expected = vec![path.to_string()];
            expected.extend(extra_args.iter().map(|arg| (*arg).to_string()));
            expected.extend(tail.iter().map(|arg| (*arg).to_string()));

            assert_eq!(argv_of(&builder), expected, "参数不符预期: {path}");
        }
    }

    #[test]
    fn build_command_uses_shell_file_name_not_full_path() {
        // 判定依据必须是可执行文件名：带空格与反斜杠的完整路径不能影响分流。
        let shell_path = "C:\\Program Files\\Git\\bin\\bash.exe";
        let argv = argv_of(&build_local_terminal_command(shell_path, &[], "claude"));

        assert_eq!(argv.len(), 3);
        assert_eq!(argv[1], "-lc");
        assert_eq!(argv[2], "claude");
    }

    #[test]
    fn build_command_without_preset_command_keeps_shell_interactive() {
        let shell_args = vec!["-d".to_string(), "Ubuntu".to_string()];
        let builder = build_local_terminal_command("wsl.exe", &shell_args, "   ");

        // 空命令表示只开交互会话，不能追加任何命令执行参数。
        let expected: Vec<String> = ["wsl.exe", "-d", "Ubuntu"]
            .iter()
            .map(|arg| (*arg).to_string())
            .collect();
        assert_eq!(argv_of(&builder), expected);
    }

    #[test]
    fn shell_command_flag_matches_known_shell_stems() {
        assert_eq!(shell_command_flag("bash"), Some("-lc"));
        assert_eq!(shell_command_flag("zsh"), Some("-lc"));
        assert_eq!(shell_command_flag("nu"), Some("-c"));
        // 未知终端保持裸命令参数语义，交由 wsl / cmd 等专门分支处理。
        assert_eq!(shell_command_flag("wsl"), None);
    }
}
