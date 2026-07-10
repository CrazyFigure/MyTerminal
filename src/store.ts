import { create } from 'zustand';

import { backend } from './backend';
import { translate } from './i18n';
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
  SshJumpHost,
  SshProxyConfig,
  TerminalSession,
  TerminalOutputChunk,
  TunnelDraft,
  TunnelOpenRequest,
  TunnelRecord,
  TunnelUpdateRequest,
  UpdateCheckResult,
  WorkspacePanel,
} from './types';

const defaultSettings: AppSettings = {
  uiLanguage: 'zh-CN',
  themeMode: 'light',
  runtimeRefreshIntervalSec: 1,
  // 大文件扫描独立于常规运行状态，默认 5 秒刷新一次。
  runtimeStorageRefreshIntervalSec: 5,
  // 进程/线程资源明细只在内存展开时刷新，默认 3 秒。
  runtimeResourceRefreshIntervalSec: 3,
  runtimeResourceSource: 'system',
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
  // 行号栏默认显示行号与时间戳，与常见远程终端习惯保持一致。
  terminalGutterShowLineNumber: true,
  terminalGutterShowTimestamp: true,
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

// 本地终端默认提供“纯 shell”和常见 AI CLI，空命令由后端解释为打开系统 shell。
const defaultLocalTerminals: LocalTerminalSettings = {
  shellPath: '',
  commands: [
    { id: 'shell', name: '本地终端', command: '', builtIn: true },
    { id: 'claude', name: 'claude', command: 'claude', builtIn: true },
    { id: 'codex', name: 'codex', command: 'codex', builtIn: true },
    { id: 'opencode', name: 'opencode', command: 'opencode', builtIn: true },
  ],
  profiles: [],
};

// 状态栏展示命令名时把空命令转成可读名称，避免用户看到空白提示。
const localTerminalCommandLabel = (settings: AppSettings, command: string) =>
  command.trim() || translate(settings.uiLanguage, 'localTerminalTitle');

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
  jumpHosts: [],
  proxy: {
    enabled: false,
    type: 'socks5',
    host: '',
    port: 1080,
    username: '',
    password: '',
  },
  note: '',
  tags: [],
});

