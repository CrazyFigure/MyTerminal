//! 终端基础契约、协议常量、布局参数与轻量测量工具。

import type { IBufferLine, IMarker } from "@xterm/xterm";

import type { TerminalReplayEntry } from "../../terminalCache";
import type { TerminalSession } from "../../types";
import packageMetadata from "../../../package.json";

export const terminalOutputEventName = "myterminal-terminal-output";

export const terminalCursorShowSequence = "\x1b[?25h";

export const terminalCursorHideSequence = "\x1b[?25l";

// 远端隐藏光标后若长时间无新输出,判定其进度渲染已结束/被打断,自动补发显示序列做自愈。
export const terminalCursorRecoveryIdleMs = 400;

// bracketed paste 的边界用于区分“粘贴中的换行”和真正提交命令的 Enter，避免误清 Claude 输入行缓存。
export const terminalBracketedPasteStartSequence = "\x1b[200~";

export const terminalBracketedPasteEndSequence = "\x1b[201~";

// xterm 支持 DEC 2026，但不内置 XTVERSION；按标准返回真实宿主身份，让 Claude 等 TUI 能继续执行能力协商。
export const terminalXtVersionResponse = `\x1bP>|MyTerminal(${packageMetadata.version})\x1b\\`;

// 单次回写最多合并固定数量的响应，既减少后端调用，也禁止异常查询造成无上限字符串分配。
export const terminalXtVersionReplyBatchSize = 32;

// 横向滚动模式根据当前缓冲区最长逻辑行动态扩列，上限防止异常长行拖慢渲染。
export const terminalHorizontalMaxColumns = 1000;

// 横向列数按块增长，避免每输入一个字符都触发一次 PTY resize。
export const terminalHorizontalColumnGrowthStep = 40;

// 长行末尾额外留几列，避免文本刚好顶到横向画布边缘。
export const terminalHorizontalLinePaddingColumns = 8;

// 光标跟随时右侧预留多个字符宽度，避免输入到边界时视觉上贴住容器。
export const terminalCursorFollowMarginColumns = 8;

// 只有本地输入后的短时间内才自动跟随光标，避免 top、htop 等远端 TUI 定时重绘把横向视口推走。
export const terminalCursorFollowAfterInputMs = 1800;

// xterm 内部竖向滚动区会占用少量宽度，横向宽度估算时预留出来避免最后几列被压住。
export const terminalScrollbarReservePx = 18;

// 横向长行模式下，鼠标靠近右侧时显示可视区固定的竖向滚动条，避免原生滚动条跑到长行内容最右端。
export const terminalVerticalScrollbarRevealZonePx = 44;

// 右侧自绘滚动条宽度和右边距必须和 CSS 保持一致，用于按 scrollLeft 定位到当前可视区右边。
export const terminalVerticalScrollbarWidthPx = 12;

export const terminalVerticalScrollbarRightInsetPx = 4;

export const terminalVerticalScrollbarTopInsetPx = 8;

export const terminalVerticalScrollbarBottomInsetPx = 22;

// 自绘竖向滚动条最小拇指高度，保证日志很多时仍能被鼠标稳定命中。
export const terminalVerticalScrollbarMinThumbHeightPx = 32;

// 普通终端保留 xterm 默认滚屏历史，避免影响 SSH 和 Shell 的日常查看习惯。
export const terminalDefaultScrollbackRows = 1000;

// AI Agent 也保留历史，避免窗口 resize 后把启动警告等一次性输出彻底丢掉；滚轮另行拦截。
export const terminalAiAgentScrollbackRows = terminalDefaultScrollbackRows;

// xterm 对 CLI 自绘颜色做逐格对比度兜底，覆盖浅色主题里的浅灰字和深色输入条上的默认黑字。
export const terminalMinimumContrastRatio = 7;

// Claude Code 用浅蓝/浅紫表达菜单选中态，使用 AA 级别兜底增强可读性，同时避免高亮色被压成黑色。
export const terminalClaudeMinimumContrastRatio = 4.5;

// 这些命令会以 TUI 方式反复重绘同一屏，必须固定在当前可视列宽内渲染。
export const terminalAiAgentCommandNames = new Set([
  "claude",
  "claude-code",
  "codex",
  "opencode",
  "qwen",
  "qwen-code",
  "gemini",
  "aider",
  "cursor-agent",
]);

// xterm 默认把 Ctrl+V 编码成控制字符；只为 Windows Claude 放行 WebView 原生粘贴，避免改变 Shell/Vim 的 Ctrl+V 语义。
export const terminalNativeCtrlVPasteCommandNames = new Set([
  "claude",
  "claude-code",
]);

