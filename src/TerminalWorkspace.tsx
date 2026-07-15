import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
import { Terminal, type IBufferCell, type IBufferLine, type IDisposable, type IMarker } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import { backend } from './backend';
import { readClipboardText, writeClipboardText } from './clipboard';
import { translate } from './i18n';
import { TerminalOutputCache } from './terminalCache';
import type { AppSettings, TerminalOutputChunk, TerminalSession } from './types';

import '@xterm/xterm/css/xterm.css';

type Props = {
  session?: TerminalSession;
  settings: AppSettings;
  onTerminalData: (data: string) => void;
  // 行号栏右键菜单切换显示项后，需要把设置写回并持久化。
  onUpdateSettings: (partial: Partial<AppSettings>) => void;
  // 当前仍存活的会话 ID 列表；用于关闭标签后显式回收对应的输出缓存与行号时间线。
  liveSessionIds: string[];
};

const terminalOutputEventName = 'myterminal-terminal-output';
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
// 只有本地输入后的短时间内才自动跟随光标，避免 top、htop 等远端 TUI 定时重绘把横向视口推走。
const terminalCursorFollowAfterInputMs = 1800;
// xterm 内部竖向滚动区会占用少量宽度，横向宽度估算时预留出来避免最后几列被压住。
const terminalScrollbarReservePx = 18;
// 横向长行模式下，鼠标靠近右侧时显示可视区固定的竖向滚动条，避免原生滚动条跑到长行内容最右端。
const terminalVerticalScrollbarRevealZonePx = 44;
// 右侧自绘滚动条宽度和右边距必须和 CSS 保持一致，用于按 scrollLeft 定位到当前可视区右边。
const terminalVerticalScrollbarWidthPx = 12;
const terminalVerticalScrollbarRightInsetPx = 4;
const terminalVerticalScrollbarTopInsetPx = 8;
const terminalVerticalScrollbarBottomInsetPx = 22;
// 自绘竖向滚动条最小拇指高度，保证日志很多时仍能被鼠标稳定命中。
const terminalVerticalScrollbarMinThumbHeightPx = 32;
// 普通终端保留 xterm 默认滚屏历史，避免影响 SSH 和 Shell 的日常查看习惯。
const terminalDefaultScrollbackRows = 1000;
// AI Agent 也保留历史，避免窗口 resize 后把启动警告等一次性输出彻底丢掉；滚轮另行拦截。
const terminalAiAgentScrollbackRows = terminalDefaultScrollbackRows;
// xterm 对 CLI 自绘颜色做逐格对比度兜底，覆盖浅色主题里的浅灰字和深色输入条上的默认黑字。
const terminalMinimumContrastRatio = 7;
// Claude Code 用浅蓝/浅紫表达菜单选中态，使用 AA 级别兜底增强可读性，同时避免高亮色被压成黑色。
const terminalClaudeMinimumContrastRatio = 4.5;
// 这些命令会以 TUI 方式反复重绘同一屏，必须固定在当前可视列宽内渲染。
const terminalAiAgentCommandNames = new Set(['claude', 'claude-code', 'codex', 'opencode', 'qwen', 'gemini', 'aider', 'cursor-agent']);
// Claude/Codex 会自绘输入光标，必须隐藏 xterm 光标，避免额外出现第二个光标。
const terminalHideLocalCursorCommandNames = new Set(['claude', 'claude-code', 'codex', 'qwen', 'gemini', 'aider', 'cursor-agent']);
// 浅色模式下 Codex 会用 ANSI black 或反色块表示输入区，映射成柔和底色避免黑块过重。
const terminalSoftDarkBlockCommandNames = new Set(['codex']);
const terminalLowerContrastCommandNames = new Set(['claude', 'claude-code']);
// 这些 TUI 不会稳定自绘光标，输出重绘后也要把 xterm 光标恢复出来。
const terminalForceShowLocalCursorCommandNames = new Set(['opencode']);
const terminalSoftDarkBlockLightBackground = '#e0e7ff';
// Claude 自绘输入框时 xterm 真实 cursor 可能停在状态栏；中文输入法候选框需要锚到可见输入行。
const terminalImeAnchorCommandNames = new Set(['claude', 'claude-code']);
// Codex 的真实 xterm cursor 会停在状态栏，需要用前端受控光标锚到输入行。
const terminalControlledInputCursorCommandNames = new Set(['codex']);
// 匹配高亮只绘制当前可查看区域，滚动时重算，避免为整个 scrollback 常驻创建大量 DOM。
const terminalMatchHighlightOverscanRows = 24;
// 单字符选择可能命中非常多内容，硬上限用于保护 WebView 内存和滚动帧率。
const terminalMatchHighlightMaxRanges = 1800;
// 选区和匹配项都用底层 SVG 色块绘制，颜色在文字下方，不覆盖终端字符；深色匹配项额外用 xterm decoration 调整文字色。
const terminalSelectionHighlightBackground = '#c7c7fb';
const terminalSelectionHighlightBorder = '#b8b8f5';
const terminalMatchHighlightLightBackground = '#cfcfcf';
const terminalMatchHighlightLightBorder = '#bdbdbd';
const terminalMatchHighlightDarkBackground = '#d8d6ff';
const terminalMatchHighlightDarkBorder = '#b9b5ff';
const terminalMatchHighlightDarkForeground = '#111827';
const terminalHighlightSvgNamespace = 'http://www.w3.org/2000/svg';
// 圆角只做柔化，不接近胶囊形；终端行高较小时也保留轻微弧度。
const terminalHighlightCornerRadiusPx = 4;
const terminalHighlightBorderWidthPx = 1;
// 匹配块之间需要有可见间隙；只收缩每个命中块的外边缘，跨行命中内部仍保持连贯。
const terminalMatchHighlightGapPx = 1.5;

// 行号栏（gutter）都不显示时仍保留少量宽度，用于承载右键菜单命中区域。
const terminalGutterMinWidthPx = 16;
// 行号栏左右内边距，保证时间戳/行号不贴住边缘；左侧取较小值避免时间戳与 gutter 左缘之间出现空隙。
const terminalGutterHorizontalPaddingPx = 6;
// 时间戳固定按 [HH:MM:SS] 展示；行号右对齐，位宽随当前最大逻辑行号动态增长。
const terminalGutterTimestampCharCount = 10;
const terminalGutterMinDigits = 2;
// 行号栏字体相对终端字号略小，避免占用过多正文宽度；同时保证最小可读像素。
const terminalGutterFontScale = 0.9;
const terminalGutterMinFontSizePx = 11;
// 等宽字体单字符宽度估算系数，用于按字符数换算行号栏像素宽度。
const terminalGutterCharWidthRatio = 0.62;
// 软换行续行在行号列以该符号占位，表示它属于上一条逻辑行。
const terminalGutterWrappedLineSymbol = '-';
// 每个会话最多缓存这么多条逻辑行的到达时刻，超出后从最旧端回收并用 base 记录已丢弃数量。
const terminalGutterMaxTrackedLines = 5000;

// 每条稳定逻辑行用一个 xterm marker 锚定其起始 buffer 行；marker 会随滚动、reflow 自动跟随，
// 被 scrollback 裁剪时自动 dispose。ANSI 光标移动重新落到已有 buffer 行时复用原 marker 和行号，
// 从根源上避免 Docker Compose 等动态进度内容每次重画都把同一显示行当成新行。

// 按会话持久缓存的稳定逻辑行时间线：times[i] 是累计编号为 (base + i + 1) 的逻辑行首次出现时刻（ms）。
// base 记录已从最旧端回收的行数，保证累计编号（行号）持续增长且不回退。
type TerminalGutterSessionData = {
  times: number[];
  base: number;
};

// 每个 marker 直接携带稳定逻辑行号；动态进度输出反复覆盖同一 buffer 行时复用原 marker，禁止重新编号。
type TerminalGutterMarkerEntry = {
  marker: IMarker;
  logicalNumber: number;
};

