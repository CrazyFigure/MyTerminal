import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { retainTerminalSessions } from '../../terminal/terminalOutputHub';
import type { AppSettings, ConnectionProfile, TerminalSession } from '../../types';
import type { TranslationKey } from '../../i18n';
import { SplitDividerHandle } from './SplitDividerHandle';
import { SplitDropIndicator } from './SplitDropIndicator';
import { SplitPaneTabBar } from './SplitPaneTabBar';
import {
  splitMaskToBounds,
  splitMaskToGridArea,
  type SplitDropTarget,
  type SplitLayout,
} from './splitLayout';
import {
  applySplitRatiosToElement,
  DEFAULT_SPLIT_RATIOS,
  resolveSplitDividers,
  type SplitRatios,
} from './splitRatios';

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

  // 分屏比例只有两个数字：竖线的横向位置与横线的纵向位置（见 splitRatios.ts）。
  // 它属于「当前这套分屏长什么样」的视图状态，和会话本身一样只活在运行期，因此留在组件里。
  const [ratios, setRatios] = useState<SplitRatios>(DEFAULT_SPLIT_RATIOS);
  // 拖拽期间不重渲染，手柄通过 ref 读取起始比例，避免闭包拿到过期值。
  const ratiosRef = useRef(ratios);
  ratiosRef.current = ratios;

  // 该画哪几条线、每条多长，全部从掩码几何推导：二分屏一条贯穿线，三分格里那条短线只占半边，
  // 四分格两条贯穿线外加一个中心手柄。因此 2/3/4 分屏不需要各写一套分支。
  const dividers = useMemo(() => resolveSplitDividers(layout), [layout]);

  // 松手时才提交：拖拽过程中的跟手效果由手柄直接改 CSS 变量完成，一次拖动只产生一次渲染。
  const commitRatios = useCallback((next: SplitRatios) => {
    setRatios(next);
  }, []);

  // 比例写进 DOM 走 effect，而不是 JSX 的 style：拖拽中手柄会直接改写这两个变量，
  // 若 style 里也声明它们，任何一次不相干的重渲染（新输出、标签切换）都会把变量刷回
  // 上一次提交的值，表现为拖到一半突然弹回去。effect 只在提交后的比例真正变化时才写。
  useEffect(() => {
    const element = containerRef.current;
    if (element) {
      applySplitRatiosToElement(element, ratios);
    }
  }, [containerRef, ratios]);

  // 分屏拆回单格时复位。比例这两个数字在任何布局下含义都一样（竖线在哪、横线在哪），
  // 不存在"对旧结构才有效"的问题，所以布局改变**不**重置——左右二分拖成 70/30 后
  // 再把右侧切成上下两块，那条竖线理应留在用户放的位置。只有整个分屏被拆干净了，
  // 下次重新分屏才从均分开始，免得用户莫名其妙继承到很久以前的比例。
  const hasDividers = dividers.length > 0;
  useEffect(() => {
    if (!hasDividers) {
      setRatios(DEFAULT_SPLIT_RATIOS);
    }
  }, [hasDividers]);

  // 全局输出缓存/行号时间线的回收放在容器里执行一次；若下沉到每个终端实例，
  // 分屏后同一份回收会按实例数重复触发。
  useEffect(() => {
    retainTerminalSessions(new Set(liveSessionIds));
  }, [liveSessionIds]);

  return (
    <div
      className={`terminal-split-grid ${dragActive ? 'is-tab-dragging' : ''}`}
      data-pane-count={layout.panes.length}
      ref={containerRef}
    >
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
      {/* 分隔条浮在格子之上、指示层之下：拖标签时指示层接管整个区域，
          此时手柄被 CSS 屏蔽（.terminal-split-grid.is-tab-dragging），不会抢走落点判定。 */}
      {dividers.map((divider) => (
        <SplitDividerHandle
          containerRef={containerRef}
          divider={divider}
          key={divider.id}
          onCommitRatios={commitRatios}
          ratiosRef={ratiosRef}
        />
      ))}
      {/* 指示层铺满网格，与格子共享同一坐标系，缩放窗口时不需要额外同步矩形。 */}
      <SplitDropIndicator hint={dropHint} layout={layout} target={dropTarget} visible={dragActive} />
    </div>
  );
}
