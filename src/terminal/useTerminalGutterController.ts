import type { RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';

import type { TerminalSession } from '../types';
import {
  formatTerminalGutterClock,
  terminalGutterCharWidthRatio,
  terminalGutterFontScale,
  terminalGutterHorizontalPaddingPx,
  terminalGutterMaxTrackedLines,
  terminalGutterMinDigits,
  terminalGutterMinFontSizePx,
  terminalGutterMinWidthPx,
  terminalGutterTimestampCharCount,
  terminalGutterWrappedLineSymbol,
  type TerminalGutterMarkerEntry,
  type TerminalGutterSessionData,
  type TerminalReplayState,
} from './support';

type TerminalGutterControllerOptions = {
  containerRef: RefObject<HTMLDivElement | null>;
  gutterShowLineNumberRef: RefObject<boolean>;
  gutterShowTimestampRef: RefObject<boolean>;
  scheduleTerminalSizeSync: () => void;
  sessionRef: RefObject<TerminalSession | undefined>;
  terminalActiveReplayRef: RefObject<TerminalReplayState | null>;
  terminalFontSizeRef: RefObject<number>;
  terminalGutterFrameRef: RefObject<number | null>;
  terminalGutterMarkersRef: RefObject<TerminalGutterMarkerEntry[]>;
  terminalGutterRef: RefObject<HTMLDivElement | null>;
  terminalGutterReplayActiveRef: RefObject<boolean>;
  terminalGutterReplayNextLogicalNumberRef: RefObject<number>;
  terminalGutterSessionDataRef: RefObject<Record<string, TerminalGutterSessionData>>;
  terminalGutterWidthRef: RefObject<number>;
  terminalRef: RefObject<Terminal | null>;
  terminalScrollbackRowsRef: RefObject<number>;
};

// 控制器封装行号时间线、宽度预算和帧调度；调用方只使用四个用例级操作。
export function useTerminalGutterController(options: TerminalGutterControllerOptions) {
  const {
    containerRef,
    gutterShowLineNumberRef,
    gutterShowTimestampRef,
    scheduleTerminalSizeSync,
    sessionRef,
    terminalActiveReplayRef,
    terminalFontSizeRef,
    terminalGutterFrameRef,
    terminalGutterMarkersRef,
    terminalGutterRef,
    terminalGutterReplayActiveRef,
    terminalGutterReplayNextLogicalNumberRef,
    terminalGutterSessionDataRef,
    terminalGutterWidthRef,
    terminalRef,
    terminalScrollbackRowsRef,
  } = options;

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
const finishTerminalGutterReplay = (nowMs: number, completedReplay: TerminalReplayState) => {
  const activeReplay = terminalActiveReplayRef.current;
  if (
    !activeReplay
    || activeReplay.generation !== completedReplay.generation
    || activeReplay.sessionId !== completedReplay.sessionId
  ) {
    return false;
  }

  terminalActiveReplayRef.current = null;
  terminalGutterReplayActiveRef.current = false;
  // 快速切换会话时旧 write 回调即使最后到达，也不能把它的 gutter 数据归到当前会话。
  if (sessionRef.current?.id !== completedReplay.sessionId) {
    return false;
  }
  if (!completedReplay.sessionId) {
    return true;
  }
  const sessionId = completedReplay.sessionId;
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
  return true;
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

  return {
    finishTerminalGutterReplay,
    registerTerminalGutterLine,
    resetTerminalGutterMarkers,
    scheduleTerminalGutterSync,
  };
}
