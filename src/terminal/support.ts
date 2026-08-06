//! 终端输出解析、主题、选区、高亮和布局支持逻辑。

import type { CSSProperties } from 'react';
import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
import { Terminal, type IBufferCell, type IBufferLine, type IMarker } from '@xterm/xterm';

import type { TerminalReplayEntry } from '../terminalCache';
import type { AppSettings, TerminalSession } from '../types';
import packageMetadata from '../../package.json';

export const terminalOutputEventName = 'myterminal-terminal-output';


export const terminalCursorShowSequence = '\x1b[?25h';


export const terminalCursorHideSequence = '\x1b[?25l';


// 远端隐藏光标后若长时间无新输出,判定其进度渲染已结束/被打断,自动补发显示序列做自愈。
export const terminalCursorRecoveryIdleMs = 400;


// bracketed paste 的边界用于区分“粘贴中的换行”和真正提交命令的 Enter，避免误清 Claude 输入行缓存。
export const terminalBracketedPasteStartSequence = '\x1b[200~';


export const terminalBracketedPasteEndSequence = '\x1b[201~';


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
export const terminalAiAgentCommandNames = new Set(['claude', 'claude-code', 'codex', 'opencode', 'qwen', 'qwen-code', 'gemini', 'aider', 'cursor-agent']);


// xterm 默认把 Ctrl+V 编码成控制字符；只为 Windows Claude 放行 WebView 原生粘贴，避免改变 Shell/Vim 的 Ctrl+V 语义。
export const terminalNativeCtrlVPasteCommandNames = new Set(['claude', 'claude-code']);


// 仅隐藏已确认会自行绘制光标、且终端真实光标会停在状态栏的 TUI；OpenCode 等依赖标准光标协议的程序保持原样。
export const terminalHideLocalCursorCommandNames = new Set(['claude', 'claude-code', 'qwen', 'qwen-code', 'gemini', 'aider', 'cursor-agent']);


// Codex 重绘帧会反复恢复原生光标；协议层持续隐藏它，并按真实 buffer 坐标绘制经过输入区校验的替代光标。
export const terminalManagedCursorCommandNames = new Set(['codex']);


// 浅色模式下 Codex 会用 ANSI black 或反色块表示输入区，映射成柔和底色避免黑块过重。
export const terminalSoftDarkBlockCommandNames = new Set(['codex']);


export const terminalLowerContrastCommandNames = new Set(['claude', 'claude-code']);


export const terminalSoftDarkBlockLightBackground = '#e0e7ff';


// Claude 自绘输入框时 xterm 真实 cursor 可能停在状态栏；中文输入法候选框需要锚到可见输入行。
export const terminalImeAnchorCommandNames = new Set(['claude', 'claude-code']);


// 输入框探测默认只看视口底部；Claude 可能把输入框绘制在上半屏，另由输入框边线与专用会话约束全屏搜索。
export const terminalPromptGlyphs = ['›', '❯'] as const;


export const terminalPromptSearchRows = 12;


// 无提示符兜底只接受邻近的足够长边线：距离覆盖单行/短多行输入，最小长度排除回答里的普通短横线。
export const terminalPromptBorderSearchDistanceRows = 4;


export const terminalPromptBorderMinCharacters = 8;


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
export const terminalSelectionHighlightBackground = '#c7c7fb';


export const terminalSelectionHighlightBorder = '#b8b8f5';


export const terminalMatchHighlightLightBackground = '#cfcfcf';


export const terminalMatchHighlightLightBorder = '#bdbdbd';


export const terminalMatchHighlightDarkBackground = '#d8d6ff';


export const terminalMatchHighlightDarkBorder = '#b9b5ff';


export const terminalMatchHighlightDarkForeground = '#111827';


export const terminalHighlightSvgNamespace = 'http://www.w3.org/2000/svg';


// 圆角只做柔化，不接近胶囊形；终端行高较小时也保留轻微弧度。
export const terminalHighlightCornerRadiusPx = 4;


export const terminalHighlightBorderWidthPx = 1;


// 匹配块之间需要有可见间隙；只收缩每个命中块的外边缘，跨行命中内部仍保持连贯。
export const terminalMatchHighlightGapPx = 1.5;


// 提示符各部分只用底部细色条区分，不铺命令行背景，完整保留终端底色与背景图片。
export const terminalPromptHighlightLightColors: TerminalPromptHighlightColors = {
  segments: {
    user: '#0f766e',
    host: '#0284c7',
    path: '#7c3aed',
    symbol: '#d97706',
    separator: '#64748b',
  },
};


export const terminalPromptHighlightDarkColors: TerminalPromptHighlightColors = {
  segments: {
    user: '#5eead4',
    host: '#7dd3fc',
    path: '#c4b5fd',
    symbol: '#fbbf24',
    separator: '#94a3b8',
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


// 时间戳固定按 [HH:MM:SS] 展示；行号右对齐，位宽随当前最大逻辑行号动态增长。
export const terminalGutterTimestampCharCount = 10;


export const terminalGutterMinDigits = 2;


// 行号栏字体相对终端字号略小，避免占用过多正文宽度；同时保证最小可读像素。
export const terminalGutterFontScale = 0.9;


export const terminalGutterMinFontSizePx = 11;


// 等宽字体单字符宽度估算系数，用于按字符数换算行号栏像素宽度。
export const terminalGutterCharWidthRatio = 0.62;


// 软换行续行在行号列以该符号占位，表示它属于上一条逻辑行。
export const terminalGutterWrappedLineSymbol = '-';


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
  const pad = (value: number) => String(value).padStart(2, '0');
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



export type TerminalPromptSegmentKind = 'user' | 'host' | 'path' | 'symbol' | 'separator';



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
      state = character === '\x1b' ? 1 : character === '\x9b' ? 2 : 0;
      continue;
    }
    if (state === 1) {
      state = character === '[' ? 2 : character === '\x1b' ? 1 : character === '\x9b' ? 2 : 0;
      continue;
    }
    if (state === 2) {
      state = character === '>' ? 3 : character === '\x1b' ? 1 : 0;
      continue;
    }
    if (character === 'q') {
      count += 1;
      state = 0;
    } else if (!/[0-9;]/.test(character)) {
      state = character === '\x1b' ? 1 : 0;
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
export const canAcceptTerminalInput = (session?: TerminalSession) => Boolean(session && ['connected', 'stub'].includes(session.status));



export const clampTerminalNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));



