import { useRef, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';

import {
  clampTerminalNumber,
  terminalVerticalScrollbarBottomInsetPx,
  terminalVerticalScrollbarMinThumbHeightPx,
  terminalVerticalScrollbarRevealZonePx,
  terminalVerticalScrollbarTopInsetPx,
  type TerminalVerticalScrollbarDragState,
  type TerminalVerticalScrollbarMetrics,
} from './support';

type TerminalVerticalScrollbarControllerOptions = {
  containerRef: RefObject<HTMLDivElement | null>;
  terminalRef: RefObject<Terminal | null>;
};

// 自绘滚动条控制器集中管理测量、显隐、帧合并与拖拽状态，避免工作区同时承担终端业务和 DOM 交互细节。
export function useTerminalVerticalScrollbarController({
  containerRef,
  terminalRef,
}: TerminalVerticalScrollbarControllerOptions) {
  const terminalVerticalScrollbarRef = useRef<HTMLDivElement | null>(null);
  const terminalVerticalScrollbarThumbRef = useRef<HTMLDivElement | null>(null);
  const terminalVerticalScrollbarFrameRef = useRef<number | null>(null);
  const terminalVerticalScrollbarTimeoutRef = useRef<number | null>(null);
  const terminalVerticalScrollbarDragRef = useRef<TerminalVerticalScrollbarDragState | null>(null);

  // 轨道隐藏时无法读取自身高度，因此指标统一由终端缓冲区和容器可用高度推导。
  const resolveTerminalVerticalScrollbarMetrics = (): TerminalVerticalScrollbarMetrics | undefined => {
    const container = containerRef.current;
    const terminal = terminalRef.current;
    if (!container || !terminal) {
      return undefined;
    }

    const buffer = terminal.buffer.active;
    const totalRows = Math.max(terminal.rows, buffer.length);
    const maxScrollLine = Math.max(0, totalRows - terminal.rows);
    const trackHeight = Math.max(
      0,
      container.clientHeight - terminalVerticalScrollbarTopInsetPx - terminalVerticalScrollbarBottomInsetPx,
    );
    if (maxScrollLine <= 0 || trackHeight <= 0) {
      return undefined;
    }

    // 拇指保留最小命中高度；长历史缓冲区也必须能可靠拖动。
    const thumbHeight = Math.min(
      trackHeight,
      Math.max(terminalVerticalScrollbarMinThumbHeightPx, Math.round((trackHeight * terminal.rows) / totalRows)),
    );
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const viewportY = clampTerminalNumber(buffer.viewportY, 0, maxScrollLine);
    const thumbTop = maxThumbTop > 0 ? Math.round((viewportY / maxScrollLine) * maxThumbTop) : 0;
    return { thumbHeight, thumbTop, maxThumbTop, maxScrollLine };
  };

  // 拖拽和点击轨道都先换算为缓冲区行，再交由 xterm 保证实际滚动边界。
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

  // 将缓冲区视口同步到 DOM；无历史可滚动时同时清除拖拽和可见状态。
  const syncTerminalVerticalScrollbar = () => {
    const container = containerRef.current;
    const scrollbar = terminalVerticalScrollbarRef.current;
    const thumb = terminalVerticalScrollbarThumbRef.current;
    if (!container || !scrollbar || !thumb) {
      return;
    }

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

  const showTerminalVerticalScrollbar = () => {
    syncTerminalVerticalScrollbar();
    const scrollbar = terminalVerticalScrollbarRef.current;
    if (scrollbar?.classList.contains('is-scrollable')) {
      scrollbar.classList.add('is-visible');
    }
  };

  const hideTerminalVerticalScrollbar = () => {
    if (!terminalVerticalScrollbarDragRef.current) {
      terminalVerticalScrollbarRef.current?.classList.remove('is-visible');
    }
  };

  // 高频 scroll/resize 事件按动画帧合并；滚动停止后延迟收起，兼顾反馈和内容可读性。
  const scheduleTerminalVerticalScrollbarSync = () => {
    if (terminalVerticalScrollbarFrameRef.current !== null) {
      return;
    }

    terminalVerticalScrollbarFrameRef.current = window.requestAnimationFrame(() => {
      terminalVerticalScrollbarFrameRef.current = null;
      syncTerminalVerticalScrollbar();
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

  // 鼠标进入终端右侧热区时常驻显示；离开热区后尊重已有滚动隐藏计时器。
  const handleTerminalMouseMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) {
      hideTerminalVerticalScrollbar();
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const isNearRightEdge = containerRect.right - event.clientX <= terminalVerticalScrollbarRevealZonePx;
    if (isNearRightEdge) {
      if (terminalVerticalScrollbarTimeoutRef.current !== null) {
        window.clearTimeout(terminalVerticalScrollbarTimeoutRef.current);
        terminalVerticalScrollbarTimeoutRef.current = null;
      }
      showTerminalVerticalScrollbar();
      return;
    }

    if (terminalVerticalScrollbarTimeoutRef.current === null) {
      hideTerminalVerticalScrollbar();
    }
  };

  // 点击轨道立即定位，按住拇指则记录起点，由全局 mousemove 驱动连续滚动。
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

  const handleTerminalVerticalScrollbarMouseEnter = () => {
    if (terminalVerticalScrollbarTimeoutRef.current !== null) {
      window.clearTimeout(terminalVerticalScrollbarTimeoutRef.current);
      terminalVerticalScrollbarTimeoutRef.current = null;
    }
    showTerminalVerticalScrollbar();
  };

  const handleTerminalVerticalScrollbarMouseLeave = () => {
    hideTerminalVerticalScrollbar();
  };

  // 工作区卸载时统一取消浏览器任务并失效拖拽状态，避免迟到帧访问已经移除的 DOM。
  const disposeTerminalVerticalScrollbarController = () => {
    if (terminalVerticalScrollbarFrameRef.current !== null) {
      window.cancelAnimationFrame(terminalVerticalScrollbarFrameRef.current);
      terminalVerticalScrollbarFrameRef.current = null;
    }
    if (terminalVerticalScrollbarTimeoutRef.current !== null) {
      window.clearTimeout(terminalVerticalScrollbarTimeoutRef.current);
      terminalVerticalScrollbarTimeoutRef.current = null;
    }
    terminalVerticalScrollbarDragRef.current = null;
  };

  return {
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
  };
}
