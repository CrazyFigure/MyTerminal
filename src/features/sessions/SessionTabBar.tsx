import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { TerminalSquare, X } from 'lucide-react';

import { formatLocalTerminalTabLabel, getLocalTerminalIcon } from '../../app/localTerminal';
import { clamp } from '../../app/layout';
import {
  isPointInsideElement,
  moveItemToEnd,
  moveItemToInsert,
  resolveInlineInsertPlacement,
  useFlipListAnimation,
  type InsertPlacement,
} from '../../app/connectionGroups';
import { translateStatus } from '../../i18n';
import {
  resolveSplitDropTarget,
  type SplitDropTarget,
  type SplitLayout,
} from '../terminal/splitLayout';
import type { AppSettings, ConnectionProfile, TerminalSession } from '../../types';
import { sessionStatusClassName } from './presentation';

type SessionTabDragState = {
  id: string;
  label: string;
  originX: number;
  originY: number;
  currentX: number;
  currentY: number;
} | null;

type SessionTabDropTarget =
  | { sessionId: string; placement: InsertPlacement }
  | { type: 'end' }
  // 指针已经离开标签栏、进入终端区：此时不再排序，改由分屏落点判定接管。
  | { type: 'split'; target: SplitDropTarget | null }
  | null;

type SessionTabScrollbarState = {
  visible: boolean;
  thumbLeft: number;
  thumbWidth: number;
};

type SessionTabScrollbarDragState = {
  pointerId: number;
  originX: number;
  originScrollLeft: number;
  maxScrollLeft: number;
  maxThumbTravel: number;
};

// 标签栏上下各留出的容错高度（像素）：横向甩动标签时手几乎走不出一条水平线，
// 若指针擦出栏外一两像素就切成分屏落点，排序会被落点提示反复打断。
const TAB_STRIP_VERTICAL_TOLERANCE = 12;

// 指针是否仍在"本格自己这条标签栏"的排序带内。
// 横向必须在栏内（越到隔壁格的标签栏就不再属于本格排序），纵向允许上下溢出一点容错。
// 分屏后标签栏本身就长在终端网格里，只判"是否落在终端区"无法区分排序与分屏，
// 必须先用这条带子把"在自己栏里左右拖"择出来。
const isPointInTabStrip = (event: PointerEvent, element: HTMLElement | null) => {
  if (!element) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return event.clientX >= rect.left
    && event.clientX <= rect.right
    && event.clientY >= rect.top - TAB_STRIP_VERTICAL_TOLERANCE
    && event.clientY <= rect.bottom + TAB_STRIP_VERTICAL_TOLERANCE;
};

type Props = {
  activeSessionId: string | undefined;
  closeLabel: string;
  connections: ConnectionProfile[];
  layoutKey: string;
  localTerminalTitle: string;
  onCloseSession: (sessionId: string) => void | Promise<unknown>;
  onOpenContextMenu: (sessionId: string, x: number, y: number) => void;
  onReorderSessions: (sessionIds: string[]) => void;
  onSelectSession: (sessionId: string) => void;
  sessions: TerminalSession[];
  uiLanguage: AppSettings['uiLanguage'];
  // 分屏拖拽所需的上下文：终端区的 DOM 位置用来把指针换算成归一化坐标，
  // 当前布局用来判定落点。拖拽结果通过 onSplitDrop 提交，过程状态通过 onSplitDropTargetChange 上报。
  splitLayout: SplitLayout;
  terminalAreaRef: RefObject<HTMLElement | null>;
  onSplitDrop: (target: SplitDropTarget, sessionId: string) => void;
  // active 表示"指针正悬在终端区"（指示器该显示），target 才是具体落点，
  // 两者分开是为了让"悬在终端区但暂时无有效落点"也能显示骨架而不闪烁。
  onSplitDragPreview: (preview: { active: boolean; target: SplitDropTarget | null }) => void;
};