// 横向宽度只看当前列范围内的真实文本单元格；带反色背景的行尾空格不能把 TUI 标题栏算成长行内容。
export const measureTerminalBufferLineContentColumns = (line: IBufferLine, maxColumns: number) => {
  let lastContentColumn = 0;
  const lineColumns = Math.min(line.length, Math.max(0, maxColumns));
  for (let column = 0; column < lineColumns; column += 1) {
    const cell = line.getCell(column);
    if (!cell) {
      break;
    }

    const text = cell.getChars();
    const width = cell.getWidth();
    if (width <= 0 || !text || text === ' ') {
      continue;
    }
    lastContentColumn = column + width;
  }
  return lastContentColumn;
};



// 在指定行内查找 Claude 自绘的反色光标块，返回其起始列号；未找到时返回 -1。
export const findTerminalInverseCursorColumn = (line: IBufferLine, maxColumns: number): number => {
  const lineColumns = Math.min(line.length, Math.max(0, maxColumns));
  for (let column = 0; column < lineColumns; column += 1) {
    const cell = line.getCell(column);
    if (!cell) break;
    if (cell.isInverse() && cell.getWidth() > 0) {
      return column;
    }
  }
  return -1;
};



export const normalizeTerminalMatchSelection = (selection: string) => {
  const normalized = selection.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized || !normalized.trim() || normalized.includes('\n')) {
    return '';
  }
  return normalized;
};



export const normalizeTerminalSelectionSnapshotText = (selection: string) =>
  selection.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\u00a0/g, ' ');



export const cloneTerminalSelectionPosition = (position: TerminalSelectionPosition): TerminalSelectionPosition => ({
  start: { x: position.start.x, y: position.start.y },
  end: { x: position.end.x, y: position.end.y },
});



export const terminalSelectionPositionHasRange = (position: TerminalSelectionPosition) =>
  position.start.x !== position.end.x || position.start.y !== position.end.y;



export const resolveTerminalSelectionLength = (position: TerminalSelectionPosition, cols: number) =>
  (position.end.y - position.start.y) * cols - position.start.x + position.end.x;



// 选区快照校验直接从当前缓冲区重读文本，避免把已经被 scrollback trim 或 resize reflow 改写的旧坐标硬恢复出来。
export const readTerminalSelectionTextFromBuffer = (terminal: Terminal, position: TerminalSelectionPosition) => {
  const buffer = terminal.buffer.active;
  if (
    position.start.y < 0 ||
    position.end.y < position.start.y ||
    position.start.y >= buffer.length ||
    position.end.y >= buffer.length
  ) {
    return '';
  }

  const result: string[] = [];
  const firstLine = buffer.getLine(position.start.y);
  if (!firstLine) {
    return '';
  }

  const firstRowEndColumn = position.start.y === position.end.y ? position.end.x : undefined;
  result.push(firstLine.translateToString(true, position.start.x, firstRowEndColumn));

  for (let row = position.start.y + 1; row <= position.end.y - 1; row += 1) {
    const line = buffer.getLine(row);
    if (!line) {
      return '';
    }
    const lineText = line.translateToString(true);
    if (line.isWrapped && result.length > 0) {
      result[result.length - 1] += lineText;
    } else {
      result.push(lineText);
    }
  }

  if (position.start.y !== position.end.y) {
    const finalLine = buffer.getLine(position.end.y);
    if (!finalLine) {
      return '';
    }
    const lineText = finalLine.translateToString(true, 0, position.end.x);
    if (finalLine.isWrapped && result.length > 0) {
      result[result.length - 1] += lineText;
    } else {
      result.push(lineText);
    }
  }

  return result.join('\n');
};



// 复用 xterm search addon 的行合并思路：软换行需要当成同一条逻辑行搜索，硬换行才截断。
export const translateTerminalBufferLineWithWrap = (terminal: Terminal, startRow: number) => {
  const buffer = terminal.buffer.active;
  const parts: string[] = [];
  const offsets = [0];
  let row = startRow;
  let line = buffer.getLine(row);

  while (line) {
    const nextLine = buffer.getLine(row + 1);
    const wrapsToNextLine = Boolean(nextLine?.isWrapped);
    let text = line.translateToString(!wrapsToNextLine);
    if (wrapsToNextLine && nextLine) {
      const lastCell = line.getCell(line.length - 1);
      const firstNextCell = nextLine.getCell(0);
      // 宽字符被软换行拆到下一行时，xterm 会在上一行末尾留下占位空格；搜索文本里需要去掉这个视觉占位。
      if (lastCell?.getCode() === 0 && lastCell.getWidth() === 1 && firstNextCell?.getWidth() === 2) {
        text = text.slice(0, -1);
      }
    }

    parts.push(text);
    if (!wrapsToNextLine) {
      break;
    }
    offsets.push(offsets[offsets.length - 1] + text.length);
    row += 1;
    line = nextLine;
  }

  return {
    text: parts.join(''),
    offsets,
    endRowExclusive: startRow + offsets.length,
  };
};



