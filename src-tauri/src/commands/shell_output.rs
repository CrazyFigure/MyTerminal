//! Shell 输出同步协议领域模型。
//! 负责跨分片解析 OSC 标记、过滤初始化回显、维护光标与命令捕获边界。

/// 目录同步标记使用 OSC 控制序列，终端可见内容会被后端过滤，仅把 cwd 元数据传给前端。
const CWD_SYNC_MARKER_PREFIX: &str = "\x1b]6973;MyTerminalCwd=";
/// 提示符标记只由 precmd/PROMPT_COMMAND/PS1 发出；与 cd 中途的 cwd 更新分开，才能安全修正提示符行边界。
const PROMPT_CWD_SYNC_MARKER_PREFIX: &str = "\x1b]6973;MyTerminalPromptCwd=";
/// 命令开始标记由 bash PS0 / zsh preexec 发出，标志用户或 agent 提交的命令即将执行；值为空串。
/// 它是 agent 可见执行捕获输出的左边界，也是判定 shell 具备命令边界能力的唯一依据。
const CMD_BEGIN_MARKER_PREFIX: &str = "\x1b]6973;MyTerminalCmdBegin=";
/// 命令结束标记由 precmd/PROMPT_COMMAND 在最前面发出，值为上一条命令的 exit code。
const CMD_END_MARKER_PREFIX: &str = "\x1b]6973;MyTerminalCmdEnd=";
/// 能力标记只在 PS0/preexec 安装成功后发出一次；后端据此判定该会话能否承载 agent 可见执行。
const CMD_CAPABLE_MARKER_PREFIX: &str = "\x1b]6973;MyTerminalCmdCapable=";
const CWD_SYNC_MARKER_SUFFIX: char = '\x07';
const CWD_SYNC_SETUP_NAME: &str = "__myterminal_sync_cwd";
const CWD_SYNC_HISTORY_PREP_TOKEN: &str = "HIST_IGNORE_SPACE";
/// 部分命令行工具会在绘制进度时隐藏光标，异常返回 shell 时可能漏发恢复序列；提示符边界需要兜底恢复。
const TERMINAL_CURSOR_HIDE_SEQUENCE: &str = "\x1b[?25l";
const TERMINAL_CURSOR_SHOW_SEQUENCE: &str = "\x1b[?25h";
/// AI 可见提示固定使用浅粉色真彩色；专属下划线色是前端识别标记，用于绕过 xterm 对浅色主题的自动压暗。
pub(super) const AGENT_COMMAND_ACCENT_SEQUENCE: &str = "\x1b[1;4;38;2;244;114;182;58;2;1;2;3m";
/// AI 提示结束后立即恢复终端默认样式，禁止命令输出继承浅粉色。
pub(super) const TERMINAL_STYLE_RESET_SEQUENCE: &str = "\x1b[0m";
/// 光标控制序列长度固定为 6 字节，保留前一分片末尾 5 字节即可识别跨 SSH 分片的半截序列。
const TERMINAL_CURSOR_CONTROL_TAIL_BYTES: usize = TERMINAL_CURSOR_HIDE_SEQUENCE.len() - 1;

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

/// Shell 通过 OSC 回传的同步标记类别；解析后按类别决定是更新 cwd、修正提示符行还是切分命令边界。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellSyncMarkerKind {
    /// cd/pushd/popd 中途回传的工作目录。
    Cwd,
    /// 提示符即将绘制，携带工作目录，额外触发提示符行边界修正。
    PromptCwd,
    /// 命令开始执行，agent 可见执行的捕获左边界。
    CommandBegin,
    /// 命令执行结束，值为 exit code，捕获右边界。
    CommandEnd,
    /// 该会话已具备命令边界能力（PS0/preexec 安装成功）。
    CommandCapable,
}

