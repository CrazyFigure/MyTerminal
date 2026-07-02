import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import { backend } from './backend';
import { readClipboardText, writeClipboardText } from './clipboard';
import { translate } from './i18n';
import type { AppSettings, TerminalOutputChunk, TerminalSession } from './types';

import '@xterm/xterm/css/xterm.css';

type Props = {
  session?: TerminalSession;
  settings: AppSettings;
  onTerminalData: (data: string) => void;
};

const terminalOutputEventName = 'myterminal-terminal-output';
const maxCachedTerminalOutputLength = 1_000_000;
const terminalCursorShowSequence = '\x1b[?25h';
const terminalCursorHideSequence = '\x1b[?25l';
// 横向滚动模式根据当前缓冲区最长逻辑行动态扩列，上限防止异常长行拖慢渲染。
const terminalHorizontalMaxColumns = 1000;
// 横向列数按块增长，避免每输入一个字符都触发一次 PTY resize。
const terminalHorizontalColumnGrowthStep = 40;
// 长行末尾额外留几列，避免文本刚好顶到横向画布边缘。
const terminalHorizontalLinePaddingColumns = 8;
// 光标跟随时右侧预留多个字符宽度，避免输入到边界时视觉上贴住容器。
const terminalCursorFollowMarginColumns = 8;
// xterm 内部竖向滚动区会占用少量宽度，横向宽度估算时预留出来避免最后几列被压住。
const terminalScrollbarReservePx = 18;
// 普通终端保留 xterm 默认滚屏历史，避免影响 SSH 和 Shell 的日常查看习惯。
const terminalDefaultScrollbackRows = 1000;
// AI Agent 也保留历史，避免窗口 resize 后把启动警告等一次性输出彻底丢掉；滚轮另行拦截。
const terminalAiAgentScrollbackRows = terminalDefaultScrollbackRows;
// 这些命令会以 TUI 方式反复重绘同一屏，必须固定在当前可视列宽内渲染。
const terminalAiAgentCommandNames = new Set(['claude', 'claude-code', 'codex', 'opencode', 'qwen', 'gemini', 'aider', 'cursor-agent']);
// 匹配高亮只绘制当前可查看区域，滚动时重算，避免为整个 scrollback 常驻创建大量 DOM。
const terminalMatchHighlightOverscanRows = 24;
// 单字符选择可能命中非常多内容，硬上限用于保护 WebView 内存和滚动帧率。
const terminalMatchHighlightMaxRanges = 1800;
// 选区和匹配项都用底层 SVG 色块绘制，颜色在文字下方，不覆盖终端字符。
const terminalSelectionHighlightBackground = '#c7c7fb';
const terminalSelectionHighlightBorder = '#b8b8f5';
const terminalMatchHighlightBackground = '#cfcfcf';
const terminalMatchHighlightBorder = '#bdbdbd';
const terminalHighlightSvgNamespace = 'http://www.w3.org/2000/svg';
// 圆角只做柔化，不接近胶囊形；终端行高较小时也保留轻微弧度。
const terminalHighlightCornerRadiusPx = 4;
const terminalHighlightBorderWidthPx = 1;
// 匹配块之间需要有可见间隙；只收缩每个命中块的外边缘，跨行命中内部仍保持连贯。
const terminalMatchHighlightGapPx = 1.5;

type TerminalLayoutSize = {
  // renderCols 是前端 xterm 的渲染列数，横向模式可临时扩大用于浏览当前可见长行。
  renderCols: number;
  // remoteCols 是远端 PTY 真实列数，必须保持为容器可视列数，避免 scp/top 等程序按虚假宽度布局。
  remoteCols: number;
  rows: number;
  visibleCols: number;
};

type TerminalMatchRange = {
  row: number;
  col: number;
  size: number;
};

type TerminalHighlightStrip = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type TerminalHighlightPoint = {
  x: number;
  y: number;
};

// 只有后端 PTY 已就绪的会话才接收键盘输入，connecting 阶段避免用户输入被前端或后端吞掉。
const canAcceptTerminalInput = (session?: TerminalSession) => Boolean(session && ['connected', 'stub'].includes(session.status));

// 列宽估算只看可见字符，先剥离常见 ANSI/OSC 控制序列，避免颜色和标题控制码被算成文本宽度。
const terminalOscSequencePattern = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
const terminalCsiSequencePattern = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const terminalShortEscapeSequencePattern = /\x1b[@-Z\\-_]/g;
const terminalTabStopColumns = 8;

