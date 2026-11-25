//! 本地终端任务完成与等待输入提醒协调器：持有按会话防抖计时器、连接 xterm 视口读取与后端系统通知。

import { formatLocalTerminalTabLabel } from '../../app/localTerminal';
import { isTauriRuntime } from '../../app/runtime';
import { backend } from '../../backend';
import {
  LOCAL_TERMINAL_OUTPUT_SETTLE_DELAY_MS,
  LOCAL_TERMINAL_SIGNAL_SETTLE_DELAY_MS,
  LocalTerminalNotificationStateMachine,
  type LocalTerminalNotificationDecision,
  type LocalTerminalNotificationKind,
} from '../../domain/terminal/localTerminalNotifications';
import { translate } from '../../i18n';
import type { AppSettings, TerminalSession } from '../../types';

export type LocalTerminalViewportReader = () => string[];

type NotifierContext = {
  activeSessionId?: string;
  sessions: TerminalSession[];
  settings: AppSettings;
};

type SessionRuntimeTracker = {
  machine: LocalTerminalNotificationStateMachine;
  quickTimer: number | null;
  settleTimer: number | null;
};

type AlertListener = (sessionId: string, kind: LocalTerminalNotificationKind) => void;

const trackers = new Map<string, SessionRuntimeTracker>();
const viewportReaders = new Map<string, LocalTerminalViewportReader>();
let contextProvider: (() => NotifierContext) | undefined;
let alertListener: AlertListener | undefined;

export const configureLocalTerminalNotifier = (options: {
  getContext?: () => NotifierContext;
  onAlert?: AlertListener;
}) => {
  if (options.getContext) {
    contextProvider = options.getContext;
  }
  if (options.onAlert) {
    alertListener = options.onAlert;
  }
};

export const registerLocalTerminalViewportReader = (
  sessionId: string,
  reader: LocalTerminalViewportReader,
) => {
  viewportReaders.set(sessionId, reader);
  return () => {
    if (viewportReaders.get(sessionId) === reader) {
      viewportReaders.delete(sessionId);
    }
  };
};

const getOrCreateTracker = (session: TerminalSession): SessionRuntimeTracker => {
  let tracker = trackers.get(session.id);
  if (!tracker) {
    tracker = {
      machine: new LocalTerminalNotificationStateMachine({
        sessionId: session.id,
        sessionTitle: session.title,
        localCommand: session.localCommand ?? '',
        createdAtMs: Date.now(),
      }),
      quickTimer: null,
      settleTimer: null,
    };
    trackers.set(session.id, tracker);
  } else {
    tracker.machine.updateSessionMeta(
      session.title,
      session.localCommand ?? '',
      session.terminalTopic,
    );
  }
  return tracker;
};

const clearTrackerTimers = (tracker: SessionRuntimeTracker) => {
  if (tracker.quickTimer !== null) {
    window.clearTimeout(tracker.quickTimer);
    tracker.quickTimer = null;
  }
  if (tracker.settleTimer !== null) {
    window.clearTimeout(tracker.settleTimer);
    tracker.settleTimer = null;
  }
};

