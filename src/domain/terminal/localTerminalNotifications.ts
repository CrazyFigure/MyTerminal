/* 本地终端任务完成与待输入检测领域规则：纯函数与纯状态机，不依赖 React、Zustand、DOM 与 Tauri。 */

import { normalizeTerminalSessionTopic } from './terminalTitle';

export type LocalTerminalNotificationKind = 'completed' | 'needs_input';

export type LocalTerminalSignal =
  | { type: 'bell' }
  | { type: 'title'; title: string }
  | { type: 'osc_notify'; source: 'osc9' | 'osc777' | 'osc99'; title?: string; body: string }
  | { type: 'osc133_prompt' }
  | { type: 'osc133_start' }
  | { type: 'osc133_end'; exitCode?: number }
  | { type: 'shell_cwd' };

export type LocalTerminalOsc99Buffer = {
  id?: string;
  title?: string;
  body?: string;
};

export type LocalTerminalSignalScannerState = {
  pending: string;
  osc99?: LocalTerminalOsc99Buffer;
};

export type LocalTerminalSignalScanResult = {
  signals: LocalTerminalSignal[];
  state: LocalTerminalSignalScannerState;
};

export type TerminalTitleActivityState = 'working' | 'needs_input' | 'idle' | 'neutral';

export type LocalTerminalViewportAssessment = {
  isActivelyWorking: boolean;
  needsInputPrompt: boolean;
  isAtIdlePrompt: boolean;
  isFreshTuiWelcome: boolean;
  summary?: string;
};

export type LocalTerminalNotificationDecision = {
  kind: LocalTerminalNotificationKind;
  title?: string;
  body: string;
  source: 'osc' | 'bell' | 'title' | 'osc133' | 'viewport';
};

export type LocalTerminalTrackerConfig = {
  sessionId: string;
  sessionTitle: string;
  localCommand: string;
  createdAtMs: number;
};

const MAX_PENDING_SIGNAL_LENGTH = 4096;
const BEL_INPUT_SUPPRESS_MS = 1500;
const BEL_STARTUP_SUPPRESS_MS = 2000;
const RESIZE_REDRAW_SUPPRESS_MS = 1200;
const GENERIC_MIN_WORK_DURATION_MS = 3000;
const AGENT_MIN_WORK_DURATION_MS = 1200;
const NOTIFICATION_COOLDOWN_MS = 4500;

export const LOCAL_TERMINAL_OUTPUT_SETTLE_DELAY_MS = 1600;
export const LOCAL_TERMINAL_SIGNAL_SETTLE_DELAY_MS = 350;

// 盲文点阵旋转帧（排除 U+2800 空白盲文），Claude/OpenCode/Codex 常用于标题动画。
const BRAILLE_SPINNER_PATTERN = /[\u2801-\u28FF]/;
const WORKING_TITLE_PATTERN = /^(?:working|thinking|running|busy|generating|processing)\b[\s.…]*(?:\(.*\))?$/i;
const IDLE_TITLE_PATTERN = /^(?:ready|idle|done|finished|completed)\b[\s.…]*(?:\(.*\))?$/i;
const NEEDS_INPUT_TITLE_PATTERN =
  /action required|needs?\s+(?:your\s+)?(?:input|attention|approval|confirmation)|permission\s+required|waiting\s+for\s+(?:input|approval|confirmation)|(?:需要|等待)(?:确认|输入|授权|批准)/i;
const SHELL_DEFAULT_TITLES = new Set([
  'windows powershell',
  'powershell',
  'pwsh',
  'command prompt',
  '命令提示符',
  'cmd',
  'bash',
  'zsh',
  'fish',
]);

const INPUT_OR_APPROVAL_TEXT_PATTERN =
  /action required|approval|permission|confirm(?:ation)?|question|waiting\s+for\s+(?:input|approval|user)|needs?\s+(?:your\s+)?(?:attention|input|approval)|select\s+an\s+option|确认|授权|批准|询问|等待输入|需要输入/i;

