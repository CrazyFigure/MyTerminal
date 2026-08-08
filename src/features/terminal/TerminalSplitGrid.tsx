import { Suspense, lazy, useEffect, useMemo, type RefObject } from 'react';

import { retainTerminalSessions } from '../../terminal/terminalOutputHub';
import type { AppSettings, ConnectionProfile, TerminalSession } from '../../types';
import type { TranslationKey } from '../../i18n';
import { SplitDropIndicator } from './SplitDropIndicator';
import { SplitPaneTabBar } from './SplitPaneTabBar';
import {
  splitMaskToBounds,
  splitMaskToGridArea,
  type SplitDropTarget,
  type SplitLayout,
} from './splitLayout';

// 终端内核较重，沿用 App 原有的懒加载边界；分屏后多个格子共享同一份已加载的模块。
const TerminalWorkspace = lazy(() => import('../../TerminalWorkspace').then((module) => ({
  default: module.TerminalWorkspace,
})));

type Props = {
  activeSessionId: string | undefined;
  connections: ConnectionProfile[];
  // 拖拽落点判定与指示器共用同一个容器矩形，因此 ref 必须指向下面这个网格根节点。
  containerRef: RefObject<HTMLDivElement | null>;
  dragActive: boolean;
  dropHint: string;
  dropTarget: SplitDropTarget | null;
  layout: SplitLayout;
  onCloseSession: (sessionId: string) => void | Promise<unknown>;
  onOpenContextMenu: (sessionId: string, x: number, y: number) => void;
  onReorderPaneSessions: (paneId: string, sessionIds: string[]) => void;
  onSelectSession: (sessionId: string) => void;
  onSendTerminalData: (sessionId: string, data: string) => void;
  onSplitDragPreview: (preview: { active: boolean; target: SplitDropTarget | null }) => void;
  onSplitDrop: (target: SplitDropTarget, sessionId: string) => void;
  onUpdateSettings: (partial: Partial<AppSettings>) => void;
  sessions: TerminalSession[];
  settings: AppSettings;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
};

// 分屏容器：把布局里的每个格子摆到 2×2 CSS Grid 上，各自带一条标签栏和一个终端实例。
// 会话与格子的对应关系全部来自 store，本组件只负责呈现与转发事件。
export function TerminalSplitGrid({
  activeSessionId,
  connections,
  containerRef,
  dragActive,
  dropHint,
  dropTarget,
  layout,
  onCloseSession,
  onOpenContextMenu,
  onReorderPaneSessions,
  onSelectSession,
  onSendTerminalData,
  onSplitDragPreview,
  onSplitDrop,
  onUpdateSettings,
  sessions,
  settings,
  t,
}: Props) {
  const sessionIdsKey = sessions.map((item) => item.id).join('\n');
  const liveSessionIds = useMemo(() => sessions.map((item) => item.id), [sessionIdsKey]);

  // 全局输出缓存/行号时间线的回收放在容器里执行一次；若下沉到每个终端实例，
  // 分屏后同一份回收会按实例数重复触发。
  useEffect(() => {
    retainTerminalSessions(new Set(liveSessionIds));
  }, [liveSessionIds]);

  return (
    <div className="terminal-split-grid" data-pane-count={layout.panes.length} ref={containerRef}>
      {layout.panes.map((pane) => {
        // 每格只渲染自己那一条标签栏对应的会话；未激活的标签不挂终端实例。
        const paneSessions = pane.sessionIds
          .map((sessionId) => sessions.find((item) => item.id === sessionId))
          .filter((session): session is TerminalSession => Boolean(session));
        const paneSession = pane.activeSessionId
          ? paneSessions.find((item) => item.id === pane.activeSessionId)
          : undefined;
        const isFocused = Boolean(paneSession && paneSession.id === activeSessionId);
        // 落点若指向本格，整格描边；具体预览区域由指示层绘制。
        const isDropTarget = dropTarget?.kind === 'move' && dropTarget.paneId === pane.id;
        // 贴着网格右/下边缘的格子不画分隔线，避免与外层卡片边框叠成双线。
        const bounds = splitMaskToBounds(pane.mask);

        return (
          <section
            key={pane.id}
            className={`terminal-split-pane ${isFocused ? 'is-focused' : ''} ${
              isDropTarget ? 'is-drop-target' : ''
            } ${paneSession ? '' : 'is-empty'}`}
            data-at-bottom-edge={bounds.rowEnd === 2}
            data-at-right-edge={bounds.colEnd === 2}
            data-pane-id={pane.id}
            onPointerDownCapture={() => {
              // 点击格子内任意位置都视为聚焦该格，后续新开的会话会落在这里。
              if (paneSession && paneSession.id !== activeSessionId) {
                onSelectSession(paneSession.id);
              }
            }}
            style={splitMaskToGridArea(pane.mask)}
          >
            <SplitPaneTabBar
              activeSessionId={pane.activeSessionId}
              connections={connections}
              layout={layout}
              onCloseSession={onCloseSession}
              onOpenContextMenu={onOpenContextMenu}
              onReorderSessions={(sessionIds) => onReorderPaneSessions(pane.id, sessionIds)}
              onSelectSession={onSelectSession}
              onSplitDragPreview={onSplitDragPreview}
              onSplitDrop={onSplitDrop}
              paneId={pane.id}
              sessions={paneSessions}
              t={t}
              terminalAreaRef={containerRef}
              uiLanguage={settings.uiLanguage}
            />
            <div className="terminal-split-pane-body">
              {paneSession || layout.panes.length === 1 ? (
                // 单格且无会话时仍挂载终端实例：欢迎/空态画面由 TerminalWorkspace 自己绘制，
                // 这里不另造一套，保持与分屏前完全一致的首屏。
                <Suspense fallback={<div className="terminal-startup-placeholder">{t('working')}</div>}>
                  <TerminalWorkspace
                    key={pane.id}
                    liveSessionIds={liveSessionIds}
                    onTerminalData={(data) => {
                      if (paneSession) {
                        onSendTerminalData(paneSession.id, data);
                      }
                    }}
                    onUpdateSettings={onUpdateSettings}
                    session={paneSession}
                    settings={settings}
                  />
                </Suspense>
              ) : (
                <div className="terminal-split-pane-empty">{t('splitPaneEmptyHint')}</div>
              )}
            </div>
          </section>
        );
      })}
      {/* 指示层铺满网格，与格子共享同一坐标系，缩放窗口时不需要额外同步矩形。 */}
      <SplitDropIndicator hint={dropHint} layout={layout} target={dropTarget} visible={dragActive} />
    </div>
  );
}
