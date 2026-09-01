import { create } from 'zustand';

import { backend } from './backend';
import { activateFontPack } from './app/fontPack';
import type { StoreState } from './application/store/contracts';
import { resolveBoundConnectionId } from './application/store/sessionRuntime';
import { statusText } from './application/store/status';
import { createTunnelActions } from './application/store/tunnelActions';
import { createRemoteFileActions } from './application/store/remoteFileActions';
import { createSettingsActions } from './application/store/settingsActions';
import { createConnectionActions } from './application/store/connectionActions';
import { createSessionActions } from './application/store/sessionActions';
import {
  emptyConnectionDraft,
  normalizeLoadedConnection,
} from './domain/connections/model';
import { emptyTunnelDraft, getTunnelDraftValidationKey } from './domain/tunnels/model';
import { createSplitLayout } from './features/terminal/splitLayout';
import { defaultLocalTerminals, defaultSettings } from './domain/settings/defaults';
import type {
  TunnelOpenRequest,
  TunnelUpdateRequest,
} from './types';

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
  filesLoading: false,
  historyLoading: false,
  connectionTestResult: undefined,
  editorDocument: undefined,
  activeConnectionId: undefined,
  activeSessionId: undefined,
  // 分屏布局只存在于运行期：会话本身重启后是否还在无法保证，每次启动都从单格开始。
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
    // 历史同样跟随绑定会话；分屏切换时不应向无关会话拉取历史。
    const boundConnectionId = connectionId ?? resolveBoundConnectionId(get());
    if (!boundConnectionId) {
      set({ historyLoading: false });
      return;
    }

    const requestConnectionId = boundConnectionId;
    const requestSeq = ++remoteHistoryRefreshSeq;
    set({ historyLoading: true });
    try {
      const history = await backend.readRemoteHistory(requestConnectionId);
      if (requestSeq !== remoteHistoryRefreshSeq || resolveBoundConnectionId(get()) !== requestConnectionId) {
        return;
      }

      set((state) => ({
        history: [
          ...history,
          ...state.history.filter((item) => item.connectionId !== requestConnectionId),
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
  ...createSettingsActions(set, get),
  ...createTunnelActions(set, get),
}));
