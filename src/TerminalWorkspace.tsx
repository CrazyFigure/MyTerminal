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

// 横向列数只在确实超过可视宽度时增长，并按固定步长取整来减少后端 resize 抖动。
const roundHorizontalColumns = (requiredColumns: number, visibleColumns: number) => {
  if (requiredColumns <= visibleColumns) {
    return visibleColumns;
  }
  const roundedColumns = Math.ceil(requiredColumns / terminalHorizontalColumnGrowthStep) * terminalHorizontalColumnGrowthStep;
  return Math.min(terminalHorizontalMaxColumns, Math.max(visibleColumns, roundedColumns));
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

// 终端彩色文本使用清晰的 ANSI 调色板；浅色终端里 ANSI white 也要落到深灰，避免 ls 高亮发白发虚。
const buildTerminalTheme = (settings: AppSettings) => {
  const isDarkTheme = settings.themeMode === 'dark';
  const hasBackgroundImage = Boolean(settings.backgroundImage?.trim());

  return {
    background: hasBackgroundImage ? 'rgba(0, 0, 0, 0)' : settings.terminalBackground,
    foreground: settings.terminalForeground,
    cursor: settings.accentColor,
    selectionBackground: isDarkTheme ? '#334155' : '#bfdbfe',
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const cachedOutputBySessionRef = useRef<Record<string, string>>({});
  const onTerminalDataRef = useRef(onTerminalData);
  const sessionRef = useRef<TerminalSession | undefined>(session);
  const resizeFrameRef = useRef<number | null>(null);
  const cursorFollowFrameRef = useRef<number | null>(null);
  const terminalSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const pendingFocusSessionIdRef = useRef<string | null>(session?.id ?? null);
  const terminalLineWrapMode = settings.terminalLineWrapMode ?? 'wrap';
  const terminalLineWrapModeRef = useRef<AppSettings['terminalLineWrapMode']>(terminalLineWrapMode);
  const terminalUsesHorizontalScroll = terminalLineWrapMode === 'horizontal';
  const terminalTheme = useMemo(
    () => buildTerminalTheme(settings),
    [
      settings.accentColor,
      settings.backgroundImage,
      settings.terminalBackground,
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
  const terminalFontFamily = useMemo(
    () => buildTerminalFontFamily(
      settings.shellLatinFontFamily ?? settings.shellFontFamily,
      settings.shellCjkFontFamily ?? settings.shellFontFamily,
    ),
    [settings.shellCjkFontFamily, settings.shellFontFamily, settings.shellLatinFontFamily],
  );
  terminalLineWrapModeRef.current = terminalLineWrapMode;

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

  // 远端命令可能输出隐藏光标控制符；会话切换或缓存重放后只恢复本地 xterm 光标，不把控制符写回 SSH。
  const restoreLocalCursorVisibility = () => {
    const terminal = terminalRef.current;
    if (!terminal || !canAcceptTerminalInput(sessionRef.current)) {
      return;
    }

    terminal.write(terminalCursorShowSequence);
  };

  // 右键菜单动作完成后延后一帧恢复焦点，确保 React 已经卸载菜单按钮。
  const restoreTerminalFocusAfterContextMenuAction = () => {
    // 右键菜单按钮会短暂拿走焦点；等待菜单卸载后再聚焦 xterm，避免复制/粘贴后键盘输入停在旧光标状态。
    window.requestAnimationFrame(() => {
      focusTerminalInput();
    });
  };

  // 横向滚动模式下 xterm 元素必须比可视容器更宽，外层容器才会出现底部滚动条。
  const applyTerminalElementWidth = (targetCols: number, visibleCols: number) => {
    const container = containerRef.current;
    const terminal = terminalRef.current;
    const terminalElement = terminal?.element;
    if (!container || !terminal || !terminalElement) {
      return;
    }

    if (terminalLineWrapModeRef.current !== 'horizontal') {
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

  // 当前缓冲区通过 isWrapped 合并软换行片段，用来判断是否真的需要横向滚动和扩列。
  const measureTerminalBufferLongestLineColumns = () => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return 0;
    }

    const buffer = terminal.buffer.active;
    let longestColumns = 0;
    let currentLineColumns = 0;
    for (let lineIndex = 0; lineIndex < buffer.length; lineIndex += 1) {
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

    const longestLineColumns = measureTerminalBufferLongestLineColumns();
    const cursorRequiredColumns = terminal.buffer.active.cursorX + terminalCursorFollowMarginColumns;
    const requiredColumns = Math.max(
      visibleCols,
      longestLineColumns + terminalHorizontalLinePaddingColumns,
      cursorRequiredColumns,
    );
    return roundHorizontalColumns(requiredColumns, visibleCols);
  };

  // 横向模式不使用 fitAddon.fit 直接改列数，而是按可视行数 + 动态目标列数手动 resize。
  const resolveTerminalLayoutSize = () => {
    const terminal = terminalRef.current;
    const proposed = fitAddonRef.current?.proposeDimensions();
    if (!terminal || !proposed) {
      return undefined;
    }

    const visibleCols = Math.max(2, proposed.cols);
    const rows = Math.max(1, proposed.rows);
    const cols = terminalLineWrapModeRef.current === 'horizontal'
      ? resolveHorizontalTerminalColumns(visibleCols)
      : visibleCols;
    return { cols, rows, visibleCols };
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

    terminal.reset();
    const cachedOutput = sessionRef.current?.id ? cachedOutputBySessionRef.current[sessionRef.current.id] ?? '' : '';
    if (cachedOutput) {
      terminal.write(cachedOutput, () => {
        scheduleTerminalSizeSync();
        restoreLocalCursorVisibility();
        scheduleTerminalCursorFollow();
      });
      return;
    }

    scheduleTerminalSizeSync();
    restoreLocalCursorVisibility();
    scheduleTerminalCursorFollow();
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
    if (!terminalUsesHorizontalScroll || !containerRef.current) {
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

  const syncTerminalSizeToRemote = () => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    const nextLayoutSize = resolveTerminalLayoutSize();
    if (!nextLayoutSize) {
      return;
    }

    applyTerminalElementWidth(nextLayoutSize.cols, nextLayoutSize.visibleCols);
    if (terminal.cols !== nextLayoutSize.cols || terminal.rows !== nextLayoutSize.rows) {
      terminal.resize(nextLayoutSize.cols, nextLayoutSize.rows);
    }
    applyTerminalElementWidth(nextLayoutSize.cols, nextLayoutSize.visibleCols);

    const currentSession = sessionRef.current;
    const nextSize = { cols: nextLayoutSize.cols, rows: nextLayoutSize.rows };
    const previousSize = terminalSizeRef.current;
    terminalSizeRef.current = nextSize;
    // 远端 readline/zle 按 PTY 列宽重绘长命令；session 切换后也必须同步一次，不能只依赖 ResizeObserver。
    if (currentSession && (!previousSize || previousSize.cols !== nextSize.cols || previousSize.rows !== nextSize.rows)) {
      void backend.resizeTerminal(currentSession.id, nextLayoutSize.cols, nextLayoutSize.rows);
    }
    scheduleTerminalCursorFollow();
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
      theme: terminalTheme,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);

    const dataDisposable = terminal.onData((data) => {
      if (canAcceptTerminalInput(sessionRef.current)) {
        onTerminalDataRef.current(data);
        scheduleTerminalCursorFollow();
      }
    });
    const cursorMoveDisposable = terminal.onCursorMove(scheduleTerminalCursorFollow);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    syncTerminalSizeToRemote();

    const observer = new ResizeObserver(scheduleTerminalSizeSync);
    observer.observe(containerRef.current);
    window.addEventListener('resize', scheduleTerminalSizeSync);

    return () => {
      dataDisposable.dispose();
      cursorMoveDisposable.dispose();
      observer.disconnect();
      window.removeEventListener('resize', scheduleTerminalSizeSync);
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      if (cursorFollowFrameRef.current !== null) {
        window.cancelAnimationFrame(cursorFollowFrameRef.current);
        cursorFollowFrameRef.current = null;
      }
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
          scheduleTerminalCursorFollow();
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
    restoreLocalCursorVisibility();
    window.requestAnimationFrame(focusPendingTerminalInput);
  }, [session?.id, session?.status]);

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
    });
  }, [settings.shellFontSize, terminalFontFamily, terminalTheme]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    pendingFocusSessionIdRef.current = session?.id ?? null;
    replayCurrentSessionOutput();
    // 新会话打开时立刻把当前 xterm 尺寸推给远端 PTY，避免默认 120 列和实际界面列宽不一致。
    terminalSizeRef.current = null;
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

    // 长行展示模式改变会影响 PTY 列宽，必须先 resize 再重放缓存，保证原有画面也同步切换排版。
    terminalSizeRef.current = null;
    window.requestAnimationFrame(() => {
      syncTerminalSizeToRemote();
      replayCurrentSessionOutput();
    });
  }, [terminalLineWrapMode]);

  return (
    <section className="terminal-workspace card" style={{ background: settings.terminalBackground }}>
      {backgroundImageStyle ? <div className="terminal-background-image" style={backgroundImageStyle} /> : null}
      <div
        className={`terminal-surface ${terminalUsesHorizontalScroll ? 'is-horizontal-scroll' : 'is-wrapped'}`}
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