/// 所有同步标记的前缀表；解析与跨分片保留都以它为唯一来源，新增标记只需在此登记一次。
const SHELL_SYNC_MARKERS: [(&str, ShellSyncMarkerKind); 5] = [
    (CWD_SYNC_MARKER_PREFIX, ShellSyncMarkerKind::Cwd),
    (
        PROMPT_CWD_SYNC_MARKER_PREFIX,
        ShellSyncMarkerKind::PromptCwd,
    ),
    (CMD_BEGIN_MARKER_PREFIX, ShellSyncMarkerKind::CommandBegin),
    (CMD_END_MARKER_PREFIX, ShellSyncMarkerKind::CommandEnd),
    (
        CMD_CAPABLE_MARKER_PREFIX,
        ShellSyncMarkerKind::CommandCapable,
    ),
];

/// 找到各类同步标记中最先出现的一类。
/// 注意 MyTerminalCmdBegin/CmdEnd/CmdCapable 互不为前缀，MyTerminalCwd 也不是 MyTerminalCmd* 的前缀，
/// 因此按出现位置取最小即可唯一确定标记类别，不会误匹配。
fn find_next_shell_sync_marker(value: &str) -> Option<(usize, &'static str, ShellSyncMarkerKind)> {
    SHELL_SYNC_MARKERS
        .into_iter()
        .filter_map(|(prefix, kind)| value.find(prefix).map(|index| (index, prefix, kind)))
        .min_by_key(|(index, _, _)| *index)
}

/// 输出分片末尾可能只包含任一标记的前半截；保留最长匹配，下一分片到达后再统一解析。
fn trailing_shell_sync_marker_prefix_len(value: &str) -> usize {
    let mut keep = 0;
    for (marker_prefix, _) in SHELL_SYNC_MARKERS {
        for (index, _) in marker_prefix.char_indices().skip(1) {
            let prefix = &marker_prefix[..index];
            if value.ends_with(prefix) {
                keep = keep.max(prefix.len());
            }
        }
    }
    keep
}

/// agent 捕获缓冲硬上限；超限后停止累加并标记截断，绝不让一条命令的输出在后端无限驻留。
/// 用户可见的滚动缓冲不受影响，仍由 TerminalOutputQueue 与前端 LRU 各自管理。
const AGENT_CAPTURE_MAX_BYTES: usize = 2 * 1024 * 1024;
/// 等待 OSC 标记结束符时 pending 的容量上限；二进制输出里出现孤立的 `\x1b]6973;` 时兜底放行，避免无限缓冲。
const SHELL_SYNC_MARKER_MAX_PENDING_BYTES: usize = 8192;

/// Shell 输出解析出的命令边界事件；agent 可见执行据此拼装 stdout 与退出码。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ShellCommandEvent {
    /// 该会话已确认具备命令边界能力（PS0/preexec 安装成功）。
    Capable,
    /// 一条命令开始执行；仅在已武装捕获时才会真正开始累积输出。
    Begin,
    /// 一条被捕获的命令执行结束，携带 exit code、输出与截断标记。
    End {
        exit_code: Option<i32>,
        captured: String,
        truncated: bool,
    },
}

/// `consume` 的解析结果：可见文本照常上屏，cwd 更新同步文件管理，命令事件驱动 agent 可见执行。
#[derive(Debug, Default)]
pub(super) struct ShellConsumeOutput {
    /// 交给 xterm 的可见内容。
    pub(super) visible: String,
    /// 远端回传的工作目录更新。
    pub(super) cwd_updates: Vec<String>,
    /// 命令边界事件，按出现顺序排列。
    pub(super) command_events: Vec<ShellCommandEvent>,
    /// 本批次内是否有命令开始执行（无论是 agent 注入的还是用户手敲的）。
    /// 用于判定 shell 已离开提示符——用户跑 `tail -f` 时必须据此拒绝注入。
    pub(super) command_started: bool,
    /// 本批次内是否出现了提示符标记。
    /// 必须区分“本批次刚到达提示符”与“持续停在提示符”：用户输入的回显同样发生在提示符状态下，
    /// 若按状态而非事件复位，用户正在敲的半截命令会被误判成已提交。
    pub(super) prompt_arrived: bool,
}

