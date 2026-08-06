import { create } from 'zustand';

import { backend } from './backend';
import { translate } from './i18n';
import {
  clearQueuedTerminalInput,
  extractCompletedTerminalInputLines,
  flushQueuedTerminalInput,
  isBulkTerminalInput,
  normalizeCommandPanelTerminalInput,
  normalizeRemoteTerminalContinuationEnter,
  queueTerminalInput,
  shouldFlushTerminalInputImmediately,
  terminalBulkInputFlushDelayMs,
  terminalInteractiveInputFlushDelayMs,
} from './application/terminal/inputQueue';
import {
  buildConnectionProfile,
  emptyConnectionDraft,
  emptyJumpHostDraft,
  emptyProxyDraft,
  getConnectionDraftValidationKey,
  isGroupOrChildPath,
  mergeConnectionGroups,
  normalizeConnectionGroupPath,
  normalizeLoadedConnection,
} from './domain/connections/model';
import { isUsableRemoteSession, isUsableTerminalSession } from './domain/sessions/model';
import { defaultLocalTerminals, defaultSettings } from './domain/settings/defaults';
import { guessNextRemotePath, parentRemotePath } from './domain/terminal/navigation';
import { emptyTunnelDraft, getTunnelDraftValidationKey } from './domain/tunnels/model';
import { toBase64, uploadRemoteName } from './infrastructure/fileTransfer';
import type {
  AppSettings,
  ConnectionDraft,
  ConnectionProfile,
  EditorDocument,
  HistoryEntry,
  LocalTerminalProfile,
  LocalTerminalSettings,
  RemoteFileEntry,
  RuntimeOverview,
  SessionStatus,
  TerminalSession,
  TerminalOutputChunk,
  TunnelDraft,
  TunnelOpenRequest,
  TunnelRecord,
  TunnelUpdateRequest,
  UpdateCheckResult,
  WorkspacePanel,
} from './types';

// 状态栏展示命令名时把空命令转成可读名称，避免用户看到空白提示。
const localTerminalCommandLabel = (settings: AppSettings, command: string) =>
  command.trim() || translate(settings.uiLanguage, 'localTerminalTitle');

const terminalOutputEventName = 'myterminal-terminal-output';

// 终端输出和 PTY 尺寸时间线走浏览器事件直达 xterm，避免高频数据通过 React 状态触发整页重渲染。
const emitTerminalOutput = (chunk: TerminalOutputChunk) => {
  const hasTerminalSize = Number.isInteger(chunk.cols) && Number.isInteger(chunk.rows);
  if (typeof window === 'undefined' || (!chunk.content && !hasTerminalSize)) {
    return;
  }

  window.dispatchEvent(new CustomEvent(terminalOutputEventName, { detail: chunk }));
};

// 自动重连计划：仅针对已成功连上又掉线的 SSH 会话，按指数退避有限次重试，避免永久断连。
// 用模块级 Map（而非 React 状态）保存，重连不触发整页重渲染；会话 ID 在每次重连后变化，需迁移条目。
type AutoReconnectEntry = { attempts: number; timer?: number; connectionId: string };
const autoReconnectBySession = new Map<string, AutoReconnectEntry>();
// 最多自动重连次数；超过后停止并提示用户手动重连，防止对不可达主机无限重试。
const AUTO_RECONNECT_MAX_ATTEMPTS = 6;
// 指数退避（首次约 1s，之后翻倍，封顶 30s）；attempt 从 1 起。
const autoReconnectDelayMs = (attempt: number) => Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));

// 取消并清理某会话的自动重连计划（用户主动关闭、手动重连或已稳定连上时调用）。
const cancelAutoReconnect = (sessionId: string) => {
  const entry = autoReconnectBySession.get(sessionId);
  if (entry?.timer) {
    window.clearTimeout(entry.timer);
  }
  autoReconnectBySession.delete(sessionId);
};

// 远端刷新请求可能被快速 cd、目录双击或自动轮询连续触发；序号只允许最后一次结果落到界面。
let remoteFilesRefreshSeq = 0;
let runtimeOverviewRefreshSeq = 0;
let remoteHistoryRefreshSeq = 0;
type RemoteFilesRefreshRequest = { connectionId: string; path: string; seq: number };
let remoteFilesRefreshInFlight = false;
// 当前执行项与最后排队项共同描述文件管理器的真实目标，cwd 回传据此避免重复列举同一路径，并能覆盖错误预判。
let remoteFilesActiveRequest: RemoteFilesRefreshRequest | undefined;
let remoteFilesQueuedRequest: RemoteFilesRefreshRequest | undefined;

// 文件管理请求统一路径格式，避免 /ology 与 /ology/ 被误判为两个目录并重复触发 SFTP 列举。
const normalizeRemoteFilesPath = (path: string) => {
  const normalized = path.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!normalized) {
    return '~';
  }
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
};

const isSameRemoteFilesTarget = (
  request: Pick<RemoteFilesRefreshRequest, 'connectionId' | 'path'> | undefined,
  connectionId: string,
  path: string,
) => Boolean(
  request
  && request.connectionId === connectionId
  && normalizeRemoteFilesPath(request.path) === normalizeRemoteFilesPath(path),
);

// 排队项代表最新意图；没有排队项时，正在执行的请求才是当前文件管理目标。
const latestPendingRemoteFilesRequest = () => remoteFilesQueuedRequest ?? remoteFilesActiveRequest;

const statusText = (
  settings: AppSettings,
  key: Parameters<typeof translate>[1],
  replacements?: Parameters<typeof translate>[2],
) => translate(settings.uiLanguage, key, replacements);

type ConnectionTestResult = {
  kind: 'success' | 'error';
  message: string;
};