// 字符串索引要转换回终端单元格宽度，组合字符和全角字符都不能按 JS length 直接当列数。
export const stringLengthToTerminalBufferSize = (terminal: Terminal, row: number, length: number) => {
  const line = terminal.buffer.active.getLine(row);
  if (!line) {
    return 0;
  }

  let bufferSize = length;
  for (let column = 0; column < bufferSize; column += 1) {
    const cell = line.getCell(column);
    if (!cell) {
      break;
    }
    const chars = cell.getChars();
    if (chars.length > 1) {
      bufferSize -= chars.length - 1;
    }
    const nextCell = line.getCell(column + 1);
    if (nextCell?.getWidth() === 0) {
      bufferSize += 1;
    }
  }
  return bufferSize;
};



// 常见 Unix、RHEL、PowerShell 与 cmd 提示符都要求从逻辑行首完整命中，避免把日志里的邮箱、路径或大于号误认成命令行。
export const terminalPromptUnixPattern = /^((?:\([^()\n]{1,64}\)\s+)*)([A-Za-z0-9._+-]+)(@)([A-Za-z0-9._-]+)(:)(\S*?)([#\$%])(?=\s|$)/;


export const terminalPromptUnixSpacePattern = /^((?:\([^()\n]{1,64}\)\s+)*)([A-Za-z0-9._+-]+)(@)([A-Za-z0-9._-]+)(\s+)(\S+?)(\s*)([#\$%])(?=\s|$)/;


export const terminalPromptBracketPattern = /^(\[)([A-Za-z0-9._+-]+)(@)([A-Za-z0-9._-]+)(\s+)(\S*?)(\])([#\$])(?=\s|$)/;


export const terminalPromptPowerShellPattern = /^(PS)(\s+)(.+?)(>)(?=\s|$)/;


export const terminalPromptCmdPattern = /^([A-Za-z]:[^<>|\n]*?)(>)(?=\s|$)/;



// 按正则捕获顺序累加字符串下标；渲染前再换算成 xterm 单元格列，兼容全角路径与组合字符。
export const buildTerminalPromptSegments = (
  parts: Array<{ text: string; kind: TerminalPromptSegmentKind }>,
) => {
  const segments: TerminalPromptHighlightSegment[] = [];
  let cursor = 0;
  for (const part of parts) {
    const start = cursor;
    cursor += part.text.length;
    if (cursor > start) {
      segments.push({ start, end: cursor, kind: part.kind });
    }
  }
  return segments;
};



// 返回提示符自身的彩色分段；命令正文不做改色，只由整条命令行的透明底色负责定位。
export const matchTerminalPromptSegments = (lineText: string): TerminalPromptHighlightSegment[] | undefined => {
  const text = lineText.slice(0, terminalPromptHighlightMaxScanChars);
  const unixMatch = terminalPromptUnixPattern.exec(text);
  if (unixMatch) {
    return buildTerminalPromptSegments([
      { text: unixMatch[1], kind: 'separator' },
      { text: unixMatch[2], kind: 'user' },
      { text: unixMatch[3], kind: 'separator' },
      { text: unixMatch[4], kind: 'host' },
      { text: unixMatch[5], kind: 'separator' },
      { text: unixMatch[6], kind: 'path' },
      { text: unixMatch[7], kind: 'symbol' },
    ]);
  }

  const unixSpaceMatch = terminalPromptUnixSpacePattern.exec(text);
  if (unixSpaceMatch) {
    return buildTerminalPromptSegments([
      { text: unixSpaceMatch[1], kind: 'separator' },
      { text: unixSpaceMatch[2], kind: 'user' },
      { text: unixSpaceMatch[3], kind: 'separator' },
      { text: unixSpaceMatch[4], kind: 'host' },
      { text: unixSpaceMatch[5], kind: 'separator' },
      { text: unixSpaceMatch[6], kind: 'path' },
      { text: unixSpaceMatch[7], kind: 'separator' },
      { text: unixSpaceMatch[8], kind: 'symbol' },
    ]);
  }

  const bracketMatch = terminalPromptBracketPattern.exec(text);
  if (bracketMatch) {
    return buildTerminalPromptSegments([
      { text: bracketMatch[1], kind: 'separator' },
      { text: bracketMatch[2], kind: 'user' },
      { text: bracketMatch[3], kind: 'separator' },
      { text: bracketMatch[4], kind: 'host' },
      { text: bracketMatch[5], kind: 'separator' },
      { text: bracketMatch[6], kind: 'path' },
      { text: bracketMatch[7], kind: 'separator' },
      { text: bracketMatch[8], kind: 'symbol' },
    ]);
  }

  const powerShellMatch = terminalPromptPowerShellPattern.exec(text);
  if (powerShellMatch) {
    return buildTerminalPromptSegments([
      { text: powerShellMatch[1], kind: 'user' },
      { text: powerShellMatch[2], kind: 'separator' },
      { text: powerShellMatch[3], kind: 'path' },
      { text: powerShellMatch[4], kind: 'symbol' },
    ]);
  }

  const cmdMatch = terminalPromptCmdPattern.exec(text);
  if (cmdMatch) {
    return buildTerminalPromptSegments([
      { text: cmdMatch[1], kind: 'path' },
      { text: cmdMatch[2], kind: 'symbol' },
    ]);
  }
  return undefined;
};



// 从当前可视窗口收集提示符逻辑行；若窗口从软换行中间开始，先回溯到该逻辑行首再判断。
export const collectTerminalPromptHighlightMatches = (
  terminal: Terminal,
  firstRow: number,
  lastRowExclusive: number,
) => {
  const buffer = terminal.buffer.active;
  const matches: TerminalPromptHighlightMatch[] = [];
  let row = Math.max(0, firstRow);
  while (row > 0 && buffer.getLine(row)?.isWrapped) {
    row -= 1;
  }

  while (row < lastRowExclusive) {
    const line = buffer.getLine(row);
    if (!line || line.isWrapped) {
      row += 1;
      continue;
    }
    const logicalLine = translateTerminalBufferLineWithWrap(terminal, row);
    const segments = matchTerminalPromptSegments(logicalLine.text);
    if (segments && logicalLine.endRowExclusive > firstRow) {
      matches.push({ row, segments });
    }
    row = Math.max(row + 1, logicalLine.endRowExclusive);
  }
  return matches;
};



export const resolveTerminalMatchRange = (
  terminal: Terminal,
  logicalStartRow: number,
  offsets: number[],
  matchIndex: number,
  matchLength: number,
): TerminalMatchRange | undefined => {
  let startSegmentIndex = 0;
  while (startSegmentIndex < offsets.length - 1 && matchIndex >= offsets[startSegmentIndex + 1]) {
    startSegmentIndex += 1;
  }

  const matchEndIndex = matchIndex + matchLength;
  let endSegmentIndex = startSegmentIndex;
  while (endSegmentIndex < offsets.length - 1 && matchEndIndex >= offsets[endSegmentIndex + 1]) {
    endSegmentIndex += 1;
  }

  const startRow = logicalStartRow + startSegmentIndex;
  const endRow = logicalStartRow + endSegmentIndex;
  const startColumn = stringLengthToTerminalBufferSize(terminal, startRow, matchIndex - offsets[startSegmentIndex]);
  const endColumn = stringLengthToTerminalBufferSize(terminal, endRow, matchEndIndex - offsets[endSegmentIndex]);
  const size = endColumn - startColumn + terminal.cols * (endSegmentIndex - startSegmentIndex);
  return size > 0 ? { row: startRow, col: startColumn, size } : undefined;
};



export const collectTerminalMatchRanges = (
  terminal: Terminal,
  term: string,
  firstRow: number,
  lastRowExclusive: number,
  maxRanges: number,
) => {
  const buffer = terminal.buffer.active;
  const ranges: TerminalMatchRange[] = [];
  let row = Math.max(0, firstRow);

  while (row > 0 && buffer.getLine(row)?.isWrapped) {
    row -= 1;
  }

  while (row < lastRowExclusive && ranges.length < maxRanges) {
    const line = buffer.getLine(row);
    if (!line) {
      row += 1;
      continue;
    }
    if (line.isWrapped) {
      row += 1;
      continue;
    }

    const logicalLine = translateTerminalBufferLineWithWrap(terminal, row);
    if (logicalLine.endRowExclusive <= firstRow) {
      row = logicalLine.endRowExclusive;
      continue;
    }

    let matchIndex = logicalLine.text.indexOf(term);
    while (matchIndex >= 0 && ranges.length < maxRanges) {
      const range = resolveTerminalMatchRange(terminal, row, logicalLine.offsets, matchIndex, term.length);
      if (range && range.row < lastRowExclusive && range.row + Math.ceil(range.size / Math.max(terminal.cols, 1)) >= firstRow) {
        ranges.push(range);
      }
      matchIndex = logicalLine.text.indexOf(term, matchIndex + Math.max(term.length, 1));
    }

    row = logicalLine.endRowExclusive;
  }

  return ranges;
};



export const formatTerminalHighlightSvgNumber = (value: number) => {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return value.toFixed(2).replace(/\.?0+$/, '');
};



export const isSameTerminalHighlightPoint = (first: TerminalHighlightPoint, second: TerminalHighlightPoint) =>
  Math.abs(first.x - second.x) < 0.01 && Math.abs(first.y - second.y) < 0.01;



export const isTerminalHighlightPointCollinear = (
  previous: TerminalHighlightPoint,
  current: TerminalHighlightPoint,
  next: TerminalHighlightPoint,
) => {
  const cross = (current.x - previous.x) * (next.y - current.y) - (current.y - previous.y) * (next.x - current.x);
  return Math.abs(cross) < 0.01;
};



export const simplifyTerminalHighlightPolygon = (points: TerminalHighlightPoint[]) => {
  const withoutDuplicates: TerminalHighlightPoint[] = [];
  for (const point of points) {
    if (!withoutDuplicates.length || !isSameTerminalHighlightPoint(withoutDuplicates[withoutDuplicates.length - 1], point)) {
      withoutDuplicates.push(point);
    }
  }
  if (withoutDuplicates.length > 1 && isSameTerminalHighlightPoint(withoutDuplicates[0], withoutDuplicates[withoutDuplicates.length - 1])) {
    withoutDuplicates.pop();
  }

  let simplified = withoutDuplicates;
  let changed = true;
  while (changed && simplified.length > 2) {
    changed = false;
    simplified = simplified.filter((point, index, list) => {
      const previous = list[(index - 1 + list.length) % list.length];
      const next = list[(index + 1) % list.length];
      const keep = !isTerminalHighlightPointCollinear(previous, point, next);
      changed ||= !keep;
      return keep;
    });
  }
  return simplified;
};



export const buildTerminalRoundedPolygonPath = (points: TerminalHighlightPoint[], radius: number) => {
  const simplified = simplifyTerminalHighlightPolygon(points);
  if (simplified.length < 3) {
    return '';
  }

  const commands: string[] = [];
  for (let index = 0; index < simplified.length; index += 1) {
    const previous = simplified[(index - 1 + simplified.length) % simplified.length];
    const current = simplified[index];
    const next = simplified[(index + 1) % simplified.length];
    const previousLength = Math.hypot(previous.x - current.x, previous.y - current.y);
    const nextLength = Math.hypot(next.x - current.x, next.y - current.y);
    if (previousLength <= 0.01 || nextLength <= 0.01) {
      continue;
    }
    const cornerRadius = Math.min(radius, previousLength / 2, nextLength / 2);
    const entry = {
      x: current.x + ((previous.x - current.x) / previousLength) * cornerRadius,
      y: current.y + ((previous.y - current.y) / previousLength) * cornerRadius,
    };
    const exit = {
      x: current.x + ((next.x - current.x) / nextLength) * cornerRadius,
      y: current.y + ((next.y - current.y) / nextLength) * cornerRadius,
    };
    const entryPoint = `${formatTerminalHighlightSvgNumber(entry.x)} ${formatTerminalHighlightSvgNumber(entry.y)}`;
    const exitPoint = `${formatTerminalHighlightSvgNumber(exit.x)} ${formatTerminalHighlightSvgNumber(exit.y)}`;
    const controlPoint = `${formatTerminalHighlightSvgNumber(current.x)} ${formatTerminalHighlightSvgNumber(current.y)}`;
    if (index === 0) {
      commands.push(`M ${entryPoint}`);
    } else {
      commands.push(`L ${entryPoint}`);
    }
    commands.push(`Q ${controlPoint} ${exitPoint}`);
  }
  if (!commands.length) {
    return '';
  }
  commands.push('Z');
  return commands.join(' ');
};



export const buildTerminalHighlightPath = (strips: TerminalHighlightStrip[], radius: number) => {
  const orderedStrips = strips
    .filter((strip) => strip.right > strip.left && strip.bottom > strip.top)
    .sort((first, second) => first.top - second.top || first.left - second.left);
  if (!orderedStrips.length) {
    return '';
  }

  const firstStrip = orderedStrips[0];
  const lastStrip = orderedStrips[orderedStrips.length - 1];
  const points: TerminalHighlightPoint[] = [
    { x: firstStrip.left, y: firstStrip.top },
    { x: firstStrip.right, y: firstStrip.top },
  ];

  for (let index = 0; index < orderedStrips.length - 1; index += 1) {
    const current = orderedStrips[index];
    const next = orderedStrips[index + 1];
    points.push({ x: current.right, y: current.bottom });
    if (Math.abs(current.right - next.right) > 0.01) {
      points.push({ x: next.right, y: current.bottom });
    }
  }

  points.push({ x: lastStrip.right, y: lastStrip.bottom });
  points.push({ x: lastStrip.left, y: lastStrip.bottom });

  for (let index = orderedStrips.length - 1; index > 0; index -= 1) {
    const current = orderedStrips[index];
    const previous = orderedStrips[index - 1];
    points.push({ x: current.left, y: current.top });
    if (Math.abs(current.left - previous.left) > 0.01) {
      points.push({ x: previous.left, y: current.top });
    }
  }

  return buildTerminalRoundedPolygonPath(points, radius);
};



export const createTerminalHighlightPathElement = (className: string, color: string, borderColor: string, pathValue: string) => {
  const path = document.createElementNS(terminalHighlightSvgNamespace, 'path');
  path.setAttribute('class', className);
  path.setAttribute('d', pathValue);
  path.setAttribute('fill', color);
  path.setAttribute('stroke', borderColor);
  path.setAttribute('stroke-width', `${terminalHighlightBorderWidthPx}`);
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  return path;
};



// 匹配高亮需要按主题换底色，避免深色模式白色终端字压在浅灰命中块上读不清。
export const resolveTerminalMatchHighlightColors = (isDarkTheme: boolean) => (
  isDarkTheme
    ? {
        background: terminalMatchHighlightDarkBackground,
        border: terminalMatchHighlightDarkBorder,
        foreground: terminalMatchHighlightDarkForeground,
      }
    : {
        background: terminalMatchHighlightLightBackground,
        border: terminalMatchHighlightLightBorder,
        foreground: undefined,
      }
);



// 横向列数只在确实超过可视宽度时增长，并按固定步长取整来减少后端 resize 抖动。
export const roundHorizontalColumns = (requiredColumns: number, visibleColumns: number) => {
  if (requiredColumns <= visibleColumns) {
    return visibleColumns;
  }
  const roundedColumns = Math.ceil(requiredColumns / terminalHorizontalColumnGrowthStep) * terminalHorizontalColumnGrowthStep;
  return Math.min(terminalHorizontalMaxColumns, Math.max(visibleColumns, roundedColumns));
};



// 本地终端新会话直接带 localCommand；旧会话或旧后端回退到“命令 · 目录”的标签格式解析。
export const resolveLocalSessionCommandText = (session?: TerminalSession) => {
  if (session?.kind !== 'local') {
    return '';
  }
  if (session.localCommand?.trim()) {
    return session.localCommand.trim();
  }

  const titleSeparatorIndex = session.title.indexOf(' · ');
  return titleSeparatorIndex > 0 ? session.title.slice(0, titleSeparatorIndex).trim() : '';
};



// 只取命令行第一个可执行文件名，兼容 PowerShell `&`、Windows 引号路径和 .cmd/.exe/.ps1/.bat 后缀。
export const extractTerminalExecutableName = (commandText: string) => {
  const commandHeadMatch = commandText.match(/^\s*(?:&\s*)?(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const commandHead = commandHeadMatch?.[1] ?? commandHeadMatch?.[2] ?? commandHeadMatch?.[3] ?? '';
  const executableName = commandHead.replace(/\\/g, '/').split('/').pop() ?? '';
  return executableName.replace(/\.(?:cmd|exe|ps1|bat)$/i, '').toLowerCase();
};



// AI Agent 会话按全屏 TUI 处理，用于套用光标、滚轮和对比度等专用渲染策略。
export const isTerminalAiAgentSession = (session?: TerminalSession) => {
  const executableName = extractTerminalExecutableName(resolveLocalSessionCommandText(session));
  return executableName ? terminalAiAgentCommandNames.has(executableName) : false;
};



// 部分 AI TUI 自绘输入光标，隐藏 xterm 光标可避免双光标；依赖终端光标的程序需排除。
export const shouldHideLocalTerminalCursor = (session?: TerminalSession) => {
  const executableName = extractTerminalExecutableName(resolveLocalSessionCommandText(session));
  return executableName ? terminalHideLocalCursorCommandNames.has(executableName) : false;
};



// 只在浅色 AI TUI 内软化黑色背景块，避免影响普通终端里 top/htop 等标准 ANSI 表现。
export const shouldUseSoftDarkBlocks = (session?: TerminalSession) => {
  const executableName = extractTerminalExecutableName(resolveLocalSessionCommandText(session));
  return executableName ? terminalSoftDarkBlockCommandNames.has(executableName) : false;
};



// Claude 菜单高亮依赖低对比浅色调，单独降低兜底强度以保留原始高亮语义。
export const resolveTerminalMinimumContrastRatio = (session?: TerminalSession) => {
  const executableName = extractTerminalExecutableName(resolveLocalSessionCommandText(session));
  return executableName && terminalLowerContrastCommandNames.has(executableName)
    ? terminalClaudeMinimumContrastRatio
    : terminalMinimumContrastRatio;
};



// 只有自绘输入框且 xterm cursor 与可见输入框分离的 CLI 需要重定位中文输入法锚点。
export const shouldAnchorTerminalImeToPrompt = (session?: TerminalSession) => {
  const executableName = extractTerminalExecutableName(resolveLocalSessionCommandText(session));
  return executableName ? terminalImeAnchorCommandNames.has(executableName) : false;
};



// 宿主平台只用于决定是否把 Ctrl+V 交还给 WebView 原生 paste；其它平台保留 Claude 自己的快捷键绑定。
export const isWindowsTerminalHost = () =>
  typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);



// 仅直接启动的本地 Claude 会话使用 Windows 原生 Ctrl+V 粘贴，其它终端程序继续收到 \x16。
export const shouldUseNativeCtrlVPaste = (session?: TerminalSession) => {
  const executableName = extractTerminalExecutableName(resolveLocalSessionCommandText(session));
  return executableName ? terminalNativeCtrlVPasteCommandNames.has(executableName) : false;
};



export const directImageUrlPattern = /^(https?:|data:|blob:|asset:|http:\/\/asset\.localhost)/i;


export const windowsAbsolutePathPattern = /^[a-z]:[\\/]/i;



export const isLocalImagePath = (value: string) => {
  const trimmed = value.trim();
  return Boolean(
    trimmed.startsWith('file://') ||
      trimmed.startsWith('/') ||
      trimmed.startsWith('~') ||
      windowsAbsolutePathPattern.test(trimmed),
  );
};



export const normalizeLocalFilePath = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith('file://')) {
    return trimmed;
  }

  try {
    return decodeURIComponent(new URL(trimmed).pathname).replace(/^\/([a-z]:[\\/])/i, '$1');
  } catch {
    return trimmed.replace(/^file:\/+/i, '');
  }
};



export const resolveTerminalBackgroundImage = (value?: string) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (directImageUrlPattern.test(trimmed)) {
    return trimmed;
  }
  if (isLocalImagePath(trimmed) && isTauri()) {
    return convertFileSrc(normalizeLocalFilePath(trimmed));
  }
  return trimmed;
};



// 远程 http(s) 背景图需要走后端下载绕开防盗链，其余(本地路径、data:、asset:)由 CSS 直接加载。
export const isRemoteHttpImage = (value?: string) => {
  const trimmed = value?.trim().toLowerCase();
  return Boolean(trimmed && (trimmed.startsWith('http://') || trimmed.startsWith('https://')));
};



// resolvedImage 由调用方决定：本地/asset 直接解析，远程 http(s) 图片先经后端下载成 data URL 再传入。
export const buildTerminalBackgroundImageStyle = (
  settings: AppSettings,
  resolvedImage: string | undefined,
): CSSProperties | undefined => {
  if (!resolvedImage) {
    return undefined;
  }

  const opacity = Math.min(1, Math.max(0, settings.terminalBackgroundImageOpacity ?? 0.18));
  const fit = settings.terminalBackgroundImageFit ?? 'cover';
  const baseStyle: CSSProperties = {
    backgroundImage: `url("${resolvedImage.replace(/"/g, '\\"')}")`,
    opacity,
  };

  // 背景适配只作用于终端区域，不影响应用外壳；不同图片比例由用户选择填充策略。
  if (fit === 'contain') {
    return { ...baseStyle, backgroundPosition: 'center', backgroundRepeat: 'no-repeat', backgroundSize: 'contain' };
  }
  if (fit === 'stretch') {
    return { ...baseStyle, backgroundPosition: 'center', backgroundRepeat: 'no-repeat', backgroundSize: '100% 100%' };
  }
  if (fit === 'tile') {
    return { ...baseStyle, backgroundPosition: 'top left', backgroundRepeat: 'repeat', backgroundSize: 'auto' };
  }
  if (fit === 'center') {
    return { ...baseStyle, backgroundPosition: 'center', backgroundRepeat: 'no-repeat', backgroundSize: 'auto' };
  }
  return { ...baseStyle, backgroundPosition: 'center', backgroundRepeat: 'no-repeat', backgroundSize: 'cover' };
};



// 浅色模式的默认终端配色；深色模式使用暗底亮字避免白屏刺眼。
export const defaultLightTerminalBackground = '#f7f7f7';


export const defaultLightTerminalForeground = '#111111';


export const defaultDarkTerminalBackground = '#1e1e2e';


export const defaultDarkTerminalForeground = '#e0e0e0';



export type TerminalRgbColor = {
  red: number;
  green: number;
  blue: number;
};



// 主题色来自颜色选择器时通常是 hex，这里额外兼容 rgb/rgba，供透明背景和光标对比度共用。
export const parseTerminalRgbColor = (value: string): TerminalRgbColor | undefined => {
  const trimmed = value.trim();
  const shortHexMatch = trimmed.match(/^#([\da-f])([\da-f])([\da-f])(?:[\da-f])?$/i);
  if (shortHexMatch) {
    return {
      red: parseInt(shortHexMatch[1].repeat(2), 16),
      green: parseInt(shortHexMatch[2].repeat(2), 16),
      blue: parseInt(shortHexMatch[3].repeat(2), 16),
    };
  }

  const hexMatch = trimmed.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})(?:[\da-f]{2})?$/i);
  if (hexMatch) {
    return {
      red: parseInt(hexMatch[1], 16),
      green: parseInt(hexMatch[2], 16),
      blue: parseInt(hexMatch[3], 16),
    };
  }

  const rgbMatch = trimmed.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(?:0|1|\d?\.\d+)\s*)?\)$/i);
  if (!rgbMatch) {
    return undefined;
  }

  const red = Number(rgbMatch[1]);
  const green = Number(rgbMatch[2]);
  const blue = Number(rgbMatch[3]);
  if ([red, green, blue].some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
    return undefined;
  }
  return { red, green, blue };
};



