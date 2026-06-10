import { invoke } from '@tauri-apps/api/core';

import type {
  AppSettings,
  BootstrapState,
  ConnectionProfile,
  EditorDocument,
  HistoryEntry,
  RemoteFileEntry,
  RuntimeOverview,
  TerminalOutputChunk,
  TerminalSession,
  TunnelOpenRequest,
  TunnelRecord,
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

const normalizeSettings = (settings: AppSettings): AppSettings => ({
  ...settings,
  ...normalizeFontPair(settings),
  shellFontSize: clampFontSize(settings.shellFontSize),
  runtimeRefreshIntervalSec: clampRefreshInterval(settings.runtimeRefreshIntervalSec),
  terminalBackgroundImageOpacity: clampRatio(settings.terminalBackgroundImageOpacity, 0.18),
  terminalBackgroundImageFit: terminalBackgroundImageFits.has(settings.terminalBackgroundImageFit)
    ? settings.terminalBackgroundImageFit
    : 'cover',
  terminalRightClickBehavior: settings.terminalRightClickBehavior === 'menu' ? 'menu' : 'paste',
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
    remoteSettingsPath: settings.webdav?.remoteSettingsPath ?? '/myterminal/settings.enc.json',
    remoteConnectionsPath: settings.webdav?.remoteConnectionsPath ?? '/myterminal/connections.enc.json',
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
});

const normalizeTunnelRequest = (request: TunnelOpenRequest): TunnelOpenRequest => ({
  ...request,
  bindAddress: trimToUndefined(request.bindAddress) ?? '127.0.0.1',
  localPort: clampPort(request.localPort, 15432),
  remotePort: clampPort(request.remotePort, 5432),
});

const mockSettings: AppSettings = {
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
  connectionGroups: ['ology', 'ology/ology-old'],
  connectionOrder: ['local-demo-1'],
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
  connections: mockConnections,
  history: mockHistory,
  sessions: [],
  tunnels: mockTunnels,
};

const mockAppVersion = import.meta.env.VITE_APP_VERSION ?? '0.1.3';

const mockUpdateCheckResult: UpdateCheckResult = {
  currentVersion: mockAppVersion,
  latestVersion: mockAppVersion,
  releaseName: 'MyTerminal local preview',
  releaseUrl: 'https://github.com/CrazyFigure/MyShell/releases/latest',
  updateAvailable: false,
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
    return { ...state, settings: normalizeSettings(state.settings) };
  },
  saveSettings: (settings: AppSettings) => {
    const normalized = normalizeSettings(settings);
    return call<AppSettings>('save_app_settings', { settings: normalized }, normalized);
  },
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
        connectionId,
        title: `SSH ${connectionId}`,
        status: 'stub',
        cwd: '~',
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
  downloadRemoteFile: (connectionId: string, path: string) =>
    call<string>('download_remote_file', { connectionId, path }, `C:/Software/WorkSpace/MyTerminal/.myterminal-data/downloads/${path.split('/').pop() ?? 'download.bin'}`),
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
  openTunnel: (request: TunnelOpenRequest) => {
    const normalized = normalizeTunnelRequest(request);
    return call<TunnelRecord>('open_tunnel', { request: normalized }, { ...normalized, id: crypto.randomUUID(), status: 'running' });
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
  uploadSettings: () => call<boolean>('upload_settings_to_webdav', undefined, true),
  downloadSettings: async () => normalizeSettings(await call<AppSettings>('download_settings_from_webdav', undefined, mockSettings)),
  uploadConnections: () => call<boolean>('upload_connections_to_webdav', undefined, true),
  downloadConnections: () => call<ConnectionProfile[]>('download_connections_from_webdav', undefined, mockConnections),
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
      { downloadUrl: result.installerDownloadUrl, assetName: result.installerAssetName },
      'C:/Software/WorkSpace/MyTerminal/.myterminal-data/updates/MyShell-update.exe',
    ),
  // 外链打开在桌面端交给后端调用系统浏览器；Web 预览下保持成功返回，方便本地界面调试。
  openExternalUrl: (url: string) => call<boolean>('open_external_url', { url }, true),
};
