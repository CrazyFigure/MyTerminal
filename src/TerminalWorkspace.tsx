import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { Terminal, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

import { backend } from './backend';
import { readClipboardText, writeClipboardText } from './clipboard';
import { translate } from './i18n';
import { TerminalOutputCache, type TerminalReplayEntry } from './terminalCache';
import { buildTerminalFontFamily } from './terminalFonts';
import type { AppSettings, TerminalOutputChunk, TerminalSession } from './types';

import {
  buildTerminalBackgroundImageStyle,
  buildTerminalHighlightPath,
  buildTerminalTheme,
  canAcceptTerminalInput,
  clampTerminalNumber,
  cloneTerminalSelectionPosition,
  collectTerminalMatchRanges,
  collectTerminalPromptHighlightMatches,
  countTerminalXtVersionQueries,
  createTerminalHighlightPathElement,
  findTerminalInverseCursorColumn,
  formatTerminalGutterClock,
  formatTerminalHighlightSvgNumber,
  isRemoteHttpImage,
  isTerminalAiAgentSession,
  isWindowsTerminalHost,
  measureTerminalBufferLineContentColumns,
  normalizeTerminalMatchSelection,
  normalizeTerminalSelectionSnapshotText,
  parseTerminalOscRgbColor,
  parseTerminalRgbColor,
  readTerminalSelectionTextFromBuffer,
  resolveTerminalBackgroundImage,
  resolveTerminalCellVisualBackgroundRgb,
  resolveTerminalColorContrastRatio,
  resolveTerminalColors,
  resolveTerminalMatchHighlightColors,
  resolveTerminalMatchRange,
  resolveTerminalMinimumContrastRatio,
  resolveTerminalSelectionLength,
  roundHorizontalColumns,
  shouldAnchorTerminalImeToPrompt,
  shouldHideLocalTerminalCursor,
  shouldUseManagedTerminalCursor,
  shouldUseNativeCtrlVPaste,
  shouldUseSoftDarkBlocks,
  terminalAiAgentScrollbackRows,
  terminalBracketedPasteEndSequence,
  terminalBracketedPasteStartSequence,
  terminalCursorFollowAfterInputMs,
  terminalCursorFollowMarginColumns,
  terminalCursorHideSequence,
  terminalCursorMinimumContrastRatio,
  terminalCursorRecoveryIdleMs,
  terminalCursorShowSequence,
  terminalDefaultScrollbackRows,
  terminalGutterCharWidthRatio,
  terminalGutterFontScale,
  terminalGutterHorizontalPaddingPx,
  terminalGutterMaxTrackedLines,
  terminalGutterMinDigits,
  terminalGutterMinFontSizePx,
  terminalGutterMinWidthPx,
  terminalGutterTimestampCharCount,
  terminalGutterWrappedLineSymbol,
  terminalHighlightCornerRadiusPx,
  terminalHighlightSvgNamespace,
  terminalHorizontalLinePaddingColumns,
  terminalHorizontalMaxColumns,
  terminalManagedCursorInputGraceMs,
  terminalManagedCursorOutputIdleMs,
  terminalMatchHighlightGapPx,
  terminalMatchHighlightMaxRanges,
  terminalMatchHighlightOverscanRows,
  terminalOutputEventName,
  terminalPromptBorderMinCharacters,
  terminalPromptBorderSearchDistanceRows,
  terminalPromptGlyphs,
  terminalPromptHighlightDarkColors,
  terminalPromptHighlightLightColors,
  terminalPromptSearchRows,
  terminalPromptSegmentHorizontalInsetPx,
  terminalPromptSegmentUnderlineHeightPx,
  terminalScrollbarReservePx,
  terminalSelectionHighlightBackground,
  terminalSelectionHighlightBorder,
  terminalSelectionPositionHasRange,
  terminalVerticalScrollbarBottomInsetPx,
  terminalVerticalScrollbarMinThumbHeightPx,
  terminalVerticalScrollbarRevealZonePx,
  terminalVerticalScrollbarTopInsetPx,
  terminalXtVersionReplyBatchSize,
  terminalXtVersionResponse,
  translateTerminalBufferLineWithWrap,
  type TerminalGutterMarkerEntry,
  type TerminalGutterSessionData,
  type TerminalHighlightStrip,
  type TerminalHorizontalOverflowEvidence,
  type TerminalLayoutSize,
  type TerminalMatchDecorationRange,
  type TerminalMatchRange,
  type TerminalPromptAnchor,
  type TerminalPromptRowCache,
  type TerminalReplayDeferredOutput,
  type TerminalReplayState,
  type TerminalRgbColor,
  type TerminalSelectionSnapshot,
  type TerminalVerticalScrollbarDragState,
  type TerminalVerticalScrollbarMetrics,
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
  // 终端原始输出改用有界分片缓存：按会话/全局字节封顶、LRU 淘汰，并绑定后端确认的 PTY 尺寸；
  // 关闭会话时显式回收，既避免长期内存增长，也保证标签切换后动态覆盖行可按原几何重放。
  const outputCacheRef = useRef(new TerminalOutputCache());
  // 提示符命令行覆盖层基于 xterm 已解析缓冲区绘制，因此实时输出、标签切换和缓存重放共用同一条路径。
  const terminalPromptHighlightOverlayRef = useRef<SVGSVGElement | null>(null);
  const terminalPromptHighlightFrameRef = useRef<number | null>(null);
  const terminalMatchOverlayRef = useRef<SVGSVGElement | null>(null);
  const terminalMatchDecorationDisposablesRef = useRef<IDisposable[]>([]);
  const terminalMatchHighlightFrameRef = useRef<number | null>(null);
  const terminalSelectionOverlayRef = useRef<SVGSVGElement | null>(null);
  const terminalSelectionOverlayFrameRef = useRef<number | null>(null);
  const terminalSelectionSnapshotRef = useRef<TerminalSelectionSnapshot | null>(null);
  const terminalSelectionRestoreActiveRef = useRef(false);
  const terminalContrastCursorRef = useRef<HTMLDivElement | null>(null);
  const terminalContrastCursorFrameRef = useRef<number | null>(null);
  // Codex 托管光标只在提交和持续输出期间暂停；输出稳定后即使输入框为空也必须自动恢复。
  const terminalManagedCursorSuppressedRef = useRef(false);
  const terminalManagedCursorInputGraceUntilRef = useRef(0);
  const terminalManagedCursorOutputIdleTimerRef = useRef<number | null>(null);
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
  const terminalReplayGenerationRef = useRef(0);
  const terminalActiveReplayRef = useRef<TerminalReplayState | null>(null);
  const terminalReplayDeferredOutputRef = useRef<TerminalReplayDeferredOutput | null>(null);
  const terminalReplayInputBlockedRef = useRef(false);
  const terminalXtVersionParserStateBySessionRef = useRef(new Map<string, TerminalXtVersionQueryParserState>());
  // 按会话持久保存的逻辑行时间线；切换会话不清空，保证历史时间恒定。
  const terminalGutterSessionDataRef = useRef<Record<string, TerminalGutterSessionData>>({});
  const terminalSelectionDragActiveRef = useRef(false);
  const terminalSelectionDragFrameRef = useRef<number | null>(null);
  const onTerminalDataRef = useRef(onTerminalData);
  const onTerminalProtocolDataRef = useRef(onTerminalProtocolData);
  const sessionRef = useRef<TerminalSession | undefined>(session);
  const resizeFrameRef = useRef<number | null>(null);
  const cursorFollowFrameRef = useRef<number | null>(null);
  // 追踪远端最近一次 DECTCEM 是否把光标设为隐藏,配合空闲看门狗做悬空隐藏光标的自愈。
  const terminalRemoteCursorHiddenRef = useRef(false);
  const terminalCursorRecoveryTimerRef = useRef<number | null>(null);
  const terminalImeCompositionFrameRef = useRef<number | null>(null);
  const terminalImeComposingRef = useRef(false);
  const terminalPromptRowCacheRef = useRef<TerminalPromptRowCache | null>(null);
  const lastLocalTerminalInputAtRef = useRef(0);
  const terminalLocalInputEditingRef = useRef(false);
  // 横向模式只保存“软换行已证实”的内容宽度高水位；可视窗口本身变宽不能污染该值，否则缩窗后会凭空出现横向滚动。
  const terminalHorizontalContentColsRef = useRef(0);
  // 会话切走再切回时恢复真实长内容的高水位，避免缓存重放只看底部短行而丢失历史长行宽度。
  const terminalHorizontalContentColsBySessionRef = useRef<Record<string, number>>({});
  // 缓存重放结束后仅执行一次全缓冲测量，之后高频输出仍只测当前窗口，控制扫描开销。
  const terminalHorizontalFullBufferMeasurePendingRef = useRef(false);
  const terminalHorizontalOverflowEvidenceRef = useRef<TerminalHorizontalOverflowEvidence | null>(null);
  const terminalHorizontalPostShrinkCeilingRef = useRef<number | null>(null);
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
    const cursorHeight = Math.max(10, cellHeight * 0.78);
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

    const overlays = [
      terminalPromptHighlightOverlayRef.current,
      terminalMatchOverlayRef.current,
      terminalSelectionOverlayRef.current,
    ];
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

  const clearTerminalPromptHighlights = () => {
    const overlay = terminalPromptHighlightOverlayRef.current;
    if (!overlay) {
      return;
    }
    overlay.replaceChildren();
    const container = containerRef.current;
    if (container) {
      syncTerminalHighlightOverlaySize(overlay, container);
    }
  };

  // 提示符识别发生在 xterm 解析后的普通缓冲区，不依赖原始输出分片；同一逻辑自然覆盖实时 SSH、本地 Shell 与缓存重放。
  const refreshTerminalPromptHighlights = () => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    const overlay = terminalPromptHighlightOverlayRef.current;
    const metrics = resolveTerminalHighlightMetrics();
    if (
      !terminal
      || !container
      || !overlay
      || !metrics
      || terminal.buffer.active.type !== 'normal'
      || isAiAgentTerminalSessionRef.current
    ) {
      clearTerminalPromptHighlights();
      return;
    }

    const matches = collectTerminalPromptHighlightMatches(
      terminal,
      metrics.firstVisibleRow,
      metrics.lastVisibleRow + 1,
    );
    const colors = terminalPromptHighlightColorsRef.current;
    const elements: SVGElement[] = [];
    for (const match of matches) {
      // 只绘制提示符分段下划线；命令正文、终端底色和背景图片均保持原样。
      const logicalLine = translateTerminalBufferLineWithWrap(terminal, match.row);
      for (const segment of match.segments) {
        const range = resolveTerminalMatchRange(
          terminal,
          match.row,
          logicalLine.offsets,
          segment.start,
          segment.end - segment.start,
        );
        if (!range) {
          continue;
        }
        const segmentHighlight = terminalMatchRangeToHighlightStrips(range, metrics);
        for (const strip of segmentHighlight.strips) {
          const width = Math.max(0, strip.right - strip.left - terminalPromptSegmentHorizontalInsetPx * 2);
          if (width <= 0) {
            continue;
          }
          const underline = document.createElementNS(terminalHighlightSvgNamespace, 'rect');
          underline.setAttribute('class', 'terminal-prompt-segment-underline');
          underline.setAttribute('x', formatTerminalHighlightSvgNumber(strip.left + terminalPromptSegmentHorizontalInsetPx));
          underline.setAttribute('y', formatTerminalHighlightSvgNumber(strip.bottom - terminalPromptSegmentUnderlineHeightPx));
          underline.setAttribute('width', formatTerminalHighlightSvgNumber(width));
          underline.setAttribute('height', `${terminalPromptSegmentUnderlineHeightPx}`);
          underline.setAttribute('rx', '1');
          underline.setAttribute('fill', colors.segments[segment.kind]);
          elements.push(underline);
        }
      }
    }

    syncTerminalHighlightOverlaySize(overlay, container);
    overlay.replaceChildren(...elements);
  };

  const scheduleTerminalPromptHighlightRefresh = () => {
    if (terminalPromptHighlightFrameRef.current !== null) {
      return;
    }
    terminalPromptHighlightFrameRef.current = window.requestAnimationFrame(() => {
      terminalPromptHighlightFrameRef.current = null;
      refreshTerminalPromptHighlights();
    });
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

  // 只有主缓冲区承载 Shell 行编辑；alternate buffer 中的 top/vim/less 按键不能伪装成长命令输入。
  const isTerminalShellInputBufferActive = () =>
    terminalRef.current?.buffer.active.type === 'normal';

  // 远端程序定时刷新也会移动 xterm 光标；超过本地输入窗口后不再把它视为需要跟随的编辑光标。
  const hasRecentLocalTerminalInputForCursorFollow = () =>
    performance.now() - lastLocalTerminalInputAtRef.current <= terminalCursorFollowAfterInputMs;

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

  // 横向扩列只接受真实 soft-wrap 作为溢出证据：scp/top 等动态状态行会填满 PTY，但 CR 覆盖行不会产生续行，不能驱动尺寸正反馈。
  const measureTerminalBufferConfirmedOverflowColumns = () => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return 0;
    }

    const buffer = terminal.buffer.active;
    const snapshotColumns = terminal.cols;
    const measureEntireBuffer = terminalHorizontalFullBufferMeasurePendingRef.current;
    terminalHorizontalFullBufferMeasurePendingRef.current = false;
    // 输出到达或显式布局变化时测量当前窗口；缓存重放完成时测量一次全缓冲，竖向滚动本身不触发 resize。
    const requestedFirstLine = measureEntireBuffer ? 0 : Math.max(0, buffer.viewportY);
    const requestedLastLine = measureEntireBuffer
      ? buffer.length
      : Math.min(buffer.length, requestedFirstLine + terminal.rows);
    // isWrapped 记录在续行自身；视口切进逻辑行中段时必须向两侧补齐，否则会把真实长行测短。
    let firstMeasuredLine = requestedFirstLine;
    while (firstMeasuredLine > 0 && buffer.getLine(firstMeasuredLine)?.isWrapped) {
      firstMeasuredLine -= 1;
    }
    let lastMeasuredLine = requestedLastLine;
    while (lastMeasuredLine < buffer.length && buffer.getLine(lastMeasuredLine)?.isWrapped) {
      lastMeasuredLine += 1;
    }

    let confirmedOverflowColumns = 0;
    let currentLineColumns = 0;
    let currentCompletedSegmentColumns = 0;
    let currentLineStart = firstMeasuredLine;
    let currentLineHasSoftWrap = false;
    let currentLineStarted = false;
    // 只提交与原请求窗口相交、且确实超过本次 xterm 折行边界的完整逻辑行。
    const commitLogicalLine = (lineEnd: number) => {
      const intersectsRequestedRange = lineEnd > requestedFirstLine && currentLineStart < requestedLastLine;
      if (
        currentLineStarted
        && intersectsRequestedRange
        && currentLineHasSoftWrap
        && currentLineColumns > snapshotColumns
      ) {
        confirmedOverflowColumns = Math.max(confirmedOverflowColumns, currentLineColumns);
      }
    };

    for (let lineIndex = firstMeasuredLine; lineIndex < lastMeasuredLine; lineIndex += 1) {
      const line = buffer.getLine(lineIndex);
      if (!line) {
        commitLogicalLine(lineIndex);
        currentLineStarted = false;
        currentLineColumns = 0;
        currentCompletedSegmentColumns = 0;
        currentLineHasSoftWrap = false;
        continue;
      }

      const lineColumns = measureTerminalBufferLineContentColumns(line, snapshotColumns);
      if (line.isWrapped && currentLineStarted) {
        const previousLine = buffer.getLine(lineIndex - 1);
        const previousLastCell = previousLine?.getCell(snapshotColumns - 1);
        const continuationFirstCell = line.getCell(0);
        // 已有续行说明前一物理段确实走到右边界；仅对“宽字符放不下最后一格”产生的空占位回退 1 列。
        const hasWideCharacterWrapGap =
          continuationFirstCell?.getWidth() === 2
          && !previousLastCell?.getChars().trim();
        currentCompletedSegmentColumns += Math.max(0, snapshotColumns - (hasWideCharacterWrapGap ? 1 : 0));
        currentLineColumns = currentCompletedSegmentColumns + lineColumns;
        currentLineHasSoftWrap = true;
      } else {
        commitLogicalLine(lineIndex);
        currentLineStart = lineIndex;
        currentLineColumns = lineColumns;
        currentCompletedSegmentColumns = 0;
        // scrollback 顶端可能裁掉逻辑行首；保留 isWrapped 证据，但仍要求剩余内容本身超过 snapshotColumns 才扩列。
        currentLineHasSoftWrap = line.isWrapped;
        currentLineStarted = true;
      }
    }
    commitLogicalLine(lastMeasuredLine);
    return confirmedOverflowColumns;
  };

  // 横向模式只根据已确认的内容溢出提高会话高水位；可视宽度和远端重绘光标都不能反向污染高水位。
  const resolveHorizontalTerminalColumns = (visibleCols: number) => {
    const terminal = terminalRef.current;
    if (!terminalLineWrapModeRef.current || terminalLineWrapModeRef.current !== 'horizontal' || !terminal) {
      return visibleCols;
    }

    // 缩窗后的二次测量最多恢复到缩列前宽度，旧的满宽进度帧不能借 reflow 再额外推高一档。
    const postShrinkCeiling = terminalHorizontalPostShrinkCeilingRef.current;
    terminalHorizontalPostShrinkCeilingRef.current = null;
    const confirmedOverflowColumns = measureTerminalBufferConfirmedOverflowColumns();
    if (confirmedOverflowColumns > terminal.cols) {
      const previousEvidence = terminalHorizontalOverflowEvidenceRef.current;
      const currentEdgeOverflow = confirmedOverflowColumns - terminal.cols;
      const previousEdgeOverflow = previousEvidence
        ? previousEvidence.contentColumns - previousEvidence.snapshotColumns
        : 0;
      const followsPreviousResize = Boolean(
        previousEvidence
        && terminal.cols > previousEvidence.snapshotColumns
        && confirmedOverflowColumns - previousEvidence.contentColumns
          >= terminal.cols - previousEvidence.snapshotColumns - terminalHorizontalLinePaddingColumns
        && Math.abs(currentEdgeOverflow - previousEdgeOverflow) <= terminalHorizontalLinePaddingColumns,
      );
      const repeatsResponsiveEdge = Boolean(
        previousEvidence?.widthResponsive
        && terminal.cols === previousEvidence.snapshotColumns
        && confirmedOverflowColumns <= previousEvidence.contentColumns + terminalHorizontalLinePaddingColumns,
      );
      const isActivelyEditingLocalInput =
        terminalLocalInputEditingRef.current && hasRecentLocalTerminalInputForCursorFollow();
      // 紧随 resize 的同幅增长无条件视为尺寸响应；同宽重复帧仅允许真实 Shell 行编辑用后续字符突破。
      if (followsPreviousResize || (!isActivelyEditingLocalInput && repeatsResponsiveEdge)) {
        terminalHorizontalOverflowEvidenceRef.current = {
          // 同一宽度的重复边缘帧固定基准，不随每个字符滑动；真正内容再增长超过余量后仍可恢复扩列。
          contentColumns: repeatsResponsiveEdge && previousEvidence
            ? previousEvidence.contentColumns
            : confirmedOverflowColumns,
          snapshotColumns: terminal.cols,
          widthResponsive: true,
        };
        return Math.max(visibleCols, terminalHorizontalContentColsRef.current);
      }

      terminalHorizontalOverflowEvidenceRef.current = {
        contentColumns: confirmedOverflowColumns,
        snapshotColumns: terminal.cols,
        widthResponsive: Boolean(
          postShrinkCeiling
          && confirmedOverflowColumns >= postShrinkCeiling - terminalHorizontalLinePaddingColumns,
        ),
      };
      const measuredColumns = Math.min(
        postShrinkCeiling ?? terminalHorizontalMaxColumns,
        roundHorizontalColumns(
          confirmedOverflowColumns + terminalHorizontalLinePaddingColumns,
          visibleCols,
        ),
      );
      terminalHorizontalContentColsRef.current = Math.max(
        terminalHorizontalContentColsRef.current,
        measuredColumns,
      );
      const sessionId = sessionRef.current?.id;
      if (sessionId) {
        terminalHorizontalContentColsBySessionRef.current[sessionId] = terminalHorizontalContentColsRef.current;
      }
    }
    return Math.max(visibleCols, terminalHorizontalContentColsRef.current);
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
    const previousColumns = terminal.cols;
    if (terminal.cols !== nextLayoutSize.renderCols || terminal.rows !== nextLayoutSize.rows) {
      terminal.resize(nextLayoutSize.renderCols, nextLayoutSize.rows);
    }
    applyTerminalElementWidth(nextLayoutSize.renderCols, nextLayoutSize.visibleCols);
    if (
      terminalLineWrapModeRef.current === 'horizontal'
      && !terminalActiveReplayRef.current
      && nextLayoutSize.renderCols < previousColumns
    ) {
      // 缩列本身才会让此前可容纳的静态长行产生 soft-wrap；下一帧复测一次，且回扩不会再次进入该分支。
      terminalHorizontalPostShrinkCeilingRef.current = previousColumns;
      scheduleTerminalSizeSync();
    }
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
      lineHeight: 1.18,
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
      if (terminalPromptHighlightFrameRef.current !== null) {
        window.cancelAnimationFrame(terminalPromptHighlightFrameRef.current);
        terminalPromptHighlightFrameRef.current = null;
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
      if (terminalContrastCursorFrameRef.current !== null) {
        window.cancelAnimationFrame(terminalContrastCursorFrameRef.current);
        terminalContrastCursorFrameRef.current = null;
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
      terminalSelectionDragActiveRef.current = false;
      terminalVerticalScrollbarDragRef.current = null;
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
