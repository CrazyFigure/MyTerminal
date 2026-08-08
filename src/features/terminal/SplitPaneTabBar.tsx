import { type RefObject } from 'react';

import { SessionTabBar } from '../sessions';
import type { AppSettings, ConnectionProfile, TerminalSession } from '../../types';
import type { TranslationKey } from '../../i18n';
import type { SplitDropTarget, SplitLayout } from './splitLayout';

type Props = {
  activeSessionId: string | undefined;
  connections: ConnectionProfile[];
  layout: SplitLayout;
  onCloseSession: (sessionId: string) => void | Promise<unknown>;
  onOpenContextMenu: (sessionId: string, x: number, y: number) => void;
  onReorderSessions: (sessionIds: string[]) => void;
  onSelectSession: (sessionId: string) => void;
  onSplitDragPreview: (preview: { active: boolean; target: SplitDropTarget | null }) => void;
  onSplitDrop: (target: SplitDropTarget, sessionId: string) => void;
  paneId: string;
  sessions: TerminalSession[];
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
  terminalAreaRef: RefObject<HTMLElement | null>;
  uiLanguage: AppSettings['uiLanguage'];
};

// 每个分屏格子自己的标题栏：该格的标签列表，复用会话标签栏的拖拽/排序/滚动条。
// 侧栏与下栏跟随当前聚焦的标签，无需在这里另设开关。
export function SplitPaneTabBar({
  activeSessionId,
  connections,
  layout,
  onCloseSession,
  onOpenContextMenu,
  onReorderSessions,
  onSelectSession,
  onSplitDragPreview,
  onSplitDrop,
  paneId,
  sessions,
  t,
  terminalAreaRef,
  uiLanguage,
}: Props) {
  return (
    <header className="split-pane-tab-bar" data-pane-id={paneId}>
      <SessionTabBar
        activeSessionId={activeSessionId}
        closeLabel={t('close')}
        connections={connections}
        layoutKey={paneId}
        localTerminalTitle={t('localTerminalTitle')}
        onCloseSession={onCloseSession}
        onOpenContextMenu={onOpenContextMenu}
        onReorderSessions={onReorderSessions}
        onSelectSession={onSelectSession}
        onSplitDragPreview={onSplitDragPreview}
        onSplitDrop={onSplitDrop}
        sessions={sessions}
        splitLayout={layout}
        terminalAreaRef={terminalAreaRef}
        uiLanguage={uiLanguage}
      />
    </header>
  );
}
