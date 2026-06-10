import { create } from 'zustand';

import { backend } from './backend';
import { translate } from './i18n';
import type {
  AppSettings,
  ConnectionDraft,
  ConnectionProfile,
  EditorDocument,
  HistoryEntry,
  RemoteFileEntry,
  RuntimeOverview,
  SessionStatus,
  TerminalSession,
  TerminalOutputChunk,
  TunnelDraft,
  TunnelOpenRequest,
  TunnelRecord,
  UpdateCheckResult,
  WorkspacePanel,
} from './types';

const defaultSettings: AppSettings = {
  uiLanguage: 'zh-CN',
  themeMode: 'light',
  runtimeRefreshIntervalSec: 1,
  shellLatinFontFamily: 'JetBrains Mono',
  shellCjkFontFamily: 'Microsoft YaHei UI',
  shellFontFamily: 'JetBrains Mono',
  shellFontSize: 15,
  terminalBackground: '#f7f7f7',
  terminalForeground: '#111111',
  accentColor: '#4f46e5',
  backgroundImage: '',
  terminalBackgroundImageOpacity: 0.18,
  terminalBackgroundImageFit: 'cover',
  terminalRightClickBehavior: 'paste',
  compactSidebar: false,
  showCommandGhost: true,
  connectionGroups: [],
  connectionOrder: [],
  quickCommands: ['pwd', 'ls -la', 'docker ps'],
  webdav: {
    baseUrl: '',
    username: '',
    password: '',
    syncPassphrase: '',
    remoteSettingsPath: '/myterminal/settings.enc.json',
    remoteConnectionsPath: '/myterminal/connections.enc.json',
  },
};

const emptyConnectionDraft = (): ConnectionDraft => ({
  id: '',
  name: '',
  groupPath: '',
  host: '',
  port: 22,
  username: 'root',
  authMethod: 'password',
  password: '',
  privateKeyPath: '',
  privateKeyText: '',
  passphrase: '',
  note: '',
  tags: [],
});

const emptyTunnelDraft = (): TunnelDraft => ({
  name: '',
  bindAddress: '127.0.0.1',
  localPort: 15432,
  remoteHost: '127.0.0.1',
  remotePort: 5432,
});

const toBase64 = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

const parentRemotePath = (path: string) => {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  parts.pop();
  return normalized.startsWith('/') ? `/${parts.join('/')}` || '/' : parts.join('/');
};