const formatTargetLabel = (session: TerminalSession, settings: AppSettings): string => {
  const fallback = translate(settings.uiLanguage, 'localTerminalTitle');
  const shortTab = formatLocalTerminalTabLabel(session, fallback);
  const rawCommand = (session.localCommand ?? '').trim();
  if (!rawCommand || rawCommand.startsWith('shell:')) {
    return shortTab;
  }
  const commandProgram = rawCommand
    .split(/\s+/)[0]
    ?.replace(/^['"]|['"]$/g, '')
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.(?:exe|cmd|bat|ps1)$/i, '');
  if (
    commandProgram &&
    !shortTab.toLowerCase().includes(commandProgram.toLowerCase())
  ) {
    return `${commandProgram} · ${shortTab}`;
  }
  return shortTab;
};

const truncateSummary = (value: string, maxChars = 160): string => {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= maxChars) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxChars - 1)}…`;
};

const dispatchNotification = (
  sessionId: string,
  decision: LocalTerminalNotificationDecision,
) => {
  const ctx = contextProvider?.();
  if (!ctx) {
    return;
  }
  const session = ctx.sessions.find((item) => item.id === sessionId);
  if (!session || session.kind !== 'local') {
    return;
  }
  if (ctx.settings.localTerminalNotificationEnabled === false) {
    return;
  }

  const onlyWhenBackground =
    ctx.settings.localTerminalNotificationOnlyWhenBackground !== false;
  const sessionIsActive = ctx.activeSessionId === session.id;
  const windowFocused =
    typeof document !== 'undefined' &&
    document.visibilityState === 'visible' &&
    document.hasFocus();

  // 目标标签正位于前台且窗口获焦时跳过，与后端 Win32 焦点校验保持一致。
  if (onlyWhenBackground && sessionIsActive && windowFocused) {
    return;
  }

  // 非当前激活标签或后台窗口触发提醒时同步点亮标签提醒徽标。
  if (!sessionIsActive || !windowFocused) {
    alertListener?.(session.id, decision.kind);
  }

  const target = formatTargetLabel(session, ctx.settings);
  const titleKey =
    decision.kind === 'needs_input'
      ? 'localTerminalNotificationNeedsInputTitle'
      : 'localTerminalNotificationCompletedTitle';
  const fallbackBodyKey =
    decision.kind === 'needs_input'
      ? 'localTerminalNotificationNeedsInputBody'
      : 'localTerminalNotificationCompletedBody';

  const title = decision.title
    ? `${target} · ${truncateSummary(decision.title, 48)}`
    : translate(ctx.settings.uiLanguage, titleKey, { target });
  const rawBody = decision.body || session.terminalTopic || '';
  const body = rawBody
    ? truncateSummary(rawBody)
    : translate(ctx.settings.uiLanguage, fallbackBodyKey);

  if (isTauriRuntime()) {
    void backend
      .showLocalTerminalNotification({
        sessionId: session.id,
        kind: decision.kind,
        title,
        body,
        onlyWhenBackground,
        sessionIsActive,
      })
      .catch(() => undefined);
    return;
  }

  if (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    window.Notification.permission === 'granted'
  ) {
    const notification = new window.Notification(title, {
      body,
      tag: `mt-lt-${session.id}`,
    });
    notification.onclick = () => {
      notification.close();
      window.focus();
      window.dispatchEvent(
        new CustomEvent('myterminal-activate-session', { detail: session.id }),
      );
    };
  }
};

const evaluateSessionViewport = (
  sessionId: string,
  trigger: 'quick' | 'settle',
) => {
  const tracker = trackers.get(sessionId);
  if (!tracker) {
    return;
  }
  const lines = viewportReaders.get(sessionId)?.() ?? [];
  const decision = tracker.machine.evaluateViewport(lines, trigger, Date.now());
  if (decision) {
    dispatchNotification(sessionId, decision);
  }
};

const scheduleQuickCheck = (sessionId: string, tracker: SessionRuntimeTracker) => {
  if (tracker.quickTimer !== null) {
    window.clearTimeout(tracker.quickTimer);
  }
  tracker.quickTimer = window.setTimeout(() => {
    tracker.quickTimer = null;
    evaluateSessionViewport(sessionId, 'quick');
  }, LOCAL_TERMINAL_SIGNAL_SETTLE_DELAY_MS);
};

const scheduleSettleCheck = (sessionId: string, tracker: SessionRuntimeTracker) => {
  if (tracker.settleTimer !== null) {
    window.clearTimeout(tracker.settleTimer);
  }
  tracker.settleTimer = window.setTimeout(() => {
    tracker.settleTimer = null;
    evaluateSessionViewport(sessionId, 'settle');
  }, LOCAL_TERMINAL_OUTPUT_SETTLE_DELAY_MS);
};

export const recordLocalTerminalUserInput = (
  session: TerminalSession | undefined,
  data: string,
) => {
  if (!session || session.kind !== 'local' || !data) {
    return;
  }
  const tracker = getOrCreateTracker(session);
  tracker.machine.recordUserInput(data, Date.now());
  // 用户刚按 Enter 或 Ctrl+C 时清理未触发的旧延迟检测，等待新一轮输出落定。
  if (data.includes('\r') || data.includes('\n') || data.includes('\x03')) {
    clearTrackerTimers(tracker);
  }
};

export const recordLocalTerminalResize = (sessionId: string) => {
  const tracker = trackers.get(sessionId);
  if (!tracker) {
    return;
  }
  tracker.machine.recordResize(Date.now());
};

export const handleLocalTerminalOutputChunk = (
  session: TerminalSession | undefined,
  content: string,
) => {
  if (!session || session.kind !== 'local' || !content) {
    return;
  }
  const tracker = getOrCreateTracker(session);
  const outcome = tracker.machine.processOutputChunk(content, Date.now());

  for (const decision of outcome.immediateNotifications) {
    clearTrackerTimers(tracker);
    dispatchNotification(session.id, decision);
  }

  if (outcome.requestQuickCheck) {
    scheduleQuickCheck(session.id, tracker);
  }
  if (outcome.scheduleSettleCheck) {
    scheduleSettleCheck(session.id, tracker);
  }
};

export const notifyLocalTerminalViewportUpdated = (sessionId: string) => {
  const tracker = trackers.get(sessionId);
  if (!tracker) {
    return;
  }
  // 若定时器仍在等待输出落定，顺延到 xterm 写入完成之后，确保视口行数据已是最新帧。
  if (tracker.settleTimer !== null) {
    scheduleSettleCheck(sessionId, tracker);
  }
};

export const removeLocalTerminalNotificationTracker = (sessionId: string) => {
  const tracker = trackers.get(sessionId);
  if (tracker) {
    clearTrackerTimers(tracker);
    trackers.delete(sessionId);
  }
  if (isTauriRuntime()) {
    void backend.clearLocalTerminalNotification(sessionId).catch(() => undefined);
  }
};

export const retainLocalTerminalNotificationTrackers = (
  liveSessionIds: Iterable<string>,
) => {
  const live =
    liveSessionIds instanceof Set ? liveSessionIds : new Set(liveSessionIds);
  for (const [sessionId, tracker] of trackers.entries()) {
    if (!live.has(sessionId)) {
      clearTrackerTimers(tracker);
      trackers.delete(sessionId);
    }
  }
};