// 会话标签栏拥有自己的拖拽状态机、FLIP 动画和自绘滚动条；App 只接收最终选择、关闭和排序用例。
export function SessionTabBar({
  activeSessionId,
  closeLabel,
  connections,
  layoutKey,
  localTerminalTitle,
  onCloseSession,
  onOpenContextMenu,
  onReorderSessions,
  onSelectSession,
  sessions,
  uiLanguage,
  splitLayout,
  terminalAreaRef,
  onSplitDrop,
  onSplitDragPreview,
}: Props) {
  const [dragState, setDragState] = useState<SessionTabDragState>(null);
  const [dropTarget, setDropTarget] = useState<SessionTabDropTarget>(null);
  const [scrollbar, setScrollbar] = useState<SessionTabScrollbarState>({
    visible: false,
    thumbLeft: 0,
    thumbWidth: 0,
  });
  const dragStateRef = useRef<SessionTabDragState>(null);
  const dropTargetRef = useRef<SessionTabDropTarget>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const scrollbarDragRef = useRef<SessionTabScrollbarDragState | null>(null);

  useFlipListAnimation(listRef, '[data-session-id]', [sessions.map((session) => session.id).join('|')]);

  const updateScrollbar = useCallback(() => {
    const listElement = listRef.current;
    if (!listElement) {
      setScrollbar((current) => (
        current.visible || current.thumbLeft || current.thumbWidth
          ? { visible: false, thumbLeft: 0, thumbWidth: 0 }
          : current
      ));
      return;
    }

    const maxScrollLeft = Math.max(0, listElement.scrollWidth - listElement.clientWidth);
    if (maxScrollLeft <= 1) {
      setScrollbar((current) => (
        current.visible || current.thumbLeft || current.thumbWidth
          ? { visible: false, thumbLeft: 0, thumbWidth: 0 }
          : current
      ));
      return;
    }

    // 拇指按可视区域比例计算并保留最小命中宽度，连接很多时仍能稳定拖动。
    const trackWidth = Math.max(1, listElement.clientWidth - 8);
    const thumbWidth = Math.min(
      trackWidth,
      Math.max(24, Math.round((trackWidth * listElement.clientWidth) / listElement.scrollWidth)),
    );
    const maxThumbTravel = Math.max(1, trackWidth - thumbWidth);
    const thumbLeft = Math.round((listElement.scrollLeft / maxScrollLeft) * maxThumbTravel);
    setScrollbar((current) => (
      current.visible && current.thumbLeft === thumbLeft && current.thumbWidth === thumbWidth
        ? current
        : { visible: true, thumbLeft, thumbWidth }
    ));
  }, []);

  useLayoutEffect(() => {
    updateScrollbar();
    const listElement = listRef.current;
    if (!listElement) {
      return undefined;
    }

    const handleResize = () => updateScrollbar();
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(handleResize);
    resizeObserver?.observe(listElement);
    if (listElement.parentElement) {
      resizeObserver?.observe(listElement.parentElement);
    }
    window.addEventListener('resize', handleResize);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [connections, layoutKey, sessions, updateScrollbar]);

  const startScrollbarDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    const listElement = listRef.current;
    if (!listElement || !scrollbar.visible) {
      return;
    }

    const maxScrollLeft = Math.max(0, listElement.scrollWidth - listElement.clientWidth);
    const maxThumbTravel = Math.max(1, event.currentTarget.clientWidth - scrollbar.thumbWidth);
    const trackRect = event.currentTarget.getBoundingClientRect();
    // 点击轨道先定位到指针附近再进入拖动，避免细滑块难以精确命中。
    const nextThumbLeft = clamp(
      event.clientX - trackRect.left - scrollbar.thumbWidth / 2,
      0,
      maxThumbTravel,
    );
    listElement.scrollLeft = (nextThumbLeft / maxThumbTravel) * maxScrollLeft;
    scrollbarDragRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originScrollLeft: listElement.scrollLeft,
      maxScrollLeft,
      maxThumbTravel,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateScrollbar();
  }, [scrollbar.thumbWidth, scrollbar.visible, updateScrollbar]);

  const moveScrollbarPointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const currentDrag = scrollbarDragRef.current;
    const listElement = listRef.current;
    if (!currentDrag || currentDrag.pointerId !== event.pointerId || !listElement) {
      return;
    }

    const scrollDelta = ((event.clientX - currentDrag.originX) / currentDrag.maxThumbTravel)
      * currentDrag.maxScrollLeft;
    listElement.scrollLeft = clamp(
      currentDrag.originScrollLeft + scrollDelta,
      0,
      currentDrag.maxScrollLeft,
    );
    updateScrollbar();
  }, [updateScrollbar]);

  const finishScrollbarDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const currentDrag = scrollbarDragRef.current;
    if (!currentDrag || currentDrag.pointerId !== event.pointerId) {
      return;
    }
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    scrollbarDragRef.current = null;
    updateScrollbar();
  }, [updateScrollbar]);

  const resolveDropTarget = useCallback((event: PointerEvent, currentDrag: NonNullable<SessionTabDragState>): SessionTabDropTarget => {
    // 先判"还在自己这条标签栏里吗"。分屏后标签栏本身就长在终端网格内部，
    // 若先判终端区，指针从按下起就已在网格矩形里，排序分支永远轮不到。
    // 只在栏内左右拖 = 纯排序，不弹分屏落点提示；上下明显拖出去才交给分屏判定。
    const listElement = listRef.current;
    const tabStrip = listElement?.closest<HTMLElement>('.split-pane-tab-bar') ?? listElement;
    const insideTabStrip = isPointInTabStrip(event, tabStrip);

    // 指针已经离开本格标签栏的容错带：语义切换为分屏，按落在终端区的位置判定目标。
    const terminalArea = terminalAreaRef.current;
    if (!insideTabStrip && terminalArea && isPointInsideElement(event, terminalArea)) {
      const rect = terminalArea.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return {
          type: 'split',
          target: resolveSplitDropTarget(
            splitLayout,
            (event.clientX - rect.left) / rect.width,
            (event.clientY - rect.top) / rect.height,
            currentDrag.id,
          ),
        };
      }
    }

    const target = document.elementFromPoint(event.clientX, event.clientY);
    const targetTab = target?.closest<HTMLElement>('[data-session-id]');
    const targetSessionId = targetTab?.dataset.sessionId;
    if (targetSessionId === currentDrag.id) {
      return null;
    }
    // 容错带内命中的标签必须属于本格：邻格标签栏与本格同高，横向判定已排除，
    // 这里再兜一层，避免 elementFromPoint 取到别的格子的标签导致跨格"排序"。
    if (targetSessionId && sessions.some((session) => session.id === targetSessionId)) {
      return {
        sessionId: targetSessionId,
        placement: resolveInlineInsertPlacement(event, targetTab),
      };
    }
    // 落在栏内空白处（标签右侧留白、标签间隙）视为移到末尾。
    return insideTabStrip || isPointInsideElement(event, listElement) ? { type: 'end' } : null;
  }, [sessions, splitLayout, terminalAreaRef]);

  const startTabDrag = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
    session: TerminalSession,
    label: string,
  ) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.session-tab-close')) {
      return;
    }

    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragState({
      id: session.id,
      label,
      originX: event.clientX,
      originY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
    });
  }, []);

  useEffect(() => {
    dragStateRef.current = dragState;
  }, [dragState]);

  useEffect(() => {
    dropTargetRef.current = dropTarget;
  }, [dropTarget]);

  // 指示器由 App 渲染在终端区上方，这里只负责把"当前会落在哪"同步出去；
  // 拖拽结束或指针移回标签栏时 active 转为 false，指示器随即隐藏。
  useEffect(() => {
    const splitDrag = dropTarget && 'type' in dropTarget && dropTarget.type === 'split'
      ? dropTarget
      : null;
    onSplitDragPreview({ active: Boolean(splitDrag), target: splitDrag?.target ?? null });
  }, [dropTarget, onSplitDragPreview]);

  useEffect(() => {
    // 标签栏卸载（切换布局导致重挂载）时兜底关掉落点指示器，避免遗留一层高亮盖在终端上。
    return () => onSplitDragPreview({ active: false, target: null });
  }, [onSplitDragPreview]);

  useEffect(() => {
    if (!dragState) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      setDragState((current) => {
        if (!current) {
          return current;
        }
        const nextDropTarget = resolveDropTarget(event, current);
        setDropTarget((previous) => (
          JSON.stringify(previous) === JSON.stringify(nextDropTarget) ? previous : nextDropTarget
        ));
        return { ...current, currentX: event.clientX, currentY: event.clientY };
      });
    };

    const handlePointerUp = (event: PointerEvent) => {
      const currentDrag = dragStateRef.current;
      if (!currentDrag) {
        setDragState(null);
        setDropTarget(null);
        return;
      }

      const movedDistance = Math.hypot(
        event.clientX - currentDrag.originX,
        event.clientY - currentDrag.originY,
      );
      const finalDropTarget = dropTargetRef.current ?? resolveDropTarget(event, currentDrag);
      setDragState(null);
      setDropTarget(null);
      if (movedDistance < 6 || !finalDropTarget) {
        if (movedDistance < 6) {
          onSelectSession(currentDrag.id);
        }
        return;
      }

      const currentSessionIds = sessions.map((session) => session.id);
      if ('type' in finalDropTarget && finalDropTarget.type === 'split') {
        // 落在终端区但没命中任何有效落点（例如四格已满又停在缝隙上）时按取消处理，不改布局。
        if (finalDropTarget.target) {
          onSplitDrop(finalDropTarget.target, currentDrag.id);
        }
      } else if ('type' in finalDropTarget) {
        onReorderSessions(moveItemToEnd(currentSessionIds, currentDrag.id));
      } else {
        onReorderSessions(moveItemToInsert(
          currentSessionIds,
          currentDrag.id,
          finalDropTarget.sessionId,
          finalDropTarget.placement,
        ));
      }
    };

    // pointerup 不用 { once: true }：本 effect 的依赖（sessions/splitLayout 等）会在拖拽过程中变化，
    // 一旦重订阅，已被 once 摘掉的旧监听不会补回来，拖拽就再也收不到结束事件——
    // 表现为预览高亮卡住不消失，必须再拖一次才恢复。这里改为显式移除，并补上取消类事件。
    // 拖拽的任何一种结束路径都必须走到这里，保证预览高亮和拖拽状态一起清干净。
    const cancelDrag = () => {
      setDragState(null);
      setDropTarget(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    // 指针被系统取消（触控中断、窗口失焦、右键菜单弹出）时同样要收尾，否则状态同样悬空。
    window.addEventListener('pointercancel', cancelDrag);
    window.addEventListener('blur', cancelDrag);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', cancelDrag);
      window.removeEventListener('blur', cancelDrag);
    };
  }, [Boolean(dragState), onReorderSessions, onSelectSession, resolveDropTarget, sessions]);

  return (
    <>
      <div className="session-tab-scroll-shell">
        <div
          className={`tab-list session-tab-list ${
            dropTarget && 'type' in dropTarget && dropTarget.type === 'end' ? 'is-drop-end' : ''
          }`}
          onScroll={updateScrollbar}
          ref={listRef}
        >
          {sessions.map((session) => {
            const sessionLabel = session.kind === 'local'
              ? formatLocalTerminalTabLabel(session, localTerminalTitle)
              : connections.find((item) => item.id === session.connectionId)?.name ?? session.title;
            const localTerminalIcon = session.kind === 'local'
              ? getLocalTerminalIcon(session.title, session.localCommand ?? '')
              : undefined;
            return (
              <div
                key={session.id}
                data-session-id={session.id}
                className={`session-tab ${session.id === activeSessionId ? 'is-active' : ''} ${
                  dragState?.id === session.id ? 'is-dragging' : ''
                } ${
                  dropTarget && !('type' in dropTarget) && dropTarget.sessionId === session.id
                    ? `is-drop-${dropTarget.placement}`
                    : ''
                }`}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenContextMenu(session.id, event.clientX, event.clientY);
                }}
                onPointerDown={(event) => startTabDrag(event, session, sessionLabel)}
              >
                <button className="session-tab-trigger" onClick={() => onSelectSession(session.id)} type="button">
                  {localTerminalIcon ? (
                    <img
                      src={localTerminalIcon}
                      className="session-status-icon-image"
                      alt=""
                      title={translateStatus(uiLanguage, session.status)}
                    />
                  ) : (
                    <span
                      aria-label={translateStatus(uiLanguage, session.status)}
                      className={sessionStatusClassName(session.status)}
                      title={translateStatus(uiLanguage, session.status)}
                    />
                  )}
                  <span>{sessionLabel}</span>
                </button>
                <button
                  aria-label={closeLabel}
                  className="session-tab-close"
                  onClick={(event) => {
                    event.stopPropagation();
                    void onCloseSession(session.id);
                  }}
                  title={closeLabel}
                  type="button"
                >
                  <X size={10} />
                </button>
              </div>
            );
          })}
        </div>
        {scrollbar.visible ? (
          <div
            aria-hidden="true"
            className="session-tab-scrollbar"
            onPointerCancel={finishScrollbarDrag}
            onPointerDown={startScrollbarDrag}
            onPointerMove={moveScrollbarPointer}
            onPointerUp={finishScrollbarDrag}
          >
            <div
              className="session-tab-scrollbar-thumb"
              style={{
                transform: `translateX(${scrollbar.thumbLeft}px)`,
                width: scrollbar.thumbWidth,
              }}
            />
          </div>
        ) : null}
      </div>
      {dragState ? (
        <div
          className="drag-preview"
          style={{ left: dragState.currentX + 10, top: dragState.currentY + 10 }}
        >
          <TerminalSquare size={13} />
          <span>{dragState.label}</span>
        </div>
      ) : null}
    </>
  );
}
