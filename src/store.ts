import { create } from 'zustand';

import { backend } from './backend';
import type { StoreState } from './application/store/contracts';
import { statusText } from './application/store/status';
import { createTunnelActions } from './application/store/tunnelActions';
import {
  createRemoteFileActions,
} from './application/store/remoteFileActions';
import { createSettingsActions } from './application/store/settingsActions';
import { createConnectionActions } from './application/store/connectionActions';
import { createSessionActions } from './application/store/sessionActions';
import {
  emptyConnectionDraft,
  normalizeLoadedConnection,
} from './domain/connections/model';
import { isUsableRemoteSession } from './domain/sessions/model';
import { defaultLocalTerminals, defaultSettings } from './domain/settings/defaults';
import { emptyTunnelDraft, getTunnelDraftValidationKey } from './domain/tunnels/model';
import type {
  TunnelOpenRequest,
  TunnelUpdateRequest,
} from './types';

let runtimeOverviewRefreshSeq = 0;
let remoteHistoryRefreshSeq = 0;

export const useAppStore = create<StoreState>((set, get) => ({
  bootstrapped: false,
  loading: false,
  statusMessage: statusText(defaultSettings, 'ready'),
  settings: defaultSettings,
  localTerminals: defaultLocalTerminals,
  connections: [],
  history: [],
  sessions: [],
  tunnels: [],
  commandBuffers: {},
  suggestions: {},
  files: [],
  currentRemotePath: '',
  runtimeOverview: undefined,
  runtimeLoading: false,
  filesLoading: false,
  historyLoading: false,
  connectionTestResult: undefined,
  editorDocument: undefined,
  activeConnectionId: undefined,
  activeSessionId: undefined,
  activePanel: 'files',
  showConnectionForm: false,
  connectionDraft: emptyConnectionDraft(),
  showTunnelForm: false,
  tunnelDraft: emptyTunnelDraft(),
  updateCheckResult: null,

  bootstrap: async () => {
    set({ loading: true, statusMessage: statusText(get().settings, 'statusLoadingWorkspace') });
    const state = await backend.bootstrap();
    const activeSessionId = state.sessions[0]?.id;
    const activeConnectionId = state.sessions[0]?.kind === 'local' ? undefined : state.sessions[0]?.connectionId;
    set({
      bootstrapped: true,
      loading: false,
      statusMessage: statusText(state.settings, 'statusWorkspaceLoaded'),
      settings: state.settings,
      localTerminals: state.localTerminals,
      connections: state.connections.map((connection) => normalizeLoadedConnection(connection)),
      history: state.history,
      sessions: state.sessions,
      tunnels: state.tunnels,
      activeConnectionId,
      activeSessionId,
      files: [],
      currentRemotePath: activeConnectionId ? '~' : '',
      runtimeOverview: undefined,
    });
  },

  setStatusMessage: (statusMessage) => set({ statusMessage }),
  clearConnectionTestResult: () => set({ connectionTestResult: undefined }),
  setActivePanel: (activePanel) => set({ activePanel }),
  ...createSessionActions(set, get),
  ...createConnectionActions(set, get),
  closeTunnelForm: () => set({ showTunnelForm: false, tunnelDraft: emptyTunnelDraft() }),

  updateTunnelDraft: (key, value) =>
    set((state) => ({
      tunnelDraft: {
        ...state.tunnelDraft,
        [key]: value,
      },
    })),

  saveTunnelDraft: async () => {
    const { activeConnectionId, tunnelDraft } = get();
    const connectionId = tunnelDraft.connectionId || activeConnectionId;
    if (!connectionId) {
      return;
    }

    const validationKey = getTunnelDraftValidationKey(tunnelDraft);
    if (validationKey) {
      set((state) => ({
        statusMessage: statusText(state.settings, validationKey),
      }));
      return;
    }

    // 保存隧道只负责落盘，启动监听由“开启”按钮触发，避免端口被占用时连配置都无法创建。
    const request: TunnelOpenRequest = {
      connectionId,
      name: tunnelDraft.name.trim(),
      bindAddress: tunnelDraft.bindAddress.trim(),
      localPort: tunnelDraft.localPort,
      remoteHost: tunnelDraft.remoteHost.trim(),
      remotePort: tunnelDraft.remotePort,
    };

    try {
      const tunnel = tunnelDraft.id
        ? await backend.updateTunnel({ ...request, id: tunnelDraft.id } as TunnelUpdateRequest)
        : await backend.openTunnel(request);
      set((state) => ({
        tunnels: [tunnel, ...state.tunnels.filter((item) => item.id !== tunnel.id)],
        activePanel: 'tunnels',
        showTunnelForm: false,
        tunnelDraft: emptyTunnelDraft(),
        statusMessage: statusText(state.settings, tunnelDraft.id ? 'statusTunnelUpdated' : 'statusTunnelCreated'),
      }));
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusTunnelSaveFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
    }
  },

  refreshRemoteHistory: async (connectionId) => {
    const { activeSessionId, sessions } = get();
    const activeSession = sessions.find((item) => item.id === activeSessionId);
    const activeRemoteConnectionId = isUsableRemoteSession(activeSession) ? activeSession?.connectionId : undefined;
    const targetConnectionId = connectionId ?? activeRemoteConnectionId;
    // 历史刷新只允许针对已打开的当前会话，避免仅选中连接时主动访问远端。
    if (!targetConnectionId || targetConnectionId !== activeRemoteConnectionId) {
      return;
    }

    const requestSeq = ++remoteHistoryRefreshSeq;
    // 仅在当前没有该连接历史缓存时才进入加载态显示动画；有旧内容则静默刷新，避免闪烁。
    if (!get().history.some((item) => item.connectionId === targetConnectionId)) {
      set({ historyLoading: true });
    }
    try {
      const remoteHistory = await backend.readRemoteHistory(targetConnectionId);
      if (requestSeq !== remoteHistoryRefreshSeq) {
        return;
      }

      set((state) => ({
        // 历史来源以远端 Shell 为准：刷新当前连接时只替换该连接记录，保留其他连接缓存。
        history: [
          ...remoteHistory,
          ...state.history.filter((item) => item.connectionId !== targetConnectionId),
        ],
        historyLoading: false,
        statusMessage: statusText(state.settings, 'statusLoadedRemoteHistory'),
      }));
    } catch (error) {
      if (requestSeq !== remoteHistoryRefreshSeq) {
        return;
      }

      set((state) => ({
        historyLoading: false,
        statusMessage: statusText(state.settings, 'statusRemoteHistoryFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
    }
  },

  ...createRemoteFileActions(set, get),
  refreshRuntimeOverview: async () => {
    const { activeConnectionId, activeSessionId, sessions } = get();
    const activeSession = sessions.find((item) => item.id === activeSessionId);
    const activeRemoteConnectionId = isUsableRemoteSession(activeSession) ? activeSession?.connectionId : undefined;
    // 运行状态只跟随已打开会话刷新；有旧数据时静默替换，无旧数据时用加载态显示刷新动画。
    if (!activeConnectionId || activeConnectionId !== activeRemoteConnectionId) {
      set({ runtimeOverview: undefined, runtimeLoading: false });
      return;
    }

    const requestConnectionId = activeConnectionId;
    const requestSeq = ++runtimeOverviewRefreshSeq;
    // 首次加载（还没有任何运行状态数据）才显示动画，定时轮询有旧内容时不打扰。
    if (!get().runtimeOverview) {
      set({ runtimeLoading: true });
    }
    try {
      const runtimeOverview = await backend.fetchRuntimeOverview(activeConnectionId);
      if (requestSeq !== runtimeOverviewRefreshSeq || get().activeConnectionId !== requestConnectionId) {
        return;
      }

      set({ runtimeOverview, runtimeLoading: false });
    } catch {
      if (requestSeq !== runtimeOverviewRefreshSeq || get().activeConnectionId !== requestConnectionId) {
        return;
      }

      set({ runtimeOverview: undefined, runtimeLoading: false });
    }
  },

  ...createSettingsActions(set, get),
  ...createTunnelActions(set, get),
}));
