import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DependencyList,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import {
  Activity,
  Bot,
  Cable,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  FileCode2,
  FileSymlink,
  FileText,
  Folder,
  FolderOpen,
  FolderTree,
  GripVertical,
  HardDrive,
  History,
  Info,
  Laptop,
  MemoryStick,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  Square,
  TerminalSquare,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

import { translate, translateStatus, type TranslationKey } from './i18n';
import { TerminalWorkspace } from './TerminalWorkspace';
import { backend } from './backend';
import { writeClipboardText } from './clipboard';
import { useAppStore } from './store';
import type { AgentBridgeRequest, AgentBridgeStatus, AppSettings, ConnectionDraft, ConnectionProfile, LocalTerminalCommand, LocalTerminalProfile, LocalTerminalSettings, RemoteFileEntry, SshJumpHost, TerminalSession, UiLanguage, UpdateCheckResult } from './types';

const MonacoEditor = lazy(() => import('./MonacoEditor'));

type BottomPanelTab = 'commands' | 'tunnels' | 'history';
type SettingsTab = 'appearance' | 'sync' | 'agent' | 'about';
type ConnectionFormTab = 'basic' | 'jumpHosts' | 'proxy';
type FileContextMenuState = {
  file: RemoteFileEntry;
  x: number;
  y: number;
};
type SessionContextMenuState = {
  sessionId: string;
  x: number;
  y: number;
};
type InsertPlacement = 'before' | 'after';
type SessionTabDragState = {
  id: string;
  label: string;
  originX: number;
  originY: number;
  currentX: number;
  currentY: number;
} | null;
type SessionTabDropTarget = { sessionId: string; placement: InsertPlacement } | { type: 'end' } | null;
// 传输进度用于给上传、下载、编辑读取和批量删除提供轻量阶段反馈；真实字节级进度需要后端分块事件再扩展。
type TransferProgressItem = {
  id: string;
  title: string;
  percent: number;
  status: 'running' | 'success' | 'error';
  message?: string;
};
type ConnectionGroupNode = {
  name: string;
  path: string;
  children: ConnectionGroupNode[];
  connections: ConnectionProfile[];
};
type ConnectionManagerDragState =
  | { type: 'connection'; id: string; label: string; originX: number; originY: number; currentX: number; currentY: number }
  | { type: 'group'; path: string; label: string; originX: number; originY: number; currentX: number; currentY: number }
  | null;
type ConnectionManagerDropTarget =
  | { type: 'connection-insert'; connectionId: string; placement: InsertPlacement }
  | { type: 'connection-end' }
  | { type: 'connection-group'; groupPath: string }
  | { type: 'connection-ungrouped' }
  | { type: 'group-insert'; groupPath: string; placement: InsertPlacement }
  | { type: 'group-end' }
  | null;

const ungroupedGroupPath = '__ungrouped__';

// 文件管理列宽保持紧凑默认值，同时给名称列更多可扩展空间，方便长文件名场景手动拉宽。
const explorerDefaultColumnWidths = [220, 70, 62, 132, 92, 118];
// 文件管理列表使用固定行高做虚拟滚动，目录文件很多时也只渲染视口附近的行。
const explorerRowHeight = 27;
// 视口上下各多渲染少量缓冲行，避免快速滚动时出现空白闪烁。
const explorerOverscanRows = 10;
const explorerColumnLimits = [
  { min: 150, max: 680 },
  { min: 58, max: 140 },
  { min: 54, max: 130 },
  { min: 112, max: 220 },
  { min: 78, max: 180 },
  { min: 90, max: 220 },
];

// 连接列表默认列宽继续收窄，优先保证操作按钮完整露出，避免管理弹窗出现横向滚动条。
const connectionTableDefaultColumnWidths = [24, 136, 168, 54, 86];
const connectionTableColumnLimits = [
  { min: 24, max: 24 },
  { min: 96, max: 360 },
  { min: 120, max: 400 },
  { min: 48, max: 96 },
  { min: 72, max: 220 },
];
// AI 执行通知用稳定 tag 去重，避免 MCP 客户端重试时 Windows 通知中心堆出重复消息。
const agentBridgeNotificationTagPrefix = 'myterminal-agent-bridge';
// Windows toast 按钮的动作 ID 和 Rust 端保持一致，前端事件回来后直接分派审批结果。
const agentBridgeNotificationApproveActionId = 'approve-agent-request';
const agentBridgeNotificationRejectActionId = 'reject-agent-request';
// 通知正文只保留短摘要，防止长命令或长路径把 Windows toast 挤得难以阅读。
const agentRequestSummaryMaxLength = 160;
// 左右侧栏允许比旧版 320px 更窄，展开双侧栏时优先把横向空间留给终端和底部操作区。
const sidePanelMinWidth = 240;
const sidePanelMaxWidth = 560;
// 主工作区保底宽度用于反推侧栏最大可拖宽度，避免左右栏继续挤压中间按钮和终端。
const mainWorkspaceMinWidth = 720;
// 应用外壳左右 padding 和侧栏拖拽柄宽度参与宽度预算，保证 JS 钳制与 CSS 网格尺寸一致。
const appShellHorizontalPadding = 8;
const sidePanelResizeHandleWidth = 4;

const isTauriRuntime = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

const normalizeAgentRequestSummary = (value: string, maxLength = agentRequestSummaryMaxLength) => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
};

const getAgentRequestSummary = (request: AgentBridgeRequest) => {
  // 审批卡片和系统通知共用同一套摘要规则，保证收起态与通知里看到的是同一个执行目标。
  if (request.kind === 'run_command' && request.command?.trim()) {
    return normalizeAgentRequestSummary(request.command);
  }
  if (request.path) {
    const pathSummary = request.newPath ? `${request.path} -> ${request.newPath}` : request.path;
    return normalizeAgentRequestSummary(pathSummary);
  }
  if (request.contentPreview?.trim()) {
    return normalizeAgentRequestSummary(request.contentPreview);
  }
  return normalizeAgentRequestSummary(request.title || request.kind);
};

const getAgentRequestMachineLabel = (request: AgentBridgeRequest, connections: ConnectionProfile[]) => {
  const connection = connections.find((item) => item.id === request.connectionId);
  if (!connection) {
    return request.connectionId;
  }

  // SSH 机器信息只展示定位字段，避免把认证材料或备注等敏感配置带入通知和收起态。
  return `${connection.name} · ${connection.username}@${connection.host}:${connection.port}`;
};
const connectionTableActionMinWidth = 220;

const latinFontOptions = [
  'JetBrains Mono',
  'Maple Mono Normal NF CN Regular',
  'Maple Mono Normal NF CN Light',
  'Cascadia Mono',
  'Consolas',
  'Fira Code',
  'Roboto Mono',
  'Source Code Pro',
  'Monaco',
  'Courier New',
];

const cjkFontOptions = [
  'Microsoft YaHei UI',
  'Microsoft YaHei',
  'Maple Mono Normal NF CN Regular',
  'Maple Mono Normal NF CN Light',
  'SimSun',
  'SimHei',
  'Microsoft JhengHei UI',
  'Noto Sans CJK SC',
  'Sarasa Mono SC',
  'PingFang SC',
];

const ensureFontOption = (options: string[], current: string) => {
  const normalized = current.trim().replace(/^['"]|['"]$/g, '');
  return normalized && !options.includes(normalized) ? [normalized, ...options] : options;
};

const quoteCssFontFamily = (fontFamily: string) => {
  const cleaned = fontFamily.trim().replace(/^['"]|['"]$/g, '');
  if (!cleaned) {
    return undefined;
  }
  return /\s/.test(cleaned) ? `"${cleaned.replace(/"/g, '\\"')}"` : cleaned;
};

const buildPreviewFontFamily = (settings: AppSettings) =>
  [
    quoteCssFontFamily(settings.shellLatinFontFamily ?? settings.shellFontFamily),
    quoteCssFontFamily(settings.shellCjkFontFamily ?? settings.shellFontFamily),
    '"Cascadia Mono"',
    'Consolas',
    'monospace',
  ]
    .filter((fontFamily): fontFamily is string => Boolean(fontFamily))
    .filter((fontFamily, index, array) => array.indexOf(fontFamily) === index)
    .join(', ');

const defaultAgentMcpPackagePath = 'C:\\Software\\WorkSpace\\MyTerminal\\mcp\\myterminal-mcp';

// 本地终端首次打开时默认指向当前工作区，用户仍可在弹窗内切换任意目录。
const defaultLocalTerminalCwd = 'C:\\Software\\WorkSpace\\MyTerminal';

const nowIso = () => new Date().toISOString();

// 空命令代表直接打开本地 shell，是本地终端和 AI CLI 之间的兜底启动项。
const localTerminalShellCommand = { id: 'shell', name: '本地终端', command: '', builtIn: true };

// 本地终端标题要兼容空命令，避免纯 shell 会话显示成“ · 目录”。
const normalizeLocalTerminalProfileTitle = (cwd: string, command: string) => command ? `${command} · ${cwd}` : cwd;

// 顶部 tab 宽度有限，本地目录只取最后一级；历史和会话详情仍保留完整路径。
const getLocalTerminalDirectoryName = (cwd?: string, fallbackLabel = '本地终端') => {
  const normalized = cwd?.trim().replace(/[\\/]+$/, '');
  if (!normalized) {
    return fallbackLabel;
  }
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) || normalized;
};

// 本地终端 tab 用短标题展示，命令为空时只显示目录名，避免纯 shell 标签过长。
const formatLocalTerminalTabLabel = (session: TerminalSession, fallbackLabel = '本地终端') => {
  const directoryName = getLocalTerminalDirectoryName(session.cwd, fallbackLabel);
  const fullCwd = session.cwd?.trim();
  const command = fullCwd && session.title.endsWith(` · ${fullCwd}`)
    ? session.title.slice(0, -` · ${fullCwd}`.length).trim()
    : '';
  return command ? `${command} · ${directoryName}` : directoryName;
};

// 新建历史目录时同步生成标题和最近使用时间，后端会再次校验目录有效性。
const createLocalTerminalProfile = (cwd: string, command: string): LocalTerminalProfile => ({
  id: crypto.randomUUID(),
  title: normalizeLocalTerminalProfileTitle(cwd, command),
  cwd,
  command,
  lastUsedAt: nowIso(),
});

const buildAgentMcpPackagePath = (discoveryPath?: string) => {
  const normalized = discoveryPath?.trim().replace(/\\/g, '/');
  const marker = '/.myterminal-data/';
  const markerIndex = normalized?.lastIndexOf(marker) ?? -1;
  if (!normalized || markerIndex < 0) {
    return defaultAgentMcpPackagePath;
  }

  // discovery 文件位于项目数据目录下，反推项目根目录后拼出本地 npx launcher 包。
  const rootPath = normalized.slice(0, markerIndex);
  return `${rootPath}/mcp/myterminal-mcp`;
};

const buildAgentMcpConfig = (discoveryPath?: string) => {
  const npxArgs = ['--yes', buildAgentMcpPackagePath(discoveryPath)];
  return JSON.stringify(
    {
      mcpServers: {
        myterminal: {
          type: 'stdio',
          command: 'npx',
          args: npxArgs,
        },
      },
    },
    null,
    2,
  );
};

const terminalBackgroundFitOptions: Array<{
  value: NonNullable<AppSettings['terminalBackgroundImageFit']>;
  labelKey: TranslationKey;
}> = [
  { value: 'cover', labelKey: 'backgroundFitCover' },
  { value: 'contain', labelKey: 'backgroundFitContain' },
  { value: 'stretch', labelKey: 'backgroundFitStretch' },
  { value: 'tile', labelKey: 'backgroundFitTile' },
  { value: 'center', labelKey: 'backgroundFitCenter' },
];

const bottomTabs: Array<{ id: BottomPanelTab; labelKey: TranslationKey; icon: typeof TerminalSquare }> = [
  { id: 'commands', labelKey: 'panelCommands', icon: TerminalSquare },
  { id: 'tunnels', labelKey: 'panelTunnels', icon: Cable },
  { id: 'history', labelKey: 'panelHistory', icon: History },
];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// 动作按钮紧凑态使用显式分行，中文优先保留业务词组，英文按单词长度均衡切分，避免 CSS 自动断成 3/1 之类的畸形结果。
const splitActionButtonLabel = (label: string) => {
  const trimmed = label.trim();
  if (trimmed.length <= 1) {
    return [trimmed];
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > 1 && /^[\x00-\x7F]+$/.test(trimmed)) {
    if (words.length === 2) {
      return words;
    }

    let bestIndex = 1;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let index = 1; index < words.length; index += 1) {
      const left = words.slice(0, index).join(' ');
      const right = words.slice(index).join(' ');
      const delta = Math.abs(left.length - right.length);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIndex = index;
      }
    }
    return [words.slice(0, bestIndex).join(' '), words.slice(bestIndex).join(' ')];
  }

  const characters = Array.from(trimmed.replace(/\s+/g, ''));
  if (characters.length <= 1) {
    return [trimmed];
  }

  // “功能栏”是固定业务词组，紧凑态应保留为一行，避免出现“收起功 / 能栏”这种破坏语义的分割。
  const functionDockSuffix = '功能栏';
  if (trimmed.endsWith(functionDockSuffix) && characters.length > functionDockSuffix.length) {
    return [
      characters.slice(0, characters.length - functionDockSuffix.length).join(''),
      functionDockSuffix,
    ];
  }

  const firstLineLength = Math.ceil(characters.length / 2);
  return [characters.slice(0, firstLineLength).join(''), characters.slice(firstLineLength).join('')];
};

// 普通按钮保持自然横排；只有紧凑动作区才使用预切分行，图标和文字宽度互不挤压。
const renderActionButtonLabel = (label: string, compact = false) => {
  if (!compact) {
    return <span className="button-label">{label}</span>;
  }

  return (
    <span className="button-label is-compact" aria-label={label}>
      {splitActionButtonLabel(label).map((line, index) => (
        <span key={`${line}-${index}`} className="button-label-line">
          {line}
        </span>
      ))}
    </span>
  );
};

// 底部动作区只在自然横排放不下时进入紧凑模式；估算值偏保守，避免空间充足时仍然强制换行。
const estimateInlineButtonWidth = (label: string) => {
  const trimmed = label.trim();
  const asciiOnly = /^[\x00-\x7F]+$/.test(trimmed);
  const textWidth = asciiOnly ? trimmed.length * 8.5 : Array.from(trimmed).length * 15;
  return Math.max(64, Math.ceil(textWidth + 48));
};

// 紧凑态宽度按换行后最长一行计算，让“全部/开启”这类按钮真正变窄，而不是统一占用大宽度。
const estimateCompactButtonWidth = (label: string) => {
  const lines = splitActionButtonLabel(label);
  const asciiOnly = /^[\x00-\x7F]+$/.test(label.trim());
  const longestLineWidth = lines.reduce((maxWidth, line) => {
    const lineWidth = asciiOnly ? line.length * 8.5 : Array.from(line).length * 15;
    return Math.max(maxWidth, lineWidth);
  }, 0);
  return Math.max(62, Math.ceil(longestLineWidth + 44));
};

// 紧凑态按钮宽度写入 CSS 变量，避免统一 flex 宽度把已经换行的短文案又撑宽。
const buildActionButtonStyle = (label: string, compact: boolean): CSSProperties | undefined => {
  if (!compact) {
    return undefined;
  }
  return { '--compact-action-button-width': `${estimateCompactButtonWidth(label)}px` } as CSSProperties;
};

// 侧栏最大宽度由当前窗口、另一侧栏宽度和主工作区保底宽度共同决定，避免双侧栏展开时互相抢占中间区域。
const resolveSidePanelMaxWidth = (oppositePanelVisible: boolean, oppositePanelWidth: number) => {
  if (typeof window === 'undefined') {
    return sidePanelMaxWidth;
  }

  const occupiedByChrome =
    appShellHorizontalPadding +
    sidePanelResizeHandleWidth +
    (oppositePanelVisible ? sidePanelResizeHandleWidth + oppositePanelWidth : 0);
  const availableWidth = window.innerWidth - occupiedByChrome - mainWorkspaceMinWidth;
  return Math.max(sidePanelMinWidth, Math.min(sidePanelMaxWidth, Math.floor(availableWidth)));
};

const parentPath = (path: string) => {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized || normalized === '/' || normalized === '~') {
    return '~';
  }

  const parts = normalized.split('/').filter(Boolean);
  parts.pop();
  return normalized.startsWith('/') ? `/${parts.join('/')}` || '/' : parts.join('/') || '~';
};

const getConnectionValidationKey = (draft: ConnectionDraft) => {
  if (!draft.name.trim()) {
    return 'validationNameRequired' as const;
  }
  if (!draft.host.trim()) {
    return 'validationHostRequired' as const;
  }
  if (!draft.username.trim()) {
    return 'validationUsernameRequired' as const;
  }
  if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) {
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
    if (!Number.isInteger(jumpHost.port) || jumpHost.port < 1 || jumpHost.port > 65535) {
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
    if (!Number.isInteger(draft.proxy.port) || draft.proxy.port < 1 || draft.proxy.port > 65535) {
      return 'validationPortInvalid' as const;
    }
  }

  return undefined;
};

