import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

import { clampSplitRatio, applySplitRatiosToElement, type SplitDivider, type SplitRatios } from './splitRatios';

type Props = {
  containerRef: RefObject<HTMLDivElement | null>;
  divider: SplitDivider;
  // 拖拽结束时提交最终比例；拖拽过程中的跟手效果由本组件直接写 CSS 变量完成。
  onCommitRatios: (ratios: SplitRatios) => void;
  ratiosRef: RefObject<SplitRatios>;
};

// 分屏分隔条：平时完全透明，指针移近才浮现出手柄，不会一直压在终端画面上。
// 按下后用 setPointerCapture 接管指针，因此快速甩动、拖出终端区甚至拖到窗口边缘都不会丢事件。
//
// 拖拽过程中只改容器上的 CSS 变量，不走 React 渲染：分屏里最多挂着四个 xterm 实例，
// 每帧重建虚拟树会明显掉帧；终端自己有 ResizeObserver + rAF 会跟随真实尺寸重排。
// 松手时才把最终比例提交进 store，让状态与 DOM 归一。
export function SplitDividerHandle({ containerRef, divider, onCommitRatios, ratiosRef }: Props) {
  const [hovering, setHovering] = useState(false);
  const [dragging, setDragging] = useState(false);
  // 起点存在 ref 里：拖拽过程中组件不重渲染，闭包捕获的 props 不会失效。
  const originRef = useRef<{ x: number; y: number; ratios: SplitRatios } | null>(null);
  const latestRef = useRef<SplitRatios | null>(null);
  // 双击复位自己判定，不用 onDoubleClick：下面的 pointerdown 调了 preventDefault
  // （否则拖动会在终端里拉出选区），而这会连带抑制 mousedown/click 兼容事件，
  // dblclick 因此可能根本不触发。记一个上次按下的时间戳最稳。
  const lastPressAtRef = useRef(0);

  const movesColumn = divider.axis === 'column' || divider.axis === 'both';
  const movesRow = divider.axis === 'row' || divider.axis === 'both';

  // 双击回到均分：拖歪之后想复位，比反复试探着往回拖要快得多。
  const resetRatios = useCallback(() => {
    const element = containerRef.current;
    const next: SplitRatios = {
      column: movesColumn ? 0.5 : ratiosRef.current.column,
      row: movesRow ? 0.5 : ratiosRef.current.row,
    };
    if (element) {
      applySplitRatiosToElement(element, next);
    }
    onCommitRatios(next);
  }, [containerRef, movesColumn, movesRow, onCommitRatios, ratiosRef]);

  const startDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    // 阻止默认行为，否则拖动会在终端里选中文本。
    event.preventDefault();

    // 500ms 内的第二次按下视为双击复位，并且不再进入拖拽——否则复位完的比例
    // 立刻又被这次按下的 move 覆盖回去。
    const now = event.timeStamp;
    if (now - lastPressAtRef.current < 500) {
      lastPressAtRef.current = 0;
      resetRatios();
      return;
    }
    lastPressAtRef.current = now;

    event.currentTarget.setPointerCapture?.(event.pointerId);
    originRef.current = { x: event.clientX, y: event.clientY, ratios: { ...ratiosRef.current } };
    latestRef.current = null;
    setDragging(true);
  }, [ratiosRef, resetRatios]);

  const handleMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const origin = originRef.current;
    const element = containerRef.current;
    if (!origin || !element) {
      return;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    // 最小尺寸同时看比例和像素（见 resolveMinPaneRatio）：窄窗口里 15% 已经看不清内容，
    // 因此两个下限取更严格的一方，任何一格都不会被拖成一条缝。
    const next: SplitRatios = {
      column: movesColumn
        ? clampSplitRatio(origin.ratios.column + (event.clientX - origin.x) / rect.width, rect.width)
        : origin.ratios.column,
      row: movesRow
        ? clampSplitRatio(origin.ratios.row + (event.clientY - origin.y) / rect.height, rect.height)
        : origin.ratios.row,
    };

    latestRef.current = next;
    applySplitRatiosToElement(element, next);
  }, [containerRef, movesColumn, movesRow]);

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!originRef.current) {
      return;
    }
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    originRef.current = null;
    setDragging(false);
    // 指针被捕获期间不会触发 leave，松手后指针可能已不在手柄上；这里主动收回悬浮态。
    setHovering(false);
    const latest = latestRef.current;
    latestRef.current = null;
    if (latest) {
      onCommitRatios(latest);
    }
  }, [onCommitRatios]);

  return (
    <div
      className={`split-divider split-divider-${divider.id} ${hovering || dragging ? 'is-visible' : ''} ${
        dragging ? 'is-dragging' : ''
      }`}
      // span 决定这条线段有多长：三分格里竖线只存在于上半或下半（见 resolveSplitDividers）。
      data-span={divider.axis === 'both' ? 'full' : divider.span}
      onPointerCancel={finishDrag}
      onPointerDown={startDrag}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => setHovering(false)}
      onPointerMove={handleMove}
      onPointerUp={finishDrag}
      role="separator"
    >
      <span className="split-divider-grip" />
    </div>
  );
}
