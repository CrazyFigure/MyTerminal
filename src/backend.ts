import { invoke } from '@tauri-apps/api/core';

import type {
  AgentBridgeRequest,
  AgentBridgeStatus,
  AgentProvider,
  AgentRunOptions,
  AppSettings,
  BootstrapState,
  ConnectionProfile,
  EditorDocument,
  FileTransferSummary,
  HistoryEntry,
  LocalTerminalProfile,
  LocalTerminalSettings,
  RemoteFileEntry,
  RuntimeConnectionList,
  RuntimeOverview,
  RuntimeResourceUsage,
  RuntimeResourceUsageRequest,
  RuntimeStorageFiles,
  StoredAgentConversation,
  TerminalOutputChunk,
  TerminalSession,
  TunnelOpenRequest,
  TunnelRecord,
  TunnelUpdateRequest,
  UpdateCheckResult,
} from './types';

import {
  clampU16,
  isTauriRuntime,
  normalizeConnection,
  normalizeLocalTerminalSettings,
  normalizeRuntimeResourceSource,
  normalizeSettings,
  normalizeTunnelRequest,
  nowIso,
} from './backend/normalizers';
import {
  mockAgentBridgeStatus,
  mockConnections,
  mockFiles,
  mockHistory,
  mockLocalTerminals,
  mockRuntimeConnectionList,
  mockRuntimeOverview,
  mockRuntimeResourceUsage,
  mockRuntimeStorageFiles,
  mockState,
  mockTunnels,
  mockUpdateCheckResult,
} from './backend/mockState';

const call = async <T>(command: string, args?: Record<string, unknown>, fallback?: T): Promise<T> => {
  if (!isTauriRuntime()) {
    if (fallback === undefined) {
      throw new Error(`Mock response missing for ${command}`);
    }
    return structuredClone(fallback);
  }

  return invoke<T>(command, args);
};