// 跳板机默认按 SSH 常用端口和密码认证初始化；每一级都能再切换到私钥认证。
const createEmptyJumpHost = (): SshJumpHost => ({
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

const beginResize = (
  event: ReactPointerEvent<HTMLElement>,
  onMove: (moveEvent: PointerEvent, startX: number, startY: number) => void,
) => {
  event.preventDefault();
  const startX = event.clientX;
  const startY = event.clientY;

  const handleMove = (moveEvent: PointerEvent) => onMove(moveEvent, startX, startY);
  const handleUp = () => {
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', handleUp);
  };

  window.addEventListener('pointermove', handleMove);
  window.addEventListener('pointerup', handleUp);
};

const isEditableFile = (path: string) => {
  const normalized = path.toLowerCase();
  return [
    '.txt',
    '.md',
    '.json',
    '.yaml',
    '.yml',
    '.toml',
    '.ini',
    '.conf',
    '.xml',
    '.env',
    '.sh',
    '.bash',
    '.zsh',
    '.ps1',
    '.py',
    '.rs',
    '.js',
    '.ts',
    '.tsx',
    '.jsx',
    '.java',
    '.go',
    '.sql',
    '.log',
    '.csv',
  ].some((extension) => normalized.endsWith(extension));
};

const formatBytes = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

const formatTimestamp = (value?: string) => {
  if (!value) {
    return '--';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

// 文件类型列优先表达用户真正关心的类别，普通文件再退回扩展名。
const formatFileType = (file: RemoteFileEntry, directoryLabel: string, symlinkLabel: string, fileLabel: string) => {
  if (file.isSymlink) {
    return symlinkLabel;
  }
  if (file.isDir) {
    return directoryLabel;
  }

  const extension = file.name.split('.').pop();
  return extension && extension !== file.name ? extension : fileLabel;
};

// 属主列沿用 FinalShell 常见的 owner/group 组合展示，缺失时保持占位。
const formatOwnerGroup = (file: RemoteFileEntry) => {
  if (file.owner && file.group) {
    return `${file.owner}/${file.group}`;
  }

  return file.owner ?? file.group ?? '--';
};

const parseMetricPercent = (value: string) => {
  const match = value.match(/\((\d+(?:\.\d+)?)%\)|(\d+(?:\.\d+)?)\s*%/);
  const rawPercent = match?.[1] ?? match?.[2];
  if (!rawPercent) {
    return undefined;
  }

  const percent = Number(rawPercent);
  return Number.isFinite(percent) ? clamp(percent, 0, 100) : undefined;
};

// 运行状态颜色只表达资源紧张程度，阈值保持简单直观，方便快速扫一眼定位高占用。
const metricTone = (percent?: number) => {
  if (percent === undefined) {
    return 'neutral';
  }
  if (percent >= 85) {
    return 'danger';
  }
  if (percent >= 65) {
    return 'warning';
  }
  return 'ok';
};

const fileLabelIcon = (file: RemoteFileEntry) => {
  if (file.isSymlink) {
    return FileSymlink;
  }
  if (file.isDir) {
    return FolderOpen;
  }
  return isEditableFile(file.path) ? FileCode2 : FileText;
};

// 会话状态只在标签栏用紧凑图标表达，避免把连接/断开信息写进终端正文影响 Shell 阅读。
const sessionStatusClassName = (status?: string) => `session-status-icon status-${status ?? 'idle'}`;

// 只有真实可用的 SSH 会话才驱动文件、运行状态和历史刷新，本地终端只占用终端标签页。
const isUsableRemoteSession = (session?: TerminalSession) =>
  session?.kind !== 'local' && (session?.status === 'connected' || session?.status === 'stub');

// 连接分组需要合并显式分组和连接自带 groupPath，保证空分组也能展示和继续维护。
const normalizeConnectionGroupPath = (value?: string) =>
  (value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/');

// 删除和筛选分组时要包含子分组，但不能把同名前缀误判为子级。
const isConnectionGroupOrChildPath = (value: string | undefined, groupPath: string) => {
  const normalized = normalizeConnectionGroupPath(value);
  return Boolean(groupPath) && (normalized === groupPath || normalized.startsWith(`${groupPath}/`));
};

// 管理页右侧列表只展示当前目录直属连接，父目录不混入子目录连接，方便用户按层级管理。
const isConnectionInExactGroupPath = (value: string | undefined, groupPath: string) =>
  normalizeConnectionGroupPath(value) === normalizeConnectionGroupPath(groupPath);

// 拖拽排序只移动现有项位置，不改写路径含义；目标项作为插入锚点，上下半区决定插入方向。
const moveItemToInsert = (items: string[], source: string, target: string, placement: InsertPlacement) => {
  if (source === target) {
    return items;
  }

  const nextItems = items.filter((item) => item !== source);
  const targetIndex = nextItems.indexOf(target);
  if (targetIndex < 0) {
    return nextItems;
  }

  nextItems.splice(targetIndex + (placement === 'after' ? 1 : 0), 0, source);
  return nextItems;
};

const moveItemToEnd = (items: string[], source: string) => [...items.filter((item) => item !== source), source];

// 分组支持父子路径，拖动父分组时要把子分组作为一个块一起移动，避免树结构被排序拆散。
const moveGroupBlockToInsert = (groupPaths: string[], source: string, target: string, placement: InsertPlacement) => {
  if (source === target || isConnectionGroupOrChildPath(target, source)) {
    return groupPaths;
  }

  const sourceBlock = groupPaths.filter((path) => path === source || path.startsWith(`${source}/`));
  const remaining = groupPaths.filter((path) => !sourceBlock.includes(path));
  const targetIndex = remaining.indexOf(target);
  if (targetIndex < 0) {
    return remaining;
  }

  const targetBlockEndIndex = remaining.reduce((lastIndex, path, index) => {
    return path === target || path.startsWith(`${target}/`) ? index : lastIndex;
  }, targetIndex);
  const insertIndex = placement === 'after' ? targetBlockEndIndex + 1 : targetIndex;
  remaining.splice(insertIndex, 0, ...sourceBlock);
  return remaining;
};

const moveGroupBlockToEnd = (groupPaths: string[], source: string) => {
  const sourceBlock = groupPaths.filter((path) => path === source || path.startsWith(`${source}/`));
  const remaining = groupPaths.filter((path) => !sourceBlock.includes(path));
  return [...remaining, ...sourceBlock];
};

const resolveInsertPlacement = (event: PointerEvent, element: HTMLElement): InsertPlacement => {
  const rect = element.getBoundingClientRect();
  return event.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
};

const resolveInlineInsertPlacement = (event: PointerEvent, element: HTMLElement): InsertPlacement => {
  const rect = element.getBoundingClientRect();
  return event.clientX > rect.left + rect.width / 2 ? 'after' : 'before';
};

const isPointInsideElement = (event: PointerEvent, element: HTMLElement | null) => {
  if (!element) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
};

// 列表拖拽落位后用 FLIP 动画补齐“从旧位置到新位置”的过渡，避免排序结果突然跳变。
const useFlipListAnimation = (containerRef: React.RefObject<HTMLElement | null>, selector: string, deps: DependencyList) => {
  const previousRectsRef = useRef<Map<string, DOMRect>>(new Map());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const elements = Array.from(container.querySelectorAll<HTMLElement>(selector));
    const nextRects = new Map<string, DOMRect>();
    elements.forEach((element) => {
      const key = element.dataset.connectionId
        ? `connection:${element.dataset.connectionId}`
        : element.dataset.groupPath
          ? `group:${element.dataset.groupPath}`
          : element.dataset.sessionId
            ? `session:${element.dataset.sessionId}`
            : '';
      if (!key) {
        return;
      }

      const currentRect = element.getBoundingClientRect();
      const previousRect = previousRectsRef.current.get(key);
      nextRects.set(key, currentRect);
      if (!previousRect) {
        return;
      }

      const deltaX = previousRect.left - currentRect.left;
      const deltaY = previousRect.top - currentRect.top;
      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) {
        return;
      }

      element.animate(
        [
          { transform: `translate(${deltaX}px, ${deltaY}px)` },
          { transform: 'translate(0, 0)' },
        ],
        {
          duration: 180,
          easing: 'cubic-bezier(0.2, 0, 0, 1)',
        },
      );
    });

    previousRectsRef.current = nextRects;
  }, deps);
};

// 连接排序优先使用设置中的人工顺序，旧配置或新增连接没有记录时保留当前数组顺序兜底。
const sortConnectionsByOrder = (connections: ConnectionProfile[], connectionOrder: string[]) => {
  const orderMap = new Map(connectionOrder.map((connectionId, index) => [connectionId, index]));
  return [...connections].sort((left, right) => {
    const leftOrder = orderMap.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = orderMap.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return connections.indexOf(left) - connections.indexOf(right);
  });
};

const expandGroupPathWithParents = (groupPath: string) => {
  const segments = normalizeConnectionGroupPath(groupPath).split('/').filter(Boolean);
  return segments.map((_segment, index) => segments.slice(0, index + 1).join('/'));
};

// 显式分组和连接自带分组一起参与拖拽排序，父级路径也要补齐，避免旧配置里未持久化的分组在管理页消失。
const collectOrderedGroupPaths = (groupPaths: string[], connections: ConnectionProfile[]) =>
  Array.from(
    new Set([
      ...groupPaths.flatMap(expandGroupPathWithParents),
      ...connections.flatMap((connection) => expandGroupPathWithParents(connection.groupPath ?? '')),
    ].filter(Boolean)),
  );

const buildConnectionGroupTree = (groupPaths: string[], connections: ConnectionProfile[]): ConnectionGroupNode[] => {
  type MutableNode = {
    name: string;
    path: string;
    children: Map<string, MutableNode>;
    connections: ConnectionProfile[];
  };

  let nextGroupOrder = 0;
  const groupOrder = new Map<string, number>();
  const root: MutableNode = {
    name: '',
    path: '',
    children: new Map(),
    connections: [],
  };

  const ensureNode = (path: string) => {
    const segments = path.split('/').map((item) => item.trim()).filter(Boolean);
    let current = root;
    let currentPath = '';

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      if (!groupOrder.has(currentPath)) {
        groupOrder.set(currentPath, nextGroupOrder);
        nextGroupOrder += 1;
      }
      if (!current.children.has(segment)) {
        current.children.set(segment, {
          name: segment,
          path: currentPath,
          children: new Map(),
          connections: [],
        });
      }
      current = current.children.get(segment)!;
    }

    return current;
  };

  const orderedGroupPaths = Array.from(
    new Set([
      ...groupPaths.map((groupPath) => normalizeConnectionGroupPath(groupPath)),
      ...connections.map((connection) => normalizeConnectionGroupPath(connection.groupPath)),
    ].filter(Boolean)),
  );

  orderedGroupPaths.forEach((groupPath) => ensureNode(groupPath));

  for (const connection of connections) {
    const groupPath = normalizeConnectionGroupPath(connection.groupPath);
    if (groupPath) {
      ensureNode(groupPath).connections.push(connection);
    }
  }

  const finalize = (node: MutableNode): ConnectionGroupNode[] => {
    return [...node.children.values()]
      .sort((left, right) => (groupOrder.get(left.path) ?? 0) - (groupOrder.get(right.path) ?? 0))
      .map((child) => ({
        name: child.name,
        path: child.path,
        connections: child.connections,
        children: finalize(child),
      }));
  };

  return finalize(root);
};

function ConnectionGroupTree({
  nodes,
  selectedPath,
  onSelect,
  onEdit,
  onDelete,
  dragState,
  dropTarget,
  onStartGroupDrag,
  editLabel,
  deleteLabel,
}: {
  nodes: ConnectionGroupNode[];
  selectedPath: string;
  onSelect: (path: string) => void;
  onEdit: (path: string) => void;
  onDelete: (path: string) => void;
  dragState: ConnectionManagerDragState;
  dropTarget: ConnectionManagerDropTarget;
  onStartGroupDrag: (event: ReactPointerEvent<HTMLButtonElement>, path: string, label: string) => void;
  editLabel: string;
  deleteLabel: string;
}) {
  return (
    <div className="connection-group-children">
      {nodes.map((node) => (
        <div key={node.path} className="connection-group-node">
          <div
            data-group-path={node.path}
            className={`connection-group-row ${selectedPath === node.path ? 'is-selected' : ''} ${dragState?.type === 'group' && dragState.path === node.path ? 'is-dragging' : ''} ${dropTarget?.type === 'connection-group' && dropTarget.groupPath === node.path ? 'is-drop-target' : ''} ${dropTarget?.type === 'group-insert' && dropTarget.groupPath === node.path ? `is-drop-${dropTarget.placement}` : ''}`}
          >
            <button
              aria-label={`拖动分组 ${node.path}`}
              className="drag-handle"
              onPointerDown={(event) => onStartGroupDrag(event, node.path, node.name)}
              title={`拖动分组 ${node.path}`}
              type="button"
            >
              <GripVertical size={14} />
            </button>
            <button
              className="connection-group-button"
              onClick={() => onSelect(node.path)}
              title={node.path}
              type="button"
            >
              <Folder size={14} />
              <span>{node.name}</span>
            </button>
            <div className="connection-group-actions">
              <button
                aria-label={`${editLabel}: ${node.path}`}
                className="icon-button tiny"
                onClick={() => onEdit(node.path)}
                title={editLabel}
                type="button"
              >
                <Pencil size={13} />
              </button>
              <button
                aria-label={`${deleteLabel}: ${node.path}`}
                className="icon-button tiny danger-button"
                onClick={() => onDelete(node.path)}
                title={deleteLabel}
                type="button"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
          {node.children.length ? (
            <ConnectionGroupTree
              nodes={node.children}
              selectedPath={selectedPath}
              onDelete={onDelete}
              onEdit={onEdit}
              onSelect={onSelect}
              dragState={dragState}
              dropTarget={dropTarget}
              onStartGroupDrag={onStartGroupDrag}
              deleteLabel={deleteLabel}
              editLabel={editLabel}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function AgentAutoConnectionTree({
  nodes,
  ungroupedConnections,
  allowedConnectionIds,
  onToggleConnection,
  ungroupedLabel,
}: {
  nodes: ConnectionGroupNode[];
  ungroupedConnections: ConnectionProfile[];
  allowedConnectionIds: string[];
  onToggleConnection: (connectionId: string, checked: boolean) => void;
  ungroupedLabel: string;
}) {
  const renderConnection = (connection: ConnectionProfile) => (
    <label key={connection.id} className="agent-tree-connection">
      <input
        checked={allowedConnectionIds.includes(connection.id)}
        type="checkbox"
        onChange={(event) => onToggleConnection(connection.id, event.target.checked)}
      />
      <span>{connection.name}</span>
      <strong>{connection.username}@{connection.host}:{connection.port}</strong>
    </label>
  );

  const renderGroup = (node: ConnectionGroupNode) => (
    <div key={node.path} className="agent-tree-group">
      <div className="agent-tree-group-title">
        <Folder size={14} />
        <span>{node.name}</span>
      </div>
      <div className="agent-tree-group-body">
        {node.connections.map(renderConnection)}
        {node.children.map(renderGroup)}
      </div>
    </div>
  );

  return (
    <div className="agent-connection-tree">
      {nodes.map(renderGroup)}
      {ungroupedConnections.length ? (
        <div className="agent-tree-group">
          <div className="agent-tree-group-title">
            <FolderOpen size={14} />
            <span>{ungroupedLabel}</span>
          </div>
          <div className="agent-tree-group-body">{ungroupedConnections.map(renderConnection)}</div>
        </div>
      ) : null}
    </div>
  );
}

function ConnectionFormModal() {
  const [revealPassword, setRevealPassword] = useState(false);
  const [revealPassphrase, setRevealPassphrase] = useState(false);
  const [groupPickerOpen, setGroupPickerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<ConnectionFormTab>('basic');
  const {
    showConnectionForm,
    connectionDraft,
    connectionTestResult,
    closeConnectionForm,
    updateConnectionDraft,
    saveConnectionDraft,
    testConnectionDraft,
    connections,
    loading,
    settings,
  } = useAppStore();

  const t = (key: TranslationKey, replacements?: Record<string, string | number>) =>
    translate(settings.uiLanguage, key, replacements);
  const isPrivateKeyMode = connectionDraft.authMethod === 'privateKey';
  const passwordToggleLabel = revealPassword ? t('hideSecret') : t('showSecret');
  const passphraseToggleLabel = revealPassphrase ? t('hideSecret') : t('showSecret');
  const validationKey = getConnectionValidationKey(connectionDraft);
  const canSubmit = !validationKey && !loading;
  const connectionTabs: Array<{ id: ConnectionFormTab; label: string }> = [
    { id: 'basic', label: t('connectionTabBasic') },
    { id: 'jumpHosts', label: t('connectionTabJumpHosts') },
    { id: 'proxy', label: t('connectionTabProxy') },
  ];
  const updateJumpHost = (id: string, patch: Partial<SshJumpHost>) => {
    // 跳板机按数组顺序执行，更新时仅替换命中的一级，避免重排破坏用户配置的跳转链。
    updateConnectionDraft('jumpHosts', connectionDraft.jumpHosts.map((jumpHost) => (
      jumpHost.id === id ? { ...jumpHost, ...patch } : jumpHost
    )));
  };
  const moveJumpHost = (id: string, direction: -1 | 1) => {
    const currentIndex = connectionDraft.jumpHosts.findIndex((jumpHost) => jumpHost.id === id);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= connectionDraft.jumpHosts.length) {
      return;
    }
    const nextJumpHosts = [...connectionDraft.jumpHosts];
    const [item] = nextJumpHosts.splice(currentIndex, 1);
    nextJumpHosts.splice(nextIndex, 0, item);
    updateConnectionDraft('jumpHosts', nextJumpHosts);
  };
  const addJumpHost = () => {
    updateConnectionDraft('jumpHosts', [...connectionDraft.jumpHosts, createEmptyJumpHost()]);
  };
  const deleteJumpHost = (id: string) => {
    updateConnectionDraft('jumpHosts', connectionDraft.jumpHosts.filter((jumpHost) => jumpHost.id !== id));
  };
  const updateProxy = (patch: Partial<ConnectionDraft['proxy']>) => {
    // 代理开关和认证信息都保留在同一个对象里，关闭代理时不清空已填地址，便于临时切换。
    updateConnectionDraft('proxy', { ...connectionDraft.proxy, ...patch });
  };
  // 分组输入使用自定义下拉，避免浏览器 datalist 在输入前缀时把可选父分组直接过滤掉。
  const groupOptions = useMemo(() => collectOrderedGroupPaths(settings.connectionGroups, connections), [connections, settings.connectionGroups]);
  const sortedGroupOptions = useMemo(() => {
    const keyword = normalizeConnectionGroupPath(connectionDraft.groupPath).toLowerCase();
    if (!keyword) {
      return groupOptions;
    }

    // 输入内容只影响排序，不隐藏任何已有分组；用户输入 ology- 时仍能看到 ology 这类父级候选。
    return [...groupOptions].sort((left, right) => {
      const leftLower = left.toLowerCase();
      const rightLower = right.toLowerCase();
      const leftMatched = leftLower.includes(keyword) || keyword.includes(leftLower);
      const rightMatched = rightLower.includes(keyword) || keyword.includes(rightLower);
      if (leftMatched !== rightMatched) {
        return leftMatched ? -1 : 1;
      }
      return groupOptions.indexOf(left) - groupOptions.indexOf(right);
    });
  }, [connectionDraft.groupPath, groupOptions]);
  useEffect(() => {
    if (!showConnectionForm) {
      return;
    }

    // 每次打开新增/编辑弹窗都回到基础页，避免上一次停留在跳板机或代理页造成误以为基础信息丢失。
    setActiveTab('basic');
    setGroupPickerOpen(false);
    setRevealPassword(false);
    setRevealPassphrase(false);
  }, [showConnectionForm]);

  if (!showConnectionForm) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <div className="modal card connection-form-modal">
        <div className="modal-header">
          <div>
            <h3>{connectionDraft.id ? t('connectionModalEditTitle') : t('connectionModalNewTitle')}</h3>
          </div>
          <button className="icon-button" onClick={closeConnectionForm} type="button">
            <X size={18} />
          </button>
        </div>

        <div className="tab-list connection-form-tabs">
          {connectionTabs.map((tab) => (
            <button
              key={tab.id}
              className={`panel-tab ${activeTab === tab.id ? 'is-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              type="button"
            >
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        <div className="connection-form-panels">
          <div className={`connection-form-panel ${activeTab === 'basic' ? 'is-active' : ''}`}>
            <div className="form-grid">
              <label>
                <span>{t('fieldName')}</span>
                <input value={connectionDraft.name} onChange={(event) => updateConnectionDraft('name', event.target.value)} />
              </label>
              <label>
                <span>{t('fieldGroupPath')}</span>
                <div className="group-combobox">
                  <input
                    aria-expanded={groupPickerOpen}
                    placeholder={t('groupPathPlaceholder')}
                    value={connectionDraft.groupPath}
                    onBlur={() => window.setTimeout(() => setGroupPickerOpen(false), 120)}
                    onChange={(event) => {
                      updateConnectionDraft('groupPath', event.target.value);
                      setGroupPickerOpen(true);
                    }}
                    onFocus={() => setGroupPickerOpen(true)}
                  />
                  {groupPickerOpen && sortedGroupOptions.length ? (
                    <div className="group-options-menu">
                      {sortedGroupOptions.map((groupPath) => (
                        <button
                          key={groupPath}
                          className="group-option-button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            updateConnectionDraft('groupPath', groupPath);
                            setGroupPickerOpen(false);
                          }}
                          type="button"
                        >
                          <Folder size={14} />
                          <span>{groupPath}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </label>
              <label>
                <span>{t('fieldHost')}</span>
                <input value={connectionDraft.host} onChange={(event) => updateConnectionDraft('host', event.target.value)} />
              </label>
              <label>
                <span>{t('fieldPort')}</span>
                <input type="number" value={connectionDraft.port} onChange={(event) => updateConnectionDraft('port', Number(event.target.value) || 22)} />
              </label>
              <label>
                <span>{t('fieldUsername')}</span>
                <input value={connectionDraft.username} onChange={(event) => updateConnectionDraft('username', event.target.value)} />
              </label>
              <label>
                <span>{t('fieldAuthMethod')}</span>
                <select
                  value={connectionDraft.authMethod}
                  onChange={(event) => updateConnectionDraft('authMethod', event.target.value === 'privateKey' ? 'privateKey' : 'password')}
                >
                  <option value="password">{t('authMethodPassword')}</option>
                  <option value="privateKey">{t('authMethodPrivateKey')}</option>
                </select>
              </label>
              {isPrivateKeyMode ? (
                <>
                  <label className="span-2">
                    <span>{t('fieldPrivateKeyPath')}</span>
                    <input
                      placeholder={t('privateKeyPathPlaceholder')}
                      value={connectionDraft.privateKeyPath}
                      onChange={(event) => updateConnectionDraft('privateKeyPath', event.target.value)}
                    />
                  </label>
                  <label className="span-2">
                    <span>{t('fieldPrivateKeyText')}</span>
                    <textarea
                      placeholder={t('privateKeyTextPlaceholder')}
                      rows={6}
                      value={connectionDraft.privateKeyText}
                      onChange={(event) => updateConnectionDraft('privateKeyText', event.target.value)}
                    />
                  </label>
                  <label className="span-2">
                    <span>{t('fieldPassphrase')}</span>
                    <div className="password-field">
                      <input
                        type={revealPassphrase ? 'text' : 'password'}
                        value={connectionDraft.passphrase}
                        onChange={(event) => updateConnectionDraft('passphrase', event.target.value)}
                      />
                      <button
                        aria-label={passphraseToggleLabel}
                        className="secondary-button slim password-toggle-button"
                        onClick={() => setRevealPassphrase((value) => !value)}
                        title={passphraseToggleLabel}
                        type="button"
                      >
                        {revealPassphrase ? <EyeOff size={16} /> : <Eye size={16} />}
                        <span>{passphraseToggleLabel}</span>
                      </button>
                    </div>
                  </label>
                  <p className="field-hint span-2">{t('privateKeyHint')}</p>
                </>
              ) : (
                <label className="span-2">
                  <span>{t('fieldPassword')}</span>
                  <div className="password-field">
                    <input
                      type={revealPassword ? 'text' : 'password'}
                      value={connectionDraft.password}
                      onChange={(event) => updateConnectionDraft('password', event.target.value)}
                    />
                    <button
                      aria-label={passwordToggleLabel}
                      className="secondary-button slim password-toggle-button"
                      onClick={() => setRevealPassword((value) => !value)}
                      title={passwordToggleLabel}
                      type="button"
                    >
                      {revealPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      <span>{passwordToggleLabel}</span>
                    </button>
                  </div>
                </label>
              )}
              <label className="span-2">
                <span>{t('fieldTags')}</span>
                <input
                  value={Array.isArray(connectionDraft.tags) ? connectionDraft.tags.join(', ') : connectionDraft.tags}
                  onChange={(event) => updateConnectionDraft('tags', event.target.value)}
                  placeholder={t('tagsPlaceholder')}
                />
              </label>
              <label className="span-2">
                <span>{t('fieldNote')}</span>
                <textarea value={connectionDraft.note ?? ''} onChange={(event) => updateConnectionDraft('note', event.target.value)} rows={4} />
              </label>
            </div>
          </div>

          <div className={`connection-form-panel ${activeTab === 'jumpHosts' ? 'is-active' : ''}`}>
            <div className="connection-jump-hosts-toolbar">
              <div>
                <h4>{t('connectionTabJumpHosts')}</h4>
                <p>{t('connectionTabJumpHostsDesc')}</p>
              </div>
              <button className="secondary-button slim" onClick={addJumpHost} type="button">
                <Plus size={14} /> {t('addJumpHost')}
              </button>
            </div>
            {connectionDraft.jumpHosts.length ? (
              <div className="connection-jump-host-list">
                {connectionDraft.jumpHosts.map((jumpHost, index) => {
                  const isPrivateKeyModeForJump = jumpHost.authMethod === 'privateKey';
                  return (
                    <section key={jumpHost.id} className="connection-jump-host-card">
                      <div className="connection-jump-host-card-header">
                        <strong>{t('jumpHostTitle', { index: index + 1 })}</strong>
                        <div className="connection-jump-host-card-actions">
                          <button className="ghost-button slim" disabled={index === 0} onClick={() => moveJumpHost(jumpHost.id, -1)} type="button">
                            <ChevronUp size={14} />
                          </button>
                          <button className="ghost-button slim" disabled={index === connectionDraft.jumpHosts.length - 1} onClick={() => moveJumpHost(jumpHost.id, 1)} type="button">
                            <ChevronDown size={14} />
                          </button>
                          <button className="ghost-button slim danger-button" onClick={() => deleteJumpHost(jumpHost.id)} type="button">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                      <div className="form-grid connection-jump-host-grid">
                        <label>
                          <span>{t('fieldName')}</span>
                          <input value={jumpHost.name ?? ''} onChange={(event) => updateJumpHost(jumpHost.id, { name: event.target.value })} />
                        </label>
                        <label>
                          <span>{t('fieldHost')}</span>
                          <input value={jumpHost.host} onChange={(event) => updateJumpHost(jumpHost.id, { host: event.target.value })} />
                        </label>
                        <label>
                          <span>{t('fieldPort')}</span>
                          <input
                            type="number"
                            value={jumpHost.port}
                            onChange={(event) => updateJumpHost(jumpHost.id, { port: Number(event.target.value) || 22 })}
                          />
                        </label>
                        <label>
                          <span>{t('fieldUsername')}</span>
                          <input value={jumpHost.username} onChange={(event) => updateJumpHost(jumpHost.id, { username: event.target.value })} />
                        </label>
                        <label>
                          <span>{t('fieldAuthMethod')}</span>
                          <select
                            value={jumpHost.authMethod}
                            onChange={(event) => updateJumpHost(jumpHost.id, {
                              authMethod: event.target.value === 'privateKey' ? 'privateKey' : 'password',
                            })}
                          >
                            <option value="password">{t('authMethodPassword')}</option>
                            <option value="privateKey">{t('authMethodPrivateKey')}</option>
                          </select>
                        </label>
                        {isPrivateKeyModeForJump ? (
                          <>
                            <label className="span-2">
                              <span>{t('fieldPrivateKeyPath')}</span>
                              <input
                                placeholder={t('privateKeyPathPlaceholder')}
                                value={jumpHost.privateKeyPath ?? ''}
                                onChange={(event) => updateJumpHost(jumpHost.id, { privateKeyPath: event.target.value })}
                              />
                            </label>
                            <label className="span-2">
                              <span>{t('fieldPrivateKeyText')}</span>
                              <textarea
                                placeholder={t('privateKeyTextPlaceholder')}
                                rows={4}
                                value={jumpHost.privateKeyText ?? ''}
                                onChange={(event) => updateJumpHost(jumpHost.id, { privateKeyText: event.target.value })}
                              />
                            </label>
                            <label className="span-2">
                              <span>{t('fieldPassphrase')}</span>
                              <input
                                type="password"
                                value={jumpHost.passphrase ?? ''}
                                onChange={(event) => updateJumpHost(jumpHost.id, { passphrase: event.target.value })}
                              />
                            </label>
                          </>
                        ) : (
                          <label className="span-2">
                            <span>{t('fieldPassword')}</span>
                            <input
                              type="password"
                              value={jumpHost.password ?? ''}
                              onChange={(event) => updateJumpHost(jumpHost.id, { password: event.target.value })}
                            />
                          </label>
                        )}
                      </div>
                    </section>
                  );
                })}
              </div>
            ) : (
              <div className="empty-state">{t('connectionTabJumpHostsEmpty')}</div>
            )}
          </div>

          <div className={`connection-form-panel ${activeTab === 'proxy' ? 'is-active' : ''}`}>
            <div className="connection-proxy-toolbar">
              <div>
                <h4>{t('connectionTabProxy')}</h4>
                <p>{t('connectionTabProxyDesc')}</p>
              </div>
              <label className="toggle-row connection-proxy-toggle">
                <span>{t('enabled')}</span>
                <input
                  checked={connectionDraft.proxy.enabled}
                  type="checkbox"
                  onChange={(event) => updateProxy({ enabled: event.target.checked })}
                />
              </label>
            </div>
            <div className="form-grid">
              <label>
                <span>{t('fieldProxyType')}</span>
                <select
                  disabled={!connectionDraft.proxy.enabled}
                  value={connectionDraft.proxy.type}
                  onChange={(event) => updateProxy({ type: event.target.value === 'http' ? 'http' : 'socks5' })}
                >
                  <option value="socks5">{t('proxyTypeSocks5')}</option>
                  <option value="http">{t('proxyTypeHttp')}</option>
                </select>
              </label>
              <label>
                <span>{t('fieldHost')}</span>
                <input
                  disabled={!connectionDraft.proxy.enabled}
                  value={connectionDraft.proxy.host}
                  onChange={(event) => updateProxy({ host: event.target.value })}
                />
              </label>
              <label>
                <span>{t('fieldPort')}</span>
                <input
                  disabled={!connectionDraft.proxy.enabled}
                  type="number"
                  value={connectionDraft.proxy.port}
                  onChange={(event) => updateProxy({ port: Number(event.target.value) || 1080 })}
                />
              </label>
              <label>
                <span>{t('fieldUsername')}</span>
                <input
                  disabled={!connectionDraft.proxy.enabled}
                  value={connectionDraft.proxy.username ?? ''}
                  onChange={(event) => updateProxy({ username: event.target.value })}
                />
              </label>
              <label className="span-2">
                <span>{t('fieldPassword')}</span>
                <input
                  disabled={!connectionDraft.proxy.enabled}
                  type="password"
                  value={connectionDraft.proxy.password ?? ''}
                  onChange={(event) => updateProxy({ password: event.target.value })}
                />
              </label>
            </div>
          </div>
        </div>

        <div className="connection-form-feedback">
          {/* 校验和测试结果固定在同一个反馈行里，避免提示数量变化时打乱弹窗网格高度。 */}
          {validationKey ? <p className="field-hint validation-hint">{t(validationKey)}</p> : null}
          {connectionTestResult ? (
            <p className={`field-hint connection-test-result ${connectionTestResult.kind === 'error' ? 'is-error' : 'is-success'}`}>
              {connectionTestResult.message}
            </p>
          ) : null}
        </div>

        <div className="modal-actions">
          <button className="secondary-button" onClick={closeConnectionForm} type="button">
            {t('cancel')}
          </button>
          <button className="secondary-button" disabled={loading} onClick={() => void testConnectionDraft()} type="button">
            {t('testConnection')}
          </button>
          <button className="primary-button" disabled={!canSubmit} onClick={() => void saveConnectionDraft()} type="button">
            {t('saveConnection')}
          </button>
        </div>
      </div>
    </div>
  );
}

function TunnelFormModal() {
  const {
    closeTunnelForm,
    saveTunnelDraft,
    settings,
    showTunnelForm,
    tunnelDraft,
    updateTunnelDraft,
  } = useAppStore();

  const t = (key: TranslationKey, replacements?: Record<string, string | number>) =>
    translate(settings.uiLanguage, key, replacements);

  if (!showTunnelForm) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <div className="modal card">
        <div className="modal-header">
          <div>
            {/* 隧道新增和编辑共用表单，草稿 id 决定当前标题和保存分支。 */}
            <h3>{t(tunnelDraft.id ? 'tunnelModalEditTitle' : 'tunnelModalTitle')}</h3>
          </div>
          <button className="icon-button" onClick={closeTunnelForm} type="button">
            <X size={18} />
          </button>
        </div>

        <div className="form-grid">
          <label className="span-2">
            <span>{t('fieldName')}</span>
            <input value={tunnelDraft.name} onChange={(event) => updateTunnelDraft('name', event.target.value)} />
          </label>
          <label>
            <span>{t('fieldBindAddress')}</span>
            <input value={tunnelDraft.bindAddress} onChange={(event) => updateTunnelDraft('bindAddress', event.target.value)} />
          </label>
          <label>
            <span>{t('fieldLocalPort')}</span>
            <input
              type="number"
              value={tunnelDraft.localPort}
              onChange={(event) => updateTunnelDraft('localPort', Number(event.target.value) || 15432)}
            />
          </label>
          <label>
            <span>{t('fieldRemoteHost')}</span>
            <input value={tunnelDraft.remoteHost} onChange={(event) => updateTunnelDraft('remoteHost', event.target.value)} />
          </label>
          <label>
            <span>{t('fieldRemotePort')}</span>
            <input
              type="number"
              value={tunnelDraft.remotePort}
              onChange={(event) => updateTunnelDraft('remotePort', Number(event.target.value) || 5432)}
            />
          </label>
        </div>

        <div className="modal-actions">
          <button className="secondary-button" onClick={closeTunnelForm} type="button">
            {t('cancel')}
          </button>
          <button className="primary-button" onClick={() => void saveTunnelDraft()} type="button">
            {t('saveTunnel')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectionManagerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [selectedGroupPath, setSelectedGroupPath] = useState(ungroupedGroupPath);
  const [groupEditorMode, setGroupEditorMode] = useState<'create' | 'edit' | null>(null);
  const [editingGroupPath, setEditingGroupPath] = useState('');
  const [groupDraft, setGroupDraft] = useState('');
  // 连接管理拖拽状态只保存在弹窗内，用于区分连接移动、连接排序和分组排序三种放置目标。
  const [dragState, setDragState] = useState<ConnectionManagerDragState>(null);
  const [dropTarget, setDropTarget] = useState<ConnectionManagerDropTarget>(null);
  const [connectionTableColumnWidths, setConnectionTableColumnWidths] = useState(connectionTableDefaultColumnWidths);
  const dragStateRef = useRef<ConnectionManagerDragState>(null);
  const dropTargetRef = useRef<ConnectionManagerDropTarget>(null);
  const managerWasOpenRef = useRef(false);
  const groupSidebarRef = useRef<HTMLElement | null>(null);
  const connectionTableBodyRef = useRef<HTMLDivElement | null>(null);
  const {
    connections,
    createConnectionGroup,
    deleteConnection,
    deleteConnectionGroup,
    duplicateConnection,
    moveConnectionToGroup,
    openConnectionForm,
    openSession,
    renameConnectionGroup,
    reorderConnectionGroups,
    reorderConnections,
    settings,
  } = useAppStore();
  const t = (key: TranslationKey, replacements?: Record<string, string | number>) =>
    translate(settings.uiLanguage, key, replacements);
  const orderedConnections = useMemo(() => sortConnectionsByOrder(connections, settings.connectionOrder), [connections, settings.connectionOrder]);
  const orderedGroupPaths = useMemo(() => collectOrderedGroupPaths(settings.connectionGroups, connections), [connections, settings.connectionGroups]);
  const groups = useMemo(() => buildConnectionGroupTree(settings.connectionGroups, orderedConnections), [orderedConnections, settings.connectionGroups]);
  const firstSelectableGroupPath = orderedGroupPaths[0] ?? ungroupedGroupPath;
  const visibleConnections = useMemo(() => {
    if (selectedGroupPath === ungroupedGroupPath) {
      return orderedConnections.filter((connection) => !normalizeConnectionGroupPath(connection.groupPath));
    }

    return orderedConnections.filter((connection) => isConnectionInExactGroupPath(connection.groupPath, selectedGroupPath));
  }, [orderedConnections, selectedGroupPath]);
  const connectionTableGridTemplate = useMemo(
    () => `${connectionTableColumnWidths.map((width) => `${width}px`).join(' ')} minmax(${connectionTableActionMinWidth}px, 1fr)`,
    [connectionTableColumnWidths],
  );
  const connectionTableGridMinWidth = useMemo(
    () => connectionTableColumnWidths.reduce((total, width) => total + width, 0) + connectionTableActionMinWidth + 48,
    [connectionTableColumnWidths],
  );
  const connectionTableGridStyle = useMemo<CSSProperties>(
    () => ({ gridTemplateColumns: connectionTableGridTemplate, minWidth: connectionTableGridMinWidth }),
    [connectionTableGridMinWidth, connectionTableGridTemplate],
  );
  const beginConnectionTableColumnResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>, columnIndex: number) => {
    const startWidth = connectionTableColumnWidths[columnIndex] ?? connectionTableDefaultColumnWidths[columnIndex] ?? 120;
    const limits = connectionTableColumnLimits[columnIndex] ?? { min: 80, max: 360 };

    // 连接列表列宽只服务当前管理弹窗的阅读和对比，不写入配置，避免临时操作污染持久设置。
    beginResize(event, (moveEvent, startX) => {
      const nextWidth = clamp(startWidth + moveEvent.clientX - startX, limits.min, limits.max);
      setConnectionTableColumnWidths((current) => current.map((width, index) => (index === columnIndex ? nextWidth : width)));
    });
  }, [connectionTableColumnWidths]);
  useFlipListAnimation(groupSidebarRef, '[data-group-path]', [orderedGroupPaths.join('|')]);
  useFlipListAnimation(connectionTableBodyRef, '[data-connection-id]', [visibleConnections.map((connection) => connection.id).join('|')]);
  const canSaveGroup = Boolean(normalizeConnectionGroupPath(groupDraft));
  const startCreateGroup = () => {
    setGroupEditorMode('create');
    setEditingGroupPath('');
    setGroupDraft(selectedGroupPath && selectedGroupPath !== ungroupedGroupPath ? `${selectedGroupPath}/` : '');
  };
  const startEditGroup = (path: string) => {
    setGroupEditorMode('edit');
    setEditingGroupPath(path);
    setGroupDraft(path);
  };
  const cancelGroupEditor = () => {
    setGroupEditorMode(null);
    setEditingGroupPath('');
    setGroupDraft('');
  };
  const saveGroup = async () => {
    // 分组保存前先规范路径，避免用户输入反斜杠或多余斜杠导致重复分组。
    const normalized = normalizeConnectionGroupPath(groupDraft);
    const savedPath = groupEditorMode === 'edit'
      ? await renameConnectionGroup(editingGroupPath, normalized)
      : await createConnectionGroup(normalized);
    if (!savedPath) {
      return;
    }

    setSelectedGroupPath(savedPath);
    cancelGroupEditor();
  };
  const requestDeleteGroup = (path: string) => {
    // 删除确认需要明确告诉用户连接数量，因为确认后会级联删除连接而不是移动到未分组。
    const connectionCount = connections.filter((connection) => isConnectionGroupOrChildPath(connection.groupPath, path)).length;
    if (!window.confirm(t('deleteGroupConfirm', { path, count: connectionCount }))) {
      return;
    }

    void deleteConnectionGroup(path).then(() => {
      if (selectedGroupPath === path || selectedGroupPath.startsWith(`${path}/`)) {
        setSelectedGroupPath(ungroupedGroupPath);
      }
      if (editingGroupPath === path || editingGroupPath.startsWith(`${path}/`)) {
        cancelGroupEditor();
      }
    });
  };
  const handleDropConnectionToGroup = (connectionId: string, groupPath: string) => {
    setDragState(null);
    setDropTarget(null);
    void moveConnectionToGroup(connectionId, groupPath === ungroupedGroupPath ? undefined : groupPath);
  };
  const handleDuplicateConnection = (connectionId: string) => {
    // 复制连接遵循当前左侧选中的目录；固定的未分组入口等价于清空 groupPath。
    const targetGroupPath = selectedGroupPath === ungroupedGroupPath ? undefined : selectedGroupPath;
    void duplicateConnection(connectionId, targetGroupPath);
  };
  const handleReorderGroup = (sourcePath: string, targetPath: string, placement: InsertPlacement) => {
    setDragState(null);
    setDropTarget(null);
    void reorderConnectionGroups(moveGroupBlockToInsert(orderedGroupPaths, sourcePath, targetPath, placement));
  };
  const handleReorderGroupToEnd = (sourcePath: string) => {
    setDragState(null);
    setDropTarget(null);
    void reorderConnectionGroups(moveGroupBlockToEnd(orderedGroupPaths, sourcePath));
  };
  const handleReorderConnection = (sourceId: string, targetId: string, placement: InsertPlacement) => {
    setDragState(null);
    setDropTarget(null);
    const currentIds = orderedConnections.map((connection) => connection.id);
    void reorderConnections(moveItemToInsert(currentIds, sourceId, targetId, placement));
  };
  const handleReorderConnectionToEnd = (sourceId: string) => {
    setDragState(null);
    setDropTarget(null);
    const currentIds = orderedConnections.map((connection) => connection.id);
    void reorderConnections(moveItemToEnd(currentIds, sourceId));
  };
  const resolveConnectionManagerDropTarget = (event: PointerEvent, currentDrag: NonNullable<ConnectionManagerDragState>): ConnectionManagerDropTarget => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const targetConnection = target?.closest<HTMLElement>('[data-connection-id]');
    const targetGroup = target?.closest<HTMLElement>('[data-group-path]');
    const targetUngrouped = target?.closest<HTMLElement>('[data-ungrouped-drop-target]');

    // 拖动连接时，连接行表示排序插入点；左侧分组行表示移动到该分组，未分组固定入口表示清空分组。
    if (currentDrag.type === 'connection') {
      const targetConnectionId = targetConnection?.dataset.connectionId;
      if (targetConnectionId === currentDrag.id) {
        return null;
      }
      if (targetConnectionId) {
        return {
          type: 'connection-insert',
          connectionId: targetConnectionId,
          placement: resolveInsertPlacement(event, targetConnection),
        };
      }

      const targetGroupPath = targetGroup?.dataset.groupPath;
      if (targetGroupPath) {
        return { type: 'connection-group', groupPath: targetGroupPath };
      }
      if (targetUngrouped) {
        return { type: 'connection-ungrouped' };
      }
      if (isPointInsideElement(event, connectionTableBodyRef.current)) {
        return { type: 'connection-end' };
      }
      return null;
    }

    const targetGroupPath = targetGroup?.dataset.groupPath;
    if (targetGroupPath && (targetGroupPath === currentDrag.path || isConnectionGroupOrChildPath(targetGroupPath, currentDrag.path))) {
      return null;
    }
    if (targetGroupPath) {
      return {
        type: 'group-insert',
        groupPath: targetGroupPath,
        placement: resolveInsertPlacement(event, targetGroup),
      };
    }
    if (isPointInsideElement(event, groupSidebarRef.current)) {
      return { type: 'group-end' };
    }
    return null;
  };
  const startConnectionManagerDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    item:
      | { type: 'connection'; id: string; label: string }
      | { type: 'group'; path: string; label: string },
  ) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    // 连接管理使用 pointer 拖拽，不依赖 WebView 原生 drag/drop，避免 Windows Tauri 文件拖放拦截列表排序。
    const basePosition = {
      originX: event.clientX,
      originY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
    };
    if (item.type === 'connection') {
      setDragState({ ...basePosition, type: 'connection', id: item.id, label: item.label });
      return;
    }
    setDragState({ ...basePosition, type: 'group', path: item.path, label: item.label });
  };

  useEffect(() => {
    dragStateRef.current = dragState;
  }, [dragState]);

  useEffect(() => {
    dropTargetRef.current = dropTarget;
  }, [dropTarget]);

  useEffect(() => {
    if (!open) {
      managerWasOpenRef.current = false;
      setDragState(null);
      setDropTarget(null);
      return;
    }
    if (managerWasOpenRef.current) {
      return;
    }

    // 连接管理每次打开时默认落到第一个真实分组；没有分组时才选固定底部的未分组。
    setSelectedGroupPath(firstSelectableGroupPath);
    managerWasOpenRef.current = true;
  }, [firstSelectableGroupPath, open]);

  useEffect(() => {
    if (!dragState) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      setDragState((current) => {
        if (!current) {
          return current;
        }

        const nextDropTarget = resolveConnectionManagerDropTarget(event, current);
        setDropTarget((previous) => (
          JSON.stringify(previous) === JSON.stringify(nextDropTarget) ? previous : nextDropTarget
        ));
        return { ...current, currentX: event.clientX, currentY: event.clientY };
      });
    };

    const handlePointerUp = (event: PointerEvent) => {
      const currentDrag = dragStateRef.current;
      if (!currentDrag) {
        setDragState(null);
        setDropTarget(null);
        return;
      }

      const finalDropTarget = dropTargetRef.current ?? resolveConnectionManagerDropTarget(event, currentDrag);
      setDragState(null);
      setDropTarget(null);

      // 落点按最具体的连接行优先，其次分组行，最后是固定的未分组入口。
      if (currentDrag.type === 'connection') {
        if (finalDropTarget?.type === 'connection-insert') {
          handleReorderConnection(currentDrag.id, finalDropTarget.connectionId, finalDropTarget.placement);
          return;
        }
        if (finalDropTarget?.type === 'connection-end') {
          handleReorderConnectionToEnd(currentDrag.id);
          return;
        }
        if (finalDropTarget?.type === 'connection-group') {
          handleDropConnectionToGroup(currentDrag.id, finalDropTarget.groupPath);
          return;
        }
        if (finalDropTarget?.type === 'connection-ungrouped') {
          handleDropConnectionToGroup(currentDrag.id, ungroupedGroupPath);
          return;
        }
      }

      if (currentDrag.type === 'group') {
        if (finalDropTarget?.type === 'group-insert') {
          handleReorderGroup(currentDrag.path, finalDropTarget.groupPath, finalDropTarget.placement);
          return;
        }
        if (finalDropTarget?.type === 'group-end') {
          handleReorderGroupToEnd(currentDrag.path);
          return;
        }
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [Boolean(dragState)]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <div className="modal card modal-wide">
        <div className="modal-header">
          <div>
            <h3>{t('connectionManagerTitle')}</h3>
          </div>
          <div className="section-row compact">
            <button
              className="primary-button"
              onClick={() => openConnectionForm(undefined, selectedGroupPath === ungroupedGroupPath ? undefined : selectedGroupPath)}
              type="button"
            >
              <Plus size={16} /> {t('newConnection')}
            </button>
            <button className="icon-button" onClick={onClose} type="button">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="connection-manager-layout">
          <aside
            className={`connection-groups-sidebar ${dropTarget?.type === 'group-end' ? 'is-drop-end' : ''}`}
            ref={groupSidebarRef}
          >
            <div className="section-row compact">
              <strong>{t('connectionGroupsTitle')}</strong>
              <button className="secondary-button slim" onClick={startCreateGroup} type="button">
                <Plus size={14} /> {t('newGroup')}
              </button>
            </div>

            {groupEditorMode ? (
              <div className="connection-group-editor">
                <span>{groupEditorMode === 'edit' ? t('editGroup') : t('newGroup')}</span>
                <input
                  autoFocus
                  placeholder={t('groupNamePlaceholder')}
                  value={groupDraft}
                  onChange={(event) => setGroupDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void saveGroup();
                    }
                    if (event.key === 'Escape') {
                      cancelGroupEditor();
                    }
                  }}
                />
                <div className="connection-group-editor-actions">
                  <button className="secondary-button slim" onClick={cancelGroupEditor} type="button">
                    {t('cancelGroupEdit')}
                  </button>
                  <button className="primary-button slim" disabled={!canSaveGroup} onClick={() => void saveGroup()} type="button">
                    <Save size={14} /> {t('saveGroup')}
                  </button>
                </div>
              </div>
            ) : null}

            <ConnectionGroupTree
              nodes={groups}
              selectedPath={selectedGroupPath}
              onDelete={requestDeleteGroup}
              onEdit={startEditGroup}
              onSelect={setSelectedGroupPath}
              dragState={dragState}
              dropTarget={dropTarget}
              onStartGroupDrag={(event, path, label) => startConnectionManagerDrag(event, { type: 'group', path, label })}
              deleteLabel={t('deleteGroup')}
              editLabel={t('editGroup')}
            />
            <div
              data-ungrouped-drop-target="true"
              className={`connection-group-row connection-group-row-ungrouped ${selectedGroupPath === ungroupedGroupPath ? 'is-selected' : ''} ${dropTarget?.type === 'connection-ungrouped' ? 'is-drop-target' : ''} ${dropTarget?.type === 'group-end' ? 'is-drop-before' : ''}`}
            >
              <span className="drag-handle drag-handle-placeholder" aria-hidden="true" />
              <button
                className="connection-group-button"
                onClick={() => setSelectedGroupPath(ungroupedGroupPath)}
                type="button"
              >
                <FolderTree size={14} />
                <span>{t('ungroupedConnections')}</span>
              </button>
            </div>
          </aside>

          <section className="connection-table-shell">
            <div className="section-row compact">
              <strong>{t('connectionItemsTitle')}</strong>
              <span>{visibleConnections.length}</span>
            </div>

            <div className="connection-table-scroll">
              <div className="connection-table-header" style={connectionTableGridStyle}>
                <span className="connection-column-header" />
                {[t('fieldName'), t('fieldHost'), t('fieldPort'), t('fieldUsername')].map((label, index) => (
                  <span key={label} className="connection-column-header">
                    <span>{label}</span>
                    <button
                      aria-label={`调整${label}列宽`}
                      className="connection-column-resizer"
                      onPointerDown={(event) => beginConnectionTableColumnResize(event, index + 1)}
                      title={`调整${label}列宽`}
                      type="button"
                    />
                  </span>
                ))}
                <span className="connection-column-header" />
              </div>

              <div
                className={`connection-table-body ${dropTarget?.type === 'connection-end' ? 'is-drop-end' : ''}`}
                ref={connectionTableBodyRef}
              >
                {visibleConnections.length ? (
                  visibleConnections.map((connection) => (
                    <div
                      key={connection.id}
                      data-connection-id={connection.id}
                      className={`connection-table-row ${dragState?.type === 'connection' && dragState.id === connection.id ? 'is-dragging' : ''} ${dropTarget?.type === 'connection-insert' && dropTarget.connectionId === connection.id ? `is-drop-${dropTarget.placement}` : ''}`}
                      style={connectionTableGridStyle}
                    >
                      <button
                        aria-label={`拖动连接 ${connection.name}`}
                        className="drag-handle"
                        onPointerDown={(event) => startConnectionManagerDrag(event, { type: 'connection', id: connection.id, label: connection.name })}
                        title={`拖动连接 ${connection.name}`}
                        type="button"
                      >
                        <GripVertical size={14} />
                      </button>
                      <span title={connection.name}>{connection.name}</span>
                      <span title={connection.host}>{connection.host}</span>
                      <span title={String(connection.port)}>{connection.port}</span>
                      <span title={connection.username}>{connection.username}</span>
                      {/* 连接列表操作按钮保留文字，同时补充图标帮助用户更快识别常用动作。 */}
                      <div className="connection-table-actions">
                        <button className="ghost-button slim" onClick={() => {
                          // 管理弹窗先关闭，再启动会话；避免连接建立时的状态刷新和弹窗布局同时竞争渲染。
                          onClose();
                          void openSession(connection.id);
                        }} type="button">
                          <Play size={13} /> {t('connect')}
                        </button>
                        <button className="ghost-button slim" onClick={() => openConnectionForm(connection)} type="button">
                          <Pencil size={13} /> {t('edit')}
                        </button>
                        <button className="ghost-button slim" onClick={() => handleDuplicateConnection(connection.id)} type="button">
                          <Copy size={13} /> {t('copy')}
                        </button>
                        <button className="ghost-button slim danger-button" onClick={() => void deleteConnection(connection.id)} type="button">
                          {t('delete')}
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="empty-state">
                    {selectedGroupPath ? t('noConnectionsInGroup') : t('connectionManagerEmpty')}
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
        {dragState ? (
          <div
            className="drag-preview"
            style={{ left: dragState.currentX + 10, top: dragState.currentY + 10 }}
          >
            <GripVertical size={13} />
            <span>{dragState.label}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LocalTerminalManagerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    localTerminals,
    openLocalTerminal,
    saveLocalTerminals,
    settings,
    setStatusMessage,
  } = useAppStore();
  const [draft, setDraft] = useState<LocalTerminalSettings>(localTerminals);
  // 当前启动目录默认落到工作区，避免用户第一次打开时面对空白路径。
  const [cwd, setCwd] = useState(localTerminals.profiles[0]?.cwd ?? defaultLocalTerminalCwd);
  // 启动命令允许为空，空值表示直接打开本地 shell，而不是强制启动 CLI。
  const [command, setCommand] = useState(localTerminals.profiles[0]?.command ?? localTerminals.commands[0]?.command ?? '');
  const [newCommand, setNewCommand] = useState('');
  // 历史目录保留最近一次选择的命令，打开时允许单独切换，不把历史固定死成单一入口。
  const [profileCommands, setProfileCommands] = useState<Record<string, string>>({});

  const commandOptions = useMemo(() => {
    const map = new Map<string, LocalTerminalCommand>();
    [localTerminalShellCommand, ...draft.commands].forEach((item) => {
      if (!map.has(item.id)) {
        map.set(item.id, item);
      }
    });
    return Array.from(map.values());
  }, [draft.commands]);
  const t = (key: TranslationKey, replacements?: Record<string, string | number>) =>
    translate(settings.uiLanguage, key, replacements);
  const getLocalTerminalCommandName = (item: LocalTerminalCommand) => {
    // 内置 shell 命令的持久化名称可能来自旧配置，展示时跟随当前界面语言。
    return item.id === localTerminalShellCommand.id || !item.command.trim()
      ? t('localTerminalTitle')
      : item.name;
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    setDraft(localTerminals);
    setCwd(localTerminals.profiles[0]?.cwd ?? defaultLocalTerminalCwd);
    setCommand(localTerminals.profiles[0]?.command ?? localTerminals.commands[0]?.command ?? '');
    setProfileCommands(Object.fromEntries(localTerminals.profiles.map((profile) => [profile.id, profile.command ?? ''])));
    setNewCommand('');
  }, [open]);

  if (!open) {
    return null;
  }

  const persistDraft = async (nextDraft: LocalTerminalSettings) => {
    setDraft(nextDraft);
    await saveLocalTerminals(nextDraft);
  };

  const browseDirectory = async () => {
    const selected = await openFileDialog({
      directory: true,
      multiple: false,
      defaultPath: cwd,
    }).catch(() => null);
    if (typeof selected === 'string') {
      setCwd(selected);
    }
  };

  const browseShellPath = async () => {
    const selected = await openFileDialog({
      directory: false,
      multiple: false,
      defaultPath: draft.shellPath || undefined,
    }).catch(() => null);
    if (typeof selected === 'string') {
      setDraft((current) => ({ ...current, shellPath: selected }));
    }
  };

  const openCurrentTerminal = async () => {
    const normalizedCwd = cwd.trim();
    const normalizedCommand = command.trim();
    if (!normalizedCwd) {
      setStatusMessage(t('validationLocalTerminalCwdRequired'));
      return;
    }
    await persistDraft(draft);
    onClose();
    void openLocalTerminal(createLocalTerminalProfile(normalizedCwd, normalizedCommand));
  };

  const addCommand = async () => {
    const normalized = newCommand.trim();
    if (!normalized) {
      return;
    }
    if (draft.commands.some((item) => item.command === normalized)) {
      setCommand(normalized);
      setNewCommand('');
      return;
    }
    const nextDraft = {
      ...draft,
      commands: [
        ...draft.commands,
        {
          id: crypto.randomUUID(),
          name: normalized,
          command: normalized,
          builtIn: false,
        },
      ],
    };
    await persistDraft(nextDraft);
    setCommand(normalized);
    setNewCommand('');
  };

  const deleteCommand = async (commandId: string) => {
    const target = draft.commands.find((item) => item.id === commandId);
    if (!target || target.builtIn) {
      return;
    }
    const nextCommands = draft.commands.filter((item) => item.id !== commandId);
    const nextDraft = { ...draft, commands: nextCommands };
    await persistDraft(nextDraft);
    if (command === target.command) {
      setCommand(nextCommands[0]?.command ?? '');
    }
  };

  const deleteProfile = async (profileId: string) => {
    await persistDraft({
      ...draft,
      profiles: draft.profiles.filter((profile) => profile.id !== profileId),
    });
  };

  const openProfile = (profile: LocalTerminalProfile, selectedCommand: string) => {
    const normalizedCommand = selectedCommand.trim();
    onClose();
    void openLocalTerminal({
      ...profile,
      command: normalizedCommand,
      title: normalizeLocalTerminalProfileTitle(profile.cwd, normalizedCommand),
    });
  };

  return (
    <div className="modal-backdrop">
      <div className="modal card modal-wide local-terminal-modal">
        <div className="modal-header">
          <div>
            <h3>{t('localTerminalTitle')}</h3>
          </div>
          <button className="icon-button" onClick={onClose} type="button">
            <X size={18} />
          </button>
        </div>

        <div className="local-terminal-layout">
          <section className="local-terminal-panel local-terminal-command-panel">
            <div className="section-row compact">
              <strong>{t('localTerminalOpenDirectory')}</strong>
            </div>
            <div className="local-terminal-form-row">
              <input value={cwd} onChange={(event) => setCwd(event.target.value)} />
              <button className="secondary-button" onClick={() => void browseDirectory()} type="button">
                <FolderOpen size={15} /> {t('localTerminalBrowse')}
              </button>
            </div>

            <div className="section-row compact">
              <strong>{t('localTerminalStartupCommand')}</strong>
            </div>
            <div className="local-terminal-form-row">
              <select value={command} onChange={(event) => setCommand(event.target.value)}>
                {commandOptions.map((item) => (
                  <option key={item.id} value={item.command}>{getLocalTerminalCommandName(item)}</option>
                ))}
              </select>
              <button className="primary-button" onClick={() => void openCurrentTerminal()} type="button">
                <Play size={15} /> {t('localTerminalOpenTerminal')}
              </button>
            </div>

            <div className="section-row compact">
              <strong>{t('localTerminalShellPath')}</strong>
              <button
                className="secondary-button slim"
                onClick={() => void persistDraft(draft)}
                type="button"
              >
                <Save size={14} /> {t('localTerminalSave')}
              </button>
            </div>
            <div className="local-terminal-form-row">
              <input
                placeholder={t('localTerminalShellPathPlaceholder')}
                value={draft.shellPath}
                onChange={(event) => setDraft((current) => ({ ...current, shellPath: event.target.value }))}
              />
              <button className="secondary-button" onClick={() => void browseShellPath()} type="button">
                <FolderOpen size={15} /> {t('localTerminalBrowse')}
              </button>
            </div>
          </section>

          <section className="local-terminal-panel">
            <div className="section-row compact">
              <strong>{t('localTerminalCommandManagement')}</strong>
            </div>
            <div className="local-terminal-form-row">
              <input
                placeholder={t('localTerminalNewCommandPlaceholder')}
                value={newCommand}
                onChange={(event) => setNewCommand(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void addCommand();
                  }
                }}
              />
              <button className="secondary-button" onClick={() => void addCommand()} type="button">
                <Plus size={15} /> {t('localTerminalAddCommand')}
              </button>
            </div>
            <div className="local-terminal-command-list">
              {draft.commands.map((item) => (
                <div key={item.id} className="local-terminal-command-row">
                  <span>{getLocalTerminalCommandName(item)}</span>
                  <code>{item.command || 'shell'}</code>
                  <button
                    className="icon-button"
                    disabled={item.builtIn}
                    onClick={() => void deleteCommand(item.id)}
                    title={item.builtIn ? t('localTerminalBuiltInCommandLocked') : t('localTerminalDeleteCommand')}
                    type="button"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section className="local-terminal-panel local-terminal-history-panel">
            <div className="section-row compact">
              <strong>{t('localTerminalHistoryTitle')}</strong>
              <span>{draft.profiles.length}</span>
            </div>
            <div className="local-terminal-history-list">
              {draft.profiles.length ? draft.profiles.map((profile) => (
                <div key={profile.id} className="local-terminal-history-row">
                  <div className="local-terminal-history-main">
                    <strong>{profile.cwd}</strong>
                    <span>{profile.command || t('localTerminalTitle')}</span>
                  </div>
                  <select
                    className="local-terminal-history-command"
                    value={profileCommands[profile.id] ?? profile.command ?? ''}
                    onChange={(event) => setProfileCommands((current) => ({ ...current, [profile.id]: event.target.value }))}
                  >
                    {commandOptions.map((item) => (
                      <option key={item.id} value={item.command}>{getLocalTerminalCommandName(item)}</option>
                    ))}
                  </select>
                  <button
                    className="secondary-button slim"
                    onClick={() => openProfile(profile, profileCommands[profile.id] ?? profile.command ?? '')}
                    type="button"
                  >
                    <Play size={14} /> {t('localTerminalOpen')}
                  </button>
                  <button className="icon-button" onClick={() => void deleteProfile(profile.id)} title={t('localTerminalDeleteHistory')} type="button">
                    <X size={14} />
                  </button>
                </div>
              )) : (
                <div className="empty-state">{t('localTerminalHistoryEmpty')}</div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function EditorModal({
  onSaveWithProgress,
}: {
  onSaveWithProgress?: (path: string, saveTask: () => Promise<void>) => void;
}) {
  const {
    closeEditorDocument,
    editorDocument,
    saveEditorDocument,
    setEditorContent,
    settings,
  } = useAppStore();

  const t = (key: TranslationKey, replacements?: Record<string, string | number>) =>
    translate(settings.uiLanguage, key, replacements);
  const editorTheme = settings.themeMode === 'dark' ? 'vs-dark' : 'vs-light';

  if (!editorDocument) {
    return null;
  }

  const handleSaveEditorDocument = () => {
    if (onSaveWithProgress) {
      // 远程编辑保存同样是一次 SFTP 写入，复用全局传输提示，避免用户误以为按钮没有响应。
      onSaveWithProgress(editorDocument.path, saveEditorDocument);
      return;
    }
    void saveEditorDocument();
  };

  return (
    <div className="modal-backdrop">
      <div className="modal modal-editor card">
        <div className="modal-header">
          <div>
            <h3>{t('editorModalTitle')}</h3>
            <p>{editorDocument.path}</p>
          </div>
          <div className="section-row compact">
            <button className="secondary-button" onClick={closeEditorDocument} type="button">
              {t('close')}
            </button>
            <button className="primary-button" onClick={handleSaveEditorDocument} type="button">
              <Save size={16} />
              {editorDocument.dirty ? t('saveToRemote') : t('saved')}
            </button>
          </div>
        </div>

        <div className="editor-shell modal-editor-shell">
          <Suspense fallback={<div className="empty-state">{t('working')}</div>}>
            <MonacoEditor
              fontFamily={buildPreviewFontFamily(settings)}
              fontSize={settings.shellFontSize}
              language={editorDocument.language}
              onChange={(value) => setEditorContent(value ?? '')}
              onSave={handleSaveEditorDocument}
              theme={editorTheme}
              value={editorDocument.content}
            />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

function SettingsModal({
  open,
  activeTab,
  onClose,
  onTabChange,
}: {
  open: boolean;
  activeTab: SettingsTab;
  onClose: () => void;
  onTabChange: (tab: SettingsTab) => void;
}) {
  const {
    checkForUpdates,
    connections,
    installUpdate,
    settings,
    testWebdavConnection,
    uploadConfig,
    downloadConfig,
    exportLocalConfig,
    importLocalConfig,
    persistSettings,
    updateSettings,
  } = useAppStore();
  const [revealWebdavPassword, setRevealWebdavPassword] = useState(false);
  const [settingsSaveMessage, setSettingsSaveMessage] = useState('');
  const [settingsActionRunning, setSettingsActionRunning] = useState('');
  const [draftSettings, setDraftSettings] = useState<AppSettings>(settings);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateCheckResult, setUpdateCheckResult] = useState<UpdateCheckResult | null>(null);
  const [updateFeedback, setUpdateFeedback] = useState<{ kind: 'is-success' | 'is-error'; message: string } | null>(null);
  const [agentBridgeStatus, setAgentBridgeStatus] = useState<AgentBridgeStatus | null>(null);
  const [agentBridgeTransition, setAgentBridgeTransition] = useState<'starting' | 'stopping' | ''>('');
  const settingsSaveTimerRef = useRef<number | null>(null);
  const [actionFeedbackMap, setActionFeedbackMap] = useState<Record<string, { kind: 'is-success' | 'is-error'; message: string }>>({});
  const actionFeedbackTimerRef = useRef<Record<string, number>>({});
  const [backupSelectorOpen, setBackupSelectorOpen] = useState(false);
  const [backupList, setBackupList] = useState<string[]>([]);
  const backupSelectorResolveRef = useRef<((value: string | null) => void) | null>(null);

  const t = (key: TranslationKey, replacements?: Record<string, string | number>) =>
    translate(draftSettings.uiLanguage ?? settings.uiLanguage, key, replacements);
  // 界面版本由 Vite 从 package.json 注入，避免关于页和发布元数据出现不同版本。
  const appVersion = import.meta.env.VITE_APP_VERSION;
  const webdavPasswordToggleLabel = revealWebdavPassword ? t('hideSecret') : t('showSecret');
  const selectedLatinFontFamily = draftSettings.shellLatinFontFamily || draftSettings.shellFontFamily.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '') || 'JetBrains Mono';
  const selectedCjkFontFamily = draftSettings.shellCjkFontFamily || selectedLatinFontFamily;
  const latinOptions = ensureFontOption(latinFontOptions, selectedLatinFontFamily);
  const cjkOptions = ensureFontOption(cjkFontOptions, selectedCjkFontFamily);
  const agentAutoGroups = useMemo(
    () => buildConnectionGroupTree(draftSettings.connectionGroups, connections),
    [connections, draftSettings.connectionGroups],
  );
  const agentAutoUngroupedConnections = useMemo(
    () => connections.filter((connection) => !normalizeConnectionGroupPath(connection.groupPath)),
    [connections],
  );
  const terminalPreviewStyle = useMemo<CSSProperties>(
    () => ({
      fontFamily: buildPreviewFontFamily(draftSettings),
      fontSize: draftSettings.shellFontSize,
      background: draftSettings.terminalBackground,
      color: draftSettings.terminalForeground,
    }),
    [draftSettings],
  );
  const updateDraftSettings = (updater: (settings: AppSettings) => AppSettings) => {
    setDraftSettings((current) => updater(current));
  };
  const toggleAgentAutoConnection = (connectionId: string, checked: boolean) => {
    updateDraftSettings((current) => {
      const currentIds = current.agentBridge.allowedConnectionIds;
      const allowedConnectionIds = checked
        ? Array.from(new Set([...currentIds, connectionId]))
        : currentIds.filter((item) => item !== connectionId);
      return { ...current, agentBridge: { ...current.agentBridge, allowedConnectionIds } };
    });
  };
  const showSettingsFeedback = (message: string) => {
    setSettingsSaveMessage(message);
    if (settingsSaveTimerRef.current !== null) {
      window.clearTimeout(settingsSaveTimerRef.current);
    }
    // 设置反馈只短暂停留，避免把工具面板变成常驻通知区。
    settingsSaveTimerRef.current = window.setTimeout(() => {
      setSettingsSaveMessage('');
      settingsSaveTimerRef.current = null;
    }, 3000);
  };
  const persistSettingsWithFeedback = async () => {
    const saved = await persistSettings(draftSettings);
    setDraftSettings(saved);
    void refreshAgentBridgeStatus();
    showSettingsFeedback(t('statusSettingsSaved'));
    showActionFeedback('save-webdav', 'is-success', t('statusSettingsSaved'));
  };
  const refreshAgentBridgeStatus = async () => {
    try {
      const status = await backend.agentBridgeStatus();
      setAgentBridgeStatus(status);
      return status;
    } catch {
      setAgentBridgeStatus(null);
      return null;
    }
  };
  const copyAgentMcpConfig = async () => {
    await writeClipboardText(buildAgentMcpConfig(agentBridgeStatus?.discoveryPath));
    showActionFeedback('copy-agent-config', 'is-success', t('statusAgentBridgeConfigCopied'));
  };
  const showActionFeedback = (actionKey: string, kind: 'is-success' | 'is-error', message: string) => {
    setActionFeedbackMap((prev) => ({ ...prev, [actionKey]: { kind, message } }));
    if (actionFeedbackTimerRef.current[actionKey]) {
      window.clearTimeout(actionFeedbackTimerRef.current[actionKey]);
    }
    actionFeedbackTimerRef.current[actionKey] = window.setTimeout(() => {
      setActionFeedbackMap((prev) => {
        const next = { ...prev };
        delete next[actionKey];
        return next;
      });
      delete actionFeedbackTimerRef.current[actionKey];
    }, 5000);
  };
  const runSettingsAction = async (actionKey: string, action: () => Promise<void>, successMessage?: string) => {
    setSettingsActionRunning(actionKey);
    // 清除该按钮的旧反馈，显示 working 状态
    setActionFeedbackMap((prev) => {
      const next = { ...prev };
      delete next[actionKey];
      return next;
    });
    try {
      await action();
      const message = successMessage ?? useAppStore.getState().statusMessage;
      showActionFeedback(actionKey, 'is-success', message);
      showSettingsFeedback(message);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // 用户主动取消（如下载弹窗点取消），不展示错误提示
      if (reason === t('downloadCancelled')) {
        setSettingsActionRunning('');
        return;
      }
      const message = t('statusWebdavActionFailed', { reason });
      showActionFeedback(actionKey, 'is-error', message);
      showSettingsFeedback(message);
    } finally {
      setSettingsActionRunning('');
    }
  };
  const waitForAgentBridgeState = async (enabled: boolean, initialStatus: AgentBridgeStatus | null) => {
    if (initialStatus?.running === enabled) {
      return initialStatus;
    }

    // Broker 启停通常很快；短轮询只兜底后端监听线程或端口释放稍慢的情况。
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      const status = await refreshAgentBridgeStatus();
      if (status?.running === enabled) {
        return status;
      }
    }
    return initialStatus;
  };
  const setAgentBridgeEnabled = async (enabled: boolean) => {
    const previousEnabled = draftSettings.agentBridge.enabled;
    const nextTransition = enabled ? 'starting' : 'stopping';
    const applyEnabled = (value: boolean) => {
      updateDraftSettings((current) => ({
        ...current,
        agentBridge: { ...current.agentBridge, enabled: value },
      }));
      updateSettings((current) => ({
        ...current,
        agentBridge: { ...current.agentBridge, enabled: value },
      }));
    };

    setAgentBridgeTransition(nextTransition);
    applyEnabled(enabled);
    try {
      const status = await backend.setAgentBridgeEnabled(enabled);
      const confirmedStatus = await waitForAgentBridgeState(enabled, status);
      if (confirmedStatus) {
        setAgentBridgeStatus(confirmedStatus);
      }
      showSettingsFeedback(enabled ? t('statusAgentBridgeStarted') : t('statusAgentBridgeStopped'));
    } catch (error) {
      applyEnabled(previousEnabled);
      const status = await refreshAgentBridgeStatus();
      if (status) {
        applyEnabled(status.enabled);
      }
      const reason = error instanceof Error ? error.message : String(error);
      showSettingsFeedback(t('statusAgentBridgeToggleFailed', { reason }));
    } finally {
      setAgentBridgeTransition('');
    }
  };
  const saveAgentBridgeSettings = async () => {
    await runSettingsAction(
      'save-agent-settings',
      async () => {
        const saved = await persistSettings(draftSettings);
        setDraftSettings(saved);
        await refreshAgentBridgeStatus();
      },
      t('statusAgentBridgeSettingsSaved'),
    );
  };
  const openExternalLink = (url: string) => {
    const isDesktopRuntime = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    if (!isDesktopRuntime) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }

    // 桌面端外链交给 Rust 后端调用系统浏览器，避免 Tauri WebView 拦截 window.open。
    void backend.openExternalUrl(url).catch(() => {
      window.open(url, '_blank', 'noopener,noreferrer');
    });
  };
  const formatReleaseTime = (value?: string) => {
    if (!value) {
      return t('metricUnavailable');
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(draftSettings.uiLanguage);
  };
  const handleCheckForUpdates = async () => {
    setUpdateChecking(true);
    setUpdateFeedback(null);
    setUpdateCheckResult(null);
    try {
      // 更新检测只读取 GitHub Release 元数据，用户确认后再通过 Release 页面下载新版安装包。
      const result = await checkForUpdates();
      setUpdateCheckResult(result);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setUpdateFeedback({ kind: 'is-error', message: t('statusUpdateCheckFailed', { reason }) });
    } finally {
      setUpdateChecking(false);
    }
  };
  const handleInstallUpdate = async () => {
    if (!updateCheckResult) {
      return;
    }

    setUpdateInstalling(true);
    setUpdateFeedback(null);
    try {
      // 安装动作只在用户点击后触发；后端会下载 Release 安装包并启动安装程序。
      const installerPath = await installUpdate(updateCheckResult);
      // 桌面 WebView 弹窗可能被安装器抢焦点，设置页内也保留可见成功信息和本地路径。
      setUpdateFeedback({ kind: 'is-success', message: t('statusUpdateInstallStartedWithPath', { path: installerPath }) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setUpdateFeedback({ kind: 'is-error', message: t('statusUpdateInstallFailed', { reason }) });
    } finally {
      setUpdateInstalling(false);
    }
  };
  const handleLocalBackgroundImage = async () => {
    const selectedPath = await openFileDialog({
      multiple: false,
      filters: [
        {
          name: 'Images',
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'],
        },
      ],
    });
    if (!selectedPath || Array.isArray(selectedPath)) {
      return;
    }

    // 背景图需要持久保存真实本地路径，系统文件对话框会把所选文件加入 asset 协议作用域。
    updateDraftSettings((current) => ({ ...current, backgroundImage: selectedPath }));
  };
  const handleExportLocalConfig = async () => {
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+$/, '')
      .replace('T', '-');
    const selectedPath = await saveFileDialog({
      defaultPath: `myterminal-config-${timestamp}.json`,
      filters: [
        {
          name: 'JSON',
          extensions: ['json'],
        },
      ],
    });
    if (!selectedPath) {
      return;
    }

    // 本地导出由用户明确选择保存位置，避免按钮点击后只在默认目录静默生成文件。
    await runSettingsAction('export-local', () => exportLocalConfig(selectedPath));
  };

  useEffect(() => {
    if (open) {
      setDraftSettings(settings);
      setSettingsSaveMessage('');
      setSettingsActionRunning('');
      void refreshAgentBridgeStatus();
    }
  }, [open, settings]);

  useEffect(() => {
    return () => {
      if (settingsSaveTimerRef.current !== null) {
        window.clearTimeout(settingsSaveTimerRef.current);
      }
      Object.values(actionFeedbackTimerRef.current).forEach((timer) => {
        window.clearTimeout(timer);
      });
    };
  }, []);

  if (!open) {
    return null;
  }

  const agentBridgeSwitchBusy = Boolean(agentBridgeTransition);
  const agentBridgeSwitchLabel = agentBridgeTransition === 'starting'
    ? t('agentBridgeStarting')
    : agentBridgeTransition === 'stopping'
      ? t('agentBridgeStopping')
      : draftSettings.agentBridge.enabled
        ? t('enabled')
        : t('disabled');

  return (
    <div className="modal-backdrop">
      <div className="modal modal-settings card">
        <div className="modal-header">
          <div>
            <h3>{t('settingsModalTitle')}</h3>
          </div>
          <button className="icon-button" onClick={onClose} type="button">
            <X size={18} />
          </button>
        </div>

        <div className="settings-shell">
          <nav className="settings-nav">
            <button
              className={`settings-nav-item ${activeTab === 'appearance' ? 'is-active' : ''}`}
              onClick={() => onTabChange('appearance')}
              type="button"
            >
              <Settings size={16} />
              {t('settingsTabAppearance')}
            </button>
            <button
              className={`settings-nav-item ${activeTab === 'sync' ? 'is-active' : ''}`}
              onClick={() => onTabChange('sync')}
              type="button"
            >
              <Upload size={16} />
              {t('settingsTabSync')}
            </button>
            <button
              className={`settings-nav-item ${activeTab === 'agent' ? 'is-active' : ''}`}
              onClick={() => onTabChange('agent')}
              type="button"
            >
              <Cable size={16} />
              {t('settingsTabAgent')}
            </button>
            <button
              className={`settings-nav-item ${activeTab === 'about' ? 'is-active' : ''}`}
              onClick={() => onTabChange('about')}
              type="button"
            >
              <Info size={16} />
              {t('settingsTabAbout')}
            </button>
          </nav>

          <div className="settings-content">
            {activeTab === 'appearance' ? (
              <div className="stack gap-16">
                {/* 外观页按用户认知路径分块：先配置应用偏好，再调整终端视觉与交互。 */}
                <section className="settings-section-block">
                  <div>
                    <h3>{t('appearanceBaseTitle')}</h3>
                    <p>{t('appearanceBaseDesc')}</p>
                  </div>

                  <div className="form-grid">
                    <label>
                      <span>{t('fieldTheme')}</span>
                      <select value={draftSettings.themeMode} onChange={(event) => updateDraftSettings((current) => ({ ...current, themeMode: event.target.value as 'light' | 'dark' }))}>
                        <option value="light">{t('light')}</option>
                        <option value="dark">{t('dark')}</option>
                      </select>
                    </label>
                    <label>
                      <span>{t('fieldLanguage')}</span>
                      <select value={draftSettings.uiLanguage} onChange={(event) => updateDraftSettings((current) => ({ ...current, uiLanguage: event.target.value as UiLanguage }))}>
                        <option value="zh-CN">{t('languageZhCn')}</option>
                        <option value="en-US">{t('languageEnUs')}</option>
                      </select>
                    </label>
                  </div>
                </section>

                <section className="settings-section-block">
                  <div>
                    <h3>{t('appearanceFontTitle')}</h3>
                    <p>{t('appearanceFontDesc')}</p>
                  </div>

                  <div className="form-grid">
                    <label>
                      <span>{t('fieldLatinFontFamily')}</span>
                      <select value={selectedLatinFontFamily} onChange={(event) => updateDraftSettings((current) => ({ ...current, shellLatinFontFamily: event.target.value }))}>
                        {latinOptions.map((fontFamily) => (
                          <option key={fontFamily} value={fontFamily}>
                            {fontFamily}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>{t('fieldCjkFontFamily')}</span>
                      <select value={selectedCjkFontFamily} onChange={(event) => updateDraftSettings((current) => ({ ...current, shellCjkFontFamily: event.target.value }))}>
                        {cjkOptions.map((fontFamily) => (
                          <option key={fontFamily} value={fontFamily}>
                            {fontFamily}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>{t('fieldFontSize')}</span>
                      <input type="number" value={draftSettings.shellFontSize} onChange={(event) => updateDraftSettings((current) => ({ ...current, shellFontSize: Number(event.target.value) || 15 }))} />
                    </label>
                    <div className="font-preview-panel span-2" style={terminalPreviewStyle}>
                      <span>0123456789 abcdefghABCDEFGH</span>
                      <strong>终端中文字体预览</strong>
                    </div>
                  </div>
                </section>

                <section className="settings-section-block">
                  <div>
                    <h3>{t('appearanceBackgroundTitle')}</h3>
                    <p>{t('appearanceBackgroundDesc')}</p>
                  </div>

                  <div className="form-grid">
                    <label className="span-2">
                      <span>{t('fieldTerminalBackgroundImage')}</span>
                      <div className="background-image-field">
                        <input
                          placeholder="C:\\Pictures\\terminal.png 或 https://example.com/bg.png"
                          value={draftSettings.backgroundImage ?? ''}
                          onChange={(event) => updateDraftSettings((current) => ({ ...current, backgroundImage: event.target.value }))}
                        />
                        <button
                          className="secondary-button slim"
                          onClick={() => void handleLocalBackgroundImage()}
                          type="button"
                        >
                          <Upload size={14} /> {t('chooseLocalImage')}
                        </button>
                      </div>
                    </label>
                    <label>
                      <span>{t('fieldTerminalBackgroundImageOpacity')}</span>
                      <div className="opacity-control">
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={draftSettings.terminalBackgroundImageOpacity ?? 0.18}
                          onChange={(event) => updateDraftSettings((current) => ({ ...current, terminalBackgroundImageOpacity: Number(event.target.value) }))}
                        />
                        <input
                          aria-label={t('fieldTerminalBackgroundImageOpacity')}
                          type="number"
                          min={0}
                          max={100}
                          step={1}
                          value={Math.round((draftSettings.terminalBackgroundImageOpacity ?? 0.18) * 100)}
                          onChange={(event) => updateDraftSettings((current) => ({ ...current, terminalBackgroundImageOpacity: clamp(Number(event.target.value) || 0, 0, 100) / 100 }))}
                        />
                      </div>
                    </label>
                    <label>
                      <span>{t('fieldTerminalBackgroundImageFit')}</span>
                      <select
                        value={draftSettings.terminalBackgroundImageFit ?? 'cover'}
                        onChange={(event) =>
                          updateDraftSettings((current) => ({
                            ...current,
                            terminalBackgroundImageFit: event.target.value as NonNullable<AppSettings['terminalBackgroundImageFit']>,
                          }))
                        }
                      >
                        {terminalBackgroundFitOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {t(option.labelKey)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </section>

                <section className="settings-section-block">
                  <div>
                    <h3>{t('appearanceBehaviorTitle')}</h3>
                    <p>{t('appearanceBehaviorDesc')}</p>
                  </div>

                  <div className="form-grid">
                    <label>
                      <span>{t('fieldRuntimeRefreshInterval')}</span>
                      <input
                        type="number"
                        min={1}
                        max={60}
                        value={draftSettings.runtimeRefreshIntervalSec}
                        onChange={(event) =>
                          updateDraftSettings((current) => ({
                            ...current,
                            runtimeRefreshIntervalSec: Number(event.target.value) || 1,
                          }))
                        }
                      />
                    </label>
                    <label>
                      <span>{t('fieldTerminalRightClickBehavior')}</span>
                      <select
                        value={draftSettings.terminalRightClickBehavior}
                        onChange={(event) => updateDraftSettings((current) => ({ ...current, terminalRightClickBehavior: event.target.value as AppSettings['terminalRightClickBehavior'] }))}
                      >
                        <option value="paste">{t('rightClickPaste')}</option>
                        <option value="menu">{t('rightClickMenu')}</option>
                      </select>
                    </label>
                    <label>
                      <span>{t('fieldTerminalLineWrapMode')}</span>
                      <select
                        value={draftSettings.terminalLineWrapMode ?? 'wrap'}
                        onChange={(event) => updateDraftSettings((current) => ({ ...current, terminalLineWrapMode: event.target.value as AppSettings['terminalLineWrapMode'] }))}
                      >
                        <option value="wrap">{t('terminalLineWrapModeWrap')}</option>
                        <option value="horizontal">{t('terminalLineWrapModeHorizontal')}</option>
                      </select>
                    </label>
                    <label className="toggle-row settings-toggle-row">
                      <span>{t('fieldTerminalMatchSelection')}</span>
                      <input
                        checked={draftSettings.terminalMatchSelection ?? true}
                        type="checkbox"
                        onChange={(event) => updateDraftSettings((current) => ({ ...current, terminalMatchSelection: event.target.checked }))}
                      />
                    </label>
                  </div>
                </section>

                <div className="modal-actions">
                  {settingsSaveMessage ? <span className="inline-save-feedback">{settingsSaveMessage}</span> : null}
                  <button className="primary-button" onClick={() => void persistSettingsWithFeedback()} type="button">
                    <Save size={16} /> {t('saveAppearance')}
                  </button>
                </div>
              </div>
            ) : null}

            {activeTab === 'sync' ? (
              <div className="stack gap-16">
                <section className="settings-section-block">
                  <div className="section-row">
                    <div>
                      <h3>{t('webdavSaveTitle')}</h3>
                    </div>
                    <div className="section-row compact">
                      <button className="secondary-button" disabled={Boolean(settingsActionRunning)} onClick={() => void runSettingsAction('test-webdav', () => testWebdavConnection(draftSettings), t('statusWebdavTestPassed'))} type="button">
                        <RefreshCw size={16} /> {settingsActionRunning === 'test-webdav' ? t('working') : t('testWebdavConnection')}
                      </button>
                      <button className="primary-button" disabled={Boolean(settingsActionRunning)} onClick={() => void persistSettingsWithFeedback()} type="button">
                        <Save size={16} /> {t('saveWebdavSettings')}
                      </button>
                    </div>
                  </div>
                  {actionFeedbackMap['test-webdav'] ? <div className={`sync-action-feedback ${actionFeedbackMap['test-webdav'].kind}`}>{actionFeedbackMap['test-webdav'].message}</div> : null}
                  {actionFeedbackMap['save-webdav'] ? <div className={`sync-action-feedback ${actionFeedbackMap['save-webdav'].kind}`}>{actionFeedbackMap['save-webdav'].message}</div> : null}

                  <div className="form-grid">
                    <label className="span-2">
                      <span>{t('webdavBaseUrl')}</span>
                      <input value={draftSettings.webdav.baseUrl} onChange={(event) => updateDraftSettings((current) => ({ ...current, webdav: { ...current.webdav, baseUrl: event.target.value } }))} />
                    </label>
                    <label>
                      <span>{t('fieldUsername')}</span>
                      <input value={draftSettings.webdav.username} onChange={(event) => updateDraftSettings((current) => ({ ...current, webdav: { ...current.webdav, username: event.target.value } }))} />
                    </label>
                    <label>
                      <span>{t('fieldPassword')}</span>
                      <div className="password-field">
                        <input
                          type={revealWebdavPassword ? 'text' : 'password'}
                          value={draftSettings.webdav.password}
                          onChange={(event) => updateDraftSettings((current) => ({ ...current, webdav: { ...current.webdav, password: event.target.value } }))}
                        />
                        <button
                          aria-label={webdavPasswordToggleLabel}
                          className="secondary-button slim password-toggle-button"
                          onClick={() => setRevealWebdavPassword((value) => !value)}
                          title={webdavPasswordToggleLabel}
                          type="button"
                        >
                          {revealWebdavPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                          <span>{webdavPasswordToggleLabel}</span>
                        </button>
                      </div>
                    </label>
                    <label className="span-2">
                      <span>{t('webdavRemoteDir')}</span>
                      <input placeholder="/myterminal" value={draftSettings.webdav.remotePath} onChange={(event) => updateDraftSettings((current) => ({ ...current, webdav: { ...current.webdav, remotePath: event.target.value } }))} />
                    </label>
                  </div>
                </section>

                <section className="settings-section-block">
                  <div>
                    <h3>{t('webdavTransferTitle')}</h3>
                    <p>{t('webdavTransferDesc')}</p>
                  </div>

                  {(actionFeedbackMap['upload-config'] || actionFeedbackMap['download-config']) ? (
                    <div className={`sync-action-feedback ${actionFeedbackMap['upload-config'] ? actionFeedbackMap['upload-config'].kind : actionFeedbackMap['download-config']?.kind}`}>
                      {actionFeedbackMap['upload-config']?.message || actionFeedbackMap['download-config']?.message}
                    </div>
                  ) : null}

                  <div className="sync-transfer-actions">
                    <button className="primary-button" disabled={Boolean(settingsActionRunning)} onClick={() => void runSettingsAction('upload-config', async () => {
                      await persistSettings(draftSettings);
                      await uploadConfig();
                    }, t('statusUploadedConfig'))} type="button">
                      <Upload size={16} /> {settingsActionRunning === 'upload-config' ? t('working') : t('uploadConfig')}
                    </button>
                    <button className="secondary-button" disabled={Boolean(settingsActionRunning)} onClick={() => void runSettingsAction('download-config', async () => {
                      const backups = await backend.listConfigBackups();
                      if (backups.length === 0) {
                        throw new Error(t('noBackupsFound'));
                      }
                      const selected = await new Promise<string | null>((resolve) => {
                        setBackupList(backups);
                        backupSelectorResolveRef.current = resolve;
                        setBackupSelectorOpen(true);
                      });
                      if (!selected) {
                        throw new Error(t('downloadCancelled'));
                      }
                      await downloadConfig(selected);
                      setDraftSettings(useAppStore.getState().settings);
                    }, t('statusDownloadedConfig'))} type="button">
                      <Download size={16} /> {settingsActionRunning === 'download-config' ? t('working') : t('downloadConfig')}
                    </button>
                  </div>
                </section>

                <section className="settings-section-block">
                  <div>
                    <h3>{t('syncSectionLocal')}</h3>
                  </div>

                  {(actionFeedbackMap['export-local'] || actionFeedbackMap['import-local']) ? (
                    <div className={`sync-action-feedback ${actionFeedbackMap['export-local'] ? actionFeedbackMap['export-local'].kind : actionFeedbackMap['import-local']?.kind}`}>
                      {actionFeedbackMap['export-local']?.message || actionFeedbackMap['import-local']?.message}
                    </div>
                  ) : null}

                  <div className="sync-transfer-actions">
                    <button className="primary-button" disabled={Boolean(settingsActionRunning)} onClick={() => void handleExportLocalConfig()} type="button">
                      <Download size={16} /> {settingsActionRunning === 'export-local' ? t('working') : t('exportLocalConfig')}
                    </button>
                    <label className={`secondary-button file-upload-button ${settingsActionRunning ? 'is-disabled' : ''}`}>
                      <Upload size={16} /> {settingsActionRunning === 'import-local' ? t('working') : t('importLocalConfig')}
                      <input
                        accept="application/json,.json"
                        className="hidden-file-input"
                        disabled={Boolean(settingsActionRunning)}
                        type="file"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file && window.confirm(t('importLocalConfigConfirm'))) {
                            void runSettingsAction('import-local', async () => {
                              await importLocalConfig(file);
                              setDraftSettings(useAppStore.getState().settings);
                            });
                          }
                          event.currentTarget.value = '';
                        }}
                      />
                    </label>
                  </div>
                </section>
              </div>
            ) : null}

            {activeTab === 'agent' ? (
              <div className="stack gap-16">
                <section className={`settings-section-block agent-bridge-control ${agentBridgeSwitchBusy ? 'is-pending' : ''}`}>
                  <div className="agent-bridge-control-main">
                    <div>
                      <h3>{t('agentBridgeTitle')}</h3>
                      <p>{t('agentBridgeDesc')}</p>
                    </div>
                    <label className={`agent-toggle-field agent-bridge-power ${agentBridgeSwitchBusy ? 'is-pending' : ''}`}>
                      <span>{t('fieldAgentBridgeEnabled')}</span>
                      <input
                        checked={draftSettings.agentBridge.enabled}
                        disabled={agentBridgeSwitchBusy}
                        type="checkbox"
                        onChange={(event) => void setAgentBridgeEnabled(event.target.checked)}
                      />
                      <strong>{agentBridgeSwitchLabel}</strong>
                    </label>
                  </div>

                  <div className="settings-about-grid agent-bridge-status-grid">
                    <span>{t('agentBridgeRunState')}</span>
                    <strong>{agentBridgeStatus?.running ? t('statusRunningLabel') : t('statusStoppedLabel')}</strong>
                    <span>{t('agentBridgePort')}</span>
                    <strong>{agentBridgeStatus?.port ?? t('metricUnavailable')}</strong>
                    <span>{t('agentBridgeDiscoveryPath')}</span>
                    <strong>{agentBridgeStatus?.discoveryPath ?? t('metricUnavailable')}</strong>
                  </div>
                </section>

                <section className="settings-section-block">
                  <div className="section-row">
                    <div>
                      <h3>{t('agentBridgeConfigTitle')}</h3>
                      <p>{t('agentBridgeConfigDesc')}</p>
                    </div>
                    <button
                      className="primary-button"
                      disabled={Boolean(settingsActionRunning) || agentBridgeSwitchBusy}
                      onClick={() => void saveAgentBridgeSettings()}
                      type="button"
                    >
                      <Save size={16} /> {settingsActionRunning === 'save-agent-settings' ? t('working') : t('saveAgentBridgeSettings')}
                    </button>
                  </div>
                  {actionFeedbackMap['save-agent-settings'] ? <div className={`sync-action-feedback ${actionFeedbackMap['save-agent-settings'].kind}`}>{actionFeedbackMap['save-agent-settings'].message}</div> : null}

                  <div className="form-grid">
                    <label className="agent-toggle-field">
                      <span>{t('fieldAgentBridgeAutoExecute')}</span>
                      <input
                        checked={draftSettings.agentBridge.autoExecute}
                        type="checkbox"
                        onChange={(event) =>
                          updateDraftSettings((current) => ({
                            ...current,
                            agentBridge: { ...current.agentBridge, autoExecute: event.target.checked },
                          }))
                        }
                      />
                      <strong>{draftSettings.agentBridge.autoExecute ? t('enabled') : t('disabled')}</strong>
                    </label>
                    <label>
                      <span>{t('fieldAgentBridgeTimeout')}</span>
                      <input
                        min={1}
                        max={3600}
                        type="number"
                        value={draftSettings.agentBridge.defaultTimeoutSec}
                        onChange={(event) =>
                          updateDraftSettings((current) => ({
                            ...current,
                            agentBridge: { ...current.agentBridge, defaultTimeoutSec: Number(event.target.value) || 60 },
                          }))
                        }
                      />
                    </label>
                    <label>
                      <span>{t('fieldAgentBridgeMaxOutput')}</span>
                      <input
                        min={1024}
                        type="number"
                        value={draftSettings.agentBridge.maxOutputBytes}
                        onChange={(event) =>
                          updateDraftSettings((current) => ({
                            ...current,
                            agentBridge: { ...current.agentBridge, maxOutputBytes: Number(event.target.value) || 200000 },
                          }))
                        }
                      />
                    </label>
                  </div>

                  {!draftSettings.agentBridge.autoExecute ? (
                    <div className="agent-auto-connections-panel">
                      <div>
                        <h4>{t('agentBridgeAutoConnections')}</h4>
                        <p>{t('agentBridgeAutoConnectionsDesc')}</p>
                      </div>
                      <div className="agent-connection-list">
                        {connections.length ? (
                          <AgentAutoConnectionTree
                            allowedConnectionIds={draftSettings.agentBridge.allowedConnectionIds}
                            nodes={agentAutoGroups}
                            ungroupedConnections={agentAutoUngroupedConnections}
                            ungroupedLabel={t('ungroupedConnections')}
                            onToggleConnection={toggleAgentAutoConnection}
                          />
                        ) : (
                          <div className="empty-state">{t('connectionManagerEmpty')}</div>
                        )}
                      </div>
                    </div>
                  ) : null}
                </section>

                <section className="settings-section-block">
                  <div className="section-row">
                    <div>
                      <h3>{t('agentBridgeUsageTitle')}</h3>
                      <p>{t('agentBridgeUsageDesc')}</p>
                    </div>
                    <button className="secondary-button" onClick={() => void copyAgentMcpConfig()} type="button">
                      <Copy size={16} /> {t('copyAgentBridgeConfig')}
                    </button>
                  </div>
                  {actionFeedbackMap['copy-agent-config'] ? <div className={`sync-action-feedback ${actionFeedbackMap['copy-agent-config'].kind}`}>{actionFeedbackMap['copy-agent-config'].message}</div> : null}
                  <div className="agent-bridge-code-grid">
                    <label className="span-2">
                      <span>{t('agentBridgeMcpConfig')}</span>
                      <textarea readOnly rows={9} spellCheck={false} value={buildAgentMcpConfig(agentBridgeStatus?.discoveryPath)} />
                    </label>
                  </div>
                </section>
              </div>
            ) : null}

            {activeTab === 'about' ? (
              <div className="stack gap-16">
                <section className="settings-section-block settings-about-section">
                  <div className="section-row">
                    <div>
                      <h3>{t('aboutTitle')}</h3>
                    </div>
                    {/* 关于页仓库入口固定指向当前 GitHub 仓库，仓库重命名后需要同步更新。 */}
                    <button
                      className="secondary-button"
                      onClick={() => openExternalLink('https://github.com/CrazyFigure/MyTerminal')}
                      type="button"
                    >
                      <ExternalLink size={16} /> {t('githubRepository')}
                    </button>
                  </div>

                  <div className="settings-about-grid">
                    <span>{t('currentVersion')}</span>
                    <strong>{updateCheckResult?.currentVersion ?? appVersion}</strong>
                    <span>{t('latestVersion')}</span>
                    <strong>{updateCheckResult?.latestVersion ?? t('metricUnavailable')}</strong>
                    <span>{t('releasePublishedAt')}</span>
                    <strong>{formatReleaseTime(updateCheckResult?.publishedAt)}</strong>
                  </div>

                  <div className="section-row compact settings-update-actions">
                    <button className="primary-button" disabled={updateChecking} onClick={() => void handleCheckForUpdates()} type="button">
                      <RefreshCw size={16} /> {updateChecking ? t('working') : t('checkUpdates')}
                    </button>
                    <button
                      className="secondary-button"
                      disabled={
                        updateInstalling ||
                        !updateCheckResult?.updateAvailable ||
                        !updateCheckResult.installerDownloadUrl ||
                        !updateCheckResult.installerAssetName
                      }
                      onClick={() => void handleInstallUpdate()}
                      type="button"
                    >
                      <Download size={16} /> {updateInstalling ? t('working') : t('downloadAndInstallUpdate')}
                    </button>
                  </div>

                  {updateCheckResult ? (
                    <div className={`update-check-result ${updateCheckResult.updateAvailable ? 'is-update-available' : 'is-up-to-date'}`}>
                      {updateCheckResult.updateAvailable
                        ? t('statusUpdateAvailable', { version: updateCheckResult.latestVersion })
                        : t('statusUpdateNotAvailable')}
                    </div>
                  ) : null}
                  {updateFeedback ? (
                    <div className={`update-check-result ${updateFeedback.kind === 'is-success' ? 'is-success' : 'is-error'}`}>
                      {updateFeedback.message}
                    </div>
                  ) : null}
                </section>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <BackupSelectorModal
        open={backupSelectorOpen}
        backups={backupList}
        onSelect={(filename) => {
          setBackupSelectorOpen(false);
          const dir = draftSettings.webdav.remotePath.replace(/\/+$/, '');
          backupSelectorResolveRef.current?.(dir + '/' + filename);
          backupSelectorResolveRef.current = null;
        }}
        onDelete={(filename) => {
          setBackupList((prev) => prev.filter((f) => f !== filename));
        }}
        onClose={() => {
          setBackupSelectorOpen(false);
          backupSelectorResolveRef.current?.(null);
          backupSelectorResolveRef.current = null;
        }}
        t={t}
      />
    </div>
  );
}

export default function App() {
  const [sidebarWidth, setSidebarWidth] = useState(330);
  const [runtimePanelHeight, setRuntimePanelHeight] = useState(() => {
    if (typeof window === 'undefined') {
      return 220;
    }
    // 左侧默认给运行状态约 1/3 高度，文件管理保持约 2/3，CPU 展开时不至于被文件区挤掉。
    return clamp(Math.round(window.innerHeight * 0.3), 190, 300);
  });
  const [bottomHeight, setBottomHeight] = useState(180);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('appearance');
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [localTerminalsOpen, setLocalTerminalsOpen] = useState(false);
  const [globalBottomTab, setGlobalBottomTab] = useState<BottomPanelTab>('commands');
  const [bottomTabByConnection, setBottomTabByConnection] = useState<Record<string, BottomPanelTab>>({});
  // AI 执行右侧栏宽度独立于左侧栏，避免 MCP 审批展开时影响用户已经调整好的主机列表宽度。
  const [agentSidebarWidth, setAgentSidebarWidth] = useState(360);
  // AI 执行默认收起，只有用户点击或 MCP 新请求到达时才占用主窗口右侧空间。
  const [agentSidebarCollapsed, setAgentSidebarCollapsed] = useState(true);
  const [pathInput, setPathInput] = useState('~');
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenuState | null>(null);
  const [sessionContextMenu, setSessionContextMenu] = useState<SessionContextMenuState | null>(null);
  const [sessionTabDragState, setSessionTabDragState] = useState<SessionTabDragState>(null);
  const [sessionTabDropTarget, setSessionTabDropTarget] = useState<SessionTabDropTarget>(null);
  const [selectedFilePath, setSelectedFilePath] = useState('');
  const [selectedFilePaths, setSelectedFilePaths] = useState<string[]>([]);
  const [localFileDropActive, setLocalFileDropActive] = useState(false);
  const [remoteDownloadDragPaths, setRemoteDownloadDragPaths] = useState<string[]>([]);
  const [cpuCoresExpanded, setCpuCoresExpanded] = useState(false);
  const [bottomDockCollapsed, setBottomDockCollapsed] = useState(false);
  const [transferProgressItems, setTransferProgressItems] = useState<TransferProgressItem[]>([]);
  const [agentBridgeRequests, setAgentBridgeRequests] = useState<AgentBridgeRequest[]>([]);
  const [agentCommandEdits, setAgentCommandEdits] = useState<Record<string, string>>({});
  const [agentExpandedRequestIds, setAgentExpandedRequestIds] = useState<Record<string, boolean>>({});
  const [explorerColumnWidths, setExplorerColumnWidths] = useState(explorerDefaultColumnWidths);
  const pathByConnectionRef = useRef<Record<string, string>>({});
  const runtimeRefreshInFlightRef = useRef(false);
  const sessionTabDragStateRef = useRef<SessionTabDragState>(null);
  const sessionTabDropTargetRef = useRef<SessionTabDropTarget>(null);
  const sessionTabListRef = useRef<HTMLDivElement | null>(null);
  const explorerListRef = useRef<HTMLDivElement | null>(null);
  const bottomPanelActionsRef = useRef<HTMLDivElement | null>(null);
  const explorerScrollRafRef = useRef<number | null>(null);
  const explorerPanelRef = useRef<HTMLElement | null>(null);
  const agentKnownRequestIdsRef = useRef<Set<string>>(new Set());
  // 右侧 AI 执行栏新请求追加在底部，记录滚动容器用于新请求到达后自动露出最新卡片。
  const agentSidebarBodyRef = useRef<HTMLDivElement | null>(null);
  // 上一轮审批状态用于识别 pending -> running/completed/rejected/error，保证执行后自动折叠一次。
  const agentRequestStatusRef = useRef<Record<string, string>>({});
  const [explorerViewport, setExplorerViewport] = useState({ height: 0, scrollTop: 0 });

  const {
    activeConnectionId,
    activeSessionId,
    bootstrapped,
    bootstrap,
    closeSession,
    closeTunnel,
    commandBuffers,
    connections,
    currentRemotePath,
    deleteRemotePaths,
    downloadRemotePaths,
    editTunnel,
    files,
    history,
    openConnectionForm,
    openSession,
    openRemoteFile,
    openTunnel,
    pollTerminalOutputs,
    refreshFiles,
    refreshRemoteHistory,
    refreshRuntimeOverview,
    reconnectSession: reconnectSessionById,
    renameRemotePath,
    reorderSessions,
    runtimeOverview,
    selectSession,
    sendCommand,
    sendTerminalData,
    sessions,
    setCommandBuffer,
    setStatusMessage,
    settings,
    startAllTunnels,
    startTunnel,
    stopAllTunnels,
    tunnels,
    uploadLocalFiles,
    uploadLocalPaths,
  } = useAppStore();

  const t = useCallback((key: TranslationKey, replacements?: Record<string, string | number>) =>
    translate(settings.uiLanguage, key, replacements), [settings.uiLanguage]);

  const activeSession = useMemo(() => sessions.find((item) => item.id === activeSessionId), [activeSessionId, sessions]);
  // 远端文件、运行状态和历史都必须绑定到已经打开的终端会话，避免仅选中连接时提前拉取远端数据。
  const hasActiveRemoteSession = isUsableRemoteSession(activeSession);
  const activeRemoteConnectionId = hasActiveRemoteSession ? activeSession?.connectionId : undefined;
  const activeRemoteConnection = useMemo(
    () => connections.find((item) => item.id === activeRemoteConnectionId),
    [activeRemoteConnectionId, connections],
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const clampExpandedSidebars = () => {
      // 窗口变化或双侧栏同时展开时，只压缩超出预算的侧栏宽度，保留用户已经调小的宽度选择。
      setSidebarWidth((current) => {
        if (sidebarCollapsed) {
          return current;
        }
        return clamp(current, sidePanelMinWidth, resolveSidePanelMaxWidth(!agentSidebarCollapsed, agentSidebarWidth));
      });
      setAgentSidebarWidth((current) => {
        if (agentSidebarCollapsed) {
          return current;
        }
        return clamp(current, sidePanelMinWidth, resolveSidePanelMaxWidth(!sidebarCollapsed, sidebarWidth));
      });
    };

    clampExpandedSidebars();
    window.addEventListener('resize', clampExpandedSidebars);
    return () => window.removeEventListener('resize', clampExpandedSidebars);
  }, [agentSidebarCollapsed, agentSidebarWidth, sidebarCollapsed, sidebarWidth]);

  const openAgentRequestPanel = useCallback(async (focusWindow = false) => {
    // MCP 审批入口已经迁到右侧栏，新请求只展开右栏，不再改动底部命令/隧道/历史的当前 tab。
    setAgentSidebarCollapsed(false);

    if (!isTauriRuntime()) {
      return;
    }

    try {
      const { getCurrentWindow, UserAttentionType } = await import('@tauri-apps/api/window');
      const currentWindow = getCurrentWindow();
      await currentWindow.show();
      await currentWindow.unminimize();
      if (focusWindow) {
        await currentWindow.setFocus();
      } else {
        // 未点击通知时只闪烁任务栏，避免外部 agent 请求突然打断用户当前窗口焦点。
        await currentWindow.requestUserAttention(UserAttentionType.Informational).catch(() => undefined);
      }
    } catch {
      // Web 预览或系统拒绝聚焦时不影响审批列表本身展示。
    }
  }, []);

  const showAgentRequestNotification = useCallback(async (request: AgentBridgeRequest) => {
    if (typeof window === 'undefined') {
      return;
    }

    const machine = getAgentRequestMachineLabel(request, connections);
    const summary = getAgentRequestSummary(request);
    const body = t('agentRequestNotificationBody', { machine, summary });

    try {
      if (isTauriRuntime()) {
        const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification');
        let permissionGranted = await isPermissionGranted();
        if (!permissionGranted) {
          permissionGranted = (await requestPermission()) === 'granted';
        }
        if (!permissionGranted) {
          return;
        }

        try {
          await backend.showAgentBridgeNotification({
            requestId: request.id,
            title: t('agentRequestNotificationTitle'),
            body,
            approveLabel: t('approveAgentRequest'),
            rejectLabel: t('rejectAgentRequest'),
          });
          return;
        } catch {
          // 带动作 toast 不可用时退回普通系统通知；右侧栏已经自动展开，审批入口不会丢失。
        }

        if ('Notification' in window) {
          new window.Notification(t('agentRequestNotificationTitle'), {
            body,
          });
        }
        return;
      }

      if (!('Notification' in window)) {
        return;
      }
      let permissionGranted = window.Notification.permission === 'granted';
      if (!permissionGranted && window.Notification.permission !== 'denied') {
        permissionGranted = (await window.Notification.requestPermission()) === 'granted';
      }
      if (!permissionGranted) {
        return;
      }

      const notification = new window.Notification(t('agentRequestNotificationTitle'), {
        body,
        data: { source: 'agent-bridge', requestId: request.id },
        tag: `${agentBridgeNotificationTagPrefix}-${request.id}`,
      });
      notification.onclick = () => {
        notification.close();
        void openAgentRequestPanel(true);
      };
    } catch {
      // 通知权限、系统策略或 WebView 实现差异都不能阻塞 GUI 审批入口自动展开。
    }
  }, [connections, openAgentRequestPanel, t]);

  const refreshAgentBridgeRequests = useCallback(async () => {
    try {
      const requests = await backend.listAgentBridgeRequests();
      const previousRequestStatuses = agentRequestStatusRef.current;
      const pendingNewRequests = requests.filter((request) =>
        request.status === 'pending' && !agentKnownRequestIdsRef.current.has(request.id),
      );
      agentKnownRequestIdsRef.current = new Set(requests.map((request) => request.id));
      setAgentBridgeRequests(requests);
      setAgentCommandEdits((current) => {
        const activeIds = new Set(requests.map((request) => request.id));
        const next: Record<string, string> = {};
        Object.entries(current).forEach(([requestId, value]) => {
          if (activeIds.has(requestId)) {
            next[requestId] = value;
          }
        });
        requests.forEach((request) => {
          if (request.kind === 'run_command' && request.command && next[request.id] === undefined) {
            next[request.id] = request.command;
          }
        });
        return next;
      });
      setAgentExpandedRequestIds((current) => {
        const activeIds = new Set(requests.map((request) => request.id));
        const next: Record<string, boolean> = {};
        Object.entries(current).forEach(([requestId, value]) => {
          if (activeIds.has(requestId)) {
            next[requestId] = value;
          }
        });
        requests.forEach((request) => {
          if (previousRequestStatuses[request.id] === 'pending' && request.status !== 'pending') {
            next[request.id] = false;
          }
        });
        return next;
      });
      agentRequestStatusRef.current = Object.fromEntries(requests.map((request) => [request.id, request.status]));
      if (pendingNewRequests.length) {
        void openAgentRequestPanel(false);
        void showAgentRequestNotification(pendingNewRequests[0]);
      }
    } catch {
      setAgentBridgeRequests([]);
      agentRequestStatusRef.current = {};
    }
  }, [openAgentRequestPanel, showAgentRequestNotification]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return undefined;
    }

    let unlistenFn: (() => void) | undefined;
    let isMounted = true;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<{ requestId?: string; actionId?: string }>('agent-bridge-notification-action', (event) => {
        const actionId = event.payload.actionId;
        const requestId = event.payload.requestId;
        if (!requestId) {
          void openAgentRequestPanel(true);
          return;
        }

        if (actionId === agentBridgeNotificationApproveActionId) {
          void backend.approveAgentBridgeRequest(requestId).then(() => {
            void refreshAgentBridgeRequests();
          }).catch((error) => {
            setStatusMessage(error instanceof Error ? error.message : String(error));
          });
          return;
        }

        if (actionId === agentBridgeNotificationRejectActionId) {
          void backend.rejectAgentBridgeRequest(requestId, 'rejected from notification').then(() => {
            void refreshAgentBridgeRequests();
          }).catch((error) => {
            setStatusMessage(error instanceof Error ? error.message : String(error));
          });
          return;
        }

        void openAgentRequestPanel(true);
      }),
    ).then((unlisten) => {
      if (isMounted) {
        unlistenFn = unlisten;
      } else {
        unlisten();
      }
    }).catch(() => {
      // 自定义通知动作事件不可用时，右侧栏自动展开和普通按钮审批仍可使用。
    });

    return () => {
      isMounted = false;
      unlistenFn?.();
    };
  }, [openAgentRequestPanel, refreshAgentBridgeRequests, setStatusMessage]);

  const dismissTransferProgress = useCallback((id: string) => {
    setTransferProgressItems((current) => current.filter((item) => item.id !== id));
  }, []);
  const runTransferProgress = useCallback(async (title: string, task: (setPercent: (percent: number) => void) => Promise<void>) => {
    const id = crypto.randomUUID();
    const setPercent = (percent: number) => {
      setTransferProgressItems((current) =>
        current.map((item) => (item.id === id ? { ...item, percent: clamp(percent, 0, 100) } : item)),
      );
    };

    setTransferProgressItems((current) => [
      { id, title, percent: 8, status: 'running' },
      ...current.slice(0, 3),
    ]);
    try {
      // 当前任务只在关键阶段更新百分比，避免传输过程中高频 setState 影响终端输入流畅度。
      await task(setPercent);
      setTransferProgressItems((current) =>
        current.map((item) => (item.id === id ? { ...item, percent: 100, status: 'success', message: t('saved') } : item)),
      );
      window.setTimeout(() => dismissTransferProgress(id), 3000);
    } catch (error) {
      setTransferProgressItems((current) =>
        current.map((item) => (
          item.id === id
            ? { ...item, percent: 100, status: 'error', message: error instanceof Error ? error.message : String(error) }
            : item
        )),
      );
    }
  }, [dismissTransferProgress, t]);

  const refreshRuntimeOverviewOnce = useCallback(() => {
    if (!runtimeRefreshInFlightRef.current) {
      runtimeRefreshInFlightRef.current = true;
      void refreshRuntimeOverview().finally(() => {
        runtimeRefreshInFlightRef.current = false;
      });
    }
  }, [refreshRuntimeOverview]);

  useEffect(() => {
    if (!bootstrapped) {
      void bootstrap();
    }
  }, [bootstrap, bootstrapped]);

  // 主题切换时同步 Tauri 窗口主题和 document 颜色方案，确保标题栏、表单控件立即跟随。
  useEffect(() => {
    const isDark = settings.themeMode === 'dark';
    document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
    document.body.classList.toggle('theme-dark', isDark);
    if (isTauriRuntime()) {
      void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
        const currentWindow = getCurrentWindow();
        void currentWindow.setTheme(isDark ? 'dark' : 'light');
      }).catch(() => undefined);
    }
  }, [settings.themeMode]);

  useEffect(() => {
    const disableContextMenu = (event: MouseEvent) => event.preventDefault();
    window.addEventListener('contextmenu', disableContextMenu);
    return () => window.removeEventListener('contextmenu', disableContextMenu);
  }, []);

  useEffect(() => {
    const closeContextMenu = () => {
      setFileContextMenu(null);
      setSessionContextMenu(null);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFileContextMenu(null);
        setSessionContextMenu(null);
      }
    };

    window.addEventListener('click', closeContextMenu);
    window.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('click', closeContextMenu);
      window.removeEventListener('keydown', onEscape);
    };
  }, []);

  useEffect(() => {
    if (!sessions.length) {
      return;
    }

    // 后端 shell 线程在读到数据后通过 Tauri 事件推送通知；事件携带 sessionId，前端只拉取对应会话输出。
    let outputPollInFlight = false;
    // dirty 标记：poll 进行中收到的事件不会丢失；多个会话同时变脏时降级为全量拉取。
    let outputDirty = false;
    let dirtyAllSessions = false;
    let dirtySessionId: string | undefined;
    const markDirtySession = (sessionId?: string) => {
      if (!sessionId || dirtyAllSessions) {
        dirtyAllSessions = true;
        dirtySessionId = undefined;
        return;
      }
      if (dirtySessionId && dirtySessionId !== sessionId) {
        dirtyAllSessions = true;
        dirtySessionId = undefined;
        return;
      }
      dirtySessionId = sessionId;
    };
    const pollOutputs = (sessionId?: string) => {
      if (outputPollInFlight) {
        outputDirty = true;
        markDirtySession(sessionId);
        return;
      }

      outputPollInFlight = true;
      outputDirty = false;
      dirtyAllSessions = false;
      dirtySessionId = undefined;
      void pollTerminalOutputs(sessionId).finally(() => {
        outputPollInFlight = false;
        // poll 期间有新事件到达，立即再拉一次
        if (outputDirty) {
          pollOutputs(dirtyAllSessions ? undefined : dirtySessionId);
        }
      });
    };

    pollOutputs();

    // Tauri 事件驱动：后端每次 queue_output 后会 emit "terminal-output-ready"，payload 为 sessionId。
    let unlistenFn: (() => void) | undefined;
    let isMounted = true;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<string>('terminal-output-ready', (event) => {
        pollOutputs(typeof event.payload === 'string' ? event.payload : undefined);
      }),
    ).then((unlisten) => {
      if (isMounted) {
        unlistenFn = unlisten;
      } else {
        unlisten();
      }
    }).catch(() => {
      // 非 Tauri 环境（Web 开发模式）下 fallback 到轮询
    });

    // 低频兜底定时器，仅用于处理事件丢失等极端场景，不再承担回显即时性职责。
    const fallbackTimer = window.setInterval(() => {
      pollOutputs();
    }, 2000);

    return () => {
      isMounted = false;
      window.clearInterval(fallbackTimer);
      unlistenFn?.();
    };
  }, [pollTerminalOutputs, sessions.length]);


  useEffect(() => {
    void refreshAgentBridgeRequests();

    if (!isTauriRuntime()) {
      const timer = window.setInterval(() => {
        void refreshAgentBridgeRequests();
      }, 1000);
      return () => window.clearInterval(timer);
    }

    let unlistenFn: (() => void) | undefined;
    let isMounted = true;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen('agent-bridge-requests-changed', () => {
        void refreshAgentBridgeRequests();
      }),
    ).then((unlisten) => {
      if (isMounted) {
        unlistenFn = unlisten;
      } else {
        unlisten();
      }
    }).catch(() => {
      // 事件监听失败时保留初次刷新结果；下一次界面操作仍会主动刷新请求列表。
    });

    return () => {
      isMounted = false;
      unlistenFn?.();
    };
  }, [refreshAgentBridgeRequests]);

  // 左上运行状态直接以主机 IP 作为标题，减少说明性文字占位，把空间留给终端和文件表格。
  const runtimeHostLabel = runtimeOverview?.host ?? activeRemoteConnection?.host ?? '--';
  const activeCommand = activeSessionId ? commandBuffers[activeSessionId] ?? '' : '';
  const activeBottomTab = activeRemoteConnectionId ? bottomTabByConnection[activeRemoteConnectionId] ?? globalBottomTab : globalBottomTab;
  const sessionContextSession = useMemo(
    () => sessions.find((session) => session.id === sessionContextMenu?.sessionId),
    [sessionContextMenu?.sessionId, sessions],
  );
  const closeSessionBatch = useCallback((sessionIds: string[]) => {
    setSessionContextMenu(null);
    // 批量关闭标签按顺序执行，避免 activeSessionId 在多个异步关闭之间来回跳。
    void (async () => {
      for (const sessionId of sessionIds) {
        await closeSession(sessionId);
      }
    })().catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    });
  }, [closeSession, setStatusMessage]);
  const reconnectSession = useCallback((session?: TerminalSession) => {
    if (!session) {
      return;
    }

    setSessionContextMenu(null);
    // 重连交给 store 在原标签位置替换会话，避免关闭后新标签被追加到最右侧。
    void reconnectSessionById(session.id).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    });
  }, [reconnectSessionById, setStatusMessage]);
  const approveAgentBridgeRequest = useCallback((request: AgentBridgeRequest) => {
    const editedCommand = request.kind === 'run_command' ? agentCommandEdits[request.id] : undefined;
    void backend.approveAgentBridgeRequest(request.id, editedCommand).then(() => {
      void refreshAgentBridgeRequests();
    }).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    });
  }, [agentCommandEdits, refreshAgentBridgeRequests, setStatusMessage]);
  const toggleAgentRequestExpanded = useCallback((request: AgentBridgeRequest) => {
    setAgentExpandedRequestIds((current) => {
      const defaultExpanded = request.status === 'pending';
      return { ...current, [request.id]: !(current[request.id] ?? defaultExpanded) };
    });
  }, []);
  const rejectAgentBridgeRequest = useCallback((request: AgentBridgeRequest) => {
    void backend.rejectAgentBridgeRequest(request.id, 'rejected by user').then(() => {
      void refreshAgentBridgeRequests();
    }).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    });
  }, [refreshAgentBridgeRequests, setStatusMessage]);
  const clearAgentBridgeRequests = useCallback(() => {
    void backend.clearAgentBridgeRequests().then(() => {
      void refreshAgentBridgeRequests();
    }).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    });
  }, [refreshAgentBridgeRequests, setStatusMessage]);
  const copySessionConnection = useCallback((session?: TerminalSession) => {
    if (!session) {
      return;
    }

    if (session.kind === 'local') {
      const text = `${session.title} ${session.cwd ?? ''}`.trim();
      setSessionContextMenu(null);
      void writeClipboardText(text).catch(() => undefined);
      setStatusMessage(t('statusLocalTerminalInfoCopied'));
      return;
    }

    const connection = connections.find((item) => item.id === session.connectionId);
    const text = connection
      ? `${connection.name} ${connection.username}@${connection.host}:${connection.port}`
      : session.title;
    setSessionContextMenu(null);
    // 复制连接信息只包含定位字段，不复制密码、私钥等敏感内容。
    void writeClipboardText(text).catch(() => undefined);
    setStatusMessage(t('statusConnectionInfoCopied'));
  }, [connections, setStatusMessage, t]);
  const connectionTunnels = useMemo(
    () => (activeConnectionId ? tunnels.filter((item) => item.connectionId === activeConnectionId) : []),
    [activeConnectionId, tunnels],
  );
  // 历史命令只属于已打开的远端会话；未连接时保持空列表，避免缓存历史被误认为当前会话内容。
  const connectionHistory = useMemo(
    () => activeRemoteConnectionId
      ? history.filter((item) => item.connectionId === activeRemoteConnectionId)
      : [],
    [activeRemoteConnectionId, history],
  );
  const shellClassName = [
    'app-shell',
    `theme-${settings.themeMode}`,
    settings.compactSidebar ? 'compact-sidebar' : '',
    sidebarCollapsed ? 'sidebar-collapsed' : '',
    agentSidebarCollapsed ? 'agent-sidebar-collapsed' : '',
  ]
    .filter(Boolean)
    .join(' ');
  useFlipListAnimation(sessionTabListRef, '[data-session-id]', [sessions.map((session) => session.id).join('|')]);

  const resolveSessionTabDropTarget = useCallback((event: PointerEvent, currentDrag: NonNullable<SessionTabDragState>): SessionTabDropTarget => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const targetSessionTab = target?.closest<HTMLElement>('[data-session-id]');
    const targetSessionId = targetSessionTab?.dataset.sessionId;

    // 顶部会话标签是横向列表，落点用左右半区判断；空白区域允许直接拖到末尾。
    if (targetSessionId === currentDrag.id) {
      return null;
    }
    if (targetSessionId) {
      return {
        sessionId: targetSessionId,
        placement: resolveInlineInsertPlacement(event, targetSessionTab),
      };
    }
    if (isPointInsideElement(event, sessionTabListRef.current)) {
      return { type: 'end' };
    }
    return null;
  }, []);

  const startSessionTabDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>, session: TerminalSession, label: string) => {
    if (event.button !== 0) {
      return;
    }
    if ((event.target as HTMLElement).closest('.session-tab-close')) {
      return;
    }

    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    // 会话标签拖拽只改变前端排序，不触碰后端 PTY，拖动过程中保持当前终端输入状态。
    setSessionContextMenu(null);
    setSessionTabDragState({
      id: session.id,
      label,
      originX: event.clientX,
      originY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
    });
  }, []);

  useEffect(() => {
    sessionTabDragStateRef.current = sessionTabDragState;
  }, [sessionTabDragState]);

  useEffect(() => {
    sessionTabDropTargetRef.current = sessionTabDropTarget;
  }, [sessionTabDropTarget]);

  useEffect(() => {
    if (!sessionTabDragState) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      setSessionTabDragState((current) => {
        if (!current) {
          return current;
        }

        const nextDropTarget = resolveSessionTabDropTarget(event, current);
        setSessionTabDropTarget((previous) => (
          JSON.stringify(previous) === JSON.stringify(nextDropTarget) ? previous : nextDropTarget
        ));
        return { ...current, currentX: event.clientX, currentY: event.clientY };
      });
    };

    const handlePointerUp = (event: PointerEvent) => {
      const currentDrag = sessionTabDragStateRef.current;
      if (!currentDrag) {
        setSessionTabDragState(null);
        setSessionTabDropTarget(null);
        return;
      }

      const movedDistance = Math.hypot(event.clientX - currentDrag.originX, event.clientY - currentDrag.originY);
      const finalDropTarget = sessionTabDropTargetRef.current ?? resolveSessionTabDropTarget(event, currentDrag);
      setSessionTabDragState(null);
      setSessionTabDropTarget(null);
      if (movedDistance < 6 || !finalDropTarget) {
        // 点击标签时也会先进入 pointer 拖拽流程；移动距离不足时按普通点击处理，避免拖拽监听吞掉 tab 切换。
        if (movedDistance < 6) {
          selectSession(currentDrag.id);
        }
        return;
      }

      const currentSessionIds = sessions.map((session) => session.id);
      if ('type' in finalDropTarget && finalDropTarget.type === 'end') {
        reorderSessions(moveItemToEnd(currentSessionIds, currentDrag.id));
        return;
      }
      if (!('type' in finalDropTarget)) {
        reorderSessions(moveItemToInsert(currentSessionIds, currentDrag.id, finalDropTarget.sessionId, finalDropTarget.placement));
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [Boolean(sessionTabDragState), reorderSessions, resolveSessionTabDropTarget, selectSession, sessions]);
  const explorerGridTemplate = useMemo(() => explorerColumnWidths.map((width) => `${width}px`).join(' '), [explorerColumnWidths]);
  const explorerGridMinWidth = useMemo(
    () => explorerColumnWidths.reduce((total, width) => total + width, 0) + 46,
    [explorerColumnWidths],
  );
  const explorerGridStyle = useMemo<CSSProperties>(
    () => ({ gridTemplateColumns: explorerGridTemplate, minWidth: explorerGridMinWidth }),
    [explorerGridMinWidth, explorerGridTemplate],
  );
  const selectedFilePathSet = useMemo(() => new Set(selectedFilePaths), [selectedFilePaths]);
  const explorerVirtualRange = useMemo(() => {
    const total = files.length;
    if (!total) {
      return { start: 0, end: 0, entries: [] as Array<{ file: RemoteFileEntry; index: number }> };
    }

    const viewportHeight = explorerViewport.height || 360;
    const visibleCount = Math.ceil(viewportHeight / explorerRowHeight) + explorerOverscanRows * 2;
    const start = Math.max(0, Math.floor(explorerViewport.scrollTop / explorerRowHeight) - explorerOverscanRows);
    const end = Math.min(total, start + visibleCount);
    return {
      start,
      end,
      entries: files.slice(start, end).map((file, offset) => ({ file, index: start + offset })),
    };
  }, [explorerViewport.height, explorerViewport.scrollTop, files]);
  const updateExplorerViewport = useCallback(() => {
    const list = explorerListRef.current;
    if (!list) {
      return;
    }

    const nextViewport = { height: list.clientHeight, scrollTop: list.scrollTop };
    setExplorerViewport((current) => (
      current.height === nextViewport.height && current.scrollTop === nextViewport.scrollTop
        ? current
        : nextViewport
    ));
  }, []);
  const handleExplorerScroll = useCallback(() => {
    if (explorerScrollRafRef.current !== null) {
      return;
    }

    // 滚动事件可能一帧内触发多次，合并到下一帧再刷新可视行，避免 React 跟着滚轮高频重绘。
    explorerScrollRafRef.current = window.requestAnimationFrame(() => {
      explorerScrollRafRef.current = null;
      updateExplorerViewport();
    });
  }, [updateExplorerViewport]);
  useEffect(() => {
    updateExplorerViewport();
    const list = explorerListRef.current;
    if (!list || typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateExplorerViewport);
      return () => window.removeEventListener('resize', updateExplorerViewport);
    }

    const observer = new ResizeObserver(updateExplorerViewport);
    observer.observe(list);
    return () => observer.disconnect();
  }, [files.length, sidebarWidth, runtimePanelHeight, updateExplorerViewport]);
  useEffect(() => () => {
    if (explorerScrollRafRef.current !== null) {
      window.cancelAnimationFrame(explorerScrollRafRef.current);
    }
  }, []);
  const beginExplorerColumnResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>, columnIndex: number) => {
    const startWidth = explorerColumnWidths[columnIndex] ?? explorerDefaultColumnWidths[columnIndex] ?? 100;
    const limits = explorerColumnLimits[columnIndex] ?? { min: 60, max: 240 };

    // 文件列宽只影响当前界面状态，不写入配置，避免一次临时拉宽引发设置文件迁移。
    beginResize(event, (moveEvent, startX) => {
      const nextWidth = clamp(startWidth + moveEvent.clientX - startX, limits.min, limits.max);
      setExplorerColumnWidths((current) => current.map((width, index) => (index === columnIndex ? nextWidth : width)));
    });
  }, [explorerColumnWidths]);

  useEffect(() => {
    if (!activeRemoteConnectionId) {
      return;
    }

    // 只在切换连接或会话时恢复文件路径；终端内 cd 的目录变化由 cwd 元数据单独刷新，避免旧记忆路径覆盖真实 PWD。
    const rememberedPath = pathByConnectionRef.current[activeRemoteConnectionId];
    void refreshFiles(rememberedPath ?? activeSession?.cwd ?? '~');
    refreshRuntimeOverviewOnce();
  }, [activeRemoteConnectionId, activeSessionId, activeSession?.status, refreshFiles, refreshRuntimeOverviewOnce]);

  useEffect(() => {
    if (!activeRemoteConnectionId) {
      return;
    }

    pathByConnectionRef.current[activeRemoteConnectionId] = currentRemotePath;
  }, [activeRemoteConnectionId, currentRemotePath]);

  useEffect(() => {
    if (!activeRemoteConnectionId || activeBottomTab !== 'history') {
      return;
    }

    void refreshRemoteHistory(activeRemoteConnectionId);
  }, [activeBottomTab, activeRemoteConnectionId, refreshRemoteHistory]);

  useEffect(() => {
    // 没有打开远端会话时地址栏保持空白，避免刚启动软件就像已经浏览某个远端目录。
    setPathInput(hasActiveRemoteSession ? currentRemotePath || '~' : '');
  }, [currentRemotePath, hasActiveRemoteSession]);

  useEffect(() => {
    if (!activeRemoteConnectionId) {
      return;
    }

    // 运行状态会发起多条远端命令；自动刷新保持最低 5 秒间隔，避免拖慢终端输入、选区和文件列表滚动。
    const timer = window.setInterval(refreshRuntimeOverviewOnce, Math.max(5, settings.runtimeRefreshIntervalSec) * 1000);
    return () => window.clearInterval(timer);
  }, [activeRemoteConnectionId, refreshRuntimeOverviewOnce, settings.runtimeRefreshIntervalSec]);

  const runtimeItems = [
    { id: 'cpu', icon: Activity, label: t('metricCpu'), value: runtimeOverview?.cpu ?? t('metricUnavailable'), percent: parseMetricPercent(runtimeOverview?.cpu ?? '') },
    { id: 'memory', icon: MemoryStick, label: t('metricMemory'), value: runtimeOverview?.memory ?? t('metricUnavailable'), percent: parseMetricPercent(runtimeOverview?.memory ?? '') },
    { id: 'storage', icon: HardDrive, label: t('metricStorage'), value: runtimeOverview?.storage ?? t('metricUnavailable'), percent: parseMetricPercent(runtimeOverview?.storage ?? '') },
    { id: 'uptime', icon: RefreshCw, label: t('metricUptime'), value: runtimeOverview?.uptime ?? t('metricUnavailable'), percent: undefined },
  ];
  const selectExplorerFile = useCallback((file: RemoteFileEntry, event?: ReactMouseEvent<HTMLElement>) => {
    const filePath = file.path;
    if (event?.ctrlKey || event?.metaKey) {
      const nextPaths = selectedFilePathSet.has(filePath)
        ? selectedFilePaths.filter((path) => path !== filePath)
        : [...selectedFilePaths, filePath];
      setSelectedFilePath(nextPaths.at(-1) ?? '');
      setSelectedFilePaths(nextPaths);
      return;
    }

    if (event?.shiftKey && selectedFilePath) {
      const anchorIndex = files.findIndex((item) => item.path === selectedFilePath);
      const targetIndex = files.findIndex((item) => item.path === filePath);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const [startIndex, endIndex] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        // Shift 范围选择遵循当前列表顺序，方便批量删除连续文件，同时保留最后点击项作为键盘锚点。
        setSelectedFilePath(filePath);
        setSelectedFilePaths(files.slice(startIndex, endIndex + 1).map((item) => item.path));
        return;
      }
    }

    setSelectedFilePath(filePath);
    setSelectedFilePaths([filePath]);
  }, [files, selectedFilePath, selectedFilePathSet, selectedFilePaths]);
  const uploadFilesWithProgress = useCallback((uploadFiles: File[]) => {
    const filesToUpload = uploadFiles.filter((file) => file.name);
    if (!filesToUpload.length) {
      return;
    }

    const title = filesToUpload.length === 1
      ? `${t('upload')} ${filesToUpload[0].name}`
      : `${t('upload')} ${filesToUpload.length}`;
    void runTransferProgress(title, async (setPercent) => {
      setPercent(24);
      await uploadLocalFiles(filesToUpload);
      setPercent(92);
    });
  }, [runTransferProgress, t, uploadLocalFiles]);
  const uploadFolderWithProgress = useCallback((folderFiles: File[]) => {
    const uploadFiles = folderFiles.filter((file) => file.name);
    if (!uploadFiles.length) {
      return;
    }

    // 浏览器目录选择会把根目录名放在 webkitRelativePath 第一段；没有该字段时用数量兜底，避免进度标题为空。
    const firstRelativePath = (uploadFiles[0] as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
    const folderName = firstRelativePath.split('/').filter(Boolean)[0] ?? `${uploadFiles.length} ${t('fileLabel')}`;
    void runTransferProgress(`${t('uploadFolder')} ${folderName}`, async (setPercent) => {
      setPercent(18);
      await uploadLocalFiles(uploadFiles);
      setPercent(92);
    });
  }, [runTransferProgress, t, uploadLocalFiles]);
  const uploadLocalPathsWithProgress = useCallback((localPaths: string[]) => {
    const uploadPaths = Array.from(new Set(localPaths.map((path) => path.trim()).filter(Boolean)));
    if (!uploadPaths.length) {
      return;
    }

    const title = uploadPaths.length === 1
      ? `${t('upload')} ${uploadPaths[0].split(/[\\/]/).pop() ?? uploadPaths[0]}`
      : `${t('upload')} ${uploadPaths.length}`;
    void runTransferProgress(title, async (setPercent) => {
      setPercent(18);
      await uploadLocalPaths(uploadPaths);
      setPercent(92);
    });
  }, [runTransferProgress, t, uploadLocalPaths]);
  const selectDownloadDirectory = useCallback(async () => {
    // 下载文件和文件夹前必须让用户明确选择本地目录，避免内容静默落到默认下载目录里找不到。
    const selected = await openFileDialog({
      directory: true,
      multiple: false,
      title: t('selectDownloadDirectory'),
    });
    return Array.isArray(selected) ? selected[0] : selected ?? undefined;
  }, [t]);
  const downloadPathsWithProgress = useCallback((paths: string[]) => {
    const downloadPaths = Array.from(new Set(paths.filter(Boolean)));
    if (!downloadPaths.length) {
      return;
    }

    void (async () => {
      const localDir = await selectDownloadDirectory();
      if (!localDir) {
        return;
      }

      const title = downloadPaths.length === 1
        ? `${t('download')} ${downloadPaths[0].split('/').filter(Boolean).at(-1) ?? downloadPaths[0]}`
        : `${t('download')} ${downloadPaths.length}`;
      void runTransferProgress(title, async (setPercent) => {
        setPercent(22);
        await downloadRemotePaths(downloadPaths, localDir);
        setPercent(92);
      });
    })().catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    });
  }, [downloadRemotePaths, runTransferProgress, selectDownloadDirectory, setStatusMessage, t]);
  const downloadFileWithProgress = useCallback((path: string) => {
    downloadPathsWithProgress([path]);
  }, [downloadPathsWithProgress]);
  const isDragPositionInsideExplorer = useCallback((position: { x: number; y: number }) => {
    const rect = explorerPanelRef.current?.getBoundingClientRect();
    if (!rect) {
      return false;
    }

    const isInside = (clientX: number, clientY: number) =>
      clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    // 不同平台/缩放下 Tauri 拖放坐标可能表现为物理像素或 CSS 像素；两种坐标都接受，避免拖入文件区后松开无反应。
    const scale = window.devicePixelRatio || 1;
    return isInside(position.x, position.y) || isInside(position.x / scale, position.y / scale);
  }, []);
  const startRemoteDownloadDrag = useCallback((file: RemoteFileEntry, event: ReactDragEvent<HTMLElement>) => {
    const dragPaths = selectedFilePathSet.has(file.path) ? selectedFilePaths : [file.path];
    if (!selectedFilePathSet.has(file.path)) {
      setSelectedFilePath(file.path);
      setSelectedFilePaths([file.path]);
    }

    setRemoteDownloadDragPaths(dragPaths);
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', dragPaths.join('\n'));
  }, [selectedFilePathSet, selectedFilePaths]);
  const dropRemoteSelectionToDownload = useCallback((event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    const textPaths = event.dataTransfer
      .getData('text/plain')
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter(Boolean);
    const paths = remoteDownloadDragPaths.length ? remoteDownloadDragPaths : textPaths;
    setRemoteDownloadDragPaths([]);
    downloadPathsWithProgress(paths);
  }, [downloadPathsWithProgress, remoteDownloadDragPaths]);

  useEffect(() => {
    if (!hasActiveRemoteSession) {
      setLocalFileDropActive(false);
      return;
    }

    let unlisten: (() => void) | undefined;
    let isMounted = true;
    let dropInsideExplorer = false;
    const updateDropActive = (active: boolean) => {
      if (dropInsideExplorer === active) {
        return;
      }
      dropInsideExplorer = active;
      setLocalFileDropActive(active);
    };
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
      getCurrentWindow().onDragDropEvent((event) => {
        if (event.payload.type === 'enter') {
          updateDropActive(isDragPositionInsideExplorer(event.payload.position));
          return;
        }
        if (event.payload.type === 'over') {
          updateDropActive(isDragPositionInsideExplorer(event.payload.position));
          return;
        }
        if (event.payload.type === 'drop') {
          const shouldUpload = dropInsideExplorer || isDragPositionInsideExplorer(event.payload.position);
          updateDropActive(false);
          if (shouldUpload && event.payload.paths.length) {
            uploadLocalPathsWithProgress(event.payload.paths);
          }
          return;
        }
        updateDropActive(false);
      }),
    ).then((nextUnlisten) => {
      if (isMounted) {
        unlisten = nextUnlisten;
      } else {
        nextUnlisten();
      }
    }).catch(() => {
      // Web 预览环境没有 Tauri Webview 拖放 API，保留普通文件选择上传能力即可。
    });

    return () => {
      isMounted = false;
      unlisten?.();
    };
  }, [hasActiveRemoteSession, isDragPositionInsideExplorer, uploadLocalPathsWithProgress]);

  const openRemoteFileWithProgress = useCallback((path: string) => {
    const fileName = path.split('/').filter(Boolean).at(-1) ?? path;
    void runTransferProgress(`SFTP ${fileName}`, async (setPercent) => {
      setPercent(26);
      await openRemoteFile(path);
      setPercent(92);
    });
  }, [openRemoteFile, runTransferProgress]);
  const saveRemoteFileWithProgress = useCallback((path: string, saveTask: () => Promise<void>) => {
    const fileName = path.split('/').filter(Boolean).at(-1) ?? path;
    void runTransferProgress(`${t('saveToRemote')} ${fileName}`, async (setPercent) => {
      setPercent(28);
      await saveTask();
      setPercent(92);
    });
  }, [runTransferProgress, t]);
  const deleteSelectedRemotePaths = useCallback((paths: string[]) => {
    const normalizedPaths = Array.from(new Set(paths.filter(Boolean)));
    if (!normalizedPaths.length) {
      return;
    }

    const confirmText = normalizedPaths.length === 1
      ? t('deleteConfirm', { path: normalizedPaths[0] })
      : t('deleteMultipleConfirm', { count: normalizedPaths.length });
    if (!window.confirm(confirmText)) {
      return;
    }

    setFileContextMenu(null);
    void runTransferProgress(`${t('delete')} ${normalizedPaths.length}`, async (setPercent) => {
      setPercent(20);
      await deleteRemotePaths(normalizedPaths);
      setPercent(92);
      setSelectedFilePath('');
      setSelectedFilePaths([]);
    });
  }, [deleteRemotePaths, runTransferProgress, t]);
  const openRemoteFileEntry = useCallback((file: RemoteFileEntry) => {
    // 打开动作统一从文件条目入口走，保证单击选中、双击打开和回车打开使用同一套规则。
    setSelectedFilePath(file.path);
    setSelectedFilePaths([file.path]);
    if (file.isDir) {
      void refreshFiles(file.path);
      return;
    }
    if (isEditableFile(file.path)) {
      openRemoteFileWithProgress(file.path);
      return;
    }
    downloadFileWithProgress(file.path);
  }, [downloadFileWithProgress, openRemoteFileWithProgress, refreshFiles]);
  const handleExplorerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!hasActiveRemoteSession || !files.length) {
      return;
    }

    const selectedIndex = files.findIndex((file) => file.path === selectedFilePath);
    const moveSelection = (nextIndex: number) => {
      event.preventDefault();
      const nextPath = files[clamp(nextIndex, 0, files.length - 1)].path;
      setSelectedFilePath(nextPath);
      setSelectedFilePaths([nextPath]);
    };

    // 文件列表只接管导航键和回车键，不影响终端本体的输入体验。
    if (event.key === 'Delete' && selectedFilePaths.length) {
      event.preventDefault();
      deleteSelectedRemotePaths(selectedFilePaths);
      return;
    }
    if (event.key === 'ArrowDown') {
      moveSelection(selectedIndex < 0 ? 0 : selectedIndex + 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      moveSelection(selectedIndex < 0 ? files.length - 1 : selectedIndex - 1);
      return;
    }
    if (event.key === 'Home') {
      moveSelection(0);
      return;
    }
    if (event.key === 'End') {
      moveSelection(files.length - 1);
      return;
    }
    if (event.key === 'Enter' && selectedIndex >= 0) {
      event.preventDefault();
      openRemoteFileEntry(files[selectedIndex]);
    }
  }, [deleteSelectedRemotePaths, files, hasActiveRemoteSession, openRemoteFileEntry, selectedFilePath, selectedFilePaths]);

  useEffect(() => {
    // 目录刷新或断开连接后清理悬空选择，避免键盘上下键落到上一个目录的旧文件。
    const existingPaths = new Set(files.map((file) => file.path));
    if (!hasActiveRemoteSession || (selectedFilePath && !existingPaths.has(selectedFilePath))) {
      setSelectedFilePath('');
      setSelectedFilePaths([]);
      return;
    }
    setSelectedFilePaths((current) => current.filter((path) => existingPaths.has(path)));
  }, [files, hasActiveRemoteSession, selectedFilePath]);

  const orderedAgentBridgeRequests = useMemo(() => {
    // 右侧栏按消息流惯例从旧到新排列；后端仍保留 newest-first 队列，避免改变 MCP 等待逻辑。
    return agentBridgeRequests
      .map((request, index) => ({ request, index }))
      .sort((left, right) => {
        const leftTime = Date.parse(left.request.createdAt);
        const rightTime = Date.parse(right.request.createdAt);
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
          return leftTime - rightTime;
        }
        // createdAt 极端相同时，按后端原始 newest-first 下标反转，尽量维持真实入队先后。
        return right.index - left.index;
      })
      .map(({ request }) => request);
  }, [agentBridgeRequests]);
  const newestAgentRequestId = orderedAgentBridgeRequests.length
    ? orderedAgentBridgeRequests[orderedAgentBridgeRequests.length - 1].id
    : '';
  const bottomActionLabels = useMemo(() => {
    const labels = [bottomDockCollapsed ? t('expandBottomDock') : t('collapseBottomDock')];
    if (activeBottomTab === 'commands') {
      labels.push(t('sendToTerminal'));
    } else if (activeBottomTab === 'tunnels') {
      labels.push(t('tunnelStartAll'), t('tunnelStopAll'), t('newTunnel'));
    } else if (activeBottomTab === 'history') {
      labels.push(t('refresh'));
    }
    return labels;
  }, [activeBottomTab, bottomDockCollapsed, t]);
  const [bottomPanelActionsWidth, setBottomPanelActionsWidth] = useState(0);
  const bottomPanelNeedsCompactActions = useMemo(() => {
    if (!bottomPanelActionsWidth) {
      return false;
    }
    // 动作区宽度判断包含按钮 gap 和左侧分隔留白，只有自然横排明显放不下时才改为两行文字。
    const requiredWidth = bottomActionLabels.reduce((total, label) => total + estimateInlineButtonWidth(label), 0)
      + Math.max(0, bottomActionLabels.length - 1) * 6
      + 8;
    return requiredWidth > bottomPanelActionsWidth;
  }, [bottomActionLabels, bottomPanelActionsWidth]);

  useLayoutEffect(() => {
    if (agentSidebarCollapsed || !newestAgentRequestId) {
      return;
    }
    const sidebarBody = agentSidebarBodyRef.current;
    if (!sidebarBody) {
      return;
    }
    // 新请求显示在底部，侧栏展开时同步滚到底部，避免用户只看到旧审批卡片。
    sidebarBody.scrollTop = sidebarBody.scrollHeight;
  }, [agentSidebarCollapsed, newestAgentRequestId]);

  useLayoutEffect(() => {
    const actionsElement = bottomPanelActionsRef.current;
    if (!actionsElement) {
      return undefined;
    }

    const updateActionsWidth = () => setBottomPanelActionsWidth(actionsElement.clientWidth);
    updateActionsWidth();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateActionsWidth);
      return () => window.removeEventListener('resize', updateActionsWidth);
    }

    const resizeObserver = new ResizeObserver(updateActionsWidth);
    resizeObserver.observe(actionsElement);
    return () => resizeObserver.disconnect();
  }, [activeBottomTab, agentSidebarCollapsed, sidebarCollapsed]);

  const appShellStyle = {
    // 主窗口列结构由左右侧栏折叠状态驱动，保证右侧 AI 栏展开时不会挤乱左侧栏和终端主体的顺序。
    '--app-grid-columns': `${sidebarCollapsed ? '' : 'auto 4px '}minmax(0, 1fr)${agentSidebarCollapsed ? '' : ' 4px auto'}`,
    '--main-workspace-min-width': `${mainWorkspaceMinWidth}px`,
  } as CSSProperties;
  // AI 执行请求面板复用原底部 tab 的审批卡片，统一保持命令编辑、日志查看和审批按钮行为。
  const agentRequestPanel = (
    <div className="stack panel-stack agent-request-panel">
      {orderedAgentBridgeRequests.length ? (
        orderedAgentBridgeRequests.map((request) => {
          const isExpanded = agentExpandedRequestIds[request.id] ?? request.status === 'pending';
          const machineLabel = getAgentRequestMachineLabel(request, connections);
          const summaryLabel = getAgentRequestSummary(request);

          return (
            <div key={request.id} className={`agent-request-card status-${request.status} ${isExpanded ? 'is-expanded' : 'is-collapsed'}`}>
              <button
                aria-expanded={isExpanded}
                className="agent-request-header"
                onClick={() => toggleAgentRequestExpanded(request)}
                type="button"
              >
                {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                <span className="agent-request-title">
                  <strong>{request.kind}</strong>
                  <span>{request.title} · {new Date(request.createdAt).toLocaleString()}</span>
                </span>
                <span className={`status-badge status-${request.status}`}>{request.status}</span>
              </button>
              <div className="agent-request-summary">
                <span>{t('agentRequestMachine')}</span>
                <strong>{machineLabel}</strong>
                <span>{request.kind === 'run_command' ? t('agentRequestCommand') : t('agentRequestTarget')}</span>
                <strong>{summaryLabel}</strong>
              </div>
              {isExpanded ? (
                <>
                  {request.kind === 'run_command' ? (
                    <label>
                      <span>{t('agentRequestCommand')}</span>
                      <textarea
                        disabled={request.status !== 'pending'}
                        rows={3}
                        spellCheck={false}
                        value={agentCommandEdits[request.id] ?? request.command ?? ''}
                        onChange={(event) => setAgentCommandEdits((current) => ({ ...current, [request.id]: event.target.value }))}
                      />
                    </label>
                  ) : null}
                  {request.path ? (
                    <p className="agent-request-path">
                      {request.path}{request.newPath ? ` -> ${request.newPath}` : ''}
                    </p>
                  ) : null}
                  {request.contentPreview ? <pre className="agent-request-output">{request.contentPreview}</pre> : null}
                  {request.logs.length ? (
                    <div className="agent-request-logs">
                      {request.logs.map((line, index) => <span key={`${request.id}-log-${index}`}>{line}</span>)}
                    </div>
                  ) : null}
                  {request.error ? <div className="sync-action-feedback is-error">{request.error}</div> : null}
                  {request.result ? <pre className="agent-request-output">{JSON.stringify(request.result, null, 2)}</pre> : null}
                  {request.status === 'pending' ? (
                    <div className="section-row compact">
                      <button className="primary-button" onClick={() => approveAgentBridgeRequest(request)} type="button">
                        <Play size={16} /> {t('approveAgentRequest')}
                      </button>
                      <button className="secondary-button" onClick={() => rejectAgentBridgeRequest(request)} type="button">
                        <X size={16} /> {t('rejectAgentRequest')}
                      </button>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          );
        })
      ) : (
        <div className="empty-state">{t('agentBridgeRequestsEmpty')}</div>
      )}
    </div>
  );

  return (
    <div className={shellClassName} style={appShellStyle}>
      {!sidebarCollapsed ? (
      <aside className="sidebar card" style={{ minWidth: sidePanelMinWidth, width: sidebarWidth }}>
        <section className="sidebar-panel runtime-panel" style={{ height: runtimePanelHeight }}>
          <div className="section-row runtime-header">
            <h3>{runtimeHostLabel}</h3>
            <button className="icon-button" disabled={!hasActiveRemoteSession} onClick={refreshRuntimeOverviewOnce} type="button">
              <RefreshCw size={16} />
            </button>
          </div>

          <div className="runtime-list">
            {runtimeItems.map(({ id, icon: Icon, label, percent, value }) => (
              <div key={id} className="runtime-row-group">
                <button
                  className={`runtime-row metric-tone-${metricTone(percent)} ${id === 'cpu' && runtimeOverview?.cpuCores?.length ? 'is-clickable' : ''}`}
                  disabled={id !== 'cpu' || !runtimeOverview?.cpuCores?.length}
                  onClick={() => {
                    if (id === 'cpu' && runtimeOverview?.cpuCores?.length) {
                      setCpuCoresExpanded((current) => !current);
                    }
                  }}
                  type="button"
                >
                  <div className="metric-label">
                    <Icon size={14} />
                    <span>{label}</span>
                  </div>
                  <div className="metric-bar-cell">
                    {percent !== undefined ? (
                      <div className="metric-progress-track" aria-label={`${label} ${percent.toFixed(0)}%`}>
                        <span className="metric-progress-fill" style={{ width: `${percent}%` }} />
                      </div>
                    ) : null}
                    <span className="metric-value">{value}</span>
                  </div>
                </button>
                {id === 'cpu' && cpuCoresExpanded && runtimeOverview?.cpuCores?.length ? (
                  <div className="runtime-core-list">
                    {runtimeOverview.cpuCores.map((core) => {
                      const percentValue = clamp(core.percent, 0, 100);
                      return (
                        <div key={core.name} className={`runtime-core-row metric-tone-${metricTone(percentValue)}`}>
                          <span>{core.name}</span>
                          <div className="metric-bar-cell">
                            <div className="metric-progress-track" aria-label={`${core.name} ${percentValue.toFixed(0)}%`}>
                              <span className="metric-progress-fill" style={{ width: `${percentValue}%` }} />
                            </div>
                            <span className="metric-value">{percentValue.toFixed(0)}%</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <div className="runtime-extra">
            <span>{runtimeOverview?.os ?? '--'}</span>
          </div>
        </section>

        <div
          className="resize-handle resize-handle-sidebar-horizontal"
          onPointerDown={(event) => {
            const startHeight = runtimePanelHeight;
            beginResize(event, (moveEvent, _startX, startY) => {
              setRuntimePanelHeight(clamp(startHeight + (moveEvent.clientY - startY), 120, Math.min(window.innerHeight * 0.48, 380)));
            });
          }}
        />

        <section ref={explorerPanelRef} className={`sidebar-panel explorer-panel ${localFileDropActive ? 'is-local-drop-active' : ''}`}>
          <div className="explorer-toolbar">
            <div className="explorer-toolbar-actions">
              <label className="secondary-button slim file-upload-button" title={t('upload')}>
                <Upload size={14} />
                <input
                  className="hidden-file-input"
                  disabled={!hasActiveRemoteSession}
                  multiple
                  type="file"
                  onChange={(event) => {
                    uploadFilesWithProgress(Array.from(event.currentTarget.files ?? []));
                    event.currentTarget.value = '';
                  }}
                />
              </label>
              <label className="secondary-button slim file-upload-button" title={t('uploadFolder')}>
                <FolderTree size={14} />
                <input
                  {...{ directory: '', webkitdirectory: '' }}
                  className="hidden-file-input"
                  disabled={!hasActiveRemoteSession}
                  multiple
                  type="file"
                  onChange={(event) => {
                    const folderFiles = Array.from(event.currentTarget.files ?? []);
                    uploadFolderWithProgress(folderFiles);
                    event.currentTarget.value = '';
                  }}
                />
              </label>
              <button
                className={`secondary-button slim ${remoteDownloadDragPaths.length ? 'is-drop-target' : ''}`}
                disabled={!hasActiveRemoteSession}
                onClick={() => downloadPathsWithProgress(selectedFilePaths)}
                onDragOver={(event) => {
                  if (hasActiveRemoteSession) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'copy';
                  }
                }}
                onDrop={dropRemoteSelectionToDownload}
                title={remoteDownloadDragPaths.length ? t('dropToDownload') : t('download')}
                type="button"
              >
                <Download size={14} />
              </button>
              <span className="explorer-toolbar-spacer" />
              <button className="secondary-button slim" disabled={!hasActiveRemoteSession} onClick={() => void refreshFiles(parentPath(currentRemotePath))} type="button">
                {t('up')}
              </button>
              <button className="secondary-button slim" disabled={!hasActiveRemoteSession} onClick={() => void refreshFiles()} title={t('refresh')} type="button">
                <RefreshCw size={14} />
              </button>
            </div>
            <div className="address-bar">
              <input
                className="address-input"
                disabled={!hasActiveRemoteSession}
                placeholder={t('addressBarPlaceholder')}
                value={pathInput}
                onChange={(event) => setPathInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void refreshFiles(pathInput.trim() || '~');
                  }
                }}
              />
              <button className="secondary-button slim" disabled={!hasActiveRemoteSession} onClick={() => void refreshFiles(pathInput.trim() || '~')} type="button">
                {t('goToPath')}
              </button>
            </div>
          </div>

          <div className="explorer-shell explorer-shell-dense">
            <div
              ref={explorerListRef}
              className="explorer-list"
              onKeyDown={handleExplorerKeyDown}
              onScroll={handleExplorerScroll}
              tabIndex={hasActiveRemoteSession ? 0 : -1}
            >
              <div className="explorer-list-header" style={explorerGridStyle}>
                {[t('fieldName'), t('fieldSize'), t('fieldType'), t('fieldModifiedAt'), t('fieldPermission'), t('fieldOwnerGroup')].map((label, index, labels) => (
                  <span key={`${label}-${index}`} className="explorer-column-header">
                    <span>{label}</span>
                    {index < labels.length - 1 ? (
                      <button
                        aria-label={`${label} 调整列宽`}
                        className="explorer-column-resizer"
                        onPointerDown={(event) => beginExplorerColumnResize(event, index)}
                        title={`${label} 调整列宽`}
                        type="button"
                      />
                    ) : null}
                  </span>
                ))}
              </div>

              {files.length ? (
                <div
                  className="explorer-virtual-body"
                  style={{ height: files.length * explorerRowHeight, minWidth: explorerGridMinWidth }}
                >
                  {explorerVirtualRange.entries.map(({ file, index }) => {
                    const Icon = fileLabelIcon(file);
                    const isSelected = selectedFilePathSet.has(file.path);
                    return (
                      <div
                        key={file.path}
                        className={`explorer-row is-virtual ${index % 2 === 0 ? '' : 'is-odd'} ${isSelected ? 'is-selected' : ''}`}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          if (!selectedFilePathSet.has(file.path)) {
                            setSelectedFilePath(file.path);
                            setSelectedFilePaths([file.path]);
                          }
                          setFileContextMenu({ file, x: event.clientX, y: event.clientY });
                        }}
                        onDoubleClick={() => openRemoteFileEntry(file)}
                        style={{ height: explorerRowHeight, transform: `translateY(${index * explorerRowHeight}px)` }}
                      >
                        <button
                          className="explorer-row-main"
                          disabled={!hasActiveRemoteSession}
                          draggable={hasActiveRemoteSession}
                          onClick={(event) => selectExplorerFile(file, event)}
                          onDragEnd={() => setRemoteDownloadDragPaths([])}
                          onDragStart={(event) => startRemoteDownloadDrag(file, event)}
                          style={explorerGridStyle}
                          type="button"
                        >
                          <span className="explorer-name">
                            <Icon size={16} />
                            <strong>{file.name}</strong>
                          </span>
                          <span>{file.isDir ? '' : formatBytes(file.size)}</span>
                          <span>{formatFileType(file, t('directoryLabel'), t('symlinkLabel'), t('fileLabel'))}</span>
                          <span>{formatTimestamp(file.modifiedAt)}</span>
                          <span>{file.permissions ?? '--'}</span>
                          <span>{formatOwnerGroup(file)}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="empty-state">{t('remoteFilesEmpty')}</div>
              )}
            </div>
          </div>
        </section>
      </aside>
      ) : null}

      {fileContextMenu ? (
          <div className="context-menu file-context-menu" style={{ left: fileContextMenu.x, top: fileContextMenu.y }} onClick={(event) => event.stopPropagation()}>
            {selectedFilePathSet.has(fileContextMenu.file.path) && selectedFilePaths.length > 1 ? (
              <>
                <button className="context-menu-item" onClick={() => {
                  downloadPathsWithProgress(selectedFilePaths);
                  setFileContextMenu(null);
                }} type="button">
                  {t('fileMenuDownloadSelected')} ({selectedFilePaths.length})
                </button>
                <button className="context-menu-item danger" onClick={() => deleteSelectedRemotePaths(selectedFilePaths)} type="button">
                  {t('fileMenuDeleteSelected')} ({selectedFilePaths.length})
                </button>
              </>
            ) : null}
            {fileContextMenu.file.isDir ? (
              <button className="context-menu-item" onClick={() => {
                void refreshFiles(fileContextMenu.file.path);
                setFileContextMenu(null);
              }} type="button">{t('fileMenuOpen')}</button>
            ) : null}
            {!fileContextMenu.file.isDir && isEditableFile(fileContextMenu.file.path) ? (
              <button className="context-menu-item" onClick={() => {
                openRemoteFileWithProgress(fileContextMenu.file.path);
                setFileContextMenu(null);
              }} type="button">{t('fileMenuEdit')}</button>
            ) : null}
            <button className="context-menu-item" onClick={() => {
              downloadFileWithProgress(fileContextMenu.file.path);
              setFileContextMenu(null);
            }} type="button">{t('fileMenuDownload')}</button>
            <button className="context-menu-item" onClick={() => {
              const nextName = window.prompt(t('rename'), fileContextMenu.file.name);
              if (nextName) {
                void renameRemotePath(fileContextMenu.file.path, nextName);
              }
              setFileContextMenu(null);
            }} type="button">{t('fileMenuRename')}</button>
            <button className="context-menu-item danger" onClick={() => {
              const paths = selectedFilePathSet.has(fileContextMenu.file.path) ? selectedFilePaths : [fileContextMenu.file.path];
              deleteSelectedRemotePaths(paths);
            }} type="button">{t('fileMenuDelete')}</button>
          </div>
        ) : null}

      {sessionContextMenu && sessionContextSession ? (
        <div
          className="context-menu session-context-menu"
          style={{ left: sessionContextMenu.x, top: sessionContextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          {(() => {
            const sessionIndex = sessions.findIndex((session) => session.id === sessionContextSession.id);
            const leftSessionIds = sessions.slice(0, Math.max(0, sessionIndex)).map((session) => session.id);
            const rightSessionIds = sessions.slice(sessionIndex + 1).map((session) => session.id);
            const otherSessionIds = sessions.filter((session) => session.id !== sessionContextSession.id).map((session) => session.id);
            // 关闭全部需要包含当前右键标签，批量关闭函数会按当前标签顺序逐个释放后端会话。
            const allSessionIds = sessions.map((session) => session.id);
            return (
              <>
                <button className="context-menu-item" onClick={() => closeSessionBatch([sessionContextSession.id])} type="button">
                  <X size={14} /> {t('closeSessionAction')}
                </button>
                <button className="context-menu-item" disabled={!leftSessionIds.length} onClick={() => closeSessionBatch(leftSessionIds)} type="button">
                  <ChevronLeft size={14} /> {t('closeSessionsLeft')}
                </button>
                <button className="context-menu-item" disabled={!rightSessionIds.length} onClick={() => closeSessionBatch(rightSessionIds)} type="button">
                  <ChevronRight size={14} /> {t('closeSessionsRight')}
                </button>
                <button className="context-menu-item" disabled={!otherSessionIds.length} onClick={() => closeSessionBatch(otherSessionIds)} type="button">
                  <X size={14} /> {t('closeOtherSessions')}
                </button>
                <button className="context-menu-item" onClick={() => closeSessionBatch(allSessionIds)} type="button">
                  <Trash2 size={14} /> {t('closeAllSessions')}
                </button>
                <button className="context-menu-item" onClick={() => reconnectSession(sessionContextSession)} type="button">
                  <RotateCcw size={14} /> {t('reconnectSession')}
                </button>
                <button className="context-menu-item" onClick={() => copySessionConnection(sessionContextSession)} type="button">
                  <Copy size={14} /> {t('copyConnectionInfo')}
                </button>
              </>
            );
          })()}
        </div>
      ) : null}

      {!sidebarCollapsed ? (
        <div
          className="resize-handle resize-handle-main"
          onPointerDown={(event) => {
            const startWidth = sidebarWidth;
            beginResize(event, (moveEvent, startX) => {
              setSidebarWidth(clamp(
                startWidth + (moveEvent.clientX - startX),
                sidePanelMinWidth,
                resolveSidePanelMaxWidth(!agentSidebarCollapsed, agentSidebarWidth),
              ));
            });
          }}
        />
      ) : null}

      <main className="workspace">
        <section className="workspace-toolbar card">
          {/* 侧栏入口固定在终端工具栏首位，收起时不再保留残缺侧栏，给终端让出完整横向空间。 */}
          <button
            className="toolbar-sidebar-toggle icon-button"
            onClick={() => setSidebarCollapsed((current) => !current)}
            title={sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar')}
            type="button"
          >
            {sidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
          <div className="session-strip">
            <div
              className={`tab-list session-tab-list ${
                sessionTabDropTarget && 'type' in sessionTabDropTarget && sessionTabDropTarget.type === 'end' ? 'is-drop-end' : ''
              }`}
              ref={sessionTabListRef}
            >
              {sessions.map((session) => {
                const sessionLabel = session.kind === 'local'
                  ? formatLocalTerminalTabLabel(session, t('localTerminalTitle'))
                  : connections.find((item) => item.id === session.connectionId)?.name ?? session.title;
                return (
                  <div
                    key={session.id}
                    data-session-id={session.id}
                    className={`session-tab ${session.id === activeSessionId ? 'is-active' : ''} ${
                      sessionTabDragState?.id === session.id ? 'is-dragging' : ''
                    } ${
                      sessionTabDropTarget && !('type' in sessionTabDropTarget) && sessionTabDropTarget.sessionId === session.id
                        ? `is-drop-${sessionTabDropTarget.placement}`
                        : ''
                    }`}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setSessionContextMenu({ sessionId: session.id, x: event.clientX, y: event.clientY });
                    }}
                    onPointerDown={(event) => startSessionTabDrag(event, session, sessionLabel)}
                  >
                    <button className="session-tab-trigger" onClick={() => selectSession(session.id)} type="button">
                      <span aria-label={translateStatus(settings.uiLanguage, session.status)} className={sessionStatusClassName(session.status)} title={translateStatus(settings.uiLanguage, session.status)} />
                      <span>{sessionLabel}</span>
                    </button>
                    <button
                      aria-label={t('closeSessionAction')}
                      className="session-tab-close"
                      onClick={(event) => {
                        event.stopPropagation();
                        void closeSession(session.id);
                      }}
                      title={t('closeSessionAction')}
                      type="button"
                    >
                      <X size={10} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="workspace-toolbar-actions">
            <button className="secondary-button" onClick={() => setLocalTerminalsOpen(true)} type="button">
              <Laptop size={16} /> {renderActionButtonLabel(t('localTerminalTitle'))}
            </button>
            <button className="secondary-button" onClick={() => setConnectionsOpen(true)} type="button">
              <FolderTree size={16} /> {renderActionButtonLabel(t('manageConnections'))}
            </button>
            <button
              className="secondary-button"
              onClick={() => {
                setSettingsTab('appearance');
                setSettingsOpen(true);
              }}
              type="button"
            >
              <Settings size={16} /> {renderActionButtonLabel(t('openSettings'))}
            </button>
            <button
              aria-label={t('newConnection')}
              className="primary-button toolbar-icon-only"
              onClick={() => openConnectionForm()}
              title={t('newConnection')}
              type="button"
            >
              <Plus size={16} />
            </button>
            <button
              aria-label={agentSidebarCollapsed ? t('expandAgentSidebar') : t('collapseAgentSidebar')}
              className="toolbar-sidebar-toggle icon-button"
              onClick={() => setAgentSidebarCollapsed((current) => !current)}
              title={agentSidebarCollapsed ? t('expandAgentSidebar') : t('collapseAgentSidebar')}
              type="button"
            >
              {agentSidebarCollapsed ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
            </button>
          </div>
        </section>

        <div className={`terminal-area ${bottomDockCollapsed ? 'is-bottom-collapsed' : ''}`}>
          <TerminalWorkspace
            session={activeSession}
            settings={settings}
            onTerminalData={(data) => {
              if (!activeSessionId) {
                return;
              }
              void sendTerminalData(activeSessionId, data);
            }}
          />

          <div
            className="resize-handle resize-handle-horizontal"
            onPointerDown={(event) => {
              if (bottomDockCollapsed) {
                return;
              }
              const startHeight = bottomHeight;
              beginResize(event, (moveEvent, _startX, startY) => {
                setBottomHeight(clamp(startHeight + (startY - moveEvent.clientY), 180, Math.min(window.innerHeight * 0.58, 460)));
              });
            }}
          />

          <section className={`bottom-dock card ${bottomDockCollapsed ? 'is-collapsed' : ''}`} style={bottomDockCollapsed ? undefined : { height: bottomHeight }}>
            <header className="panel-tab-row">
              <div className="tab-list">
                {bottomTabs.map((tab) => {
                  const Icon = tab.icon;
                  return (
                    <button
                      key={tab.id}
                      className={`panel-tab ${activeBottomTab === tab.id ? 'is-active' : ''}`}
                      onClick={() => {
                        setGlobalBottomTab(tab.id);
                        if (activeRemoteConnectionId) {
                          setBottomTabByConnection((current) => ({ ...current, [activeRemoteConnectionId]: tab.id }));
                        }
                      }}
                      type="button"
                    >
                      <Icon size={16} />
                      <span>{t(tab.labelKey)}</span>
                    </button>
                  );
                })}
              </div>
              <div ref={bottomPanelActionsRef} className={`panel-tab-actions ${bottomPanelNeedsCompactActions ? 'is-compact-actions' : ''}`}>
                <button
                  className="secondary-button slim"
                  onClick={() => setBottomDockCollapsed((current) => !current)}
                  style={buildActionButtonStyle(bottomDockCollapsed ? t('expandBottomDock') : t('collapseBottomDock'), bottomPanelNeedsCompactActions)}
                  title={bottomDockCollapsed ? t('expandBottomDock') : t('collapseBottomDock')}
                  type="button"
                >
                  {bottomDockCollapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  {renderActionButtonLabel(bottomDockCollapsed ? t('expandBottomDock') : t('collapseBottomDock'), bottomPanelNeedsCompactActions)}
                </button>
                {activeBottomTab === 'commands' ? (
                  <button
                    className="primary-button"
                    disabled={!hasActiveRemoteSession || !activeCommand.trim()}
                    onClick={() => {
                      if (activeSessionId) {
                        void sendCommand(activeSessionId);
                      }
                    }}
                    style={buildActionButtonStyle(t('sendToTerminal'), bottomPanelNeedsCompactActions)}
                    type="button"
                  >
                    <Play size={16} /> {renderActionButtonLabel(t('sendToTerminal'), bottomPanelNeedsCompactActions)}
                  </button>
                ) : null}
                {activeBottomTab === 'tunnels' ? (
                  <>
                    <button
                      className="secondary-button"
                      disabled={!connectionTunnels.some((item) => item.status !== 'running')}
                      onClick={() => void startAllTunnels()}
                      style={buildActionButtonStyle(t('tunnelStartAll'), bottomPanelNeedsCompactActions)}
                      type="button"
                    >
                      <Play size={16} /> {renderActionButtonLabel(t('tunnelStartAll'), bottomPanelNeedsCompactActions)}
                    </button>
                    <button
                      className="secondary-button"
                      disabled={!connectionTunnels.some((item) => item.status === 'running')}
                      onClick={() => void stopAllTunnels()}
                      style={buildActionButtonStyle(t('tunnelStopAll'), bottomPanelNeedsCompactActions)}
                      type="button"
                    >
                      <Square size={16} /> {renderActionButtonLabel(t('tunnelStopAll'), bottomPanelNeedsCompactActions)}
                    </button>
                    <button
                      className="primary-button"
                      disabled={!activeConnectionId}
                      onClick={() => void openTunnel()}
                      style={buildActionButtonStyle(t('newTunnel'), bottomPanelNeedsCompactActions)}
                      type="button"
                    >
                      <Plus size={16} /> {renderActionButtonLabel(t('newTunnel'), bottomPanelNeedsCompactActions)}
                    </button>
                  </>
                ) : null}
                {activeBottomTab === 'history' ? (
                  <button
                    className="secondary-button slim"
                    disabled={!activeRemoteConnectionId}
                    onClick={() => {
                      if (activeRemoteConnectionId) {
                        void refreshRemoteHistory(activeRemoteConnectionId);
                      }
                    }}
                    style={buildActionButtonStyle(t('refresh'), bottomPanelNeedsCompactActions)}
                    type="button"
                  >
                    <RefreshCw size={14} /> {renderActionButtonLabel(t('refresh'), bottomPanelNeedsCompactActions)}
                  </button>
                ) : null}
              </div>
            </header>

            <div className="panel-body dock-body">
              {activeBottomTab === 'commands' ? (
                <div className="stack command-panel fill-height">
                  <textarea
                    className="command-editor"
                    disabled={!hasActiveRemoteSession}
                    placeholder={t('commandTextareaPlaceholder')}
                    rows={8}
                    spellCheck={false}
                    value={activeCommand}
                    onChange={(event) => {
                      if (!activeSessionId) {
                        return;
                      }
                      setCommandBuffer(activeSessionId, event.target.value);
                    }}
                  />

                </div>
              ) : null}

              {activeBottomTab === 'tunnels' ? (
                <div className="stack panel-stack">
                  <div className="tunnel-grid">
                    {connectionTunnels.length ? (
                      connectionTunnels.map((tunnel) => (
                        <div key={tunnel.id} className="tunnel-card">
                          <div>
                            <strong>{tunnel.name}</strong>
                            <p>
                              {tunnel.bindAddress}:{tunnel.localPort}{' -> '}
                              {tunnel.remoteHost}:{tunnel.remotePort}
                            </p>
                          </div>
                          <div className="section-row compact">
                            <span className={`status-badge status-${tunnel.status}`}>{translateStatus(settings.uiLanguage, tunnel.status)}</span>
                            {/* 编辑隧道只更新配置并停止旧监听，避免运行中改端点后后台仍占用旧端口。 */}
                            <button className="ghost-button slim" onClick={() => editTunnel(tunnel)} type="button">
                              <Pencil size={14} /> {t('edit')}
                            </button>
                            {tunnel.status === 'running' ? (
                              <button className="ghost-button slim" onClick={() => void closeTunnel(tunnel.id)} type="button">
                                <Square size={14} /> {t('stop')}
                              </button>
                            ) : (
                              <button className="ghost-button slim" onClick={() => void startTunnel(tunnel.id)} type="button">
                                <Play size={14} /> {t('start')}
                              </button>
                            )}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="empty-state">{t('noTunnels')}</div>
                    )}
                  </div>
                </div>
              ) : null}

              {activeBottomTab === 'history' ? (
                <div className="stack panel-stack">
                  <div className="history-list">
                    {connectionHistory.length ? (
                      connectionHistory.map((item) => (
                        <button
                          key={item.id}
                          className="history-row"
                          disabled={!activeSessionId}
                          onClick={() => {
                            if (!activeSessionId) {
                              return;
                            }
                            setCommandBuffer(activeSessionId, item.command);
                            if (activeRemoteConnectionId) {
                              setBottomTabByConnection((current) => ({ ...current, [activeRemoteConnectionId]: 'commands' }));
                            }
                          }}
                          type="button"
                        >
                          <strong>{item.command}</strong>
                          <span>{new Date(item.executedAt).toLocaleString()}</span>
                        </button>
                      ))
                    ) : (
                      <div className="empty-state">{t('noHistory')}</div>
                    )}
                  </div>
                </div>
              ) : null}

            </div>
          </section>
        </div>
      </main>

      {!agentSidebarCollapsed ? (
        <>
          <div
            className="resize-handle resize-handle-main resize-handle-agent-sidebar"
            onPointerDown={(event) => {
              const startWidth = agentSidebarWidth;
              beginResize(event, (moveEvent, startX) => {
                setAgentSidebarWidth(clamp(
                  startWidth + (startX - moveEvent.clientX),
                  sidePanelMinWidth,
                  resolveSidePanelMaxWidth(!sidebarCollapsed, sidebarWidth),
                ));
              });
            }}
          />
          <aside className="agent-sidebar card" style={{ minWidth: sidePanelMinWidth, width: agentSidebarWidth }}>
            <header className="agent-sidebar-header">
              <div className="panel-tab is-active agent-sidebar-title">
                <Bot size={16} />
                <span>{t('panelAgent')}</span>
              </div>
              <button className="secondary-button slim" onClick={() => clearAgentBridgeRequests()} type="button">
                <Trash2 size={14} /> {t('clearAgentBridgeRequests')}
              </button>
            </header>
            <div ref={agentSidebarBodyRef} className="agent-sidebar-body">
              {agentRequestPanel}
            </div>
          </aside>
        </>
      ) : null}

      <ConnectionManagerModal open={connectionsOpen} onClose={() => setConnectionsOpen(false)} />
      <LocalTerminalManagerModal open={localTerminalsOpen} onClose={() => setLocalTerminalsOpen(false)} />
      <SettingsModal open={settingsOpen} activeTab={settingsTab} onClose={() => setSettingsOpen(false)} onTabChange={setSettingsTab} />
      <EditorModal onSaveWithProgress={saveRemoteFileWithProgress} />
      <ConnectionFormModal />
      <TunnelFormModal />
      {transferProgressItems.length ? (
        <div className="transfer-progress-stack">
          {transferProgressItems.map((item) => (
            <div key={item.id} className={`transfer-progress-card is-${item.status}`}>
              <div className="section-row compact">
                <strong>{item.title}</strong>
                <button className="icon-button transfer-progress-close" onClick={() => dismissTransferProgress(item.id)} type="button">
                  <X size={12} />
                </button>
              </div>
              <div className="transfer-progress-track">
                <span className="transfer-progress-fill" style={{ width: `${item.percent}%` }} />
              </div>
              <span>{item.message ?? `${item.percent.toFixed(0)}%`}</span>
            </div>
          ))}
        </div>
      ) : null}
      {sessionTabDragState ? (
        <div
          className="drag-preview"
          style={{ left: sessionTabDragState.currentX + 10, top: sessionTabDragState.currentY + 10 }}
        >
          <TerminalSquare size={13} />
          <span>{sessionTabDragState.label}</span>
        </div>
      ) : null}
    </div>
  );
}

/* ── Backup Selector Modal ─────────────────────────────────────────────── */

interface BackupItem {
  filename: string;
  timestamp: string;
  type: 'bundle' | 'settings' | 'connections';
}

function BackupSelectorModal({
  open,
  backups,
  onSelect,
  onDelete,
  onClose,
  t,
}: {
  open: boolean;
  backups: string[];
  onSelect: (filename: string) => void;
  onDelete: (filename: string) => void;
  onClose: () => void;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
}) {
  const [deleting, setDeleting] = useState<string | null>(null);

  const parsed = useMemo<BackupItem[]>(() => {
    const items = backups.map((filename) => {
      let type: BackupItem['type'] = 'bundle';
      if (filename.startsWith('settings')) type = 'settings';
      else if (filename.startsWith('connections')) type = 'connections';

      // 从文件名提取时间戳: myterminal-config-20260611-160128.enc.json
      const match = filename.match(/(\d{8})-(\d{6})/);
      let timestamp = '-';
      let sortKey = '';
      if (match) {
        const [, date, time] = match;
        timestamp = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)} ${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4)}`;
        sortKey = date + time;
      }

      return { filename, timestamp, type, sortKey };
    });
    // 按时间戳倒序排列（最新的在前面）
    return items.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
  }, [backups]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card modal modal-backup-selector">
        <div className="modal-header">
          <h3>{t('selectBackupVersion')}</h3>
          <button className="icon-button" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </div>
        <div className="backup-table-shell">
          <div className="backup-table-header">
            <span className="backup-col-name">{t('fieldFilename')}</span>
            <span className="backup-col-time">{t('fieldTimestamp')}</span>
            <span className="backup-col-type">{t('backupType')}</span>
            <span className="backup-col-actions">{t('backupActions')}</span>
          </div>
          <div className="backup-table-body">
            {parsed.length === 0 ? (
              <div className="backup-empty">{t('noBackupsFound')}</div>
            ) : (
              parsed.map((item) => (
                <div key={item.filename} className="backup-table-row">
                  <span className="backup-col-name" title={item.filename}>{item.filename}</span>
                  <span className="backup-col-time">{item.timestamp}</span>
                  <span className="backup-col-type">
                    {item.type === 'bundle' ? t('typeBundle') : item.type === 'settings' ? t('typeSettings') : t('typeConnections')}
                  </span>
                  <div className="backup-col-actions">
                    <button
                      className="ghost-button slim backup-download-btn"
                      onClick={() => onSelect(item.filename)}
                      type="button"
                    >
                      <Download size={14} /> {t('actionDownload')}
                    </button>
                    <button
                      className="ghost-button slim danger-button"
                      disabled={deleting === item.filename}
                      onClick={() => {
                        setDeleting(item.filename);
                        onDelete(item.filename);
                      }}
                      type="button"
                    >
                      <Trash2 size={14} /> {t('actionDelete')}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose} type="button">
            {t('actionCancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