// 根据主题自动选择终端背景/前景色：如果用户仍为默认值则跟随主题切换，自定义过的保持不变。
export const resolveTerminalColors = (settings: AppSettings) => {
  const isDarkTheme = settings.themeMode === 'dark';
  const isDefaultLightBg = settings.terminalBackground === defaultLightTerminalBackground;
  const isDefaultLightFg = settings.terminalForeground === defaultLightTerminalForeground;
  const isDefaultDarkBg = settings.terminalBackground === defaultDarkTerminalBackground;
  const isDefaultDarkFg = settings.terminalForeground === defaultDarkTerminalForeground;
  const background = isDarkTheme
    ? (isDefaultLightBg ? defaultDarkTerminalBackground : settings.terminalBackground)
    : (isDefaultDarkBg ? defaultLightTerminalBackground : settings.terminalBackground);
  const foreground = isDarkTheme
    ? (isDefaultLightFg ? defaultDarkTerminalForeground : settings.terminalForeground)
    : (isDefaultDarkFg ? defaultLightTerminalForeground : settings.terminalForeground);
  return { background, foreground };
};



// xterm 反色属性会用默认背景的 RGB 作为反色前景；背景仍需 alpha=0，避免遮住终端背景图和选区 SVG。
export const buildTransparentTerminalThemeBackground = (background: string) => {
  const rgb = parseTerminalRgbColor(background);
  if (rgb) {
    return `rgba(${rgb.red}, ${rgb.green}, ${rgb.blue}, 0)`;
  }

  // 非常规 CSS 颜色无法可靠保留色相并透明化；保留原有透明兜底，避免意外遮挡背景图。
  return 'rgba(0, 0, 0, 0)';
};