export const backend = {
  bootstrap: async () => {
    const state = await call<BootstrapState>('bootstrap_state', undefined, mockState);
    return {
      ...state,
      settings: normalizeSettings(state.settings),
      localTerminals: normalizeLocalTerminalSettings(state.localTerminals ?? mockLocalTerminals),
    };
  },
  saveSettings: (settings: AppSettings) => {
    const normalized = normalizeSettings(settings);
    return call<AppSettings>('save_app_settings', { settings: normalized }, normalized);
  },
  loadLocalTerminals: async () => {
    const settings = await call<LocalTerminalSettings>('load_local_terminal_settings', undefined, mockLocalTerminals);
    return normalizeLocalTerminalSettings(settings);
  },
  saveLocalTerminals: (settings: LocalTerminalSettings) => {
    const normalized = normalizeLocalTerminalSettings(settings);
    return call<LocalTerminalSettings>('save_local_terminal_settings', { settings: normalized }, normalized);
  },
  // 枚举本机已安装字体，供字体设置下拉全量选择；Web 预览或后端失败时返回空列表由前端补齐推荐字体。
  listSystemFonts: () => call<string[]>('list_system_fonts', undefined, []),
  agentBridgeStatus: () => call<AgentBridgeStatus>('agent_bridge_status', undefined, mockAgentBridgeStatus),
  listAgentBridgeRequests: () => call<AgentBridgeRequest[]>('list_agent_bridge_requests', undefined, []),
  approveAgentBridgeRequest: (requestId: string, editedCommand?: string) =>
    call<boolean>('approve_agent_bridge_request', { requestId, editedCommand }, true),
  rejectAgentBridgeRequest: (requestId: string, reason?: string) =>
    call<boolean>('reject_agent_bridge_request', { requestId, reason }, true),
  clearAgentBridgeRequests: () => call<boolean>('clear_agent_bridge_requests', undefined, true),
  // MCP 审批通知走 Rust 命令创建带动作按钮的系统 toast，按钮结果再通过 Tauri 事件回到前端。
  showAgentBridgeNotification: (request: {
    requestId: string;
    title: string;
    body: string;
    approveLabel: string;
    rejectLabel: string;
  }) => call<boolean>('show_agent_bridge_notification', { request }, true),
  resetAgentBridgeToken: () => call<AgentBridgeStatus>('reset_agent_bridge_token', undefined, mockAgentBridgeStatus),
  setAgentBridgeEnabled: (enabled: boolean) => call<AgentBridgeStatus>('set_agent_bridge_enabled', { enabled }, mockAgentBridgeStatus),
  testConnection: (connection: ConnectionProfile) => {
    const normalized = normalizeConnection(connection);
    return call<boolean>('test_connection', { connection: normalized }, true);
  },
  upsertConnection: (connection: ConnectionProfile, isExisting = false) => {
    const normalized = normalizeConnection(connection);
    return call<ConnectionProfile>(isExisting ? 'update_connection' : 'create_connection', { connection: normalized }, normalized);
  },
  deleteConnection: (connectionId: string) => call<boolean>('delete_connection', { connectionId }, true),
  // 内置 Agent：端点配置读写与对话驱动。API Key 只上行不下行。
  listAgentProviders: () => call<AgentProvider[]>('list_agent_providers', undefined, []),
  saveAgentProviders: (providers: AgentProvider[]) =>
    call<AgentProvider[]>('save_agent_providers', { providers }, providers),
  startAgentChat: (payload: {
    conversationId: string;
    providerId: string;
    modelId: string;
    history: { role: string; content: string; toolCalls: unknown[]; toolResults: unknown[] }[];
    options: AgentRunOptions;
  }) => call<boolean>('start_agent_chat', payload, true),
  cancelAgentChat: (conversationId: string) =>
    call<boolean>('cancel_agent_chat', { conversationId }, true),
  listAgentConversations: () =>
    call<StoredAgentConversation[]>('list_agent_conversations', undefined, []),
  saveAgentConversation: (conversation: StoredAgentConversation) =>
    call<boolean>('save_agent_conversation', { conversation }, true),
  deleteAgentConversation: (conversationId: string) =>
    call<boolean>('delete_agent_conversation', { conversationId }, true),
  openSession: (connectionId: string) =>
    call<TerminalSession>(
      'open_ssh_session',
      { connectionId },
      {
        id: crypto.randomUUID(),
        kind: 'ssh',
        connectionId,
        localProfileId: undefined,
        title: `SSH ${connectionId}`,
        status: 'stub',
        cwd: '~',
      },
    ),
  // RDP 连接由后端写入当前登录会话的临时凭据，并启动 Windows 自带 mstsc，不创建内置终端标签。
  openRdpConnection: (connectionId: string) =>
    call<boolean>('open_rdp_connection', { connectionId }, true),
  openLocalTerminal: (profile: LocalTerminalProfile) =>
    call<TerminalSession>(
      'open_local_terminal_session',
      { profile },
      {
        id: crypto.randomUUID(),
        kind: 'local',
        connectionId: '',
        localProfileId: profile.id,
        // 本地命令回传给终端渲染层，确保 Web mock 也走 AI TUI 专用策略。
        localCommand: profile.command,
        title: profile.title || (profile.command ? `${profile.command} · ${profile.cwd}` : profile.cwd),
        status: 'stub',
        cwd: profile.cwd,
      },
    ),
  closeSession: (sessionId: string) => call<boolean>('close_ssh_session', { sessionId }, true),
  writeTerminalInput: (sessionId: string, data: string) => call<boolean>('write_terminal_input', { sessionId, data }, true),
  readTerminalOutput: (sessionId: string) =>
    call<TerminalOutputChunk[]>('read_terminal_output', { sessionId }, [
      { sessionId, content: `[stub] ${new Date().toLocaleTimeString()} waiting for Rust session bridge...\r\n` },
    ]),
  resizeTerminal: (sessionId: string, cols: number, rows: number) =>
    call<boolean>('resize_terminal', { sessionId, cols: clampU16(cols, 80), rows: clampU16(rows, 24) }, true),
  listRemoteFiles: (connectionId: string, path: string) =>
    call<RemoteFileEntry[]>('list_remote_files', { connectionId, path }, mockFiles),
  uploadRemoteFile: (connectionId: string, remoteDir: string, fileName: string, contentBase64: string) =>
    call<boolean>('upload_remote_file', { connectionId, remoteDir, fileName, contentBase64 }, true),
  uploadLocalPaths: (connectionId: string, remoteDir: string, localPaths: string[]) =>
    call<FileTransferSummary>('upload_local_paths', { connectionId, remoteDir, localPaths }, {
      files: localPaths.length,
      directories: 0,
      bytes: 0,
      destinations: localPaths.map((path) => `${remoteDir.replace(/\/$/, '')}/${path.split(/[\\/]/).pop() ?? 'upload'}`),
    }),
  downloadRemoteFile: (connectionId: string, path: string) =>
    call<string>('download_remote_file', { connectionId, path }, `C:/Software/WorkSpace/MyTerminal/.myterminal-data/downloads/${path.split('/').pop() ?? 'download.bin'}`),
  downloadRemotePaths: (connectionId: string, paths: string[], localDir?: string) =>
    call<FileTransferSummary>('download_remote_paths', { connectionId, paths, localDir }, {
      files: paths.length,
      directories: 0,
      bytes: 0,
      destinations: paths.map((path) => `${localDir || 'C:/Software/WorkSpace/MyTerminal/.myterminal-data/downloads'}/${path.split('/').pop() ?? 'download'}`),
    }),
  deleteRemotePath: (connectionId: string, path: string) =>
    call<boolean>('delete_remote_path', { connectionId, path }, true),
  deleteRemotePaths: (connectionId: string, paths: string[]) =>
    call<boolean>('delete_remote_paths', { connectionId, paths }, true),
  renameRemotePath: (connectionId: string, path: string, newPath: string) =>
    call<boolean>('rename_remote_path', { connectionId, path, newPath }, true),
  copyRemotePaths: (connectionId: string, sources: string[], targetDir: string) =>
    call<boolean>('copy_remote_paths', { connectionId, sources, targetDir }, true),
  loadEditorDocument: (connectionId: string, path: string) =>
    call<EditorDocument>('load_editor_document', { connectionId, path }, {
      connectionId,
      path,
      language: path.endsWith('.conf') ? 'ini' : 'shell',
      dirty: false,
      content: `# Stub document for ${path}\n# Replace with remote content after SSH + SFTP backend is wired.\n`,
    }),
  saveEditorDocument: (connectionId: string, path: string, content: string) =>
    call<boolean>('save_editor_document', { connectionId, path, content }, true),
  fetchRuntimeOverview: (connectionId: string) =>
    call<RuntimeOverview>('fetch_runtime_overview', { connectionId }, {
      ...mockRuntimeOverview,
      host: mockConnections.find((item) => item.id === connectionId)?.host ?? mockRuntimeOverview.host,
    }),
  fetchRuntimeResourceUsage: (connectionId: string, request: RuntimeResourceUsageRequest) =>
    call<RuntimeResourceUsage>('fetch_runtime_resource_usage', { connectionId, request }, {
      ...mockRuntimeResourceUsage,
      source: normalizeRuntimeResourceSource(request.source),
      metric: request.metric,
      target: request.target,
      capturedAt: nowIso(),
    }),
  // 存储大文件扫描由前端展开态驱动调用，收起时不会触发这个远端命令。
  fetchRuntimeStorageFiles: (connectionId: string) =>
    call<RuntimeStorageFiles>('fetch_runtime_storage_files', { connectionId }, {
      ...mockRuntimeStorageFiles,
      capturedAt: nowIso(),
    }),
  // 连接明细同样由连接数行展开态驱动，收起时不会读取远端网络表。
  fetchRuntimeConnectionList: (connectionId: string) =>
    call<RuntimeConnectionList>('fetch_runtime_connection_list', { connectionId }, {
      ...mockRuntimeConnectionList,
      capturedAt: nowIso(),
    }),
  listTunnels: () => call<TunnelRecord[]>('list_tunnels', undefined, mockTunnels),
  // 新建隧道只保存配置，真正绑定本地端口交给 startTunnel，避免端口占用导致配置无法添加。
  openTunnel: (request: TunnelOpenRequest) => {
    const normalized = normalizeTunnelRequest(request);
    return call<TunnelRecord>('open_tunnel', { request: normalized }, { ...normalized, id: crypto.randomUUID(), status: 'stopped' });
  },
  // 编辑隧道会让后端停止旧监听并保存为 stopped，用户确认后可再手动开启新端点。
  updateTunnel: (request: TunnelUpdateRequest) => {
    const normalized = normalizeTunnelRequest(request);
    const fallback = mockTunnels.find((item) => item.id === request.id);
    return call<TunnelRecord>('update_tunnel', { request: { ...normalized, id: request.id } }, {
      ...fallback,
      ...normalized,
      id: request.id,
      status: 'stopped',
    } as TunnelRecord);
  },
  startTunnel: (tunnelId: string) =>
    call<TunnelRecord>('start_tunnel', { tunnelId }, {
      ...mockTunnels.find((item) => item.id === tunnelId),
      id: tunnelId,
      connectionId: mockTunnels.find((item) => item.id === tunnelId)?.connectionId ?? mockConnections[0]?.id ?? 'local-demo-1',
      name: mockTunnels.find((item) => item.id === tunnelId)?.name ?? 'Tunnel',
      bindAddress: mockTunnels.find((item) => item.id === tunnelId)?.bindAddress ?? '127.0.0.1',
      localPort: mockTunnels.find((item) => item.id === tunnelId)?.localPort ?? 15432,
      remoteHost: mockTunnels.find((item) => item.id === tunnelId)?.remoteHost ?? '127.0.0.1',
      remotePort: mockTunnels.find((item) => item.id === tunnelId)?.remotePort ?? 5432,
      status: 'running',
    } as TunnelRecord),
  closeTunnel: (tunnelId: string) => call<boolean>('close_tunnel', { tunnelId }, true),
  // 历史列表以远端 Shell 历史文件为准，避免只记录命令面板输入而漏掉终端直接输入。
  readRemoteHistory: (connectionId: string, limit = 100) =>
    call<HistoryEntry[]>('read_remote_shell_history', { connectionId, limit }, mockHistory
      .filter((item) => item.connectionId === connectionId)
      .slice(0, limit)),
  appendHistory: (entry: Omit<HistoryEntry, 'id' | 'executedAt'> & Partial<Pick<HistoryEntry, 'id' | 'executedAt'>>) =>
    call<HistoryEntry>('append_command_history', { entry }, {
      id: entry.id ?? crypto.randomUUID(),
      connectionId: entry.connectionId,
      command: entry.command,
      executedAt: entry.executedAt ?? nowIso(),
    }),
  getSuggestions: (connectionId: string | undefined, prefix: string) =>
    call<string[]>('get_command_suggestions', { connectionId, prefix, limit: 5 }, mockHistory
      .map((item) => item.command)
      .filter((command) => command.startsWith(prefix))
      .slice(0, 5)),
  uploadConfig: () => call<string>('upload_config_to_webdav', undefined, '/myterminal/myterminal-config-20260611-142530.enc.json'),
  listConfigBackups: () => call<string[]>('list_config_backups', undefined, []),
  downloadConfig: async (remotePath: string) => {
    const state = await call<BootstrapState>('download_config_from_webdav', { remotePath }, mockState);
    return { ...state, settings: normalizeSettings(state.settings) };
  },
  testWebdavConnection: (settings: AppSettings) =>
    call<boolean>('test_webdav_connection', { webdav: normalizeSettings(settings).webdav }, true),
  exportLocalConfig: (targetPath: string) =>
    call<string>('export_local_config', { targetPath }, targetPath || 'C:/Software/WorkSpace/MyTerminal/.myterminal-data/exports/myterminal-config-demo.json'),
  importLocalConfig: async (content: string) => {
    const state = await call<BootstrapState>('import_local_config', { content }, mockState);
    return { ...state, settings: normalizeSettings(state.settings) };
  },
  // 更新检测读取 GitHub Release 元数据；Web 预览环境下返回当前版本，避免误提示本地预览需要更新。
  checkForUpdates: () => call<UpdateCheckResult>('check_for_updates', undefined, mockUpdateCheckResult),
  // 更新安装只接收后端检测出的 Release 安装包，桌面端下载到临时目录后启动安装器。
  installUpdate: (result: UpdateCheckResult) =>
    call<string>(
      'download_and_install_update',
      // 安装包大小来自 Release 元数据，后端用它判断本地缓存是否完整，避免复用半截文件。
      {
        downloadUrl: result.installerDownloadUrl,
        assetName: result.installerAssetName,
        installerSize: result.installerSize ?? null,
      },
      'C:/Software/WorkSpace/MyTerminal/.myterminal-data/updates/MyTerminal-update.exe',
    ),
  // 外链打开在桌面端交给后端调用系统浏览器；Web 预览下保持成功返回，方便本地界面调试。
  openExternalUrl: (url: string) => call<boolean>('open_external_url', { url }, true),
  // 远程背景图经后端 reqwest 下载并转为 data URL，绕开 WebView 自动附带的 Referer，避免图床防盗链返回 403。Web 预览无后端时回退为原始地址。
  fetchRemoteBackgroundImage: (url: string) =>
    call<string>('fetch_remote_background_image', { url }, url),
};