// 分组路径统一使用相对路径形式，便于前端树渲染与后端设置持久化保持同一套判断规则。
const normalizeConnectionGroupPath = (value?: string) =>
  (value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/');

// 删除、重命名分组都需要同时处理子分组，路径前缀判断必须只命中完整层级。
const isGroupOrChildPath = (value: string | undefined, groupPath: string) => {
  const normalized = normalizeConnectionGroupPath(value);
  return Boolean(groupPath) && (normalized === groupPath || normalized.startsWith(`${groupPath}/`));
};

// 显式分组和连接表单里的分组会在这里去重，但保留传入顺序以支持用户拖拽排序。
const mergeConnectionGroups = (...groups: Array<Array<string | undefined>>) =>
  Array.from(
    new Set(
      groups
        .flat()
        .map((groupPath) => normalizeConnectionGroupPath(groupPath))
        .filter(Boolean),
    ),
  );

const stripWrappedQuotes = (value: string) => value.replace(/^['"]|['"]$/g, '');

const guessNextRemotePath = (currentPath: string, commandText: string) => {
  const lastLine = commandText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);

  if (!lastLine) {
    return undefined;
  }

  const match = lastLine.match(/^cd(?:\s+(.+))?$/);
  if (!match) {
    return undefined;
  }

  const rawTarget = stripWrappedQuotes(match[1]?.trim() ?? '');
  if (!rawTarget || rawTarget === '~') {
    return '~';
  }
  if (rawTarget === '.') {
    return currentPath || '~';
  }
  if (rawTarget === '..') {
    return parentRemotePath(currentPath) || '~';
  }
  if (rawTarget.startsWith('/') || rawTarget.startsWith('~')) {
    return rawTarget;
  }

  return `${currentPath.replace(/\/$/, '')}/${rawTarget}`.replace(/\/+/g, '/');
};

const terminalOutputEventName = 'myterminal-terminal-output';

// 只有可交互远端会话才允许驱动文件、历史和运行状态刷新，异常/关闭会话只保留终端残留输出用于排查。
const isUsableRemoteSession = (status?: SessionStatus) => status === 'connected' || status === 'stub';

// 终端输出走浏览器事件直达 xterm，避免高频输出通过 React 状态触发整页重渲染。
const emitTerminalOutput = (chunk: TerminalOutputChunk) => {
  if (typeof window === 'undefined' || !chunk.content) {
    return;
  }

  window.dispatchEvent(new CustomEvent(terminalOutputEventName, { detail: chunk }));
};

// 终端输入跨 Tauri IPC 写入，普通按键用极短窗口合并，减少逐字 IPC 带来的输入和选区卡顿。
const terminalInputBuffers = new Map<string, string>();
const terminalInputFlushPromises = new Map<string, Promise<void>>();
const terminalInputFlushTimers = new Map<string, number>();
const terminalInputFlushTimerDelays = new Map<string, number>();
// 连续退格和粘贴会产生密集 onData，小窗口合并可减少 IPC 与 SSH channel 写入抖动，同时保持按键回显足够即时。
const terminalInputFlushDelayMs = 28;
// Backspace/Delete 属于强交互编辑键，窗口太长会出现尾部删除回显滞后，保持轻微合并但更快落到 PTY。
const terminalEditingInputFlushDelayMs = 8;

// 会话关闭或重连时清理尚未写入的输入，避免旧 PTY 已释放后仍被延迟刷新命中。
const clearQueuedTerminalInput = (sessionId: string) => {
  const pendingTimer = terminalInputFlushTimers.get(sessionId);
  if (pendingTimer) {
    window.clearTimeout(pendingTimer);
    terminalInputFlushTimers.delete(sessionId);
    terminalInputFlushTimerDelays.delete(sessionId);
  }
  terminalInputBuffers.delete(sessionId);
};

// 输入刷新会串行写入后端，避免同一个会话出现并发写入导致字符顺序抖动。
const flushQueuedTerminalInput = (sessionId: string) => {
  const pendingTimer = terminalInputFlushTimers.get(sessionId);
  if (pendingTimer) {
    window.clearTimeout(pendingTimer);
    terminalInputFlushTimers.delete(sessionId);
    terminalInputFlushTimerDelays.delete(sessionId);
  }

  const runningFlush = terminalInputFlushPromises.get(sessionId);
  if (runningFlush) {
    return runningFlush;
  }

  const flushPromise = (async () => {
    while (true) {
      const payload = terminalInputBuffers.get(sessionId);
      if (!payload) {
        terminalInputBuffers.delete(sessionId);
        return;
      }

      terminalInputBuffers.set(sessionId, '');
      await backend.writeTerminalInput(sessionId, payload);
    }
  })().finally(() => {
    terminalInputFlushPromises.delete(sessionId);
  });

  terminalInputFlushPromises.set(sessionId, flushPromise);
  return flushPromise;
};

// 普通按键先入队再短延迟刷新，Enter/Tab 等需要立即反馈的输入会主动等待刷新完成。
const queueTerminalInput = (sessionId: string, data: string, flushDelayMs = terminalInputFlushDelayMs) => {
  terminalInputBuffers.set(sessionId, `${terminalInputBuffers.get(sessionId) ?? ''}${data}`);
  const pendingTimer = terminalInputFlushTimers.get(sessionId);
  if (pendingTimer) {
    const pendingDelayMs = terminalInputFlushTimerDelays.get(sessionId) ?? terminalInputFlushDelayMs;
    if (flushDelayMs >= pendingDelayMs) {
      return;
    }
    window.clearTimeout(pendingTimer);
    terminalInputFlushTimers.delete(sessionId);
    terminalInputFlushTimerDelays.delete(sessionId);
  }

  const timer = window.setTimeout(() => {
    terminalInputFlushTimers.delete(sessionId);
    terminalInputFlushTimerDelays.delete(sessionId);
    void flushQueuedTerminalInput(sessionId).catch(() => undefined);
  }, flushDelayMs);
  terminalInputFlushTimers.set(sessionId, timer);
  terminalInputFlushTimerDelays.set(sessionId, flushDelayMs);
};

const isTerminalEditingInput = (data: string) => data.includes('\x7f') || data.includes('\b') || data.includes('\x1b[3~');

// 远端刷新请求可能被快速 cd、目录双击或自动轮询连续触发；序号只允许最后一次结果落到界面。
let remoteFilesRefreshSeq = 0;
let runtimeOverviewRefreshSeq = 0;
let remoteHistoryRefreshSeq = 0;

const statusText = (
  settings: AppSettings,
  key: Parameters<typeof translate>[1],
  replacements?: Parameters<typeof translate>[2],
) => translate(settings.uiLanguage, key, replacements);

const isValidPort = (value: number) => Number.isInteger(value) && value >= 1 && value <= 65535;

const getConnectionDraftValidationKey = (draft: ConnectionDraft) => {
  if (!draft.name.trim()) {
    return 'validationNameRequired' as const;
  }
  if (!draft.host.trim()) {
    return 'validationHostRequired' as const;
  }
  if (!draft.username.trim()) {
    return 'validationUsernameRequired' as const;
  }
  if (!isValidPort(draft.port)) {
    return 'validationPortInvalid' as const;
  }

  if (draft.authMethod === 'privateKey') {
    if (!draft.privateKeyPath.trim() && !draft.privateKeyText.trim()) {
      return 'validationPrivateKeyRequired' as const;
    }
  } else if (!draft.password.trim()) {
    return 'validationPasswordRequired' as const;
  }

  return undefined;
};

const buildConnectionProfile = (draft: ConnectionDraft): ConnectionProfile => {
  const authMethod = draft.authMethod === 'privateKey' ? 'privateKey' : 'password';

  return {
    id: draft.id || crypto.randomUUID(),
    name: draft.name.trim(),
    groupPath: normalizeConnectionGroupPath(draft.groupPath) || undefined,
    host: draft.host.trim(),
    port: draft.port,
    username: draft.username.trim(),
    authMethod,
    password: authMethod === 'password' ? draft.password : undefined,
    privateKeyPath: authMethod === 'privateKey' ? draft.privateKeyPath : undefined,
    privateKeyText: authMethod === 'privateKey' ? draft.privateKeyText : undefined,
    passphrase: authMethod === 'privateKey' ? draft.passphrase : undefined,
    note: draft.note?.trim() || undefined,
    tags: Array.isArray(draft.tags)
      ? draft.tags
      : String(draft.tags)
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
  };
};

type ConnectionTestResult = {
  kind: 'success' | 'error';
  message: string;
};

type StoreState = {
  bootstrapped: boolean;
  loading: boolean;
  statusMessage: string;
  settings: AppSettings;
  connections: ConnectionProfile[];
  history: HistoryEntry[];
  sessions: TerminalSession[];
  tunnels: TunnelRecord[];
  commandBuffers: Record<string, string>;
  suggestions: Record<string, string[]>;
  files: RemoteFileEntry[];
  currentRemotePath: string;
  runtimeOverview?: RuntimeOverview;
  connectionTestResult?: ConnectionTestResult;
  editorDocument?: EditorDocument;
  activeConnectionId?: string;
  activeSessionId?: string;
  activePanel: WorkspacePanel;
  showConnectionForm: boolean;
  connectionDraft: ConnectionDraft;
  showTunnelForm: boolean;
  tunnelDraft: TunnelDraft;
  bootstrap: () => Promise<void>;
  setStatusMessage: (message: string) => void;
  clearConnectionTestResult: () => void;
  setActivePanel: (panel: WorkspacePanel) => void;
  setActiveConnectionId: (connectionId?: string) => void;
  selectSession: (sessionId?: string) => void;
  openConnectionForm: (connection?: ConnectionProfile) => void;
  closeConnectionForm: () => void;
  updateConnectionDraft: (key: keyof ConnectionDraft, value: string | number | string[]) => void;
  saveConnectionDraft: () => Promise<void>;
  testConnectionDraft: () => Promise<void>;
  closeTunnelForm: () => void;
  updateTunnelDraft: (key: keyof TunnelDraft, value: string | number) => void;
  saveTunnelDraft: () => Promise<void>;
  deleteConnection: (connectionId: string) => Promise<void>;
  duplicateConnection: (connectionId: string, groupPath?: string) => Promise<void>;
  createConnectionGroup: (groupPath: string) => Promise<string | undefined>;
  renameConnectionGroup: (currentPath: string, nextPath: string) => Promise<string | undefined>;
  deleteConnectionGroup: (groupPath: string) => Promise<void>;
  reorderConnectionGroups: (groupPaths: string[]) => Promise<void>;
  reorderConnections: (connectionIds: string[]) => Promise<void>;
  moveConnectionToGroup: (connectionId: string, groupPath?: string) => Promise<void>;
  openSession: (connectionId: string) => Promise<void>;
  reconnectSession: (sessionId: string) => Promise<void>;
  reorderSessions: (sessionIds: string[]) => void;
  closeSession: (sessionId: string) => Promise<void>;
  setCommandBuffer: (sessionId: string, value: string) => void;
  acceptSuggestion: (sessionId: string, suggestion: string) => void;
  requestSuggestions: (sessionId: string, connectionId: string | undefined, prefix: string) => Promise<void>;
  sendCommand: (sessionId: string) => Promise<void>;
  sendTerminalData: (sessionId: string, data: string) => Promise<void>;
  passthroughTab: (sessionId: string) => Promise<void>;
  runQuickCommand: (command: string) => Promise<void>;
  pollTerminalOutputs: () => Promise<void>;
  refreshRemoteHistory: (connectionId?: string) => Promise<void>;
  refreshFiles: (path?: string) => Promise<void>;
  uploadLocalFile: (file: File) => Promise<void>;
  downloadRemoteFile: (path: string) => Promise<void>;
  deleteRemotePath: (path: string) => Promise<void>;
  deleteRemotePaths: (paths: string[]) => Promise<void>;
  renameRemotePath: (path: string, newName: string) => Promise<void>;
  refreshRuntimeOverview: () => Promise<void>;
  openRemoteFile: (path: string) => Promise<void>;
  closeEditorDocument: () => void;
  setEditorContent: (content: string) => void;
  saveEditorDocument: () => Promise<void>;
  updateSettings: (updater: (settings: AppSettings) => AppSettings) => void;
  persistSettings: (settings?: AppSettings) => Promise<AppSettings>;
  testWebdavConnection: (settings?: AppSettings) => Promise<void>;
  uploadSettings: () => Promise<void>;
  downloadSettings: () => Promise<void>;
  uploadConnections: () => Promise<void>;
  downloadConnections: () => Promise<void>;
  exportLocalConfig: (targetPath: string) => Promise<void>;
  importLocalConfig: (file: File) => Promise<void>;
  checkForUpdates: () => Promise<UpdateCheckResult>;
  installUpdate: (result: UpdateCheckResult) => Promise<void>;
  openTunnel: () => Promise<void>;
  startTunnel: (tunnelId: string) => Promise<void>;
  startAllTunnels: () => Promise<void>;
  stopAllTunnels: () => Promise<void>;
  closeTunnel: (tunnelId: string) => Promise<void>;
};

export const useAppStore = create<StoreState>((set, get) => ({
  bootstrapped: false,
  loading: false,
  statusMessage: statusText(defaultSettings, 'ready'),
  settings: defaultSettings,
  connections: [],
  history: [],
  sessions: [],
  tunnels: [],
  commandBuffers: {},
  suggestions: {},
  files: [],
  currentRemotePath: '',
  runtimeOverview: undefined,
  connectionTestResult: undefined,
  editorDocument: undefined,
  activeConnectionId: undefined,
  activeSessionId: undefined,
  activePanel: 'files',
  showConnectionForm: false,
  connectionDraft: emptyConnectionDraft(),
  showTunnelForm: false,
  tunnelDraft: emptyTunnelDraft(),

  bootstrap: async () => {
    set({ loading: true, statusMessage: statusText(get().settings, 'statusLoadingWorkspace') });
    const state = await backend.bootstrap();
    const activeSessionId = state.sessions[0]?.id;
    const activeConnectionId = state.sessions[0]?.connectionId;
    set({
      bootstrapped: true,
      loading: false,
      statusMessage: statusText(state.settings, 'statusWorkspaceLoaded'),
      settings: state.settings,
      connections: state.connections,
      history: state.history,
      sessions: state.sessions,
      tunnels: state.tunnels,
      activeConnectionId,
      activeSessionId,
      files: [],
      currentRemotePath: activeSessionId ? '~' : '',
      runtimeOverview: undefined,
    });
  },

  setStatusMessage: (statusMessage) => set({ statusMessage }),
  clearConnectionTestResult: () => set({ connectionTestResult: undefined }),
  setActivePanel: (activePanel) => set({ activePanel }),
  setActiveConnectionId: (activeConnectionId) =>
    set((state) => {
      const matchedSession = activeConnectionId
        ? state.sessions.find((item) => item.connectionId === activeConnectionId)
        : undefined;
      const keepCurrentFiles = Boolean(matchedSession && matchedSession.connectionId === state.activeConnectionId);

      return {
        activeConnectionId,
        activeSessionId: matchedSession?.id,
        runtimeOverview: undefined,
        files: keepCurrentFiles ? state.files : [],
        currentRemotePath: matchedSession?.cwd ?? '',
      };
    }),
  selectSession: (activeSessionId) =>
    set((state) => {
      const matchedSession = activeSessionId
        ? state.sessions.find((item) => item.id === activeSessionId)
        : undefined;
      const keepCurrentFiles = Boolean(matchedSession && matchedSession.connectionId === state.activeConnectionId);

      return {
        activeSessionId,
        activeConnectionId: matchedSession?.connectionId,
        runtimeOverview: undefined,
        files: keepCurrentFiles ? state.files : [],
        currentRemotePath: matchedSession?.cwd ?? '',
      };
    }),

  openConnectionForm: (connection) =>
    set({
      showConnectionForm: true,
      connectionTestResult: undefined,
      connectionDraft: connection
        ? {
            ...connection,
            authMethod: connection.authMethod ?? 'password',
            groupPath: connection.groupPath ?? '',
            password: connection.password ?? '',
            privateKeyPath: connection.privateKeyPath ?? '',
            privateKeyText: connection.privateKeyText ?? '',
            passphrase: connection.passphrase ?? '',
            note: connection.note ?? '',
            tags: [...connection.tags],
          }
        : emptyConnectionDraft(),
    }),

  closeConnectionForm: () =>
    set({ showConnectionForm: false, connectionDraft: emptyConnectionDraft(), connectionTestResult: undefined }),

  updateConnectionDraft: (key, value) =>
    set((state) => ({
      connectionTestResult: undefined,
      connectionDraft: {
        ...state.connectionDraft,
        [key]: value,
      },
    })),

  saveConnectionDraft: async () => {
    const draft = get().connectionDraft;
    const validationKey = getConnectionDraftValidationKey(draft);
    if (validationKey) {
      set((state) => ({
        statusMessage: statusText(state.settings, validationKey),
      }));
      return;
    }

    const isExisting = Boolean(draft.id);
    const connection = buildConnectionProfile(draft);

    try {
      const saved = await backend.upsertConnection(connection, isExisting);
      const currentSettings = get().settings;
      const nextGroupPath = normalizeConnectionGroupPath(saved.groupPath);
      // 新连接默认放到排序顶部；编辑旧连接时保留原排序，只补齐缺失的 id。
      const knownOrder = currentSettings.connectionOrder.filter((connectionId) => connectionId !== saved.id);
      const nextConnectionOrder = isExisting
        ? [...currentSettings.connectionOrder, saved.id].filter((connectionId, index, array) => array.indexOf(connectionId) === index)
        : [saved.id, ...knownOrder];
      const nextSettings = await backend.saveSettings({
        ...currentSettings,
        connectionGroups: nextGroupPath
          ? mergeConnectionGroups(currentSettings.connectionGroups, [nextGroupPath])
          : currentSettings.connectionGroups,
        connectionOrder: nextConnectionOrder,
      });
      set((state) => {
        const exists = state.connections.some((item) => item.id === saved.id);
        return {
          settings: nextSettings,
          connections: exists
            ? state.connections.map((item) => (item.id === saved.id ? saved : item))
            : [saved, ...state.connections],
          activeConnectionId: saved.id,
          showConnectionForm: false,
          connectionDraft: emptyConnectionDraft(),
          connectionTestResult: undefined,
          statusMessage: statusText(state.settings, 'statusSavedConnection', { name: saved.name }),
        };
      });
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusConnectionSaveFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
    }
  },

  testConnectionDraft: async () => {
    const draft = get().connectionDraft;
    const validationKey = getConnectionDraftValidationKey(draft);
    if (validationKey) {
      set((state) => ({
        statusMessage: statusText(state.settings, validationKey),
      }));
      return;
    }

    const connection = buildConnectionProfile(draft);
    set((state) => ({
      loading: true,
      connectionTestResult: undefined,
      statusMessage: statusText(state.settings, 'statusTestingConnection'),
    }));

    try {
      const message = statusText(get().settings, 'statusConnectionTestPassed', {
        name: connection.name || connection.host,
      });
      await backend.testConnection(connection);
      set((state) => ({
        loading: false,
        connectionTestResult: { kind: 'success', message },
        statusMessage: message,
      }));
    } catch (error) {
      const message = statusText(get().settings, 'statusConnectionTestFailed', {
        reason: error instanceof Error ? error.message : String(error),
      });
      set((state) => ({
        loading: false,
        connectionTestResult: { kind: 'error', message },
        statusMessage: message,
      }));
    }
  },

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
    if (!activeConnectionId) {
      return;
    }

    const request: TunnelOpenRequest = {
      connectionId: activeConnectionId,
      name: tunnelDraft.name.trim(),
      bindAddress: tunnelDraft.bindAddress.trim(),
      localPort: tunnelDraft.localPort,
      remoteHost: tunnelDraft.remoteHost.trim(),
      remotePort: tunnelDraft.remotePort,
    };

    const tunnel = await backend.openTunnel(request);
    set((state) => ({
      tunnels: [tunnel, ...state.tunnels.filter((item) => item.id !== tunnel.id)],
      activePanel: 'tunnels',
      showTunnelForm: false,
      tunnelDraft: emptyTunnelDraft(),
      statusMessage: statusText(state.settings, 'statusTunnelCreated'),
    }));
  },

  deleteConnection: async (connectionId) => {
    await backend.deleteConnection(connectionId);
    const nextSettings = await backend.saveSettings({
      ...get().settings,
      // 删除连接时同步清理人工排序，避免后续拖拽列表夹带无效 id。
      connectionOrder: get().settings.connectionOrder.filter((item) => item !== connectionId),
    });
    set((state) => {
      const removedSessionIds = state.sessions
        .filter((item) => item.connectionId === connectionId)
        .map((item) => item.id);
      const nextSessions = state.sessions.filter((item) => item.connectionId !== connectionId);
      const nextActiveSessionId = removedSessionIds.includes(state.activeSessionId ?? '')
        ? nextSessions[0]?.id
        : state.activeSessionId;
      const nextActiveConnectionId = nextActiveSessionId
        ? nextSessions.find((item) => item.id === nextActiveSessionId)?.connectionId
        : state.activeConnectionId === connectionId
          ? state.connections.find((item) => item.id !== connectionId)?.id
          : state.activeConnectionId;
      const deletedActiveConnection = state.activeConnectionId === connectionId;

      const nextCommandBuffers = { ...state.commandBuffers };
      const nextSuggestions = { ...state.suggestions };
      removedSessionIds.forEach((sessionId) => {
        delete nextCommandBuffers[sessionId];
        delete nextSuggestions[sessionId];
      });

      return {
        settings: nextSettings,
        connections: state.connections.filter((item) => item.id !== connectionId),
        sessions: nextSessions,
        activeConnectionId: nextActiveConnectionId,
        activeSessionId: nextActiveSessionId,
        runtimeOverview: deletedActiveConnection ? undefined : state.runtimeOverview,
        files: deletedActiveConnection ? [] : state.files,
        currentRemotePath: deletedActiveConnection ? nextSessions.find((item) => item.id === nextActiveSessionId)?.cwd ?? '' : state.currentRemotePath,
        commandBuffers: nextCommandBuffers,
        suggestions: nextSuggestions,
        statusMessage: statusText(state.settings, 'statusConnectionDeleted'),
      };
    });
  },

  duplicateConnection: async (connectionId, groupPath) => {
    const { connections, settings } = get();
    const source = connections.find((item) => item.id === connectionId);
    if (!source) {
      return;
    }

    const targetGroupPath = normalizeConnectionGroupPath(groupPath);
    const baseName = `${source.name} 副本`;
    const existingNames = new Set(connections.map((connection) => connection.name));
    let nextName = baseName;
    let copyIndex = 2;
    while (existingNames.has(nextName)) {
      nextName = `${baseName} ${copyIndex}`;
      copyIndex += 1;
    }

    // 复制连接时保留认证、标签和备注等配置，只替换 id、名称和当前分组选区，避免误改原连接。
    const duplicatedConnection: ConnectionProfile = {
      ...source,
      id: crypto.randomUUID(),
      name: nextName,
      groupPath: targetGroupPath || undefined,
      tags: [...source.tags],
    };
    const saved = await backend.upsertConnection(duplicatedConnection, false);
    const sourceIndex = settings.connectionOrder.indexOf(source.id);
    const nextConnectionOrder = settings.connectionOrder.filter((item) => item !== saved.id);
    if (sourceIndex >= 0) {
      nextConnectionOrder.splice(sourceIndex + 1, 0, saved.id);
    } else {
      nextConnectionOrder.unshift(saved.id);
    }

    const nextSettings = await backend.saveSettings({
      ...settings,
      connectionGroups: targetGroupPath
        ? mergeConnectionGroups(settings.connectionGroups, [targetGroupPath])
        : settings.connectionGroups,
      connectionOrder: nextConnectionOrder,
    });

    set((state) => ({
      settings: nextSettings,
      connections: [saved, ...state.connections.filter((item) => item.id !== saved.id)],
      activeConnectionId: saved.id,
      statusMessage: statusText(nextSettings, 'statusConnectionDuplicated', { name: saved.name }),
    }));
  },

  createConnectionGroup: async (groupPath) => {
    const normalized = normalizeConnectionGroupPath(groupPath);
    if (!normalized) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'validationGroupPathRequired'),
      }));
      return undefined;
    }

    const { connections, settings } = get();
    const exists = mergeConnectionGroups(settings.connectionGroups, connections.map((connection) => connection.groupPath))
      .some((item) => item === normalized);
    if (exists) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'validationGroupPathDuplicate'),
      }));
      return undefined;
    }

    // 新增空分组只写入 settings；没有连接时也必须能在连接管理里立即显示。
    const nextSettings = await backend.saveSettings({
      ...settings,
      connectionGroups: mergeConnectionGroups(settings.connectionGroups, [normalized]),
    });

    set({
      settings: nextSettings,
      statusMessage: statusText(nextSettings, 'statusGroupSaved', { path: normalized }),
    });
    return normalized;
  },

  renameConnectionGroup: async (currentPath, nextPath) => {
    const current = normalizeConnectionGroupPath(currentPath);
    const next = normalizeConnectionGroupPath(nextPath);
    if (!current || !next) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'validationGroupPathRequired'),
      }));
      return undefined;
    }
    if (current === next) {
      return current;
    }
    if (isGroupOrChildPath(next, current)) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'validationGroupMoveIntoSelf'),
      }));
      return undefined;
    }

    const { connections, settings } = get();
    const duplicated = mergeConnectionGroups(settings.connectionGroups, connections.map((connection) => connection.groupPath))
      .some((item) => item === next && !isGroupOrChildPath(item, current));
    if (duplicated) {
      set({
        statusMessage: statusText(settings, 'validationGroupPathDuplicate'),
      });
      return undefined;
    }

    const movePath = (value: string | undefined) => {
      const normalized = normalizeConnectionGroupPath(value);
      if (!isGroupOrChildPath(normalized, current)) {
        return normalized || undefined;
      }

      const suffix = normalized.slice(current.length).replace(/^\//, '');
      return suffix ? `${next}/${suffix}` : next;
    };

    // 重命名分组会级联改写子分组与连接 groupPath，逐条保存可避免并发写连接文件。
    const nextConnections = connections.map((connection) => {
      const movedPath = movePath(connection.groupPath);
      return movedPath === connection.groupPath ? connection : { ...connection, groupPath: movedPath };
    });
    for (const connection of nextConnections) {
      const previous = connections.find((item) => item.id === connection.id);
      if (previous?.groupPath !== connection.groupPath) {
        await backend.upsertConnection(connection, true);
      }
    }

    const movedSettingsGroups = settings.connectionGroups.map((group) => movePath(group));
    const nextSettings = await backend.saveSettings({
      ...settings,
      connectionGroups: mergeConnectionGroups(movedSettingsGroups, nextConnections.map((connection) => connection.groupPath)),
    });

    set({
      settings: nextSettings,
      connections: nextConnections,
      statusMessage: statusText(nextSettings, 'statusGroupRenamed', { path: next }),
    });
    return next;
  },

  deleteConnectionGroup: async (groupPath) => {
    const normalized = normalizeConnectionGroupPath(groupPath);
    if (!normalized) {
      return;
    }

    const { connections, settings } = get();
    const targets = connections.filter((connection) => isGroupOrChildPath(connection.groupPath, normalized));

    // 删除分组按用户选择执行级联删除：分组、子分组和其中连接全部删除，不再移动到未分组。
    for (const connection of targets) {
      await get().deleteConnection(connection.id);
    }

    const nextSettings = await backend.saveSettings({
      ...get().settings,
      connectionGroups: settings.connectionGroups.filter((item) => !isGroupOrChildPath(item, normalized)),
    });

    set({
      settings: nextSettings,
      statusMessage: statusText(nextSettings, 'statusGroupDeleted', { path: normalized }),
    });
  },

  reorderConnectionGroups: async (groupPaths) => {
    const { connections, settings } = get();
    // 分组排序保存完整显式分组列表，并补上连接中仍在使用但旧设置未显式保存的分组。
    const nextSettings = await backend.saveSettings({
      ...settings,
      connectionGroups: mergeConnectionGroups(groupPaths, settings.connectionGroups, connections.map((connection) => connection.groupPath)),
    });
    set({ settings: nextSettings, statusMessage: statusText(nextSettings, 'statusSettingsSaved') });
  },

  reorderConnections: async (connectionIds) => {
    const { connections, settings } = get();
    const existingIds = connections.map((connection) => connection.id);
    // 连接排序只保存仍存在的连接 id，未参与拖拽的新连接追加到末尾，保证列表不会丢项。
    const nextOrder = [
      ...connectionIds.filter((connectionId) => existingIds.includes(connectionId)),
      ...existingIds.filter((connectionId) => !connectionIds.includes(connectionId)),
    ];
    const nextSettings = await backend.saveSettings({ ...settings, connectionOrder: nextOrder });
    set({ settings: nextSettings, statusMessage: statusText(nextSettings, 'statusSettingsSaved') });
  },

  moveConnectionToGroup: async (connectionId, groupPath) => {
    const normalized = normalizeConnectionGroupPath(groupPath);
    const { connections, settings } = get();
    const connection = connections.find((item) => item.id === connectionId);
    if (!connection) {
      return;
    }

    // 拖到未分组时清空 groupPath；拖到真实分组时先保存连接，再补齐显式分组列表。
    const nextConnection: ConnectionProfile = {
      ...connection,
      groupPath: normalized || undefined,
    };
    const saved = await backend.upsertConnection(nextConnection, true);
    const nextSettings = await backend.saveSettings({
      ...settings,
      connectionGroups: normalized ? mergeConnectionGroups(settings.connectionGroups, [normalized]) : settings.connectionGroups,
    });

    set((state) => ({
      settings: nextSettings,
      connections: state.connections.map((item) => (item.id === saved.id ? saved : item)),
      statusMessage: statusText(nextSettings, 'statusSavedConnection', { name: saved.name }),
    }));
  },

  openSession: async (connectionId) => {
    const connection = get().connections.find((item) => item.id === connectionId);
    if (!connection) {
      return;
    }

    try {
      set({
        loading: true,
        statusMessage: statusText(get().settings, 'statusOpeningSession', { name: connection.name }),
      });
      const session = await backend.openSession(connectionId);
      const nextSession = { ...session, title: connection.name };
      set((state) => ({
        loading: false,
        sessions: [...state.sessions.filter((item) => item.id !== nextSession.id), nextSession],
        activeSessionId: nextSession.id,
        activeConnectionId: connectionId,
        statusMessage: statusText(state.settings, 'statusSessionReady', { name: connection.name }),
        files: [],
        currentRemotePath: nextSession.cwd ?? '~',
        runtimeOverview: undefined,
      }));
      // 文件、运行状态和首屏终端输出并行刷新，避免打开会话后等待远端状态查询阻塞终端交互。
      void Promise.allSettled([
        get().refreshFiles(nextSession.cwd ?? '~'),
        get().refreshRuntimeOverview(),
        get().pollTerminalOutputs(),
      ]);
    } catch (error) {
      set((state) => ({
        loading: false,
        statusMessage: statusText(state.settings, 'statusConnectionTestFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
    }
  },

  reconnectSession: async (sessionId) => {
    const state = get();
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) {
      return;
    }

    const connection = state.connections.find((item) => item.id === session.connectionId);
    if (!connection) {
      return;
    }

    const previousIndex = Math.max(0, state.sessions.findIndex((item) => item.id === sessionId));
    clearQueuedTerminalInput(sessionId);
    set({
      loading: true,
      statusMessage: statusText(state.settings, 'statusOpeningSession', { name: connection.name }),
    });

    try {
      try {
        await backend.closeSession(sessionId);
      } catch {
        // 重连以重新打开会话为主；旧后端会话已断开时仍继续创建新 PTY。
      }

      const openedSession = await backend.openSession(connection.id);
      const nextSession = { ...openedSession, title: connection.name };
      set((current) => {
        const filteredSessions = current.sessions.filter((item) => item.id !== sessionId && item.id !== nextSession.id);
        const insertIndex = Math.min(previousIndex, filteredSessions.length);
        const nextSessions = [
          ...filteredSessions.slice(0, insertIndex),
          nextSession,
          ...filteredSessions.slice(insertIndex),
        ];
        const nextCommandBuffers = { ...current.commandBuffers };
        const nextSuggestions = { ...current.suggestions };
        delete nextCommandBuffers[sessionId];
        delete nextSuggestions[sessionId];

        return {
          loading: false,
          sessions: nextSessions,
          activeSessionId: nextSession.id,
          activeConnectionId: connection.id,
          commandBuffers: nextCommandBuffers,
          suggestions: nextSuggestions,
          files: [],
          currentRemotePath: nextSession.cwd ?? '~',
          runtimeOverview: undefined,
          statusMessage: statusText(current.settings, 'statusSessionReady', { name: connection.name }),
        };
      });

      // 重连后保持原标签位置，但远端文件、状态和终端首屏输出需要按新 session 重新拉取。
      void Promise.allSettled([
        get().refreshFiles(nextSession.cwd ?? '~'),
        get().refreshRuntimeOverview(),
        get().pollTerminalOutputs(),
      ]);
    } catch (error) {
      set((current) => ({
        loading: false,
        statusMessage: statusText(current.settings, 'statusConnectionTestFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
    }
  },

  reorderSessions: (sessionIds) =>
    set((state) => {
      const orderedIds = Array.from(new Set(sessionIds));
      const orderedSessions = orderedIds
        .map((sessionId) => state.sessions.find((session) => session.id === sessionId))
        .filter((session): session is TerminalSession => Boolean(session));
      const remainingSessions = state.sessions.filter((session) => !orderedIds.includes(session.id));

      // 标签排序只改前端顺序，不触碰后端 PTY；缺失 id 兜底追加，避免拖拽中状态刷新造成标签丢失。
      return { sessions: [...orderedSessions, ...remainingSessions] };
    }),

  closeSession: async (sessionId) => {
    clearQueuedTerminalInput(sessionId);
    try {
      await backend.closeSession(sessionId);
    } catch {
      // 关闭标签以清理前端状态为主；后端会话已丢失时仍允许用户从界面移除坏标签。
    }
    set((state) => {
      const nextSessions = state.sessions.filter((item) => item.id !== sessionId);
      const nextActiveSessionId = state.activeSessionId === sessionId ? nextSessions[0]?.id : state.activeSessionId;
      const nextActiveConnectionId = nextActiveSessionId
        ? nextSessions.find((item) => item.id === nextActiveSessionId)?.connectionId
        : undefined;
      const closedActiveSession = state.activeSessionId === sessionId;
      const nextActiveSession = nextActiveSessionId
        ? nextSessions.find((item) => item.id === nextActiveSessionId)
        : undefined;
      const nextCommandBuffers = { ...state.commandBuffers };
      const nextSuggestions = { ...state.suggestions };
      delete nextCommandBuffers[sessionId];
      delete nextSuggestions[sessionId];

      return {
        sessions: nextSessions,
        activeSessionId: nextActiveSessionId,
        activeConnectionId: nextActiveConnectionId,
        runtimeOverview: nextActiveConnectionId ? state.runtimeOverview : undefined,
        files: closedActiveSession ? [] : state.files,
        currentRemotePath: closedActiveSession ? nextActiveSession?.cwd ?? '' : state.currentRemotePath,
        commandBuffers: nextCommandBuffers,
        suggestions: nextSuggestions,
        statusMessage: statusText(state.settings, 'statusSessionClosed'),
      };
    });
  },

  setCommandBuffer: (sessionId, value) =>
    set((state) => ({
      commandBuffers: {
        ...state.commandBuffers,
        [sessionId]: value,
      },
    })),

  acceptSuggestion: (sessionId, suggestion) =>
    set((state) => ({
      commandBuffers: {
        ...state.commandBuffers,
        [sessionId]: suggestion,
      },
      suggestions: {
        ...state.suggestions,
        [sessionId]: suggestion ? [suggestion] : [],
      },
    })),

  requestSuggestions: async (sessionId, connectionId, prefix) => {
    if (!prefix.trim()) {
      set((state) => ({ suggestions: { ...state.suggestions, [sessionId]: [] } }));
      return;
    }

    const suggestions = await backend.getSuggestions(connectionId, prefix);
    set((state) => ({
      suggestions: {
        ...state.suggestions,
        [sessionId]: suggestions,
      },
    }));
  },

  sendCommand: async (sessionId) => {
    const state = get();
    const rawCommand = state.commandBuffers[sessionId] ?? '';
    const command = rawCommand.trim();
    if (!command) {
      return;
    }

    const session = state.sessions.find((item) => item.id === sessionId);
    if (!isUsableRemoteSession(session?.status)) {
      return;
    }
    const nextRemotePath = session?.connectionId === state.activeConnectionId
      ? guessNextRemotePath(state.currentRemotePath, rawCommand)
      : undefined;

    await flushQueuedTerminalInput(sessionId);
    await backend.writeTerminalInput(sessionId, rawCommand.endsWith('\n') ? rawCommand : `${rawCommand}\n`);

    set((prev) => ({
      commandBuffers: { ...prev.commandBuffers, [sessionId]: '' },
      suggestions: { ...prev.suggestions, [sessionId]: [] },
      statusMessage: statusText(prev.settings, 'statusSentCommand', { target: session?.title ?? 'session' }),
    }));

    await get().pollTerminalOutputs();
    if (session?.connectionId) {
      void get().refreshRemoteHistory(session.connectionId);
    }
    if (nextRemotePath) {
      await get().refreshFiles(nextRemotePath);
    }
  },

  sendTerminalData: async (sessionId, data) => {
    const session = get().sessions.find((item) => item.id === sessionId);
    if (!isUsableRemoteSession(session?.status)) {
      return;
    }

    queueTerminalInput(sessionId, data, isTerminalEditingInput(data) ? terminalEditingInputFlushDelayMs : terminalInputFlushDelayMs);
    if (data === '\r' || data === '\n') {
      await flushQueuedTerminalInput(sessionId);
      await get().pollTerminalOutputs();
      return;
    }
  },

  passthroughTab: async (sessionId) => {
    queueTerminalInput(sessionId, '\t');
    await flushQueuedTerminalInput(sessionId);
    await get().pollTerminalOutputs();
  },

  runQuickCommand: async (command) => {
    const { activeSessionId } = get();
    if (!activeSessionId) {
      return;
    }

    set((state) => ({
      commandBuffers: {
        ...state.commandBuffers,
        [activeSessionId]: command,
      },
    }));
    await get().sendCommand(activeSessionId);
  },

  pollTerminalOutputs: async () => {
    const { sessions } = get();
    if (!sessions.length) {
      return;
    }

    const settledOutputs = await Promise.allSettled(sessions.map((session) => backend.readTerminalOutput(session.id)));
    const outputFailures = new Set<string>();
    settledOutputs.forEach((result, index) => {
      if (result.status === 'rejected') {
        outputFailures.add(sessions[index]?.id ?? '');
      }
    });
    const outputs = settledOutputs
      .filter((result): result is PromiseFulfilledResult<TerminalOutputChunk[]> => result.status === 'fulfilled')
      .map((result) => result.value);
    const chunks = outputs.flat();
    chunks.forEach(emitTerminalOutput);

    // 远端 Shell 通过后端元数据回传 cwd/status：cwd 同步文件管理，status 只更新标签图标。
    const cwdBySession = new Map<string, string>();
    const statusBySession = new Map<string, SessionStatus>();
    chunks.forEach((chunk) => {
      const cwd = chunk.cwd?.trim();
      if (cwd) {
        cwdBySession.set(chunk.sessionId, cwd);
      }
      if (chunk.status) {
        statusBySession.set(chunk.sessionId, chunk.status);
      }
    });

    outputFailures.forEach((sessionId) => {
      if (sessionId) {
        statusBySession.set(sessionId, 'error');
      }
    });

    if (!cwdBySession.size && !statusBySession.size) {
      return;
    }

    let activeCwdToRefresh: string | undefined;
    set((state) => {
      let sessionsChanged = false;
      const nextSessions = state.sessions.map((session) => {
        const cwd = cwdBySession.get(session.id);
        const status = statusBySession.get(session.id);
        let nextSession = session;

        if (cwd && session.cwd !== cwd) {
          nextSession = { ...nextSession, cwd };
          sessionsChanged = true;
        }
        if (status && session.status !== status) {
          nextSession = { ...nextSession, status };
          sessionsChanged = true;
        }

        if (
          cwd &&
          session.id === state.activeSessionId &&
          session.connectionId === state.activeConnectionId &&
          isUsableRemoteSession(nextSession.status) &&
          state.currentRemotePath !== cwd
        ) {
          activeCwdToRefresh = cwd;
        }

        return nextSession;
      });

      const activeSession = nextSessions.find((session) => session.id === state.activeSessionId);
      const activeSessionBecameUnavailable = activeSession ? !isUsableRemoteSession(activeSession.status) : false;
      const shouldClearActiveRemoteData = activeSessionBecameUnavailable
        && (state.files.length > 0 || Boolean(state.runtimeOverview) || Boolean(state.currentRemotePath));

      return {
        ...(sessionsChanged ? { sessions: nextSessions } : {}),
        ...(shouldClearActiveRemoteData ? { files: [], runtimeOverview: undefined, currentRemotePath: '' } : {}),
      };
    });

    if (activeCwdToRefresh) {
      await get().refreshFiles(activeCwdToRefresh);
    }
  },

  // 历史 Tab 以远端 Shell 历史文件为来源，刷新当前连接时替换对应连接缓存。
  refreshRemoteHistory: async (connectionId) => {
    const { activeSessionId, sessions } = get();
    const activeSession = sessions.find((item) => item.id === activeSessionId);
    const activeRemoteConnectionId = isUsableRemoteSession(activeSession?.status) ? activeSession?.connectionId : undefined;
    const targetConnectionId = connectionId ?? activeRemoteConnectionId;
    // 历史刷新只允许针对已打开的当前会话，避免仅选中连接时主动访问远端。
    if (!targetConnectionId || targetConnectionId !== activeRemoteConnectionId) {
      return;
    }

    const requestSeq = ++remoteHistoryRefreshSeq;
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
        statusMessage: statusText(state.settings, 'statusLoadedRemoteHistory'),
      }));
    } catch (error) {
      if (requestSeq !== remoteHistoryRefreshSeq) {
        return;
      }

      set((state) => ({
        statusMessage: statusText(state.settings, 'statusRemoteHistoryFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
    }
  },

  refreshFiles: async (path) => {
    const { activeConnectionId, activeSessionId, currentRemotePath, sessions } = get();
    const activeSession = sessions.find((item) => item.id === activeSessionId);
    const activeRemoteConnectionId = isUsableRemoteSession(activeSession?.status) ? activeSession?.connectionId : undefined;
    // 文件管理必须绑定已打开的终端会话；只选中连接时不展示也不刷新远端文件。
    if (!activeConnectionId || activeConnectionId !== activeRemoteConnectionId) {
      return;
    }

    const nextPath = path ?? currentRemotePath;
    const requestConnectionId = activeConnectionId;
    const requestSeq = ++remoteFilesRefreshSeq;
    try {
      const files = await backend.listRemoteFiles(activeConnectionId, nextPath);
      if (requestSeq !== remoteFilesRefreshSeq || get().activeConnectionId !== requestConnectionId) {
        return;
      }

      set({ files, currentRemotePath: nextPath, statusMessage: statusText(get().settings, 'statusLoadedPath', { path: nextPath }) });
    } catch (error) {
      if (requestSeq !== remoteFilesRefreshSeq || get().activeConnectionId !== requestConnectionId) {
        return;
      }

      set((state) => ({
        statusMessage: statusText(state.settings, 'statusRemoteFilesFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
    }
  },

  uploadLocalFile: async (file) => {
    const { activeConnectionId, currentRemotePath } = get();
    if (!activeConnectionId) {
      return;
    }

    try {
      const contentBase64 = await toBase64(file);
      await backend.uploadRemoteFile(activeConnectionId, currentRemotePath, file.name, contentBase64);
      await get().refreshFiles(currentRemotePath);
      set({ statusMessage: statusText(get().settings, 'statusUploadedFile', { name: file.name }) });
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusFileOperationFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
      throw error;
    }
  },

  downloadRemoteFile: async (path) => {
    const { activeConnectionId } = get();
    if (!activeConnectionId) {
      return;
    }

    try {
      const localPath = await backend.downloadRemoteFile(activeConnectionId, path);
      set({ statusMessage: statusText(get().settings, 'statusDownloadedFile', { path: localPath }) });
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusFileOperationFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
      throw error;
    }
  },

  deleteRemotePath: async (path) => {
    const { activeConnectionId, currentRemotePath } = get();
    if (!activeConnectionId) {
      return;
    }

    try {
      await backend.deleteRemotePath(activeConnectionId, path);
      await get().refreshFiles(currentRemotePath);
      set({ statusMessage: statusText(get().settings, 'statusDeletedPath', { path }) });
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusFileOperationFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
      throw error;
    }
  },

  deleteRemotePaths: async (paths) => {
    const { activeConnectionId, currentRemotePath } = get();
    const normalizedPaths = Array.from(new Set(paths.filter(Boolean)));
    if (!activeConnectionId || !normalizedPaths.length) {
      return;
    }

    try {
      // 多选删除使用后端批量 SFTP 命令，删除完再刷新一次目录，避免连续刷新拖慢 UI。
      await backend.deleteRemotePaths(activeConnectionId, normalizedPaths);
      await get().refreshFiles(currentRemotePath);
      set({
        statusMessage: normalizedPaths.length === 1
          ? statusText(get().settings, 'statusDeletedPath', { path: normalizedPaths[0] })
          : statusText(get().settings, 'statusDeletedPaths', { count: normalizedPaths.length }),
      });
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusFileOperationFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
      throw error;
    }
  },

  renameRemotePath: async (path, newName) => {
    const { activeConnectionId, currentRemotePath } = get();
    if (!activeConnectionId || !newName.trim()) {
      return;
    }

    try {
      const nextPath = `${parentRemotePath(path).replace(/\/$/, '')}/${newName.trim()}`.replace('//', '/');
      await backend.renameRemotePath(activeConnectionId, path, nextPath);
      await get().refreshFiles(currentRemotePath);
      set({ statusMessage: statusText(get().settings, 'statusRenamedPath', { name: newName.trim() }) });
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusFileOperationFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
      throw error;
    }
  },

  refreshRuntimeOverview: async () => {
    const { activeConnectionId, activeSessionId, sessions } = get();
    const activeSession = sessions.find((item) => item.id === activeSessionId);
    const activeRemoteConnectionId = isUsableRemoteSession(activeSession?.status) ? activeSession?.connectionId : undefined;
    // 运行状态只跟随已打开会话刷新，刷新完成后一次性替换旧数据，不显示中间“刷新中”状态。
    if (!activeConnectionId || activeConnectionId !== activeRemoteConnectionId) {
      set({ runtimeOverview: undefined });
      return;
    }

    const requestConnectionId = activeConnectionId;
    const requestSeq = ++runtimeOverviewRefreshSeq;
    try {
      const runtimeOverview = await backend.fetchRuntimeOverview(activeConnectionId);
      if (requestSeq !== runtimeOverviewRefreshSeq || get().activeConnectionId !== requestConnectionId) {
        return;
      }

      set({ runtimeOverview });
    } catch {
      if (requestSeq !== runtimeOverviewRefreshSeq || get().activeConnectionId !== requestConnectionId) {
        return;
      }

      set({ runtimeOverview: undefined });
    }
  },

  openRemoteFile: async (path) => {
    const { activeConnectionId } = get();
    if (!activeConnectionId) {
      return;
    }

    try {
      const editorDocument = await backend.loadEditorDocument(activeConnectionId, path);
      set({ editorDocument, statusMessage: statusText(get().settings, 'statusOpenedFile', { path }) });
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusFileOperationFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
      throw error;
    }
  },

  closeEditorDocument: () =>
    set({
      editorDocument: undefined,
    }),

  setEditorContent: (content) =>
    set((state) => ({
      editorDocument: state.editorDocument
        ? {
            ...state.editorDocument,
            content,
            dirty: true,
          }
        : undefined,
    })),

  saveEditorDocument: async () => {
    const { editorDocument } = get();
    if (!editorDocument) {
      return;
    }

    try {
      await backend.saveEditorDocument(editorDocument.connectionId, editorDocument.path, editorDocument.content);
      set({
        editorDocument: { ...editorDocument, dirty: false },
        statusMessage: statusText(get().settings, 'statusSavedFile', { path: editorDocument.path }),
      });
      await get().refreshFiles(parentRemotePath(editorDocument.path) || '~');
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusFileOperationFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
    }
  },

  updateSettings: (updater) => set((state) => ({ settings: updater(state.settings) })),

  persistSettings: async (settingsDraft) => {
    // 设置页使用草稿编辑，只有用户点击保存时才把草稿写入全局状态和本地文件。
    const settings = await backend.saveSettings(settingsDraft ?? get().settings);
    set({ settings, statusMessage: statusText(settings, 'statusSettingsSaved') });
    return settings;
  },

  testWebdavConnection: async (settingsDraft) => {
    const settings = settingsDraft ?? get().settings;
    await backend.testWebdavConnection(settings);
    set({ statusMessage: statusText(settings, 'statusWebdavTestPassed') });
  },

  uploadSettings: async () => {
    await get().persistSettings();
    await backend.uploadSettings();
    set({ statusMessage: statusText(get().settings, 'statusUploadedSettings') });
  },

  downloadSettings: async () => {
    const settings = await backend.downloadSettings();
    set({ settings, statusMessage: statusText(settings, 'statusDownloadedSettings') });
  },

  uploadConnections: async () => {
    await backend.uploadConnections();
    set({ statusMessage: statusText(get().settings, 'statusUploadedConnections') });
  },

  downloadConnections: async () => {
    const connections = await backend.downloadConnections();
    set({ connections, statusMessage: statusText(get().settings, 'statusDownloadedConnections') });
  },

  exportLocalConfig: async (targetPath) => {
    const path = await backend.exportLocalConfig(targetPath);
    set({ statusMessage: statusText(get().settings, 'statusExportedLocalConfig', { path }) });
  },

  importLocalConfig: async (file) => {
    const content = await file.text();
    const nextState = await backend.importLocalConfig(content);
    const nextActiveSessionId = nextState.sessions[0]?.id;
    const nextActiveConnectionId = nextState.sessions[0]?.connectionId;
    set({
      settings: nextState.settings,
      connections: nextState.connections,
      history: nextState.history,
      sessions: nextState.sessions,
      tunnels: nextState.tunnels,
      activeConnectionId: nextActiveConnectionId,
      activeSessionId: nextActiveSessionId,
      commandBuffers: {},
      suggestions: {},
      files: [],
      // 导入配置后只有已有会话才展示远端路径，避免刚导入就像已连接主机一样显示远端文件。
      currentRemotePath: nextActiveSessionId ? '~' : '',
      runtimeOverview: undefined,
      editorDocument: undefined,
      statusMessage: statusText(nextState.settings, 'statusImportedLocalConfig', { name: file.name }),
    });
  },

  checkForUpdates: async () => {
    // 更新检测走 GitHub Release 元数据，不直接下载安装，避免在未确认前产生外部副作用。
    const result = await backend.checkForUpdates();
    set((state) => ({
      statusMessage: result.updateAvailable
        ? statusText(state.settings, 'statusUpdateAvailable', { version: result.latestVersion })
        : statusText(state.settings, 'statusUpdateNotAvailable'),
    }));
    return result;
  },

  installUpdate: async (result) => {
    if (!result.installerDownloadUrl || !result.installerAssetName) {
      set((state) => ({ statusMessage: statusText(state.settings, 'statusUpdateInstallerMissing') }));
      return;
    }

    try {
      set((state) => ({
        loading: true,
        statusMessage: statusText(state.settings, 'statusUpdateDownloading'),
      }));
      await backend.installUpdate(result);
      set((state) => ({
        loading: false,
        statusMessage: statusText(state.settings, 'statusUpdateInstallStarted'),
      }));
    } catch (error) {
      set((state) => ({
        loading: false,
        statusMessage: statusText(state.settings, 'statusUpdateInstallFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
    }
  },

  openTunnel: async () => {
    const { activeConnectionId, connections } = get();
    if (!activeConnectionId) {
      return;
    }

    const connection = connections.find((item) => item.id === activeConnectionId);
    if (!connection) {
      return;
    }

    set(() => ({
      showTunnelForm: true,
      tunnelDraft: {
        name: `${connection.name} DB tunnel`,
        bindAddress: '127.0.0.1',
        localPort: 15432,
        remoteHost: '127.0.0.1',
        remotePort: 5432,
      },
      activePanel: 'tunnels',
    }));
  },

  startTunnel: async (tunnelId) => {
    const tunnel = await backend.startTunnel(tunnelId);
    set((state) => ({
      tunnels: state.tunnels.map((item) => (item.id === tunnel.id ? tunnel : item)),
      statusMessage: statusText(state.settings, 'statusTunnelCreated'),
    }));
  },

  startAllTunnels: async () => {
    const stoppedTunnels = get().tunnels.filter((item) => item.status !== 'running');
    if (!stoppedTunnels.length) {
      return;
    }

    const restarted = await Promise.all(stoppedTunnels.map((item) => backend.startTunnel(item.id)));
    set((state) => ({
      tunnels: state.tunnels.map((item) => restarted.find((next) => next.id === item.id) ?? item),
      statusMessage: statusText(state.settings, 'statusAllTunnelsStarted'),
    }));
  },

  stopAllTunnels: async () => {
    const runningTunnels = get().tunnels.filter((item) => item.status === 'running');
    if (!runningTunnels.length) {
      return;
    }

    await Promise.all(runningTunnels.map((item) => backend.closeTunnel(item.id)));
    set((state) => ({
      tunnels: state.tunnels.map((item) =>
        runningTunnels.some((running) => running.id === item.id) ? { ...item, status: 'stopped' } : item,
      ),
      statusMessage: statusText(state.settings, 'statusAllTunnelsStopped'),
    }));
  },

  closeTunnel: async (tunnelId) => {
    await backend.closeTunnel(tunnelId);
    set((state) => ({
      tunnels: state.tunnels.map((item) => (item.id === tunnelId ? { ...item, status: 'stopped' } : item)),
      statusMessage: statusText(state.settings, 'statusTunnelStopped'),
    }));
  },
}));
