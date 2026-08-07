import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import { backend } from './backend';
import { readClipboardText, writeClipboardText } from './clipboard';
import { translate } from './i18n';
import { TerminalOutputCache, type TerminalReplayEntry } from './terminalCache';
import { buildTerminalFontFamily } from './terminalFonts';
import type { AppSettings, TerminalOutputChunk, TerminalSession } from './types';
import { useTerminalGutterController } from './terminal/useTerminalGutterController';
import { useTerminalHighlightController } from './terminal/useTerminalHighlightController';
import { useTerminalLayoutController } from './terminal/useTerminalLayoutController';
import { useTerminalVerticalScrollbarController } from './terminal/useTerminalVerticalScrollbarController';

import {
  buildTerminalBackgroundImageStyle,
  buildTerminalTheme,
  canAcceptTerminalInput,
  countTerminalXtVersionQueries,
  findTerminalInverseCursorColumn,
  isRemoteHttpImage,
  isTerminalAiAgentSession,
  isWindowsTerminalHost,
  measureTerminalBufferLineContentColumns,
  parseTerminalOscRgbColor,
  parseTerminalRgbColor,
  resolveTerminalBackgroundImage,
  resolveTerminalCellVisualBackgroundRgb,
  resolveTerminalColorContrastRatio,
  resolveTerminalColors,
  resolveTerminalMinimumContrastRatio,
  shouldAnchorTerminalImeToPrompt,
  shouldHideLocalTerminalCursor,
  shouldUseManagedTerminalCursor,
  shouldUseNativeCtrlVPaste,
  shouldUseSoftDarkBlocks,
  terminalAiAgentScrollbackRows,
  terminalBracketedPasteEndSequence,
  terminalBracketedPasteStartSequence,
  terminalCursorFollowAfterInputMs,
  terminalCursorHideSequence,
  terminalCursorMinimumContrastRatio,
  terminalCursorRecoveryIdleMs,
  terminalCursorShowSequence,
  terminalDefaultScrollbackRows,
  terminalHighlightSvgNamespace,
  terminalManagedCursorInputGraceMs,
  terminalManagedCursorOutputIdleMs,
  terminalOutputEventName,
  terminalPromptBorderMinCharacters,
  terminalPromptBorderSearchDistanceRows,
  terminalPromptGlyphs,
  terminalPromptHighlightDarkColors,
  terminalPromptHighlightLightColors,
  terminalPromptSearchRows,
  terminalXtVersionReplyBatchSize,
  terminalXtVersionResponse,
  type TerminalGutterMarkerEntry,
  type TerminalGutterSessionData,
  type TerminalPromptAnchor,
  type TerminalPromptRowCache,
  type TerminalReplayDeferredOutput,
  type TerminalReplayState,
  type TerminalRgbColor,
  type TerminalXtVersionQueryParserState,
} from './terminal/support';

import '@xterm/xterm/css/xterm.css';

type Props = {
  session?: TerminalSession;
  settings: AppSettings;
  onTerminalData: (data: string) => void;
  // 终端能力协商可能来自后台会话，必须携带原始会话 ID 回写，不能误发到当前活动标签。
  onTerminalProtocolData: (sessionId: string, data: string) => void;
  // 行号栏右键菜单切换显示项后，需要把设置写回并持久化。
  onUpdateSettings: (partial: Partial<AppSettings>) => void;
  // 当前仍存活的会话 ID 列表；用于关闭标签后显式回收对应的输出缓存与行号时间线。
  liveSessionIds: string[];
};