// 行号栏时间戳固定使用本地时区 HH:MM:SS，与常见远程终端展示保持一致。
const formatTerminalGutterClock = (timestampMs: number) => {
  const date = new Date(timestampMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

type TerminalLayoutSize = {
  // renderCols 是前端 xterm 的渲染列数，横向模式可临时扩大用于浏览当前可见长行。
  renderCols: number;
  // remoteCols 是发给远端 PTY 的列数，必须与 renderCols 保持一致，否则 readline/zle 会按错误宽度
  // 计算命令行重绘时要清除的物理行数，导致按上/下键翻历史命令时旧行和右侧内容残留清不掉。
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

type TerminalMatchDecorationRange = {
  row: number;
  column: number;
  width: number;
};

type TerminalSelectionPosition = {
  start: {
    x: number;
    y: number;
  };
  end: {
    x: number;
    y: number;
  };
};

type TerminalSelectionSnapshot = {
  text: string;
  position: TerminalSelectionPosition;
  cols: number;
  sessionId?: string;
};

type TerminalHighlightPoint = {
  x: number;
  y: number;
};

type TerminalPromptAnchor = {
  row: number;
  column: number;
  screenLeft: number;
  screenTop: number;
  containerLeft: number;
  containerTop: number;
  cellWidth: number;
  cellHeight: number;
};

type TerminalVerticalScrollbarMetrics = {
  thumbHeight: number;
  thumbTop: number;
  maxThumbTop: number;
  maxScrollLine: number;
};

type TerminalVerticalScrollbarDragState = {
  originY: number;
  originThumbTop: number;
  maxThumbTop: number;
  maxScrollLine: number;
};

// 只有后端 PTY 已就绪的会话才接收键盘输入，connecting 阶段避免用户输入被前端或后端吞掉。
const canAcceptTerminalInput = (session?: TerminalSession) => Boolean(session && ['connected', 'stub'].includes(session.status));

const clampTerminalNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// 横向宽度只看当前列范围内的真实文本单元格；带反色背景的行尾空格不能把 TUI 标题栏算成长行内容。
const measureTerminalBufferLineContentColumns = (line: IBufferLine, maxColumns: number) => {
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

const normalizeTerminalMatchSelection = (selection: string) => {
  const normalized = selection.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!normalized || !normalized.trim() || normalized.includes('\n')) {
    return '';
  }
  return normalized;
};

const normalizeTerminalSelectionSnapshotText = (selection: string) =>
  selection.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\u00a0/g, ' ');

const cloneTerminalSelectionPosition = (position: TerminalSelectionPosition): TerminalSelectionPosition => ({
  start: { x: position.start.x, y: position.start.y },
  end: { x: position.end.x, y: position.end.y },
});

const terminalSelectionPositionHasRange = (position: TerminalSelectionPosition) =>
  position.start.x !== position.end.x || position.start.y !== position.end.y;

const resolveTerminalSelectionLength = (position: TerminalSelectionPosition, cols: number) =>
  (position.end.y - position.start.y) * cols - position.start.x + position.end.x;

// 选区快照校验直接从当前缓冲区重读文本，避免把已经被 scrollback trim 或 resize reflow 改写的旧坐标硬恢复出来。
const readTerminalSelectionTextFromBuffer = (terminal: Terminal, position: TerminalSelectionPosition) => {
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

// 匹配高亮需要按主题换底色，避免深色模式白色终端字压在浅灰命中块上读不清。
const resolveTerminalMatchHighlightColors = (isDarkTheme: boolean) => (
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

// AI Agent 会话按全屏 TUI 处理，用于套用光标、滚轮和对比度等专用渲染策略。
const isTerminalAiAgentSession = (session?: TerminalSession) => {
  const executableName = extractTerminalExecutableName(resolveLocalSessionCommandText(session));
  return executableName ? terminalAiAgentCommandNames.has(executableName) : false;
};

// 部分 AI TUI 自绘输入光标，隐藏 xterm 光标可避免双光标；依赖终端光标的程序需排除。
const shouldHideLocalTerminalCursor = (session?: TerminalSession) => {
  const executableName = extractTerminalExecutableName(resolveLocalSessionCommandText(session));
  return executableName ? terminalHideLocalCursorCommandNames.has(executableName) : false;
};

// 只在浅色 AI TUI 内软化黑色背景块，避免影响普通终端里 top/htop 等标准 ANSI 表现。
const shouldUseSoftDarkBlocks = (session?: TerminalSession) => {
  const executableName = extractTerminalExecutableName(resolveLocalSessionCommandText(session));
  return executableName ? terminalSoftDarkBlockCommandNames.has(executableName) : false;
};

// Claude 菜单高亮依赖低对比浅色调，单独降低兜底强度以保留原始高亮语义。
const resolveTerminalMinimumContrastRatio = (session?: TerminalSession) => {
  const executableName = extractTerminalExecutableName(resolveLocalSessionCommandText(session));
  return executableName && terminalLowerContrastCommandNames.has(executableName)
    ? terminalClaudeMinimumContrastRatio
    : terminalMinimumContrastRatio;
};

// 某些 TUI 依赖 xterm 自己的输入光标，不能只靠程序输出的光标状态。
const shouldForceShowLocalTerminalCursor = (session?: TerminalSession) => {
  const executableName = extractTerminalExecutableName(resolveLocalSessionCommandText(session));
  return executableName ? terminalForceShowLocalCursorCommandNames.has(executableName) : false;
};

// 只有自绘输入框且 xterm cursor 与可见输入框分离的 CLI 需要重定位中文输入法锚点。
const shouldAnchorTerminalImeToPrompt = (session?: TerminalSession) => {
  const executableName = extractTerminalExecutableName(resolveLocalSessionCommandText(session));
  return executableName ? terminalImeAnchorCommandNames.has(executableName) : false;
};

// Codex 输入框位置由 CLI 自绘，前端光标需要跟随该输入行，而不是跟随 xterm 内部状态栏 cursor。
const shouldUseControlledInputCursor = (session?: TerminalSession) => {
  const executableName = extractTerminalExecutableName(resolveLocalSessionCommandText(session));
  return executableName ? terminalControlledInputCursorCommandNames.has(executableName) : false;
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

// 远程 http(s) 背景图需要走后端下载绕开防盗链，其余(本地路径、data:、asset:)由 CSS 直接加载。
const isRemoteHttpImage = (value?: string) => {
  const trimmed = value?.trim().toLowerCase();
  return Boolean(trimmed && (trimmed.startsWith('http://') || trimmed.startsWith('https://')));
};

// resolvedImage 由调用方决定：本地/asset 直接解析，远程 http(s) 图片先经后端下载成 data URL 再传入。
const buildTerminalBackgroundImageStyle = (
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
const defaultLightTerminalBackground = '#f7f7f7';
const defaultLightTerminalForeground = '#111111';
const defaultDarkTerminalBackground = '#1e1e2e';
const defaultDarkTerminalForeground = '#e0e0e0';

type TerminalRgbColor = {
  red: number;
  green: number;
  blue: number;
};

// 主题色来自颜色选择器时通常是 hex，这里额外兼容 rgb/rgba，供透明背景和光标对比度共用。
const parseTerminalRgbColor = (value: string): TerminalRgbColor | undefined => {
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

// xterm 反色属性会用默认背景的 RGB 作为反色前景；背景仍需 alpha=0，避免遮住终端背景图和选区 SVG。
const buildTransparentTerminalThemeBackground = (background: string) => {
  const rgb = parseTerminalRgbColor(background);
  if (rgb) {
    return `rgba(${rgb.red}, ${rgb.green}, ${rgb.blue}, 0)`;
  }

  // 非常规 CSS 颜色无法可靠保留色相并透明化；保留原有透明兜底，避免意外遮挡背景图。
  return 'rgba(0, 0, 0, 0)';
};

// 光标颜色只跟随应用主题：浅色模式黑色，深色模式白色，避免不同 TUI 之间切换时颜色跳变。
const resolveTerminalCursorTheme = (isDarkTheme: boolean) =>
  isDarkTheme
    ? { cursor: '#f8fafc', cursorAccent: '#111827' }
    : { cursor: '#111827', cursorAccent: '#f8fafc' };

type TerminalThemeOptions = {
  softenDarkBlocks?: boolean;
};

// 终端彩色文本使用清晰的 ANSI 调色板；浅色终端里 ANSI white 也要落到深灰，避免 ls 高亮发白发虚。
// xterm theme background 始终设为透明，让选区 SVG 覆盖层可以从 canvas 后面透出来。
const buildTerminalTheme = (settings: AppSettings, options: TerminalThemeOptions = {}) => {
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

type TerminalTheme = ReturnType<typeof buildTerminalTheme>;

// 覆盖光标需要避开 Codex 深浅混合输入行；按单元格实际背景选择反差最大的黑/白色。
const resolveTerminalPaletteRgbColor = (paletteIndex: number, theme: TerminalTheme) => {
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

const resolveTerminalTrueColorRgb = (color: number): TerminalRgbColor => ({
  red: (color >> 16) & 0xff,
  green: (color >> 8) & 0xff,
  blue: color & 0xff,
});

const resolveTerminalCellColorRgb = (
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

const resolveTerminalCellVisualBackgroundRgb = (
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

const resolveTerminalRelativeLuminance = (color: TerminalRgbColor) => {
  const channels = [color.red, color.green, color.blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
};

export function TerminalWorkspace({ session, settings, onTerminalData, onUpdateSettings, liveSessionIds }: Props) {
  const [terminalContextMenu, setTerminalContextMenu] = useState<{ x: number; y: number; selectedText: string } | null>(null);
  // 行号栏右键菜单只承载“显示行号/时间戳”两个开关，与正文区右键复制/粘贴互不干扰。
  const [terminalGutterContextMenu, setTerminalGutterContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [terminalHasHorizontalOverflow, setTerminalHasHorizontalOverflow] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  // 终端原始输出改用有界分片缓存：按会话/全局字节封顶、LRU 淘汰，关闭会话时显式回收，
  // 避免旧实现的全量字符串拼接与关闭后不回收导致的长时间运行内存增长。
  const outputCacheRef = useRef(new TerminalOutputCache());
  const terminalMatchOverlayRef = useRef<SVGSVGElement | null>(null);
  const terminalMatchDecorationDisposablesRef = useRef<IDisposable[]>([]);
  const terminalMatchHighlightFrameRef = useRef<number | null>(null);
  const terminalSelectionOverlayRef = useRef<SVGSVGElement | null>(null);
  const terminalSelectionOverlayFrameRef = useRef<number | null>(null);
  const terminalSelectionSnapshotRef = useRef<TerminalSelectionSnapshot | null>(null);
  const terminalSelectionRestoreActiveRef = useRef(false);
  const terminalControlledCursorRef = useRef<HTMLDivElement | null>(null);
  const terminalControlledCursorFrameRef = useRef<number | null>(null);
  const terminalVerticalScrollbarRef = useRef<HTMLDivElement | null>(null);
  const terminalVerticalScrollbarThumbRef = useRef<HTMLDivElement | null>(null);
  const terminalVerticalScrollbarFrameRef = useRef<number | null>(null);
  const terminalVerticalScrollbarTimeoutRef = useRef<number | null>(null);
  const terminalVerticalScrollbarDragRef = useRef<TerminalVerticalScrollbarDragState | null>(null);
  // 行号栏容器与逐行行数据、时间戳追踪状态；追踪状态随会话切换重置。
  const terminalGutterRef = useRef<HTMLDivElement | null>(null);
  const terminalGutterFrameRef = useRef<number | null>(null);
  const terminalGutterClockTimerRef = useRef<number | null>(null);
  const terminalGutterWidthRef = useRef(0);
  // 按注册顺序保存逻辑行 marker 与稳定行号；同一 buffer 行被 ANSI 控制序列覆盖时不重复登记。
  const terminalGutterMarkersRef = useRef<TerminalGutterMarkerEntry[]>([]);
  // 缓存重放期间先按重放顺序建立临时编号，完成后再与会话累计编号从末端对齐。
  const terminalGutterReplayActiveRef = useRef(false);
  const terminalGutterReplayNextLogicalNumberRef = useRef(1);
  // 按会话持久保存的逻辑行时间线；切换会话不清空，保证历史时间恒定。
  const terminalGutterSessionDataRef = useRef<Record<string, TerminalGutterSessionData>>({});
  const terminalSelectionDragActiveRef = useRef(false);
  const terminalSelectionDragFrameRef = useRef<number | null>(null);
  const onTerminalDataRef = useRef(onTerminalData);
  const sessionRef = useRef<TerminalSession | undefined>(session);
  const resizeFrameRef = useRef<number | null>(null);
  const cursorFollowFrameRef = useRef<number | null>(null);
  const terminalImeCompositionFrameRef = useRef<number | null>(null);
  const terminalImeComposingRef = useRef(false);
  const lastLocalTerminalInputAtRef = useRef(0);
  // 横向模式的渲染列数在单个会话内只允许增长，避免竖向翻页时因当前页长短不同反复 resize/reflow。
  const terminalHorizontalRenderColsRef = useRef(0);
  // 会话切走再切回时恢复原高水位，避免缓存重放只看底部短行而丢失历史长行的横向宽度。
  const terminalHorizontalRenderColsBySessionRef = useRef<Record<string, number>>({});
  // 缓存重放结束后仅执行一次全缓冲测量，之后高频输出仍只测当前窗口，控制扫描开销。
  const terminalHorizontalFullBufferMeasurePendingRef = useRef(false);
  const remoteTerminalSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const pendingFocusSessionIdRef = useRef<string | null>(session?.id ?? null);
  const terminalLineWrapMode = settings.terminalLineWrapMode ?? 'wrap';
  const isAiAgentTerminalSession = useMemo(
    () => isTerminalAiAgentSession(session),
    [session?.kind, session?.localCommand, session?.title],
  );
  const hideLocalCursorForSession = useMemo(
    () => shouldHideLocalTerminalCursor(session),
    [session?.kind, session?.localCommand, session?.title],
  );
  const useSoftDarkBlocksForSession = useMemo(
    () => shouldUseSoftDarkBlocks(session),
    [session?.kind, session?.localCommand, session?.title],
  );
  const minimumContrastRatioForSession = useMemo(
    () => resolveTerminalMinimumContrastRatio(session),
    [session?.kind, session?.localCommand, session?.title],
  );
  const forceShowLocalCursorForSession = useMemo(
    () => shouldForceShowLocalTerminalCursor(session),
    [session?.kind, session?.localCommand, session?.title],
  );
  const anchorImeToPromptForSession = useMemo(
    () => shouldAnchorTerminalImeToPrompt(session),
    [session?.kind, session?.localCommand, session?.title],
  );
  const useControlledInputCursorForSession = useMemo(
    () => shouldUseControlledInputCursor(session),
    [session?.kind, session?.localCommand, session?.title],
  );
  // 本地终端（包含纯 Shell 与 AI TUI）必须始终按可视宽度自动换行；长行展示设置只影响 SSH 会话。
  const effectiveTerminalLineWrapMode: AppSettings['terminalLineWrapMode'] = session?.kind === 'local' ? 'wrap' : terminalLineWrapMode;
  const terminalScrollbackRows = isAiAgentTerminalSession ? terminalAiAgentScrollbackRows : terminalDefaultScrollbackRows;
  const terminalLineWrapModeRef = useRef<AppSettings['terminalLineWrapMode']>(effectiveTerminalLineWrapMode);
  const terminalScrollbackRowsRef = useRef(terminalScrollbackRows);
  const terminalMinimumContrastRatioRef = useRef(minimumContrastRatioForSession);
  const isAiAgentTerminalSessionRef = useRef(isAiAgentTerminalSession);
  const hideLocalCursorForSessionRef = useRef(hideLocalCursorForSession);
  const forceShowLocalCursorForSessionRef = useRef(forceShowLocalCursorForSession);
  const anchorImeToPromptForSessionRef = useRef(anchorImeToPromptForSession);
  const useControlledInputCursorForSessionRef = useRef(useControlledInputCursorForSession);
  const terminalMatchSelectionRef = useRef(settings.terminalMatchSelection ?? true);
  // 行号栏两个开关缓存进 ref，命令式同步逻辑读取时无需依赖闭包中的最新 props。
  const gutterShowLineNumber = settings.terminalGutterShowLineNumber !== false;
  const gutterShowTimestamp = settings.terminalGutterShowTimestamp !== false;
  const gutterShowLineNumberRef = useRef(gutterShowLineNumber);
  const gutterShowTimestampRef = useRef(gutterShowTimestamp);
  const terminalFontSizeRef = useRef(settings.shellFontSize);
  const terminalTheme = useMemo(
    () => buildTerminalTheme(settings, {
      softenDarkBlocks: useSoftDarkBlocksForSession,
    }),
    [
      settings.terminalBackground,
      settings.terminalForeground,
      settings.themeMode,
      useSoftDarkBlocksForSession,
    ],
  );
  const terminalThemeRef = useRef(terminalTheme);
  // 远程 http(s) 背景图经后端下载后缓存的 data URL；null 表示无远程图或下载失败(回退到原始行为)。
  const [remoteBackgroundDataUrl, setRemoteBackgroundDataUrl] = useState<string | null>(null);
  useEffect(() => {
    const rawUrl = settings.backgroundImage?.trim();
    // 非远程图片(本地/asset/data)无需下载，清空缓存交给下方直接解析。
    if (!isRemoteHttpImage(rawUrl) || !rawUrl) {
      setRemoteBackgroundDataUrl(null);
      return;
    }
    let cancelled = false;
    setRemoteBackgroundDataUrl(null);
    backend
      .fetchRemoteBackgroundImage(rawUrl)
      .then((dataUrl) => {
        if (!cancelled) {
          setRemoteBackgroundDataUrl(dataUrl);
        }
      })
      .catch(() => {
        // 下载失败时回退为直接使用原始 URL，保持与旧行为一致(仍可能被防盗链拦截，但不影响其它功能)。
        if (!cancelled) {
          setRemoteBackgroundDataUrl(rawUrl);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [settings.backgroundImage]);
  const backgroundImageStyle = useMemo(() => {
    // 远程图片用下载得到的 data URL；本地/asset/data 走原解析逻辑。
    const resolvedImage = isRemoteHttpImage(settings.backgroundImage)
      ? remoteBackgroundDataUrl ?? undefined
      : resolveTerminalBackgroundImage(settings.backgroundImage);
    return buildTerminalBackgroundImageStyle(settings, resolvedImage);
  }, [
    settings.backgroundImage,
    settings.terminalBackgroundImageFit,
    settings.terminalBackgroundImageOpacity,
    remoteBackgroundDataUrl,
  ]);
  // 外层容器的实际背景色：跟随主题自动切换，xterm canvas 始终透明以便选区覆盖层透出。
  const terminalBackgroundColor = useMemo(
    () => resolveTerminalColors(settings).background,
    [settings.terminalBackground, settings.themeMode],
  );
  const terminalBackgroundColorRef = useRef(terminalBackgroundColor);
  const terminalFontFamily = useMemo(
    () => buildTerminalFontFamily(
      settings.shellLatinFontFamily ?? settings.shellFontFamily,
      settings.shellCjkFontFamily ?? settings.shellFontFamily,
    ),
    [settings.shellCjkFontFamily, settings.shellFontFamily, settings.shellLatinFontFamily],
  );
  terminalLineWrapModeRef.current = effectiveTerminalLineWrapMode;
  terminalScrollbackRowsRef.current = terminalScrollbackRows;
  terminalMinimumContrastRatioRef.current = minimumContrastRatioForSession;
  terminalThemeRef.current = terminalTheme;
  terminalBackgroundColorRef.current = terminalBackgroundColor;
  isAiAgentTerminalSessionRef.current = isAiAgentTerminalSession;
  hideLocalCursorForSessionRef.current = hideLocalCursorForSession;
  forceShowLocalCursorForSessionRef.current = forceShowLocalCursorForSession;
  anchorImeToPromptForSessionRef.current = anchorImeToPromptForSession;
  useControlledInputCursorForSessionRef.current = useControlledInputCursorForSession;
  terminalMatchSelectionRef.current = settings.terminalMatchSelection ?? true;
  gutterShowLineNumberRef.current = gutterShowLineNumber;
  gutterShowTimestampRef.current = gutterShowTimestamp;
  terminalFontSizeRef.current = settings.shellFontSize;

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

    if (hideLocalCursorForSessionRef.current) {
      terminal.write(terminalCursorHideSequence);
      return;
    }

    // 部分 CLI 会通过 OSC 修改光标色；每次恢复光标时重新应用主题色，确保浅色黑、深色白。
    terminal.options.theme = { ...terminalThemeRef.current };

    if (restoreNormalCursor || forceShowLocalCursorForSessionRef.current) {
      terminal.write(terminalCursorShowSequence);
    }
  };

  // Claude/Codex 自绘输入框时，真实 xterm cursor 可能停在状态栏；用可见的 `› ...` 输入行作为锚点。
  const resolveTerminalPromptAnchor = (): TerminalPromptAnchor | undefined => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    const screen = terminal?.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!terminal || !container || !screen || terminal.cols <= 0 || terminal.rows <= 0) {
      return undefined;
    }

    const buffer = terminal.buffer.active;
    const firstVisibleRow = buffer.viewportY;
    const lastVisibleRow = Math.min(buffer.length - 1, firstVisibleRow + terminal.rows - 1);
    let promptRow = -1;
    let promptColumn = 0;

    for (let row = lastVisibleRow; row >= firstVisibleRow; row -= 1) {
      const line = buffer.getLine(row);
      const text = line?.translateToString(true) ?? '';
      if (!line || !text.trimStart().startsWith('›')) {
        continue;
      }

      promptRow = row;
      promptColumn = Math.min(
        terminal.cols - 1,
        Math.max(0, measureTerminalBufferLineContentColumns(line, terminal.cols)),
      );
      break;
    }

    if (promptRow < firstVisibleRow) {
      return undefined;
    }

    const screenRect = screen.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const cellWidth = screenRect.width / terminal.cols;
    const cellHeight = screenRect.height / terminal.rows;
    const screenLeft = promptColumn * cellWidth;
    const screenTop = (promptRow - firstVisibleRow) * cellHeight;
    return {
      row: promptRow,
      column: promptColumn,
      screenLeft,
      screenTop,
      containerLeft: screenRect.left - containerRect.left + container.scrollLeft + screenLeft,
      containerTop: screenRect.top - containerRect.top + container.scrollTop + screenTop,
      cellWidth,
      cellHeight,
    };
  };

  const resolveTerminalImePromptAnchor = () => {
    const anchor = resolveTerminalPromptAnchor();
    return anchor
      ? {
        left: anchor.screenLeft,
        top: anchor.screenTop,
        cellWidth: anchor.cellWidth,
        cellHeight: anchor.cellHeight,
      }
      : undefined;
  };

  // 输入法候选框跟随隐藏 textarea；组合输入期间把 textarea 和 composition-view 同步到可见输入框。
  const syncTerminalImeCompositionAnchor = () => {
    if (!anchorImeToPromptForSessionRef.current || !terminalImeComposingRef.current) {
      return;
    }

    const terminal = terminalRef.current;
    const textarea = terminal?.element?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    const compositionView = terminal?.element?.querySelector<HTMLElement>('.composition-view');
    const anchor = resolveTerminalImePromptAnchor();
    if (!terminal || !textarea || !compositionView || !anchor) {
      return;
    }

    const left = `${anchor.left}px`;
    const top = `${anchor.top}px`;
    const height = `${anchor.cellHeight}px`;
    textarea.style.left = left;
    textarea.style.top = top;
    textarea.style.width = `${Math.max(anchor.cellWidth, compositionView.getBoundingClientRect().width || 1)}px`;
    textarea.style.height = height;
    textarea.style.lineHeight = height;
    compositionView.style.left = left;
    compositionView.style.top = top;
    compositionView.style.height = height;
    compositionView.style.lineHeight = height;
    compositionView.style.fontFamily = terminal.options.fontFamily ?? terminalFontFamily;
    compositionView.style.fontSize = `${terminal.options.fontSize ?? settings.shellFontSize}px`;
  };

  const scheduleTerminalImeCompositionAnchorSync = () => {
    if (terminalImeCompositionFrameRef.current !== null) {
      return;
    }

    terminalImeCompositionFrameRef.current = window.requestAnimationFrame(() => {
      terminalImeCompositionFrameRef.current = null;
      syncTerminalImeCompositionAnchor();
    });
  };

  const hideTerminalControlledInputCursor = () => {
    const cursor = terminalControlledCursorRef.current;
    if (cursor) {
      cursor.style.display = 'none';
    }
  };

  // Codex 的真实 xterm cursor 会落在状态栏；这里只在可见输入行绘制一个不参与选区的前端光标。
  const syncTerminalControlledInputCursor = () => {
    const terminal = terminalRef.current;
    const cursor = terminalControlledCursorRef.current;
    if (
      !terminal ||
      !cursor ||
      !useControlledInputCursorForSessionRef.current ||
      !canAcceptTerminalInput(sessionRef.current)
    ) {
      hideTerminalControlledInputCursor();
      return;
    }

    const anchor = resolveTerminalPromptAnchor();
    if (!anchor) {
      hideTerminalControlledInputCursor();
      return;
    }

    const line = terminal.buffer.active.getLine(anchor.row);
    const cursorCell = line?.getCell(Math.min(Math.max(anchor.column, 0), terminal.cols - 1));
    const background = resolveTerminalCellVisualBackgroundRgb(
      cursorCell,
      terminalThemeRef.current,
      terminalBackgroundColorRef.current,
    );
    const useDarkCursor = !background || resolveTerminalRelativeLuminance(background) > 0.45;
    const cursorColor = useDarkCursor ? '#111827' : '#f8fafc';
    const outlineColor = useDarkCursor ? 'rgba(248, 250, 252, 0.9)' : 'rgba(17, 24, 39, 0.9)';
    const cursorWidth = Math.max(2, Math.min(3, anchor.cellWidth * 0.18));
    const cursorHeight = Math.max(10, anchor.cellHeight * 0.78);
    const container = containerRef.current;
    const maxLeft = container ? Math.max(0, container.scrollWidth - cursorWidth) : anchor.containerLeft;

    cursor.style.display = 'block';
    cursor.style.left = `${Math.min(anchor.containerLeft, maxLeft)}px`;
    cursor.style.top = `${anchor.containerTop + (anchor.cellHeight - cursorHeight) / 2}px`;
    cursor.style.width = `${cursorWidth}px`;
    cursor.style.height = `${cursorHeight}px`;
    cursor.style.background = cursorColor;
    cursor.style.boxShadow = `0 0 0 1px ${outlineColor}`;
  };

  const scheduleTerminalControlledInputCursorSync = () => {
    if (terminalControlledCursorFrameRef.current !== null) {
      return;
    }

    terminalControlledCursorFrameRef.current = window.requestAnimationFrame(() => {
      terminalControlledCursorFrameRef.current = null;
      syncTerminalControlledInputCursor();
    });
  };

  // 右键菜单动作完成后延后一帧恢复焦点，确保 React 已经卸载菜单按钮。
  const restoreTerminalFocusAfterContextMenuAction = () => {
    // 右键菜单按钮会短暂拿走焦点；等待菜单卸载后再聚焦 xterm，避免复制/粘贴后键盘输入停在旧光标状态。
    window.requestAnimationFrame(() => {
      focusTerminalInput();
    });
  };

  const clearTerminalMatchOverlay = () => {
    const terminal = terminalRef.current;
    const hadDecorations = terminalMatchDecorationDisposablesRef.current.length > 0;
    for (const disposable of terminalMatchDecorationDisposablesRef.current) {
      disposable.dispose();
    }
    terminalMatchDecorationDisposablesRef.current = [];
    if (hadDecorations && terminal && terminal.rows > 0) {
      // 匹配文字前景色由 xterm decoration 接管，清除 decoration 后必须重绘可视行，避免旧色残留。
      terminal.refresh(0, terminal.rows - 1);
    }

    const overlay = terminalMatchOverlayRef.current;
    if (!overlay) {
      return;
    }

    overlay.replaceChildren();
    const container = containerRef.current;
    if (container) {
      syncTerminalHighlightOverlaySize(overlay, container);
    }
  };

  const terminalMatchRangeToDecorationRanges = (range: TerminalMatchRange) => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return [];
    }

    const ranges: TerminalMatchDecorationRange[] = [];
    let row = range.row;
    let column = range.col;
    let remainingSize = range.size;
    while (remainingSize > 0) {
      const width = Math.min(Math.max(terminal.cols - column, 0), remainingSize);
      if (width > 0) {
        ranges.push({ row, column, width });
      }
      remainingSize -= width;
      row += 1;
      column = 0;
      if (width <= 0) {
        break;
      }
    }
    return ranges;
  };

  const syncTerminalMatchDecorations = (ranges: TerminalMatchRange[], foregroundColor?: string) => {
    const terminal = terminalRef.current;
    const hadDecorations = terminalMatchDecorationDisposablesRef.current.length > 0;
    for (const disposable of terminalMatchDecorationDisposablesRef.current) {
      disposable.dispose();
    }
    terminalMatchDecorationDisposablesRef.current = [];

    if (!terminal || !foregroundColor) {
      if (hadDecorations && terminal && terminal.rows > 0) {
        terminal.refresh(0, terminal.rows - 1);
      }
      return;
    }

    const buffer = terminal.buffer.active;
    const disposables: IDisposable[] = [];
    for (const range of ranges) {
      for (const decorationRange of terminalMatchRangeToDecorationRanges(range)) {
        // xterm marker 以当前光标为基准定位缓冲区行，匹配范围来自绝对 buffer row，需要转换成 cursorYOffset。
        const markerOffset = decorationRange.row - buffer.baseY - buffer.cursorY;
        const marker = terminal.registerMarker(markerOffset);
        if (!marker) {
          continue;
        }
        const decoration = terminal.registerDecoration({
          marker,
          x: decorationRange.column,
          width: decorationRange.width,
          foregroundColor,
          layer: 'top',
        });
        if (!decoration) {
          marker.dispose();
          continue;
        }
        disposables.push(marker, decoration);
      }
    }
    terminalMatchDecorationDisposablesRef.current = disposables;
    if ((hadDecorations || disposables.length > 0) && terminal.rows > 0) {
      // xterm decoration 只在重绘后才会把匹配项文字改成深色，避免深色模式下白字压在浅色块上。
      terminal.refresh(0, terminal.rows - 1);
    }
  };

  // 覆盖层宽高必须来自 xterm 实际内容盒，不能读取 container.scrollWidth；
  // 否则旧覆盖层自身会参与 scrollWidth 计算，把横向滚动范围持续撑大。
  const resolveTerminalAuxiliaryLayerSize = (container: HTMLDivElement) => {
    const terminalElement = terminalRef.current?.element;
    if (!terminalElement) {
      return {
        width: Math.ceil(container.clientWidth),
        height: Math.ceil(container.clientHeight),
      };
    }

    const containerRect = container.getBoundingClientRect();
    const terminalRect = terminalElement.getBoundingClientRect();
    return {
      width: Math.ceil(Math.max(container.clientWidth, terminalRect.right - containerRect.left + container.scrollLeft)),
      height: Math.ceil(Math.max(container.clientHeight, terminalRect.bottom - containerRect.top + container.scrollTop)),
    };
  };

  const syncTerminalHighlightOverlaySize = (overlay: SVGSVGElement, container: HTMLDivElement) => {
    const { width, height } = resolveTerminalAuxiliaryLayerSize(container);
    overlay.setAttribute('width', `${width}`);
    overlay.setAttribute('height', `${height}`);
    overlay.style.width = `${width}px`;
    overlay.style.height = `${height}px`;
  };

  // 横向列宽变化后立即回收两个 SVG 辅助层，避免下一帧刷新前仍由旧宽度撑出空白滚动范围。
  const syncTerminalAuxiliaryLayerSizes = () => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const overlays = [terminalMatchOverlayRef.current, terminalSelectionOverlayRef.current];
    for (const overlay of overlays) {
      if (overlay) {
        syncTerminalHighlightOverlaySize(overlay, container);
      }
    }
  };

  const resolveTerminalVerticalScrollbarMetrics = (): TerminalVerticalScrollbarMetrics | undefined => {
    const container = containerRef.current;
    const terminal = terminalRef.current;
    if (!container || !terminal) {
      return undefined;
    }

    const buffer = terminal.buffer.active;
    const totalRows = Math.max(terminal.rows, buffer.length);
    const maxScrollLine = Math.max(0, totalRows - terminal.rows);
    // 轨道默认 display:none，不能读取自身 clientHeight；用容器高度减去 CSS 上下留白计算。
    const trackHeight = Math.max(
      0,
      container.clientHeight - terminalVerticalScrollbarTopInsetPx - terminalVerticalScrollbarBottomInsetPx,
    );
    if (maxScrollLine <= 0 || trackHeight <= 0) {
      return undefined;
    }

    // 拇指高度按当前可视行占总缓冲行的比例计算，并保留最小可拖拽尺寸。
    const thumbHeight = Math.min(
      trackHeight,
      Math.max(terminalVerticalScrollbarMinThumbHeightPx, Math.round((trackHeight * terminal.rows) / totalRows)),
    );
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const viewportY = clampTerminalNumber(buffer.viewportY, 0, maxScrollLine);
    const thumbTop = maxThumbTop > 0 ? Math.round((viewportY / maxScrollLine) * maxThumbTop) : 0;
    return { thumbHeight, thumbTop, maxThumbTop, maxScrollLine };
  };

  const scrollTerminalVerticalScrollbarToThumbTop = (
    thumbTop: number,
    metrics: Pick<TerminalVerticalScrollbarMetrics, 'maxThumbTop' | 'maxScrollLine'>,
  ) => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    const safeThumbTop = clampTerminalNumber(thumbTop, 0, metrics.maxThumbTop);
    const scrollRatio = metrics.maxThumbTop > 0 ? safeThumbTop / metrics.maxThumbTop : 0;
    terminal.scrollToLine(Math.round(scrollRatio * metrics.maxScrollLine));
    syncTerminalVerticalScrollbar();
  };

  const syncTerminalVerticalScrollbar = () => {
    const container = containerRef.current;
    const scrollbar = terminalVerticalScrollbarRef.current;
    const thumb = terminalVerticalScrollbarThumbRef.current;
    if (!container || !scrollbar || !thumb) {
      return;
    }

    // 该滚动条已经移动到横向滚动容器的外部；由 CSS right 属性固定在右侧，无需再手动叠加 scrollLeft 计算 left。

    const metrics = resolveTerminalVerticalScrollbarMetrics();
    const isScrollable = Boolean(metrics);
    scrollbar.classList.toggle('is-scrollable', isScrollable);
    if (!metrics) {
      scrollbar.classList.remove('is-visible', 'is-dragging');
      return;
    }

    thumb.style.height = `${metrics.thumbHeight}px`;
    thumb.style.transform = `translateY(${metrics.thumbTop}px)`;
  };

  const scheduleTerminalVerticalScrollbarSync = () => {
    if (terminalVerticalScrollbarFrameRef.current !== null) {
      return;
    }

    terminalVerticalScrollbarFrameRef.current = window.requestAnimationFrame(() => {
      terminalVerticalScrollbarFrameRef.current = null;
      syncTerminalVerticalScrollbar();

      // 上下滚动时短暂展示竖向滚动条，滚动停止后自动隐藏。
      showTerminalVerticalScrollbar();
      if (terminalVerticalScrollbarTimeoutRef.current !== null) {
        window.clearTimeout(terminalVerticalScrollbarTimeoutRef.current);
      }
      terminalVerticalScrollbarTimeoutRef.current = window.setTimeout(() => {
        terminalVerticalScrollbarTimeoutRef.current = null;
        hideTerminalVerticalScrollbar();
      }, 1200);
    });
  };

  const showTerminalVerticalScrollbar = () => {
    syncTerminalVerticalScrollbar();
    const scrollbar = terminalVerticalScrollbarRef.current;
    if (scrollbar?.classList.contains('is-scrollable')) {
      scrollbar.classList.add('is-visible');
    }
  };

  const hideTerminalVerticalScrollbar = () => {
    if (terminalVerticalScrollbarDragRef.current) {
      return;
    }

    terminalVerticalScrollbarRef.current?.classList.remove('is-visible');
  };

  // 鼠标靠近终端右侧边缘时展示自绘竖向滚动条，移开后隐藏。
  const handleTerminalMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) {
      hideTerminalVerticalScrollbar();
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const isNearRightEdge = containerRect.right - event.clientX <= terminalVerticalScrollbarRevealZonePx;
    if (isNearRightEdge) {
      // 鼠标在右侧区域时，取消自动隐藏定时器，保持滚动条常驻。
      if (terminalVerticalScrollbarTimeoutRef.current !== null) {
        window.clearTimeout(terminalVerticalScrollbarTimeoutRef.current);
        terminalVerticalScrollbarTimeoutRef.current = null;
      }
      showTerminalVerticalScrollbar();
      return;
    }

    // 鼠标不在右侧区域时，如果没有正在运行的滚动隐藏定时器则立刻隐藏。
    if (terminalVerticalScrollbarTimeoutRef.current === null) {
      hideTerminalVerticalScrollbar();
    }
  };

  const startTerminalVerticalScrollbarDrag = (event: MouseEvent) => {
    if (event.button !== 0) {
      return;
    }

    const scrollbar = terminalVerticalScrollbarRef.current;
    const thumb = terminalVerticalScrollbarThumbRef.current;
    const metrics = resolveTerminalVerticalScrollbarMetrics();
    if (!scrollbar || !thumb || !metrics) {
      return;
    }

    const trackRect = scrollbar.getBoundingClientRect();
    const isThumbDrag = thumb.contains(event.target as Node);
    const nextThumbTop = isThumbDrag
      ? metrics.thumbTop
      : clampTerminalNumber(event.clientY - trackRect.top - metrics.thumbHeight / 2, 0, metrics.maxThumbTop);
    if (!isThumbDrag) {
      scrollTerminalVerticalScrollbarToThumbTop(nextThumbTop, metrics);
    }

    terminalVerticalScrollbarDragRef.current = {
      originY: event.clientY,
      originThumbTop: nextThumbTop,
      maxThumbTop: metrics.maxThumbTop,
      maxScrollLine: metrics.maxScrollLine,
    };
    scrollbar.classList.add('is-visible', 'is-dragging');
    event.preventDefault();
    event.stopPropagation();
  };

  const syncTerminalVerticalScrollbarDrag = (event: MouseEvent) => {
    const dragState = terminalVerticalScrollbarDragRef.current;
    if (!dragState) {
      return;
    }

    scrollTerminalVerticalScrollbarToThumbTop(
      dragState.originThumbTop + event.clientY - dragState.originY,
      dragState,
    );
    event.preventDefault();
    event.stopPropagation();
  };

  const stopTerminalVerticalScrollbarDrag = () => {
    terminalVerticalScrollbarDragRef.current = null;
    terminalVerticalScrollbarRef.current?.classList.remove('is-dragging');
  };

  // 会话切换或缓存重放前只回收 marker（定位信息），不触碰按会话持久保存的稳定行号与时间线。
  const resetTerminalGutterMarkers = () => {
    for (const entry of terminalGutterMarkersRef.current) {
      entry.marker.dispose();
    }
    terminalGutterMarkersRef.current = [];
  };

  // 取（必要时初始化）某会话的稳定逻辑行时间线；只有首次占用新 buffer 行时才追加时间。
  const ensureTerminalGutterSessionData = (sessionId: string) => {
    let data = terminalGutterSessionDataRef.current[sessionId];
    if (!data) {
      data = { times: [], base: 0 };
      terminalGutterSessionDataRef.current[sessionId] = data;
    }
    return data;
  };

  // 新逻辑行首次落到屏幕或 scrollback 时追加时间；回车覆盖、光标上移后重画同一行都不能推进编号。
  const appendTerminalGutterLogicalLine = (sessionId: string, nowMs: number) => {
    const data = ensureTerminalGutterSessionData(sessionId);
    data.times.push(nowMs);
    // 超出上限时从最旧端回收，并累加 base，保证累计序号不回退。
    if (data.times.length > terminalGutterMaxTrackedLines) {
      const drop = data.times.length - terminalGutterMaxTrackedLines;
      data.times.splice(0, drop);
      data.base += drop;
    }
  };

  // 硬换行后光标已落到新的一行，为该行注册一个 marker 作为逻辑行位置锚点。
  const registerTerminalGutterLine = (nowMs = Date.now()) => {
    const terminal = terminalRef.current;
    const sessionId = sessionRef.current?.id;
    if (!terminal || !sessionId) {
      return;
    }

    // 防护：若光标落到的新行是软换行续行（部分 xterm 版本自动折行也会触发 onLineFeed），则不建 marker，
    // 使 marker 仅对应逻辑行，让续行正确显示为占位符，也避免折行片段重复占用稳定行号。
    const buffer = terminal.buffer.active;
    const bufferRow = buffer.baseY + buffer.cursorY;
    if (buffer.getLine(bufferRow)?.isWrapped) {
      return;
    }

    // Docker Compose 等程序会反复“上移光标 + LF”覆盖同一组进度行；已有存活 marker 时必须复用原行号。
    const existingEntry = terminalGutterMarkersRef.current.find((entry) => entry.marker.line === bufferRow);
    if (existingEntry) {
      return;
    }

    const marker = terminal.registerMarker(0);
    if (!marker) {
      return;
    }

    let logicalNumber: number;
    if (terminalGutterReplayActiveRef.current) {
      // 重放期间只建立相对顺序，完成后统一对齐到会话已有累计编号，避免切换会话时重复累加。
      logicalNumber = terminalGutterReplayNextLogicalNumberRef.current;
      terminalGutterReplayNextLogicalNumberRef.current += 1;
    } else {
      appendTerminalGutterLogicalLine(sessionId, nowMs);
      logicalNumber = resolveTerminalGutterCounter();
    }
    terminalGutterMarkersRef.current.push({ marker, logicalNumber });

    // 缓存重放会同步触发大量换行；超过阈值时惰性回收已被裁剪（line<0）的 marker，避免数组无界增长。
    const markers = terminalGutterMarkersRef.current;
    if (markers.length > terminal.rows + terminalScrollbackRowsRef.current + 64) {
      terminalGutterMarkersRef.current = markers.filter((entry) => entry.marker.line >= 0);
    }
  };

  // 缓存重放结束后把存活 marker 从末端对齐到会话累计编号；首次展示的缓存则补齐缺少的稳定行记录。
  const finishTerminalGutterReplay = (nowMs: number) => {
    const sessionId = sessionRef.current?.id;
    if (!terminalGutterReplayActiveRef.current || !sessionId) {
      return;
    }

    terminalGutterReplayActiveRef.current = false;
    const liveEntries = terminalGutterMarkersRef.current.filter((entry) => entry.marker.line >= 0);
    const data = ensureTerminalGutterSessionData(sessionId);
    const trackedTotal = data.base + data.times.length;
    if (trackedTotal < liveEntries.length) {
      const missingLineCount = liveEntries.length - trackedTotal;
      for (let index = 0; index < missingLineCount; index += 1) {
        appendTerminalGutterLogicalLine(sessionId, nowMs);
      }
    }

    const totalLogical = Math.max(resolveTerminalGutterCounter(), liveEntries.length);
    for (let index = 0; index < liveEntries.length; index += 1) {
      liveEntries[index].logicalNumber = totalLogical - (liveEntries.length - 1 - index);
    }
    terminalGutterMarkersRef.current = liveEntries;
  };

  // 当前会话累计逻辑行数（= 最新一行的编号）。
  const resolveTerminalGutterCounter = () => {
    const sessionId = sessionRef.current?.id;
    const data = sessionId ? terminalGutterSessionDataRef.current[sessionId] : undefined;
    return data ? data.base + data.times.length : 0;
  };

  // 行号栏当前需要的像素宽度：按显示项和最大逻辑行号位宽估算，两项都关闭时保留右键命中宽度。
  const resolveTerminalGutterWidth = () => {
    if (!gutterShowLineNumberRef.current && !gutterShowTimestampRef.current) {
      return terminalGutterMinWidthPx;
    }

    const fontSize = Math.max(terminalGutterMinFontSizePx, terminalFontSizeRef.current * terminalGutterFontScale);
    const charWidth = fontSize * terminalGutterCharWidthRatio;
    let charCount = 0;
    if (gutterShowTimestampRef.current) {
      charCount += terminalGutterTimestampCharCount;
    }
    if (gutterShowLineNumberRef.current) {
      const maxLogical = resolveTerminalGutterCounter();
      const digits = Math.max(terminalGutterMinDigits, String(Math.max(1, maxLogical)).length);
      // 行号和时间戳之间留 1 个字符间距。
      charCount += digits + (gutterShowTimestampRef.current ? 1 : 0);
    }
    return Math.ceil(charCount * charWidth) + terminalGutterHorizontalPaddingPx * 2;
  };

  // 行号栏通过真正缩小 surface 的宽度来占位（marginLeft + width），而不是加 padding：FitAddon 读的是
  // 父容器 border-box 宽度、只扣 .xterm 自身 padding，若用容器 padding 占位会导致列数被高估、右侧字符被裁。
  const applyTerminalGutterWidth = (width: number) => {
    const container = containerRef.current;
    if (!container || terminalGutterWidthRef.current === width) {
      return;
    }
    terminalGutterWidthRef.current = width;
    if (width > 0) {
      container.style.marginLeft = `${width}px`;
      container.style.width = `calc(100% - ${width}px)`;
    } else {
      container.style.marginLeft = '';
      container.style.width = '';
    }
    // 宽度变化会改变正文可用列宽，主动重排一次终端尺寸，避免自动换行模式下右侧字符被裁剪。
    scheduleTerminalSizeSync();
  };

  // 行号栏渲染：按当前可见 buffer 行逐行绘制时间戳与逻辑行号，软换行续行显示占位符，
  // 光标所在行显示实时时钟。gutter 固定在左侧，横向滚动时不随正文移动。
  const syncTerminalGutter = (nowMs: number) => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    const gutter = terminalGutterRef.current;
    const workspace = container?.parentElement;
    const screen = terminal?.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!terminal || !container || !gutter || !workspace || !screen) {
      return;
    }

    const showNumber = gutterShowLineNumberRef.current;
    const showTime = gutterShowTimestampRef.current;

    // 无会话（空态）或本地终端（PowerShell/TUI 不需要时间/行号栏）时收起整条左栏并把宽度归零，
    // 让 surface 恢复全宽——本地终端的自动换行据此按全宽排版；SSH 会话则有左栏占位、按缩减后的宽度排版。
    if (!sessionRef.current || sessionRef.current.kind === 'local') {
      gutter.style.display = 'none';
      applyTerminalGutterWidth(0);
      return;
    }

    const width = resolveTerminalGutterWidth();
    applyTerminalGutterWidth(width);
    gutter.style.display = 'block';

    if (terminal.cols <= 0 || terminal.rows <= 0) {
      return;
    }

    const workspaceRect = workspace.getBoundingClientRect();
    const surfaceRect = container.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const cellHeight = screenRect.height / terminal.rows;
    const fontSize = Math.max(terminalGutterMinFontSizePx, terminalFontSizeRef.current * terminalGutterFontScale);
    const buffer = terminal.buffer.active;
    const firstVisibleRow = buffer.viewportY;
    const cursorBufferRow = buffer.baseY + buffer.cursorY;

    // 存活 marker 自带稳定逻辑行号；重放完成时已从末端对齐，日常动态覆盖不会再次改号。
    const liveMarkers = terminalGutterMarkersRef.current.filter((entry) => entry.marker.line >= 0);
    // 时间线尚未建立（会话刚打开）时用存活 marker 数兜底，避免最旧行推出非正编号。
    const totalLogical = Math.max(resolveTerminalGutterCounter(), liveMarkers.length);
    const sessionData = sessionRef.current?.id ? terminalGutterSessionDataRef.current[sessionRef.current.id] : undefined;
    // buffer 行 -> 逻辑行编号；同一 buffer 行可能有多个历史 marker（reflow 后），取最新（末端）的编号。
    const logicalNumberByBufferRow = new Map<number, number>();
    for (let index = 0; index < liveMarkers.length; index += 1) {
      logicalNumberByBufferRow.set(liveMarkers[index].marker.line, liveMarkers[index].logicalNumber);
    }
    const digits = Math.max(terminalGutterMinDigits, String(Math.max(1, totalLogical)).length);

    // 按逻辑编号取该行到达时刻；编号已回收出时间线窗口时返回 undefined（极旧历史行不显示时间）。
    const resolveLineTime = (logicalNumber: number) => {
      if (!sessionData) {
        return undefined;
      }
      const timeIndex = logicalNumber - 1 - sessionData.base;
      return timeIndex >= 0 && timeIndex < sessionData.times.length ? sessionData.times[timeIndex] : undefined;
    };

    // 当前光标所在“逻辑行”的起始 buffer 行：从光标行向上跳过软换行续行，得到这条逻辑行的第一物理行。
    let activeLineStartRow = cursorBufferRow;
    while (activeLineStartRow > 0 && buffer.getLine(activeLineStartRow)?.isWrapped) {
      activeLineStartRow -= 1;
    }
    // 当前逻辑行若还没有落 marker（例如刚新起一行），用累计行数兜底，保证底部当前行始终有编号。
    const activeLogicalNumber = logicalNumberByBufferRow.get(activeLineStartRow) ?? Math.max(1, totalLogical);

    // gutter 覆盖 surface 左侧外部的占位区（marginLeft 让出的宽度），对齐 xterm 内容顶部与高度。
    gutter.style.left = `${surfaceRect.left - workspaceRect.left - width}px`;
    gutter.style.top = `${screenRect.top - workspaceRect.top}px`;
    gutter.style.width = `${width}px`;
    gutter.style.height = `${screenRect.height}px`;
    gutter.style.fontSize = `${fontSize}px`;

    const rows: HTMLDivElement[] = [];
    for (let i = 0; i < terminal.rows; i += 1) {
      const bufferRow = firstVisibleRow + i;
      if (bufferRow >= buffer.length) {
        break;
      }
      const line = buffer.getLine(bufferRow);
      const logicalNumber = logicalNumberByBufferRow.get(bufferRow);
      // 只有“当前逻辑行”所覆盖的物理行属于活动行（时间走实时时钟并高亮）；光标下方的空行不算。
      const isActiveLine = bufferRow >= activeLineStartRow && bufferRow <= cursorBufferRow;
      const isActiveLineStart = bufferRow === activeLineStartRow;

      const rowElement = document.createElement('div');
      rowElement.className = 'terminal-gutter-line';
      rowElement.style.top = `${i * cellHeight}px`;
      rowElement.style.height = `${cellHeight}px`;
      if (isActiveLine) {
        rowElement.classList.add('is-active');
      }

      if (showTime) {
        const timeSpan = document.createElement('span');
        timeSpan.className = 'terminal-gutter-time';
        // 活动逻辑行起始行显示实时时钟；其余逻辑行按编号显示各自真实到达时刻，软换行续行留空。
        let arrival: number | undefined;
        if (isActiveLineStart) {
          arrival = nowMs;
        } else if (logicalNumber !== undefined) {
          arrival = resolveLineTime(logicalNumber);
        }
        timeSpan.textContent = arrival !== undefined ? `[${formatTerminalGutterClock(arrival)}]` : '';
        rowElement.appendChild(timeSpan);
      }

      if (showNumber) {
        const numberSpan = document.createElement('span');
        numberSpan.className = 'terminal-gutter-number';
        numberSpan.style.minWidth = `${digits}ch`;
        if (logicalNumber !== undefined) {
          numberSpan.textContent = String(logicalNumber);
        } else if (isActiveLineStart) {
          // 当前逻辑行尚未落 marker 时用兜底编号，保证底部当前行始终有编号。
          numberSpan.textContent = String(activeLogicalNumber);
        } else if (line?.isWrapped) {
          // 软换行续行不占逻辑号，用占位符表示它接续上一行。
          numberSpan.textContent = terminalGutterWrappedLineSymbol;
        } else {
          // 没有 marker 的非续行（例如光标下方的空行）不显示编号。
          numberSpan.textContent = '';
        }
        rowElement.appendChild(numberSpan);
      }

      rows.push(rowElement);
    }

    gutter.replaceChildren(...rows);
  };

  const scheduleTerminalGutterSync = () => {
    if (terminalGutterFrameRef.current !== null) {
      return;
    }
    terminalGutterFrameRef.current = window.requestAnimationFrame(() => {
      terminalGutterFrameRef.current = null;
      syncTerminalGutter(Date.now());
    });
  };

  const clearTerminalSelectionOverlay = () => {
    const overlay = terminalSelectionOverlayRef.current;
    if (overlay) {
      overlay.replaceChildren();
      const container = containerRef.current;
      if (container) {
        syncTerminalHighlightOverlaySize(overlay, container);
      }
    }
  };

  // 选区快照只记录用户已经确认过的 xterm 选区；主动清空时同步回收选区层和匹配层。
  const clearTerminalSelectionSnapshot = (clearVisuals = true) => {
    terminalSelectionSnapshotRef.current = null;
    if (!clearVisuals) {
      return;
    }
    clearTerminalSelectionOverlay();
    clearTerminalMatchOverlay();
  };

  const captureTerminalSelectionSnapshot = () => {
    const terminal = terminalRef.current;
    const selectionPosition = terminal?.getSelectionPosition();
    if (!terminal || !selectionPosition || !terminal.hasSelection() || !terminalSelectionPositionHasRange(selectionPosition)) {
      return undefined;
    }

    const selectionText = terminal.getSelection();
    if (!selectionText.length) {
      return undefined;
    }

    const snapshot: TerminalSelectionSnapshot = {
      text: selectionText,
      position: cloneTerminalSelectionPosition(selectionPosition),
      cols: terminal.cols,
      sessionId: sessionRef.current?.id,
    };
    terminalSelectionSnapshotRef.current = snapshot;
    return snapshot;
  };

  const isTerminalSelectionSnapshotUsable = (snapshot: TerminalSelectionSnapshot) => {
    const terminal = terminalRef.current;
    if (
      !terminal ||
      snapshot.sessionId !== sessionRef.current?.id ||
      snapshot.cols !== terminal.cols ||
      !terminalSelectionPositionHasRange(snapshot.position)
    ) {
      return false;
    }

    const bufferedText = readTerminalSelectionTextFromBuffer(terminal, snapshot.position);
    return Boolean(bufferedText.length) &&
      normalizeTerminalSelectionSnapshotText(bufferedText) === normalizeTerminalSelectionSnapshotText(snapshot.text);
  };

  // 滚动/翻页/布局刷新可能让 xterm 短暂丢掉原生选区；快照仍能通过缓冲区文本校验时继续用于重绘。
  const resolveTerminalSelectionSnapshot = () => {
    const liveSnapshot = captureTerminalSelectionSnapshot();
    if (liveSnapshot) {
      return liveSnapshot;
    }

    const snapshot = terminalSelectionSnapshotRef.current;
    if (!snapshot) {
      return undefined;
    }
    if (!isTerminalSelectionSnapshotUsable(snapshot)) {
      terminalSelectionSnapshotRef.current = null;
      return undefined;
    }
    return snapshot;
  };

  const restoreTerminalSelectionFromSnapshot = (snapshot: TerminalSelectionSnapshot) => {
    const terminal = terminalRef.current;
    if (!terminal || terminal.hasSelection()) {
      return;
    }

    const selectionLength = resolveTerminalSelectionLength(snapshot.position, terminal.cols);
    if (selectionLength <= 0) {
      return;
    }

    terminalSelectionRestoreActiveRef.current = true;
    try {
      // 恢复 xterm 原生选区，保证右键复制等原有能力不会因为内部 resize/scroll 刷新而丢失。
      terminal.select(snapshot.position.start.x, snapshot.position.start.y, selectionLength);
    } finally {
      terminalSelectionRestoreActiveRef.current = false;
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
    if (!terminal || !container || !overlay) {
      clearTerminalSelectionOverlay();
      return;
    }

    const metrics = resolveTerminalHighlightMetrics();
    const selectionSnapshot = resolveTerminalSelectionSnapshot();
    if (selectionSnapshot && !terminal.hasSelection()) {
      restoreTerminalSelectionFromSnapshot(selectionSnapshot);
    }

    let resolved: { metrics: NonNullable<ReturnType<typeof resolveTerminalHighlightMetrics>>; strips: TerminalHighlightStrip[] } | undefined;
    if (selectionSnapshot) {
      resolved = terminalRowsToHighlightStrips(selectionSnapshot.position.start.y, selectionSnapshot.position.end.y, (row) => ({
        startColumn: row === selectionSnapshot.position.start.y ? selectionSnapshot.position.start.x : 0,
        endColumn: row === selectionSnapshot.position.end.y ? selectionSnapshot.position.end.x : terminal.cols,
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
    if (event.button !== 0 || terminalVerticalScrollbarRef.current?.contains(event.target as Node)) {
      return;
    }
    // 新一轮鼠标选区必须从干净快照开始，避免单击空白取消选区后继续显示旧高亮。
    clearTerminalSelectionSnapshot();
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
    const selectionSnapshot = resolveTerminalSelectionSnapshot();
    if (!terminal || !container || !overlay || !metrics || !terminalMatchSelectionRef.current || !selectionSnapshot) {
      clearTerminalMatchOverlay();
      return;
    }

    if (!terminal.hasSelection()) {
      restoreTerminalSelectionFromSnapshot(selectionSnapshot);
    }

    const term = normalizeTerminalMatchSelection(selectionSnapshot.text);
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
    const matchHighlightColors = resolveTerminalMatchHighlightColors(settings.themeMode === 'dark');
    syncTerminalMatchDecorations(ranges, matchHighlightColors.foreground);
    for (const range of ranges) {
      const resolved = terminalMatchRangeToHighlightStrips(range, metrics);
      if (!resolved.strips.length) {
        continue;
      }
      const pathValue = buildTerminalHighlightPath(resolved.strips, resolved.metrics.cornerRadius);
      if (pathValue) {
        paths.push(createTerminalHighlightPathElement(
          'terminal-match-rounded-shape',
          matchHighlightColors.background,
          matchHighlightColors.border,
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

  // 本地键盘输入和粘贴会触发行编辑回显；记录时间后，后续短时间内的光标移动才允许自动横向跟随。
  const markLocalTerminalInputForCursorFollow = () => {
    lastLocalTerminalInputAtRef.current = performance.now();
  };

  // 远端程序定时刷新也会移动 xterm 光标；超过本地输入窗口后不再把它视为需要跟随的编辑光标。
  const hasRecentLocalTerminalInputForCursorFollow = () =>
    performance.now() - lastLocalTerminalInputAtRef.current <= terminalCursorFollowAfterInputMs;

  // 会话级渲染选项必须先于缓存重放生效，保证切换普通终端和 AI TUI 时滚屏历史策略一致。
  const applyTerminalSessionBehaviorOptions = () => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    if (terminal.options.scrollback !== terminalScrollbackRowsRef.current) {
      terminal.options.scrollback = terminalScrollbackRowsRef.current;
    }
    if (terminal.options.minimumContrastRatio !== terminalMinimumContrastRatioRef.current) {
      terminal.options.minimumContrastRatio = terminalMinimumContrastRatioRef.current;
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
      syncTerminalAuxiliaryLayerSizes();
      return;
    }

    const containerWidth = Number.parseFloat(window.getComputedStyle(container).width) || container.clientWidth;
    const fallbackCellWidth = (terminal.options.fontSize ?? 15) * 0.62;
    const cellWidth = visibleCols > 0 && containerWidth > 0
      ? containerWidth / visibleCols
      : fallbackCellWidth;
    const targetWidth = Math.ceil(Math.max(containerWidth, targetCols * Math.max(4, cellWidth) + terminalScrollbarReservePx));
    terminalElement.style.width = `${targetWidth}px`;
    syncTerminalAuxiliaryLayerSizes();
  };

  // 缓冲区测量通过 isWrapped 合并软换行片段；通常只扫可视窗口，缓存重放后允许一次全量扫描恢复历史长行宽度。
  const measureVisibleTerminalBufferLongestLineColumns = () => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return 0;
    }

    const buffer = terminal.buffer.active;
    let longestColumns = 0;
    let currentLineColumns = 0;
    const measureEntireBuffer = terminalHorizontalFullBufferMeasurePendingRef.current;
    terminalHorizontalFullBufferMeasurePendingRef.current = false;
    // 输出到达或显式布局变化时测量当前窗口；缓存重放完成时测量一次全缓冲，竖向滚动本身不触发 resize。
    const firstVisibleLine = measureEntireBuffer ? 0 : Math.max(0, buffer.viewportY);
    const lastVisibleLine = measureEntireBuffer
      ? buffer.length
      : Math.min(buffer.length, firstVisibleLine + terminal.rows);
    for (let lineIndex = firstVisibleLine; lineIndex < lastVisibleLine; lineIndex += 1) {
      const line = buffer.getLine(lineIndex);
      if (!line) {
        continue;
      }

      const lineColumns = measureTerminalBufferLineContentColumns(line, terminal.cols);
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

  // 横向模式按当前内容和光标余量扩列，但会话内使用高水位列数，短页面不能把宽页面重新压窄。
  const resolveHorizontalTerminalColumns = (visibleCols: number) => {
    const terminal = terminalRef.current;
    if (!terminalLineWrapModeRef.current || terminalLineWrapModeRef.current !== 'horizontal' || !terminal) {
      return visibleCols;
    }

    const longestLineColumns = measureVisibleTerminalBufferLongestLineColumns();
    // 远端 TUI 的重绘光标只负责定位绘制，不代表用户正在编辑；只有近期本地输入才按光标列扩宽画布。
    const cursorRequiredColumns = hasRecentLocalTerminalInputForCursorFollow()
      ? terminal.buffer.active.cursorX + terminalCursorFollowMarginColumns
      : visibleCols;
    const requiredColumns = Math.max(
      visibleCols,
      longestLineColumns + terminalHorizontalLinePaddingColumns,
      cursorRequiredColumns,
    );
    const measuredColumns = roundHorizontalColumns(requiredColumns, visibleCols);
    const stableColumns = Math.max(visibleCols, terminalHorizontalRenderColsRef.current, measuredColumns);
    terminalHorizontalRenderColsRef.current = stableColumns;
    const sessionId = sessionRef.current?.id;
    if (sessionId) {
      terminalHorizontalRenderColsBySessionRef.current[sessionId] = stableColumns;
    }
    return stableColumns;
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
    // 横向浏览需要的扩列同时作用于 xterm 渲染层和远端 PTY：readline 只有拿到与 xterm 相同的列宽，
    // 才能在翻历史命令时按正确的物理行数发送清除序列，避免长命令的多余行/右侧内容残留。
    const renderCols = terminalLineWrapModeRef.current === 'horizontal'
      ? resolveHorizontalTerminalColumns(visibleCols)
      : visibleCols;
    return { renderCols, remoteCols: renderCols, rows, visibleCols };
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
    if (!container || !terminal || terminalLineWrapModeRef.current !== 'horizontal' || !hasRecentLocalTerminalInputForCursorFollow()) {
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
    if (terminalLineWrapModeRef.current !== 'horizontal' || cursorFollowFrameRef.current !== null || !hasRecentLocalTerminalInputForCursorFollow()) {
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

    clearTerminalSelectionSnapshot();
    applyTerminalSessionBehaviorOptions();
    // 只回收 marker（定位）并清空 buffer，保留按会话持久保存的稳定时间线；重放完成后从末端恢复编号。
    resetTerminalGutterMarkers();
    terminalGutterReplayActiveRef.current = true;
    terminalGutterReplayNextLogicalNumberRef.current = 1;
    terminal.reset();
    const nextLayoutSize = resolveTerminalLayoutSize();
    if (nextLayoutSize) {
      applyTerminalLayoutSize(nextLayoutSize);
    }
    // 为会话首行（row0，从不触发 onLineFeed）登记初始 marker；始终登记以保证第一条逻辑行也可定位。
    registerTerminalGutterLine();
    const replayChunks = sessionRef.current?.id
      ? outputCacheRef.current.replayChunks(sessionRef.current.id)
      : [];
    if (replayChunks.length > 0) {
      const runReplayCompletion = () => {
        finishTerminalGutterReplay(Date.now());
        // 重放结束后全量扫描一次 scrollback，恢复该会话历史长行对应的横向高水位。
        terminalHorizontalFullBufferMeasurePendingRef.current = true;
        scheduleTerminalSizeSync();
        syncLocalCursorVisibility();
        scheduleTerminalCursorFollow();
        scheduleTerminalMatchHighlightRefresh();
        scheduleTerminalSelectionOverlaySync();
        scheduleTerminalControlledInputCursorSync();
        scheduleTerminalVerticalScrollbarSync();
        scheduleTerminalGutterSync();
      };
      // 逐块写入 xterm，不先 join 成大字符串；完成回调只挂在最后一块，行为与旧的单次 write 一致。
      replayChunks.forEach((chunk, index) => {
        const isLast = index === replayChunks.length - 1;
        terminal.write(chunk, isLast ? runReplayCompletion : undefined);
      });
      return;
    }

    finishTerminalGutterReplay(Date.now());
    scheduleTerminalSizeSync();
    syncLocalCursorVisibility();
    scheduleTerminalCursorFollow();
    scheduleTerminalMatchHighlightRefresh();
    scheduleTerminalSelectionOverlaySync();
    scheduleTerminalControlledInputCursorSync();
    scheduleTerminalVerticalScrollbarSync();
    scheduleTerminalGutterSync();
  };

  useEffect(() => {
    const closeTerminalContextMenu = () => {
      setTerminalContextMenu(null);
      setTerminalGutterContextMenu(null);
    };
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
        clearTerminalSelectionSnapshot();
        markLocalTerminalInputForCursorFollow();
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

    const selectedText = terminal.getSelection() || resolveTerminalSelectionSnapshot()?.text || '';
    setTerminalContextMenu({
      x: event.clientX,
      y: event.clientY,
      selectedText,
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
    // 远端 PTY 列宽与 xterm 渲染列宽保持一致（横向模式下同步扩列），确保 readline/zle 翻历史命令时
    // 按正确宽度重绘；代价是横向扩列时 top/docker 等程序也会看到被撑宽的终端尺寸。
    if (currentSession && (!previousSize || previousSize.cols !== nextSize.cols || previousSize.rows !== nextSize.rows)) {
      void backend.resizeTerminal(currentSession.id, nextLayoutSize.remoteCols, nextLayoutSize.rows);
    }
    scheduleTerminalCursorFollow();
    scheduleTerminalSelectionOverlaySync();
    scheduleTerminalControlledInputCursorSync();
    scheduleTerminalVerticalScrollbarSync();
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
      minimumContrastRatio: terminalMinimumContrastRatioRef.current,
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
    const controlledCursor = document.createElement('div');
    controlledCursor.classList.add('terminal-controlled-input-cursor');
    containerRef.current.appendChild(controlledCursor);
    terminalControlledCursorRef.current = controlledCursor;
    const verticalScrollbar = document.createElement('div');
    verticalScrollbar.classList.add('terminal-vertical-scrollbar');
    const verticalScrollbarThumb = document.createElement('div');
    verticalScrollbarThumb.classList.add('terminal-vertical-scrollbar-thumb');
    verticalScrollbar.appendChild(verticalScrollbarThumb);
    containerRef.current.parentElement?.appendChild(verticalScrollbar);
    terminalVerticalScrollbarRef.current = verticalScrollbar;
    terminalVerticalScrollbarThumbRef.current = verticalScrollbarThumb;
    // 行号栏挂到 workspace（surface 的父层），横向滚动时保持固定在左侧；右键弹出显示项开关菜单。
    const gutter = document.createElement('div');
    gutter.classList.add('terminal-gutter');
    const handleGutterContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setTerminalGutterContextMenu({ x: event.clientX, y: event.clientY });
    };
    gutter.addEventListener('contextmenu', handleGutterContextMenu);
    containerRef.current.parentElement?.appendChild(gutter);
    terminalGutterRef.current = gutter;
    terminal.attachCustomWheelEventHandler(handleAiAgentTerminalWheel);
    const textarea = terminal.element?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    const handleTerminalCompositionStart = () => {
      terminalImeComposingRef.current = true;
      scheduleTerminalImeCompositionAnchorSync();
    };
    const handleTerminalCompositionUpdate = () => {
      terminalImeComposingRef.current = true;
      scheduleTerminalImeCompositionAnchorSync();
    };
    const handleTerminalCompositionEnd = () => {
      terminalImeComposingRef.current = false;
    };
    textarea?.addEventListener('compositionstart', handleTerminalCompositionStart);
    textarea?.addEventListener('compositionupdate', handleTerminalCompositionUpdate);
    textarea?.addEventListener('compositionend', handleTerminalCompositionEnd);

    const dataDisposable = terminal.onData((data) => {
      if (canAcceptTerminalInput(sessionRef.current)) {
        clearTerminalSelectionSnapshot();
        markLocalTerminalInputForCursorFollow();
        onTerminalDataRef.current(data);
        scheduleTerminalCursorFollow();
        scheduleTerminalControlledInputCursorSync();
      }
    });
    const cursorMoveDisposable = terminal.onCursorMove(() => {
      scheduleTerminalCursorFollow();
      scheduleTerminalControlledInputCursorSync();
    });
    const renderDisposable = terminal.onRender(() => {
      scheduleTerminalImeCompositionAnchorSync();
      scheduleTerminalControlledInputCursorSync();
      scheduleTerminalGutterSync();
    });
    // 每次硬换行落到新行时登记一条逻辑行 marker（仅定位）；始终登记，与开关无关，保证切换显示项后
    // 历史行仍能定位。软换行不触发，天然显示为续行占位。
    const lineFeedDisposable = terminal.onLineFeed(() => {
      registerTerminalGutterLine(Date.now());
    });
    const scrollDisposable = terminal.onScroll(() => {
      // 竖向翻页只能刷新依赖 viewportY 的覆盖层，禁止按当前页最长行 resize；否则会 reflow 出空行并造成页面跳动。
      scheduleTerminalMatchHighlightRefresh();
      scheduleTerminalSelectionOverlaySync();
      scheduleTerminalImeCompositionAnchorSync();
      scheduleTerminalControlledInputCursorSync();
      scheduleTerminalVerticalScrollbarSync();
      scheduleTerminalGutterSync();
    });
    const selectionDisposable = terminal.onSelectionChange(() => {
      if (!terminalSelectionRestoreActiveRef.current) {
        captureTerminalSelectionSnapshot();
      }
      scheduleTerminalMatchHighlightRefresh();
      syncTerminalSelectionOverlay();
    });
    const resizeDisposable = terminal.onResize(() => {
      scheduleTerminalMatchHighlightRefresh();
      scheduleTerminalSelectionOverlaySync();
      scheduleTerminalControlledInputCursorSync();
      scheduleTerminalVerticalScrollbarSync();
      scheduleTerminalGutterSync();
    });
    const handleTerminalSurfaceScroll = () => {
      scheduleTerminalMatchHighlightRefresh();
      scheduleTerminalSelectionOverlaySync();
      scheduleTerminalControlledInputCursorSync();
      scheduleTerminalVerticalScrollbarSync();
      scheduleTerminalGutterSync();
    };

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    syncTerminalSizeToRemote();

    const observer = new ResizeObserver(scheduleTerminalSizeSync);
    observer.observe(containerRef.current);
    window.addEventListener('resize', scheduleTerminalSizeSync);
    window.addEventListener('mouseup', stopTerminalSelectionDragSync, true);
    window.addEventListener('blur', stopTerminalSelectionDragSync);
    window.addEventListener('mousemove', syncTerminalVerticalScrollbarDrag, true);
    window.addEventListener('mouseup', stopTerminalVerticalScrollbarDrag, true);
    window.addEventListener('blur', stopTerminalVerticalScrollbarDrag);
    containerRef.current.addEventListener('mousedown', startTerminalSelectionDragSync, true);
    containerRef.current.addEventListener('scroll', handleTerminalSurfaceScroll);
    verticalScrollbar.addEventListener('mousedown', startTerminalVerticalScrollbarDrag);
    const handleScrollbarMouseEnter = () => {
      if (terminalVerticalScrollbarTimeoutRef.current !== null) {
        window.clearTimeout(terminalVerticalScrollbarTimeoutRef.current);
        terminalVerticalScrollbarTimeoutRef.current = null;
      }
      showTerminalVerticalScrollbar();
    };
    const handleScrollbarMouseLeave = () => {
      hideTerminalVerticalScrollbar();
    };
    verticalScrollbar.addEventListener('mouseenter', handleScrollbarMouseEnter);
    verticalScrollbar.addEventListener('mouseleave', handleScrollbarMouseLeave);
    // 每秒刷新一次行号栏，让最底部当前行的时间戳跟随实时时钟走动。
    terminalGutterClockTimerRef.current = window.setInterval(() => {
      // 页面隐藏（最小化/切后台）时跳过纯 UI 的时钟重绘，避免无谓布局与重绘开销；恢复时统一补一次。
      if (document.visibilityState !== 'visible') {
        return;
      }
      if (gutterShowTimestampRef.current) {
        scheduleTerminalGutterSync();
      }
    }, 1000);
    // 窗口从隐藏恢复可见时，合并刷新一次行号栏时钟，避免隐藏期间累积的时间偏差在下一秒才补上。
    const handleTerminalGutterVisibilityRefresh = () => {
      if (document.visibilityState === 'visible' && gutterShowTimestampRef.current) {
        scheduleTerminalGutterSync();
      }
    };
    document.addEventListener('visibilitychange', handleTerminalGutterVisibilityRefresh);
    scheduleTerminalGutterSync();

    return () => {
      dataDisposable.dispose();
      cursorMoveDisposable.dispose();
      renderDisposable.dispose();
      lineFeedDisposable.dispose();
      scrollDisposable.dispose();
      selectionDisposable.dispose();
      resizeDisposable.dispose();
      textarea?.removeEventListener('compositionstart', handleTerminalCompositionStart);
      textarea?.removeEventListener('compositionupdate', handleTerminalCompositionUpdate);
      textarea?.removeEventListener('compositionend', handleTerminalCompositionEnd);
      observer.disconnect();
      window.removeEventListener('resize', scheduleTerminalSizeSync);
      window.removeEventListener('mouseup', stopTerminalSelectionDragSync, true);
      window.removeEventListener('blur', stopTerminalSelectionDragSync);
      window.removeEventListener('mousemove', syncTerminalVerticalScrollbarDrag, true);
      window.removeEventListener('mouseup', stopTerminalVerticalScrollbarDrag, true);
      window.removeEventListener('blur', stopTerminalVerticalScrollbarDrag);
      containerRef.current?.removeEventListener('mousedown', startTerminalSelectionDragSync, true);
      containerRef.current?.removeEventListener('scroll', handleTerminalSurfaceScroll);
      verticalScrollbar.removeEventListener('mousedown', startTerminalVerticalScrollbarDrag);
      verticalScrollbar.removeEventListener('mouseenter', handleScrollbarMouseEnter);
      verticalScrollbar.removeEventListener('mouseleave', handleScrollbarMouseLeave);
      gutter.removeEventListener('contextmenu', handleGutterContextMenu);
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
      if (terminalImeCompositionFrameRef.current !== null) {
        window.cancelAnimationFrame(terminalImeCompositionFrameRef.current);
        terminalImeCompositionFrameRef.current = null;
      }
      if (terminalControlledCursorFrameRef.current !== null) {
        window.cancelAnimationFrame(terminalControlledCursorFrameRef.current);
        terminalControlledCursorFrameRef.current = null;
      }
      if (terminalVerticalScrollbarFrameRef.current !== null) {
        window.cancelAnimationFrame(terminalVerticalScrollbarFrameRef.current);
        terminalVerticalScrollbarFrameRef.current = null;
      }
      if (terminalGutterFrameRef.current !== null) {
        window.cancelAnimationFrame(terminalGutterFrameRef.current);
        terminalGutterFrameRef.current = null;
      }
      if (terminalGutterClockTimerRef.current !== null) {
        window.clearInterval(terminalGutterClockTimerRef.current);
        terminalGutterClockTimerRef.current = null;
      }
      document.removeEventListener('visibilitychange', handleTerminalGutterVisibilityRefresh);
      terminalImeComposingRef.current = false;
      terminalSelectionDragActiveRef.current = false;
      terminalVerticalScrollbarDragRef.current = null;
      clearTerminalSelectionSnapshot();
      resetTerminalGutterMarkers();
      hideTerminalControlledInputCursor();
      matchOverlay.remove();
      selectionOverlay.remove();
      controlledCursor.remove();
      verticalScrollbar.remove();
      gutter.remove();
      terminalMatchOverlayRef.current = null;
      terminalSelectionOverlayRef.current = null;
      terminalControlledCursorRef.current = null;
      terminalVerticalScrollbarRef.current = null;
      terminalVerticalScrollbarThumbRef.current = null;
      terminalGutterRef.current = null;
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
      // 原始输出进有界分片缓存：只累加分片、不整体拼接，超限时按会话/全局上限淘汰最旧分片。
      outputCacheRef.current.append(
        chunk.sessionId,
        chunk.content,
        sessionRef.current?.id === chunk.sessionId,
      );

      if (sessionRef.current?.id === chunk.sessionId) {
        terminalRef.current?.write(chunk.content, () => {
          scheduleTerminalSizeSync();
          syncLocalCursorVisibility(false);
          scheduleTerminalCursorFollow();
          scheduleTerminalMatchHighlightRefresh();
          scheduleTerminalSelectionOverlaySync();
          scheduleTerminalImeCompositionAnchorSync();
          scheduleTerminalControlledInputCursorSync();
          scheduleTerminalVerticalScrollbarSync();
          scheduleTerminalGutterSync();
        });
      }
    };

    window.addEventListener(terminalOutputEventName, handleTerminalOutput);
    return () => window.removeEventListener(terminalOutputEventName, handleTerminalOutput);
  }, []);

  // 会话列表变化时（含关闭标签、批量关闭、重连换 ID），显式回收已不存在会话的输出缓存与行号时间线，
  // 避免关闭过的会话历史一直保留到应用退出。
  useEffect(() => {
    const live = new Set(liveSessionIds);
    outputCacheRef.current.retain(live);
    for (const sessionId of Object.keys(terminalGutterSessionDataRef.current)) {
      if (!live.has(sessionId)) {
        delete terminalGutterSessionDataRef.current[sessionId];
      }
    }
    for (const sessionId of Object.keys(terminalHorizontalRenderColsBySessionRef.current)) {
      if (!live.has(sessionId)) {
        delete terminalHorizontalRenderColsBySessionRef.current[sessionId];
      }
    }
  }, [liveSessionIds]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    terminal.options.disableStdin = !canAcceptTerminalInput(session);
    applyTerminalSessionBehaviorOptions();
    syncLocalCursorVisibility();
    scheduleTerminalControlledInputCursorSync();
    window.requestAnimationFrame(focusPendingTerminalInput);
  }, [minimumContrastRatioForSession, session?.id, session?.status, terminalScrollbackRows, useControlledInputCursorForSession]);

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
      scheduleTerminalControlledInputCursorSync();
      scheduleTerminalVerticalScrollbarSync();
    });
  }, [settings.shellFontSize, terminalFontFamily, terminalTheme]);

  useEffect(() => {
    if (settings.terminalMatchSelection ?? true) {
      scheduleTerminalMatchHighlightRefresh();
      return;
    }

    clearTerminalMatchOverlay();
  }, [settings.terminalMatchSelection]);

  // 行号栏显示项、字号或会话类型变化后重算宽度并重绘：本地会话整条左栏隐藏（宽度归零），会改变正文列宽，需重新 fit。
  useEffect(() => {
    scheduleTerminalGutterSync();
    scheduleTerminalSizeSync();
  }, [gutterShowLineNumber, gutterShowTimestamp, settings.shellFontSize, session?.kind]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    pendingFocusSessionIdRef.current = session?.id ?? null;
    // 会话切换后重放缓存属于历史画面恢复，不能继承上一会话的本地输入跟随状态。
    lastLocalTerminalInputAtRef.current = 0;
    // 恢复目标会话自己的横向列宽高水位，避免上一会话串宽，也避免切回来后历史长行宽度丢失。
    terminalHorizontalRenderColsRef.current = session?.id
      ? terminalHorizontalRenderColsBySessionRef.current[session.id] ?? 0
      : 0;
    terminalHorizontalFullBufferMeasurePendingRef.current = false;
    terminalImeComposingRef.current = false;
    hideTerminalControlledInputCursor();
    replayCurrentSessionOutput();
    // 新会话打开时立刻把当前 xterm 尺寸推给远端 PTY，避免默认 120 列和实际界面列宽不一致。
    remoteTerminalSizeRef.current = null;
    window.requestAnimationFrame(() => {
      syncTerminalSizeToRemote();
      focusPendingTerminalInput();
      scheduleTerminalControlledInputCursorSync();
      scheduleTerminalVerticalScrollbarSync();
    });
  }, [session?.id]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    // SSH 长行展示模式或会话类型改变会影响 xterm 渲染列数；本地终端始终使用 wrap。
    remoteTerminalSizeRef.current = null;
    // 显式切换模式允许重新建立列宽基线；正常竖向滚动期间仍禁止缩列。
    terminalHorizontalRenderColsRef.current = 0;
    if (sessionRef.current?.id) {
      delete terminalHorizontalRenderColsBySessionRef.current[sessionRef.current.id];
    }
    terminalHorizontalFullBufferMeasurePendingRef.current = false;
    // 模式切换触发的是缓存重排，不是用户正在编辑命令，避免切换后按旧光标位置自动横移。
    lastLocalTerminalInputAtRef.current = 0;
    window.requestAnimationFrame(() => {
      // 模式切换只按新列宽 resize，交给 xterm 原生 reflow 重排当前缓冲区；绝不能 reset+重放原始缓存，
      // 否则历史翻页时 readline 的原地重绘序列会按新列宽错位，导致翻过的命令全部堆叠残留在屏幕上。
      clearTerminalSelectionSnapshot();
      syncTerminalSizeToRemote();
      scheduleTerminalMatchHighlightRefresh();
      scheduleTerminalSelectionOverlaySync();
      scheduleTerminalControlledInputCursorSync();
      scheduleTerminalVerticalScrollbarSync();
    });
  }, [effectiveTerminalLineWrapMode]);

  return (
    <section className="terminal-workspace card" style={{ background: terminalBackgroundColor }}>
      {backgroundImageStyle ? <div className="terminal-background-image" style={backgroundImageStyle} /> : null}
      <div
        className={`terminal-surface ${terminalHasHorizontalOverflow && effectiveTerminalLineWrapMode === 'horizontal' ? 'is-horizontal-scroll' : 'is-wrapped'}`}
        ref={containerRef}
        onContextMenu={handleTerminalContextMenu}
        onMouseLeave={hideTerminalVerticalScrollbar}
        onMouseMove={handleTerminalMouseMove}
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

      {terminalGutterContextMenu ? (
        <div
          className="context-menu terminal-gutter-context-menu"
          style={{ left: terminalGutterContextMenu.x, top: terminalGutterContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            className="context-menu-item terminal-gutter-context-item"
            onClick={() => {
              setTerminalGutterContextMenu(null);
              onUpdateSettings({ terminalGutterShowLineNumber: !gutterShowLineNumber });
              restoreTerminalFocusAfterContextMenuAction();
            }}
            type="button"
          >
            <span className={`terminal-gutter-context-check ${gutterShowLineNumber ? 'is-checked' : ''}`} aria-hidden="true" />
            {translate(settings.uiLanguage, 'terminalGutterShowLineNumber')}
          </button>
          <button
            className="context-menu-item terminal-gutter-context-item"
            onClick={() => {
              setTerminalGutterContextMenu(null);
              onUpdateSettings({ terminalGutterShowTimestamp: !gutterShowTimestamp });
              restoreTerminalFocusAfterContextMenuAction();
            }}
            type="button"
          >
            <span className={`terminal-gutter-context-check ${gutterShowTimestamp ? 'is-checked' : ''}`} aria-hidden="true" />
            {translate(settings.uiLanguage, 'terminalGutterShowTimestamp')}
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
