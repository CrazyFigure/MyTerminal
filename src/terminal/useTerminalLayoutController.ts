import { useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

import type { AppSettings, TerminalSession } from '../types';
import {
  measureTerminalBufferLineContentColumns,
  roundHorizontalColumns,
  terminalCursorFollowMarginColumns,
  terminalHorizontalLinePaddingColumns,
  terminalHorizontalMaxColumns,
  terminalScrollbarReservePx,
  type TerminalHorizontalOverflowEvidence,
  type TerminalLayoutSize,
  type TerminalReplayState,
} from './support';

type TerminalLayoutControllerOptions = {
  containerRef: RefObject<HTMLDivElement | null>;
  fitAddonRef: RefObject<FitAddon | null>;
  hasRecentLocalTerminalInputForCursorFollow: () => boolean;
  scheduleTerminalSizeSync: () => void;
  sessionRef: RefObject<TerminalSession | undefined>;
  setTerminalHasHorizontalOverflow: Dispatch<SetStateAction<boolean>>;
  syncTerminalAuxiliaryLayerSizes: () => void;
  terminalActiveReplayRef: RefObject<TerminalReplayState | null>;
  terminalLineWrapModeRef: RefObject<AppSettings['terminalLineWrapMode']>;
  terminalLocalInputEditingRef: RefObject<boolean>;
  terminalRef: RefObject<Terminal | null>;
};

// 横向布局控制器只接受真实 soft-wrap 作为扩列证据，并以会话高水位抵抗动态状态行造成的尺寸正反馈。
export function useTerminalLayoutController({
  containerRef,
  fitAddonRef,
  hasRecentLocalTerminalInputForCursorFollow,
  scheduleTerminalSizeSync,
  sessionRef,
  setTerminalHasHorizontalOverflow,
  syncTerminalAuxiliaryLayerSizes,
  terminalActiveReplayRef,
  terminalLineWrapModeRef,
  terminalLocalInputEditingRef,
  terminalRef,
}: TerminalLayoutControllerOptions) {
  const cursorFollowFrameRef = useRef<number | null>(null);
  const terminalHorizontalContentColsRef = useRef(0);
  const terminalHorizontalContentColsBySessionRef = useRef<Record<string, number>>({});
  const terminalHorizontalFullBufferMeasurePendingRef = useRef(false);
  const terminalHorizontalOverflowEvidenceRef = useRef<TerminalHorizontalOverflowEvidence | null>(null);
  const terminalHorizontalPostShrinkCeilingRef = useRef<number | null>(null);

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


  // 卸载时取消迟到的光标跟随帧，避免访问已销毁的 xterm DOM。
  const disposeTerminalLayoutController = () => {
    if (cursorFollowFrameRef.current !== null) {
      window.cancelAnimationFrame(cursorFollowFrameRef.current);
      cursorFollowFrameRef.current = null;
    }
  };

  return {
    applyTerminalLayoutSize,
    disposeTerminalLayoutController,
    resolveTerminalLayoutSize,
    scheduleTerminalCursorFollow,
    terminalHorizontalContentColsBySessionRef,
    terminalHorizontalContentColsRef,
    terminalHorizontalFullBufferMeasurePendingRef,
    terminalHorizontalOverflowEvidenceRef,
    terminalHorizontalPostShrinkCeilingRef,
  };
}

