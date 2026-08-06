import { ChevronLeft, ChevronRight, Copy, CopyPlus, RotateCcw, Trash2, X } from 'lucide-react';

import type { TranslationKey } from '../../i18n';
import type { TerminalSession } from '../../types';

export type SessionContextMenuTarget = { sessionId: string; x: number; y: number };

type Props = {
  closeSessionBatch: (sessionIds: string[]) => void;
  copyConnection: (session: TerminalSession) => void;
  duplicateSession: (session: TerminalSession) => void;
  reconnectSession: (session: TerminalSession) => void;
  session: TerminalSession;
  sessions: TerminalSession[];
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
  target: SessionContextMenuTarget;
};

// 会话菜单集中计算相对关闭范围，保证左侧、右侧、其他和全部关闭始终使用当前标签顺序。
export function SessionContextMenu({
  closeSessionBatch,
  copyConnection,
  duplicateSession,
  reconnectSession,
  session,
  sessions,
  t,
  target,
}: Props) {
  const sessionIndex = sessions.findIndex((item) => item.id === session.id);
  const leftSessionIds = sessions.slice(0, Math.max(0, sessionIndex)).map((item) => item.id);
  const rightSessionIds = sessions.slice(sessionIndex + 1).map((item) => item.id);
  const otherSessionIds = sessions.filter((item) => item.id !== session.id).map((item) => item.id);
  const allSessionIds = sessions.map((item) => item.id);

  return (
    <div className="context-menu session-context-menu" style={{ left: target.x, top: target.y }} onClick={(event) => event.stopPropagation()}>
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
    </div>
  );
}