/// 记录跨 SSH 分片的半截 OSC 标记和当前可见行状态，保证同步协议不泄漏且提示符总能从干净新行开始。
pub(super) struct ShellOutputFilter {
    pending: String,
    suppress_setup_echo_line: bool,
    suppress_initial_setup_echo: bool,
    cursor_hidden_by_remote_output: bool,
    cursor_control_tail: String,
    visible_line_dirty: bool,
    visible_line_position_uncertain: bool,
    visible_line_escape_state: TerminalVisibleLineEscapeState,
    visible_line_csi_parameters: String,
    /// 已武装但尚未开始：agent 注入命令前置位，等下一个 Begin 标记才真正开始捕获。
    /// 不武装就不捕获，避免用户手敲的每条命令都在后端白白拷一份输出。
    capture_armed: bool,
    /// 武装后隐藏远端 PTY 对安全包装命令的首行回显；界面已经单独展示不带括号的 AI 业务命令。
    suppress_agent_command_echo: bool,
    /// 是否处于 Begin/End 之间且已武装；为 true 时可见输出会复制一份给 agent。
    capturing: bool,
    /// 当前捕获缓冲与截断标记；End 时随事件一起取走。
    capture_buffer: String,
    capture_truncated: bool,
    /// 远端是否处于 alternate screen（vim/top 等全屏 TUI）；此时严禁注入命令。
    pub(super) alternate_screen_active: bool,
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
            capture_armed: false,
            suppress_agent_command_echo: false,
            capturing: false,
            capture_buffer: String::new(),
            capture_truncated: false,
            alternate_screen_active: false,
        }
    }
}

impl ShellOutputFilter {
    /// 解析普通终端输出、目录同步标记与命令边界标记；可见文本照常上屏，命令事件驱动 agent 可见执行。
    pub(super) fn consume(&mut self, content: &str) -> ShellConsumeOutput {
        self.pending.push_str(content);
        let mut output = ShellConsumeOutput::default();

        loop {
            if let Some((marker_start, marker_prefix, kind)) =
                find_next_shell_sync_marker(&self.pending)
            {
                let before_marker = self.pending[..marker_start].to_string();
                self.push_filtered_visible(&mut output, &before_marker);
                let value_start = marker_start + marker_prefix.len();

                if let Some(value_end) = self.pending[value_start..].find(CWD_SYNC_MARKER_SUFFIX) {
                    let value = self.pending[value_start..value_start + value_end].trim();
                    // 第一次任意标记说明启动注入已执行完毕；之后如果用户历史里出现内部函数名，不能再隐藏 readline 的重绘输出。
                    self.suppress_initial_setup_echo = false;

                    match kind {
                        ShellSyncMarkerKind::Cwd => {
                            if !value.is_empty() {
                                output.cwd_updates.push(value.to_string());
                            }
                        }
                        ShellSyncMarkerKind::PromptCwd => {
                            if !value.is_empty() {
                                output.cwd_updates.push(value.to_string());
                            }
                            // 提示符出现说明上一条命令已彻底结束，shell 正等待输入。
                            output.prompt_arrived = true;
                            self.prepare_prompt_line(&mut output.visible);
                            self.restore_cursor_at_prompt_boundary(&mut output.visible);
                        }
                        ShellSyncMarkerKind::CommandCapable => {
                            output.command_events.push(ShellCommandEvent::Capable);
                        }
                        ShellSyncMarkerKind::CommandBegin => {
                            // 无论谁发起，命令开始就意味着 shell 已离开提示符。
                            output.command_started = true;
                            // Begin 是命令回显的可靠右边界；即使远端没有回显换行，也必须在这里结束抑制。
                            self.suppress_agent_command_echo = false;
                            // 只有 agent 注入前武装过才开始捕获；用户手敲的命令不产生后端拷贝。
                            if self.capture_armed {
                                self.capture_armed = false;
                                self.capturing = true;
                                self.capture_buffer.clear();
                                self.capture_truncated = false;
                                output.command_events.push(ShellCommandEvent::Begin);
                            }
                        }
                        ShellSyncMarkerKind::CommandEnd => {
                            // 没有配对 Begin 时不产生 End，避免启动注入的收尾被误判成一条命令结束。
                            if self.capturing {
                                self.capturing = false;
                                output.command_events.push(ShellCommandEvent::End {
                                    exit_code: value.parse::<i32>().ok(),
                                    captured: std::mem::take(&mut self.capture_buffer),
                                    truncated: std::mem::take(&mut self.capture_truncated),
                                });
                            }
                        }
                    }

                    let remainder_start =
                        value_start + value_end + CWD_SYNC_MARKER_SUFFIX.len_utf8();
                    self.pending = self.pending[remainder_start..].to_string();
                    continue;
                }

                self.pending = self.pending[marker_start..].to_string();
                // 二进制输出里可能出现与标记前缀相同、却永远等不到 \x07 的字节串；
                // 超过上限就当作普通内容放行，避免 pending 无限增长把内存吃光。
                if self.pending.len() > SHELL_SYNC_MARKER_MAX_PENDING_BYTES {
                    let bogus = std::mem::take(&mut self.pending);
                    self.push_filtered_visible(&mut output, &bogus);
                }
                break;
            }

            let keep = trailing_shell_sync_marker_prefix_len(&self.pending);

            let drain_len = self.pending.len().saturating_sub(keep);
            let drainable = self.pending[..drain_len].to_string();
            self.push_filtered_visible(&mut output, &drainable);
            self.pending = self.pending[drain_len..].to_string();
            break;
        }

        output
    }

