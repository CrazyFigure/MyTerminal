import { invoke } from '@tauri-apps/api/core';

import type {
  AgentBridgeRequest,
  AgentBridgeStatus,
  AppSettings,
  BootstrapState,
  ConnectionProfile,
  EditorDocument,
  FileTransferSummary,
  HistoryEntry,
  LocalTerminalProfile,
  LocalTerminalSettings,
  RemoteFileEntry,
  RuntimeOverview,
  SshJumpHost,
  SshProxyConfig,
  TerminalOutputChunk,
  TerminalSession,
  TunnelOpenRequest,
  TunnelRecord,
  TunnelUpdateRequest,
  UpdateCheckResult,
} from './types';

const isTauriRuntime = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const nowIso = () => new Date().toISOString();

const clampInteger = (value: number, min: number, max: number, fallback: number) => {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
};

const clampU16 = (value: number, fallback: number) => clampInteger(value, 0, 65535, fallback);
const clampPort = (value: number, fallback = 22) => clampInteger(value, 1, 65535, fallback);
const clampFontSize = (value: number, fallback = 15) => clampInteger(value, 8, 48, fallback);
const clampRefreshInterval = (value: number, fallback = 1) => clampInteger(value, 1, 60, fallback);
const clampRatio = (value: number | undefined, fallback: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, value));
};

const terminalBackgroundImageFits = new Set<AppSettings['terminalBackgroundImageFit']>(['cover', 'contain', 'stretch', 'tile', 'center']);
// 长行展示模式只接受前端枚举值，旧配置或手动编辑错误时回落到自动换行。
const terminalLineWrapModes = new Set<AppSettings['terminalLineWrapMode']>(['wrap', 'horizontal']);

const normalizeSingleFontFamily = (value: string) => {
  // 旧配置可能保存过一整串 fallback 字体；设置页只展示和保存用户明确选择的单个字体。
  const firstFont = value
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .find(Boolean);
  return firstFont ?? 'JetBrains Mono';
};

// 中英文字体拆分后仍同步旧字段，避免旧配置、Monaco 编辑器和旧版本数据读取到空字体。
const normalizeFontPair = (settings: AppSettings) => {
  const legacyFontFamily = normalizeSingleFontFamily(settings.shellFontFamily ?? 'JetBrains Mono');
  const shellLatinFontFamily = normalizeSingleFontFamily(settings.shellLatinFontFamily ?? legacyFontFamily);
  const shellCjkFontFamily = normalizeSingleFontFamily(settings.shellCjkFontFamily ?? shellLatinFontFamily);
  return {
    shellLatinFontFamily,
    shellCjkFontFamily,
    // 旧字段保留为 CSS 字体族组合，供编辑器和旧版本配置继续读取。
    shellFontFamily: [shellLatinFontFamily, shellCjkFontFamily]
      .filter((fontFamily, index, array) => array.indexOf(fontFamily) === index)
      .join(', '),
  };
};

const trimToUndefined = (value?: string) => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const keepTextIfPresent = (value?: string) => {
  if (typeof value !== 'string') {
    return undefined;
  }

  return value.trim() ? value : undefined;
};

// 跳板机作为连接链路的一部分，保存和测试前必须按主连接同一规则整理认证与端口。
const normalizeJumpHost = (jumpHost: SshJumpHost): SshJumpHost => {
  const authMethod = jumpHost.authMethod === 'privateKey' ? 'privateKey' : 'password';
  return {
    id: jumpHost.id,
    name: trimToUndefined(jumpHost.name),
    host: jumpHost.host.trim(),
    port: clampPort(jumpHost.port),
    username: jumpHost.username.trim(),
    authMethod,
    password: authMethod === 'password' ? jumpHost.password ?? '' : undefined,
    privateKeyPath: authMethod === 'privateKey' ? trimToUndefined(jumpHost.privateKeyPath) : undefined,
    privateKeyText: authMethod === 'privateKey' ? keepTextIfPresent(jumpHost.privateKeyText) : undefined,
    passphrase: authMethod === 'privateKey' ? keepTextIfPresent(jumpHost.passphrase) : undefined,
  };
};