export function TerminalWorkspace({
  session,
  settings,
  onTerminalData,
  onTerminalProtocolData,
  onUpdateSettings,
  liveSessionIds,
}: Props) {
  const [terminalContextMenu, setTerminalContextMenu] = useState<{ x: number; y: number; selectedText: string } | null>(null);
  // 行号栏右键菜单只承载“显示行号/时间戳”两个开关，与正文区右键复制/粘贴互不干扰。
  const [terminalGutterContextMenu, setTerminalGutterContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [terminalHasHorizontalOverflow, setTerminalHasHorizontalOverflow] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  // 行号控制器通过稳定引用延迟调用后方定义的尺寸同步函数，避免 Hook 初始化阶段访问未初始化闭包。
  const scheduleTerminalSizeSyncRef = useRef<() => void>(() => undefined);
  // 终端原始输出改用有界分片缓存：按会话/全局字节封顶、LRU 淘汰，并绑定后端确认的 PTY 尺寸；
  // 关闭会话时显式回收，既避免长期内存增长，也保证标签切换后动态覆盖行可按原几何重放。
  const outputCacheRef = useRef(new TerminalOutputCache());
  // 提示符命令行覆盖层基于 xterm 已解析缓冲区绘制，因此实时输出、标签切换和缓存重放共用同一条路径。
  const terminalContrastCursorRef = useRef<HTMLDivElement | null>(null);
  const terminalContrastCursorFrameRef = useRef<number | null>(null);
  // Codex 托管光标只在提交和持续输出期间暂停；输出稳定后即使输入框为空也必须自动恢复。
  const terminalManagedCursorSuppressedRef = useRef(false);
  const terminalManagedCursorInputGraceUntilRef = useRef(0);
  const terminalManagedCursorOutputIdleTimerRef = useRef<number | null>(null);
  // 自绘滚动条以独立交互控制器管理帧、计时器和拖拽状态；工作区仅负责编排 DOM 生命周期。
  const {
    disposeTerminalVerticalScrollbarController,
    handleTerminalMouseMove,
    handleTerminalVerticalScrollbarMouseEnter,
    handleTerminalVerticalScrollbarMouseLeave,
    hideTerminalVerticalScrollbar,
    scheduleTerminalVerticalScrollbarSync,
    startTerminalVerticalScrollbarDrag,
    stopTerminalVerticalScrollbarDrag,
    syncTerminalVerticalScrollbarDrag,
    terminalVerticalScrollbarRef,
    terminalVerticalScrollbarThumbRef,
  } = useTerminalVerticalScrollbarController({ containerRef, terminalRef });
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
  const terminalReplayGenerationRef = useRef(0);
  const terminalActiveReplayRef = useRef<TerminalReplayState | null>(null);
  const terminalReplayDeferredOutputRef = useRef<TerminalReplayDeferredOutput | null>(null);
  const terminalReplayInputBlockedRef = useRef(false);
  const terminalXtVersionParserStateBySessionRef = useRef(new Map<string, TerminalXtVersionQueryParserState>());
  // 按会话持久保存的逻辑行时间线；切换会话不清空，保证历史时间恒定。
  const terminalGutterSessionDataRef = useRef<Record<string, TerminalGutterSessionData>>({});
  const onTerminalDataRef = useRef(onTerminalData);
  const onTerminalProtocolDataRef = useRef(onTerminalProtocolData);
  const sessionRef = useRef<TerminalSession | undefined>(session);
  const resizeFrameRef = useRef<number | null>(null);
  // 追踪远端最近一次 DECTCEM 是否把光标设为隐藏,配合空闲看门狗做悬空隐藏光标的自愈。
  const terminalRemoteCursorHiddenRef = useRef(false);
  const terminalCursorRecoveryTimerRef = useRef<number | null>(null);
  const terminalImeCompositionFrameRef = useRef<number | null>(null);
  const terminalImeComposingRef = useRef(false);
  const terminalPromptRowCacheRef = useRef<TerminalPromptRowCache | null>(null);
  const lastLocalTerminalInputAtRef = useRef(0);
  const terminalLocalInputEditingRef = useRef(false);
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
  const useManagedCursorForSession = useMemo(
    () => shouldUseManagedTerminalCursor(session),
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
  const anchorImeToPromptForSession = useMemo(
    () => shouldAnchorTerminalImeToPrompt(session),
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
  const useManagedCursorForSessionRef = useRef(useManagedCursorForSession);
  const anchorImeToPromptForSessionRef = useRef(anchorImeToPromptForSession);
  const terminalMatchSelectionRef = useRef(settings.terminalMatchSelection ?? true);
  // 命令式覆盖层从 ref 读取当前主题，避免终端实例的一次性事件回调持有挂载时的旧配色。
  const terminalPromptHighlightColorsRef = useRef(
    settings.themeMode === 'dark' ? terminalPromptHighlightDarkColors : terminalPromptHighlightLightColors,
  );
  const isDarkThemeRef = useRef(settings.themeMode === 'dark');
  // 三类终端高亮共享缓冲区测量和选区快照，由一个渲染域控制器保证重排与销毁顺序一致。
  const {
    captureTerminalSelectionSnapshot,
    clearTerminalMatchOverlay,
    clearTerminalPromptHighlights,
    clearTerminalSelectionSnapshot,
    disposeTerminalHighlightController,
    resolveTerminalSelectionSnapshot,
    scheduleTerminalMatchHighlightRefresh,
    scheduleTerminalPromptHighlightRefresh,
    scheduleTerminalSelectionOverlaySync,
    startTerminalSelectionDragSync,
    stopTerminalSelectionDragSync,
    syncTerminalAuxiliaryLayerSizes,
    syncTerminalSelectionOverlay,
    terminalMatchOverlayRef,
    terminalPromptHighlightOverlayRef,
    terminalSelectionOverlayRef,
    terminalSelectionRestoreActiveRef,
  } = useTerminalHighlightController({
    containerRef,
    isAiAgentTerminalSessionRef,
    isDarkThemeRef,
    sessionRef,
    terminalMatchSelectionRef,
    terminalPromptHighlightColorsRef,
    terminalRef,
    terminalVerticalScrollbarRef,
  });
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
  // 记录 xterm 当前真实光标色；TUI 可通过 OSC 12 覆盖主题值，低对比兜底必须使用协议生效后的颜色。
  const terminalCursorColorRef = useRef<TerminalRgbColor | undefined>(parseTerminalRgbColor(terminalTheme.cursor));
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
  useManagedCursorForSessionRef.current = useManagedCursorForSession;
  anchorImeToPromptForSessionRef.current = anchorImeToPromptForSession;
  terminalMatchSelectionRef.current = settings.terminalMatchSelection ?? true;
  terminalPromptHighlightColorsRef.current = settings.themeMode === 'dark'
    ? terminalPromptHighlightDarkColors
    : terminalPromptHighlightLightColors;
  isDarkThemeRef.current = settings.themeMode === 'dark';
  gutterShowLineNumberRef.current = gutterShowLineNumber;
  gutterShowTimestampRef.current = gutterShowTimestamp;
  terminalFontSizeRef.current = settings.shellFontSize;

  useEffect(() => {
    onTerminalDataRef.current = onTerminalData;
  }, [onTerminalData]);

  useEffect(() => {
    onTerminalProtocolDataRef.current = onTerminalProtocolData;
  }, [onTerminalProtocolData]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  // 终端焦点恢复只面向可输入会话，避免关闭或异常会话重新抢占页面焦点。
  const focusTerminalInput = () => {
    const terminal = terminalRef.current;
    if (
      !terminal
      || terminalActiveReplayRef.current
      || terminalReplayInputBlockedRef.current
      || !canAcceptTerminalInput(sessionRef.current)
    ) {
      return;
    }

    terminal.focus();
  };

  // 点击顶部会话标签后先记住目标会话，等 SSH 从 connecting 进入可输入状态时再把焦点交回 xterm。
  const focusPendingTerminalInput = () => {
    const targetSessionId = pendingFocusSessionIdRef.current;
    if (
      terminalActiveReplayRef.current
      || terminalReplayInputBlockedRef.current
      || !targetSessionId
      || sessionRef.current?.id !== targetSessionId
      || !canAcceptTerminalInput(sessionRef.current)
    ) {
      return;
    }

    pendingFocusSessionIdRef.current = null;
    focusTerminalInput();
  };

  // 重放期间除协议自动回复外禁止真实用户输入；移出 Tab 顺序可避免隐藏 textarea 被意外聚焦并上报焦点协议。
  const setTerminalReplayInputBlocked = (blocked: boolean) => {
    terminalReplayInputBlockedRef.current = blocked;
    const textarea = terminalRef.current?.element?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    if (textarea) {
      textarea.tabIndex = blocked ? -1 : 0;
    }
  };

  // 自绘型 TUI 与 Codex 托管模式都在协议层隐藏 xterm 原生光标；其它程序的显隐仍由标准终端协议接管。
  const syncLocalCursorVisibility = () => {
    const terminal = terminalRef.current;
    if (!terminal || !canAcceptTerminalInput(sessionRef.current)) {
      return;
    }

    if (hideLocalCursorForSessionRef.current || useManagedCursorForSessionRef.current) {
      terminal.write(terminalCursorHideSequence);
    }
  };

  // Claude 自绘输入框时真实 xterm cursor 可能停在状态栏；从可见输入行解析中文输入法锚点。
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
    // Claude 在侧栏展开、窗口 resize 或启动期重排后，输入框可能停在视口上半部；专用会话扫描整个可见区。
    // 默认分支仍限制在底部，避免未来复用此解析器时把历史回答里的提示符误判为输入行。
    const promptSearchStartRow = anchorImeToPromptForSessionRef.current
      ? firstVisibleRow
      : Math.max(firstVisibleRow, lastVisibleRow - terminalPromptSearchRows + 1);
    let promptStartRow = -1;

    // Claude 新版在首词提交后可能连提示符也一起擦掉；上下输入框边线可为无提示符行提供可信结构锚点。
    const promptBorderRowCache = new Map<number, boolean>();
    const isPromptBorderRow = (row: number) => {
      const cached = promptBorderRowCache.get(row);
      if (cached !== undefined) {
        return cached;
      }
      const text = buffer.getLine(row)?.translateToString(true).replace(/\s/g, '') ?? '';
      const isBorder = text.length >= terminalPromptBorderMinCharacters && /^[─━═-]+$/.test(text);
      // 全视口扫描会反复检查邻近行；单次解析内缓存结果，避免每个候选行重复翻译整条 xterm buffer。
      promptBorderRowCache.set(row, isBorder);
      return isBorder;
    };
    const isFramedFallbackPrompt = (row: number) => {
      let hasUpperBorder = false;
      let hasLowerBorder = false;
      for (
        let candidate = row - 1;
        candidate >= Math.max(promptSearchStartRow, row - terminalPromptBorderSearchDistanceRows);
        candidate -= 1
      ) {
        if (isPromptBorderRow(candidate)) {
          hasUpperBorder = true;
          break;
        }
      }
      for (
        let candidate = row + 1;
        candidate <= Math.min(lastVisibleRow, row + terminalPromptBorderSearchDistanceRows);
        candidate += 1
      ) {
        if (isPromptBorderRow(candidate)) {
          hasLowerBorder = true;
          break;
        }
      }
      return hasUpperBorder && hasLowerBorder;
    };

    for (let row = lastVisibleRow; row >= promptSearchStartRow; row -= 1) {
      const line = buffer.getLine(row);
      const text = line?.translateToString(true) ?? '';
      // 边线本身不能充当输入行；多段分隔线相邻时否则可能把中间边线误判成被框住的内容。
      if (!line || line.isWrapped || isPromptBorderRow(row)) {
        continue;
      }
      const trimmedText = text.trimStart();
      const hasKnownPromptGlyph = terminalPromptGlyphs.some((glyph) => trimmedText.startsWith(glyph));
      const hasFramedClaudeInputRow = anchorImeToPromptForSessionRef.current && isFramedFallbackPrompt(row);
      if (!hasKnownPromptGlyph && !hasFramedClaudeInputRow) {
        continue;
      }

      promptStartRow = row;
      if (anchorImeToPromptForSessionRef.current && sessionRef.current?.id) {
        terminalPromptRowCacheRef.current = { sessionId: sessionRef.current.id, row };
      }
      break;
    }

    // 首个中文词提交后 Claude 可能擦掉提示符；输入尚未提交时复用上一条可信输入行并重新测量当前列。
    if (promptStartRow < 0 && anchorImeToPromptForSessionRef.current) {
      const cachedPrompt = terminalPromptRowCacheRef.current;
      const cachedLine = cachedPrompt && cachedPrompt.sessionId === sessionRef.current?.id
        ? buffer.getLine(cachedPrompt.row)
        : undefined;
      if (
        cachedPrompt &&
        cachedLine &&
        !cachedLine.isWrapped &&
        cachedPrompt.row >= firstVisibleRow &&
        cachedPrompt.row <= lastVisibleRow
      ) {
        promptStartRow = cachedPrompt.row;
      } else {
        terminalPromptRowCacheRef.current = null;
      }
    }
    if (promptStartRow < firstVisibleRow) {
      return undefined;
    }

    // 输入行的最后一个软换行物理行；无反色光标时退回这一行的行末内容列。
    let promptEndRow = promptStartRow;
    while (promptEndRow < lastVisibleRow && buffer.getLine(promptEndRow + 1)?.isWrapped) {
      promptEndRow += 1;
    }

    // 优先在整条软换行组内定位 Claude 自绘的反色光标块：光标移到行中间/靠上的续行时，
    // 候选窗才能跟随真实光标列，而不是笼统停在最后一行的行末。
    let promptRow = promptEndRow;
    let promptColumn = -1;
    for (let row = promptStartRow; row <= promptEndRow; row += 1) {
      const line = buffer.getLine(row);
      const inverseCursorColumn = line ? findTerminalInverseCursorColumn(line, terminal.cols) : -1;
      if (inverseCursorColumn >= 0) {
        promptRow = row;
        promptColumn = inverseCursorColumn;
        break;
      }
    }

    // 未找到反色光标（例如光标停在行尾空白处）时，退回最后一物理行的行末内容列。
    if (promptColumn < 0) {
      const promptEndLine = buffer.getLine(promptEndRow);
      promptColumn = promptEndLine ? measureTerminalBufferLineContentColumns(promptEndLine, terminal.cols) : 0;
    }
    promptColumn = Math.min(terminal.cols - 1, Math.max(0, promptColumn));

    const screenRect = screen.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const cellWidth = screenRect.width / terminal.cols;
    const cellHeight = screenRect.height / terminal.rows;
    const screenLeft = promptColumn * cellWidth;
    const screenTop = (promptRow - firstVisibleRow) * cellHeight;
    return {
      row: promptRow,
      column: promptColumn,
      promptStartRow,
      promptEndRow,
      screenLeft,
      screenTop,
      containerLeft: screenRect.left - containerRect.left + container.scrollLeft + screenLeft,
      containerTop: screenRect.top - containerRect.top + container.scrollTop + screenTop,
      cellWidth,
      cellHeight,
    };
  };

  // 清除 CSS 级 IME 锁定；提交/切换会话时同时丢弃旧输入行，普通重绘失败则只撤销当前视觉锁定。
  const clearTerminalImePromptAnchor = (clearCachedRow = true) => {
    if (clearCachedRow) {
      terminalPromptRowCacheRef.current = null;
    }
    const terminalElement = terminalRef.current?.element;
    if (!terminalElement) {
      return;
    }
    terminalElement.classList.remove('is-claude-ime-prompt-anchored');
    for (const property of [
      '--terminal-ime-anchor-left',
      '--terminal-ime-anchor-top',
      '--terminal-ime-anchor-width',
      '--terminal-ime-anchor-height',
    ]) {
      terminalElement.style.removeProperty(property);
    }
  };

  // 输入法候选框跟随隐藏 textarea；CSS 变量配合 !important 锁住坐标，阻止 xterm 的真实状态栏 cursor 抢回位置。
  const syncTerminalImeCompositionAnchor = () => {
    if (!anchorImeToPromptForSessionRef.current) {
      clearTerminalImePromptAnchor();
      return;
    }

    const terminal = terminalRef.current;
    const textarea = terminal?.element?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    const compositionView = terminal?.element?.querySelector<HTMLElement>('.composition-view');
    const anchor = resolveTerminalPromptAnchor();
    if (!terminal || !terminal.element || !textarea || !compositionView || !anchor) {
      clearTerminalImePromptAnchor(false);
      return;
    }

    const left = `${anchor.screenLeft}px`;
    const top = `${anchor.screenTop}px`;
    const height = `${anchor.cellHeight}px`;
    const compositionWidth = terminalImeComposingRef.current
      ? compositionView.getBoundingClientRect().width
      : 0;
    terminal.element.style.setProperty('--terminal-ime-anchor-left', left);
    terminal.element.style.setProperty('--terminal-ime-anchor-top', top);
    terminal.element.style.setProperty('--terminal-ime-anchor-width', `${Math.max(anchor.cellWidth, compositionWidth || 1)}px`);
    terminal.element.style.setProperty('--terminal-ime-anchor-height', height);
    terminal.element.classList.add('is-claude-ime-prompt-anchored');
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

  const hideTerminalContrastCursor = () => {
    const cursor = terminalContrastCursorRef.current;
    if (cursor) {
      cursor.style.display = 'none';
    }
  };

  // 所有 TUI 都以 xterm 的真实 buffer cursor 为唯一位置来源；Codex 额外过滤输入区外的重绘中间坐标。
  const syncTerminalContrastCursor = () => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    const cursor = terminalContrastCursorRef.current;
    const screen = terminal?.element?.querySelector<HTMLElement>('.xterm-screen');
    const useManagedCursor = useManagedCursorForSessionRef.current;
    const terminalHasFocus = Boolean(terminal?.element?.classList.contains('focus'));
    if (
      !terminal ||
      !container ||
      !cursor ||
      !screen ||
      !canAcceptTerminalInput(sessionRef.current) ||
      hideLocalCursorForSessionRef.current ||
      (!useManagedCursor && terminalRemoteCursorHiddenRef.current) ||
      (useManagedCursor && terminalManagedCursorSuppressedRef.current) ||
      !terminalHasFocus ||
      terminal.cols <= 0 ||
      terminal.rows <= 0
    ) {
      hideTerminalContrastCursor();
      return;
    }

    const buffer = terminal.buffer.active;
    const absoluteCursorRow = buffer.baseY + buffer.cursorY;
    const visibleCursorRow = absoluteCursorRow - buffer.viewportY;
    if (visibleCursorRow < 0 || visibleCursorRow >= terminal.rows) {
      hideTerminalContrastCursor();
      return;
    }

    // Codex 绘制状态栏时 buffer cursor 会短暂落到状态栏末尾；输入框仍存在时持续隐藏原生层，
    // 只有最终 cursor 回到提示符及其软换行组内才显示替代光标，从根源上消除中间帧闪烁。
    const promptAnchor = useManagedCursor ? resolveTerminalPromptAnchor() : undefined;
    if (
      useManagedCursor &&
      (!promptAnchor || absoluteCursorRow < promptAnchor.promptStartRow || absoluteCursorRow > promptAnchor.promptEndRow)
    ) {
      hideTerminalContrastCursor();
      return;
    }

    const cursorColumn = Math.min(Math.max(buffer.cursorX, 0), terminal.cols - 1);
    const line = buffer.getLine(absoluteCursorRow);
    const cursorCell = line?.getCell(cursorColumn);
    const background = resolveTerminalCellVisualBackgroundRgb(
      cursorCell,
      terminalThemeRef.current,
      terminalBackgroundColorRef.current,
    );
    const nativeCursorColor = terminalCursorColorRef.current;
    if (
      !useManagedCursor &&
      background &&
      nativeCursorColor &&
      resolveTerminalColorContrastRatio(background, nativeCursorColor) >= terminalCursorMinimumContrastRatio
    ) {
      hideTerminalContrastCursor();
      return;
    }

    const screenRect = screen.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const cellWidth = screenRect.width / terminal.cols;
    const cellHeight = screenRect.height / terminal.rows;
    if (cellWidth <= 0 || cellHeight <= 0) {
      hideTerminalContrastCursor();
      return;
    }

    const blackCursor: TerminalRgbColor = { red: 17, green: 24, blue: 39 };
    const whiteCursor: TerminalRgbColor = { red: 248, green: 250, blue: 252 };
    const useDarkCursor = !background || resolveTerminalColorContrastRatio(background, blackCursor)
      >= resolveTerminalColorContrastRatio(background, whiteCursor);
    const cursorColor = useDarkCursor ? '#111827' : '#f8fafc';
    const outlineColor = useDarkCursor ? 'rgba(248, 250, 252, 0.9)' : 'rgba(17, 24, 39, 0.9)';
    const cursorWidth = Math.max(2, Math.min(3, cellWidth * 0.18));
    // 下限保证小字号下光标仍可见，但绝不超过行高本身，否则会溢出到相邻行。
    const cursorHeight = Math.max(Math.min(10, cellHeight), cellHeight * 0.78);
    const cursorLeft = screenRect.left - containerRect.left + container.scrollLeft + cursorColumn * cellWidth;
    const cursorTop = screenRect.top - containerRect.top + container.scrollTop + visibleCursorRow * cellHeight;
    const maxLeft = Math.max(0, container.scrollWidth - cursorWidth);

    cursor.style.display = 'block';
    cursor.style.left = `${Math.min(cursorLeft, maxLeft)}px`;
    cursor.style.top = `${cursorTop + (cellHeight - cursorHeight) / 2}px`;
    cursor.style.width = `${cursorWidth}px`;
    cursor.style.height = `${cursorHeight}px`;
    cursor.style.background = cursorColor;
    cursor.style.boxShadow = `0 0 0 1px ${outlineColor}`;
  };

  const scheduleTerminalContrastCursorSync = () => {
    if (terminalContrastCursorFrameRef.current !== null) {
      return;
    }

    terminalContrastCursorFrameRef.current = window.requestAnimationFrame(() => {
      terminalContrastCursorFrameRef.current = null;
      syncTerminalContrastCursor();
    });
  };

  // 提交后立即暂停 Codex 光标；普通编辑、取消或方向键则开启短暂保护期，保证交互时光标即时可见。
  const updateTerminalManagedCursorForInput = (inputAction: 'submit' | 'cancel' | 'edit') => {
    if (!useManagedCursorForSessionRef.current) {
      return;
    }
    if (terminalManagedCursorOutputIdleTimerRef.current !== null) {
      window.clearTimeout(terminalManagedCursorOutputIdleTimerRef.current);
      terminalManagedCursorOutputIdleTimerRef.current = null;
    }
    terminalManagedCursorInputGraceUntilRef.current = inputAction === 'submit'
      ? 0
      : performance.now() + terminalManagedCursorInputGraceMs;
    terminalManagedCursorSuppressedRef.current = inputAction === 'submit';
    scheduleTerminalContrastCursorSync();
  };

  // Codex 流式帧持续到达时保持光标暂停；输出稳定后恢复输入区光标，空输入框无需等到首次按键才出现。
  const updateTerminalManagedCursorForOutput = () => {
    if (!useManagedCursorForSessionRef.current) {
      return;
    }
    if (terminalManagedCursorOutputIdleTimerRef.current !== null) {
      window.clearTimeout(terminalManagedCursorOutputIdleTimerRef.current);
    }
    if (performance.now() >= terminalManagedCursorInputGraceUntilRef.current) {
      terminalManagedCursorSuppressedRef.current = true;
      scheduleTerminalContrastCursorSync();
    }
    terminalManagedCursorOutputIdleTimerRef.current = window.setTimeout(() => {
      terminalManagedCursorOutputIdleTimerRef.current = null;
      if (!useManagedCursorForSessionRef.current) {
        return;
      }
      // 最后一帧稳定后由输入框锚点继续校验位置；这里只结束输出抑制，确保空提示行也能显示稳定光标。
      terminalManagedCursorSuppressedRef.current = false;
      terminalManagedCursorInputGraceUntilRef.current = 0;
      scheduleTerminalContrastCursorSync();
    }, terminalManagedCursorOutputIdleMs);
  };

  // 右键菜单动作完成后延后一帧恢复焦点，确保 React 已经卸载菜单按钮。
  const restoreTerminalFocusAfterContextMenuAction = () => {
    // 右键菜单按钮会短暂拿走焦点；等待菜单卸载后再聚焦 xterm，避免复制/粘贴后键盘输入停在旧光标状态。
    window.requestAnimationFrame(() => {
      focusTerminalInput();
    });
  };

  // 会话切换或缓存重放前只回收 marker（定位信息），不触碰按会话持久保存的稳定行号与时间线。
  const {
    finishTerminalGutterReplay,
    registerTerminalGutterLine,
    resetTerminalGutterMarkers,
    scheduleTerminalGutterSync,
  } = useTerminalGutterController({
    containerRef,
    gutterShowLineNumberRef,
    gutterShowTimestampRef,
    scheduleTerminalSizeSync: () => scheduleTerminalSizeSyncRef.current(),
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
  });

  // 本地键盘输入和粘贴会触发行编辑回显；记录时间后，后续短时间内的光标移动才允许自动横向跟随。
  const markLocalTerminalInputForCursorFollow = () => {
    lastLocalTerminalInputAtRef.current = performance.now();
  };

  // 只有主缓冲区承载 Shell 行编辑；alternate buffer 中的 top/vim/less 按键不能伪装成长命令输入。
  const isTerminalShellInputBufferActive = () =>
    terminalRef.current?.buffer.active.type === 'normal';

  // 远端程序定时刷新也会移动 xterm 光标；超过本地输入窗口后不再把它视为需要跟随的编辑光标。
  const hasRecentLocalTerminalInputForCursorFollow = () =>
    performance.now() - lastLocalTerminalInputAtRef.current <= terminalCursorFollowAfterInputMs;

  // 长行布局控制器集中维护按会话高水位、扩列证据和光标跟随帧；工作区只调用布局用例。
  const {
    applyTerminalLayoutSize,
    disposeTerminalLayoutController,
    resolveTerminalLayoutSize,
    scheduleTerminalCursorFollow,
    terminalHorizontalContentColsBySessionRef,
    terminalHorizontalContentColsRef,
    terminalHorizontalFullBufferMeasurePendingRef,
    terminalHorizontalOverflowEvidenceRef,
    terminalHorizontalPostShrinkCeilingRef,
  } = useTerminalLayoutController({
    containerRef,
    fitAddonRef,
    hasRecentLocalTerminalInputForCursorFollow,
    scheduleTerminalSizeSync: () => scheduleTerminalSizeSyncRef.current(),
    sessionRef,
    setTerminalHasHorizontalOverflow,
    syncTerminalAuxiliaryLayerSizes,
    terminalActiveReplayRef,
    terminalLineWrapModeRef,
    terminalLocalInputEditingRef,
    terminalRef,
  });

  // 会话级渲染选项必须先于缓存重放生效，保证切换普通终端和 AI TUI 时滚屏历史策略一致。
  const applyTerminalSessionBehaviorOptions = () => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    // Codex 从启动加载起就完全托管光标，避免输入框尚未出现时 xterm 原生光标在重绘位置闪烁；切出后立即恢复。
    const useManagedCursor = useManagedCursorForSessionRef.current;
    terminal.element?.classList.toggle('is-managed-tui-cursor-active', useManagedCursor);
    terminalContrastCursorRef.current?.classList.toggle('is-managed-tui-cursor', useManagedCursor);
    // xterm 会动态注入光标动画，不能只靠外层 CSS 隐藏；渲染选项同步禁用 Codex 原生闪烁作为第二层兜底。
    if (terminal.options.cursorBlink === useManagedCursor) {
      terminal.options.cursorBlink = !useManagedCursor;
    }

    if (terminal.options.scrollback !== terminalScrollbackRowsRef.current) {
      terminal.options.scrollback = terminalScrollbackRowsRef.current;
    }
    if (terminal.options.minimumContrastRatio !== terminalMinimumContrastRatioRef.current) {
      terminal.options.minimumContrastRatio = terminalMinimumContrastRatioRef.current;
    }
  };

  // 远端悬空隐藏光标的自愈:输出空闲后,若仍处于 Shell 主缓冲区且光标被判定为隐藏,补发一次显示序列。
  const recoverTerminalCursorIfStuck = () => {
    const terminal = terminalRef.current;
    if (
      !terminal
      || terminalActiveReplayRef.current                   // 重放期不介入
      || !canAcceptTerminalInput(sessionRef.current)       // 只处理可交互会话
      || isAiAgentTerminalSessionRef.current               // AI TUI 自行管理光标显隐，宿主不能在忙碌态强行显示
      || hideLocalCursorForSessionRef.current              // 已确认自绘光标的 TUI 保持宿主级隐藏
      || !isTerminalShellInputBufferActive()               // 仅主缓冲区(排除 top/vim/less)
      || !terminalRemoteCursorHiddenRef.current             // 仅在确实隐藏时补写
    ) {
      return;
    }
    terminal.write(terminalCursorShowSequence);
    terminalRemoteCursorHiddenRef.current = false;
  };

  // 每来一块输出重置计时;输出真正停止 idle 时长后才触发自愈检查,避免高频进度帧期间误触发。
  const scheduleTerminalCursorRecovery = () => {
    if (terminalCursorRecoveryTimerRef.current !== null) {
      window.clearTimeout(terminalCursorRecoveryTimerRef.current);
    }
    terminalCursorRecoveryTimerRef.current = window.setTimeout(() => {
      terminalCursorRecoveryTimerRef.current = null;
      recoverTerminalCursorIfStuck();
    }, terminalCursorRecoveryIdleMs);
  };

  // 设置切换或会话切换后重放当前会话缓存，让已显示内容立即按新的列宽重新排版。
  const replayCurrentSessionOutput = () => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    const replaySessionId = sessionRef.current?.id;
    const replayState: TerminalReplayState = {
      generation: terminalReplayGenerationRef.current + 1,
      sessionId: replaySessionId,
    };
    terminalReplayGenerationRef.current = replayState.generation;
    terminalActiveReplayRef.current = replayState;
    terminalReplayDeferredOutputRef.current = { ...replayState, entries: [] };
    terminalGutterReplayActiveRef.current = Boolean(replaySessionId);
    const wasImeComposing = terminalImeComposingRef.current;
    // 先关闭 stdin 再暂时放行 blur/compositionend，让 xterm 清掉旧会话组合态；其延迟 finalize 仍会被 activeReplay 丢弃。
    terminal.options.disableStdin = true;
    setTerminalReplayInputBlocked(false);
    terminal.blur();
    terminalImeComposingRef.current = false;
    clearTerminalImePromptAnchor();
    if (terminalImeCompositionFrameRef.current !== null) {
      // blur 的 compositionend 可能排过一次旧锚点刷新；切换会话后必须取消，避免它用旧画面重新定位新 textarea。
      window.cancelAnimationFrame(terminalImeCompositionFrameRef.current);
      terminalImeCompositionFrameRef.current = null;
    }

    const startReplayBarrier = () => {
      const scheduledReplay = terminalActiveReplayRef.current;
      if (
        !scheduledReplay
        || scheduledReplay.generation !== replayState.generation
        || scheduledReplay.sessionId !== replayState.sessionId
        || sessionRef.current?.id !== replayState.sessionId
      ) {
        return;
      }
      setTerminalReplayInputBlocked(true);
      // 空 write 充当 FIFO 屏障：xterm reset 不会取消旧输入，必须等上一会话的待解析块完成后才能清屏重放新会话。
      terminal.write('', () => {
      const activeReplay = terminalActiveReplayRef.current;
      if (
        !activeReplay
        || activeReplay.generation !== replayState.generation
        || activeReplay.sessionId !== replayState.sessionId
        || sessionRef.current?.id !== replayState.sessionId
      ) {
        return;
      }

      clearTerminalSelectionSnapshot();
      applyTerminalSessionBehaviorOptions();
      // 只回收 marker（定位）并清空 buffer，保留按会话持久保存的稳定时间线；重放完成后从末端恢复编号。
      resetTerminalGutterMarkers();
      clearTerminalPromptHighlights();
      terminalGutterReplayNextLogicalNumberRef.current = 1;
      terminal.reset();
      // reset 会恢复 xterm 内部的主题光标色和显示状态；Codex 托管模式必须在重放缓存前立刻重新隐藏，避免 reset 与首个输出块之间漏出原生块光标。
      if (useManagedCursorForSessionRef.current) {
        terminal.write(terminalCursorHideSequence);
      }
      // 同步观测值后，缓存里的 OSC/DECTCEM 会按原顺序重新覆盖；托管模式的自绘光标不依赖该远端显隐值。
      terminalCursorColorRef.current = parseTerminalRgbColor(terminalThemeRef.current.cursor);
      terminalRemoteCursorHiddenRef.current = useManagedCursorForSessionRef.current;
      const nextLayoutSize = resolveTerminalLayoutSize();
      if (nextLayoutSize) {
        applyTerminalLayoutSize(nextLayoutSize);
      }
      // 为会话首行（row0，从不触发 onLineFeed）登记初始 marker；始终登记以保证第一条逻辑行也可定位。
      registerTerminalGutterLine();
      const deferredBeforeSnapshot = terminalReplayDeferredOutputRef.current;
      if (
        deferredBeforeSnapshot?.generation === replayState.generation
        && deferredBeforeSnapshot.sessionId === replayState.sessionId
      ) {
        // 屏障前到达的实时块已经进入 outputCache，将由本次快照统一重放，不能再作为 deferred 重复写入。
        deferredBeforeSnapshot.entries = [];
      }
      const replayEntries = replaySessionId
        ? outputCacheRef.current.replayEntries(replaySessionId)
        : [];

      // 同一尺寸的相邻分片作为一组送入 xterm；组间等待 write FIFO 落地后再 resize，严格复现输出生成时的 PTY 几何。
      // 如果先按当前窗口一次性解析，scp 的 CR 覆盖帧可能因软换行而把每次进度刷新永久变成一条新行。
      const writeReplayEntries = (entries: TerminalReplayEntry[], onComplete: () => void) => {
        let nextEntryIndex = 0;
        const writeNextSizeGroup = () => {
          if (
            terminalReplayGenerationRef.current !== replayState.generation
            || sessionRef.current?.id !== replayState.sessionId
          ) {
            return;
          }
          if (nextEntryIndex >= entries.length) {
            onComplete();
            return;
          }

          const firstEntry = entries[nextEntryIndex];
          if (terminal.cols !== firstEntry.cols || terminal.rows !== firstEntry.rows) {
            terminal.resize(firstEntry.cols, firstEntry.rows);
          }
          let groupEnd = nextEntryIndex + 1;
          while (
            groupEnd < entries.length
            && entries[groupEnd].cols === firstEntry.cols
            && entries[groupEnd].rows === firstEntry.rows
          ) {
            groupEnd += 1;
          }

          for (let index = nextEntryIndex; index < groupEnd; index += 1) {
            terminal.write(entries[index].content, index === groupEnd - 1 ? () => {
              nextEntryIndex = groupEnd;
              writeNextSizeGroup();
            } : undefined);
          }
        };
        writeNextSizeGroup();
      };
      const finishReplay = () => {
        if (!finishTerminalGutterReplay(Date.now(), replayState)) {
          return;
        }

        // 历史解析已结束，先恢复 xterm 自动协议回包；DOM 捕获层仍阻止真实用户输入，直到 deferred 全部落屏。
        terminal.options.disableStdin = !canAcceptTerminalInput(sessionRef.current);

        const runReplayVisualCompletion = () => {
          if (
            terminalReplayGenerationRef.current !== replayState.generation
            || sessionRef.current?.id !== replayState.sessionId
          ) {
            return;
          }
          // 重放和期间积累的实时块全部落屏后再测量，避免按半帧 buffer 扩列或刷新覆盖层。
          setTerminalReplayInputBlocked(false);
          terminal.options.disableStdin = !canAcceptTerminalInput(sessionRef.current);
          terminalHorizontalFullBufferMeasurePendingRef.current = true;
          scheduleTerminalSizeSync();
          syncLocalCursorVisibility();
          scheduleTerminalCursorFollow();
          scheduleTerminalMatchHighlightRefresh();
          scheduleTerminalPromptHighlightRefresh();
          scheduleTerminalSelectionOverlaySync();
          scheduleTerminalContrastCursorSync();
          scheduleTerminalVerticalScrollbarSync();
          scheduleTerminalGutterSync();
          window.requestAnimationFrame(focusPendingTerminalInput);
        };
        // 分尺寸组写入需要等待上一组解析后才能 resize；期间新到实时块继续进入 deferred，循环排空后才能开放输入。
        const flushDeferredEntries = () => {
          const deferredOutput = terminalReplayDeferredOutputRef.current;
          const deferredEntries = deferredOutput?.generation === replayState.generation
            && deferredOutput.sessionId === replayState.sessionId
            ? deferredOutput.entries.splice(0)
            : [];
          if (deferredEntries.length > 0) {
            writeReplayEntries(deferredEntries, flushDeferredEntries);
            return;
          }
          if (deferredOutput?.generation === replayState.generation) {
            terminalReplayDeferredOutputRef.current = null;
          }
          runReplayVisualCompletion();
        };
        flushDeferredEntries();
      };
      if (replayEntries.length > 0) {
        writeReplayEntries(replayEntries, finishReplay);
        return;
      }

      finishReplay();
      });
    };

    if (wasImeComposing) {
      // xterm 在 compositionend 后用 0ms 定时器提取最终文本；下一轮任务再启动屏障，确保其内部组合态先完整复位。
      window.setTimeout(startReplayBarrier, 0);
    } else {
      startReplayBarrier();
    }
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
    const targetSessionId = sessionRef.current?.id;
    if (
      terminalActiveReplayRef.current
      || terminalReplayInputBlockedRef.current
      || !targetSessionId
      || !canAcceptTerminalInput(sessionRef.current)
    ) {
      if (restoreFocusAfterPaste) {
        restoreTerminalFocusAfterContextMenuAction();
      }
      return;
    }

    try {
      // 右键粘贴直接走终端输入通道，保持和键盘粘贴完全一致的后端写入路径。
      const text = await readClipboardText().catch(() => '');
      // 系统剪贴板读取是异步的；期间若已切换会话或开始重放，旧粘贴必须丢弃，不能落到新标签。
      if (
        text
        && sessionRef.current?.id === targetSessionId
        && !terminalActiveReplayRef.current
        && !terminalReplayInputBlockedRef.current
      ) {
        clearTerminalSelectionSnapshot();
        markLocalTerminalInputForCursorFollow();
        terminalLocalInputEditingRef.current =
          isTerminalShellInputBufferActive() && !text.includes('\r') && !text.includes('\n');
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
    scheduleTerminalContrastCursorSync();
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
  // 每次渲染都刷新桥接函数，使行号控制器始终使用当前设置与会话状态计算终端尺寸。
  scheduleTerminalSizeSyncRef.current = scheduleTerminalSizeSync;

  useEffect(() => {
    if (!containerRef.current || terminalRef.current) {
      return;
    }

    // 终端实例只初始化一次；主题、字体和背景图后续通过 options 更新，避免设置视觉项时清空当前会话画面。
    const terminal = new Terminal({
      allowTransparency: true,
      // 交互 SSH PTY 必须保留远端原始 CR/LF 与 ANSI 行编辑序列；convertEol 会破坏长行历史重绘。
      convertEol: false,
      cursorBlink: !useManagedCursorForSessionRef.current,
      disableStdin: !canAcceptTerminalInput(sessionRef.current),
      fontFamily: terminalFontFamily,
      fontSize: settings.shellFontSize,
      letterSpacing: 0,
      // 行高来自设置；xterm 对小于 1 的行高会直接抛错，异常配置由 normalizer 兜底后再兜一层。
      lineHeight: settings.shellLineHeight ?? 1.18,
      minimumContrastRatio: terminalMinimumContrastRatioRef.current,
      scrollback: terminalScrollbackRows,
      theme: terminalTheme,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    // 首帧输出前就隐藏 Codex 原生光标，加载画面不能先漏出一次 xterm 默认闪烁光标。
    terminal.element?.classList.toggle('is-managed-tui-cursor-active', useManagedCursorForSessionRef.current);
    // deferred 解析期需要开放 xterm 的自动协议回复，但键盘、IME、粘贴、鼠标和焦点上报都必须在捕获阶段阻断。
    const replayBlockedInputEventNames = [
      'keydown',
      'beforeinput',
      'input',
      'paste',
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'pointerdown',
      'pointermove',
      'pointerup',
      'mousedown',
      'mousemove',
      'mouseup',
      'click',
      'dblclick',
      'contextmenu',
      'wheel',
      'touchstart',
      'touchmove',
      'touchend',
      'focus',
      'focusin',
      'blur',
      'focusout',
    ] as const;
    const blockUserInputDuringReplay = (event: Event) => {
      if (!terminalReplayInputBlockedRef.current) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === 'focus' || event.type === 'focusin') {
        // focus 事件发生时元素已取得焦点；立即 blur，且同一捕获层会吞掉对应失焦上报。
        terminal.blur();
      }
    };
    replayBlockedInputEventNames.forEach((eventName) => {
      terminal.element?.addEventListener(eventName, blockUserInputDuringReplay, true);
    });
    // 实时输出状态机已经按原会话回包；xterm parser 这里只消费查询，缓存重放不得再次触发任何响应。
    const xtVersionDisposable = terminal.parser.registerCsiHandler({ prefix: '>', final: 'q' }, () => true);
    // 识别远端私有模式 25（DECTCEM）；普通会话继续交给 xterm，Codex 托管模式则在解析阶段阻止原生光标被重新显示。
    const paramsIncludeCursorMode = (params: (number | number[])[]) =>
      params.some((value) => (Array.isArray(value) ? value.includes(25) : value === 25));
    // 只有纯 ?25h 才能安全整条消费；组合 DECSET 还可能携带 alternate buffer 等模式，必须继续交给 xterm 完整处理。
    const paramsOnlyIncludeCursorMode = (params: (number | number[])[]) =>
      params.length > 0 && params.every((value) => (
        Array.isArray(value)
          ? value.length > 0 && value.every((nestedValue) => nestedValue === 25)
          : value === 25
      ));
    const cursorHideObserverDisposable = terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      if (paramsIncludeCursorMode(params)) {
        terminalRemoteCursorHiddenRef.current = true;
        scheduleTerminalContrastCursorSync();
      }
      return false;
    });
    const cursorShowObserverDisposable = terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (paramsIncludeCursorMode(params)) {
        terminalRemoteCursorHiddenRef.current = false;
        scheduleTerminalContrastCursorSync();
      }
      // Codex 会在加载和等待回复的重绘帧反复发送 ?25h；在 xterm 绘制前消费它，彻底消除提示文字首字符上的块光标闪烁。
      return useManagedCursorForSessionRef.current && paramsOnlyIncludeCursorMode(params);
    });
    // parser 注册完成后立即从协议层隐藏首帧原生光标；后续 Codex 的单独 ?25h 会由上面的 handler 持续拦截。
    if (useManagedCursorForSessionRef.current) {
      terminal.write(terminalCursorHideSequence);
    }
    // OSC 12 是 TUI 设置原生光标色的标准通道；只观测其最终颜色并继续交给 xterm 处理，绝不吞掉程序自身协议。
    const cursorColorObserverDisposable = terminal.parser.registerOscHandler(12, (data) => {
      const normalizedColor = data.trim();
      if (normalizedColor !== '?') {
        terminalCursorColorRef.current = normalizedColor.toLowerCase() === 'default'
          ? parseTerminalRgbColor(terminalThemeRef.current.cursor)
          : parseTerminalOscRgbColor(normalizedColor);
        scheduleTerminalContrastCursorSync();
      }
      return false;
    });
    // OSC 112 恢复主题默认光标色；同步清除上一个 TUI 留下的颜色，避免后续 Shell 沿用错误判断。
    const cursorColorResetObserverDisposable = terminal.parser.registerOscHandler(112, () => {
      terminalCursorColorRef.current = parseTerminalRgbColor(terminalThemeRef.current.cursor);
      scheduleTerminalContrastCursorSync();
      return false;
    });
    // Codex 可通过 DECSCUSR 在任意帧恢复闪烁光标；托管会话吞掉该序列并只保留对应的稳态形状。
    const cursorStyleObserverDisposable = terminal.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
      if (!useManagedCursorForSessionRef.current) {
        return false;
      }
      const firstParam = params[0];
      const cursorStyleParam = Array.isArray(firstParam) ? firstParam[0] : firstParam;
      const steadyCursorStyle = cursorStyleParam === 1 || cursorStyleParam === 2
        ? 'block'
        : cursorStyleParam === 3 || cursorStyleParam === 4
          ? 'underline'
          : cursorStyleParam === 5 || cursorStyleParam === 6
            ? 'bar'
            : undefined;
      terminal.options.cursorBlink = false;
      if (steadyCursorStyle) {
        terminal.options.cursorStyle = steadyCursorStyle;
      }
      scheduleTerminalContrastCursorSync();
      return true;
    });
    // 精确放行 Windows 本地 Claude 的 Ctrl+V 浏览器默认行为：xterm 随后接收可信 paste 事件并负责
    // bracketed-paste/换行规范化；返回 false 只阻止它把该按键编码成 \x16，不能手动再读一次剪贴板。
    terminal.attachCustomKeyEventHandler((event) => {
      if (terminalActiveReplayRef.current || terminalReplayInputBlockedRef.current) {
        return false;
      }
      const useNativeClipboardPaste =
        event.type === 'keydown' &&
        event.code === 'KeyV' &&
        event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        isWindowsTerminalHost() &&
        canAcceptTerminalInput(sessionRef.current) &&
        shouldUseNativeCtrlVPaste(sessionRef.current);
      if (event.type === 'keydown' && !['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
        // 直接依据浏览器键盘事件判断提交，兼容 Codex 启用 Kitty/CSI-u 后 Enter 不再编码为 CR/LF 的情况。
        const submitsManagedInput = event.key === 'Enter' && !event.shiftKey && !event.isComposing;
        const cancelsManagedInput = event.key === 'Escape'
          || (event.ctrlKey && ['c', 'd'].includes(event.key.toLowerCase()));
        updateTerminalManagedCursorForInput(
          submitsManagedInput ? 'submit' : cancelsManagedInput ? 'cancel' : 'edit',
        );
        markLocalTerminalInputForCursorFollow();
        const abandonsOrSubmitsInput =
          event.key === 'Enter'
          || (event.ctrlKey && ['c', 'd', 'u'].includes(event.key.toLowerCase()));
        if (abandonsOrSubmitsInput || terminal.buffer.active.type !== 'normal') {
          terminalLocalInputEditingRef.current = false;
        } else {
          // 方向键、PageUp、F1 等只能延续已有编辑，不能让 top/vim 的控制键绕过宽度响应抑制。
          const canGrowInputLine =
            event.isComposing
            || event.key === 'Process'
            || event.key === 'Tab'
            || (event.key.length === 1 && !event.ctrlKey && !event.metaKey);
          if (canGrowInputLine) {
            terminalLocalInputEditingRef.current = true;
          }
        }
      }
      return !useNativeClipboardPaste;
    });
    const promptHighlightOverlay = document.createElementNS(terminalHighlightSvgNamespace, 'svg');
    promptHighlightOverlay.classList.add('terminal-prompt-line-overlay');
    containerRef.current.appendChild(promptHighlightOverlay);
    terminalPromptHighlightOverlayRef.current = promptHighlightOverlay;
    const matchOverlay = document.createElementNS(terminalHighlightSvgNamespace, 'svg');
    matchOverlay.classList.add('terminal-match-rounded-overlay');
    containerRef.current.appendChild(matchOverlay);
    terminalMatchOverlayRef.current = matchOverlay;
    const selectionOverlay = document.createElementNS(terminalHighlightSvgNamespace, 'svg');
    selectionOverlay.classList.add('terminal-selection-rounded-overlay');
    containerRef.current.appendChild(selectionOverlay);
    terminalSelectionOverlayRef.current = selectionOverlay;
    const contrastCursor = document.createElement('div');
    contrastCursor.classList.add('terminal-contrast-cursor');
    contrastCursor.classList.toggle('is-managed-tui-cursor', useManagedCursorForSessionRef.current);
    containerRef.current.appendChild(contrastCursor);
    terminalContrastCursorRef.current = contrastCursor;
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
    const handleTerminalFocusVisibilityChange = () => scheduleTerminalContrastCursorSync();
    terminal.element?.addEventListener('focusin', handleTerminalFocusVisibilityChange);
    terminal.element?.addEventListener('focusout', handleTerminalFocusVisibilityChange);
    const handleTerminalCompositionStart = () => {
      if (terminalActiveReplayRef.current || terminalReplayInputBlockedRef.current) {
        return;
      }
      terminalImeComposingRef.current = true;
      terminalLocalInputEditingRef.current = terminal.buffer.active.type === 'normal';
      updateTerminalManagedCursorForInput('edit');
      markLocalTerminalInputForCursorFollow();
      // xterm 的监听器先按真实状态栏 cursor 写坐标；同一事件内立即纠偏，Windows 才不会用错误旧位置弹候选窗。
      syncTerminalImeCompositionAnchor();
      scheduleTerminalImeCompositionAnchorSync();
    };
    const handleTerminalCompositionUpdate = () => {
      if (terminalActiveReplayRef.current || terminalReplayInputBlockedRef.current) {
        return;
      }
      terminalImeComposingRef.current = true;
      terminalLocalInputEditingRef.current = terminal.buffer.active.type === 'normal';
      updateTerminalManagedCursorForInput('edit');
      markLocalTerminalInputForCursorFollow();
      syncTerminalImeCompositionAnchor();
      scheduleTerminalImeCompositionAnchorSync();
    };
    const handleTerminalCompositionEnd = () => {
      if (terminalReplayInputBlockedRef.current || !terminalImeComposingRef.current) {
        return;
      }
      terminalImeComposingRef.current = false;
      terminalLocalInputEditingRef.current = terminal.buffer.active.type === 'normal';
      updateTerminalManagedCursorForInput('edit');
      markLocalTerminalInputForCursorFollow();
      // 首词结束后继续把隐藏 textarea 留在输入行，第二次 compositionstart 不再从最右侧错误位置起步。
      syncTerminalImeCompositionAnchor();
      scheduleTerminalImeCompositionAnchorSync();
    };
    const handleTerminalPaste = () => {
      if (terminalActiveReplayRef.current || terminalReplayInputBlockedRef.current) {
        return;
      }
      terminalLocalInputEditingRef.current = terminal.buffer.active.type === 'normal';
      updateTerminalManagedCursorForInput('edit');
      markLocalTerminalInputForCursorFollow();
    };
    textarea?.addEventListener('compositionstart', handleTerminalCompositionStart);
    textarea?.addEventListener('compositionupdate', handleTerminalCompositionUpdate);
    textarea?.addEventListener('compositionend', handleTerminalCompositionEnd);
    textarea?.addEventListener('paste', handleTerminalPaste);

    const dataDisposable = terminal.onData((data) => {
      // 缓存重放会重新解析 DA/DSR/DECRQM 等历史查询；期间产生的自动回复和偶发键盘输入都不能写进当前活 PTY。
      if (canAcceptTerminalInput(sessionRef.current) && !terminalActiveReplayRef.current) {
        // bracketed paste 中的换行只扩展输入框；非 bracketed 的 CR/LF 会被 TUI 当作提交，必须结束旧锚点。
        const isBracketedPaste =
          data.startsWith(terminalBracketedPasteStartSequence) &&
          data.endsWith(terminalBracketedPasteEndSequence);
        const submittedInput = !isBracketedPaste && (data.includes('\r') || data.includes('\n'));
        if (data === '\x03' || submittedInput) {
          clearTerminalImePromptAnchor();
        }
        clearTerminalSelectionSnapshot();
        onTerminalDataRef.current(data);
        scheduleTerminalCursorFollow();
        scheduleTerminalContrastCursorSync();
      }
    });
    const cursorMoveDisposable = terminal.onCursorMove(() => {
      scheduleTerminalCursorFollow();
      scheduleTerminalImeCompositionAnchorSync();
      scheduleTerminalContrastCursorSync();
    });
    const renderDisposable = terminal.onRender(() => {
      scheduleTerminalImeCompositionAnchorSync();
      scheduleTerminalContrastCursorSync();
      scheduleTerminalGutterSync();
      scheduleTerminalPromptHighlightRefresh();
    });
    // 每次硬换行落到新行时登记一条逻辑行 marker（仅定位）；始终登记，与开关无关，保证切换显示项后
    // 历史行仍能定位。软换行不触发，天然显示为续行占位。
    const lineFeedDisposable = terminal.onLineFeed(() => {
      registerTerminalGutterLine(Date.now());
    });
    const scrollDisposable = terminal.onScroll(() => {
      // 竖向翻页只能刷新依赖 viewportY 的覆盖层，禁止按当前页最长行 resize；否则会 reflow 出空行并造成页面跳动。
      scheduleTerminalMatchHighlightRefresh();
      scheduleTerminalPromptHighlightRefresh();
      scheduleTerminalSelectionOverlaySync();
      scheduleTerminalImeCompositionAnchorSync();
      scheduleTerminalContrastCursorSync();
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
      scheduleTerminalPromptHighlightRefresh();
      scheduleTerminalSelectionOverlaySync();
      scheduleTerminalImeCompositionAnchorSync();
      scheduleTerminalContrastCursorSync();
      scheduleTerminalVerticalScrollbarSync();
      scheduleTerminalGutterSync();
    });
    const handleTerminalSurfaceScroll = () => {
      scheduleTerminalMatchHighlightRefresh();
      scheduleTerminalPromptHighlightRefresh();
      scheduleTerminalSelectionOverlaySync();
      scheduleTerminalImeCompositionAnchorSync();
      scheduleTerminalContrastCursorSync();
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
    verticalScrollbar.addEventListener('mouseenter', handleTerminalVerticalScrollbarMouseEnter);
    verticalScrollbar.addEventListener('mouseleave', handleTerminalVerticalScrollbarMouseLeave);
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
      // xterm 的 WriteBuffer 可能仍有定时回调；先失效代次和 deferred 状态，旧屏障回调随后只能安全退出。
      terminalReplayGenerationRef.current += 1;
      terminalActiveReplayRef.current = null;
      terminalReplayDeferredOutputRef.current = null;
      setTerminalReplayInputBlocked(false);
      terminalGutterReplayActiveRef.current = false;
      replayBlockedInputEventNames.forEach((eventName) => {
        terminal.element?.removeEventListener(eventName, blockUserInputDuringReplay, true);
      });
      xtVersionDisposable.dispose();
      cursorHideObserverDisposable.dispose();
      cursorShowObserverDisposable.dispose();
      cursorColorObserverDisposable.dispose();
      cursorColorResetObserverDisposable.dispose();
      cursorStyleObserverDisposable.dispose();
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
      textarea?.removeEventListener('paste', handleTerminalPaste);
      terminal.element?.removeEventListener('focusin', handleTerminalFocusVisibilityChange);
      terminal.element?.removeEventListener('focusout', handleTerminalFocusVisibilityChange);
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
      verticalScrollbar.removeEventListener('mouseenter', handleTerminalVerticalScrollbarMouseEnter);
      verticalScrollbar.removeEventListener('mouseleave', handleTerminalVerticalScrollbarMouseLeave);
      gutter.removeEventListener('contextmenu', handleGutterContextMenu);
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      disposeTerminalLayoutController();
      disposeTerminalHighlightController();
      if (terminalImeCompositionFrameRef.current !== null) {
        window.cancelAnimationFrame(terminalImeCompositionFrameRef.current);
        terminalImeCompositionFrameRef.current = null;
      }
      if (terminalContrastCursorFrameRef.current !== null) {
        window.cancelAnimationFrame(terminalContrastCursorFrameRef.current);
        terminalContrastCursorFrameRef.current = null;
      }
      disposeTerminalVerticalScrollbarController();
      if (terminalGutterFrameRef.current !== null) {
        window.cancelAnimationFrame(terminalGutterFrameRef.current);
        terminalGutterFrameRef.current = null;
      }
      if (terminalGutterClockTimerRef.current !== null) {
        window.clearInterval(terminalGutterClockTimerRef.current);
        terminalGutterClockTimerRef.current = null;
      }
      if (terminalCursorRecoveryTimerRef.current !== null) {
        window.clearTimeout(terminalCursorRecoveryTimerRef.current);
        terminalCursorRecoveryTimerRef.current = null;
      }
      if (terminalManagedCursorOutputIdleTimerRef.current !== null) {
        window.clearTimeout(terminalManagedCursorOutputIdleTimerRef.current);
        terminalManagedCursorOutputIdleTimerRef.current = null;
      }
      document.removeEventListener('visibilitychange', handleTerminalGutterVisibilityRefresh);
      terminalImeComposingRef.current = false;
      clearTerminalImePromptAnchor();
      clearTerminalSelectionSnapshot();
      resetTerminalGutterMarkers();
      hideTerminalContrastCursor();
      promptHighlightOverlay.remove();
      matchOverlay.remove();
      selectionOverlay.remove();
      contrastCursor.remove();
      verticalScrollbar.remove();
      gutter.remove();
      terminalPromptHighlightOverlayRef.current = null;
      terminalMatchOverlayRef.current = null;
      terminalSelectionOverlayRef.current = null;
      terminalContrastCursorRef.current = null;
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
      if (!chunk?.sessionId) {
        return;
      }

      // 尺寸元数据由后端在 PTY 初建/resize 真正生效后按输出时序发出；缓存后续分片必须先绑定该几何。
      if (Number.isInteger(chunk.cols) && Number.isInteger(chunk.rows)) {
        outputCacheRef.current.recordTerminalSize(chunk.sessionId, chunk.cols as number, chunk.rows as number);
      }
      if (!chunk.content) {
        return;
      }

      // 只扫描后端实时分片并立刻按原会话回包；缓存重放只经过 xterm parser，因此不会重复响应。
      const queryProgress = countTerminalXtVersionQueries(
        chunk.content,
        terminalXtVersionParserStateBySessionRef.current.get(chunk.sessionId) ?? 0,
      );
      if (queryProgress.state === 0) {
        terminalXtVersionParserStateBySessionRef.current.delete(chunk.sessionId);
      } else {
        terminalXtVersionParserStateBySessionRef.current.set(chunk.sessionId, queryProgress.state);
      }
      let remainingXtVersionReplies = queryProgress.count;
      while (remainingXtVersionReplies > 0) {
        // 每批大小固定，异常远端即使连续查询也不能触发一次巨大的 repeat 分配。
        const replyCount = Math.min(remainingXtVersionReplies, terminalXtVersionReplyBatchSize);
        onTerminalProtocolDataRef.current(
          chunk.sessionId,
          terminalXtVersionResponse.repeat(replyCount),
        );
        remainingXtVersionReplies -= replyCount;
      }

      // 终端输出直接写入 xterm，避免每 80ms 把大字符串塞进 React 状态导致输入、滚动和选区明显卡顿。
      // 原始输出进有界分片缓存：只累加分片、不整体拼接，超限时按会话/全局上限淘汰最旧分片。
      const replayEntry = outputCacheRef.current.append(
        chunk.sessionId,
        chunk.content,
        sessionRef.current?.id === chunk.sessionId,
      );

      if (sessionRef.current?.id === chunk.sessionId) {
        const activeReplay = terminalActiveReplayRef.current;
        const deferredOutput = terminalReplayDeferredOutputRef.current;
        const shouldDeferDuringReplay = Boolean(
          deferredOutput
          && deferredOutput.sessionId === chunk.sessionId
          && deferredOutput.generation === terminalReplayGenerationRef.current
          && (
            activeReplay?.generation === deferredOutput.generation
            || terminalReplayInputBlockedRef.current
          )
        );
        if (shouldDeferDuringReplay && deferredOutput) {
          // 屏障/重放期间只缓存实时块；快照前的块由 replay 覆盖，快照后的块在 finishReplay 后按原顺序补写。
          if (replayEntry) {
            deferredOutput.entries.push(replayEntry);
          }
          return;
        }
        terminalRef.current?.write(chunk.content, () => {
          // 只有 SSH 横向长行会因新内容扩列；wrap 模式的 Claude 流式帧不能每块都插入无意义的布局测量。
          if (terminalLineWrapModeRef.current === 'horizontal') {
            scheduleTerminalSizeSync();
          }
          updateTerminalManagedCursorForOutput();
          syncLocalCursorVisibility();
          scheduleTerminalCursorRecovery();
          scheduleTerminalCursorFollow();
          scheduleTerminalMatchHighlightRefresh();
          scheduleTerminalPromptHighlightRefresh();
          scheduleTerminalSelectionOverlaySync();
          scheduleTerminalImeCompositionAnchorSync();
          scheduleTerminalContrastCursorSync();
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
    for (const sessionId of Object.keys(terminalHorizontalContentColsBySessionRef.current)) {
      if (!live.has(sessionId)) {
        delete terminalHorizontalContentColsBySessionRef.current[sessionId];
      }
    }
    for (const sessionId of terminalXtVersionParserStateBySessionRef.current.keys()) {
      if (!live.has(sessionId)) {
        terminalXtVersionParserStateBySessionRef.current.delete(sessionId);
      }
    }
  }, [liveSessionIds]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    terminal.options.disableStdin = Boolean(terminalActiveReplayRef.current) || !canAcceptTerminalInput(session);
    applyTerminalSessionBehaviorOptions();
    syncLocalCursorVisibility();
    scheduleTerminalContrastCursorSync();
    window.requestAnimationFrame(focusPendingTerminalInput);
  }, [minimumContrastRatioForSession, session?.id, session?.status, terminalScrollbackRows]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    // 字体和终端主题变化才重新测量 xterm；背景图适配/透明度只更新底层图片，不能牵动字符画布缩放。
    terminal.options.fontFamily = terminalFontFamily;
    terminal.options.fontSize = settings.shellFontSize;
    // 行高由 xterm 监听后自动重建画布，自绘高亮依赖同一动画帧重排，不残留旧位置。
    terminal.options.lineHeight = settings.shellLineHeight ?? 1.18;
    terminal.options.letterSpacing = 0;
    terminal.options.theme = terminalTheme;
    terminalCursorColorRef.current = parseTerminalRgbColor(terminalTheme.cursor);
    terminal.clearTextureAtlas();

    window.requestAnimationFrame(() => {
      syncTerminalSizeToRemote();
      scheduleTerminalMatchHighlightRefresh();
      scheduleTerminalPromptHighlightRefresh();
      scheduleTerminalSelectionOverlaySync();
      scheduleTerminalContrastCursorSync();
      scheduleTerminalVerticalScrollbarSync();
    });
  }, [settings.shellFontSize, settings.shellLineHeight, terminalFontFamily, terminalTheme]);

  useEffect(() => {
    if (settings.terminalMatchSelection ?? true) {
      scheduleTerminalMatchHighlightRefresh();
      return;
    }

    clearTerminalMatchOverlay();
  }, [settings.terminalMatchSelection]);

  // 行号栏显示项、字号、行高或会话类型变化后重算宽度并重绘：本地会话整条左栏隐藏（宽度归零），会改变正文列宽，需重新 fit。
  useEffect(() => {
    scheduleTerminalGutterSync();
    scheduleTerminalSizeSync();
  }, [gutterShowLineNumber, gutterShowTimestamp, settings.shellFontSize, settings.shellLineHeight, session?.kind]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    pendingFocusSessionIdRef.current = session?.id ?? null;
    // 会话切换后重放缓存属于历史画面恢复，不能继承上一会话的本地输入跟随状态。
    lastLocalTerminalInputAtRef.current = 0;
    terminalLocalInputEditingRef.current = false;
    // 每个会话独立开始托管光标生命周期，禁止上一 Codex 会话的提交态或 idle 定时器串到新标签。
    if (terminalManagedCursorOutputIdleTimerRef.current !== null) {
      window.clearTimeout(terminalManagedCursorOutputIdleTimerRef.current);
      terminalManagedCursorOutputIdleTimerRef.current = null;
    }
    // Codex 新标签在加载输出稳定前不显示光标；稳定后由输出状态机自动恢复，不要求输入框先出现文字。
    terminalManagedCursorSuppressedRef.current = useManagedCursorForSessionRef.current;
    terminalManagedCursorInputGraceUntilRef.current = 0;
    terminalHorizontalOverflowEvidenceRef.current = null;
    terminalHorizontalPostShrinkCeilingRef.current = null;
    // 恢复目标会话由真实软换行确认的内容高水位，避免上一会话串宽，也避免切回来后历史长行宽度丢失。
    terminalHorizontalContentColsRef.current = session?.id
      ? terminalHorizontalContentColsBySessionRef.current[session.id] ?? 0
      : 0;
    terminalHorizontalFullBufferMeasurePendingRef.current = false;
    hideTerminalContrastCursor();
    remoteTerminalSizeRef.current = null;
    // FIFO 屏障后的重放完成逻辑会按新会话 buffer 推送尺寸；屏障前不能拿上一会话画面测量并 resize 新 PTY。
    replayCurrentSessionOutput();
    window.requestAnimationFrame(() => {
      focusPendingTerminalInput();
      scheduleTerminalContrastCursorSync();
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
    terminalHorizontalContentColsRef.current = 0;
    if (sessionRef.current?.id) {
      delete terminalHorizontalContentColsBySessionRef.current[sessionRef.current.id];
    }
    terminalHorizontalFullBufferMeasurePendingRef.current = false;
    terminalHorizontalOverflowEvidenceRef.current = null;
    terminalHorizontalPostShrinkCeilingRef.current = null;
    // 模式切换触发的是缓存重排，不是用户正在编辑命令，避免切换后按旧光标位置自动横移。
    lastLocalTerminalInputAtRef.current = 0;
    terminalLocalInputEditingRef.current = false;
    window.requestAnimationFrame(() => {
      // 模式切换只按新列宽 resize，交给 xterm 原生 reflow 重排当前缓冲区；绝不能 reset+重放原始缓存，
      // 否则历史翻页时 readline 的原地重绘序列会按新列宽错位，导致翻过的命令全部堆叠残留在屏幕上。
      clearTerminalSelectionSnapshot();
      syncTerminalSizeToRemote();
      scheduleTerminalMatchHighlightRefresh();
      scheduleTerminalPromptHighlightRefresh();
      scheduleTerminalSelectionOverlaySync();
      scheduleTerminalContrastCursorSync();
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
