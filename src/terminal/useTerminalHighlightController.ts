import { useRef, type RefObject } from 'react';
import type { IDisposable, Terminal } from '@xterm/xterm';

import type { TerminalSession } from '../types';
import {
  buildTerminalHighlightPath,
  cloneTerminalSelectionPosition,
  collectTerminalMatchRanges,
  collectTerminalPromptHighlightMatches,
  createTerminalHighlightPathElement,
  formatTerminalHighlightSvgNumber,
  normalizeTerminalMatchSelection,
  normalizeTerminalSelectionSnapshotText,
  readTerminalSelectionTextFromBuffer,
  resolveTerminalMatchHighlightColors,
  resolveTerminalMatchRange,
  resolveTerminalSelectionLength,
  terminalHighlightCornerRadiusPx,
  terminalHighlightSvgNamespace,
  terminalMatchHighlightGapPx,
  terminalMatchHighlightMaxRanges,
  terminalMatchHighlightMaxVerticalGapPx,
  terminalMatchHighlightOverscanRows,
  terminalMatchHighlightVerticalGapRatio,
  terminalPromptSegmentHorizontalInsetPx,
  terminalPromptSegmentUnderlineHeightPx,
  terminalSelectionHighlightBackground,
  terminalSelectionHighlightBorder,
  terminalSelectionPositionHasRange,
  translateTerminalBufferLineWithWrap,
  type TerminalHighlightStrip,
  type TerminalMatchDecorationRange,
  type TerminalMatchRange,
  type TerminalPromptHighlightColors,
  type TerminalSelectionSnapshot,
} from './support';

type TerminalHighlightControllerOptions = {
  containerRef: RefObject<HTMLDivElement | null>;
  isAiAgentTerminalSessionRef: RefObject<boolean>;
  isDarkThemeRef: RefObject<boolean>;
  sessionRef: RefObject<TerminalSession | undefined>;
  terminalMatchSelectionRef: RefObject<boolean>;
  terminalPromptHighlightColorsRef: RefObject<TerminalPromptHighlightColors>;
  terminalRef: RefObject<Terminal | null>;
  terminalVerticalScrollbarRef: RefObject<HTMLDivElement | null>;
};

// 高亮控制器把选区、同词匹配和提示符三种覆盖层视为一个渲染域，共享测量、快照和销毁策略。
export function useTerminalHighlightController({
  containerRef,
  isAiAgentTerminalSessionRef,
  isDarkThemeRef,
  sessionRef,
  terminalMatchSelectionRef,
  terminalPromptHighlightColorsRef,
  terminalRef,
  terminalVerticalScrollbarRef,
}: TerminalHighlightControllerOptions) {
  const terminalPromptHighlightOverlayRef = useRef<SVGSVGElement | null>(null);
  const terminalPromptHighlightFrameRef = useRef<number | null>(null);
  const terminalMatchOverlayRef = useRef<SVGSVGElement | null>(null);
  const terminalMatchDecorationDisposablesRef = useRef<IDisposable[]>([]);
  const terminalMatchHighlightFrameRef = useRef<number | null>(null);
  const terminalSelectionOverlayRef = useRef<SVGSVGElement | null>(null);
  const terminalSelectionOverlayFrameRef = useRef<number | null>(null);
  const terminalSelectionSnapshotRef = useRef<TerminalSelectionSnapshot | null>(null);
  const terminalSelectionRestoreActiveRef = useRef(false);
  const terminalSelectionDragActiveRef = useRef(false);
  const terminalSelectionDragFrameRef = useRef<number | null>(null);

  // 覆盖层宽高必须来自 xterm 实际内容盒，不能让旧 SVG 自身参与 scrollWidth 并形成宽度正反馈。
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

  // 横向列宽变化后立即同步三个 SVG 辅助层，避免下一帧刷新前仍由旧宽度撑出空白滚动范围。
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

  const clearTerminalMatchDecorations = () => {
    const terminal = terminalRef.current;
    const hadDecorations = terminalMatchDecorationDisposablesRef.current.length > 0;
    for (const disposable of terminalMatchDecorationDisposablesRef.current) {
      disposable.dispose();
    }
    terminalMatchDecorationDisposablesRef.current = [];
    if (hadDecorations && terminal && terminal.rows > 0) {
      terminal.refresh(0, terminal.rows - 1);
    }
  };

  const clearTerminalMatchOverlay = () => {
    clearTerminalMatchDecorations();
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

  // 匹配文字前景由 xterm decoration 接管，创建和清理后都强制重绘可视区，避免旧颜色残留。
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
      terminal.refresh(0, terminal.rows - 1);
    }
  };

  const clearTerminalSelectionOverlay = () => {
    const overlay = terminalSelectionOverlayRef.current;
    if (!overlay) {
      return;
    }
    overlay.replaceChildren();
    const container = containerRef.current;
    if (container) {
      syncTerminalHighlightOverlaySize(overlay, container);
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
      !terminal
      || snapshot.sessionId !== sessionRef.current?.id
      || snapshot.cols !== terminal.cols
      || !terminalSelectionPositionHasRange(snapshot.position)
    ) {
      return false;
    }

    const bufferedText = readTerminalSelectionTextFromBuffer(terminal, snapshot.position);
    return Boolean(bufferedText.length)
      && normalizeTerminalSelectionSnapshotText(bufferedText) === normalizeTerminalSelectionSnapshotText(snapshot.text);
  };

  // 内部滚动或重排可能让 xterm 短暂丢失原生选区；只有缓冲区文本仍一致时才恢复快照。
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
      // 最后一项约束半径不超过行高的 40%，防止小字号叠小行高时圆角路径自交。
      cornerRadius: Math.min(
        terminalHighlightCornerRadiusPx,
        Math.max(2.5, cellHeight * 0.28),
        cellHeight / 2.5,
      ),
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

  // xterm 的选区事件在拖拽中不保证逐帧触发，因此鼠标按住时主动同步圆角覆盖层。
  const startTerminalSelectionDragSync = (event: MouseEvent) => {
    if (event.button !== 0 || terminalVerticalScrollbarRef.current?.contains(event.target as Node)) {
      return;
    }
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
        // 垂直内缩按行高等比缩放：小行高时由下限兜住可见间隙，大行高时封顶避免色块贴满整行。
        const verticalGap = Math.min(
          terminalMatchHighlightMaxVerticalGapPx,
          Math.max(
            terminalMatchHighlightGapPx,
            metrics.cellHeight * terminalMatchHighlightVerticalGapRatio,
          ),
        );
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

  // 提示符识别基于 xterm 解析后的普通缓冲区，同一流程覆盖 SSH、本地 Shell 与缓存重放。
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
    const matchHighlightColors = resolveTerminalMatchHighlightColors(isDarkThemeRef.current);
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

  // 卸载时统一终止所有帧和 decoration；DOM 元素本身仍由工作区创建并移除。
  const disposeTerminalHighlightController = () => {
    const frameRefs = [
      terminalMatchHighlightFrameRef,
      terminalPromptHighlightFrameRef,
      terminalSelectionOverlayFrameRef,
      terminalSelectionDragFrameRef,
    ];
    for (const frameRef of frameRefs) {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    }
    terminalSelectionDragActiveRef.current = false;
    clearTerminalMatchDecorations();
  };

  return {
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
  };
}
