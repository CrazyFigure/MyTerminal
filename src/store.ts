import { create } from 'zustand';

import { backend } from './backend';
import { activateFontPack } from './app/fontPack';
import type { StoreState } from './application/store/contracts';
import { resolveBoundConnectionId } from './application/store/sessionRuntime';
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
import { createSplitLayout } from './features/terminal/splitLayout';
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
  // 分屏布局只存在于运行期：会话本身重启后是否还在无法保证，
  // 恢复一个指向失效会话的布局反而困惑，因此每次启动都从单格开始。
  splitLayout: createSplitLayout(),
  activePanel: 'files',
  showConnectionForm: false,
  connectionDraft: emptyConnectionDraft(),
  showTunnelForm: false,
  tunnelDraft: emptyTunnelDraft(),
  updateCheckResult: null,
  fontPackStatus: null,

  bootstrap: async () => {
    set({ loading: true, statusMessage: statusText(get().settings, 'statusLoadingWorkspace') });
    // 工作区数据与字体包状态并行读取；只有字体完成本地注册后才挂载终端，避免先按 fallback 测量再跳格。
    const [state, fontPackStatus] = await Promise.all([
      backend.bootstrap(),
      backend.getFontPackStatus(),
    ]);
    let activeFontPackStatus = fontPackStatus;
    try {
      await activateFontPack(fontPackStatus);
    } catch {
      // 字体文件虽通过后端校验但 WebView 拒绝解析时继续启动，并把资源标记为待修复。
      activeFontPackStatus = { ...fontPackStatus, state: 'invalid', faces: [] };
      await activateFontPack(activeFontPackStatus);
    }
    const activeSessionId = state.sessions[0]?.id;
    const activeConnectionId = state.sessions[0]?.kind === 'local' ? undefined : state.sessions[0]?.connectionId;
    set({
      bootstrapped: true,
      loading: false,
      statusMessage: statusText(state.settings, 'statusWorkspaceLoaded'),
      settings: state.settings,
      fontPackStatus: activeFontPackStatus,
      localTerminals: state.localTerminals,
      connections: state.connections.map((connection) => normalizeLoadedConnection(connection)),
      history: state.history,
      sessions: state.sessions,
      tunnels: state.tunnels,
      activeConnectionId,
      activeSessionId,
      // 启动恢复出的首个会话进入唯一那一格；侧栏与下栏跟随当前聚焦的标签。
      splitLayout: createSplitLayout(activeSessionId),
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
    const { activeConnectionId, tunnelDraft, tunnels } = get();
    const connectionId = tunnelDraft.connectionId || activeConnectionId;
    if (!connectionId) {
      return;
    }

    const validationKey = getTunnelDraftValidationKey(tunnelDraft, tunnels);
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
      localPort: Number(tunnelDraft.localPort),
      remoteHost: tunnelDraft.remoteHost.trim(),
      remotePort: Number(tunnelDraft.remotePort),
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
    const boundConnectionId = resolveBoundConnectionId(get());
    const targetConnectionId = connectionId ?? boundConnectionId;
    // 历史同样跟随绑定会话；切分屏焦点不触发重新拉取，也不会清掉已加载的记录。
    if (!targetConnectionId || targetConnectionId !== boundConnectionId) {
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
    // 运行状态跟随绑定会话；点击其他分屏不再清空已加载的指标。
    const boundConnectionId = resolveBoundConnectionId(get());
    if (!boundConnectionId) {
      set({ runtimeOverview: undefined, runtimeLoading: false });
      return;
    }

    const requestConnectionId = boundConnectionId;
    const requestSeq = ++runtimeOverviewRefreshSeq;
    // 首次加载（还没有任何运行状态数据）才显示动画，定时轮询有旧内容时不打扰。
    if (!get().runtimeOverview) {
      set({ runtimeLoading: true });
    }
    try {
      const runtimeOverview = await backend.fetchRuntimeOverview(requestConnectionId);
      if (requestSeq !== runtimeOverviewRefreshSeq || resolveBoundConnectionId(get()) !== requestConnectionId) {
        return;
      }

      set({ runtimeOverview, runtimeLoading: false });
    } catch {
      if (requestSeq !== runtimeOverviewRefreshSeq || resolveBoundConnectionId(get()) !== requestConnectionId) {
        return;
      }

      set({ runtimeOverview: undefined, runtimeLoading: false });
    }
  },

  ...createSettingsActions(set, get),
  ...createTunnelActions(set, get),
}));