    /// 写入真正要交给 xterm 的内容，并同步跟踪远端是否把光标切到隐藏状态。
    /// 处于命令执行区间时同一份内容会复制给 agent 捕获缓冲；上限由调用方按设置裁剪。
    fn push_filtered_visible(&mut self, output: &mut ShellConsumeOutput, value: &str) {
        let setup_filtered = self.strip_cwd_sync_setup_echo(value);
        let filtered = self.strip_agent_command_echo(&setup_filtered);
        if filtered.is_empty() {
            return;
        }

        self.track_cursor_visibility_sequences(&filtered);
        self.track_visible_line_state(&filtered);
        if self.capturing {
            self.append_capture(&filtered);
        }
        output.visible.push_str(&filtered);
    }

    /// 武装或取消 agent 捕获。武装后遇到下一个命令开始标记才真正开始累积；
    /// 取消时立即停止捕获并丢弃缓冲，用于超时中止后不再污染下一条命令。
    pub(super) fn set_capture_armed(&mut self, armed: bool) {
        self.capture_armed = armed;
        self.suppress_agent_command_echo = armed;
        if !armed {
            self.capturing = false;
            self.capture_buffer.clear();
            self.capture_truncated = false;
        }
    }

    /// 只隐藏武装后的第一条远端回显行；遇到换行或 Begin 标记立即恢复，命令正文输出始终正常上屏。
    fn strip_agent_command_echo(&mut self, value: &str) -> String {
        if !self.suppress_agent_command_echo {
            return value.to_string();
        }

        let Some(line_end) = value.find('\n') else {
            return String::new();
        };
        self.suppress_agent_command_echo = false;
        value[line_end + 1..].to_string()
    }