// 仅隐藏已确认会自行绘制光标、且终端真实光标会停在状态栏的 TUI；OpenCode 等依赖标准光标协议的程序保持原样。
export const terminalHideLocalCursorCommandNames = new Set([
  "claude",
  "claude-code",
  "qwen",
  "qwen-code",
  "gemini",
  "aider",
  "cursor-agent",
]);

// Codex 重绘帧会反复恢复原生光标；协议层持续隐藏它，并按真实 buffer 坐标绘制经过输入区校验的替代光标。
export const terminalManagedCursorCommandNames = new Set(["codex"]);

// 浅色模式下 Codex 会用 ANSI black 或反色块表示输入区，映射成柔和底色避免黑块过重。
export const terminalSoftDarkBlockCommandNames = new Set(["codex"]);

export const terminalLowerContrastCommandNames = new Set([
  "claude",
  "claude-code",
]);

export const terminalSoftDarkBlockLightBackground = "#e0e7ff";

// Claude 自绘输入框时 xterm 真实 cursor 可能停在状态栏；中文输入法候选框需要锚到可见输入行。
export const terminalImeAnchorCommandNames = new Set(["claude", "claude-code"]);

// 输入框探测默认只看视口底部；Claude 可能把输入框绘制在上半屏，另由输入框边线与专用会话约束全屏搜索。
export const terminalPromptGlyphs = ["›", "❯"] as const;

export const terminalPromptSearchRows = 12;

// 无提示符兜底只接受邻近的足够长边线：距离覆盖单行/短多行输入，最小长度排除回答里的普通短横线。
export const terminalPromptBorderSearchDistanceRows = 4;

// 上边框必须紧贴候选行：spinner 行与输入框之间只隔一条边线，放宽到 4 行会把 spinner 行也算成被框住。
export const terminalPromptUpperBorderSearchDistanceRows = 2;

export const terminalPromptBorderMinCharacters = 8;

// 运行中的 Claude 会在输入框上方绘制 spinner、token 计数和快捷键提示；这些行同样被边线夹住，
// 必须显式排除，否则无提示符兜底会把中文候选框锚到随内容横移的 spinner 行上。
export const terminalNonPromptRowPatterns: readonly RegExp[] = [
  // "(56m 33s · ↓ 83.2k tokens)" 这类计时/用量尾巴
  /tokens\s*\)/i,
  // "(esc to interrupt)" / "(ctrl+o to expand)" 等运行态操作提示
  /\(\s*(?:esc|ctrl\+\w+)\b[^)]*\)/i,
  // "⏵⏵ accept edits on · 1 shell" 状态栏，以及百分比进度尾巴
  /^\s*(?:⏵⏵|▶▶)/,
  /\d+(?:\.\d+)?%/,
];

// 命中任一特征即判定为 Claude 的状态/进度行，不能作为中文输入法的锚点。
export const isTerminalNonPromptRowText = (text: string) =>
  terminalNonPromptRowPatterns.some((pattern) => pattern.test(text));

// 会话可能不是用 `claude` 直接启动的（在已打开的 Shell 里手敲、经 npx/pwsh 包裹、或 SSH 到远端再运行），
// 此时启动命令解析不出可执行名，IME 锚定开关不会打开。改用画面结构在运行时识别：
// Claude 的输入框是「上边线 + `›` 提示行 + 下边线」的固定组合，普通 Shell 与其它 TUI 不会呈现这种结构。
export const detectTerminalClaudeInputFrame = (
  readRowText: (row: number) => string | undefined,
  firstVisibleRow: number,
  lastVisibleRow: number,
): boolean => {
  const isBorder = (row: number) => {
    const text = (readRowText(row) ?? "").replace(/\s/g, "");
    return (
      text.length >= terminalPromptBorderMinCharacters &&
      /^[─━═-]+$/.test(text)
    );
  };

  // 自底向上找带提示符的行，并要求它被上下边线紧紧夹住；只认最靠下的一处，避免历史回答里的引用块误判。
  for (let row = lastVisibleRow; row >= firstVisibleRow; row -= 1) {
    const text = readRowText(row);
    if (text === undefined) {
      continue;
    }
    const trimmed = text.trimStart();
    if (!terminalPromptGlyphs.some((glyph) => trimmed.startsWith(glyph))) {
      continue;
    }
    const hasUpperBorder =
      row - 1 >= firstVisibleRow && isBorder(row - 1);
    // 输入内容可能软换行成多行，下边线允许隔几行。
    let hasLowerBorder = false;
    for (
      let candidate = row + 1;
      candidate <=
      Math.min(lastVisibleRow, row + terminalPromptBorderSearchDistanceRows);
      candidate += 1
    ) {
      if (isBorder(candidate)) {
        hasLowerBorder = true;
        break;
      }
    }
    if (hasUpperBorder && hasLowerBorder) {
      return true;
    }
  }
  return false;
};

