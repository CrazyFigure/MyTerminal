import { ChevronLeft, ChevronRight, Copy, CopyPlus, RotateCcw, Trash2, X } from 'lucide-react';

import type { TranslationKey } from '../../i18n';
import { ViewportClampedMenu } from '../../shared/ui/ViewportClampedMenu';
import type { TerminalSession } from '../../types';

export type SessionContextMenuTarget = { sessionId: string; x: number; y: number };

type Props = {
  closeSessionBatch: (sessionIds: string[]) => void;
  copyConnection: (session: TerminalSession) => void;
  duplicateSession: (session: TerminalSession) => void;
  reconnectSession: (session: TerminalSession) => void;
  session: TerminalSession;
  sessions: TerminalSession[];
  // 左右关闭范围只取当前标签栏的显示顺序，全局会话列表不承担位置语义。
  tabSessionIds: string[];
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
  target: SessionContextMenuTarget;
};

// 左右关闭以当前标签栏的显示顺序为准；关闭其他和全部仍沿用全局会话范围。
export function SessionContextMenu({
  closeSessionBatch,
  copyConnection,
  duplicateSession,
  reconnectSession,
  session,
  sessions,
  tabSessionIds,
  t,
  target,
}: Props) {
  // 过滤已关闭的标签；目标标签不在当前栏时禁用左右关闭，避免误关其他格的会话。
  const visibleSessionIds = tabSessionIds.filter((sessionId) => sessions.some((item) => item.id === sessionId));
  const sessionIndex = visibleSessionIds.indexOf(session.id);
  const leftSessionIds = visibleSessionIds.slice(0, Math.max(0, sessionIndex));
  const rightSessionIds = sessionIndex >= 0 ? visibleSessionIds.slice(sessionIndex + 1) : [];
  const otherSessionIds = sessions.filter((item) => item.id !== session.id).map((item) => item.id);
  const allSessionIds = sessions.map((item) => item.id);

  return (
    <ViewportClampedMenu className="context-menu session-context-menu" x={target.x} y={target.y}>
      <button className="context-menu-item" onClick={() => closeSessionBatch([session.id])} type="button">
        <X size={14} /> {t('closeSessionAction')}
      </button>
      <button className="context-menu-item" disabled={!leftSessionIds.length} onClick={() => closeSessionBatch(leftSessionIds)} type="button">
        <ChevronLeft size={14} /> {t('closeSessionsLeft')}
      </button>
      <button className="context-menu-item" disabled={!rightSessionIds.length} onClick={() => closeSessionBatch(rightSessionIds)} type="button">
        <ChevronRight size={14} /> {t('closeSessionsRight')}
      </button>
      <button className="context-menu-item" disabled={!otherSessionIds.length} onClick={() => closeSessionBatch(otherSessionIds)} type="button">
        <X size={14} /> {t('closeOtherSessions')}
      </button>
      <button className="context-menu-item" onClick={() => closeSessionBatch(allSessionIds)} type="button">
        <Trash2 size={14} /> {t('closeAllSessions')}
      </button>
      <button className="context-menu-item" onClick={() => duplicateSession(session)} type="button">
        <CopyPlus size={14} /> {t('duplicateSession')}
      </button>
      <button className="context-menu-item" onClick={() => reconnectSession(session)} type="button">
        <RotateCcw size={14} /> {t('reconnectSession')}
      </button>
      <button className="context-menu-item" onClick={() => copyConnection(session)} type="button">
        <Copy size={14} /> {t('copyConnectionInfo')}
      </button>
    </ViewportClampedMenu>
  );
}
