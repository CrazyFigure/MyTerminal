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
  TerminalSession,
  TunnelDraft,
  TunnelRecord,
  UpdateCheckResult,
  WorkspacePanel,
} from '../../types';

export type ConnectionTestResult = {
  kind: 'success' | 'error';
  message: string;
};

// Store 契约是应用层公开端口；各功能 action factory 只实现自己的用例切片，组件仍订阅同一个总状态。
export type StoreState = {
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
  // 面板刷新态只在没有旧内容时显示加载动画，后台定时刷新不应让已有内容闪烁。
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
  adoptSession: (session: TerminalSession) => void;
  saveLocalTerminals: (settings: LocalTerminalSettings) => Promise<LocalTerminalSettings>;
  openLocalTerminal: (profile: LocalTerminalProfile) => Promise<void>;
  duplicateSession: (sessionId: string) => Promise<void>;
  reconnectSession: (sessionId: string) => Promise<void>;
  scheduleAutoReconnect: (sessionId: string) => void;
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
  installUpdate: (result: UpdateCheckResult) => Promise<string>;
  openTunnel: () => Promise<void>;
  editTunnel: (tunnel: TunnelRecord) => void;
  startTunnel: (tunnelId: string) => Promise<void>;
  startAllTunnels: () => Promise<void>;
  stopAllTunnels: () => Promise<void>;
  closeTunnel: (tunnelId: string) => Promise<void>;
  applyTunnelStatusChange: (tunnel: TunnelRecord) => void;
};

export type StoreSet = {
  (partial: Partial<StoreState> | ((state: StoreState) => Partial<StoreState>)): void;
};

export type StoreGet = () => StoreState;
