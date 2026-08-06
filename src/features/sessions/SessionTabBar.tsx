import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
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
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const targetTab = target?.closest<HTMLElement>('[data-session-id]');
    const targetSessionId = targetTab?.dataset.sessionId;
    if (targetSessionId === currentDrag.id) {
      return null;
    }
    if (targetSessionId) {
      return {
        sessionId: targetSessionId,
        placement: resolveInlineInsertPlacement(event, targetTab),
      };
    }
    return isPointInsideElement(event, listRef.current) ? { type: 'end' } : null;
  }, []);

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
      if ('type' in finalDropTarget) {
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

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [Boolean(dragState), onReorderSessions, onSelectSession, resolveDropTarget, sessions]);

  return (
    <>
      <div className="session-tab-scroll-shell">
        <div
          className={`tab-list session-tab-list ${dropTarget && 'type' in dropTarget ? 'is-drop-end' : ''}`}
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