// 光标与所在单元格低于非文本 UI 的最低可辨识对比度时，叠加同位置反色细线作为通用兜底。
export const terminalCursorMinimumContrastRatio = 3;

// Codex 输入动作后的短暂保护期内，重绘输出不能立即隐藏正在操作的光标。
export const terminalManagedCursorInputGraceMs = 600;

// Codex 输出停止一小段时间后再结算光标状态，避免流式回复的短间隙造成反复闪现。
export const terminalManagedCursorOutputIdleMs = 700;

// 匹配高亮只绘制当前可查看区域，滚动时重算，避免为整个 scrollback 常驻创建大量 DOM。
export const terminalMatchHighlightOverscanRows = 24;

// 单字符选择可能命中非常多内容，硬上限用于保护 WebView 内存和滚动帧率。
export const terminalMatchHighlightMaxRanges = 1800;

// 选区和匹配项都用底层 SVG 色块绘制，颜色在文字下方，不覆盖终端字符；深色匹配项额外用 xterm decoration 调整文字色。
export const terminalSelectionHighlightBackground = "#c7c7fb";

export const terminalSelectionHighlightBorder = "#b8b8f5";

export const terminalMatchHighlightLightBackground = "#cfcfcf";

export const terminalMatchHighlightLightBorder = "#bdbdbd";

export const terminalMatchHighlightDarkBackground = "#d8d6ff";

export const terminalMatchHighlightDarkBorder = "#b9b5ff";

export const terminalMatchHighlightDarkForeground = "#111827";

export const terminalHighlightSvgNamespace = "http://www.w3.org/2000/svg";

// 圆角只做柔化，不接近胶囊形；终端行高较小时也保留轻微弧度。
export const terminalHighlightCornerRadiusPx = 4;

export const terminalHighlightBorderWidthPx = 1;

// 匹配块之间需要有可见间隙；只收缩每个命中块的外边缘，跨行命中内部仍保持连贯。
export const terminalMatchHighlightGapPx = 1.5;

// 垂直内缩随行高按比例放大，避免大行高下色块贴满整行糊成一片。
// 系数按默认行高 1.18 + 字号 15（单元格约 17.7px）反推，使默认观感与固定 1.5px 保持一致。
export const terminalMatchHighlightVerticalGapRatio = 0.085;

// 超大字号下间隙不再继续放大，防止色块被压得过扁。
export const terminalMatchHighlightMaxVerticalGapPx = 6;

// 提示符各部分只用底部细色条区分，不铺命令行背景，完整保留终端底色与背景图片。
export const terminalPromptHighlightLightColors: TerminalPromptHighlightColors =
  {
    segments: {
      user: "#0f766e",
      host: "#0284c7",
      path: "#7c3aed",
      symbol: "#d97706",
      separator: "#64748b",
    },
  };

export const terminalPromptHighlightDarkColors: TerminalPromptHighlightColors =
  {
    segments: {
      user: "#5eead4",
      host: "#7dd3fc",
      path: "#c4b5fd",
      symbol: "#fbbf24",
      separator: "#94a3b8",
    },
  };

// 提示符前缀有严格上限，避免超长日志行触发不必要的正则回溯；路径超过该长度时仍保留整行浅色标识。
export const terminalPromptHighlightMaxScanChars = 512;

// 分段色条保持纤细，只强化 user/host/path/结束符的视觉节奏，不遮挡下划线字符或背景图细节。
export const terminalPromptSegmentUnderlineHeightPx = 2;

export const terminalPromptSegmentHorizontalInsetPx = 0.6;

// 行号栏（gutter）都不显示时仍保留少量宽度，用于承载右键菜单命中区域。
export const terminalGutterMinWidthPx = 16;

// 行号栏左右内边距，保证时间戳/行号不贴住边缘；左侧取较小值避免时间戳与 gutter 左缘之间出现空隙。
export const terminalGutterHorizontalPaddingPx = 6;

// 时间戳固定按 HH:MM:SS 展示；行号右对齐，位宽随当前最大逻辑行号动态增长。
// 不再加方括号：时间戳独占一列且右侧有分隔线，括号只是噪声，去掉还能省回两个字符的正文宽度。
export const terminalGutterTimestampCharCount = 8;

