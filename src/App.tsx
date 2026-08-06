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
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import {
  Activity,
  Bot,
  Cable,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CloudDownload,
  Copy,
  CopyPlus,
  CornerDownLeft,
  Download,
  FileCode2,
  FileSymlink,
  FileText,
  FolderOpen,
  FolderTree,
  HardDrive,
  History,
  Laptop,
  MemoryStick,
  Moon,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  ShieldCheck,
  Square,
  Sun,
  TerminalSquare,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

import { translate, translateStatus, type TranslationKey } from './i18n';
import { backend } from './backend';
import { writeClipboardText } from './clipboard';
import { useAppStore } from './store';
import { buildAgentChatFontFamily } from './terminalFonts';
// useShallow 让组件按“选中字段的浅比较”订阅 store，避免订阅整个 store 导致终端 cwd/status
// 等高频更新触发无关组件（尤其是未打开的弹窗）重渲染。
import { useShallow } from 'zustand/react/shallow';
import { UpdateModal, type UpdateDownloadProgress } from './UpdateModal';
import type { AgentBridgeRequest, AgentProvider, ConnectionProfile, RemoteFileEntry, RuntimeConnectionList, RuntimeResourceMetric, RuntimeResourceTarget, RuntimeResourceUsage, RuntimeResourceSource, RuntimeStorageFiles, TerminalSession, TunnelRecord } from './types';
import { useDraggableModals } from './useDraggableModals';
import { ConnectionFormModal } from './components/ConnectionFormModal';
import { ConnectionManagerModal } from './components/ConnectionManagerModal';
import { EditorModal } from './components/EditorModal';
import { LocalTerminalManagerModal } from './components/LocalTerminalManagerModal';
import { SettingsModal, type SettingsTab } from './components/SettingsModal';
import { TitlebarWindowControls } from './components/TitlebarWindowControls';
import { TunnelFormModal } from './components/TunnelFormModal';
import { buildPreviewFontFamily } from './app/fonts';
import { beginResize, clamp } from './app/layout';
import { formatLocalTerminalTabLabel, getLocalTerminalIcon } from './app/localTerminal';
import { isTauriRuntime } from './app/runtime';
import { translateUpdateCheckError } from './app/updates';
import {
  isPointInsideElement,
  moveItemToEnd,
  moveItemToInsert,
  resolveInlineInsertPlacement,
  useFlipListAnimation,
  type InsertPlacement,
} from './app/connectionGroups';
// 终端内核和 AI 对话都不是绘制应用骨架的前置条件；动态加载可让标题栏、侧栏和操作区先进入可用状态。
const TerminalWorkspace = lazy(() => import('./TerminalWorkspace').then((module) => ({ default: module.TerminalWorkspace })));
const AgentChatPanel = lazy(() => import('./AgentChatPanel').then((module) => ({ default: module.AgentChatPanel })));

type BottomPanelTab = 'commands' | 'tunnels' | 'history';
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
type SessionTabDragState = {
  id: string;
  label: string;
  originX: number;
  originY: number;
  currentX: number;
  currentY: number;
} | null;
type SessionTabDropTarget = { sessionId: string; placement: InsertPlacement } | { type: 'end' } | null;
// 会话标签自绘滚动条只表达横向溢出位置，避免依赖 WebView 原生滚动条高度渲染。
type SessionTabScrollbarState = {
  visible: boolean;
  thumbLeft: number;
  thumbWidth: number;
};
type SessionTabScrollbarDragState = {
  pointerId: number;
  originX: number;
  originScrollLeft: number;
  maxScrollLeft: number;
  maxThumbTravel: number;
};
// 传输进度用于给上传、下载、编辑读取和批量删除提供轻量阶段反馈；真实字节级进度需要后端分块事件再扩展。
type TransferProgressItem = {
  id: string;
  title: string;
  percent: number;
  status: 'running' | 'success' | 'error';
  message?: string;
};

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
// AI 对话栏承载长文本与代码块，需要比文件树宽得多；按窗口比例上限，大屏时能拖到接近 3/5。
const agentSidebarMaxWidthRatio = 0.6;
// AI 栏展开时主工作区可以让到更窄——终端本身在窄宽下仍可用，用户是主动选择看对话。
const agentSidebarMainWorkspaceMinWidth = 420;
// 左侧上下分区都保留约 120px 最小可用高度，避免文件管理区被限制成半屏起步。
const sidebarRuntimeMinHeight = 120;
const sidebarExplorerMinHeight = 120;
// app 外壳 padding、sidebar padding、分隔拖拽条和 gap 都要从可分配高度里预留出来。
const sidebarVerticalChromeBudget = 28;
// 主工作区保底宽度用于反推侧栏最大可拖宽度，避免左右栏继续挤压中间按钮和终端。
const mainWorkspaceMinWidth = 720;
// 应用外壳左右 padding 和侧栏拖拽柄宽度参与宽度预算，保证 JS 钳制与 CSS 网格尺寸一致。
const appShellHorizontalPadding = 8;
const sidePanelResizeHandleWidth = 4;
// 内存展开区只展示前 4 项，降低远端 ps 查询和前端渲染负担。
const runtimeResourceDetailLimit = 4;

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

const bottomTabs: Array<{ id: BottomPanelTab; labelKey: TranslationKey; icon: typeof TerminalSquare }> = [
  { id: 'commands', labelKey: 'panelCommands', icon: TerminalSquare },
  { id: 'tunnels', labelKey: 'panelTunnels', icon: Cable },
  { id: 'history', labelKey: 'panelHistory', icon: History },
];

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

const resolveSidePanelMaxWidth = (
  oppositePanelVisible: boolean,
  oppositePanelWidth: number,
  // AI 对话栏用更宽的上限与更小的主工作区保底，其余侧栏维持原有克制的尺寸。
  isAgentPanel = false,
) => {
  if (typeof window === 'undefined') {
    return isAgentPanel ? Math.round(1180 * agentSidebarMaxWidthRatio) : sidePanelMaxWidth;
  }

  const occupiedByChrome =
    appShellHorizontalPadding +
    sidePanelResizeHandleWidth +
    (oppositePanelVisible ? sidePanelResizeHandleWidth + oppositePanelWidth : 0);
  const workspaceFloor = isAgentPanel
    ? agentSidebarMainWorkspaceMinWidth
    : mainWorkspaceMinWidth;
  const ceiling = isAgentPanel
    ? Math.round(window.innerWidth * agentSidebarMaxWidthRatio)
    : sidePanelMaxWidth;
  const availableWidth = window.innerWidth - occupiedByChrome - workspaceFloor;
  return Math.max(sidePanelMinWidth, Math.min(ceiling, Math.floor(availableWidth)));
};

// 运行状态区域最大高度由文件管理区最小高度反推，拖拽到底时仍给文件管理保留可操作空间。
const resolveRuntimePanelMaxHeight = () => {
  if (typeof window === 'undefined') {
    return 380;
  }

  return Math.max(
    sidebarRuntimeMinHeight,
    window.innerHeight - sidebarExplorerMinHeight - sidebarVerticalChromeBudget,
  );
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

export default function App() {
  // 所有业务弹窗复用标题栏拖动能力；偏移仅存在于本次打开的 DOM 节点，关闭后自动复位。
  useDraggableModals();
  // 右侧 AI 栏分为对话与审批两个页签；默认停在对话，审批有新请求时会自动切过去。
  const [agentSidebarTab, setAgentSidebarTab] = useState<'chat' | 'requests'>('chat');
  // AI 端点列表（含明文密钥）缓存在前端，供侧边栏对话与设置页共用。
  const [agentProviders, setAgentProviders] = useState<AgentProvider[]>([]);
  // 左侧栏初始宽度默认取最小宽度稍多一点，避免打开时占用过多空间
  const [sidebarWidth, setSidebarWidth] = useState(sidePanelMinWidth + 20);
  const [runtimePanelHeight, setRuntimePanelHeight] = useState(() => {
    if (typeof window === 'undefined') {
      return 220;
    }
    // 左侧默认给运行状态约 1/3 高度，文件管理保持约 2/3，CPU 展开时不至于被文件区挤掉。
    return clamp(Math.round(window.innerHeight * 0.3), 190, Math.min(resolveRuntimePanelMaxHeight(), 300));
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
  // 对话栏默认取约 1/3 窗口宽：AI 回复常含多行说明与命令块，需要足够宽；
  // 上限仍套用拖拽钳制逻辑，小窗口或双侧栏展开时不会挤掉主工作区。
  const [agentSidebarWidth, setAgentSidebarWidth] = useState(() => {
    if (typeof window === 'undefined') {
      return 460;
    }
    const preferred = Math.round(window.innerWidth / 3);
    const ceiling = resolveSidePanelMaxWidth(!sidebarCollapsed, sidePanelMinWidth + 20, true);
    return clamp(preferred, 380, ceiling);
  });
  // AI 执行默认收起，只有用户点击或 MCP 新请求到达时才占用主窗口右侧空间。
  const [agentSidebarCollapsed, setAgentSidebarCollapsed] = useState(true);
  // 首次展开前不加载 AI 对话模块；展开过后保持挂载，收起侧栏也不能中断正在进行的流式响应。
  const [agentSidebarMounted, setAgentSidebarMounted] = useState(false);
  const [pathInput, setPathInput] = useState('~');
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenuState | null>(null);
  // 文件右键“复制”暂存待粘贴的远端路径；记录来源连接以便仅在同主机内启用粘贴。
  const [fileClipboard, setFileClipboard] = useState<{ connectionId: string; paths: string[] } | null>(null);
  // 右键菜单容器引用，用于渲染后按视口边界回收越界位置，避免菜单被面板/窗口裁掉。
  const fileContextMenuRef = useRef<HTMLDivElement | null>(null);
  // 复制名称的二级菜单默认向右展开，靠近右边界时翻转到左侧，防止子菜单溢出窗口。
  const [copyNameSubmenuFlipLeft, setCopyNameSubmenuFlipLeft] = useState(false);
  const [sessionContextMenu, setSessionContextMenu] = useState<SessionContextMenuState | null>(null);
  const [sessionTabDragState, setSessionTabDragState] = useState<SessionTabDragState>(null);
  const [sessionTabDropTarget, setSessionTabDropTarget] = useState<SessionTabDropTarget>(null);
  // 原生横向滚动条在 WebView2 中高度不可控，顶部标签改用自绘滑块保持细条视觉。
  const [sessionTabScrollbar, setSessionTabScrollbar] = useState<SessionTabScrollbarState>({
    visible: false,
    thumbLeft: 0,
    thumbWidth: 0,
  });
  const [selectedFilePath, setSelectedFilePath] = useState('');
  const [selectedFilePaths, setSelectedFilePaths] = useState<string[]>([]);
  const [localFileDropActive, setLocalFileDropActive] = useState(false);
  const [remoteDownloadDragPaths, setRemoteDownloadDragPaths] = useState<string[]>([]);
  // 运行状态区的展开态独立保存；存储明细只在 storageFilesExpanded 为 true 时触发远端扫描。
  const [cpuCoresExpanded, setCpuCoresExpanded] = useState(false);
  const [memoryResourcesExpanded, setMemoryResourcesExpanded] = useState(false);
  const [storageFilesExpanded, setStorageFilesExpanded] = useState(false);
  const [runtimeResourceMetric, setRuntimeResourceMetric] = useState<RuntimeResourceMetric>('memory');
  const [runtimeResourceTarget, setRuntimeResourceTarget] = useState<RuntimeResourceTarget>('process');
  const [runtimeResourceUsage, setRuntimeResourceUsage] = useState<RuntimeResourceUsage | null>(null);
  const [runtimeResourceLoading, setRuntimeResourceLoading] = useState(false);
  const [runtimeResourceError, setRuntimeResourceError] = useState('');
  const [runtimeStorageFiles, setRuntimeStorageFiles] = useState<RuntimeStorageFiles | null>(null);
  const [runtimeStorageFilesLoading, setRuntimeStorageFilesLoading] = useState(false);
  const [runtimeStorageFilesError, setRuntimeStorageFilesError] = useState('');
  // 连接数展开态与明细数据独立保存；明细只在 connectionsExpanded 为 true 时触发远端采集。
  const [connectionsExpanded, setConnectionsExpanded] = useState(false);
  const [runtimeConnections, setRuntimeConnections] = useState<RuntimeConnectionList | null>(null);
  const [runtimeConnectionsLoading, setRuntimeConnectionsLoading] = useState(false);
  const [runtimeConnectionsError, setRuntimeConnectionsError] = useState('');
  // 底部功能栏默认收起：日常操作集中在终端，命令/隧道/历史面板按需展开，把纵向空间让给终端。
  const [bottomDockCollapsed, setBottomDockCollapsed] = useState(true);
  const [transferProgressItems, setTransferProgressItems] = useState<TransferProgressItem[]>([]);
  const [agentBridgeRequests, setAgentBridgeRequests] = useState<AgentBridgeRequest[]>([]);
  const [agentCommandEdits, setAgentCommandEdits] = useState<Record<string, string>>({});
  const [agentExpandedRequestIds, setAgentExpandedRequestIds] = useState<Record<string, boolean>>({});
  const [explorerColumnWidths, setExplorerColumnWidths] = useState(explorerDefaultColumnWidths);
  const pathByConnectionRef = useRef<Record<string, string>>({});
  const runtimeRefreshInFlightRef = useRef(false);
  // 刷新进行中又收到刷新请求时置位，当前刷新结束后补跑一次，避免切换连接时漏刷、加载动画卡住。
  const runtimeRefreshPendingRef = useRef(false);
  // 展开明细的刷新序号用于丢弃旧请求，避免收起或切换连接后把过期结果写回界面。
  const runtimeResourceRefreshSeqRef = useRef(0);
  // 进程/线程资源明细可能需要 1~2 秒；同一展开态下避免轮询并发堆积。
  const runtimeResourceRefreshInFlightRef = useRef(false);
  const runtimeStorageFilesRefreshSeqRef = useRef(0);
  // 大文件扫描可能超过刷新间隔；同一连接同一展开态下只允许一个扫描请求在路上。
  const runtimeStorageFilesRefreshInFlightRef = useRef(false);
  const runtimeConnectionsRefreshSeqRef = useRef(0);
  // 连接明细轮询同样防并发重入，收起或切换连接时用序号丢弃过期响应。
  const runtimeConnectionsRefreshInFlightRef = useRef(false);
  const sessionTabDragStateRef = useRef<SessionTabDragState>(null);
  const sessionTabDropTargetRef = useRef<SessionTabDropTarget>(null);
  const sessionTabListRef = useRef<HTMLDivElement | null>(null);
  const sessionTabScrollbarDragRef = useRef<SessionTabScrollbarDragState | null>(null);
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
  // 首页工具栏“更新”按钮触发的弹窗状态，与设置页内的更新弹窗独立，避免互相抢占打开状态。
  const [appUpdateModalOpen, setAppUpdateModalOpen] = useState(false);
  const [appUpdateInstalling, setAppUpdateInstalling] = useState(false);
  const [appUpdateProgress, setAppUpdateProgress] = useState<UpdateDownloadProgress | null>(null);
  const [appUpdateError, setAppUpdateError] = useState<string | null>(null);
  // 标题栏”更新”按钮主动检测时的进行态，用于图标旋转反馈并避免重复点击。
  const [appUpdateChecking, setAppUpdateChecking] = useState(false);
  // 标题栏手动检测失败时的错误文案，传给弹窗展示。
  const [appUpdateCheckError, setAppUpdateCheckError] = useState<string | null>(null);

  const {
    activeConnectionId,
    activeSessionId,
    bootstrapped,
    bootstrap,
    checkForUpdates,
    closeSession,
    closeTunnel,
    applyTunnelStatusChange,
    commandBuffers,
    connections,
    currentRemotePath,
    deleteRemotePaths,
    copyRemotePaths,
    downloadRemotePaths,
    duplicateSession: duplicateSessionById,
    editTunnel,
    files,
    filesLoading,
    adoptSession,
    history,
    historyLoading,
    installUpdate,
    openConnectionForm,
    openRemoteFile,
    openTunnel,
    persistSettings,
    pollTerminalOutputs,
    refreshFiles,
    refreshRemoteHistory,
    refreshRuntimeOverview,
    reconnectSession: reconnectSessionById,
    renameRemotePath,
    reorderSessions,
    runtimeOverview,
    runtimeLoading,
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
    updateCheckResult,
    uploadLocalFiles,
    uploadLocalPaths,
  } = useAppStore(
    useShallow((state) => ({
      activeConnectionId: state.activeConnectionId,
      activeSessionId: state.activeSessionId,
      bootstrapped: state.bootstrapped,
      bootstrap: state.bootstrap,
      checkForUpdates: state.checkForUpdates,
      closeSession: state.closeSession,
      closeTunnel: state.closeTunnel,
      applyTunnelStatusChange: state.applyTunnelStatusChange,
      commandBuffers: state.commandBuffers,
      connections: state.connections,
      currentRemotePath: state.currentRemotePath,
      deleteRemotePaths: state.deleteRemotePaths,
      copyRemotePaths: state.copyRemotePaths,
      downloadRemotePaths: state.downloadRemotePaths,
      duplicateSession: state.duplicateSession,
      editTunnel: state.editTunnel,
      files: state.files,
      filesLoading: state.filesLoading,
      history: state.history,
      historyLoading: state.historyLoading,
      adoptSession: state.adoptSession,
      installUpdate: state.installUpdate,
      openConnectionForm: state.openConnectionForm,
      openRemoteFile: state.openRemoteFile,
      openTunnel: state.openTunnel,
      persistSettings: state.persistSettings,
      pollTerminalOutputs: state.pollTerminalOutputs,
      refreshFiles: state.refreshFiles,
      refreshRemoteHistory: state.refreshRemoteHistory,
      refreshRuntimeOverview: state.refreshRuntimeOverview,
      reconnectSession: state.reconnectSession,
      renameRemotePath: state.renameRemotePath,
      reorderSessions: state.reorderSessions,
      runtimeOverview: state.runtimeOverview,
      runtimeLoading: state.runtimeLoading,
      selectSession: state.selectSession,
      sendCommand: state.sendCommand,
      sendTerminalData: state.sendTerminalData,
      sessions: state.sessions,
      setCommandBuffer: state.setCommandBuffer,
      setStatusMessage: state.setStatusMessage,
      settings: state.settings,
      startAllTunnels: state.startAllTunnels,
      startTunnel: state.startTunnel,
      stopAllTunnels: state.stopAllTunnels,
      tunnels: state.tunnels,
      updateCheckResult: state.updateCheckResult,
      uploadLocalFiles: state.uploadLocalFiles,
      uploadLocalPaths: state.uploadLocalPaths,
    })),
  );

  const t = useCallback((key: TranslationKey, replacements?: Record<string, string | number>) =>
    translate(settings.uiLanguage, key, replacements), [settings.uiLanguage]);
  const runtimeResourceSourceLabel = useCallback((source: RuntimeResourceSource) => {
    const labelKeyBySource: Record<RuntimeResourceSource, TranslationKey> = {
      system: 'runtimeResourceSourceSystem',
      docker: 'runtimeResourceSourceDocker',
      podman: 'runtimeResourceSourcePodman',
      kubernetes: 'runtimeResourceSourceKubernetes',
    };
    return t(labelKeyBySource[source] ?? 'runtimeResourceSourceSystem');
  }, [t]);

  // 首页工具栏“更新”按钮和设置页共用后端安装接口，但下载进度与弹窗状态各自独立。
  const openAppExternalLink = useCallback((url: string) => {
    if (!isTauriRuntime()) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    void backend.openExternalUrl(url).catch(() => {
      window.open(url, '_blank', 'noopener,noreferrer');
    });
  }, []);
  const handleAppInstallUpdate = useCallback(async () => {
    if (!updateCheckResult) {
      return;
    }
    setAppUpdateInstalling(true);
    setAppUpdateError(null);
    setAppUpdateProgress(null);
    try {
      await installUpdate(updateCheckResult);
      // 安装程序已由后端启动，关闭首页弹窗即可，避免遮挡安装器窗口。
      setAppUpdateModalOpen(false);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason === t('downloadCancelled')) {
        setAppUpdateInstalling(false);
        return;
      }
      setAppUpdateError(t('statusUpdateInstallFailed', { reason }));
    } finally {
      setAppUpdateInstalling(false);
      setAppUpdateProgress(null);
    }
  }, [installUpdate, t, updateCheckResult]);

  // 标题栏更新按钮：用户主动点击时立即检测一次；无论结果如何都弹窗展示，否则由 store 写入”已是最新”状态提示。
  const handleTitlebarCheckUpdate = useCallback(async () => {
    if (appUpdateChecking) {
      return;
    }
    setAppUpdateChecking(true);
    setAppUpdateCheckError(null);
    try {
      await checkForUpdates();
      // 无论是否有新版本，都弹窗展示结果。
      setAppUpdateModalOpen(true);
    } catch (error) {
      // 网络异常或 GitHub 不可达时弹窗展示错误；与设置页一致，后端错误码按当前界面语言翻译。
      const reason = error instanceof Error ? error.message : String(error);
      setAppUpdateCheckError(translateUpdateCheckError(reason, settings.uiLanguage));
      setAppUpdateModalOpen(true);
    } finally {
      setAppUpdateChecking(false);
    }
  }, [appUpdateChecking, checkForUpdates, t, settings.uiLanguage]);

  // 标题栏主题按钮：在深浅色之间切换并立即持久化，无需打开设置页。
  const handleToggleTheme = useCallback(() => {
    const nextMode = settings.themeMode === 'dark' ? 'light' : 'dark';
    void persistSettings({ ...settings, themeMode: nextMode }).catch(() => undefined);
  }, [persistSettings, settings]);

  const activeSession = useMemo(() => sessions.find((item) => item.id === activeSessionId), [activeSessionId, sessions]);
  // 存活会话 ID 列表传给 TerminalWorkspace 做缓存回收；用 join 作为 memo key，会话状态/cwd 更新不改变
  // ID 集合时保持数组引用稳定，避免每次 store 更新都触发缓存清理副作用。
  const sessionIdsKey = sessions.map((item) => item.id).join('\n');
  const sessionIds = useMemo(() => sessions.map((item) => item.id), [sessionIdsKey]);
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
        return clamp(
          current,
          sidePanelMinWidth,
          resolveSidePanelMaxWidth(!sidebarCollapsed, sidebarWidth, true),
        );
      });
      // 窗口缩小时重新钳制运行状态高度，确保文件管理区仍保留最小可操作高度。
      setRuntimePanelHeight((current) => clamp(current, sidebarRuntimeMinHeight, resolveRuntimePanelMaxHeight()));
    };

    clampExpandedSidebars();
    window.addEventListener('resize', clampExpandedSidebars);
    return () => window.removeEventListener('resize', clampExpandedSidebars);
  }, [agentSidebarCollapsed, agentSidebarWidth, sidebarCollapsed, sidebarWidth]);

  const openAgentRequestPanel = useCallback(async (focusWindow = false) => {
    // MCP 审批入口已经迁到右侧栏，新请求只展开右栏，不再改动底部命令/隧道/历史的当前 tab。
    setAgentSidebarCollapsed(false);
    // 有待审批请求时必须切到审批页签，否则用户停在对话页会完全看不到卡片。
    setAgentSidebarTab('requests');

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
      // 内置 AI 对话的审批直接挂在原工具调用下方；侧栏被收起时重新展开到对话页，确保审批入口可见。
      const pendingChatRequests = pendingNewRequests.filter((request) => Boolean(request.conversationId));
      if (pendingChatRequests.length) {
        setAgentSidebarCollapsed(false);
        setAgentSidebarTab('chat');
      }
      // 只有外部 MCP 请求才进入独立审批页。
      const pendingExternalRequests = pendingNewRequests.filter((request) => !request.conversationId);
      if (pendingExternalRequests.length) {
        void openAgentRequestPanel(false);
        void showAgentRequestNotification(pendingExternalRequests[0]);
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
    // 正在刷新时不并发重入，只记下“还需再刷一次”的诉求；否则切换连接时新刷新会被丢弃，
    // 导致运行状态加载动画一直空转到下一次定时器才恢复。
    if (runtimeRefreshInFlightRef.current) {
      runtimeRefreshPendingRef.current = true;
      return;
    }
    const run = () => {
      runtimeRefreshInFlightRef.current = true;
      runtimeRefreshPendingRef.current = false;
      void refreshRuntimeOverview().finally(() => {
        runtimeRefreshInFlightRef.current = false;
        // 刷新期间若又发起过（如切换了连接），补跑一次以覆盖最新的活动连接，避免漏刷。
        if (runtimeRefreshPendingRef.current) {
          run();
        }
      });
    };
    run();
  }, [refreshRuntimeOverview]);

  const refreshRuntimeResourceUsageOnce = useCallback(() => {
    if (!activeRemoteConnectionId || !memoryResourcesExpanded || runtimeResourceRefreshInFlightRef.current) {
      return;
    }

    const requestSeq = ++runtimeResourceRefreshSeqRef.current;
    runtimeResourceRefreshInFlightRef.current = true;
    setRuntimeResourceLoading(true);
    setRuntimeResourceError('');
    void backend.fetchRuntimeResourceUsage(activeRemoteConnectionId, {
      source: settings.runtimeResourceSource ?? 'system',
      metric: runtimeResourceMetric,
      target: runtimeResourceTarget,
      limit: runtimeResourceDetailLimit,
    }).then((usage) => {
      if (requestSeq !== runtimeResourceRefreshSeqRef.current) {
        return;
      }
      setRuntimeResourceUsage(usage);
      setRuntimeResourceError(usage.error ?? '');
    }).catch((error) => {
      if (requestSeq !== runtimeResourceRefreshSeqRef.current) {
        return;
      }
      // 刷新失败时保留旧明细，避免网络抖动或远端命令慢导致展开区突然清空。
      setRuntimeResourceError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (requestSeq === runtimeResourceRefreshSeqRef.current) {
        runtimeResourceRefreshInFlightRef.current = false;
        setRuntimeResourceLoading(false);
      }
    });
  }, [activeRemoteConnectionId, memoryResourcesExpanded, runtimeResourceMetric, runtimeResourceTarget, settings.runtimeResourceSource]);

  useEffect(() => {
    if (!memoryResourcesExpanded || !activeRemoteConnectionId) {
      runtimeResourceRefreshSeqRef.current += 1;
      runtimeResourceRefreshInFlightRef.current = false;
      setRuntimeResourceLoading(false);
      return undefined;
    }

    // 内存明细展开、切换 CPU/内存、切换进程/线程或来源设置变化时都会立即刷新一次。
    // 后续按资源设置里的进程状态刷新频率轮询；收起时 cleanup 会关闭轮询。
    refreshRuntimeResourceUsageOnce();
    const timer = window.setInterval(
      refreshRuntimeResourceUsageOnce,
      Math.max(1, settings.runtimeResourceRefreshIntervalSec ?? 3) * 1000,
    );
    return () => {
      runtimeResourceRefreshSeqRef.current += 1;
      runtimeResourceRefreshInFlightRef.current = false;
      window.clearInterval(timer);
    };
  }, [activeRemoteConnectionId, memoryResourcesExpanded, refreshRuntimeResourceUsageOnce, settings.runtimeResourceRefreshIntervalSec]);

  // 存储最大文件扫描按展开态触发；未选连接或已收起时直接跳过，减少远端磁盘遍历。
  const refreshRuntimeStorageFilesOnce = useCallback(() => {
    if (!activeRemoteConnectionId || !storageFilesExpanded || runtimeStorageFilesRefreshInFlightRef.current) {
      return;
    }

    const requestSeq = ++runtimeStorageFilesRefreshSeqRef.current;
    runtimeStorageFilesRefreshInFlightRef.current = true;
    setRuntimeStorageFilesLoading(true);
    setRuntimeStorageFilesError('');
    void backend.fetchRuntimeStorageFiles(activeRemoteConnectionId).then((files) => {
      if (requestSeq !== runtimeStorageFilesRefreshSeqRef.current) {
        return;
      }
      setRuntimeStorageFiles(files);
      setRuntimeStorageFilesError(files.error ?? '');
    }).catch((error) => {
      if (requestSeq !== runtimeStorageFilesRefreshSeqRef.current) {
        return;
      }
      // 刷新失败时保留旧文件列表，避免一次扫描超时导致已展示的大文件数据消失。
      setRuntimeStorageFilesError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (requestSeq === runtimeStorageFilesRefreshSeqRef.current) {
        runtimeStorageFilesRefreshInFlightRef.current = false;
        setRuntimeStorageFilesLoading(false);
      }
    });
  }, [activeRemoteConnectionId, storageFilesExpanded]);

  useEffect(() => {
    if (!storageFilesExpanded || !activeRemoteConnectionId) {
      runtimeStorageFilesRefreshSeqRef.current += 1;
      runtimeStorageFilesRefreshInFlightRef.current = false;
      setRuntimeStorageFilesLoading(false);
      return undefined;
    }

    // 存储展开时立即扫描一次，后续按资源设置里的大文件状态刷新频率轮询；收起时 cleanup 会关闭轮询。
    refreshRuntimeStorageFilesOnce();
    const timer = window.setInterval(
      refreshRuntimeStorageFilesOnce,
      Math.max(5, settings.runtimeStorageRefreshIntervalSec ?? 5) * 1000,
    );
    return () => {
      runtimeStorageFilesRefreshSeqRef.current += 1;
      runtimeStorageFilesRefreshInFlightRef.current = false;
      window.clearInterval(timer);
    };
  }, [activeRemoteConnectionId, refreshRuntimeStorageFilesOnce, settings.runtimeStorageRefreshIntervalSec, storageFilesExpanded]);

  // 连接明细按展开态触发；读取 /proc 网络表开销小，但仍只在本行展开时才请求，收起即停止。
  const refreshRuntimeConnectionsOnce = useCallback(() => {
    if (!activeRemoteConnectionId || !connectionsExpanded || runtimeConnectionsRefreshInFlightRef.current) {
      return;
    }

    const requestSeq = ++runtimeConnectionsRefreshSeqRef.current;
    runtimeConnectionsRefreshInFlightRef.current = true;
    setRuntimeConnectionsLoading(true);
    setRuntimeConnectionsError('');
    void backend.fetchRuntimeConnectionList(activeRemoteConnectionId).then((list) => {
      if (requestSeq !== runtimeConnectionsRefreshSeqRef.current) {
        return;
      }
      setRuntimeConnections(list);
      setRuntimeConnectionsError(list.error ?? '');
    }).catch((error) => {
      if (requestSeq !== runtimeConnectionsRefreshSeqRef.current) {
        return;
      }
      // 刷新失败时保留旧明细，避免一次网络抖动清空已展示的连接列表。
      setRuntimeConnectionsError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (requestSeq === runtimeConnectionsRefreshSeqRef.current) {
        runtimeConnectionsRefreshInFlightRef.current = false;
        setRuntimeConnectionsLoading(false);
      }
    });
  }, [activeRemoteConnectionId, connectionsExpanded]);

  useEffect(() => {
    if (!connectionsExpanded || !activeRemoteConnectionId) {
      runtimeConnectionsRefreshSeqRef.current += 1;
      runtimeConnectionsRefreshInFlightRef.current = false;
      setRuntimeConnectionsLoading(false);
      return undefined;
    }

    // 展开时立即拉取一次，随后跟随运行状态主刷新频率轮询（最低 5 秒），与连接数主行保持同节奏。
    refreshRuntimeConnectionsOnce();
    const timer = window.setInterval(
      refreshRuntimeConnectionsOnce,
      Math.max(5, settings.runtimeRefreshIntervalSec) * 1000,
    );
    return () => {
      runtimeConnectionsRefreshSeqRef.current += 1;
      runtimeConnectionsRefreshInFlightRef.current = false;
      window.clearInterval(timer);
    };
  }, [activeRemoteConnectionId, connectionsExpanded, refreshRuntimeConnectionsOnce, settings.runtimeRefreshIntervalSec]);

  // 活动远端连接变化时（关闭 SSH tab、切到其它连接或断开），收起运行状态所有下拉并清空已暂存的明细。
  // 否则下拉会停留在上一个连接的内存/存储数据上：无连接时轮询已停止无法刷新，看起来像卡死；
  // 切到其它连接时又会短暂显示旧连接数据，语义错误。收起后用户重新展开即按新连接重新拉取。
  useEffect(() => {
    setCpuCoresExpanded(false);
    setMemoryResourcesExpanded(false);
    setStorageFilesExpanded(false);
    setConnectionsExpanded(false);
    setRuntimeResourceUsage(null);
    setRuntimeResourceError('');
    setRuntimeStorageFiles(null);
    setRuntimeStorageFilesError('');
    setRuntimeConnections(null);
    setRuntimeConnectionsError('');
  }, [activeRemoteConnectionId]);

  useEffect(() => {
    if (!bootstrapped) {
      void bootstrap();
    }
  }, [bootstrap, bootstrapped]);

  useEffect(() => {
    if (!agentSidebarCollapsed) {
      setAgentSidebarMounted(true);
    }
  }, [agentSidebarCollapsed]);

  // 启动后立即检测一次更新，之后每 10 分钟复检一次；网络失败时静默忽略，不打扰用户。
  useEffect(() => {
    if (!isTauriRuntime()) {
      return undefined;
    }
    const runSilentCheck = () => {
      void checkForUpdates().catch(() => {
        // 网络异常或 GitHub 不可达时不报错，仅在后台静默失败。
      });
    };
    runSilentCheck();
    const timer = window.setInterval(runSilentCheck, 10 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [checkForUpdates]);

  // 下载进度事件由后端统一发出，首页和设置页弹窗共用同一个事件名，分别更新各自进度状态。
  useEffect(() => {
    if (!isTauriRuntime()) {
      return undefined;
    }
    let unlistenFn: (() => void) | undefined;
    let isMounted = true;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen('myterminal-update-download-progress', (event) => {
        const payload = event.payload as UpdateDownloadProgress;
        setAppUpdateProgress(payload);
      }),
    ).then((unlisten) => {
      if (isMounted) {
        unlistenFn = unlisten;
      } else {
        unlisten();
      }
    }).catch(() => undefined);
    return () => {
      isMounted = false;
      unlistenFn?.();
    };
  }, []);

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
    // 原生层会统一关闭 WebView 浏览器加速键；这里专门兜底旧版 WebView2 的刷新键，避免任意面板或弹窗触发整页重载。
    const suppressWebviewReloadFallback = (event: KeyboardEvent) => {
      const isReloadShortcut = event.key === 'F5'
        || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r');
      if (!isReloadShortcut) {
        return;
      }

      // Monaco 需要把 Ctrl+R 映射为替换，xterm 也需要接收终端功能键；两者会自行消费按键并阻止浏览器默认行为。
      const target = event.target;
      if (target instanceof Element && target.closest('.monaco-editor, .xterm')) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
    };

    window.addEventListener('keydown', suppressWebviewReloadFallback, true);
    return () => window.removeEventListener('keydown', suppressWebviewReloadFallback, true);
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

  // 文件右键菜单渲染后按视口边界回拉位置，防止靠近面板右/下缘时被裁切；useLayoutEffect 在绘制前完成，无跳动。
  useLayoutEffect(() => {
    const menu = fileContextMenuRef.current;
    if (!fileContextMenu || !menu) {
      return;
    }

    const margin = 8;
    const rect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    let left = fileContextMenu.x;
    let top = fileContextMenu.y;
    if (left + rect.width > viewportWidth - margin) {
      left = Math.max(margin, viewportWidth - rect.width - margin);
    }
    if (top + rect.height > viewportHeight - margin) {
      top = Math.max(margin, viewportHeight - rect.height - margin);
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    // 二级菜单约 160px 宽，主菜单右侧放不下时翻转到左边展开。
    setCopyNameSubmenuFlipLeft(left + rect.width + 160 > viewportWidth - margin);
  }, [fileContextMenu]);

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

  // 启动时加载 AI 端点列表（含明文密钥），供侧边栏对话与设置页共用。
  const refreshAgentProviders = useCallback(async () => {
    try {
      setAgentProviders(await backend.listAgentProviders());
    } catch {
      // 端点未配置或读取失败不影响其它功能，对话面板会提示去设置里添加。
    }
  }, []);

  useEffect(() => {
    void refreshAgentProviders();
  }, [refreshAgentProviders]);

  // AI 可见执行会在没有可用标签时自行开一个终端；前端未发起过 openSession，必须靠事件登记进标签栏。
  // 依赖数组刻意为空：首个由后端创建的会话到达时 sessions 还是空的，不能因依赖变化错过订阅。
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    let isMounted = true;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<TerminalSession>('terminal-session-opened', (event) => {
        if (event.payload && typeof event.payload === 'object') {
          adoptSession(event.payload);
        }
      }),
    ).then((unlisten) => {
      if (isMounted) {
        unlistenFn = unlisten;
      } else {
        unlisten();
      }
    }).catch(() => {
      // 非 Tauri 环境没有该事件；可见执行本身也不可用，忽略即可。
    });

    return () => {
      isMounted = false;
      unlistenFn?.();
    };
  }, [adoptSession]);

  // 监听后台隧道健康监控线程发出的状态变化事件，实时将隧道“运行中/异常”状态同步到面板。
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    let isMounted = true;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<TunnelRecord>('tunnel-status-changed', (event) => {
        if (event.payload && typeof event.payload === 'object') {
          applyTunnelStatusChange(event.payload);
        }
      }),
    ).then((unlisten) => {
      if (isMounted) {
        unlistenFn = unlisten;
      } else {
        unlisten();
      }
    }).catch(() => {
      // 非 Tauri 环境（Web 开发模式）下无事件通道，静默忽略。
    });

    return () => {
      isMounted = false;
      unlistenFn?.();
    };
  }, [applyTunnelStatusChange]);


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
  const duplicateSession = useCallback((session?: TerminalSession) => {
    if (!session) {
      return;
    }

    setSessionContextMenu(null);
    // 复制标签在源标签右侧新开一条同类会话；SSH 走登录默认目录，本地终端沿用原目录与启动命令。
    void duplicateSessionById(session.id).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    });
  }, [duplicateSessionById, setStatusMessage]);
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

  const updateSessionTabScrollbar = useCallback(() => {
    const listElement = sessionTabListRef.current;
    if (!listElement) {
      setSessionTabScrollbar((current) => (
        current.visible || current.thumbLeft || current.thumbWidth
          ? { visible: false, thumbLeft: 0, thumbWidth: 0 }
          : current
      ));
      return;
    }

    const maxScrollLeft = Math.max(0, listElement.scrollWidth - listElement.clientWidth);
    if (maxScrollLeft <= 1) {
      setSessionTabScrollbar((current) => (
        current.visible || current.thumbLeft || current.thumbWidth
          ? { visible: false, thumbLeft: 0, thumbWidth: 0 }
          : current
      ));
      return;
    }

    // thumb 宽度按可视区域比例计算，并保留最小可拖动宽度，避免连接很多时滑块过短。
    const trackWidth = Math.max(1, listElement.clientWidth - 8);
    const thumbWidth = Math.min(trackWidth, Math.max(24, Math.round((trackWidth * listElement.clientWidth) / listElement.scrollWidth)));
    const maxThumbTravel = Math.max(1, trackWidth - thumbWidth);
    const thumbLeft = Math.round((listElement.scrollLeft / maxScrollLeft) * maxThumbTravel);
    setSessionTabScrollbar((current) => (
      current.visible === true && current.thumbLeft === thumbLeft && current.thumbWidth === thumbWidth
        ? current
        : { visible: true, thumbLeft, thumbWidth }
    ));
  }, []);

  useLayoutEffect(() => {
    updateSessionTabScrollbar();
    const listElement = sessionTabListRef.current;
    if (!listElement) {
      return undefined;
    }

    const handleResize = () => updateSessionTabScrollbar();
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(handleResize);
    resizeObserver?.observe(listElement);
    if (listElement.parentElement) {
      resizeObserver?.observe(listElement.parentElement);
    }
    window.addEventListener('resize', handleResize);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [agentSidebarCollapsed, connections, sessions, sidebarCollapsed, updateSessionTabScrollbar]);

  const handleSessionTabScroll = useCallback(() => {
    updateSessionTabScrollbar();
  }, [updateSessionTabScrollbar]);

  const startSessionTabScrollbarDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    const listElement = sessionTabListRef.current;
    if (!listElement || !sessionTabScrollbar.visible) {
      return;
    }

    const maxScrollLeft = Math.max(0, listElement.scrollWidth - listElement.clientWidth);
    const maxThumbTravel = Math.max(1, event.currentTarget.clientWidth - sessionTabScrollbar.thumbWidth);
    const trackRect = event.currentTarget.getBoundingClientRect();
    // 点击轨道时先把滑块移动到鼠标附近，再进入拖动，避免细条难以精准命中。
    const nextThumbLeft = clamp(event.clientX - trackRect.left - sessionTabScrollbar.thumbWidth / 2, 0, maxThumbTravel);
    listElement.scrollLeft = (nextThumbLeft / maxThumbTravel) * maxScrollLeft;
    sessionTabScrollbarDragRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originScrollLeft: listElement.scrollLeft,
      maxScrollLeft,
      maxThumbTravel,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateSessionTabScrollbar();
  }, [sessionTabScrollbar.thumbWidth, sessionTabScrollbar.visible, updateSessionTabScrollbar]);

  const handleSessionTabScrollbarPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = sessionTabScrollbarDragRef.current;
    const listElement = sessionTabListRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId || !listElement) {
      return;
    }

    const scrollDelta = ((event.clientX - dragState.originX) / dragState.maxThumbTravel) * dragState.maxScrollLeft;
    listElement.scrollLeft = clamp(dragState.originScrollLeft + scrollDelta, 0, dragState.maxScrollLeft);
    updateSessionTabScrollbar();
  }, [updateSessionTabScrollbar]);

  const finishSessionTabScrollbarDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = sessionTabScrollbarDragRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }

    event.currentTarget.releasePointerCapture?.(event.pointerId);
    sessionTabScrollbarDragRef.current = null;
    updateSessionTabScrollbar();
  }, [updateSessionTabScrollbar]);

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
    { id: 'connections', icon: Cable, label: t('metricConnections'), value: runtimeOverview?.connections ?? t('metricUnavailable'), percent: undefined },
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
  // 复制名称：写入系统剪贴板，name 为文件名、fullPath 为从 / 起的完整路径。
  const copyFileNameToClipboard = useCallback((text: string) => {
    setFileContextMenu(null);
    void writeClipboardText(text)
      .then(() => setStatusMessage(t('statusCopiedName', { name: text })))
      .catch((error) => setStatusMessage(error instanceof Error ? error.message : String(error)));
  }, [setStatusMessage, t]);
  // 复制：把选中（或右键命中）的远端路径暂存到内部剪贴板，供后续在目标目录粘贴。
  const copyRemoteSelection = useCallback((paths: string[]) => {
    const normalizedPaths = Array.from(new Set(paths.filter(Boolean)));
    setFileContextMenu(null);
    if (!activeConnectionId || !normalizedPaths.length) {
      return;
    }
    setFileClipboard({ connectionId: activeConnectionId, paths: normalizedPaths });
    setStatusMessage(t('statusClipboardReady', { count: normalizedPaths.length }));
  }, [activeConnectionId, setStatusMessage, t]);
  // 粘贴：仅当剪贴板来源与当前连接一致时可用，复制走后端服务器本地 cp，无需经客户端中转。
  const pasteRemoteClipboard = useCallback(() => {
    setFileContextMenu(null);
    if (!fileClipboard || fileClipboard.connectionId !== activeConnectionId || !fileClipboard.paths.length) {
      return;
    }
    const sources = fileClipboard.paths;
    void runTransferProgress(`${t('fileMenuPaste')} ${sources.length}`, async (setPercent) => {
      setPercent(24);
      await copyRemotePaths(sources, currentRemotePath);
      setPercent(92);
    });
  }, [activeConnectionId, copyRemotePaths, currentRemotePath, fileClipboard, runTransferProgress, t]);
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
  // AI 对话审批仍保留在执行审批列表作为审计记录，同时传回对话面板完成原位审批。
  const agentChatApprovalRequests = useMemo(
    () => agentBridgeRequests.filter((request) => Boolean(request.conversationId && request.toolCallId)),
    [agentBridgeRequests],
  );
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
          // 执行结果里带回本次走的通道；未完成或非命令类请求时不显示该行。
          const executionResult = request.result as
            | { executionMode?: string; fallbackReason?: string }
            | undefined;
          const executionModeLabel = executionResult?.executionMode
            ? executionResult.executionMode === 'terminal'
              ? t('agentRequestModeTerminal')
              : `${t('agentRequestModeHidden')}${executionResult.fallbackReason ? `（${executionResult.fallbackReason}）` : ''}`
            : '';

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
                {executionModeLabel ? (
                  <>
                    {/* 如实告知本次是在终端里可见执行还是走了后台通道，避免用户误以为一定能看到过程。 */}
                    <span>{t('agentRequestExecutionMode')}</span>
                    <strong>{executionModeLabel}</strong>
                  </>
                ) : null}
              </div>
              {isExpanded ? (
                <>
                  {request.kind === 'run_command' ? (
                    <label>
                      <span>{t('agentRequestCommand')}</span>
                      <textarea
                        // 内置 AI 请求在对话内审批；这里作为审计记录只读展示，避免出现两个可操作入口。
                        disabled={request.status !== 'pending' || Boolean(request.conversationId)}
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
                  {request.status === 'pending' && request.conversationId ? (
                    <div className="agent-request-record-hint">{t('agentRequestApproveInChat')}</div>
                  ) : null}
                  {request.status === 'pending' && !request.conversationId ? (
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
      {/* 自定义标题栏：关闭原生装饰后承载操作入口和窗口控制，中间空白区作为拖动手柄。 */}
      <header className="app-titlebar">
        <div className="app-titlebar-actions">
          <button
            aria-label={t('newConnection')}
            className="titlebar-action-button"
            onClick={() => openConnectionForm()}
            title={t('newConnection')}
            type="button"
          >
            <Plus size={16} /> <span className="button-label">{t('newConnection')}</span>
          </button>
          <button
            className="titlebar-action-button"
            onClick={() => setConnectionsOpen(true)}
            title={t('manageConnections')}
            type="button"
          >
            <FolderTree size={16} /> <span className="button-label">{t('manageConnections')}</span>
          </button>
          <button
            className="titlebar-action-button"
            onClick={() => setLocalTerminalsOpen(true)}
            title={t('localTerminalTitle')}
            type="button"
          >
            <Laptop size={16} /> <span className="button-label">{t('localTerminalTitle')}</span>
          </button>
        </div>
        {/* 中间空白区专用于拖动窗口，避免按钮区误触发拖动。 */}
        <div className="app-titlebar-drag" data-tauri-drag-region />
        <div className="app-titlebar-system">
          {/* 更新按钮常驻，支持主动点击检测；检测中图标旋转，发现新版本时右上角显示红点提示。 */}
          <button
            aria-label={t('checkUpdates')}
            className="titlebar-icon-button"
            disabled={appUpdateChecking}
            onClick={() => void handleTitlebarCheckUpdate()}
            title={t('checkUpdates')}
            type="button"
          >
            <CloudDownload className={appUpdateChecking ? 'is-spinning' : ''} size={16} />
            {updateCheckResult?.updateAvailable ? <span className="titlebar-badge-dot" /> : null}
          </button>
          {/* 主题按钮：浅色下显示月亮（点击进入深色），深色下显示太阳（点击回到浅色）。 */}
          <button
            aria-label={settings.themeMode === 'dark' ? t('switchToLightMode') : t('switchToDarkMode')}
            className="titlebar-icon-button"
            onClick={handleToggleTheme}
            title={settings.themeMode === 'dark' ? t('switchToLightMode') : t('switchToDarkMode')}
            type="button"
          >
            {settings.themeMode === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button
            aria-label={t('openSettings')}
            className="titlebar-icon-button"
            onClick={() => {
              setSettingsTab('appearance');
              setSettingsOpen(true);
            }}
            title={t('openSettings')}
            type="button"
          >
            <Settings size={16} />
          </button>
          <TitlebarWindowControls t={t} />
        </div>
      </header>

      <div className="app-body">
      {!sidebarCollapsed ? (
      <aside className="sidebar card" style={{ minWidth: sidePanelMinWidth, width: sidebarWidth }}>
        <section className="sidebar-panel runtime-panel" style={{ height: runtimePanelHeight }}>
          <div className="section-row runtime-header">
            <h3>{runtimeHostLabel}</h3>
            {/* 刷新进行中时图标持续旋转，给出“正在刷新”的即时反馈。 */}
            <button className="icon-button" disabled={!hasActiveRemoteSession} onClick={refreshRuntimeOverviewOnce} type="button">
              <RefreshCw className={runtimeLoading ? 'is-spinning' : ''} size={16} />
            </button>
          </div>

          {/* 无旧数据的首次加载才显示遮罩动画；有旧数据时后台静默刷新，保留上次内容不闪烁。 */}
          <div className={`runtime-list ${runtimeLoading && !runtimeOverview ? 'is-panel-loading' : ''}`}>
            {runtimeLoading && !runtimeOverview ? (
              <div className="panel-loading-overlay">
                <RefreshCw className="is-spinning" size={18} />
                <span>{t('panelRefreshing')}</span>
              </div>
            ) : null}
            {runtimeItems.map(({ id, icon: Icon, label, percent, value }) => {
              // CPU、内存、存储和连接数主行承担各自展开入口；行内不再放箭头，保持左侧状态区横向空间稳定。
              const isCpuMetric = id === 'cpu';
              const isMemoryMetric = id === 'memory';
              const isStorageMetric = id === 'storage';
              const isConnectionsMetric = id === 'connections';
              const cpuCoreCount = runtimeOverview?.cpuCores?.length ?? 0;
              const isCpuExpandable = isCpuMetric && cpuCoreCount > 0;
              const isMemoryExpandable = isMemoryMetric && Boolean(activeRemoteConnectionId);
              const isStorageExpandable = isStorageMetric && Boolean(activeRemoteConnectionId);
              const isConnectionsExpandable = isConnectionsMetric && Boolean(activeRemoteConnectionId);
              const isExpandableMetric = isCpuExpandable || isMemoryExpandable || isStorageExpandable || isConnectionsExpandable;
              const expanded = isCpuMetric
                ? cpuCoresExpanded
                : isMemoryMetric
                  ? memoryResourcesExpanded
                  : isStorageMetric
                    ? storageFilesExpanded
                    : isConnectionsMetric
                      ? connectionsExpanded
                      : undefined;
              const controlsId = isCpuExpandable
                ? 'runtime-cpu-core-list'
                : isMemoryExpandable
                  ? 'runtime-memory-resource-list'
                  : isStorageExpandable
                    ? 'runtime-storage-file-list'
                    : isConnectionsExpandable
                      ? 'runtime-connection-list'
                  : undefined;
              return (
                <div key={id} className="runtime-row-group">
                  <button
                    aria-controls={controlsId}
                    aria-expanded={isExpandableMetric ? expanded : undefined}
                    className={`runtime-row metric-tone-${metricTone(percent)} ${isExpandableMetric ? 'is-expandable-metric-row' : ''} ${isExpandableMetric ? 'is-clickable' : ''}`}
                    disabled={!isExpandableMetric}
                    onClick={() => {
                      if (isCpuExpandable) {
                        setCpuCoresExpanded((current) => !current);
                      }
                      if (isMemoryExpandable) {
                        setMemoryResourcesExpanded((current) => !current);
                      }
                      if (isStorageExpandable) {
                        setStorageFilesExpanded((current) => !current);
                      }
                      if (isConnectionsExpandable) {
                        setConnectionsExpanded((current) => !current);
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
                  {isCpuMetric && cpuCoresExpanded && cpuCoreCount > 0 ? (
                    <div className="runtime-core-list" id="runtime-cpu-core-list">
                      {runtimeOverview?.cpuCores.map((core) => {
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
                  {isMemoryMetric && memoryResourcesExpanded ? (
                    <div className="runtime-resource-panel" id="runtime-memory-resource-list">
                      <div className="runtime-resource-toolbar">
                        <div className="runtime-segmented-control" aria-label={t('runtimeResourceMetric')}>
                          <button
                            className={runtimeResourceMetric === 'memory' ? 'is-active' : ''}
                            onClick={() => setRuntimeResourceMetric('memory')}
                            type="button"
                          >
                            {t('runtimeResourceMetricMemory')}
                          </button>
                          <button
                            className={runtimeResourceMetric === 'cpu' ? 'is-active' : ''}
                            onClick={() => setRuntimeResourceMetric('cpu')}
                            type="button"
                          >
                            {t('runtimeResourceMetricCpu')}
                          </button>
                        </div>
                        <div className="runtime-segmented-control" aria-label={t('runtimeResourceTarget')}>
                          <button
                            className={runtimeResourceTarget === 'process' ? 'is-active' : ''}
                            onClick={() => setRuntimeResourceTarget('process')}
                            type="button"
                          >
                            {t('runtimeResourceTargetProcess')}
                          </button>
                          <button
                            className={runtimeResourceTarget === 'thread' ? 'is-active' : ''}
                            onClick={() => setRuntimeResourceTarget('thread')}
                            type="button"
                          >
                            {t('runtimeResourceTargetThread')}
                          </button>
                        </div>
                      </div>

                      <div className="runtime-resource-header">
                        <span>#</span>
                        <span>
                          {runtimeResourceTarget === 'thread' ? t('runtimeResourceTargetThread') : t('runtimeResourceTargetProcess')}
                          {' · '}
                          {runtimeResourceSourceLabel((runtimeResourceUsage?.source ?? settings.runtimeResourceSource ?? 'system') as RuntimeResourceSource)}
                        </span>
                        <span>{t('metricCpu')}</span>
                        <span>{t('metricMemory')}</span>
                      </div>

                      {runtimeResourceUsage?.items.length ? (
                        <div className="runtime-resource-table">
                          {runtimeResourceUsage.items.map((item, index) => (
                            <div className="runtime-resource-row" key={`${item.id}-${index}`} title={item.detail}>
                              <span className="runtime-resource-rank">{item.rank}</span>
                              <span className="runtime-resource-name">
                                <strong>{item.name || item.id}</strong>
                                <small>{item.context}</small>
                              </span>
                              <span>{item.cpu}</span>
                              <span>{item.memory}</span>
                            </div>
                          ))}
                        </div>
                      ) : runtimeResourceLoading ? (
                        <div className="runtime-resource-empty">
                          {t('panelRefreshing')}
                        </div>
                      ) : runtimeResourceError || !runtimeResourceLoading ? (
                        <div className="runtime-resource-empty">
                          {runtimeResourceError || t('runtimeResourceEmpty')}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {isStorageMetric && storageFilesExpanded ? (
                    <div className="runtime-storage-panel" id="runtime-storage-file-list">
                      <div className="runtime-storage-header">
                        <span>#</span>
                        <span>{t('runtimeStorageFileName')}</span>
                        <span>{t('runtimeStorageFileSize')}</span>
                      </div>

                      {runtimeStorageFiles?.items.length ? (
                        <div className="runtime-storage-table">
                          {runtimeStorageFiles.items.map((item) => (
                            <div
                              className="runtime-storage-row"
                              key={`${item.path}-${item.rank}`}
                              title={`${item.name}\n${item.path}\n${item.size}`}
                            >
                              <span className="runtime-storage-rank">{item.rank}</span>
                              <span className="runtime-storage-file">
                                <strong>{item.name}</strong>
                                <small>{item.path}</small>
                              </span>
                              <span className="runtime-storage-size">{item.size}</span>
                            </div>
                          ))}
                        </div>
                      ) : runtimeStorageFilesLoading ? (
                        <div className="runtime-resource-empty">
                          {t('panelRefreshing')}
                        </div>
                      ) : runtimeStorageFilesError || !runtimeStorageFilesLoading ? (
                        <div className="runtime-resource-empty">
                          {runtimeStorageFilesError || t('runtimeStorageFilesEmpty')}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {isConnectionsMetric && connectionsExpanded ? (
                    <div className="runtime-connection-panel" id="runtime-connection-list">
                      {/* 连接表读自远端主机的内核，列里的“本机”是那台主机而非用户电脑；不写清这行 127.0.0.1 极易被误读成自己的机器 */}
                      <div className="runtime-connection-note">
                        {t('runtimeConnectionsPerspective', { host: runtimeHostLabel })}
                      </div>
                      <div className="runtime-connection-header">
                        <span>#</span>
                        <span>{t('runtimeConnectionLocal')}</span>
                        <span>{t('runtimeConnectionRemote')}</span>
                      </div>

                      {runtimeConnections?.items.length ? (
                        <div className="runtime-connection-table">
                          {runtimeConnections.items.map((item, index) => (
                            <div
                              className="runtime-connection-row"
                              key={`${item.local}-${item.remote}-${index}`}
                              title={`${item.local} ↔ ${item.remote}`}
                            >
                              <span className="runtime-connection-rank">{index + 1}</span>
                              <span className="runtime-connection-addr">
                                {/* SSH 管理连接带标签置顶，与主行 TCP/SSH 计数口径一致 */}
                                {item.isSsh ? <em className="runtime-connection-ssh-tag">SSH</em> : null}
                                {item.local}
                              </span>
                              <span className="runtime-connection-addr">{item.remote}</span>
                            </div>
                          ))}
                          {/* 远端连接数超出单次采集上限时提示剩余条数，避免列表被误读为全量 */}
                          {runtimeConnections.total > runtimeConnections.items.length ? (
                            <div className="runtime-resource-empty">
                              {t('runtimeConnectionsOmitted', { count: runtimeConnections.total - runtimeConnections.items.length })}
                            </div>
                          ) : null}
                        </div>
                      ) : runtimeConnectionsLoading ? (
                        <div className="runtime-resource-empty">
                          {t('panelRefreshing')}
                        </div>
                      ) : runtimeConnectionsError || !runtimeConnectionsLoading ? (
                        <div className="runtime-resource-empty">
                          {runtimeConnectionsError || t('runtimeConnectionsEmpty')}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {/* 系统版本信息跟随运行状态列表滚动，运行区被拖小时不会固定占位压住运行时长。 */}
            <div className="runtime-extra">
              <span>{runtimeOverview?.os ?? '--'}</span>
            </div>
          </div>
        </section>

        <div
          className="resize-handle resize-handle-sidebar-horizontal"
          onPointerDown={(event) => {
            const startHeight = runtimePanelHeight;
            beginResize(event, (moveEvent, _startX, startY) => {
              setRuntimePanelHeight(clamp(startHeight + (moveEvent.clientY - startY), sidebarRuntimeMinHeight, resolveRuntimePanelMaxHeight()));
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
                <ChevronUp size={14} />
                {t('up')}
              </button>
              <button className="secondary-button slim" disabled={!hasActiveRemoteSession} onClick={() => void refreshFiles()} title={t('refresh')} type="button">
                {/* 文件刷新进行中时图标旋转，提示后台正在拉取目录。 */}
                <RefreshCw className={filesLoading ? 'is-spinning' : ''} size={14} />
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
              <button
                className="secondary-button slim address-go-button"
                disabled={!hasActiveRemoteSession}
                onClick={() => void refreshFiles(pathInput.trim() || '~')}
                title={t('goToPath')}
                type="button"
              >
                {/* 重要逻辑：使用 CornerDownLeft ↩︎ 图标作为前往按钮，文字收起以提高美观度，悬浮显示前往 */}
                <CornerDownLeft size={14} />
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
                    // 文件表格列宽通常较窄，悬浮提示必须复用单元格展示文本，避免省略号场景下看到不同格式。
                    const fileSizeLabel = file.isDir ? '' : formatBytes(file.size);
                    const fileTypeLabel = formatFileType(file, t('directoryLabel'), t('symlinkLabel'), t('fileLabel'));
                    const fileModifiedAtLabel = formatTimestamp(file.modifiedAt);
                    const filePermissionLabel = file.permissions ?? '--';
                    const fileOwnerGroupLabel = formatOwnerGroup(file);
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
                          <span className="explorer-name" title={file.name}>
                            <Icon size={16} />
                            <strong>{file.name}</strong>
                          </span>
                          <span title={fileSizeLabel || undefined}>{fileSizeLabel}</span>
                          <span title={fileTypeLabel}>{fileTypeLabel}</span>
                          <span title={fileModifiedAtLabel}>{fileModifiedAtLabel}</span>
                          <span title={filePermissionLabel}>{filePermissionLabel}</span>
                          <span title={fileOwnerGroupLabel}>{fileOwnerGroupLabel}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : filesLoading ? (
                // 列表为空且正在加载时显示刷新动画，而不是直接闪出“空目录”文案。
                <div className="panel-loading-overlay is-inline">
                  <RefreshCw className="is-spinning" size={18} />
                  <span>{t('panelRefreshing')}</span>
                </div>
              ) : (
                <div className="empty-state">{t('remoteFilesEmpty')}</div>
              )}
            </div>
          </div>
        </section>
      </aside>
      ) : null}

      {fileContextMenu ? (() => {
          // 复制/复制名称作用于选区（右键命中已选中项时）或单个右键目标；粘贴仅在同连接有暂存内容时可用。
          const menuPaths = selectedFilePathSet.has(fileContextMenu.file.path) ? selectedFilePaths : [fileContextMenu.file.path];
          const canPaste = Boolean(fileClipboard && fileClipboard.connectionId === activeConnectionId && fileClipboard.paths.length);
          return (
          <div ref={fileContextMenuRef} className="context-menu file-context-menu" style={{ left: fileContextMenu.x, top: fileContextMenu.y }} onClick={(event) => event.stopPropagation()}>
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
            <div className="context-menu-item has-submenu" tabIndex={0}>
              <span className="context-menu-item-label"><Copy size={14} /> {t('fileMenuCopyName')}</span>
              <ChevronRight className="context-submenu-caret" size={12} />
              <div className={`context-menu file-context-menu context-submenu${copyNameSubmenuFlipLeft ? ' flip-left' : ''}`}>
                <button className="context-menu-item" onClick={() => copyFileNameToClipboard(fileContextMenu.file.name)} type="button">{t('fileMenuCopyFileName')}</button>
                <button className="context-menu-item" onClick={() => copyFileNameToClipboard(fileContextMenu.file.path)} type="button">{t('fileMenuCopyFullPath')}</button>
              </div>
            </div>
            <button className="context-menu-item" onClick={() => copyRemoteSelection(menuPaths)} type="button">
              {t('fileMenuCopy')}{menuPaths.length > 1 ? ` (${menuPaths.length})` : ''}
            </button>
            <button className="context-menu-item" disabled={!canPaste} onClick={pasteRemoteClipboard} type="button">{t('fileMenuPaste')}</button>
            <button className="context-menu-item" onClick={() => {
              const nextName = window.prompt(t('rename'), fileContextMenu.file.name);
              if (nextName) {
                void renameRemotePath(fileContextMenu.file.path, nextName);
              }
              setFileContextMenu(null);
            }} type="button">{t('fileMenuRename')}</button>
            <button className="context-menu-item danger" onClick={() => {
              deleteSelectedRemotePaths(menuPaths);
            }} type="button">{t('fileMenuDelete')}</button>
          </div>
          );
        })() : null}

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
                <button className="context-menu-item" onClick={() => duplicateSession(sessionContextSession)} type="button">
                  <CopyPlus size={14} /> {t('duplicateSession')}
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
            <div className="session-tab-scroll-shell">
              <div
                className={`tab-list session-tab-list ${
                  sessionTabDropTarget && 'type' in sessionTabDropTarget && sessionTabDropTarget.type === 'end' ? 'is-drop-end' : ''
                }`}
                onScroll={handleSessionTabScroll}
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
                        {session.kind === 'local' && getLocalTerminalIcon(session.title, session.localCommand ?? '') ? (
                          <img
                            src={getLocalTerminalIcon(session.title, session.localCommand ?? '')!}
                            className="session-status-icon-image"
                            alt=""
                            title={translateStatus(settings.uiLanguage, session.status)}
                          />
                        ) : (
                          <span
                            aria-label={translateStatus(settings.uiLanguage, session.status)}
                            className={sessionStatusClassName(session.status)}
                            title={translateStatus(settings.uiLanguage, session.status)}
                          />
                        )}
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
              {sessionTabScrollbar.visible ? (
                <div
                  aria-hidden="true"
                  className="session-tab-scrollbar"
                  onPointerCancel={finishSessionTabScrollbarDrag}
                  onPointerDown={startSessionTabScrollbarDrag}
                  onPointerMove={handleSessionTabScrollbarPointerMove}
                  onPointerUp={finishSessionTabScrollbarDrag}
                >
                  <div
                    className="session-tab-scrollbar-thumb"
                    style={{
                      transform: `translateX(${sessionTabScrollbar.thumbLeft}px)`,
                      width: sessionTabScrollbar.thumbWidth,
                    }}
                  />
                </div>
              ) : null}
            </div>
          </div>

          <div className="workspace-toolbar-actions">
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
          <Suspense fallback={<div className="terminal-startup-placeholder">{t('working')}</div>}>
            <TerminalWorkspace
              session={activeSession}
              settings={settings}
              liveSessionIds={sessionIds}
              onTerminalData={(data) => {
                if (!activeSessionId) {
                  return;
                }
                void sendTerminalData(activeSessionId, data);
              }}
              onTerminalProtocolData={(sessionId, data) => {
                // 能力查询可能来自后台标签；使用事件自带会话 ID，避免切换标签时把回包写入另一条 PTY。
                void sendTerminalData(sessionId, data);
              }}
              onUpdateSettings={(partial) => {
                // 行号栏右键切换的显示项直接落盘持久化，保证重启和多端同步后仍生效。
                void persistSettings({ ...settings, ...partial }).catch(() => undefined);
              }}
            />
          </Suspense>

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
                    {/* 历史刷新进行中时图标旋转，提示后台正在读取远端历史。 */}
                    <RefreshCw className={historyLoading ? 'is-spinning' : ''} size={14} /> {renderActionButtonLabel(t('refresh'), bottomPanelNeedsCompactActions)}
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
                          {/* 命令保留换行以完整显示长命令；右侧执行时间恒定单行右对齐，无真实时间时显示占位符。 */}
                          <strong>{item.command}</strong>
                          <span>{item.executedAt ? new Date(item.executedAt).toLocaleString() : '—'}</span>
                        </button>
                      ))
                    ) : historyLoading ? (
                      // 历史为空且正在加载时显示刷新动画，避免先闪一下“无历史”再出现列表。
                      <div className="panel-loading-overlay is-inline">
                        <RefreshCw className="is-spinning" size={18} />
                        <span>{t('panelRefreshing')}</span>
                      </div>
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

      {/* AI 侧栏默认收起时不创建重组件；展开后的页签切换仍只隐藏 DOM，保留流式对话状态。 */}
      <>
        {(!agentSidebarCollapsed || agentSidebarMounted) ? <>
        <div
          className={`resize-handle resize-handle-main resize-handle-agent-sidebar ${agentSidebarCollapsed ? 'is-hidden' : ''}`}
          onPointerDown={(event) => {
            const startWidth = agentSidebarWidth;
            beginResize(event, (moveEvent, startX) => {
              setAgentSidebarWidth(clamp(
                startWidth + (startX - moveEvent.clientX),
                sidePanelMinWidth,
                resolveSidePanelMaxWidth(!sidebarCollapsed, sidebarWidth, true),
              ));
            });
          }}
        />
        <aside
          className={`agent-sidebar card ${agentSidebarCollapsed ? 'is-hidden' : ''}`}
          style={{ minWidth: sidePanelMinWidth, width: agentSidebarWidth }}
        >
          <header className="agent-sidebar-header panel-tab-row">
            <div className="tab-list">
              <button
                className={`panel-tab ${agentSidebarTab === 'chat' ? 'is-active' : ''}`}
                onClick={() => setAgentSidebarTab('chat')}
                type="button"
              >
                <Bot size={16} />
                <span>{t('panelAgentChat')}</span>
              </button>
              <button
                className={`panel-tab ${agentSidebarTab === 'requests' ? 'is-active' : ''}`}
                onClick={() => setAgentSidebarTab('requests')}
                type="button"
              >
                <ShieldCheck size={16} />
                <span>{t('panelAgentRequests')}</span>
              </button>
            </div>
            {agentSidebarTab === 'requests' ? (
              <button className="secondary-button slim" onClick={() => clearAgentBridgeRequests()} type="button">
                <Trash2 size={14} /> {t('clearAgentBridgeRequests')}
              </button>
            ) : null}
          </header>
          <div ref={agentSidebarBodyRef} className="agent-sidebar-body">
            <div className={`agent-sidebar-tab-panel ${agentSidebarTab === 'chat' ? '' : 'is-hidden'}`}>
              <Suspense fallback={<div className="empty-state">{t('working')}</div>}>
                <AgentChatPanel
                  approvalRequests={agentChatApprovalRequests}
                  codeFontFamily={buildPreviewFontFamily(settings)}
                  fontFamily={buildAgentChatFontFamily(
                    // 对话字体独立于终端：未单独配置（空字体 / 0 字号）时回落到终端对应设置。
                    settings.agentChatLatinFontFamily || settings.shellLatinFontFamily || settings.shellFontFamily,
                    settings.agentChatCjkFontFamily || settings.shellCjkFontFamily || settings.shellLatinFontFamily || settings.shellFontFamily,
                  )}
                  fontSize={settings.agentChatFontSize || settings.shellFontSize}
                  onApproveRequest={approveAgentBridgeRequest}
                  onRejectRequest={rejectAgentBridgeRequest}
                  providers={agentProviders}
                  t={t}
                />
              </Suspense>
            </div>
            <div className={`agent-sidebar-tab-panel ${agentSidebarTab === 'requests' ? '' : 'is-hidden'}`}>
              {agentRequestPanel}
            </div>
          </div>
        </aside>
        </> : null}
      </>
      </div>

      <ConnectionManagerModal open={connectionsOpen} onClose={() => setConnectionsOpen(false)} />
      <LocalTerminalManagerModal open={localTerminalsOpen} onClose={() => setLocalTerminalsOpen(false)} />
      <SettingsModal
        activeTab={settingsTab}
        onAgentProvidersSaved={setAgentProviders}
        onClose={() => setSettingsOpen(false)}
        onTabChange={setSettingsTab}
        open={settingsOpen}
      />
      <UpdateModal
        checkError={appUpdateCheckError}
        downloading={appUpdateInstalling}
        error={appUpdateError}
        onClose={() => {
          setAppUpdateModalOpen(false);
          setAppUpdateProgress(null);
          setAppUpdateError(null);
          setAppUpdateCheckError(null);
        }}
        onDownload={() => void handleAppInstallUpdate()}
        onOpenRelease={(url) => openAppExternalLink(url)}
        open={appUpdateModalOpen}
        progress={appUpdateProgress}
        result={updateCheckResult}
        t={t}
      />
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