// CJK、全角符号和常见 emoji 在终端里通常占两列，这里用于动态横向列宽的近似估算。
const isFullWidthCodePoint = (codePoint: number) =>
  (codePoint >= 0x1100 && codePoint <= 0x115f) ||
  codePoint === 0x2329 ||
  codePoint === 0x232a ||
  (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
  (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
  (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
  (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
  (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
  (codePoint >= 0xff00 && codePoint <= 0xff60) ||
  (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
  (codePoint >= 0x1f300 && codePoint <= 0x1faff);

const stripTerminalControlSequences = (value: string) =>
  value
    .replace(terminalOscSequencePattern, '')
    .replace(terminalCsiSequencePattern, '')
    .replace(terminalShortEscapeSequencePattern, '');

// 按终端单元格而不是字符串长度估算文本宽度，保证中文文件名不会低估横向空间。
const measureTerminalTextColumns = (value: string, startColumn = 0) => {
  let columns = startColumn;
  for (const character of stripTerminalControlSequences(value)) {
    if (character === '\t') {
      columns += terminalTabStopColumns - (columns % terminalTabStopColumns);
      continue;
    }
    if (character < ' ') {
      continue;
    }
    columns += isFullWidthCodePoint(character.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return columns;
};

const normalizeTerminalMatchSelection = (selection: string) => {
  const normalized = selection.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized || !normalized.trim() || normalized.includes('\n')) {
    return '';
  }
  return normalized;
};

// 复用 xterm search addon 的行合并思路：软换行需要当成同一条逻辑行搜索，硬换行才截断。
const translateTerminalBufferLineWithWrap = (terminal: Terminal, startRow: number) => {
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
const stringLengthToTerminalBufferSize = (terminal: Terminal, row: number, length: number) => {
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

const resolveTerminalMatchRange = (
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

const collectTerminalMatchRanges = (
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

const formatTerminalHighlightSvgNumber = (value: number) => {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return value.toFixed(2).replace(/\.?0+$/, '');
};

const isSameTerminalHighlightPoint = (first: TerminalHighlightPoint, second: TerminalHighlightPoint) =>
  Math.abs(first.x - second.x) < 0.01 && Math.abs(first.y - second.y) < 0.01;

const isTerminalHighlightPointCollinear = (
  previous: TerminalHighlightPoint,
  current: TerminalHighlightPoint,
  next: TerminalHighlightPoint,
) => {
  const cross = (current.x - previous.x) * (next.y - current.y) - (current.y - previous.y) * (next.x - current.x);
  return Math.abs(cross) < 0.01;
};

const simplifyTerminalHighlightPolygon = (points: TerminalHighlightPoint[]) => {
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

const buildTerminalRoundedPolygonPath = (points: TerminalHighlightPoint[], radius: number) => {
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

const buildTerminalHighlightPath = (strips: TerminalHighlightStrip[], radius: number) => {
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

const createTerminalHighlightPathElement = (className: string, color: string, borderColor: string, pathValue: string) => {
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

// 横向列数只在确实超过可视宽度时增长，并按固定步长取整来减少后端 resize 抖动。
const roundHorizontalColumns = (requiredColumns: number, visibleColumns: number) => {
  if (requiredColumns <= visibleColumns) {
    return visibleColumns;
  }
  const roundedColumns = Math.ceil(requiredColumns / terminalHorizontalColumnGrowthStep) * terminalHorizontalColumnGrowthStep;
  return Math.min(terminalHorizontalMaxColumns, Math.max(visibleColumns, roundedColumns));
};

// 本地终端新会话直接带 localCommand；旧会话或旧后端回退到“命令 · 目录”的标签格式解析。
const resolveLocalSessionCommandText = (session?: TerminalSession) => {
  if (session?.kind !== 'local') {
    return '';
  }
  if (session.localCommand?.trim()) {
    return session.localCommand.trim();
  }

  const titleSeparatorIndex = session.title.indexOf(' · ');
  return titleSeparatorIndex > 0 ? session.title.slice(0, titleSeparatorIndex).trim() : '';
};

// 只取命令行第一个可执行文件名，兼容 Windows 路径和 .cmd/.exe/.ps1 后缀。
const extractTerminalExecutableName = (commandText: string) => {
  const commandHeadMatch = commandText.match(/^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const commandHead = commandHeadMatch?.[1] ?? commandHeadMatch?.[2] ?? commandHeadMatch?.[3] ?? '';
  const executableName = commandHead.replace(/\\/g, '/').split('/').pop() ?? '';
  return executableName.replace(/\.(?:cmd|exe|ps1|bat)$/i, '').toLowerCase();
};

// AI Agent 会话按全屏 TUI 处理，不继承“同一行横向滚动”设置，避免 Claude Code 等界面错位。
const isTerminalAiAgentSession = (session?: TerminalSession) => {
  const executableName = extractTerminalExecutableName(resolveLocalSessionCommandText(session));
  return executableName ? terminalAiAgentCommandNames.has(executableName) : false;
};

const terminalFontFallbacks = ['Cascadia Mono', 'Consolas', 'Courier New', 'monospace'];

const quoteFontFamily = (fontFamily: string) => {
  const cleaned = fontFamily.trim().replace(/^['"]|['"]$/g, '');
  if (!cleaned) {
    return undefined;
  }
  return /\s/.test(cleaned) && cleaned !== 'monospace' ? `"${cleaned.replace(/"/g, '\\"')}"` : cleaned;
};

const buildTerminalFontFamily = (latinFontFamily: string, cjkFontFamily: string) => {
  const primaryFont = quoteFontFamily(latinFontFamily) ?? '"Cascadia Mono"';
  const cjkFont = quoteFontFamily(cjkFontFamily);
  const normalizedPrimary = primaryFont.replace(/^["']|["']$/g, '').toLowerCase();
  const normalizedCjk = cjkFont?.replace(/^["']|["']$/g, '').toLowerCase();
  const fallbackFonts = terminalFontFallbacks
    .filter((fallback) => fallback.toLowerCase() !== normalizedPrimary && fallback.toLowerCase() !== normalizedCjk)
    .map((fallback) => quoteFontFamily(fallback))
    .filter((fallback): fallback is string => Boolean(fallback));

  // 终端字体按英文、中文、等宽兜底排列，保证 ASCII 和 CJK 分别命中用户指定字体。
  return [primaryFont, cjkFont, ...fallbackFonts]
    .filter((fontFamily): fontFamily is string => Boolean(fontFamily))
    .filter((fontFamily, index, array) => array.indexOf(fontFamily) === index)
    .join(', ');
};

const directImageUrlPattern = /^(https?:|data:|blob:|asset:|http:\/\/asset\.localhost)/i;
const windowsAbsolutePathPattern = /^[a-z]:[\\/]/i;

const isLocalImagePath = (value: string) => {
  const trimmed = value.trim();
  return Boolean(
    trimmed.startsWith('file://') ||
      trimmed.startsWith('/') ||
      trimmed.startsWith('~') ||
      windowsAbsolutePathPattern.test(trimmed),
  );
};

const normalizeLocalFilePath = (value: string) => {
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

const resolveTerminalBackgroundImage = (value?: string) => {
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

const buildTerminalBackgroundImageStyle = (settings: AppSettings): CSSProperties | undefined => {
  const resolvedImage = resolveTerminalBackgroundImage(settings.backgroundImage);
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
const defaultLightTerminalBackground = '#f7f7f7';
const defaultLightTerminalForeground = '#111111';
const defaultDarkTerminalBackground = '#1e1e2e';
const defaultDarkTerminalForeground = '#e0e0e0';

// 根据主题自动选择终端背景/前景色：如果用户仍为默认值则跟随主题切换，自定义过的保持不变。
const resolveTerminalColors = (settings: AppSettings) => {
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

// 终端彩色文本使用清晰的 ANSI 调色板；浅色终端里 ANSI white 也要落到深灰，避免 ls 高亮发白发虚。
// xterm theme background 始终设为透明，让选区 SVG 覆盖层可以从 canvas 后面透出来。
const buildTerminalTheme = (settings: AppSettings) => {
  const isDarkTheme = settings.themeMode === 'dark';
  const { foreground } = resolveTerminalColors(settings);

  return {
    // canvas 背景透明，实际背景色由外层 .terminal-workspace 提供，选区覆盖层才能从下方显示出来。
    background: 'rgba(0, 0, 0, 0)',
    foreground,
    cursor: settings.accentColor,
    // 终端选区使用用户指定的柔和紫色，xterm 原生层负责保持文字清晰可读。
    selectionBackground: '#c7c7fb',
    selectionInactiveBackground: '#c7c7fb',
    black: isDarkTheme ? '#020617' : '#374151',
    red: '#dc2626',
    green: '#059669',
    yellow: isDarkTheme ? '#f59e0b' : '#b45309',
    blue: '#2563eb',
    magenta: '#9333ea',
    cyan: '#0891b2',
    white: isDarkTheme ? '#e5e7eb' : '#374151',
    brightBlack: isDarkTheme ? '#64748b' : '#6b7280',
    brightRed: '#ef4444',
    brightGreen: '#10b981',
    brightYellow: isDarkTheme ? '#fbbf24' : '#d97706',
    brightBlue: '#3b82f6',
    brightMagenta: '#a855f7',
    brightCyan: '#06b6d4',
    brightWhite: isDarkTheme ? '#f9fafb' : '#111827',
  };
};

export function TerminalWorkspace({ session, settings, onTerminalData }: Props) {
  const [terminalContextMenu, setTerminalContextMenu] = useState<{ x: number; y: number; selectedText: string } | null>(null);
  const [terminalHasHorizontalOverflow, setTerminalHasHorizontalOverflow] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const cachedOutputBySessionRef = useRef<Record<string, string>>({});
  const terminalMatchOverlayRef = useRef<SVGSVGElement | null>(null);
  const terminalMatchHighlightFrameRef = useRef<number | null>(null);
  const terminalSelectionOverlayRef = useRef<SVGSVGElement | null>(null);
  const terminalSelectionOverlayFrameRef = useRef<number | null>(null);
  const terminalSelectionDragActiveRef = useRef(false);
  const terminalSelectionDragFrameRef = useRef<number | null>(null);
  const onTerminalDataRef = useRef(onTerminalData);
  const sessionRef = useRef<TerminalSession | undefined>(session);
  const resizeFrameRef = useRef<number | null>(null);
  const cursorFollowFrameRef = useRef<number | null>(null);
  const remoteTerminalSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const pendingFocusSessionIdRef = useRef<string | null>(session?.id ?? null);
  const terminalLineWrapMode = settings.terminalLineWrapMode ?? 'wrap';
  const isAiAgentTerminalSession = useMemo(
    () => isTerminalAiAgentSession(session),
    [session?.kind, session?.localCommand, session?.title],
  );
  const effectiveTerminalLineWrapMode: AppSettings['terminalLineWrapMode'] = isAiAgentTerminalSession ? 'wrap' : terminalLineWrapMode;
  const terminalScrollbackRows = isAiAgentTerminalSession ? terminalAiAgentScrollbackRows : terminalDefaultScrollbackRows;
  const terminalLineWrapModeRef = useRef<AppSettings['terminalLineWrapMode']>(effectiveTerminalLineWrapMode);
  const terminalScrollbackRowsRef = useRef(terminalScrollbackRows);
  const isAiAgentTerminalSessionRef = useRef(isAiAgentTerminalSession);
  const terminalMatchSelectionRef = useRef(settings.terminalMatchSelection ?? true);
  const terminalTheme = useMemo(
    () => buildTerminalTheme(settings),
    [
      settings.accentColor,
      settings.terminalForeground,
      settings.themeMode,
    ],
  );
  const backgroundImageStyle = useMemo(
    () => buildTerminalBackgroundImageStyle(settings),
    [
      settings.backgroundImage,
      settings.terminalBackgroundImageFit,
      settings.terminalBackgroundImageOpacity,
    ],
  );
  // 外层容器的实际背景色：跟随主题自动切换，xterm canvas 始终透明以便选区覆盖层透出。
  const terminalBackgroundColor = useMemo(
    () => resolveTerminalColors(settings).background,
    [settings.terminalBackground, settings.themeMode],
  );
  const terminalFontFamily = useMemo(
    () => buildTerminalFontFamily(
      settings.shellLatinFontFamily ?? settings.shellFontFamily,
      settings.shellCjkFontFamily ?? settings.shellFontFamily,
    ),
    [settings.shellCjkFontFamily, settings.shellFontFamily, settings.shellLatinFontFamily],
  );
  terminalLineWrapModeRef.current = effectiveTerminalLineWrapMode;
  terminalScrollbackRowsRef.current = terminalScrollbackRows;
  isAiAgentTerminalSessionRef.current = isAiAgentTerminalSession;
  terminalMatchSelectionRef.current = settings.terminalMatchSelection ?? true;

  useEffect(() => {
    onTerminalDataRef.current = onTerminalData;
  }, [onTerminalData]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // 终端焦点恢复只面向可输入会话，避免关闭或异常会话重新抢占页面焦点。
  const focusTerminalInput = () => {
    const terminal = terminalRef.current;
    if (!terminal || !canAcceptTerminalInput(sessionRef.current)) {
      return;
    }

    terminal.focus();
  };

  // 点击顶部会话标签后先记住目标会话，等 SSH 从 connecting 进入可输入状态时再把焦点交回 xterm。
  const focusPendingTerminalInput = () => {
    const targetSessionId = pendingFocusSessionIdRef.current;
    if (!targetSessionId || sessionRef.current?.id !== targetSessionId || !canAcceptTerminalInput(sessionRef.current)) {
      return;
    }

    pendingFocusSessionIdRef.current = null;
    focusTerminalInput();
  };

  // AI TUI 会自己绘制输入光标，本地 xterm 光标必须隐藏，避免滚轮或重绘后出现黑蓝双光标。
  const syncLocalCursorVisibility = (restoreNormalCursor = true) => {
    const terminal = terminalRef.current;
    if (!terminal || !canAcceptTerminalInput(sessionRef.current)) {
      return;
    }

    if (isAiAgentTerminalSessionRef.current) {
      terminal.write(terminalCursorHideSequence);
      return;
    }

    if (restoreNormalCursor) {
      terminal.write(terminalCursorShowSequence);
    }
  };

  // 右键菜单动作完成后延后一帧恢复焦点，确保 React 已经卸载菜单按钮。
  const restoreTerminalFocusAfterContextMenuAction = () => {
    // 右键菜单按钮会短暂拿走焦点；等待菜单卸载后再聚焦 xterm，避免复制/粘贴后键盘输入停在旧光标状态。
    window.requestAnimationFrame(() => {
      focusTerminalInput();
    });
  };

  const clearTerminalMatchOverlay = () => {
    terminalMatchOverlayRef.current?.replaceChildren();
  };

  const syncTerminalHighlightOverlaySize = (overlay: SVGSVGElement, container: HTMLDivElement) => {
    const width = Math.max(container.scrollWidth, container.clientWidth);
    const height = Math.max(container.scrollHeight, container.clientHeight);
    overlay.setAttribute('width', `${width}`);
    overlay.setAttribute('height', `${height}`);
    overlay.style.width = `${width}px`;
    overlay.style.height = `${height}px`;
  };

  const clearTerminalSelectionOverlay = () => {
    const overlay = terminalSelectionOverlayRef.current;
    if (overlay) {
      overlay.replaceChildren();
    }
  };

  const resolveTerminalHighlightMetrics = () => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    if (!terminal || !container) {
      return undefined;
    }
    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen || terminal.cols <= 0 || terminal.rows <= 0) {
      return undefined;
    }

    const containerRect = container.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const buffer = terminal.buffer.active;
    const cellWidth = screenRect.width / terminal.cols;
    const cellHeight = screenRect.height / terminal.rows;
    const firstVisibleRow = buffer.viewportY;
    const lastVisibleRow = firstVisibleRow + terminal.rows - 1;
    return {
      terminal,
      container,
      cellWidth,
      cellHeight,
      firstVisibleRow,
      lastVisibleRow,
      leftBase: screenRect.left - containerRect.left + container.scrollLeft,
      topBase: screenRect.top - containerRect.top + container.scrollTop,
      cornerRadius: Math.min(terminalHighlightCornerRadiusPx, Math.max(2.5, cellHeight * 0.28)),
    };
  };

  const terminalRowsToHighlightStrips = (
    startRow: number,
    endRow: number,
    getColumns: (row: number) => { startColumn: number; endColumn: number },
  ) => {
    const metrics = resolveTerminalHighlightMetrics();
    if (!metrics) {
      return undefined;
    }

    const strips: TerminalHighlightStrip[] = [];
    const firstRow = Math.max(startRow, metrics.firstVisibleRow);
    const lastRow = Math.min(endRow, metrics.lastVisibleRow);
    for (let row = firstRow; row <= lastRow; row += 1) {
      const { startColumn, endColumn } = getColumns(row);
      const safeStartColumn = Math.min(Math.max(startColumn, 0), metrics.terminal.cols);
      const safeEndColumn = Math.min(Math.max(endColumn, 0), metrics.terminal.cols);
      if (safeEndColumn <= safeStartColumn) {
        continue;
      }
      const top = metrics.topBase + (row - metrics.firstVisibleRow) * metrics.cellHeight;
      strips.push({
        left: metrics.leftBase + safeStartColumn * metrics.cellWidth,
        top,
        right: metrics.leftBase + safeEndColumn * metrics.cellWidth,
        bottom: top + metrics.cellHeight,
      });
    }

    return { metrics, strips };
  };

  const syncTerminalSelectionOverlay = () => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    const overlay = terminalSelectionOverlayRef.current;
    const selectionPosition = terminal?.getSelectionPosition();
    if (!terminal || !container || !overlay) {
      clearTerminalSelectionOverlay();
      return;
    }

    const metrics = resolveTerminalHighlightMetrics();
    let resolved: { metrics: NonNullable<ReturnType<typeof resolveTerminalHighlightMetrics>>; strips: TerminalHighlightStrip[] } | undefined;
    if (selectionPosition && terminal.hasSelection()) {
      resolved = terminalRowsToHighlightStrips(selectionPosition.start.y, selectionPosition.end.y, (row) => ({
        startColumn: row === selectionPosition.start.y ? selectionPosition.start.x : 0,
        endColumn: row === selectionPosition.end.y ? selectionPosition.end.x : terminal.cols,
      }));
    } else if (metrics) {
      const containerRect = container.getBoundingClientRect();
      const strips = Array.from(terminal.element?.querySelectorAll<HTMLElement>('.xterm-selection div') ?? [])
        .map((selectionBlock) => {
          const rect = selectionBlock.getBoundingClientRect();
          return {
            left: rect.left - containerRect.left + container.scrollLeft,
            top: rect.top - containerRect.top + container.scrollTop,
            right: rect.right - containerRect.left + container.scrollLeft,
            bottom: rect.bottom - containerRect.top + container.scrollTop,
          };
        })
        .filter((strip) => strip.right > strip.left && strip.bottom > strip.top);
      resolved = { metrics, strips };
    }
    if (!resolved) {
      clearTerminalSelectionOverlay();
      return;
    }

    const pathValue = buildTerminalHighlightPath(resolved.strips, resolved.metrics.cornerRadius);
    const path = pathValue
      ? createTerminalHighlightPathElement(
        'terminal-selection-rounded-shape',
        terminalSelectionHighlightBackground,
        terminalSelectionHighlightBorder,
        pathValue,
      )
      : undefined;
    syncTerminalHighlightOverlaySize(overlay, container);
    overlay.replaceChildren(...(path ? [path] : []));
  };

  const scheduleTerminalSelectionOverlaySync = () => {
    if (terminalSelectionOverlayFrameRef.current !== null) {
      return;
    }

    terminalSelectionOverlayFrameRef.current = window.requestAnimationFrame(() => {
      terminalSelectionOverlayFrameRef.current = null;
      syncTerminalSelectionOverlay();
    });
  };

  const stopTerminalSelectionDragSync = () => {
    terminalSelectionDragActiveRef.current = false;
    if (terminalSelectionDragFrameRef.current !== null) {
      window.cancelAnimationFrame(terminalSelectionDragFrameRef.current);
      terminalSelectionDragFrameRef.current = null;
    }
    syncTerminalSelectionOverlay();
  };

  const scheduleTerminalSelectionDragSync = () => {
    if (!terminalSelectionDragActiveRef.current || terminalSelectionDragFrameRef.current !== null) {
      return;
    }

    terminalSelectionDragFrameRef.current = window.requestAnimationFrame(() => {
      terminalSelectionDragFrameRef.current = null;
      syncTerminalSelectionOverlay();
      scheduleTerminalSelectionDragSync();
    });
  };

  // xterm 的 selection change 在拖拽中不一定逐帧触发；鼠标按住时主动同步圆角层，避免临时露出空背景。
  const startTerminalSelectionDragSync = (event: MouseEvent) => {
    if (event.button !== 0) {
      return;
    }
    terminalSelectionDragActiveRef.current = true;
    scheduleTerminalSelectionDragSync();
  };

  const terminalMatchRangeToHighlightStrips = (
    range: TerminalMatchRange,
    metrics: NonNullable<ReturnType<typeof resolveTerminalHighlightMetrics>>,
  ) => {
    const strips: TerminalHighlightStrip[] = [];
    let row = range.row;
    let column = range.col;
    let remainingSize = range.size;
    while (remainingSize > 0) {
      const width = Math.min(Math.max(metrics.terminal.cols - column, 0), remainingSize);
      if (width > 0 && row >= metrics.firstVisibleRow && row <= metrics.lastVisibleRow) {
        const top = metrics.topBase + (row - metrics.firstVisibleRow) * metrics.cellHeight;
        const horizontalGap = Math.min(terminalMatchHighlightGapPx, (width * metrics.cellWidth) / 3);
        const verticalGap = Math.min(terminalMatchHighlightGapPx, metrics.cellHeight / 4);
        const isFirstRangeRow = row === range.row;
        const isLastRangeRow = remainingSize <= width;
        strips.push({
          left: metrics.leftBase + column * metrics.cellWidth + horizontalGap,
          top: top + (isFirstRangeRow ? verticalGap : 0),
          right: metrics.leftBase + (column + width) * metrics.cellWidth - horizontalGap,
          bottom: top + metrics.cellHeight - (isLastRangeRow ? verticalGap : 0),
        });
      }
      remainingSize -= width;
      row += 1;
      column = 0;
      if (width <= 0) {
        break;
      }
    }
    return { metrics, strips };
  };

  const refreshTerminalMatchHighlights = () => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    const overlay = terminalMatchOverlayRef.current;
    const metrics = resolveTerminalHighlightMetrics();
    if (!terminal || !container || !overlay || !metrics || !terminalMatchSelectionRef.current || !terminal.hasSelection()) {
      clearTerminalMatchOverlay();
      return;
    }

    const term = normalizeTerminalMatchSelection(terminal.getSelection());
    if (!term) {
      clearTerminalMatchOverlay();
      return;
    }

    const buffer = terminal.buffer.active;
    const firstHighlightedRow = Math.max(0, buffer.viewportY - terminalMatchHighlightOverscanRows);
    const lastHighlightedRowExclusive = Math.min(
      buffer.length,
      buffer.viewportY + terminal.rows + terminalMatchHighlightOverscanRows,
    );
    const ranges = collectTerminalMatchRanges(
      terminal,
      term,
      firstHighlightedRow,
      lastHighlightedRowExclusive,
      terminalMatchHighlightMaxRanges,
    );

    const paths: SVGPathElement[] = [];
    for (const range of ranges) {
      const resolved = terminalMatchRangeToHighlightStrips(range, metrics);
      if (!resolved.strips.length) {
        continue;
      }
      const pathValue = buildTerminalHighlightPath(resolved.strips, resolved.metrics.cornerRadius);
      if (pathValue) {
        paths.push(createTerminalHighlightPathElement(
          'terminal-match-rounded-shape',
          terminalMatchHighlightBackground,
          terminalMatchHighlightBorder,
          pathValue,
        ));
      }
    }

    syncTerminalHighlightOverlaySize(overlay, container);
    overlay.replaceChildren(...paths);
  };

  const scheduleTerminalMatchHighlightRefresh = () => {
    if (terminalMatchHighlightFrameRef.current !== null) {
      return;
    }

    terminalMatchHighlightFrameRef.current = window.requestAnimationFrame(() => {
      terminalMatchHighlightFrameRef.current = null;
      refreshTerminalMatchHighlights();
    });
  };

  // 会话级渲染选项必须先于缓存重放生效，保证切换普通终端和 AI TUI 时滚屏历史策略一致。
  const applyTerminalSessionBehaviorOptions = () => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    if (terminal.options.scrollback !== terminalScrollbackRowsRef.current) {
      terminal.options.scrollback = terminalScrollbackRowsRef.current;
    }
  };

  // 横向滚动模式只有在目标列数真正超过可视列数时才扩宽 xterm 元素，避免空会话也出现底部滑块。
  const applyTerminalElementWidth = (targetCols: number, visibleCols: number) => {
    const container = containerRef.current;
    const terminal = terminalRef.current;
    const terminalElement = terminal?.element;
    if (!container || !terminal || !terminalElement) {
      return;
    }

    const hasHorizontalOverflow = terminalLineWrapModeRef.current === 'horizontal' && targetCols > visibleCols;
    if (!hasHorizontalOverflow) {
      terminalElement.style.width = '100%';
      container.scrollLeft = 0;
      return;
    }

    const containerWidth = Number.parseFloat(window.getComputedStyle(container).width) || container.clientWidth;
    const fallbackCellWidth = (terminal.options.fontSize ?? 15) * 0.62;
    const cellWidth = visibleCols > 0 && containerWidth > 0
      ? containerWidth / visibleCols
      : fallbackCellWidth;
    const targetWidth = Math.ceil(Math.max(containerWidth, targetCols * Math.max(4, cellWidth) + terminalScrollbarReservePx));
    terminalElement.style.width = `${targetWidth}px`;
  };

  // 当前可视缓冲区通过 isWrapped 合并软换行片段，避免历史里的 Docker 进度长行永久撑大后续终端。
  const measureVisibleTerminalBufferLongestLineColumns = () => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return 0;
    }

    const buffer = terminal.buffer.active;
    let longestColumns = 0;
    let currentLineColumns = 0;
    // 横向滚动只服务当前看得见的内容；用户滚回历史时 onScroll 会重新测量对应窗口。
    const firstVisibleLine = Math.max(0, buffer.viewportY);
    const lastVisibleLine = Math.min(buffer.length, firstVisibleLine + terminal.rows);
    for (let lineIndex = firstVisibleLine; lineIndex < lastVisibleLine; lineIndex += 1) {
      const line = buffer.getLine(lineIndex);
      if (!line) {
        continue;
      }

      const lineColumns = measureTerminalTextColumns(line.translateToString(true));
      if (line.isWrapped) {
        currentLineColumns += lineColumns;
      } else {
        longestColumns = Math.max(longestColumns, currentLineColumns);
        currentLineColumns = lineColumns;
      }
      longestColumns = Math.max(longestColumns, currentLineColumns);
    }
    return longestColumns;
  };

  // 横向模式不固定扩到最大列数，而是按缓冲区最长逻辑行和光标余量动态计算目标列数。
  const resolveHorizontalTerminalColumns = (visibleCols: number) => {
    const terminal = terminalRef.current;
    if (!terminalLineWrapModeRef.current || terminalLineWrapModeRef.current !== 'horizontal' || !terminal) {
      return visibleCols;
    }

    const longestLineColumns = measureVisibleTerminalBufferLongestLineColumns();
    const cursorRequiredColumns = terminal.buffer.active.cursorX + terminalCursorFollowMarginColumns;
    const requiredColumns = Math.max(
      visibleCols,
      longestLineColumns + terminalHorizontalLinePaddingColumns,
      cursorRequiredColumns,
    );
    return roundHorizontalColumns(requiredColumns, visibleCols);
  };

  // 横向模式不使用 fitAddon.fit 直接改列数，而是按可视行数 + 动态目标列数手动 resize。
  const resolveTerminalLayoutSize = (): TerminalLayoutSize | undefined => {
    const terminal = terminalRef.current;
    const proposed = fitAddonRef.current?.proposeDimensions();
    if (!terminal || !proposed) {
      return undefined;
    }

    const visibleCols = Math.max(2, proposed.cols);
    const rows = Math.max(1, proposed.rows);
    // 远端 PTY 只同步真实可视列数；前端横向浏览需要的扩列仅作用于 xterm 渲染层。
    const renderCols = terminalLineWrapModeRef.current === 'horizontal'
      ? resolveHorizontalTerminalColumns(visibleCols)
      : visibleCols;
    return { renderCols, remoteCols: visibleCols, rows, visibleCols };
  };

  // 前端渲染尺寸和横向滚动状态集中在这里更新，缓存重放前也可复用以清掉旧宽度。
  const applyTerminalLayoutSize = (nextLayoutSize: TerminalLayoutSize) => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    const hasHorizontalOverflow = terminalLineWrapModeRef.current === 'horizontal' && nextLayoutSize.renderCols > nextLayoutSize.visibleCols;
    // 底部滑块和底部留白只在确实有横向溢出时启用，空会话和普通短输出保持干净画面。
    setTerminalHasHorizontalOverflow((current) => current === hasHorizontalOverflow ? current : hasHorizontalOverflow);
    applyTerminalElementWidth(nextLayoutSize.renderCols, nextLayoutSize.visibleCols);
    if (terminal.cols !== nextLayoutSize.renderCols || terminal.rows !== nextLayoutSize.rows) {
      terminal.resize(nextLayoutSize.renderCols, nextLayoutSize.rows);
    }
    applyTerminalElementWidth(nextLayoutSize.renderCols, nextLayoutSize.visibleCols);
  };

  // 输入、回显和程序重绘移动光标后，横向模式需要把视口跟到光标并保留右侧余量。
  const scrollTerminalCursorIntoView = () => {
    const container = containerRef.current;
    const terminal = terminalRef.current;
    if (!container || !terminal || terminalLineWrapModeRef.current !== 'horizontal') {
      return;
    }

    const maxScrollLeft = Math.max(0, container.scrollWidth - container.clientWidth);
    if (maxScrollLeft <= 0) {
      return;
    }

    const proposed = fitAddonRef.current?.proposeDimensions();
    const visibleCols = Math.max(1, proposed?.cols ?? Math.round(terminal.cols * container.clientWidth / Math.max(container.scrollWidth, 1)));
    const cellWidth = container.clientWidth / visibleCols;
    const cursorX = Math.min(Math.max(terminal.buffer.active.cursorX, 0), terminal.cols);
    const cursorLeft = cursorX * cellWidth;
    const margin = terminalCursorFollowMarginColumns * cellWidth;
    const viewportLeft = container.scrollLeft;
    const viewportRight = viewportLeft + container.clientWidth;

    if (cursorLeft + margin > viewportRight) {
      container.scrollLeft = Math.min(maxScrollLeft, cursorLeft + margin - container.clientWidth);
      return;
    }
    if (cursorLeft - margin < viewportLeft) {
      container.scrollLeft = Math.max(0, cursorLeft - margin);
    }
  };

  // 光标跟随合并到下一帧执行，避免大段输出时每个字符移动都触发布局计算。
  const scheduleTerminalCursorFollow = () => {
    if (terminalLineWrapModeRef.current !== 'horizontal' || cursorFollowFrameRef.current !== null) {
      return;
    }

    cursorFollowFrameRef.current = window.requestAnimationFrame(() => {
      cursorFollowFrameRef.current = null;
      scrollTerminalCursorIntoView();
    });
  };

  // 设置切换或会话切换后重放当前会话缓存，让已显示内容立即按新的列宽重新排版。
  const replayCurrentSessionOutput = () => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    clearTerminalMatchOverlay();
    clearTerminalSelectionOverlay();
    applyTerminalSessionBehaviorOptions();
    terminal.reset();
    const nextLayoutSize = resolveTerminalLayoutSize();
    if (nextLayoutSize) {
      applyTerminalLayoutSize(nextLayoutSize);
    }
    const cachedOutput = sessionRef.current?.id ? cachedOutputBySessionRef.current[sessionRef.current.id] ?? '' : '';
    if (cachedOutput) {
      terminal.write(cachedOutput, () => {
        scheduleTerminalSizeSync();
        syncLocalCursorVisibility();
        scheduleTerminalCursorFollow();
        scheduleTerminalMatchHighlightRefresh();
        scheduleTerminalSelectionOverlaySync();
      });
      return;
    }

    scheduleTerminalSizeSync();
    syncLocalCursorVisibility();
    scheduleTerminalCursorFollow();
    scheduleTerminalMatchHighlightRefresh();
    scheduleTerminalSelectionOverlaySync();
  };

  useEffect(() => {
    const closeTerminalContextMenu = () => setTerminalContextMenu(null);
    window.addEventListener('click', closeTerminalContextMenu);
    window.addEventListener('keydown', closeTerminalContextMenu);
    return () => {
      window.removeEventListener('click', closeTerminalContextMenu);
      window.removeEventListener('keydown', closeTerminalContextMenu);
    };
  }, []);

  // 右键粘贴复用终端输入通道，并按调用场景决定是否在粘贴后把键盘焦点交回 xterm。
  const pasteClipboardToTerminal = async (restoreFocusAfterPaste = false) => {
    if (!canAcceptTerminalInput(sessionRef.current)) {
      if (restoreFocusAfterPaste) {
        restoreTerminalFocusAfterContextMenuAction();
      }
      return;
    }

    try {
      // 右键粘贴直接走终端输入通道，保持和键盘粘贴完全一致的后端写入路径。
      const text = await readClipboardText().catch(() => '');
      if (text) {
        onTerminalDataRef.current(text);
      }
    } finally {
      if (restoreFocusAfterPaste) {
        restoreTerminalFocusAfterContextMenuAction();
      }
    }
  };

  const handleTerminalContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    if (settings.terminalRightClickBehavior !== 'menu') {
      void pasteClipboardToTerminal(true);
      return;
    }

    setTerminalContextMenu({
      x: event.clientX,
      y: event.clientY,
      selectedText: terminal.getSelection(),
    });
  };

  const handleTerminalWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!terminalHasHorizontalOverflow || !containerRef.current) {
      return;
    }

    // 触控板横向滑动直接移动横向视口；普通鼠标保留 Shift + 滚轮作为横向滚动补充。
    const horizontalDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ? event.deltaX
      : event.shiftKey
        ? event.deltaY
        : 0;
    if (!horizontalDelta) {
      return;
    }

    containerRef.current.scrollLeft += horizontalDelta;
    event.preventDefault();
    event.stopPropagation();
  };

  // AI TUI 的滚轮不能直接滚 xterm 历史，也不映射方向键，避免 Claude 输入区出现双光标。
  const handleAiAgentTerminalWheel = (event: WheelEvent) => {
    if (!isAiAgentTerminalSessionRef.current) {
      return true;
    }

    if (event.deltaY === 0 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      return true;
    }

    syncLocalCursorVisibility();
    event.preventDefault();
    event.stopPropagation();
    return false;
  };

  const syncTerminalSizeToRemote = () => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    const nextLayoutSize = resolveTerminalLayoutSize();
    if (!nextLayoutSize) {
      return;
    }

    applyTerminalLayoutSize(nextLayoutSize);

    const currentSession = sessionRef.current;
    const nextSize = { cols: nextLayoutSize.remoteCols, rows: nextLayoutSize.rows };
    const previousSize = remoteTerminalSizeRef.current;
    remoteTerminalSizeRef.current = nextSize;
    // 远端程序只能看到真实可视列宽；前端横向扩列不再污染 scp/docker/top 读取到的 PTY 尺寸。
    if (currentSession && (!previousSize || previousSize.cols !== nextSize.cols || previousSize.rows !== nextSize.rows)) {
      void backend.resizeTerminal(currentSession.id, nextLayoutSize.remoteCols, nextLayoutSize.rows);
    }
    scheduleTerminalCursorFollow();
    scheduleTerminalSelectionOverlaySync();
  };

  // 终端尺寸同步统一合并到动画帧，避免连续输出、拖拽窗口和输入回显造成密集 resize。
  const scheduleTerminalSizeSync = () => {
    if (resizeFrameRef.current !== null) {
      return;
    }

    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      syncTerminalSizeToRemote();
    });
  };

  useEffect(() => {
    if (!containerRef.current || terminalRef.current) {
      return;
    }

    // 终端实例只初始化一次；主题、字体和背景图后续通过 options 更新，避免设置视觉项时清空当前会话画面。
    const terminal = new Terminal({
      allowTransparency: true,
      // 交互 SSH PTY 必须保留远端原始 CR/LF 与 ANSI 行编辑序列；convertEol 会破坏长行历史重绘。
      convertEol: false,
      cursorBlink: true,
      disableStdin: !canAcceptTerminalInput(sessionRef.current),
      fontFamily: terminalFontFamily,
      fontSize: settings.shellFontSize,
      letterSpacing: 0,
      lineHeight: 1.18,
      scrollback: terminalScrollbackRows,
      theme: terminalTheme,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    const matchOverlay = document.createElementNS(terminalHighlightSvgNamespace, 'svg');
    matchOverlay.classList.add('terminal-match-rounded-overlay');
    containerRef.current.appendChild(matchOverlay);
    terminalMatchOverlayRef.current = matchOverlay;
    const selectionOverlay = document.createElementNS(terminalHighlightSvgNamespace, 'svg');
    selectionOverlay.classList.add('terminal-selection-rounded-overlay');
    containerRef.current.appendChild(selectionOverlay);
    terminalSelectionOverlayRef.current = selectionOverlay;
    terminal.attachCustomWheelEventHandler(handleAiAgentTerminalWheel);

    const dataDisposable = terminal.onData((data) => {
      if (canAcceptTerminalInput(sessionRef.current)) {
        onTerminalDataRef.current(data);
        scheduleTerminalCursorFollow();
      }
    });
    const cursorMoveDisposable = terminal.onCursorMove(scheduleTerminalCursorFollow);
    const scrollDisposable = terminal.onScroll(() => {
      scheduleTerminalSizeSync();
      scheduleTerminalMatchHighlightRefresh();
      scheduleTerminalSelectionOverlaySync();
    });
    const selectionDisposable = terminal.onSelectionChange(() => {
      scheduleTerminalMatchHighlightRefresh();
      syncTerminalSelectionOverlay();
    });
    const resizeDisposable = terminal.onResize(() => {
      scheduleTerminalMatchHighlightRefresh();
      scheduleTerminalSelectionOverlaySync();
    });
    const handleTerminalSurfaceScroll = () => {
      scheduleTerminalMatchHighlightRefresh();
      scheduleTerminalSelectionOverlaySync();
    };

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    syncTerminalSizeToRemote();

    const observer = new ResizeObserver(scheduleTerminalSizeSync);
    observer.observe(containerRef.current);
    window.addEventListener('resize', scheduleTerminalSizeSync);
    window.addEventListener('mouseup', stopTerminalSelectionDragSync, true);
    window.addEventListener('blur', stopTerminalSelectionDragSync);
    containerRef.current.addEventListener('mousedown', startTerminalSelectionDragSync, true);
    containerRef.current.addEventListener('scroll', handleTerminalSurfaceScroll);

    return () => {
      dataDisposable.dispose();
      cursorMoveDisposable.dispose();
      scrollDisposable.dispose();
      selectionDisposable.dispose();
      resizeDisposable.dispose();
      observer.disconnect();
      window.removeEventListener('resize', scheduleTerminalSizeSync);
      window.removeEventListener('mouseup', stopTerminalSelectionDragSync, true);
      window.removeEventListener('blur', stopTerminalSelectionDragSync);
      containerRef.current?.removeEventListener('mousedown', startTerminalSelectionDragSync, true);
      containerRef.current?.removeEventListener('scroll', handleTerminalSurfaceScroll);
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      if (cursorFollowFrameRef.current !== null) {
        window.cancelAnimationFrame(cursorFollowFrameRef.current);
        cursorFollowFrameRef.current = null;
      }
      if (terminalMatchHighlightFrameRef.current !== null) {
        window.cancelAnimationFrame(terminalMatchHighlightFrameRef.current);
        terminalMatchHighlightFrameRef.current = null;
      }
      if (terminalSelectionOverlayFrameRef.current !== null) {
        window.cancelAnimationFrame(terminalSelectionOverlayFrameRef.current);
        terminalSelectionOverlayFrameRef.current = null;
      }
      if (terminalSelectionDragFrameRef.current !== null) {
        window.cancelAnimationFrame(terminalSelectionDragFrameRef.current);
        terminalSelectionDragFrameRef.current = null;
      }
      terminalSelectionDragActiveRef.current = false;
      clearTerminalMatchOverlay();
      matchOverlay.remove();
      selectionOverlay.remove();
      terminalMatchOverlayRef.current = null;
      terminalSelectionOverlayRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  useEffect(() => {
    const handleTerminalOutput = (event: Event) => {
      const chunk = (event as CustomEvent<TerminalOutputChunk>).detail;
      if (!chunk?.sessionId || !chunk.content) {
        return;
      }

      // 终端输出直接写入 xterm，避免每 80ms 把大字符串塞进 React 状态导致输入、滚动和选区明显卡顿。
      const cached = `${cachedOutputBySessionRef.current[chunk.sessionId] ?? ''}${chunk.content}`;
      cachedOutputBySessionRef.current[chunk.sessionId] =
        cached.length > maxCachedTerminalOutputLength ? cached.slice(-maxCachedTerminalOutputLength) : cached;

      if (sessionRef.current?.id === chunk.sessionId) {
        terminalRef.current?.write(chunk.content, () => {
          scheduleTerminalSizeSync();
          syncLocalCursorVisibility(false);
          scheduleTerminalCursorFollow();
          scheduleTerminalMatchHighlightRefresh();
          scheduleTerminalSelectionOverlaySync();
        });
      }
    };

    window.addEventListener(terminalOutputEventName, handleTerminalOutput);
    return () => window.removeEventListener(terminalOutputEventName, handleTerminalOutput);
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    terminal.options.disableStdin = !canAcceptTerminalInput(session);
    applyTerminalSessionBehaviorOptions();
    syncLocalCursorVisibility();
    window.requestAnimationFrame(focusPendingTerminalInput);
  }, [session?.id, session?.status, terminalScrollbackRows]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    // 字体和终端主题变化才重新测量 xterm；背景图适配/透明度只更新底层图片，不能牵动字符画布缩放。
    terminal.options.fontFamily = terminalFontFamily;
    terminal.options.fontSize = settings.shellFontSize;
    terminal.options.letterSpacing = 0;
    terminal.options.theme = terminalTheme;
    terminal.clearTextureAtlas();

    window.requestAnimationFrame(() => {
      syncTerminalSizeToRemote();
      scheduleTerminalMatchHighlightRefresh();
      scheduleTerminalSelectionOverlaySync();
    });
  }, [settings.shellFontSize, terminalFontFamily, terminalTheme]);

  useEffect(() => {
    if (settings.terminalMatchSelection ?? true) {
      scheduleTerminalMatchHighlightRefresh();
      return;
    }

    clearTerminalMatchOverlay();
  }, [settings.terminalMatchSelection]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    pendingFocusSessionIdRef.current = session?.id ?? null;
    replayCurrentSessionOutput();
    // 新会话打开时立刻把当前 xterm 尺寸推给远端 PTY，避免默认 120 列和实际界面列宽不一致。
    remoteTerminalSizeRef.current = null;
    window.requestAnimationFrame(() => {
      syncTerminalSizeToRemote();
      focusPendingTerminalInput();
    });
  }, [session?.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    // 长行展示模式改变会影响 xterm 渲染列数；AI Agent 始终使用 wrap，远端仍重推真实可视列宽。
    remoteTerminalSizeRef.current = null;
    window.requestAnimationFrame(() => {
      syncTerminalSizeToRemote();
      replayCurrentSessionOutput();
    });
  }, [effectiveTerminalLineWrapMode]);

  return (
    <section className="terminal-workspace card" style={{ background: terminalBackgroundColor }}>
      {backgroundImageStyle ? <div className="terminal-background-image" style={backgroundImageStyle} /> : null}
      <div
        className={`terminal-surface ${terminalHasHorizontalOverflow && effectiveTerminalLineWrapMode === 'horizontal' ? 'is-horizontal-scroll' : 'is-wrapped'}`}
        ref={containerRef}
        onContextMenu={handleTerminalContextMenu}
        onWheel={handleTerminalWheel}
      />

      {terminalContextMenu ? (
        <div
          className="context-menu terminal-context-menu"
          style={{ left: terminalContextMenu.x, top: terminalContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            className="context-menu-item"
            disabled={!terminalContextMenu.selectedText}
            onClick={() => {
              const selectedText = terminalContextMenu.selectedText;
              setTerminalContextMenu(null);
              restoreTerminalFocusAfterContextMenuAction();
              if (selectedText) {
                void writeClipboardText(selectedText).catch(() => undefined);
              }
            }}
            type="button"
          >
            {translate(settings.uiLanguage, 'terminalMenuCopy')}
          </button>
          <button
            className="context-menu-item"
            disabled={!canAcceptTerminalInput(session)}
            onClick={() => {
              setTerminalContextMenu(null);
              void pasteClipboardToTerminal(true);
            }}
            type="button"
          >
            {translate(settings.uiLanguage, 'terminalMenuPaste')}
          </button>
        </div>
      ) : null}

      {!session ? (
        <div className="terminal-empty-state">
          <p>{translate(settings.uiLanguage, 'terminalPlaceholder')}</p>
        </div>
      ) : null}
    </section>
  );
}