export const terminalGutterMinDigits = 2;

// 行号栏字体相对终端字号略小，避免占用过多正文宽度；同时保证最小可读像素。
export const terminalGutterFontScale = 0.9;

export const terminalGutterMinFontSizePx = 11;

// 等宽字体单字符宽度估算系数，用于按字符数换算行号栏像素宽度。
export const terminalGutterCharWidthRatio = 0.62;

// 软换行续行在行号列以该符号占位，表示它属于上一条逻辑行；
// 用中点而不是减号，避免右对齐的数字列里被误读成负号。
export const terminalGutterWrappedLineSymbol = "·";

// 每个会话最多缓存这么多条逻辑行的到达时刻，超出后从最旧端回收并用 base 记录已丢弃数量。
export const terminalGutterMaxTrackedLines = 5000;

// 每条稳定逻辑行用一个 xterm marker 锚定其起始 buffer 行；marker 会随滚动、reflow 自动跟随，
// 被 scrollback 裁剪时自动 dispose。ANSI 光标移动重新落到已有 buffer 行时复用原 marker 和行号，
// 从根源上避免 Docker Compose 等动态进度内容每次重画都把同一显示行当成新行。

// 按会话持久缓存的稳定逻辑行时间线：times[i] 是累计编号为 (base + i + 1) 的逻辑行首次出现时刻（ms）。
// base 记录已从最旧端回收的行数，保证累计编号（行号）持续增长且不回退。
export type TerminalGutterSessionData = {
  times: number[];
  base: number;
};

// 每个 marker 直接携带稳定逻辑行号；动态进度输出反复覆盖同一 buffer 行时复用原 marker，禁止重新编号。
export type TerminalGutterMarkerEntry = {
  marker: IMarker;
  logicalNumber: number;
};