    /// 按硬上限追加 agent 捕获内容；超限后置截断标记并停止累加，可见内容不受影响。
    fn append_capture(&mut self, value: &str) {
        if self.capture_truncated {
            return;
        }

        let remaining = AGENT_CAPTURE_MAX_BYTES.saturating_sub(self.capture_buffer.len());
        if value.len() <= remaining {
            self.capture_buffer.push_str(value);
            return;
        }

        // 必须落在 UTF-8 字符边界上，否则截断处会产生非法序列。
        let mut cut = remaining;
        while cut > 0 && !value.is_char_boundary(cut) {
            cut -= 1;
        }
        self.capture_buffer.push_str(&value[..cut]);
        self.capture_truncated = true;
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
                            self.alternate_screen_active = false;
                            self.visible_line_dirty = true;
                            self.visible_line_position_uncertain = true;
                        } else if byte == b'h'
                            && self.visible_line_csi_parameters.starts_with('?')
                            && matches!(first_parameter, Some(47 | 1047 | 1049))
                        {
                            // 进入 alternate screen 说明前台是 vim/top 这类全屏 TUI；
                            // 此时注入命令会被 TUI 当作按键吃掉，agent 必须回退隐藏通道。
                            self.alternate_screen_active = true;
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

    /// 兼容既有单元测试的薄封装：只暴露可见内容与 cwd 更新。
    /// 生产代码一律走 `consume`，确保命令事件不会被静默丢弃。
    #[cfg(test)]
    fn consume_visible(&mut self, content: &str) -> (String, Vec<String>) {
        let output = self.consume(content);
        (output.visible, output.cwd_updates)
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
    use std::sync::Mutex;

    // 这些兼容测试覆盖命令层与输出过滤器的协作，显式引入父命令模块中的队列、cwd 和字体辅助函数。
    use super::super::*;
    use super::super::local_terminal::{
        should_force_claude_synchronized_output, should_force_qwen_synchronized_output,
    };
    use super::*;

    #[test]
    fn keeps_agent_input_guard_dirty_during_backslash_continuation() {
        let agent_pty = Arc::new(Mutex::new(AgentPtyState::default()));
        let signal = Arc::new(Condvar::new());

        // 第一行以单个反斜杠结束时，换行后仍处于同一条逻辑命令，agent 不得趁 PS2 等待态注入。
        track_user_input_activity(&agent_pty, &signal, b"echo first \\");
        track_user_input_activity(&agent_pty, &signal, b"\n");
        assert!(agent_pty.lock().unwrap().user_line_dirty);

        // 后续物理行正常提交后才真正解除占用。
        track_user_input_activity(&agent_pty, &signal, b"second\r");
        assert!(!agent_pty.lock().unwrap().user_line_dirty);
    }

    #[test]
    fn treats_even_trailing_backslashes_as_a_normal_submission() {
        let agent_pty = Arc::new(Mutex::new(AgentPtyState::default()));
        let signal = Arc::new(Condvar::new());

        // 两个行尾反斜杠表示最后一个反斜杠已被转义，Enter 应当按普通提交处理。
        track_user_input_activity(&agent_pty, &signal, b"printf \\\\");
        track_user_input_activity(&agent_pty, &signal, b"\r");
        assert!(!agent_pty.lock().unwrap().user_line_dirty);
    }

    fn cwd_marker(cwd: &str) -> String {
        format!("{CWD_SYNC_MARKER_PREFIX}{cwd}{CWD_SYNC_MARKER_SUFFIX}")
    }

    fn prompt_marker(cwd: &str) -> String {
        format!("{PROMPT_CWD_SYNC_MARKER_PREFIX}{cwd}{CWD_SYNC_MARKER_SUFFIX}")
    }

    fn cmd_begin_marker() -> String {
        format!("{CMD_BEGIN_MARKER_PREFIX}{CWD_SYNC_MARKER_SUFFIX}")
    }

    fn cmd_end_marker(exit_code: &str) -> String {
        format!("{CMD_END_MARKER_PREFIX}{exit_code}{CWD_SYNC_MARKER_SUFFIX}")
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
    fn captures_agent_command_output_between_boundaries() {
        let mut filter = ShellOutputFilter::default();
        filter.set_capture_armed(true);

        let output = filter.consume(&format!(
            "{}total 4\r\nfile.txt\r\n{}",
            cmd_begin_marker(),
            cmd_end_marker("0")
        ));

        // 可见内容照常上屏，协议标记不泄漏。
        assert_eq!(output.visible, "total 4\r\nfile.txt\r\n");
        assert!(!output.visible.contains("MyTerminalCmd"));
        match output.command_events.last() {
            Some(ShellCommandEvent::End {
                exit_code,
                captured,
                truncated,
            }) => {
                assert_eq!(*exit_code, Some(0));
                assert_eq!(captured, "total 4\r\nfile.txt\r\n");
                assert!(!truncated);
            }
            other => panic!("expected End event, got {other:?}"),
        }
    }

    #[test]
    fn hides_agent_wrapper_echo_but_keeps_command_output() {
        let mut filter = ShellOutputFilter::default();
        filter.set_capture_armed(true);

        // 包装命令即使被 SSH 拆成多个分片也不应上屏；换行后的 Begin/End 区间仍正常显示并捕获。
        let first = filter.consume("( cd '/root' && docker ps )\r");
        assert!(first.visible.is_empty());
        let second = filter.consume(&format!(
            "\n{}NAMES\r\ncontainer-a\r\n{}",
            cmd_begin_marker(),
            cmd_end_marker("0")
        ));

        assert_eq!(second.visible, "NAMES\r\ncontainer-a\r\n");
        match second.command_events.last() {
            Some(ShellCommandEvent::End { captured, .. }) => {
                assert_eq!(captured, "NAMES\r\ncontainer-a\r\n");
            }
            other => panic!("expected End event, got {other:?}"),
        }
    }

    #[test]
    fn extracts_non_zero_exit_code_from_end_marker() {
        let mut filter = ShellOutputFilter::default();
        filter.set_capture_armed(true);

        let output = filter.consume(&format!(
            "{}bash: nope: command not found\r\n{}",
            cmd_begin_marker(),
            cmd_end_marker("127")
        ));

        let Some(ShellCommandEvent::End { exit_code, .. }) = output.command_events.last() else {
            panic!("expected End event");
        };
        assert_eq!(*exit_code, Some(127));
    }

    #[test]
    fn does_not_capture_user_commands_without_arming() {
        let mut filter = ShellOutputFilter::default();

        // 未武装时用户手敲的命令不应产生任何捕获事件，避免后端白白拷贝每条命令的输出。
        let output = filter.consume(&format!(
            "{}user typed this\r\n{}",
            cmd_begin_marker(),
            cmd_end_marker("0")
        ));

        assert_eq!(output.visible, "user typed this\r\n");
        assert!(output.command_events.is_empty());
    }

    #[test]
    fn keeps_command_markers_private_when_split_across_chunks() {
        let mut filter = ShellOutputFilter::default();
        filter.set_capture_armed(true);

        // 8192 字节分片可能把标记从任意位置切断；半截前缀必须保留到下一分片再解析。
        let split = CMD_BEGIN_MARKER_PREFIX.len() - 4;
        let first = filter.consume(&CMD_BEGIN_MARKER_PREFIX[..split]);
        assert_eq!(first.visible, "");

        let second = filter.consume(&format!(
            "{}{}out{}",
            &CMD_BEGIN_MARKER_PREFIX[split..],
            CWD_SYNC_MARKER_SUFFIX,
            cmd_end_marker("0")
        ));

        assert_eq!(second.visible, "out");
        assert!(!second.visible.contains("MyTerminalCmdBegin"));
        let Some(ShellCommandEvent::End { captured, .. }) = second.command_events.last() else {
            panic!("expected End event");
        };
        assert_eq!(captured, "out");
    }

    #[test]
    fn reports_command_boundary_capability_marker() {
        let mut filter = ShellOutputFilter::default();
        let output = filter.consume(&format!(
            "{CMD_CAPABLE_MARKER_PREFIX}1{CWD_SYNC_MARKER_SUFFIX}"
        ));

        assert_eq!(output.visible, "");
        assert_eq!(output.command_events, vec![ShellCommandEvent::Capable]);
    }

    #[test]
    fn truncates_capture_beyond_limit_but_keeps_visible_output() {
        let mut filter = ShellOutputFilter::default();
        filter.set_capture_armed(true);
        filter.consume(&cmd_begin_marker());

        // 超过上限后停止累加捕获，但可见内容必须完整交给 xterm。
        let huge = "x".repeat(AGENT_CAPTURE_MAX_BYTES + 2048);
        let flood = filter.consume(&huge);
        assert_eq!(flood.visible.len(), huge.len());

        let finished = filter.consume(&cmd_end_marker("0"));
        let Some(ShellCommandEvent::End {
            captured,
            truncated,
            ..
        }) = finished.command_events.last()
        else {
            panic!("expected End event");
        };
        assert!(truncated);
        assert!(captured.len() <= AGENT_CAPTURE_MAX_BYTES);
    }

    #[test]
    fn tracks_alternate_screen_for_tui_detection() {
        let mut filter = ShellOutputFilter::default();
        assert!(!filter.alternate_screen_active);

        // 进入 alternate screen 说明前台是 vim/top，此时不能注入命令。
        filter.consume("\x1b[?1049h");
        assert!(filter.alternate_screen_active);

        filter.consume("\x1b[?1049l");
        assert!(!filter.alternate_screen_active);
    }

    #[test]
    fn releases_pending_when_marker_never_terminates() {
        let mut filter = ShellOutputFilter::default();

        // 二进制输出里可能出现同前缀却永远等不到 \x07 的字节串，必须兜底放行而不是无限缓冲。
        let bogus = format!("{CMD_BEGIN_MARKER_PREFIX}{}", "A".repeat(9000));
        let output = filter.consume(&bogus);

        assert!(output.visible.contains(&"A".repeat(100)));
    }

    #[test]
    fn restores_cursor_when_prompt_marker_arrives_after_hidden_cursor() {
        let mut filter = ShellOutputFilter::default();
        let input = format!(
            "docker progress{TERMINAL_CURSOR_HIDE_SEQUENCE}{}",
            prompt_marker("/ology/ology-server")
        );

        let (visible, cwd_updates) = filter.consume_visible(&input);

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

        let (visible, cwd_updates) = filter.consume_visible(&input);

        assert_eq!(cwd_updates, vec!["/tmp".to_string()]);
        assert_eq!(visible.matches(TERMINAL_CURSOR_SHOW_SEQUENCE).count(), 1);
    }

    #[test]
    fn tracks_cursor_hide_sequence_split_across_output_chunks() {
        let mut filter = ShellOutputFilter::default();

        let (first_visible, _) = filter.consume_visible("\x1b[?2");
        let (second_visible, _) = filter.consume_visible("5l");
        let (prompt_visible, cwd_updates) = filter.consume_visible(&prompt_marker("/split"));

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

        let (visible, cwd_updates) = filter.consume_visible(&prompt_marker("/visible"));

        assert_eq!(visible, "\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/visible".to_string()]);
    }

    #[test]
    fn moves_prompt_after_output_without_trailing_line_feed() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) =
            filter.consume_visible(&format!("cat tail{}", prompt_marker("/cat")));

        assert_eq!(visible, "cat tail\r\n\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/cat".to_string()]);
    }

    #[test]
    fn preserves_carriage_return_progress_before_clearing_prompt_line() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) =
            filter.consume_visible(&format!("Container Started\r{}", prompt_marker("/docker")));

        assert_eq!(visible, "Container Started\r\r\n\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/docker".to_string()]);
    }

    #[test]
    fn ansi_after_completed_line_does_not_insert_an_extra_blank_line() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) =
            filter.consume_visible(&format!("done\r\n\x1b[0m{}", prompt_marker("/ansi")));

        assert_eq!(visible, "done\r\n\x1b[0m\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/ansi".to_string()]);
    }

    #[test]
    fn cwd_marker_inside_compound_command_does_not_break_the_output_line() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) =
            filter.consume_visible(&format!("before{}after", cwd_marker("/middle")));

        assert_eq!(visible, "beforeafter");
        assert_eq!(cwd_updates, vec!["/middle".to_string()]);
    }

    #[test]
    fn keeps_both_marker_prefixes_private_when_split_across_chunks() {
        let mut filter = ShellOutputFilter::default();
        let cwd_split = CWD_SYNC_MARKER_PREFIX.len() - 3;

        let (cwd_prefix_visible, _) = filter.consume_visible(&CWD_SYNC_MARKER_PREFIX[..cwd_split]);
        let (cwd_visible, cwd_updates) = filter.consume_visible(&format!(
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
            filter.consume_visible(&PROMPT_CWD_SYNC_MARKER_PREFIX[..prompt_split]);
        let (prompt_visible, prompt_updates) = filter.consume_visible(&format!(
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

        let (first_visible, _) = filter.consume_visible("done\r\n\x1b[3");
        let (second_visible, _) = filter.consume_visible("1m");
        let (prompt_visible, cwd_updates) = filter.consume_visible(&prompt_marker("/ansi-split"));

        assert_eq!(first_visible, "done\r\n\x1b[3");
        assert_eq!(second_visible, "1m");
        assert_eq!(prompt_visible, "\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/ansi-split".to_string()]);
    }

    #[test]
    fn preserves_output_when_csi_moves_cursor_back_before_prompt() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) =
            filter.consume_visible(&format!("done\r\n\x1b[1A{}", prompt_marker("/cursor-up")));

        assert_eq!(visible, "done\r\n\x1b[1A\x1b[r\x1b[999B\r\n\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/cursor-up".to_string()]);
    }

    #[test]
    fn clear_screen_keeps_the_next_prompt_on_the_first_clean_line() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) =
            filter.consume_visible(&format!("old\r\n\x1b[H\x1b[2J{}", prompt_marker("/clear")));

        assert_eq!(visible, "old\r\n\x1b[H\x1b[2J\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/clear".to_string()]);
    }

    #[test]
    fn erased_progress_line_does_not_create_an_unneeded_blank_line() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) = filter.consume_visible(&format!(
            "progress\r\x1b[2K{}",
            prompt_marker("/erased-progress")
        ));

        assert_eq!(visible, "progress\r\x1b[2K\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/erased-progress".to_string()]);
    }

    #[test]
    fn dec_cursor_restore_preserves_the_saved_output_line() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) = filter.consume_visible(&format!(
            "body\x1b7\r\n\x1b8{}",
            prompt_marker("/dec-restore")
        ));

        assert_eq!(visible, "body\x1b7\r\n\x1b8\x1b[r\x1b[999B\r\n\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/dec-restore".to_string()]);
    }

    #[test]
    fn erase_scrollback_does_not_mark_visible_body_as_cleared() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) =
            filter.consume_visible(&format!("body\x1b[3J{}", prompt_marker("/scrollback")));

        assert_eq!(visible, "body\x1b[3J\r\n\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/scrollback".to_string()]);
    }

    #[test]
    fn alternate_screen_restore_preserves_the_main_buffer_line() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) = filter.consume_visible(&format!(
            "\r\n\x1b[?1049l{}",
            prompt_marker("/alternate-screen")
        ));

        assert_eq!(visible, "\r\n\x1b[?1049l\x1b[r\x1b[999B\r\n\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/alternate-screen".to_string()]);
    }

    #[test]
    fn line_feed_after_cursor_positioning_does_not_clear_an_existing_row() {
        let mut filter = ShellOutputFilter::default();

        let (visible, cwd_updates) = filter.consume_visible(&format!(
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

        let (visible, cwd_updates) = filter.consume_visible(&format!(
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

        let (visible, cwd_updates) = filter.consume_visible(&format!(
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
            filter.consume_visible(&format!("body\x1b[?2J{}", prompt_marker("/private-ed")));

        assert_eq!(visible, "body\x1b[?2J\r\n\r\x1b[2K");
        assert_eq!(cwd_updates, vec!["/private-ed".to_string()]);
    }

    #[test]
    fn decstbm_reset_preserves_body_after_moving_the_cursor_home() {
        let mut filter = ShellOutputFilter::default();

        // DECSTBM 即使不带参数也会把 xterm 光标移回 Home；提示符必须先转移到底部空行，不能清掉首行正文。
        let (visible, cwd_updates) =
            filter.consume_visible(&format!("body\r\n\x1b[r{}", prompt_marker("/decstbm")));

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
        // 退出码显式作为参数传给同步函数：dispatcher 此时已跑过用户原 hook，$? 不再可信。
        assert!(
            command.contains("__myterminal_sync_prompt \"$__myterminal_prompt_status\"; return 0;")
        );
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