// 光标颜色只跟随应用主题：浅色模式黑色，深色模式白色，避免不同 TUI 之间切换时颜色跳变。
export const resolveTerminalCursorTheme = (isDarkTheme: boolean) =>
  isDarkTheme
    ? { cursor: '#f8fafc', cursorAccent: '#111827' }
    : { cursor: '#111827', cursorAccent: '#f8fafc' };



export type TerminalThemeOptions = {
  softenDarkBlocks?: boolean;
};



// 终端彩色文本使用清晰的 ANSI 调色板；浅色终端里 ANSI white 也要落到深灰，避免 ls 高亮发白发虚。
// xterm theme background 始终设为透明，让选区 SVG 覆盖层可以从 canvas 后面透出来。
export const buildTerminalTheme = (settings: AppSettings, options: TerminalThemeOptions = {}) => {
  const isDarkTheme = settings.themeMode === 'dark';
  const { background, foreground } = resolveTerminalColors(settings);
  const cursorTheme = resolveTerminalCursorTheme(isDarkTheme);
  const shouldSoftenDarkBlocks = !isDarkTheme && Boolean(options.softenDarkBlocks);
  const resolvedForeground = shouldSoftenDarkBlocks ? terminalSoftDarkBlockLightBackground : foreground;
  const resolvedAnsiBlack = shouldSoftenDarkBlocks ? terminalSoftDarkBlockLightBackground : (isDarkTheme ? '#020617' : '#111827');

  return {
    // canvas 背景透明，但 RGB 取真实背景色，保证 top 等反色行在浅色模式下不会变成黑底黑字。
    background: buildTransparentTerminalThemeBackground(background),
    foreground: resolvedForeground,
    cursor: cursorTheme.cursor,
    cursorAccent: cursorTheme.cursorAccent,
    // 终端选区使用用户指定的柔和紫色，xterm 原生层负责保持文字清晰可读。
    selectionBackground: '#c7c7fb',
    selectionInactiveBackground: '#c7c7fb',
    black: resolvedAnsiBlack,
    red: isDarkTheme ? '#dc2626' : '#b91c1c',
    green: isDarkTheme ? '#059669' : '#047857',
    yellow: isDarkTheme ? '#f59e0b' : '#92400e',
    blue: isDarkTheme ? '#2563eb' : '#1d4ed8',
    magenta: isDarkTheme ? '#9333ea' : '#7e22ce',
    cyan: isDarkTheme ? '#0891b2' : '#0e7490',
    white: isDarkTheme ? '#e5e7eb' : '#374151',
    brightBlack: isDarkTheme ? '#64748b' : '#4b5563',
    brightRed: isDarkTheme ? '#ef4444' : '#991b1b',
    brightGreen: isDarkTheme ? '#10b981' : '#065f46',
    brightYellow: isDarkTheme ? '#fbbf24' : '#78350f',
    brightBlue: isDarkTheme ? '#3b82f6' : '#1e40af',
    brightMagenta: isDarkTheme ? '#a855f7' : '#6b21a8',
    brightCyan: isDarkTheme ? '#06b6d4' : '#155e75',
    brightWhite: isDarkTheme ? '#f9fafb' : '#111827',
  };
};



