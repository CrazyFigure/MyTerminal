import type { Terminal } from '@xterm/xterm';

type TerminalScrollControllerOptions = {
  container: HTMLElement;
  terminal: Terminal;
  isInputBlocked: () => boolean;
};

type TouchPosition = {
  x: number;
  y: number;
  count: number;
};

// 远控虚拟滚轮可能一次发送整页或很大的像素增量，限制为三行以便逐段阅读。
const maxWheelScrollRows = 3;
// 先确认竖向滑动意图，避免轻点聚焦或横向浏览被当作翻页。
const touchScrollThresholdPx = 6;

// 按触点中心计算位移，兼容单指和双指平移；触点数量变化时重新建立起点。
function resolveTouchPosition(touches: TouchList): TouchPosition | undefined {
  if (touches.length === 0) {
    return undefined;
  }

  let x = 0;
  let y = 0;
  for (const touch of Array.from(touches)) {
    x += touch.clientX;
    y += touch.clientY;
  }
  return { x: x / touches.length, y: y / touches.length, count: touches.length };
}

// xterm 6.0 的自绘视口只处理滚轮；在会话容器补齐触摸输入，并复用 xterm 的 TUI 鼠标协议和滚轮拦截规则。
export function attachTerminalScrollController({ container, terminal, isInputBlocked }: TerminalScrollControllerOptions) {
  let touchOrigin: TouchPosition | undefined;
  let previousTouch: TouchPosition | undefined;
  let touchScrollActive = false;
  let pendingTouchRows = 0;

  // 从实际终端屏幕测量行高，跟随字体、行距与缩放设置，不依赖 xterm 私有字段。
  const resolveRowHeight = () => {
    const screen = terminal.element?.querySelector('.xterm-screen');
    const measuredHeight = (screen?.getBoundingClientRect().height ?? 0) / terminal.rows;
    const fallbackHeight = (terminal.options.fontSize ?? 14) * (terminal.options.lineHeight ?? 1);
    return Math.max(1, measuredHeight || fallbackHeight);
  };

  const isMouseWheelReported = () => {
    const mode = terminal.modes.mouseTrackingMode;
    return mode !== 'none' && mode !== 'x10';
  };

  // 普通滚轮和触控板沿用原处理，仅截住超大纵向增量；程序接管鼠标及修饰键加速仍遵循终端协议。
  const handleWheel = (event: WheelEvent) => {
    if (
      isInputBlocked() || event.defaultPrevented
      || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey
      || Math.abs(event.deltaX) > Math.abs(event.deltaY)
      || terminal.buffer.active.type !== 'normal' || isMouseWheelReported()
    ) {
      return;
    }

    const rowHeight = resolveRowHeight();
    const deltaRows = event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? event.deltaY * terminal.rows
      : event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? event.deltaY
        : event.deltaY / rowHeight;
    // 像素模式保留常见的一格鼠标滚轮（最多 120px），避免改变原有桌面滚轮手感。
    const limitRows = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL
      ? Math.max(maxWheelScrollRows, 120 / rowHeight)
      : maxWheelScrollRows;
    if (Math.abs(deltaRows) <= limitRows) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    terminal.scrollLines(Math.sign(deltaRows) * maxWheelScrollRows);
  };

  const resetTouch = () => {
    touchOrigin = undefined;
    previousTouch = undefined;
    touchScrollActive = false;
    pendingTouchRows = 0;
  };

  const handleTouchStart = (event: TouchEvent) => {
    resetTouch();
    if (!isInputBlocked()) {
      touchOrigin = resolveTouchPosition(event.touches);
      previousTouch = touchOrigin;
    }
  };

  const handleTouchMove = (event: TouchEvent) => {
    const position = resolveTouchPosition(event.touches);
    if (isInputBlocked() || !touchOrigin || !previousTouch || !position) {
      resetTouch();
      return;
    }
    if (position.count !== previousTouch.count) {
      handleTouchStart(event);
      return;
    }

    if (!touchScrollActive) {
      const deltaX = position.x - touchOrigin.x;
      const deltaY = position.y - touchOrigin.y;
      if (Math.abs(deltaY) < touchScrollThresholdPx || Math.abs(deltaY) <= Math.abs(deltaX)) {
        return;
      }
      touchScrollActive = true;
    }

    event.preventDefault();
    event.stopPropagation();
    pendingTouchRows += (previousTouch.y - position.y) / resolveRowHeight();
    previousTouch = position;
    const rows = Math.trunc(pendingTouchRows);
    pendingTouchRows -= rows;
    if (rows === 0) {
      return;
    }

    // Shell 的历史直接滚动缓冲区，保留不足一行的位移，慢速手势也能连续推进。
    if (terminal.buffer.active.type === 'normal' && !isMouseWheelReported()) {
      terminal.scrollLines(rows);
      return;
    }

    // Claude 等全屏 TUI 自己保存对话，通过等价滚轮事件交给 xterm 编码，避免直接发送方向键修改输入历史。
    const screenRect = terminal.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
    if (!screenRect || !terminal.element) {
      return;
    }
    for (let index = 0; index < Math.min(Math.abs(rows), maxWheelScrollRows); index += 1) {
      terminal.element.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: Math.max(screenRect.left, Math.min(position.x, screenRect.right - 1)),
        clientY: Math.max(screenRect.top, Math.min(position.y, screenRect.bottom - 1)),
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        deltaY: Math.sign(rows),
      }));
    }
  };

  // 捕获阶段先接住远控触摸输入；非被动监听允许阻止浏览器默认手势与兼容鼠标拖选。
  container.addEventListener('wheel', handleWheel, { capture: true, passive: false });
  container.addEventListener('touchstart', handleTouchStart, { capture: true, passive: true });
  container.addEventListener('touchmove', handleTouchMove, { capture: true, passive: false });
  container.addEventListener('touchend', resetTouch, true);
  container.addEventListener('touchcancel', resetTouch, true);
  window.addEventListener('blur', resetTouch);

  // 与终端实例同生共灭，防止切换或重建工作区后重复处理一次手势。
  return () => {
    resetTouch();
    container.removeEventListener('wheel', handleWheel, true);
    container.removeEventListener('touchstart', handleTouchStart, true);
    container.removeEventListener('touchmove', handleTouchMove, true);
    container.removeEventListener('touchend', resetTouch, true);
    container.removeEventListener('touchcancel', resetTouch, true);
    window.removeEventListener('blur', resetTouch);
  };
}