const emptyTunnelDraft = (): TunnelDraft => ({
  id: '',
  connectionId: '',
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

const uploadRemoteName = (file: File) => {
  // 目录上传依赖浏览器提供的 webkitRelativePath 保留根目录和子目录；单文件上传没有该字段时退回文件名。
  const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  const normalized = relativePath
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
  return normalized || file.name;
};

// 跳板机草稿默认用独立 id 保持增删排序稳定；认证字段按主机独立保存，支持多级链路不同账号。
const emptyJumpHostDraft = (): SshJumpHost => ({
  id: crypto.randomUUID(),
  name: '',
  host: '',
  port: 22,
  username: '',
  authMethod: 'password',
  password: '',
  privateKeyPath: '',
  privateKeyText: '',
  passphrase: '',
});

// 代理草稿允许临时关闭但保留输入值，默认 SOCKS5/1080 更贴近常见本地代理习惯。
const emptyProxyDraft = (): SshProxyConfig => ({
  enabled: false,
  type: 'socks5',
  host: '',
  port: 1080,
  username: '',
  password: '',
});

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

const clampPort = (value: number | undefined, fallback = 22) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(65535, Math.max(1, Math.trunc(value)));
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

const normalizeAuthMethod = (authMethod?: string) => (authMethod === 'privateKey' ? 'privateKey' : 'password');

// 连接保存前统一清洗跳板机字段：空敏感字段不落到无意义字符串，端口不合法时回退 SSH 默认端口。
const normalizeJumpHost = (jumpHost: SshJumpHost): SshJumpHost => {
  const authMethod = normalizeAuthMethod(jumpHost.authMethod);
  return {
    id: jumpHost.id || crypto.randomUUID(),
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

// 代理只作用于第一跳；关闭时仍保留配置，方便用户临时启停。
const normalizeProxyConfig = (proxy?: SshProxyConfig): SshProxyConfig => ({
  enabled: Boolean(proxy?.enabled),
  type: proxy?.type === 'http' ? 'http' : 'socks5',
  host: proxy?.host?.trim() ?? '',
  port: clampPort(proxy?.port, 1080),
  username: trimToUndefined(proxy?.username),
  password: keepTextIfPresent(proxy?.password),
});

// 旧连接没有 jumpHosts/proxy 字段，加载到前端状态时补齐默认值，避免编辑旧连接时报 undefined。
const normalizeLoadedConnection = (connection: ConnectionProfile): ConnectionProfile => ({
  ...connection,
  jumpHosts: Array.isArray(connection.jumpHosts) ? connection.jumpHosts : [],
  proxy: normalizeProxyConfig(connection.proxy),
  tags: Array.isArray(connection.tags) ? connection.tags : [],
});

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

  const match = lastLine.match(/^cd(?:\s+(.+?))?\s*;?$/);
  if (!match) {
    return undefined;
  }

  const rawTarget = stripWrappedQuotes((match[1]?.trim() ?? '').replace(/^--\s+/, ''));
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
const isUsableRemoteSession = (session?: TerminalSession): session is TerminalSession =>
  session?.kind !== 'local' && (session?.status === 'connected' || session?.status === 'stub');
const isUsableTerminalSession = (session?: TerminalSession): session is TerminalSession =>
  Boolean(session && !['closed', 'error'].includes(session.status));

// 终端输出走浏览器事件直达 xterm，避免高频输出通过 React 状态触发整页重渲染。
const emitTerminalOutput = (chunk: TerminalOutputChunk) => {
  if (typeof window === 'undefined' || !chunk.content) {
    return;
  }

  window.dispatchEvent(new CustomEvent(terminalOutputEventName, { detail: chunk }));
};

// 终端输入跨 Tauri IPC 写入：交互按键只合并同一浏览器事件轮次，避免固定延迟造成远端 echo 成批出现。
const terminalInputBuffers = new Map<string, string>();
const terminalInputFlushPromises = new Map<string, Promise<void>>();
// 即时刷新任务只用微任务排队，不用 setTimeout；同一轮 onData 的多段输入会自然合并，下一轮按键会立刻发出。
const terminalInputImmediateFlushSessions = new Set<string>();
const terminalInputFlushTimers = new Map<string, number>();
const terminalInputFlushTimerDelays = new Map<string, number>();
// 终端直接输入不会经过命令面板；按会话记录当前命令行，用于识别回车后的 cd 并兜底刷新文件管理。
const terminalInputLineBuffers = new Map<string, string>();
// 大段粘贴保留极短合并窗口，避免一次粘贴拆成大量 IPC；普通按键和编辑键不走这个延迟。
const terminalBulkInputFlushDelayMs = 8;
// 普通可打印字符使用单帧级合并，降低 WebView->Rust IPC 频率，同时把体感延迟压在不可感知范围内。
const terminalInteractiveInputFlushDelayMs = 2;
// xterm 的方向键/Delete 等控制序列通常只有 3-4 字节；超过该阈值基本可视为粘贴或程序批量输入。
const terminalBulkInputThreshold = 64;

// 会话关闭或重连时清理尚未写入的输入，避免旧 PTY 已释放后仍被延迟刷新命中。
const clearQueuedTerminalInput = (sessionId: string) => {
  const pendingTimer = terminalInputFlushTimers.get(sessionId);
  if (pendingTimer) {
    window.clearTimeout(pendingTimer);
    terminalInputFlushTimers.delete(sessionId);
    terminalInputFlushTimerDelays.delete(sessionId);
  }
  terminalInputImmediateFlushSessions.delete(sessionId);
  terminalInputBuffers.delete(sessionId);
  terminalInputLineBuffers.delete(sessionId);
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

// 交互输入入队后用微任务立即刷新，去掉固定毫秒级等待；这保持远端 echo 语义，不做本地假回显。
const scheduleImmediateTerminalInputFlush = (sessionId: string) => {
  if (terminalInputImmediateFlushSessions.has(sessionId)) {
    return;
  }
  terminalInputImmediateFlushSessions.add(sessionId);
  window.queueMicrotask(() => {
    terminalInputImmediateFlushSessions.delete(sessionId);
    void flushQueuedTerminalInput(sessionId).catch(() => undefined);
  });
};

// 批量输入才使用短定时窗口，多个粘贴分片会并成一次后端写入，降低 SSH channel 抖动。
const scheduleDelayedTerminalInputFlush = (sessionId: string, flushDelayMs: number) => {
  const pendingTimer = terminalInputFlushTimers.get(sessionId);
  if (pendingTimer) {
    const pendingDelayMs = terminalInputFlushTimerDelays.get(sessionId) ?? terminalBulkInputFlushDelayMs;
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

// 终端输入默认立即刷新；仅对大段文本启用短窗口合并，避免牺牲单字符输入跟手感。
const queueTerminalInput = (sessionId: string, data: string, flushDelayMs = 0) => {
  terminalInputBuffers.set(sessionId, `${terminalInputBuffers.get(sessionId) ?? ''}${data}`);

  if (flushDelayMs <= 0) {
    const pendingTimer = terminalInputFlushTimers.get(sessionId);
    if (pendingTimer) {
      window.clearTimeout(pendingTimer);
      terminalInputFlushTimers.delete(sessionId);
      terminalInputFlushTimerDelays.delete(sessionId);
    }
    scheduleImmediateTerminalInputFlush(sessionId);
    return;
  }

  scheduleDelayedTerminalInputFlush(sessionId, flushDelayMs);
};

const isTerminalEditingInput = (data: string) => data.includes('\x7f') || data.includes('\b') || data.includes('\x1b[3~');
// 回车、Tab、控制序列和编辑键必须立即送到远端；粘贴文本里包含换行时也要立刻刷新，避免命令执行和 cwd 同步滞后。
const shouldFlushTerminalInputImmediately = (data: string) =>
  data.includes('\r') ||
  data.includes('\n') ||
  data === '\t' ||
  data.includes('\x1b') ||
  isTerminalEditingInput(data);
// 大段文本不属于逐键交互，允许 8ms 合并；普通字符走 2ms 合并，控制序列仍立即进入远端 PTY。
const isBulkTerminalInput = (data: string) => data.length > terminalBulkInputThreshold && !isTerminalEditingInput(data);

// 命令行预测只关心用户输入的可见文本；括号粘贴边界和 CSI 控制序列必须先剥离，避免污染 cd 解析。
const terminalBracketedPasteBoundaryPattern = /\x1b\[(?:200|201)~/g;
const terminalCsiSequencePattern = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const terminalShortEscapeSequencePattern = /\x1b./g;

const normalizeTerminalInputForCommandTracking = (data: string) =>
  data
    .replace(terminalBracketedPasteBoundaryPattern, '')
    .replace(terminalCsiSequencePattern, '')
    .replace(terminalShortEscapeSequencePattern, '');

const extractCompletedTerminalInputLines = (sessionId: string, data: string) => {
  let currentLine = terminalInputLineBuffers.get(sessionId) ?? '';
  const completedLines: string[] = [];

  for (const character of normalizeTerminalInputForCommandTracking(data)) {
    if (character === '\x03' || character === '\x15') {
      // Ctrl+C / Ctrl+U 会放弃当前命令行，前端预测也必须同步清空，避免下一次回车误判旧 cd。
      currentLine = '';
      continue;
    }
    if (character === '\x7f' || character === '\b') {
      currentLine = currentLine.slice(0, -1);
      continue;
    }
    if (character === '\r' || character === '\n') {
      const completedLine = currentLine.trim();
      if (completedLine) {
        completedLines.push(completedLine);
      }
      currentLine = '';
      continue;
    }
    if (character === '\t' || character >= ' ') {
      currentLine += character;
    }
  }

  if (currentLine) {
    terminalInputLineBuffers.set(sessionId, currentLine);
  } else {
    terminalInputLineBuffers.delete(sessionId);
  }

  return completedLines;
};

// 远端刷新请求可能被快速 cd、目录双击或自动轮询连续触发；序号只允许最后一次结果落到界面。
let remoteFilesRefreshSeq = 0;
let runtimeOverviewRefreshSeq = 0;
let remoteHistoryRefreshSeq = 0;
let remoteFilesAutoRefreshTimer: number | undefined;
let remoteFilesRefreshInFlight = false;
let remoteFilesQueuedRequest: { connectionId: string; path: string; seq: number } | undefined;
// cwd 自动同步只做轻量延迟，给用户连续输入留出优先级，避免刚 cd 就立刻抢占远端 SFTP 连接。
const remoteFilesAutoRefreshDelayMs = 360;

const statusText = (
  settings: AppSettings,
  key: Parameters<typeof translate>[1],
  replacements?: Parameters<typeof translate>[2],
) => translate(settings.uiLanguage, key, replacements);

const isValidPort = (value: number) => Number.isInteger(value) && value >= 1 && value <= 65535;

// 隧道草稿先校验本地必填项和端口范围，端口占用等运行态问题交给启动监听时返回明确错误。
const getTunnelDraftValidationKey = (draft: TunnelDraft) => {
  if (!draft.name.trim()) {
    return 'validationNameRequired' as const;
  }
  if (!draft.bindAddress.trim()) {
    return 'validationBindAddressRequired' as const;
  }
  if (!isValidPort(draft.localPort) || !isValidPort(draft.remotePort)) {
    return 'validationPortInvalid' as const;
  }
  if (!draft.remoteHost.trim()) {
    return 'validationRemoteHostRequired' as const;
  }

  return undefined;
};

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

  for (const jumpHost of draft.jumpHosts) {
    if (!jumpHost.host.trim()) {
      return 'validationJumpHostRequired' as const;
    }
    if (!jumpHost.username.trim()) {
      return 'validationJumpUsernameRequired' as const;
    }
    if (!isValidPort(jumpHost.port)) {
      return 'validationPortInvalid' as const;
    }
    if (jumpHost.authMethod === 'privateKey') {
      if (!jumpHost.privateKeyPath?.trim() && !jumpHost.privateKeyText?.trim()) {
        return 'validationJumpPrivateKeyRequired' as const;
      }
    } else if (!jumpHost.password?.trim()) {
      return 'validationJumpPasswordRequired' as const;
    }
  }

  if (draft.proxy.enabled) {
    if (!draft.proxy.host.trim()) {
      return 'validationProxyHostRequired' as const;
    }
    if (!isValidPort(draft.proxy.port)) {
      return 'validationPortInvalid' as const;
    }
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
    jumpHosts: draft.jumpHosts.map((jumpHost) => normalizeJumpHost(jumpHost)),
    proxy: normalizeProxyConfig(draft.proxy),
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
  saveLocalTerminals: (settings: LocalTerminalSettings) => Promise<LocalTerminalSettings>;
  openLocalTerminal: (profile: LocalTerminalProfile) => Promise<void>;
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
            tags: [...connection.tags],
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

  reconnectSession: async (sessionId) => {
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
      ? guessNextRemotePath(state.currentRemotePath, rawCommand)
      : undefined;

    await flushQueuedTerminalInput(sessionId);
    await backend.writeTerminalInput(sessionId, rawCommand.endsWith('\n') ? rawCommand : `${rawCommand}\n`);

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

    let nextRemotePath: string | undefined;
    if (isUsableRemoteSession(session) && session.connectionId === state.activeConnectionId) {
      let pathCursor = state.currentRemotePath || session.cwd || '~';
      for (const completedLine of extractCompletedTerminalInputLines(sessionId, data)) {
        const guessedPath = guessNextRemotePath(pathCursor, completedLine);
        if (guessedPath) {
          pathCursor = guessedPath;
          nextRemotePath = guessedPath;
        }
      }
    }

    const submittedInput = data.includes('\r') || data.includes('\n');
    const flushDelayMs = shouldFlushTerminalInputImmediately(data)
      ? 0
      : isBulkTerminalInput(data)
        ? terminalBulkInputFlushDelayMs
        : terminalInteractiveInputFlushDelayMs;
    queueTerminalInput(sessionId, data, flushDelayMs);
    if (submittedInput) {
      await flushQueuedTerminalInput(sessionId);
      void get().pollTerminalOutputs();
      if (nextRemotePath) {
        // 终端本体里粘贴或手输 cd 不经过命令面板，先用输入侧预测兜底刷新；后端真实 PWD 标记回来后会再次校正。
        void get().refreshFiles(nextRemotePath);
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
          isUsableRemoteSession(nextSession) &&
          state.currentRemotePath !== cwd
        ) {
          // cwd 元数据来自交互 Shell 的真实 PWD，先更新路径栏；文件列表随后异步刷新，慢 SFTP 不应挡住路径同步。
          activeCwdToRefresh = cwd;
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
        ...(activeCwdToRefresh ? { currentRemotePath: activeCwdToRefresh } : {}),
        // 会话变为不可用（断开/异常）时清掉残留的远端数据，避免继续展示上一台主机的内容。
        ...(shouldClearActiveRemoteData ? { files: [], runtimeOverview: undefined, currentRemotePath: '' } : {}),
        // 加载动画的熄灭独立判断，覆盖“无旧数据可清但动画已点亮”的握手失败场景。
        ...(shouldStopLoading ? { filesLoading: false, runtimeLoading: false, historyLoading: false } : {}),
      };
    });

    if (activeCwdToRefresh) {
      if (remoteFilesAutoRefreshTimer !== undefined) {
        window.clearTimeout(remoteFilesAutoRefreshTimer);
      }
      // cwd 来自远端提示符，延迟刷新文件树可以吸收快速 cd/ls 连续输入，避免 SFTP 刷新阻塞终端输入反馈。
      remoteFilesAutoRefreshTimer = window.setTimeout(() => {
        remoteFilesAutoRefreshTimer = undefined;
        void get().refreshFiles(activeCwdToRefresh);
      }, remoteFilesAutoRefreshDelayMs);
    }
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
    const resolveRefreshRequest = () => {
      const { activeConnectionId, activeSessionId, currentRemotePath, sessions } = get();
      const activeSession = sessions.find((item) => item.id === activeSessionId);
      const activeRemoteConnectionId = isUsableRemoteSession(activeSession) ? activeSession?.connectionId : undefined;
      // 文件管理必须绑定已打开的终端会话；只选中连接时不展示也不刷新远端文件。
      if (!activeConnectionId || activeConnectionId !== activeRemoteConnectionId) {
        return undefined;
      }

      return {
        connectionId: activeConnectionId,
        path: path ?? currentRemotePath,
        seq: ++remoteFilesRefreshSeq,
      };
    };

    const firstRequest = resolveRefreshRequest();
    if (!firstRequest) {
      return;
    }

    if (remoteFilesRefreshInFlight) {
      // SFTP 刷新串行执行，正在刷新时只保留最后一次目标路径，避免快速 cd/双击目录堆出多条 SSH 连接。
      remoteFilesQueuedRequest = firstRequest;
      return;
    }

    // 当前列表为空时才显示加载动画；已有旧文件内容时静默刷新，避免闪烁。
    if (!get().files.length) {
      set({ filesLoading: true });
    }
    remoteFilesRefreshInFlight = true;
    let request: typeof firstRequest | undefined = firstRequest;
    try {
      while (request) {
        const currentRequest = request;
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
}));