export type TerminalTheme = ReturnType<typeof buildTerminalTheme>;



// 覆盖光标需要避开 Codex 深浅混合输入行；按单元格实际背景选择反差最大的黑/白色。
export const resolveTerminalPaletteRgbColor = (paletteIndex: number, theme: TerminalTheme) => {
  const ansiPalette = [
    theme.black,
    theme.red,
    theme.green,
    theme.yellow,
    theme.blue,
    theme.magenta,
    theme.cyan,
    theme.white,
    theme.brightBlack,
    theme.brightRed,
    theme.brightGreen,
    theme.brightYellow,
    theme.brightBlue,
    theme.brightMagenta,
    theme.brightCyan,
    theme.brightWhite,
  ];
  const ansiColor = ansiPalette[paletteIndex];
  if (ansiColor) {
    return parseTerminalRgbColor(ansiColor);
  }

  if (paletteIndex >= 16 && paletteIndex <= 231) {
    const colorIndex = paletteIndex - 16;
    const redLevel = Math.floor(colorIndex / 36);
    const greenLevel = Math.floor((colorIndex % 36) / 6);
    const blueLevel = colorIndex % 6;
    const resolveLevel = (level: number) => level === 0 ? 0 : 55 + level * 40;
    return {
      red: resolveLevel(redLevel),
      green: resolveLevel(greenLevel),
      blue: resolveLevel(blueLevel),
    };
  }

  if (paletteIndex >= 232 && paletteIndex <= 255) {
    const level = 8 + (paletteIndex - 232) * 10;
    return { red: level, green: level, blue: level };
  }

  return undefined;
};