type StoreState = {
  bootstrapped: boolean;
  loading: boolean;
  statusMessage: string;
  settings: AppSettings;
  localTerminals: LocalTerminalSettings;
  connections: ConnectionProfile[];
  history: HistoryEntry[];
  sessions: TerminalSession[];
  tunnels: TunnelRecord[];
  commandBuffers: Record<string, string>;
  suggestions: Record<string, string[]>;
  files: RemoteFileEntry[];
  currentRemotePath: string;
  runtimeOverview?: RuntimeOverview;
  // 三个远端面板各自的刷新态：仅在“无旧内容可展示”时才用于显示刷新动画，避免定时刷新时闪烁。
  runtimeLoading: boolean;
  filesLoading: boolean;
  historyLoading: boolean;
  connectionTestResult?: ConnectionTestResult;
  editorDocument?: EditorDocument;
  activeConnectionId?: string;
  activeSessionId?: string;
  activePanel: WorkspacePanel;
  showConnectionForm: boolean;
  connectionDraft: ConnectionDraft;
  showTunnelForm: boolean;
  tunnelDraft: TunnelDraft;
  // 全局缓存的更新检测结果，首页工具栏按钮和定时检测共用，避免每次都重新请求。
  updateCheckResult: UpdateCheckResult | null;
  bootstrap: () => Promise<void>;
  setStatusMessage: (message: string) => void;
  clearConnectionTestResult: () => void;
  setActivePanel: (panel: WorkspacePanel) => void;
  setActiveConnectionId: (connectionId?: string) => void;
  selectSession: (sessionId?: string) => void;
  openConnectionForm: (connection?: ConnectionProfile, groupPath?: string) => void;
  closeConnectionForm: () => void;
  updateConnectionDraft: <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) => void;
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
  /** 登记由后端自行创建的终端会话（AI 可见执行自动开标签），前端未发起过 openSession 时也能显示。 */
  adoptSession: (session: TerminalSession) => void;
  saveLocalTerminals: (settings: LocalTerminalSettings) => Promise<LocalTerminalSettings>;
  openLocalTerminal: (profile: LocalTerminalProfile) => Promise<void>;
  /** 复制标签页：按源标签的连接或本地启动项再开一条同类会话，新标签插在源标签右侧。 */
  duplicateSession: (sessionId: string) => Promise<void>;
  reconnectSession: (sessionId: string) => Promise<void>;
  // 为刚掉线的 SSH 会话启动自动重连计划（幂等：已在计划中则忽略）。
  scheduleAutoReconnect: (sessionId: string) => void;
  // 执行一次自动重连尝试并按需安排下一次；由 scheduleAutoReconnect 与看门狗定时器驱动。
  runAutoReconnect: (sessionId: string) => Promise<void>;
  reorderSessions: (sessionIds: string[]) => void;
  closeSession: (sessionId: string) => Promise<void>;
  setCommandBuffer: (sessionId: string, value: string) => void;
  acceptSuggestion: (sessionId: string, suggestion: string) => void;
  requestSuggestions: (sessionId: string, connectionId: string | undefined, prefix: string) => Promise<void>;
  sendCommand: (sessionId: string) => Promise<void>;
  sendTerminalData: (sessionId: string, data: string) => Promise<void>;
  passthroughTab: (sessionId: string) => Promise<void>;
  runQuickCommand: (command: string) => Promise<void>;
  pollTerminalOutputs: (sessionId?: string) => Promise<void>;
  refreshRemoteHistory: (connectionId?: string) => Promise<void>;
  refreshFiles: (path?: string) => Promise<void>;
  uploadLocalFile: (file: File) => Promise<void>;
  uploadLocalFiles: (files: File[]) => Promise<void>;
  uploadLocalPaths: (localPaths: string[]) => Promise<void>;
  downloadRemoteFile: (path: string) => Promise<void>;
  downloadRemotePaths: (paths: string[], localDir?: string) => Promise<void>;
  deleteRemotePath: (path: string) => Promise<void>;
  deleteRemotePaths: (paths: string[]) => Promise<void>;
  renameRemotePath: (path: string, newName: string) => Promise<void>;
  copyRemotePaths: (sources: string[], targetDir: string) => Promise<void>;
  refreshRuntimeOverview: () => Promise<void>;
  openRemoteFile: (path: string) => Promise<void>;
  closeEditorDocument: () => void;
  setEditorContent: (content: string) => void;
  saveEditorDocument: () => Promise<void>;
  updateSettings: (updater: (settings: AppSettings) => AppSettings) => void;
  persistSettings: (settings?: AppSettings) => Promise<AppSettings>;
  testWebdavConnection: (settings?: AppSettings) => Promise<void>;
  uploadConfig: () => Promise<void>;
  downloadConfig: (remotePath: string) => Promise<void>;
  exportLocalConfig: (targetPath: string) => Promise<void>;
  importLocalConfig: (file: File) => Promise<void>;
  checkForUpdates: () => Promise<UpdateCheckResult>;
  // 更新安装必须返回后端落盘路径，并把异常继续抛给设置页，避免按钮恢复后没有可见反馈。
  installUpdate: (result: UpdateCheckResult) => Promise<string>;
  openTunnel: () => Promise<void>;
  // 隧道编辑复用新增弹窗，草稿中的 id 用来决定保存时走新增还是更新。
  editTunnel: (tunnel: TunnelRecord) => void;
  startTunnel: (tunnelId: string) => Promise<void>;
  startAllTunnels: () => Promise<void>;
  stopAllTunnels: () => Promise<void>;
  closeTunnel: (tunnelId: string) => Promise<void>;
  // 后台隧道监控探测到状态变化时由事件监听器调用，将最新状态写回面板。
  applyTunnelStatusChange: (tunnel: TunnelRecord) => void;
};

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
  setActiveConnectionId: (activeConnectionId) =>
    set((state) => {
      const matchedSession = activeConnectionId
        ? state.sessions.find((item) => item.connectionId === activeConnectionId)
        : undefined;
      const keepCurrentFiles = Boolean(matchedSession && matchedSession.connectionId === state.activeConnectionId);
      // 切到同一连接的其它会话时保留运行状态/文件旧内容，避免整块回退成空白；只有真正换连接才清空。
      const willRefreshRemote = isUsableRemoteSession(matchedSession);

      return {
        activeConnectionId,
        activeSessionId: matchedSession?.id,
        runtimeOverview: keepCurrentFiles ? state.runtimeOverview : undefined,
        // 只有换到别的连接且需要拉取远端时才进入加载态显示刷新动画；保留旧内容时不显示动画。
        runtimeLoading: willRefreshRemote && !keepCurrentFiles,
        files: keepCurrentFiles ? state.files : [],
        filesLoading: willRefreshRemote && !keepCurrentFiles,
        currentRemotePath: matchedSession?.cwd ?? '',
      };
    }),
  selectSession: (activeSessionId) =>
    set((state) => {
      const matchedSession = activeSessionId
        ? state.sessions.find((item) => item.id === activeSessionId)
        : undefined;
      const keepCurrentFiles = Boolean(matchedSession && matchedSession.kind !== 'local' && matchedSession.connectionId === state.activeConnectionId);
      const willRefreshRemote = isUsableRemoteSession(matchedSession);

      return {
        activeSessionId,
        activeConnectionId: matchedSession?.kind === 'local' ? undefined : matchedSession?.connectionId,
        runtimeOverview: keepCurrentFiles ? state.runtimeOverview : undefined,
        runtimeLoading: willRefreshRemote && !keepCurrentFiles,
        files: keepCurrentFiles ? state.files : [],
        filesLoading: willRefreshRemote && !keepCurrentFiles,
        currentRemotePath: matchedSession?.kind === 'local' ? '' : matchedSession?.cwd ?? '',
      };
    }),

  openConnectionForm: (connection, groupPath) =>
    set({
      showConnectionForm: true,
      connectionTestResult: undefined,
      connectionDraft: connection
        ? {
            ...connection,
            protocol: connection.protocol === 'rdp' ? 'rdp' : 'ssh',
            authMethod: connection.authMethod ?? 'password',
            groupPath: connection.groupPath ?? '',
            password: connection.password ?? '',
            privateKeyPath: connection.privateKeyPath ?? '',
            privateKeyText: connection.privateKeyText ?? '',
            passphrase: connection.passphrase ?? '',
            jumpHosts: Array.isArray(connection.jumpHosts)
              ? connection.jumpHosts.map((jumpHost) => ({ ...emptyJumpHostDraft(), ...jumpHost }))
              : [],
            proxy: connection.proxy ? { ...emptyProxyDraft(), ...connection.proxy } : emptyProxyDraft(),
            note: connection.note ?? '',
          }
        : {
            ...emptyConnectionDraft(),
            // 从连接管理的当前目录新建时预填 groupPath，减少重复手输路径和误建到未分组的概率。
            groupPath: normalizeConnectionGroupPath(groupPath),
          },
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
            ? state.connections.map((item) => (item.id === saved.id ? normalizeLoadedConnection(saved) : item))
            : [normalizeLoadedConnection(saved), ...state.connections],
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
      statusMessage: statusText(state.settings, connection.protocol === 'rdp' ? 'statusTestingRdp' : 'statusTestingConnection'),
    }));

    try {
      // RDP 测试只验证目标端口可达，不能把它表述成账号认证成功。
      const message = statusText(get().settings, connection.protocol === 'rdp' ? 'statusRdpTestPassed' : 'statusConnectionTestPassed', {
        name: connection.name || connection.host,
      });
      await backend.testConnection(connection);
      set({
        loading: false,
        connectionTestResult: { kind: 'success', message },
        statusMessage: message,
      });
    } catch (error) {
      const message = statusText(get().settings, 'statusConnectionTestFailed', {
        reason: error instanceof Error ? error.message : String(error),
      });
      set({
        loading: false,
        connectionTestResult: { kind: 'error', message },
        statusMessage: message,
      });
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

    // 复制连接时保留认证和备注等配置，只替换 id、名称和当前分组选区，避免误改原连接。
    const duplicatedConnection: ConnectionProfile = {
      ...source,
      id: crypto.randomUUID(),
      name: nextName,
      groupPath: targetGroupPath || undefined,
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
      connections: [normalizeLoadedConnection(saved), ...state.connections.filter((item) => item.id !== saved.id)],
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
      connections: state.connections.map((item) => (item.id === saved.id ? normalizeLoadedConnection(saved) : item)),
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
        statusMessage: statusText(
          get().settings,
          connection.protocol === 'rdp' ? 'statusOpeningRdp' : 'statusOpeningSession',
          { name: connection.name },
        ),
      });
      if (connection.protocol === 'rdp') {
        // RDP 交给系统 mstsc 独立窗口承载；启动成功后不创建 SSH 终端标签，也不刷新远端文件和运行状态。
        await backend.openRdpConnection(connectionId);
        set((state) => ({
          loading: false,
          statusMessage: statusText(state.settings, 'statusRdpOpened', { name: connection.name }),
        }));
        return;
      }
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
        // 新开会话即将拉取远端数据，先点亮加载动画，等状态事件触发的刷新完成后自动熄灭。
        filesLoading: true,
        runtimeLoading: true,
      }));
      // SSH 握手在后端后台线程完成；连接状态事件回来后再刷新文件、运行状态和首屏输出。
      void get().pollTerminalOutputs(nextSession.id);
    } catch (error) {
      set((state) => ({
        loading: false,
        statusMessage: statusText(state.settings, 'statusConnectionTestFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
    }
  },

  adoptSession: (session) => {
    const { sessions } = get();
    if (sessions.some((item) => item.id === session.id)) {
      return;
    }

    const connection = get().connections.find((item) => item.id === session.connectionId);
    set((state) => ({
      sessions: [...state.sessions, { ...session, title: connection?.name ?? session.title }],
      statusMessage: statusText(state.settings, 'statusAgentTerminalOpened', {
        name: connection?.name ?? session.title,
      }),
    }));
    // 自动打开的标签要立刻切过去：内置 agent 与外部 MCP 开的 SSH 都走这条路径，
    // 用户希望直接看到 agent 在哪个终端里干活，而不是手动去找新标签。
    // 复用 selectSession 的面板切换逻辑，保证右侧文件/运行面板与手动点标签一致。
    // 注意只有「新建标签」才会触发 adoptSession；复用已有标签不抢焦点，避免每次工具调用都打断用户。
    get().selectSession(session.id);
    void get().pollTerminalOutputs(session.id);
  },

  saveLocalTerminals: async (settings) => {
    const saved = await backend.saveLocalTerminals(settings);
    set((state) => ({
      localTerminals: saved,
      statusMessage: statusText(state.settings, 'statusSettingsSaved'),
    }));
    return saved;
  },

  openLocalTerminal: async (profile) => {
    try {
      const settings = get().settings;
      set({
        loading: true,
        statusMessage: statusText(settings, 'statusLocalTerminalOpening', {
          command: localTerminalCommandLabel(settings, profile.command),
        }),
      });
      const session = await backend.openLocalTerminal(profile);
      const localTerminals = await backend.loadLocalTerminals();
      set((state) => ({
        loading: false,
        localTerminals,
        sessions: [...state.sessions.filter((item) => item.id !== session.id), session],
        activeSessionId: session.id,
        activeConnectionId: undefined,
        files: [],
        currentRemotePath: '',
        runtimeOverview: undefined,
        // 本地终端没有远端面板，直接熄灭加载态，避免遗留卡死的动画。
        filesLoading: false,
        runtimeLoading: false,
        historyLoading: false,
        statusMessage: statusText(state.settings, 'statusLocalTerminalOpened', { title: session.title }),
      }));
      void get().pollTerminalOutputs(session.id);
    } catch (error) {
      set({
        loading: false,
        statusMessage: error instanceof Error ? error.message : String(error),
      });
    }
  },

  // 复制标签页：SSH 复用同一连接重新开一条会话（落在登录默认目录，不向远端注入 cd）；
  // 本地终端/TUI 复用同一启动项，因此新标签的目录与启动命令都与源标签一致。
  duplicateSession: async (sessionId) => {
    const state = get();
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) {
      return;
    }

    // 新标签紧跟源标签右侧插入，避免被追加到标签栏最末尾导致用户找不到。
    const insertAfterIndex = state.sessions.findIndex((item) => item.id === sessionId);
    const placeNextToSource = (current: StoreState, openedSession: TerminalSession) => {
      const filteredSessions = current.sessions.filter((item) => item.id !== openedSession.id);
      // 源标签可能在打开过程中被关闭，此时回退到追加，保证新会话不会丢失。
      const sourceIndex = filteredSessions.findIndex((item) => item.id === sessionId);
      const insertIndex = sourceIndex >= 0 ? sourceIndex + 1 : Math.min(insertAfterIndex + 1, filteredSessions.length);
      return [
        ...filteredSessions.slice(0, insertIndex),
        openedSession,
        ...filteredSessions.slice(insertIndex),
      ];
    };

    if (session.kind === 'local') {
      // 目录与启动命令以会话自身为准：历史启动项会按目录去重覆盖，可能已被同目录的其它命令改写，
      // 而会话上的 cwd/localCommand 由后端在启动时写入，始终是这个标签真实使用的参数。
      const profile: LocalTerminalProfile = {
        // 沿用同一条历史启动项 id，复制标签只把它顶到历史列表最前，不额外新增一条重复记录。
        id: session.localProfileId ?? '',
        title: session.title,
        cwd: session.cwd ?? '',
        command: session.localCommand ?? '',
        lastUsedAt: '',
      };

      try {
        set({
          loading: true,
          statusMessage: statusText(state.settings, 'statusLocalTerminalOpening', {
            command: localTerminalCommandLabel(state.settings, profile.command),
          }),
        });
        const openedSession = await backend.openLocalTerminal(profile);
        const localTerminals = await backend.loadLocalTerminals();
        set((current) => ({
          loading: false,
          localTerminals,
          sessions: placeNextToSource(current, openedSession),
          activeSessionId: openedSession.id,
          activeConnectionId: undefined,
          files: [],
          currentRemotePath: '',
          runtimeOverview: undefined,
          // 本地终端没有远端面板，直接熄灭加载态。
          filesLoading: false,
          runtimeLoading: false,
          historyLoading: false,
          statusMessage: statusText(current.settings, 'statusLocalTerminalOpened', { title: openedSession.title }),
        }));
        void get().pollTerminalOutputs(openedSession.id);
      } catch (error) {
        set({
          loading: false,
          statusMessage: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    const connection = state.connections.find((item) => item.id === session.connectionId);
    if (!connection) {
      return;
    }

    try {
      set({
        loading: true,
        statusMessage: statusText(state.settings, 'statusOpeningSession', { name: connection.name }),
      });
      const openedSession = await backend.openSession(connection.id);
      const nextSession = { ...openedSession, title: connection.name };
      set((current) => ({
        loading: false,
        sessions: placeNextToSource(current, nextSession),
        activeSessionId: nextSession.id,
        activeConnectionId: connection.id,
        files: [],
        currentRemotePath: nextSession.cwd ?? '~',
        runtimeOverview: undefined,
        // 新会话即将拉取远端数据，先点亮加载动画，等状态事件触发的刷新完成后自动熄灭。
        filesLoading: true,
        runtimeLoading: true,
        statusMessage: statusText(current.settings, 'statusSessionReady', { name: connection.name }),
      }));
      void get().pollTerminalOutputs(nextSession.id);
    } catch (error) {
      set((current) => ({
        loading: false,
        statusMessage: statusText(current.settings, 'statusConnectionTestFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
    }
  },

  reconnectSession: async (sessionId) => {
    // 手动重连会接管该会话，先取消尚在进行的自动重连计划，避免两者重复创建会话。
    cancelAutoReconnect(sessionId);
    const state = get();
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) {
      return;
    }

    if (session.kind === 'local') {
      const profile = state.localTerminals.profiles.find((item) => item.id === session.localProfileId) ?? {
        id: session.localProfileId ?? crypto.randomUUID(),
        title: session.title,
        cwd: session.cwd ?? '',
        command: '',
        lastUsedAt: '',
      };
      const previousIndex = Math.max(0, state.sessions.findIndex((item) => item.id === sessionId));
      clearQueuedTerminalInput(sessionId);
      set({
        loading: true,
        statusMessage: statusText(state.settings, 'statusLocalTerminalReopening', {
          command: localTerminalCommandLabel(state.settings, profile.command),
        }),
      });

      try {
        await backend.closeSession(sessionId).catch(() => undefined);
        const openedSession = await backend.openLocalTerminal(profile);
        const localTerminals = await backend.loadLocalTerminals();
        set((current) => {
          const filteredSessions = current.sessions.filter((item) => item.id !== sessionId && item.id !== openedSession.id);
          const insertIndex = Math.min(previousIndex, filteredSessions.length);
          const nextCommandBuffers = { ...current.commandBuffers };
          const nextSuggestions = { ...current.suggestions };
          delete nextCommandBuffers[sessionId];
          delete nextSuggestions[sessionId];

          return {
            loading: false,
            localTerminals,
            sessions: [
              ...filteredSessions.slice(0, insertIndex),
              openedSession,
              ...filteredSessions.slice(insertIndex),
            ],
            activeSessionId: openedSession.id,
            activeConnectionId: undefined,
            commandBuffers: nextCommandBuffers,
            suggestions: nextSuggestions,
            files: [],
            currentRemotePath: '',
            runtimeOverview: undefined,
            // 本地终端无远端面板，熄灭加载态。
            filesLoading: false,
            runtimeLoading: false,
            historyLoading: false,
            statusMessage: statusText(current.settings, 'statusLocalTerminalOpened', { title: openedSession.title }),
          };
        });
        void get().pollTerminalOutputs(openedSession.id);
      } catch (error) {
        set({
          loading: false,
          statusMessage: error instanceof Error ? error.message : String(error),
        });
      }
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
          // 重连后即将重新拉取远端数据，先点亮加载动画。
          filesLoading: true,
          runtimeLoading: true,
          statusMessage: statusText(current.settings, 'statusSessionReady', { name: connection.name }),
        };
      });

      // 重连后保持原标签位置；后台连上后由状态事件触发远端文件和运行状态首刷。
      void get().pollTerminalOutputs(nextSession.id);
    } catch (error) {
      set((current) => ({
        loading: false,
        statusMessage: statusText(current.settings, 'statusConnectionTestFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
    }
  },

  scheduleAutoReconnect: (sessionId) => {
    const state = get();
    const session = state.sessions.find((item) => item.id === sessionId);
    // 仅对远端 SSH 会话自动重连；本地终端不在此机制内。
    if (!session || session.kind === 'local') {
      return;
    }
    // 已在重连计划中则不重复调度，由既有计划/看门狗继续推进。
    if (autoReconnectBySession.has(sessionId)) {
      return;
    }
    const connection = state.connections.find((item) => item.id === session.connectionId);
    if (!connection) {
      return;
    }
    autoReconnectBySession.set(sessionId, { attempts: 0, connectionId: session.connectionId });
    void get().runAutoReconnect(sessionId);
  },

  runAutoReconnect: async (sessionId) => {
    const entry = autoReconnectBySession.get(sessionId);
    if (!entry) {
      return;
    }
    const state = get();
    const session = state.sessions.find((item) => item.id === sessionId);
    // 会话已被移除（用户关闭标签）→ 结束计划。
    if (!session) {
      cancelAutoReconnect(sessionId);
      return;
    }
    // 已恢复到可用态 → 结束计划并复位计数，后续再掉线可重新获得完整重试次数。
    if (session.status === 'connected' || session.status === 'stub') {
      cancelAutoReconnect(sessionId);
      return;
    }
    const connection = state.connections.find((item) => item.id === entry.connectionId);
    if (!connection) {
      cancelAutoReconnect(sessionId);
      return;
    }
    if (entry.attempts >= AUTO_RECONNECT_MAX_ATTEMPTS) {
      cancelAutoReconnect(sessionId);
      set((current) => ({
        statusMessage: statusText(current.settings, 'statusAutoReconnectGaveUp', { name: connection.name }),
      }));
      return;
    }

    entry.attempts += 1;
    // 仅当掉线会话本身是当前活动标签时才转移焦点到新会话，后台标签重连不打断用户当前操作。
    const wasActive = state.activeSessionId === sessionId;
    const previousIndex = Math.max(0, state.sessions.findIndex((item) => item.id === sessionId));
    clearQueuedTerminalInput(sessionId);
    set((current) => ({
      statusMessage: statusText(current.settings, 'statusAutoReconnecting', {
        name: connection.name,
        attempt: entry.attempts,
        max: AUTO_RECONNECT_MAX_ATTEMPTS,
      }),
    }));

    try {
      try {
        await backend.closeSession(sessionId);
      } catch {
        // 旧会话可能已断开；忽略关闭错误，继续创建新 PTY。
      }
      const openedSession = await backend.openSession(connection.id);
      const nextSession = { ...openedSession, title: connection.name };
      // 迁移重连计划到新会话 ID：保留累计尝试次数，握手期由看门狗接管后续重试。
      autoReconnectBySession.delete(sessionId);
      autoReconnectBySession.set(nextSession.id, entry);
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
          sessions: nextSessions,
          commandBuffers: nextCommandBuffers,
          suggestions: nextSuggestions,
          // 只有原本处于活动标签时才把焦点与远端面板切到新会话。
          ...(wasActive
            ? {
                activeSessionId: nextSession.id,
                activeConnectionId: connection.id,
                currentRemotePath: nextSession.cwd ?? '~',
                files: [],
                runtimeOverview: undefined,
                filesLoading: true,
                runtimeLoading: true,
              }
            : {}),
        };
      });
      void get().pollTerminalOutputs(nextSession.id);
      // 看门狗：给足握手时间；到点若仍未连上则由 runAutoReconnect 递增尝试后再次重连。
      entry.timer = window.setTimeout(() => {
        void get().runAutoReconnect(nextSession.id);
      }, autoReconnectDelayMs(entry.attempts));
    } catch {
      // openSession 直接失败（如网络不可达）：按退避安排下一次尝试，会话 ID 未变。
      entry.timer = window.setTimeout(() => {
        void get().runAutoReconnect(sessionId);
      }, autoReconnectDelayMs(entry.attempts));
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
    // 用户主动关闭标签：取消自动重连，避免关闭瞬间迟到的 error 事件又拉起重连。
    cancelAutoReconnect(sessionId);
    clearQueuedTerminalInput(sessionId);
    try {
      await backend.closeSession(sessionId);
    } catch {
      // 关闭标签以清理前端状态为主；后端会话已丢失时仍允许用户从界面移除坏标签。
    }
    set((state) => {
      const nextSessions = state.sessions.filter((item) => item.id !== sessionId);
      const nextActiveSessionId = state.activeSessionId === sessionId ? nextSessions[0]?.id : state.activeSessionId;
      const nextActiveSession = nextActiveSessionId
        ? nextSessions.find((item) => item.id === nextActiveSessionId)
        : undefined;
      const nextActiveConnectionId = nextActiveSession?.kind === 'local' ? undefined : nextActiveSession?.connectionId;
      const closedActiveSession = state.activeSessionId === sessionId;
      const nextCommandBuffers = { ...state.commandBuffers };
      const nextSuggestions = { ...state.suggestions };
      delete nextCommandBuffers[sessionId];
      delete nextSuggestions[sessionId];

      // 关闭当前会话后切到了另一条远端连接时，紧接着会重新拉取远端数据，需要点亮加载动画；
      // 切到本地/无会话则熄灭，避免遗留空转动画。
      const switchedToOtherRemote = closedActiveSession
        && Boolean(nextActiveConnectionId)
        && nextActiveConnectionId !== state.activeConnectionId;

      return {
        sessions: nextSessions,
        activeSessionId: nextActiveSessionId,
        activeConnectionId: nextActiveConnectionId,
        runtimeOverview: nextActiveConnectionId ? state.runtimeOverview : undefined,
        files: closedActiveSession && !nextActiveConnectionId ? [] : state.files,
        currentRemotePath: closedActiveSession ? (nextActiveConnectionId ? nextActiveSession?.cwd ?? '' : '') : state.currentRemotePath,
        filesLoading: switchedToOtherRemote,
        runtimeLoading: switchedToOtherRemote,
        historyLoading: false,
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
    if (!isUsableTerminalSession(session)) {
      return;
    }
    const nextRemotePath = isUsableRemoteSession(session) && session?.connectionId === state.activeConnectionId
      // cd 相对路径必须以终端 Shell 的 cwd 为基准，不能使用可能已被用户单独浏览到别处的文件管理路径。
      ? guessNextRemotePath(session.cwd || state.currentRemotePath || '~', rawCommand)
      : undefined;

    await flushQueuedTerminalInput(sessionId);
    // SSH 底栏统一按交互 PTY 语义发送：普通换行是 Enter，行尾反斜杠换行固定为 LF 续行；本地程序保持原输入协议。
    const terminalPayload = isUsableRemoteSession(session)
      ? normalizeCommandPanelTerminalInput(rawCommand)
      : rawCommand.endsWith('\n') ? rawCommand : `${rawCommand}\n`;
    if (isUsableRemoteSession(session)) {
      // 底栏与终端本体共用同一 PTY，命令跟踪状态也必须消费完全相同的 payload，避免后续 Enter 读取到旧行。
      extractCompletedTerminalInputLines(sessionId, terminalPayload);
    }
    await backend.writeTerminalInput(sessionId, terminalPayload);

    set((prev) => ({
      commandBuffers: { ...prev.commandBuffers, [sessionId]: '' },
      suggestions: { ...prev.suggestions, [sessionId]: [] },
      statusMessage: statusText(prev.settings, 'statusSentCommand', { target: session?.title ?? 'session' }),
    }));

    void get().pollTerminalOutputs();
    if (isUsableRemoteSession(session) && session?.connectionId) {
      void get().refreshRemoteHistory(session.connectionId);
    }
    if (nextRemotePath) {
      void get().refreshFiles(nextRemotePath);
    }
  },

  sendTerminalData: async (sessionId, data) => {
    const state = get();
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!isUsableTerminalSession(session)) {
      return;
    }

    // 只修正 SSH Shell 的反斜杠续行 Enter；本地 TUI/程序依赖原始键码，不能套用 Shell 规则。
    const terminalData = isUsableRemoteSession(session)
      ? normalizeRemoteTerminalContinuationEnter(sessionId, data)
      : data;

    let nextRemotePath: string | undefined;
    let completedInputLines: string[] = [];
    let continuationLineBreaks = 0;
    if (isUsableRemoteSession(session) && session.connectionId === state.activeConnectionId) {
      // 文件管理器允许独立浏览；终端内连续 cd 的相对路径始终从 Shell cwd 推导，避免 cd .. 被面板路径带偏。
      let pathCursor = session.cwd || state.currentRemotePath || '~';
      const trackedInput = extractCompletedTerminalInputLines(sessionId, terminalData);
      completedInputLines = trackedInput.completedLines;
      continuationLineBreaks = trackedInput.continuationLineBreaks;
      for (const completedLine of completedInputLines) {
        const guessedPath = guessNextRemotePath(pathCursor, completedLine);
        if (guessedPath) {
          pathCursor = guessedPath;
          nextRemotePath = guessedPath;
        }
      }
    } else if (isUsableRemoteSession(session)) {
      // 非当前连接也必须维护续行缓冲，否则切换回来后 Enter 无法判断前一字符是否为反斜杠。
      const trackedInput = extractCompletedTerminalInputLines(sessionId, terminalData);
      completedInputLines = trackedInput.completedLines;
      continuationLineBreaks = trackedInput.continuationLineBreaks;
    }

    const hasLineBreak = terminalData.includes('\r') || terminalData.includes('\n');
    // 单独的反斜杠续行仍处于同一条逻辑命令，不触发“命令已提交”后的轮询和目录刷新。
    const submittedInput = hasLineBreak && (completedInputLines.length > 0 || continuationLineBreaks === 0);
    const flushDelayMs = shouldFlushTerminalInputImmediately(terminalData)
      ? 0
      : isBulkTerminalInput(terminalData)
        ? terminalBulkInputFlushDelayMs
        : terminalInteractiveInputFlushDelayMs;
    queueTerminalInput(sessionId, terminalData, flushDelayMs);
    if (hasLineBreak) {
      await flushQueuedTerminalInput(sessionId);
      if (submittedInput) {
        void get().pollTerminalOutputs();
        if (nextRemotePath) {
          // 终端本体里粘贴或手输 cd 不经过命令面板，先用输入侧预测兜底刷新；后端真实 PWD 标记回来后会再次校正。
          void get().refreshFiles(nextRemotePath);
        }
      }
      return;
    }
  },

  passthroughTab: async (sessionId) => {
    queueTerminalInput(sessionId, '\t');
    await flushQueuedTerminalInput(sessionId);
    void get().pollTerminalOutputs();
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

  pollTerminalOutputs: async (targetSessionId) => {
    const { sessions } = get();
    const targetSessions = targetSessionId ? sessions.filter((session) => session.id === targetSessionId) : sessions;
    if (!targetSessions.length) {
      return;
    }

    // 后端输出事件携带 sessionId 时只拉取对应会话；兜底轮询不传 sessionId，仍覆盖全部会话。
    const settledOutputs = await Promise.allSettled(targetSessions.map((session) => backend.readTerminalOutput(session.id)));
    const outputFailures = new Set<string>();
    settledOutputs.forEach((result, index) => {
      if (result.status === 'rejected') {
        const sessionId = targetSessions[index]?.id ?? '';
        console.error(`[SSH-DIAG] readTerminalOutput rejected for session=${sessionId}:`, result.reason);
        outputFailures.add(sessionId);
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

    let activeCwdToDisplay: string | undefined;
    let activeCwdToRefresh: string | undefined;
    // 本轮状态变化中需要启动/取消自动重连的会话；在 set 之后统一处理，避免在 reducer 内触发副作用。
    const disconnectedSessionIds: string[] = [];
    const reconnectedSessionIds: string[] = [];
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
          // 仅对“已成功连上”又掉线的远端会话启动自动重连，不对初次握手失败反复重试。
          if (
            session.kind !== 'local'
            && (status === 'error' || status === 'closed')
            && session.status === 'connected'
          ) {
            disconnectedSessionIds.push(session.id);
          }
          // 重新稳定连上 → 取消重连计划并复位计数。
          if (status === 'connected' || status === 'stub') {
            reconnectedSessionIds.push(session.id);
          }
        }

        if (
          cwd &&
          session.id === state.activeSessionId &&
          session.connectionId === state.activeConnectionId &&
          isUsableRemoteSession(nextSession)
        ) {
          const pendingRequest = latestPendingRemoteFilesRequest();
          const pendingMatchesCwd = isSameRemoteFilesTarget(pendingRequest, session.connectionId, cwd);
          const pendingConflictsWithCwd = Boolean(
            pendingRequest
            && pendingRequest.connectionId === session.connectionId
            && !pendingMatchesCwd,
          );

          if (state.currentRemotePath !== cwd) {
            // cwd 元数据来自交互 Shell 的真实 PWD，路径栏先同步；慢 SFTP 只影响列表内容，不应拖住路径反馈。
            activeCwdToDisplay = cwd;
          }
          if (!pendingMatchesCwd && (state.currentRemotePath !== cwd || pendingConflictsWithCwd)) {
            // 即使面板此刻恰好已在 cwd，也必须覆盖尚未完成的错误预判，防止旧请求稍后把列表带到错误目录。
            activeCwdToRefresh = cwd;
          }
        }

        return nextSession;
      });

      const activeSession = nextSessions.find((session) => session.id === state.activeSessionId);
      const activeSessionBecameUnavailable = activeSession ? !isUsableRemoteSession(activeSession) : false;
      const shouldClearActiveRemoteData = activeSessionBecameUnavailable
        && (state.files.length > 0 || Boolean(state.runtimeOverview) || Boolean(state.currentRemotePath));
      // 只要会话变为不可用（含握手失败、cwd 为空的场景），就无条件熄灭加载动画；
      // 这一步不依赖是否有旧数据可清，否则握手失败又没有旧内容时动画会一直空转。
      const shouldStopLoading = activeSessionBecameUnavailable
        && (state.filesLoading || state.runtimeLoading || state.historyLoading);

      return {
        ...(sessionsChanged ? { sessions: nextSessions } : {}),
        ...(activeCwdToDisplay ? { currentRemotePath: activeCwdToDisplay } : {}),
        // 会话变为不可用（断开/异常）时清掉残留的远端数据，避免继续展示上一台主机的内容。
        ...(shouldClearActiveRemoteData ? { files: [], runtimeOverview: undefined, currentRemotePath: '' } : {}),
        // 加载动画的熄灭独立判断，覆盖“无旧数据可清但动画已点亮”的握手失败场景。
        ...(shouldStopLoading ? { filesLoading: false, runtimeLoading: false, historyLoading: false } : {}),
      };
    });

    if (activeCwdToRefresh) {
      // 刷新队列本身只保留最新目录，因此真实 cwd 可以立即校正列表，无需再额外等待固定防抖时间。
      void get().refreshFiles(activeCwdToRefresh);
    }

    // 已恢复的会话先取消重连计划（复位计数），再为新掉线的会话启动重连。
    reconnectedSessionIds.forEach(cancelAutoReconnect);
    disconnectedSessionIds.forEach((id) => get().scheduleAutoReconnect(id));
  },

  // 历史 Tab 以远端 Shell 历史文件为来源，刷新当前连接时替换对应连接缓存。
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

  refreshFiles: async (path) => {
    const { activeConnectionId, activeSessionId, currentRemotePath, sessions } = get();
    const activeSession = sessions.find((item) => item.id === activeSessionId);
    const activeRemoteConnectionId = isUsableRemoteSession(activeSession) ? activeSession?.connectionId : undefined;
    // 文件管理必须绑定已打开的终端会话；只选中连接时不展示也不刷新远端文件。
    if (!activeConnectionId || activeConnectionId !== activeRemoteConnectionId) {
      return;
    }

    const requestedPath = normalizeRemoteFilesPath(path ?? currentRemotePath);
    if (remoteFilesRefreshInFlight) {
      if (isSameRemoteFilesTarget(remoteFilesQueuedRequest, activeConnectionId, requestedPath)) {
        // 最新排队项已经覆盖同一路径，无需再次增加序号或重复列举。
        return;
      }
      if (isSameRemoteFilesTarget(remoteFilesActiveRequest, activeConnectionId, requestedPath)) {
        if (remoteFilesQueuedRequest && remoteFilesActiveRequest) {
          // 真实 cwd 回到当前执行路径时，撤销冲突的排队项，并把执行项提升为最新请求以允许其结果落地。
          remoteFilesQueuedRequest = undefined;
          remoteFilesActiveRequest.seq = ++remoteFilesRefreshSeq;
        }
        return;
      }

      // SFTP 刷新串行执行，正在刷新时只保留最后一次目标路径，避免快速 cd/双击目录堆出多条 SSH 请求。
      remoteFilesQueuedRequest = {
        connectionId: activeConnectionId,
        path: requestedPath,
        seq: ++remoteFilesRefreshSeq,
      };
      return;
    }

    const firstRequest: RemoteFilesRefreshRequest = {
      connectionId: activeConnectionId,
      path: requestedPath,
      seq: ++remoteFilesRefreshSeq,
    };
    // 当前列表为空时才显示加载动画；已有旧文件内容时静默刷新，避免闪烁。
    if (!get().files.length) {
      set({ filesLoading: true });
    }
    remoteFilesRefreshInFlight = true;
    let request: typeof firstRequest | undefined = firstRequest;
    try {
      while (request) {
        const currentRequest = request;
        remoteFilesActiveRequest = currentRequest;
        remoteFilesQueuedRequest = undefined;
        try {
          const files = await backend.listRemoteFiles(currentRequest.connectionId, currentRequest.path);
          if (currentRequest.seq !== remoteFilesRefreshSeq || get().activeConnectionId !== currentRequest.connectionId) {
            request = remoteFilesQueuedRequest;
            continue;
          }

          set({ files, currentRemotePath: currentRequest.path, filesLoading: false, statusMessage: statusText(get().settings, 'statusLoadedPath', { path: currentRequest.path }) });
        } catch (error) {
          if (currentRequest.seq !== remoteFilesRefreshSeq || get().activeConnectionId !== currentRequest.connectionId) {
            request = remoteFilesQueuedRequest;
            continue;
          }

          set((state) => ({
            filesLoading: false,
            statusMessage: statusText(state.settings, 'statusRemoteFilesFailed', {
              reason: error instanceof Error ? error.message : String(error),
            }),
          }));
        }

        request = remoteFilesQueuedRequest;
      }
    } finally {
      remoteFilesRefreshInFlight = false;
      remoteFilesActiveRequest = undefined;
      remoteFilesQueuedRequest = undefined;
      // 兜底：无论中途 continue 还是异常，最终都清掉加载态，避免动画卡死。
      if (get().filesLoading) {
        set({ filesLoading: false });
      }
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

  uploadLocalFiles: async (files) => {
    const { activeConnectionId, currentRemotePath } = get();
    const uploadFiles = files.filter((file) => file.name);
    if (!activeConnectionId || !uploadFiles.length) {
      return;
    }

    try {
      // 文件夹上传按文件顺序串行写入，避免大量并发 base64 编码和 SFTP create 同时挤占前端内存与远端连接。
      for (const file of uploadFiles) {
        const contentBase64 = await toBase64(file);
        await backend.uploadRemoteFile(activeConnectionId, currentRemotePath, uploadRemoteName(file), contentBase64);
      }
      await get().refreshFiles(currentRemotePath);
      set({
        statusMessage: uploadFiles.length === 1
          ? statusText(get().settings, 'statusUploadedFile', { name: uploadFiles[0].name })
          : statusText(get().settings, 'statusUploadedFiles', { count: uploadFiles.length }),
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

  uploadLocalPaths: async (localPaths) => {
    const { activeConnectionId, currentRemotePath } = get();
    const uploadPaths = Array.from(new Set(localPaths.map((path) => path.trim()).filter(Boolean)));
    if (!activeConnectionId || !uploadPaths.length) {
      return;
    }

    try {
      // 桌面拖放上传直接把本机路径交给后端递归读取，避免大文件和目录树经过前端 base64 中转。
      await backend.uploadLocalPaths(activeConnectionId, currentRemotePath, uploadPaths);
      await get().refreshFiles(currentRemotePath);
      set({
        statusMessage: uploadPaths.length === 1
          ? statusText(get().settings, 'statusUploadedFile', { name: uploadPaths[0].split(/[\\/]/).pop() ?? uploadPaths[0] })
          : statusText(get().settings, 'statusUploadedPaths', { count: uploadPaths.length }),
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

  downloadRemotePaths: async (paths, localDir) => {
    const { activeConnectionId } = get();
    const normalizedPaths = Array.from(new Set(paths.filter(Boolean)));
    if (!activeConnectionId || !normalizedPaths.length) {
      return;
    }

    try {
      const summary = await backend.downloadRemotePaths(activeConnectionId, normalizedPaths, localDir);
      set({
        statusMessage: normalizedPaths.length === 1
          ? statusText(get().settings, 'statusDownloadedFile', { path: summary.destinations[0] ?? normalizedPaths[0] })
          : statusText(get().settings, 'statusDownloadedPaths', {
              count: normalizedPaths.length,
              path: summary.destinations[0] ?? localDir ?? '',
            }),
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

  copyRemotePaths: async (sources, targetDir) => {
    const { activeConnectionId, currentRemotePath } = get();
    const normalizedSources = Array.from(new Set(sources.filter(Boolean)));
    const destination = targetDir || currentRemotePath;
    if (!activeConnectionId || !normalizedSources.length) {
      return;
    }

    try {
      // 复制走后端一次辅助会话，粘贴完统一刷新目标目录，避免逐项刷新拖慢界面。
      await backend.copyRemotePaths(activeConnectionId, normalizedSources, destination);
      await get().refreshFiles(currentRemotePath);
      set({ statusMessage: statusText(get().settings, 'statusCopiedPaths', { count: normalizedSources.length }) });
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

  uploadConfig: async () => {
    await get().persistSettings();
    const remotePath = await backend.uploadConfig();
    set({ statusMessage: statusText(get().settings, 'statusUploadedConfig', { path: remotePath }) });
  },

  downloadConfig: async (remotePath: string) => {
    const nextState = await backend.downloadConfig(remotePath);
    const nextActiveSessionId = nextState.sessions[0]?.id;
    const nextActiveConnectionId = nextState.sessions[0]?.connectionId;
    set({
      settings: nextState.settings,
      connections: nextState.connections.map((connection) => normalizeLoadedConnection(connection)),
      history: nextState.history,
      sessions: nextState.sessions,
      tunnels: nextState.tunnels,
      activeConnectionId: nextActiveConnectionId,
      activeSessionId: nextActiveSessionId,
      commandBuffers: {},
      suggestions: {},
      files: [],
      currentRemotePath: nextActiveSessionId ? '~' : '',
      runtimeOverview: undefined,
      filesLoading: false,
      runtimeLoading: false,
      historyLoading: false,
      editorDocument: undefined,
      statusMessage: statusText(nextState.settings, 'statusDownloadedConfig', { path: remotePath }),
    });
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
      connections: nextState.connections.map((connection) => normalizeLoadedConnection(connection)),
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
      filesLoading: false,
      runtimeLoading: false,
      historyLoading: false,
      editorDocument: undefined,
      statusMessage: statusText(nextState.settings, 'statusImportedLocalConfig', { name: file.name }),
    });
  },

  checkForUpdates: async () => {
    // 更新检测走 GitHub Release 元数据，不直接下载安装，避免在未确认前产生外部副作用。
    const result = await backend.checkForUpdates();
    set((state) => ({
      updateCheckResult: result,
      statusMessage: result.updateAvailable
        ? statusText(state.settings, 'statusUpdateAvailable', { version: result.latestVersion })
        : statusText(state.settings, 'statusUpdateNotAvailable'),
    }));
    return result;
  },

  installUpdate: async (result) => {
    if (!result.installerDownloadUrl || !result.installerAssetName) {
      const message = statusText(get().settings, 'statusUpdateInstallerMissing');
      set({ statusMessage: message });
      throw new Error(message);
    }

    try {
      set((state) => ({
        loading: true,
        statusMessage: statusText(state.settings, 'statusUpdateDownloading'),
      }));
      // 后端返回下载后的安装包路径，设置页用它给用户一个可追踪的成功提示。
      const installerPath = await backend.installUpdate(result);
      set((state) => ({
        loading: false,
        statusMessage: statusText(state.settings, 'statusUpdateInstallStarted'),
      }));
      return installerPath;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      set((state) => ({
        loading: false,
        statusMessage: statusText(state.settings, 'statusUpdateInstallFailed', {
          reason,
        }),
      }));
      throw error instanceof Error ? error : new Error(reason);
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
        id: '',
        connectionId: activeConnectionId,
        name: `${connection.name} DB tunnel`,
        bindAddress: '127.0.0.1',
        localPort: 15432,
        remoteHost: '127.0.0.1',
        remotePort: 5432,
      },
      activePanel: 'tunnels',
    }));
  },

  editTunnel: (tunnel) => {
    set(() => ({
      showTunnelForm: true,
      // 编辑时保留原始连接归属，避免活动连接被切换后把隧道误保存到其他 SSH 连接下。
      tunnelDraft: {
        id: tunnel.id,
        connectionId: tunnel.connectionId,
        name: tunnel.name,
        bindAddress: tunnel.bindAddress,
        localPort: tunnel.localPort,
        remoteHost: tunnel.remoteHost,
        remotePort: tunnel.remotePort,
      },
      activePanel: 'tunnels',
    }));
  },

  startTunnel: async (tunnelId) => {
    try {
      const tunnel = await backend.startTunnel(tunnelId);
      set((state) => ({
        tunnels: state.tunnels.map((item) => (item.id === tunnel.id ? tunnel : item)),
        statusMessage: statusText(state.settings, 'statusTunnelStarted'),
      }));
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusTunnelStartFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
    }
  },

  startAllTunnels: async () => {
    const { activeConnectionId } = get();
    if (!activeConnectionId) {
      return;
    }

    // 批量开启只作用于当前连接的隧道，避免底部面板操作误启动其他 SSH 主机的转发规则。
    const stoppedTunnels = get().tunnels.filter((item) => item.connectionId === activeConnectionId && item.status !== 'running');
    if (!stoppedTunnels.length) {
      return;
    }

    try {
      const restarted = await Promise.all(stoppedTunnels.map((item) => backend.startTunnel(item.id)));
      set((state) => ({
        tunnels: state.tunnels.map((item) => restarted.find((next) => next.id === item.id) ?? item),
        statusMessage: statusText(state.settings, 'statusAllTunnelsStarted'),
      }));
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusTunnelStartFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
    }
  },

  stopAllTunnels: async () => {
    const { activeConnectionId } = get();
    if (!activeConnectionId) {
      return;
    }

    // 批量停止同样限制在当前连接内，和底部隧道列表的可见范围保持一致。
    const runningTunnels = get().tunnels.filter((item) => item.connectionId === activeConnectionId && item.status === 'running');
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

  applyTunnelStatusChange: (tunnel) => {
    set((state) => {
      const existing = state.tunnels.find((item) => item.id === tunnel.id);
      // 本地无该隧道或状态未变时不触发重渲染；用户已手动停止（stopped）时不被后台探测覆盖。
      if (!existing || existing.status === tunnel.status || existing.status === 'stopped') {
        return {};
      }
      return {
        tunnels: state.tunnels.map((item) => (item.id === tunnel.id ? { ...item, status: tunnel.status } : item)),
      };
    });
  },
}));