// 行号栏时间戳固定使用本地时区 HH:MM:SS，与常见远程终端展示保持一致。
export const formatTerminalGutterClock = (timestampMs: number) => {
  const date = new Date(timestampMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

export type TerminalLayoutSize = {
  // renderCols 是前端 xterm 的渲染列数，横向模式可临时扩大用于浏览当前可见长行。
  renderCols: number;
  // remoteCols 是发给远端 PTY 的列数，必须与 renderCols 保持一致，否则 readline/zle 会按错误宽度
  // 计算命令行重绘时要清除的物理行数，导致按上/下键翻历史命令时旧行和右侧内容残留清不掉。
  remoteCols: number;
  rows: number;
  visibleCols: number;
};

export type TerminalMatchRange = {
  row: number;
  col: number;
  size: number;
};

export type TerminalPromptSegmentKind =
  "user" | "host" | "path" | "symbol" | "separator";

export type TerminalPromptHighlightSegment = {
  start: number;
  end: number;
  kind: TerminalPromptSegmentKind;
};

export type TerminalPromptHighlightMatch = {
  row: number;
  segments: TerminalPromptHighlightSegment[];
};

export type TerminalPromptHighlightColors = {
  segments: Record<TerminalPromptSegmentKind, string>;
};

export type TerminalHighlightStrip = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type TerminalMatchDecorationRange = {
  row: number;
  column: number;
  width: number;
};

export type TerminalSelectionPosition = {
  start: {
    x: number;
    y: number;
  };
  end: {
    x: number;
    y: number;
  };
};

export type TerminalSelectionSnapshot = {
  text: string;
  position: TerminalSelectionPosition;
  cols: number;
  sessionId?: string;
};

export type TerminalHighlightPoint = {
  x: number;
  y: number;
};

export type TerminalPromptAnchor = {
  row: number;
  column: number;
  // 输入框首尾行用于校验 Codex 重绘途中的临时 cursor，禁止状态栏中间帧触发替代光标。
  promptStartRow: number;
  promptEndRow: number;
  screenLeft: number;
  screenTop: number;
  containerLeft: number;
  containerTop: number;
  cellWidth: number;
  cellHeight: number;
};

// Claude 提交首个中文词后可能临时擦掉提示符；缓存可信输入行，让下一轮组合输入仍锚在同一行。
export type TerminalPromptRowCache = {
  sessionId: string;
  row: number;
};

// xterm write 异步排队且 reset 不会取消旧输入；重放代次用于阻止旧会话回调提前结束新会话的重放保护。
export type TerminalReplayState = {
  generation: number;
  sessionId?: string;
};

export type TerminalReplayDeferredOutput = TerminalReplayState & {
  entries: TerminalReplayEntry[];
};

// 连续 resize 后若溢出量始终贴着右边界增长，说明内容很可能在响应 PTY 宽度，而不是一条固定长文本。
export type TerminalHorizontalOverflowEvidence = {
  contentColumns: number;
  snapshotColumns: number;
  widthResponsive: boolean;
};

export type TerminalXtVersionQueryParserState = 0 | 1 | 2 | 3;

// XTVERSION 查询可能横跨后端输出分片；小状态机按会话保留未完成前缀，并返回本分片内完整查询数。
export const countTerminalXtVersionQueries = (
  content: string,
  initialState: TerminalXtVersionQueryParserState,
) => {
  let state = initialState;
  let count = 0;
  for (const character of content) {
    if (state === 0) {
      state = character === "\x1b" ? 1 : character === "\x9b" ? 2 : 0;
      continue;
    }
    if (state === 1) {
      state =
        character === "["
          ? 2
          : character === "\x1b"
            ? 1
            : character === "\x9b"
              ? 2
              : 0;
      continue;
    }
    if (state === 2) {
      state = character === ">" ? 3 : character === "\x1b" ? 1 : 0;
      continue;
    }
    if (character === "q") {
      count += 1;
      state = 0;
    } else if (!/[0-9;]/.test(character)) {
      state = character === "\x1b" ? 1 : 0;
    }
  }
  return { count, state };
};

export type TerminalVerticalScrollbarMetrics = {
  thumbHeight: number;
  thumbTop: number;
  maxThumbTop: number;
  maxScrollLine: number;
};

export type TerminalVerticalScrollbarDragState = {
  originY: number;
  originThumbTop: number;
  maxThumbTop: number;
  maxScrollLine: number;
};

// 只有后端 PTY 已就绪的会话才接收键盘输入，connecting 阶段避免用户输入被前端或后端吞掉。
export const canAcceptTerminalInput = (session?: TerminalSession) =>
  Boolean(session && ["connected", "stub"].includes(session.status));

export const clampTerminalNumber = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

// 横向宽度只看当前列范围内的真实文本单元格；带反色背景的行尾空格不能把 TUI 标题栏算成长行内容。
export const measureTerminalBufferLineContentColumns = (
  line: IBufferLine,
  maxColumns: number,
) => {
  let lastContentColumn = 0;
  const lineColumns = Math.min(line.length, Math.max(0, maxColumns));
  for (let column = 0; column < lineColumns; column += 1) {
    const cell = line.getCell(column);
    if (!cell) {
      break;
    }

    const text = cell.getChars();
    const width = cell.getWidth();
    if (width <= 0 || !text || text === " ") {
      continue;
    }
    lastContentColumn = column + width;
  }
  return lastContentColumn;
};

// 返回行首提示符（`›`/`❯`）及其后连续空格之后的第一个内容列；无提示符时返回 0。
// 用于把反色光标扫描限制在真正的输入内容区内。
export const measureTerminalPromptGlyphEndColumn = (
  line: IBufferLine,
  maxColumns: number,
): number => {
  const lineColumns = Math.min(line.length, Math.max(0, maxColumns));
  let column = 0;
  // 跳过提示符之前的缩进空格。
  while (column < lineColumns && line.getCell(column)?.getChars() === " ") {
    column += 1;
  }

  const glyphCell = column < lineColumns ? line.getCell(column) : undefined;
  const glyphText = glyphCell?.getChars() ?? "";
  if (!terminalPromptGlyphs.some((glyph) => glyphText === glyph)) {
    return 0;
  }

  column += Math.max(1, glyphCell?.getWidth() ?? 1);
  // 提示符与输入内容之间的空格同样可能带反色，一并跳过。
  while (column < lineColumns && line.getCell(column)?.getChars() === " ") {
    column += 1;
  }
  return column;
};

// 在指定行内查找 Claude 自绘的反色光标块，返回其起始列号；未找到时返回 -1。
// startColumn 用于跳过行首提示符：`›` 及其后空格有时自带反色，会把候选框吸到行首而非真实光标处。
export const findTerminalInverseCursorColumn = (
  line: IBufferLine,
  maxColumns: number,
  startColumn = 0,
): number => {
  const lineColumns = Math.min(line.length, Math.max(0, maxColumns));
  for (
    let column = Math.max(0, startColumn);
    column < lineColumns;
    column += 1
  ) {
    const cell = line.getCell(column);
    if (!cell) break;
    if (cell.isInverse() && cell.getWidth() > 0) {
      return column;
    }
  }
  return -1;
};