export const resolveTerminalTrueColorRgb = (color: number): TerminalRgbColor => ({
  red: (color >> 16) & 0xff,
  green: (color >> 8) & 0xff,
  blue: color & 0xff,
});



export const resolveTerminalCellColorRgb = (
  cell: IBufferCell,
  colorType: 'foreground' | 'background',
  theme: TerminalTheme,
  fallbackBackground: string,
) => {
  const isForeground = colorType === 'foreground';
  if (isForeground ? cell.isFgRGB() : cell.isBgRGB()) {
    return resolveTerminalTrueColorRgb(isForeground ? cell.getFgColor() : cell.getBgColor());
  }

  if (isForeground ? cell.isFgPalette() : cell.isBgPalette()) {
    return resolveTerminalPaletteRgbColor(isForeground ? cell.getFgColor() : cell.getBgColor(), theme);
  }

  return parseTerminalRgbColor(isForeground ? theme.foreground : fallbackBackground);
};



export const resolveTerminalCellVisualBackgroundRgb = (
  cell: IBufferCell | undefined,
  theme: TerminalTheme,
  fallbackBackground: string,
) => {
  if (!cell) {
    return parseTerminalRgbColor(fallbackBackground);
  }

  // 反色单元格的视觉背景来自前景色；Codex 输入框经常用这种方式画当前编辑区。
  return cell.isInverse()
    ? resolveTerminalCellColorRgb(cell, 'foreground', theme, fallbackBackground)
    : resolveTerminalCellColorRgb(cell, 'background', theme, fallbackBackground);
};