const ACTIVE_INTERRUPT_PATTERN = /\b(?:esc|ctrl\s*\+\s*c)\s+to\s+interrupt\b/i;
const ACTIVE_STATUS_SPINNER_PATTERN =
  /^(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠂⠄⠁⠈⠐⠠•·✻✽✶✢✦⏳🔄]\s*)?(?:thinking|working|running|searching|reading|writing|editing|analyzing|planning|generating|processing|evaluating)\b.*(?:\(\s*\d+[smh]|\.{3}|…|$)/i;
const ACTIVE_TOKEN_PROGRESS_PATTERN = /\b\d+[smh]\s*·\s*[↓↑]\s*[\d.]+k?\s*tokens\b/i;

const INTERACTIVE_APPROVAL_PATTERNS: readonly RegExp[] = [
  /do you want to (?:proceed|make this edit|create|run|delete|overwrite|continue)\b/i,
  /would you like to (?:run the following command|make the following edits|approve)\b/i,
  /\ballow once\b/i,
  /\ballow for this session\b/i,
  /\bno,\s*and\s+tell\s+(?:claude|codex|me)\s+what\s+to\s+do\b/i,
  /\byes,\s*proceed\b/i,
  /\byes,\s*and\s+don'?t\s+ask\s+again\b/i,
  /\bpress enter to confirm\b/i,
  /\benter to select\b.*\besc to cancel\b/i,
  /\baction required\b/i,
  /\bpermission required\b/i,
  /\bwaiting for (?:user )?(?:input|approval|confirmation)\b/i,
];

const GENERIC_CONFIRM_PROMPT_PATTERNS: readonly RegExp[] = [
  /\[(?:y\/n|yes\/no)\]/i,
  /\((?:y\/n|yes\/no)\)\s*:?\s*$/i,
  /\b(?:press enter to continue|press any key to continue|enter your choice|proceed\?|continue\?|confirm\?)\s*$/i,
  /\bare you sure\b[^?\n]*\?\s*$/i,
  /(?:是否继续|是否允许|是否确认|请确认|请输入|请选择|按回车继续|按任意键继续)[？?:：\s]*$/,
];

const AI_TUI_FOOTER_HINTS: readonly RegExp[] = [
  /\?\s*for\s+shortcuts\b/i,
  /\bshift\s*\+\s*tab\s+to\s+cycle\b/i,
  /\bcontext\s+left\b/i,
  /\btype\s+your\s+message\b/i,
  /\bask\s+anything\b/i,
  /\bfor\s+help\b/i,
  /\baccept\s+edits\s+on\b/i,
];

const SHELL_PROMPT_PATTERNS: readonly RegExp[] = [
  /^PS\s+.+>\s*$/,
  /^[A-Za-z]:\\[^>]*>\s*$/,
  /^(?:\([^)]+\)\s*)?[^\s@]+@[^\s:]+:.*[$#%]\s*$/,
  /^(?:~|\/[\w./-]*)\s*[$#%❯➜]\s*$/,
];

const FRESH_TUI_WELCOME_PATTERNS: readonly RegExp[] = [
  /\bwelcome to claude code\b/i,
  /\bopenai codex\b/i,
  /\btips for getting started\b/i,
];

const BORDER_ONLY_LINE_PATTERN = /^[\s─━═\-|+╭╮╯╰┌┐└┘├┤┬┴┼]+$/;

const decodeBase64Utf8 = (input: string): string => {
  try {
    if (typeof atob === 'function') {
      const binary = atob(input);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new TextDecoder().decode(bytes);
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(input, 'base64').toString('utf8');
    }
  } catch {
    return input;
  }
  return input;
};

const parseOsc99Sequence = (
  payload: string,
  buffer: LocalTerminalOsc99Buffer | undefined,
): { signal?: LocalTerminalSignal; nextBuffer?: LocalTerminalOsc99Buffer } => {
  const separatorIndex = payload.indexOf(';');
  const metaText = separatorIndex === -1 ? payload : payload.slice(0, separatorIndex);
  const rawBody = separatorIndex === -1 ? '' : payload.slice(separatorIndex + 1);
  const meta: Record<string, string> = {};
  metaText.split(':').forEach((pair) => {
    const eqIndex = pair.indexOf('=');
    if (eqIndex > 0) {
      meta[pair.slice(0, eqIndex)] = pair.slice(eqIndex + 1);
    }
  });

  const decoded = meta.e === '1' ? decodeBase64Utf8(rawBody) : rawBody;
  const part = meta.p ?? 'body';
  const done = meta.d !== '0';
  const id = meta.i;
  const nextBuffer: LocalTerminalOsc99Buffer =
    buffer && (!id || !buffer.id || buffer.id === id) ? { ...buffer, id } : { id };

  if (part === 'title') {
    nextBuffer.title = (nextBuffer.title ?? '') + decoded;
  } else if (part === 'body' || !meta.p) {
    nextBuffer.body = (nextBuffer.body ?? '') + decoded;
  }

  if (!done) {
    return { nextBuffer };
  }

  const title = nextBuffer.title?.trim() || undefined;
  const body = (nextBuffer.body ?? '').trim();
  if (!title && !body) {
    return { nextBuffer: undefined };
  }
  return {
    signal: { type: 'osc_notify', source: 'osc99', title, body },
    nextBuffer: undefined,
  };
};

// 解析跨分片的本地终端信号：区分独立 BEL 与 OSC 结束符 \x07，过滤 ConEmu 进度/CWD 子命令。
export const scanLocalTerminalSignals = (
  content: string,
  previousState?: LocalTerminalSignalScannerState,
): LocalTerminalSignalScanResult => {
  const text = (previousState?.pending ?? '') + content;
  const signals: LocalTerminalSignal[] = [];
  let osc99Buffer = previousState?.osc99;
  let pending = '';
  let cursor = 0;

  while (cursor < text.length) {
    const escIndex = text.indexOf('\x1b', cursor);
    const belIndex = text.indexOf('\x07', cursor);

    if (escIndex === -1 && belIndex === -1) {
      break;
    }

    if (belIndex !== -1 && (escIndex === -1 || belIndex < escIndex)) {
      signals.push({ type: 'bell' });
      cursor = belIndex + 1;
      continue;
    }

    // 处理 ESC 引导序列
    cursor = escIndex;
    if (cursor + 1 >= text.length) {
      pending = text.slice(cursor);
      break;
    }

    const introducer = text[cursor + 1];
    if (introducer === ']') {
      const bodyStart = cursor + 2;
      const oscBel = text.indexOf('\x07', bodyStart);
      const oscSt = text.indexOf('\x1b\\', bodyStart);
      const end =
        oscBel === -1
          ? oscSt
          : oscSt === -1
            ? oscBel
            : Math.min(oscBel, oscSt);

      if (end === -1) {
        const unterminated = text.slice(cursor);
        pending = unterminated.length > MAX_PENDING_SIGNAL_LENGTH ? '' : unterminated;
        break;
      }

      const payload = text.slice(bodyStart, end);
      if (payload.startsWith('0;') || payload.startsWith('2;')) {
        signals.push({ type: 'title', title: payload.slice(2) });
      } else if (payload.startsWith('9;')) {
        const body = payload.slice(2);
        // ConEmu / Windows Terminal 把 OSC 9;<数字>;... 用于进度条(9;4)和 CWD(9;9) 等控制协议，不能误报为系统通知。
        if (/^\d+(?:;|$)/.test(body)) {
          if (body.startsWith('9;')) {
            signals.push({ type: 'shell_cwd' });
          }
        } else if (body.trim()) {
          signals.push({ type: 'osc_notify', source: 'osc9', body: body.trim() });
        }
      } else if (payload.startsWith('777;notify;')) {
        const rest = payload.slice('777;notify;'.length);
        const sep = rest.indexOf(';');
        const title = (sep === -1 ? rest : rest.slice(0, sep)).trim();
        const body = (sep === -1 ? '' : rest.slice(sep + 1)).trim();
        if (title || body) {
          signals.push({
            type: 'osc_notify',
            source: 'osc777',
            title: title || undefined,
            body,
          });
        }
      } else if (payload.startsWith('99;')) {
        const parsed = parseOsc99Sequence(payload.slice(3), osc99Buffer);
        osc99Buffer = parsed.nextBuffer;
        if (parsed.signal) {
          signals.push(parsed.signal);
        }
      } else if (payload.startsWith('133;')) {
        const kind = payload.slice(4);
        if (kind === 'A' || kind.startsWith('A;')) {
          signals.push({ type: 'osc133_prompt' });
        } else if (kind === 'C' || kind.startsWith('C;')) {
          signals.push({ type: 'osc133_start' });
        } else if (kind === 'D' || kind.startsWith('D;')) {
          const codeText = kind.startsWith('D;') ? kind.slice(2).split(';')[0] : '';
          const parsedCode = codeText ? Number.parseInt(codeText, 10) : Number.NaN;
          signals.push({
            type: 'osc133_end',
            exitCode: Number.isFinite(parsedCode) ? parsedCode : undefined,
          });
        }
      }

      cursor = end + (end === oscSt ? 2 : 1);
      continue;
    }

    // DCS / APC / PM / SOS 字符串内部以 ST（ESC \）结束，吞掉其中的 \x07 避免误判为铃声。
    if (introducer === 'P' || introducer === '_' || introducer === '^' || introducer === 'X') {
      const stringEnd = text.indexOf('\x1b\\', cursor + 2);
      if (stringEnd === -1) {
        const unterminated = text.slice(cursor);
        if (unterminated.length <= MAX_PENDING_SIGNAL_LENGTH) {
          pending = unterminated;
          break;
        }
        cursor += 2;
        continue;
      }
      cursor = stringEnd + 2;
      continue;
    }

    cursor += 2;
  }

  return {
    signals,
    state: { pending, osc99: osc99Buffer },
  };
};

// 判断 OSC 0/2 标题表达的是运行中、需要确认/输入、空闲完成还是纯主题。
export const classifyTerminalTitleActivity = (
  rawTitle: string,
  sessionTitle: string,
  localCommand: string,
): TerminalTitleActivityState => {
  const cleaned = rawTitle.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  if (!cleaned) {
    return 'idle';
  }
  if (NEEDS_INPUT_TITLE_PATTERN.test(cleaned)) {
    return 'needs_input';
  }
  if (BRAILLE_SPINNER_PATTERN.test(cleaned) || cleaned.startsWith('✦') || cleaned.startsWith('⏳')) {
    return 'working';
  }

  const normalized = normalizeTerminalSessionTopic(cleaned, sessionTitle, localCommand);
  const stripped = cleaned
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim();

  if (WORKING_TITLE_PATTERN.test(stripped)) {
    return 'working';
  }
  if (
    cleaned.startsWith('✳') ||
    cleaned.startsWith('✻') ||
    cleaned.startsWith('✱') ||
    cleaned.startsWith('◇') ||
    IDLE_TITLE_PATTERN.test(stripped)
  ) {
    return 'idle';
  }
  if (
    /\.exe\b/i.test(cleaned) ||
    /^[a-z]:[\\/]/i.test(cleaned) ||
    /^[^\s@]+@[^\s:]+:/.test(cleaned) ||
    SHELL_DEFAULT_TITLES.has(cleaned.toLowerCase())
  ) {
    return 'idle';
  }
  if (normalized.type === 'clear') {
    return 'idle';
  }
  return 'neutral';
};

const isLikelyNaturalQuestionLine = (line: string): boolean => {
  const trimmed = line.trim();
  if (trimmed.length < 8 || trimmed.length > 180) {
    return false;
  }
  if (!trimmed.endsWith('?') && !trimmed.endsWith('？')) {
    return false;
  }
  // 排除提示符回显、URL 查询串、Shell 命令和代码表达式。
  if (
    /^[❯›>$#%•●✓✔✗✘+-]\s/.test(trimmed) ||
    /https?:\/\//i.test(trimmed) ||
    /^\s*(?:const|let|var|function|return|if|for|while|import|export|SELECT|curl|git)\b/i.test(trimmed) ||
    /[{};`]|=>/.test(trimmed)
  ) {
    return false;
  }
  return true;
};

const isTuiPromptOrFooterLine = (line: string): boolean => {
  const trimmed = line.trim();
  if (!trimmed || BORDER_ONLY_LINE_PATTERN.test(trimmed)) {
    return true;
  }
  if (/^[❯›>]\s*(?:\S.*)?$/.test(trimmed)) {
    return true;
  }
  return AI_TUI_FOOTER_HINTS.some((pattern) => pattern.test(trimmed));
};

// 分析当前可视屏幕底部文本：区分“仍在运行”、“等待确认/提问输入”与“已回到空闲提示符”。
export const classifyLocalTerminalViewport = (
  rawLines: readonly string[],
): LocalTerminalViewportAssessment => {
  const nonEmptyLines = rawLines
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (!nonEmptyLines.length) {
    return {
      isActivelyWorking: false,
      needsInputPrompt: false,
      isAtIdlePrompt: false,
      isFreshTuiWelcome: false,
    };
  }

  const tailLines = nonEmptyLines.slice(-18);
  const bottomSix = nonEmptyLines.slice(-6);
  const bottomJoined = tailLines.join('\n');

  const hasIdleTuiFooter = tailLines.some((line) =>
    AI_TUI_FOOTER_HINTS.some((pattern) => pattern.test(line)),
  );
  const hasBorderedInputBox = tailLines.some((line, index) => {
    const trimmed = line.trim();
    if (!/^[❯›>](?:\s|$)/.test(trimmed)) {
      return false;
    }
    const prevBorder = index > 0 && BORDER_ONLY_LINE_PATTERN.test(tailLines[index - 1].trim());
    const nextBorder =
      index + 1 < tailLines.length && BORDER_ONLY_LINE_PATTERN.test(tailLines[index + 1].trim());
    return prevBorder || nextBorder;
  });

  const lastContentLine = [...tailLines]
    .reverse()
    .find((line) => !BORDER_ONLY_LINE_PATTERN.test(line.trim())) ?? '';

  const isShellPrompt = SHELL_PROMPT_PATTERNS.some((pattern) =>
    pattern.test(lastContentLine.trim()),
  );
  const isAtIdlePrompt = isShellPrompt || hasIdleTuiFooter || hasBorderedInputBox;

  const isFreshTuiWelcome =
    isAtIdlePrompt &&
    FRESH_TUI_WELCOME_PATTERNS.some((pattern) => pattern.test(bottomJoined));

  // 运行中的关键特征：只要存在中断提示或底部活跃 spinner，就判定仍在执行，不能过早误报完成。
  const hasInterruptHint = tailLines.some((line) => ACTIVE_INTERRUPT_PATTERN.test(line));
  const hasBottomSpinner = bottomSix.some(
    (line) =>
      ACTIVE_STATUS_SPINNER_PATTERN.test(line.trim()) ||
      ACTIVE_TOKEN_PROGRESS_PATTERN.test(line),
  );
  // 若下方已经回到带快捷键栏的空闲输入框（如 Claude 结束后的 `✻ Brewed for 42s` 汇总行），则不算仍在执行。
  const isActivelyWorking =
    hasInterruptHint || (hasBottomSpinner && !hasIdleTuiFooter && !hasBorderedInputBox);

  if (isActivelyWorking) {
    return {
      isActivelyWorking: true,
      needsInputPrompt: false,
      isAtIdlePrompt: false,
      isFreshTuiWelcome: false,
    };
  }

  // 1. 先检查交互式授权/选择/确认菜单
  for (const pattern of INTERACTIVE_APPROVAL_PATTERNS) {
    const match = bottomJoined.match(pattern);
    if (match) {
      let matchedLine =
        tailLines.find((line) => pattern.test(line))?.trim() ?? match[0].trim();
      // 若命中底部快捷键导航行（Enter to select · Esc to cancel），优先向上提取真正的问题/授权标题行。
      if (/\benter to select\b/i.test(matchedLine)) {
        const footerIdx = tailLines.findIndex((line) => pattern.test(line));
        for (let idx = footerIdx - 1; idx >= Math.max(0, footerIdx - 6); idx -= 1) {
          const candidate = tailLines[idx].trim();
          if (
            candidate &&
            !BORDER_ONLY_LINE_PATTERN.test(candidate) &&
            !/^[❯›\s]*\d+\./.test(candidate) &&
            candidate.length >= 4
          ) {
            matchedLine = candidate;
            break;
          }
        }
      }
      return {
        isActivelyWorking: false,
        needsInputPrompt: true,
        isAtIdlePrompt,
        isFreshTuiWelcome: false,
        summary: matchedLine,
      };
    }
  }

  // 2. 再检查标准 CLI 行尾确认提示（如 [y/n] / 是否继续？）
  const lastFour = nonEmptyLines.slice(-4);
  for (const line of [...lastFour].reverse()) {
    const trimmed = line.trim();
    if (GENERIC_CONFIRM_PROMPT_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      return {
        isActivelyWorking: false,
        needsInputPrompt: true,
        isAtIdlePrompt,
        isFreshTuiWelcome: false,
        summary: trimmed,
      };
    }
  }

  // 3. 若当前在 AI TUI 空闲输入栏，向前找最近一条自然语言正文行，若为提问句则识别为等待回答。
  if (hasIdleTuiFooter || hasBorderedInputBox) {
    let index = tailLines.length - 1;
    while (index >= 0 && isTuiPromptOrFooterLine(tailLines[index])) {
      index -= 1;
    }
    if (index >= 0 && isLikelyNaturalQuestionLine(tailLines[index])) {
      return {
        isActivelyWorking: false,
        needsInputPrompt: true,
        isAtIdlePrompt: true,
        isFreshTuiWelcome,
        summary: tailLines[index].trim(),
      };
    }
  }

  return {
    isActivelyWorking: false,
    needsInputPrompt: false,
    isAtIdlePrompt,
    isFreshTuiWelcome,
  };
};

const classifyOscMessageKind = (
  title: string | undefined,
  body: string,
): LocalTerminalNotificationKind => {
  const combined = `${title ?? ''} ${body}`;
  return INPUT_OR_APPROVAL_TEXT_PATTERN.test(combined) ? 'needs_input' : 'completed';
};

const BARE_INTERACTIVE_AGENT_COMMANDS = new Set([
  'claude',
  'claude-code',
  'clidex',
  'codex',
  'opencode',
  'oc',
  'gemini',
  'qwen',
  'qwen-code',
  'kimi',
  'aider',
  'copilot',
  'cursor-agent',
  'pi',
]);

// 预设命令若直接带有参数（如 `npm run build` 或 `claude "fix bug"`），打开即开始执行；
// 空命令、显式 `shell:<id>` 或无参启动交互式 AI TUI 时保持未提交态，避免启动欢迎页误报。
const shouldArmInitialPresetCommand = (command: string): boolean => {
  const trimmed = command.trim();
  if (!trimmed || trimmed.startsWith('shell:')) {
    return false;
  }
  const tokens = trimmed.split(/\s+/);
  if (tokens.length > 1) {
    return true;
  }
  const program = tokens[0]
    .replace(/^['"]|['"]$/g, '')
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.(?:exe|cmd|bat|ps1)$/i, '')
    .toLowerCase();
  return Boolean(program && !BARE_INTERACTIVE_AGENT_COMMANDS.has(program));
};

// 单会话通知状态机：负责防抖去重、Ctrl+C 取消抑制、编辑敲键 BEL 过滤与工作时长门槛。
export class LocalTerminalNotificationStateMachine {
  private scannerState: LocalTerminalSignalScannerState = { pending: '' };
  private sessionTitle: string;
  private localCommand: string;
  private readonly createdAtMs: number;
  private lastUserInputAt = 0;
  private lastNonEnterInputAt = 0;
  private lastResizeAt = 0;
  private lastOutputAt = 0;
  private lastSubmittedAt: number | null = null;
  private workingSinceAt: number | null = null;
  private workingEvidence: 'none' | 'title' | 'screen' | 'osc133' | 'sustained_output' = 'none';
  private outputChunksDuringWork = 0;
  private lastTitleState: TerminalTitleActivityState | 'unknown' = 'unknown';
  private topic: string | undefined;
  private notifiedForCurrentTurn = false;
  private lastNotifiedAt = 0;
  private lastNeedsInputSignature = '';
  private pendingQuickEvaluationKind: 'title_idle' | 'bell' | 'title_needs_input' | null = null;
  private pendingOsc133ExitCode: number | undefined;

  constructor(config: LocalTerminalTrackerConfig) {
    this.sessionTitle = config.sessionTitle;
    this.localCommand = config.localCommand;
    this.createdAtMs = config.createdAtMs;
    if (shouldArmInitialPresetCommand(config.localCommand)) {
      this.lastSubmittedAt = config.createdAtMs;
      this.workingSinceAt = config.createdAtMs;
    }
  }

  updateSessionMeta(sessionTitle: string, localCommand: string, topic?: string) {
    this.sessionTitle = sessionTitle;
    this.localCommand = localCommand;
    if (topic !== undefined) {
      this.topic = topic;
    }
  }

  recordUserInput(data: string, nowMs: number) {
    if (!data) {
      return;
    }
    this.lastUserInputAt = nowMs;

    // Ctrl+C 视为主动取消当前任务，清空运行态以避免误报“任务已完成”。
    if (data.includes('\x03')) {
      this.resetWorkingState();
      this.pendingQuickEvaluationKind = null;
      return;
    }

    if (data.includes('\r') || data.includes('\n')) {
      this.lastSubmittedAt = nowMs;
      this.workingSinceAt = nowMs;
      this.workingEvidence = 'none';
      this.outputChunksDuringWork = 0;
      this.notifiedForCurrentTurn = false;
      this.lastNeedsInputSignature = '';
      this.pendingQuickEvaluationKind = null;
      return;
    }

    this.lastNonEnterInputAt = nowMs;
  }

  recordResize(nowMs: number) {
    this.lastResizeAt = nowMs;
  }

  processOutputChunk(
    content: string,
    nowMs: number,
  ): {
    immediateNotifications: LocalTerminalNotificationDecision[];
    requestQuickCheck: boolean;
    scheduleSettleCheck: boolean;
  } {
    this.lastOutputAt = nowMs;
    const { signals, state } = scanLocalTerminalSignals(content, this.scannerState);
    this.scannerState = state;

    const immediateNotifications: LocalTerminalNotificationDecision[] = [];
    let requestQuickCheck = false;

    for (const signal of signals) {
      if (signal.type === 'osc_notify') {
        const kind = classifyOscMessageKind(signal.title, signal.body);
        if (this.canNotify(kind, signal.body, nowMs)) {
          this.markNotified(kind, signal.body, nowMs);
          this.resetWorkingState();
          immediateNotifications.push({
            kind,
            title: signal.title,
            body: signal.body || this.topic || '',
            source: 'osc',
          });
        }
        continue;
      }

      if (signal.type === 'bell') {
        const recentlyTypedNonEnter =
          this.lastNonEnterInputAt > 0 && nowMs - this.lastNonEnterInputAt < BEL_INPUT_SUPPRESS_MS;
        const duringStartup = nowMs - this.createdAtMs < BEL_STARTUP_SUPPRESS_MS;
        if (!recentlyTypedNonEnter && !duringStartup) {
          this.pendingQuickEvaluationKind = 'bell';
          requestQuickCheck = true;
        }
        continue;
      }

      if (signal.type === 'title') {
        const topicUpdate = normalizeTerminalSessionTopic(
          signal.title,
          this.sessionTitle,
          this.localCommand,
        );
        if (topicUpdate.type === 'set') {
          this.topic = topicUpdate.topic;
        } else if (topicUpdate.type === 'clear') {
          this.topic = undefined;
        }

        const nextTitleState = classifyTerminalTitleActivity(
          signal.title,
          this.sessionTitle,
          this.localCommand,
        );
        if (nextTitleState === 'needs_input' && this.lastTitleState !== 'needs_input') {
          this.pendingQuickEvaluationKind = 'title_needs_input';
          requestQuickCheck = true;
        } else if (nextTitleState === 'working') {
          this.workingEvidence = 'title';
          this.workingSinceAt ??= this.lastSubmittedAt ?? nowMs;
          this.notifiedForCurrentTurn = false;
        } else if (nextTitleState === 'idle' && this.lastTitleState === 'working') {
          this.pendingQuickEvaluationKind = 'title_idle';
          requestQuickCheck = true;
        }
        if (nextTitleState !== 'neutral') {
          this.lastTitleState = nextTitleState;
        }
        continue;
      }

      if (signal.type === 'osc133_start') {
        this.workingEvidence = 'osc133';
        this.workingSinceAt = nowMs;
        this.notifiedForCurrentTurn = false;
        continue;
      }

      if (signal.type === 'osc133_end') {
        if (
          this.workingSinceAt !== null &&
          nowMs - this.workingSinceAt >= GENERIC_MIN_WORK_DURATION_MS
        ) {
          this.pendingOsc133ExitCode = signal.exitCode;
          const summary = this.topic ?? '';
          if (this.canNotify('completed', summary, nowMs)) {
            this.markNotified('completed', summary, nowMs);
            this.resetWorkingState();
            immediateNotifications.push({
              kind: 'completed',
              body: summary,
              source: 'osc133',
            });
          }
        } else {
          this.resetWorkingState();
        }
      }
    }

    if (this.lastSubmittedAt !== null && nowMs - this.lastResizeAt > RESIZE_REDRAW_SUPPRESS_MS) {
      this.outputChunksDuringWork += 1;
      if (
        this.workingEvidence === 'none' &&
        this.outputChunksDuringWork >= 2 &&
        nowMs - this.lastSubmittedAt >= GENERIC_MIN_WORK_DURATION_MS
      ) {
        this.workingEvidence = 'sustained_output';
        this.workingSinceAt ??= this.lastSubmittedAt;
      }
    }

    const recentlyResized = nowMs - this.lastResizeAt <= RESIZE_REDRAW_SUPPRESS_MS;
    const scheduleSettleCheck = !recentlyResized;

    return {
      immediateNotifications,
      requestQuickCheck,
      scheduleSettleCheck,
    };
  }

  evaluateViewport(
    lines: readonly string[],
    trigger: 'quick' | 'settle',
    nowMs: number,
  ): LocalTerminalNotificationDecision | null {
    const assessment = classifyLocalTerminalViewport(lines);

    if (assessment.isActivelyWorking) {
      // 屏幕明确还在运行（如 esc to interrupt / Thinking），保留或提升为工作态，不发完成通知。
      if (this.workingEvidence === 'none') {
        this.workingEvidence = 'screen';
      }
      this.workingSinceAt ??= this.lastSubmittedAt ?? nowMs;
      this.notifiedForCurrentTurn = false;
      this.pendingQuickEvaluationKind = null;
      return null;
    }

    const quickKind = trigger === 'quick' ? this.pendingQuickEvaluationKind : null;
    if (trigger === 'quick') {
      this.pendingQuickEvaluationKind = null;
    }

    // 1. 优先响应待确认 / 提问提示（不要求长耗时，只要当前未在敲键且未对同一提示重复提醒）
    const recentlyTyped =
      this.lastUserInputAt > 0 && nowMs - this.lastUserInputAt < BEL_INPUT_SUPPRESS_MS;
    if (
      (assessment.needsInputPrompt || quickKind === 'title_needs_input') &&
      !recentlyTyped
    ) {
      const summary = assessment.summary || this.topic || '';
      if (this.canNotify('needs_input', summary, nowMs)) {
        this.markNotified('needs_input', summary, nowMs);
        this.resetWorkingState();
        return {
          kind: 'needs_input',
          body: summary,
          source: quickKind === 'title_needs_input' ? 'title' : 'viewport',
        };
      }
      return null;
    }

    // 2. 响铃触发（已过滤刚敲键时的 readline 响铃）
    if (quickKind === 'bell') {
      const summary = assessment.summary || this.topic || '';
      if (this.canNotify('completed', summary, nowMs)) {
        this.markNotified('completed', summary, nowMs);
        this.resetWorkingState();
        return {
          kind: 'completed',
          body: summary,
          source: 'bell',
        };
      }
      return null;
    }

    // 3. 标题从 working -> idle（如 Claude Code ⠋ -> ✳）
    if (quickKind === 'title_idle') {
      const workedLongEnough =
        this.workingSinceAt === null ||
        nowMs - this.workingSinceAt >= AGENT_MIN_WORK_DURATION_MS;
      if (workedLongEnough && !assessment.isFreshTuiWelcome) {
        const summary = this.topic || '';
        if (this.canNotify('completed', summary, nowMs)) {
          this.markNotified('completed', summary, nowMs);
          this.resetWorkingState();
          return {
            kind: 'completed',
            body: summary,
            source: 'title',
          };
        }
      }
      return null;
    }

    // 4. 静默结算兜底（覆盖 Codex/OpenCode/普通命令未发 OSC 通知但输出已落定且回到提示符的场景）
    if (trigger === 'settle') {
      if (assessment.isFreshTuiWelcome && this.workingEvidence === 'none') {
        this.resetWorkingState();
        return null;
      }

      const workDurationMs =
        this.workingSinceAt !== null ? Math.max(0, this.lastOutputAt - this.workingSinceAt) : 0;
      const wallElapsedMs =
        this.lastSubmittedAt !== null ? Math.max(0, nowMs - this.lastSubmittedAt) : 0;

      const hasAgentWorkEvidence =
        this.workingEvidence === 'title' || this.workingEvidence === 'screen';
      const hasLongCommandEvidence =
        this.lastSubmittedAt !== null &&
        this.lastOutputAt > this.lastSubmittedAt &&
        workDurationMs >= GENERIC_MIN_WORK_DURATION_MS &&
        wallElapsedMs >= GENERIC_MIN_WORK_DURATION_MS;

      const settledEnough =
        (hasAgentWorkEvidence &&
          (workDurationMs >= AGENT_MIN_WORK_DURATION_MS || this.workingEvidence === 'title')) ||
        (hasLongCommandEvidence && assessment.isAtIdlePrompt);

      if (settledEnough) {
        const summary = this.topic || '';
        if (this.canNotify('completed', summary, nowMs)) {
          this.markNotified('completed', summary, nowMs);
          this.resetWorkingState();
          return {
            kind: 'completed',
            body: summary,
            source: 'viewport',
          };
        }
      }
    }

    return null;
  }

  getPendingOsc133ExitCode() {
    return this.pendingOsc133ExitCode;
  }

  private resetWorkingState() {
    this.workingSinceAt = null;
    this.workingEvidence = 'none';
    this.lastSubmittedAt = null;
    this.outputChunksDuringWork = 0;
    this.pendingOsc133ExitCode = undefined;
  }

  private canNotify(
    kind: LocalTerminalNotificationKind,
    signature: string,
    nowMs: number,
  ): boolean {
    if (kind === 'needs_input') {
      const normalized = signature.trim().toLowerCase();
      if (normalized && normalized === this.lastNeedsInputSignature) {
        return false;
      }
      return nowMs - this.lastNotifiedAt >= 1500 || normalized !== this.lastNeedsInputSignature;
    }

    if (this.notifiedForCurrentTurn) {
      return false;
    }
    return nowMs - this.lastNotifiedAt >= NOTIFICATION_COOLDOWN_MS;
  }

  private markNotified(
    kind: LocalTerminalNotificationKind,
    signature: string,
    nowMs: number,
  ) {
    this.lastNotifiedAt = nowMs;
    if (kind === 'needs_input') {
      this.lastNeedsInputSignature = signature.trim().toLowerCase();
      // 审批确认后本轮尚未完成，允许用户在授权后继续收到最终完成提醒。
      this.notifiedForCurrentTurn = false;
    } else {
      this.notifiedForCurrentTurn = true;
    }
  }
}