// 代理配置只作用在第一跳，关闭时仍随连接保存，便于用户临时启停。
const normalizeProxyConfig = (proxy?: SshProxyConfig): SshProxyConfig => ({
  enabled: Boolean(proxy?.enabled),
  type: proxy?.type === 'http' ? 'http' : 'socks5',
  host: proxy?.host?.trim() ?? '',
  port: clampPort(proxy?.port ?? 1080, 1080),
  username: trimToUndefined(proxy?.username),
  password: keepTextIfPresent(proxy?.password),
});

const normalizeSettings = (settings: AppSettings): AppSettings => ({
  ...settings,
  ...normalizeFontPair(settings),
  shellFontSize: clampFontSize(settings.shellFontSize),
  runtimeRefreshIntervalSec: clampRefreshInterval(settings.runtimeRefreshIntervalSec),
  // SSH 保活间隔：0 表示关闭；否则夹在 10~300 秒之间，避免过于频繁或形同虚设。
  sshKeepaliveIntervalSec: (() => {
    const value = Math.round(Number(settings.sshKeepaliveIntervalSec));
    if (!Number.isFinite(value) || value <= 0) {
      return 0;
    }
    return Math.min(300, Math.max(10, value));
  })(),
  terminalBackgroundImageOpacity: clampRatio(settings.terminalBackgroundImageOpacity, 0.18),
  terminalBackgroundImageFit: terminalBackgroundImageFits.has(settings.terminalBackgroundImageFit)
    ? settings.terminalBackgroundImageFit
    : 'cover',
  terminalRightClickBehavior: settings.terminalRightClickBehavior === 'menu' ? 'menu' : 'paste',
  // 旧配置没有长行展示字段时保持原来的自动换行，避免升级后突然改变终端布局。
  terminalLineWrapMode: terminalLineWrapModes.has(settings.terminalLineWrapMode)
    ? settings.terminalLineWrapMode
    : 'wrap',
  // 旧配置没有匹配高亮字段时默认开启，符合新版本的终端阅读体验。
  terminalMatchSelection: settings.terminalMatchSelection !== false,
  // 分组和连接排序来自用户拖拽结果，规范化时只去重清洗，不再按字母重新排序。
  connectionGroups: Array.from(
    new Set(
      (settings.connectionGroups ?? [])
        .map((groupPath) => groupPath.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/'))
        .filter(Boolean),
    ),
  ),
  connectionOrder: Array.from(new Set((settings.connectionOrder ?? []).filter(Boolean))),
  quickCommands: settings.quickCommands ?? [],
  webdav: {
    baseUrl: settings.webdav?.baseUrl ?? '',
    username: settings.webdav?.username ?? '',
    password: settings.webdav?.password ?? '',
    syncPassphrase: settings.webdav?.syncPassphrase ?? '',
    remotePath: settings.webdav?.remotePath ?? '/myterminal',
  },
  agentBridge: {
    enabled: Boolean(settings.agentBridge?.enabled),
    autoExecute: Boolean(settings.agentBridge?.autoExecute),
    allowedConnectionIds: Array.from(new Set(settings.agentBridge?.allowedConnectionIds ?? [])),
    defaultTimeoutSec: Math.min(3600, Math.max(1, Number(settings.agentBridge?.defaultTimeoutSec) || 60)),
    maxOutputBytes: Math.min(10_000_000, Math.max(1024, Number(settings.agentBridge?.maxOutputBytes) || 200_000)),
  },
});

const normalizeConnection = (connection: ConnectionProfile): ConnectionProfile => ({
  ...connection,
  groupPath: trimToUndefined(connection.groupPath)?.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
  port: clampPort(connection.port),
  tags: Array.isArray(connection.tags) ? connection.tags : [],
  authMethod: connection.authMethod === 'privateKey' ? 'privateKey' : 'password',
  password: connection.authMethod === 'privateKey' ? undefined : connection.password ?? '',
  privateKeyPath:
    connection.authMethod === 'privateKey' ? trimToUndefined(connection.privateKeyPath) : undefined,
  privateKeyText:
    connection.authMethod === 'privateKey' ? keepTextIfPresent(connection.privateKeyText) : undefined,
  passphrase:
    connection.authMethod === 'privateKey' ? keepTextIfPresent(connection.passphrase) : undefined,
  jumpHosts: Array.isArray(connection.jumpHosts)
    ? connection.jumpHosts.map((jumpHost) => normalizeJumpHost(jumpHost))
    : [],
  proxy: normalizeProxyConfig(connection.proxy),
});

// 隧道请求在进入 Tauri IPC 前统一清洗端点，避免前后端对空监听地址和端口默认值理解不一致。
const normalizeTunnelRequest = (request: TunnelOpenRequest): TunnelOpenRequest => ({
  ...request,
  bindAddress: trimToUndefined(request.bindAddress) ?? '127.0.0.1',
  name: request.name.trim(),
  remoteHost: request.remoteHost.trim(),
  localPort: clampPort(request.localPort, 15432),
  remotePort: clampPort(request.remotePort, 5432),
});

// 本地终端配置在 Web stub 和 Tauri 后端之间保持同一套归一化规则，空命令表示纯 shell。
const normalizeLocalTerminalSettings = (settings: LocalTerminalSettings): LocalTerminalSettings => {
  // 内置命令始终补齐，避免旧配置缺失“本地终端”导致无法直接打开 shell。
  const defaultCommands: LocalTerminalSettings['commands'] = [
    { id: 'shell', name: '本地终端', command: '', builtIn: true },
    { id: 'claude', name: 'claude', command: 'claude', builtIn: true },
    { id: 'codex', name: 'codex', command: 'codex', builtIn: true },
    { id: 'opencode', name: 'opencode', command: 'opencode', builtIn: true },
  ];
  const commandMap = new Map<string, LocalTerminalSettings['commands'][number]>();
  [...(settings.commands ?? []), ...defaultCommands].forEach((item) => {
    const command = item.command.trim();
    const name = item.name.trim() || command || '本地终端';
    if (!command && !item.builtIn) {
      return;
    }
    const id = item.id.trim() || command || 'shell';
    if (!commandMap.has(id)) {
      commandMap.set(id, { id, name, command, builtIn: Boolean(item.builtIn) });
    }
  });

  // 历史目录只要求目录有效；命令允许为空，空命令由后端解释为直接打开本地 shell。
  const profiles = (settings.profiles ?? [])
    .map((profile) => ({
      ...profile,
      id: profile.id?.trim() || crypto.randomUUID(),
      cwd: profile.cwd.trim(),
      command: profile.command.trim(),
      lastUsedAt: profile.lastUsedAt || '',
    }))
    .filter((profile) => profile.cwd)
    .map((profile) => ({
      ...profile,
      title: profile.title?.trim() || (profile.command ? `${profile.command} · ${profile.cwd}` : profile.cwd),
    }));

  return {
    shellPath: settings.shellPath?.trim() ?? '',
    commands: Array.from(commandMap.values()),
    profiles,
  };
};

const mockSettings: AppSettings = {
  uiLanguage: 'zh-CN',
  themeMode: 'light',
  runtimeRefreshIntervalSec: 1,
  sshKeepaliveIntervalSec: 30,
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
  terminalLineWrapMode: 'wrap',
  terminalMatchSelection: true,
  compactSidebar: false,
  showCommandGhost: true,
  connectionGroups: ['ology', 'ology/ology-old'],
  connectionOrder: ['local-demo-1'],
  quickCommands: ['pwd', 'ls -la', 'docker ps'],
  webdav: {
    baseUrl: '',
    username: '',
    password: '',
    syncPassphrase: '',
    remotePath: '/myterminal',
  },
  agentBridge: {
    enabled: false,
    autoExecute: false,
    allowedConnectionIds: [],
    defaultTimeoutSec: 60,
    maxOutputBytes: 200000,
  },
};

const mockLocalTerminals: LocalTerminalSettings = {
  shellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  commands: [
    { id: 'shell', name: '本地终端', command: '', builtIn: true },
    { id: 'claude', name: 'claude', command: 'claude', builtIn: true },
    { id: 'codex', name: 'codex', command: 'codex', builtIn: true },
    { id: 'opencode', name: 'opencode', command: 'opencode', builtIn: true },
  ],
  profiles: [],
};

const mockConnections: ConnectionProfile[] = [
  {
    id: 'local-demo-1',
    name: 'Ubuntu Demo',
    groupPath: 'ology/ology-old',
    host: '192.168.12.28',
    port: 22,
    username: 'root',
    authMethod: 'password',
    password: 'password',
    jumpHosts: [],
    proxy: {
      enabled: false,
      type: 'socks5',
      host: '',
      port: 1080,
    },
    note: 'Stub connection for UI preview.',
    tags: ['demo', 'linux'],
  },
];

const mockHistory: HistoryEntry[] = [
  { id: 'hist-1', connectionId: 'local-demo-1', command: 'ls -la', executedAt: nowIso() },
  { id: 'hist-2', connectionId: 'local-demo-1', command: 'docker ps', executedAt: nowIso() },
  { id: 'hist-3', connectionId: 'local-demo-1', command: 'tail -f /var/log/syslog', executedAt: nowIso() },
];

const mockFiles: RemoteFileEntry[] = [
  { name: 'etc', path: '/etc', isDir: true, size: 0, modifiedAt: nowIso() },
  { name: 'var', path: '/var', isDir: true, size: 0, modifiedAt: nowIso() },
  { name: 'logs', path: '/srv/app/logs', isDir: true, isSymlink: true, size: 0, modifiedAt: nowIso() },
  { name: 'nginx.conf', path: '/etc/nginx/nginx.conf', isDir: false, size: 4380, modifiedAt: nowIso() },
  { name: 'app.env', path: '/srv/app/.env', isDir: false, size: 214, modifiedAt: nowIso() },
];

const mockRuntimeOverview: RuntimeOverview = {
  host: '192.168.12.28',
  os: 'Linux demo-host 6.8 x86_64',
  cpu: 'Load 0.21',
  cpuCores: [
    { name: 'CPU 0', percent: 18 },
    { name: 'CPU 1', percent: 24 },
    { name: 'CPU 2', percent: 11 },
    { name: 'CPU 3', percent: 35 },
  ],
  memory: '1423 / 4096 MB (35%)',
  storage: '18 / 64 GB (29%)',
  network: '192.168.12.28',
  uptime: '3d 4h',
};

const mockTunnels: TunnelRecord[] = [
  {
    id: 'tunnel-demo-1',
    connectionId: 'local-demo-1',
    name: 'Postgres 5432',
    bindAddress: '127.0.0.1',
    localPort: 15432,
    remoteHost: '127.0.0.1',
    remotePort: 5432,
    status: 'stub',
  },
];

const mockState: BootstrapState = {
  settings: mockSettings,
  localTerminals: mockLocalTerminals,
  connections: mockConnections,
  history: mockHistory,
  sessions: [],
  tunnels: mockTunnels,
};

const mockAgentBridgeStatus: AgentBridgeStatus = {
  enabled: false,
  running: false,
  discoveryPath: 'C:/Software/WorkSpace/MyTerminal/.myterminal-data/agent-bridge-discovery.json',
  cliCommand: 'myterminal-cli bridge status --json',
  mcpCommand: 'myterminal-cli mcp --stdio',
};

// 前端预览环境没有后端版本接口时，沿用 Vite 从 package.json 注入的版本作为展示与更新检查兜底。
const mockAppVersion = import.meta.env.VITE_APP_VERSION;

const mockUpdateCheckResult: UpdateCheckResult = {
  currentVersion: mockAppVersion,
  latestVersion: mockAppVersion,
  releaseName: 'MyTerminal local preview',
  // 本地预览的更新结果也保持真实 Release 地址，便于关于页和安装链路一致跳转。
  releaseUrl: 'https://github.com/CrazyFigure/MyTerminal/releases/latest',
  updateAvailable: false,
  releaseBody: '本地预览环境没有可用的更新内容。',
};

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
};