export const resolveTerminalRelativeLuminance = (color: TerminalRgbColor) => {
  const channels = [color.red, color.green, color.blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
};



// 仅对会在重绘中暴露临时原生光标位置的 TUI 启用宿主光标层，其它 TUI 保持协议原样。
export const shouldUseManagedTerminalCursor = (session?: TerminalSession) => {
  const executableName = extractTerminalExecutableName(resolveLocalSessionCommandText(session));
  if (executableName && terminalManagedCursorCommandNames.has(executableName)) {
    return true;
  }
  // 老会话或异常回包可能缺少 localCommand；标题仍保留“codex · cwd”，严格限制在行首以避免误伤同名目录。
  return Boolean(session?.kind === 'local' && /^\s*codex(?:\s|·|$)/i.test(session.title));
};



// OSC 12 除普通 CSS 十六进制外还允许 rgb:RR/GG/BB 或 16 位分量；统一折算为 8 位 RGB 供光标对比度判断。
export const parseTerminalOscRgbColor = (value: string): TerminalRgbColor | undefined => {
  const parsedCssColor = parseTerminalRgbColor(value);
  if (parsedCssColor) {
    return parsedCssColor;
  }

  const rgbMatch = value.trim().match(/^rgb:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})$/i);
  if (!rgbMatch) {
    return undefined;
  }
  const normalizeChannel = (channel: string) => {
    const rawValue = parseInt(channel, 16);
    const maximum = (16 ** channel.length) - 1;
    return Math.round((rawValue / maximum) * 255);
  };
  return {
    red: normalizeChannel(rgbMatch[1]),
    green: normalizeChannel(rgbMatch[2]),
    blue: normalizeChannel(rgbMatch[3]),
  };
};



// 光标属于非文本交互指示物，按 WCAG 非文本对比度算法判断是否需要反色兜底。
export const resolveTerminalColorContrastRatio = (first: TerminalRgbColor, second: TerminalRgbColor) => {
  const lighter = Math.max(resolveTerminalRelativeLuminance(first), resolveTerminalRelativeLuminance(second));
  const darker = Math.min(resolveTerminalRelativeLuminance(first), resolveTerminalRelativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
};
