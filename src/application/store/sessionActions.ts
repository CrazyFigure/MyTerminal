//! 会话动作组合入口；内部按生命周期、输入和输出三个协作职责组装。

import type { StoreGet, StoreSet, StoreState } from './contracts';
import { createSessionLifecycleActions } from './sessionLifecycleActions';
import { createTerminalInputActions } from './terminalInputActions';
import { createTerminalOutputActions } from './terminalOutputActions';

type SessionActionKeys =
  | 'setActiveConnectionId'
  | 'selectSession'
  | 'openSession'
  | 'adoptSession'
  | 'saveLocalTerminals'
  | 'openLocalTerminal'
  | 'duplicateSession'
  | 'reconnectSession'
  | 'scheduleAutoReconnect'
  | 'runAutoReconnect'
  | 'reorderSessions'
  | 'closeSession'
  | 'setCommandBuffer'
  | 'acceptSuggestion'
  | 'requestSuggestions'
  | 'sendCommand'
  | 'sendTerminalData'
  | 'passthroughTab'
  | 'runQuickCommand'
  | 'pollTerminalOutputs';

export type SessionActions = Pick<StoreState, SessionActionKeys>;

// 各工厂仍通过完整 Store 契约协作，组合层只负责建立稳定的对外 action 集合。
export const createSessionActions = (set: StoreSet, get: StoreGet): SessionActions => ({
  ...createSessionLifecycleActions(set, get),
  ...createTerminalInputActions(set, get),
  ...createTerminalOutputActions(set, get),
});
