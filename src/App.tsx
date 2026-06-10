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
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import {
  Activity,
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
import type { AppSettings, ConnectionDraft, ConnectionProfile, RemoteFileEntry, SessionStatus, TerminalSession, UiLanguage, UpdateCheckResult } from './types';

const MonacoEditor = lazy(() => import('./MonacoEditor'));

type BottomPanelTab = 'commands' | 'tunnels' | 'history';
type SettingsTab = 'appearance' | 'sync' | 'about';
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

  return undefined;
};

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

// 只有真实可用的远端会话才驱动文件、运行状态和历史刷新，断开/异常会话只保留标签用于查看终端残留内容。
const isUsableRemoteSession = (status?: SessionStatus) => status === 'connected' || status === 'stub';

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

function ConnectionFormModal() {
  const [revealPassword, setRevealPassword] = useState(false);
  const [revealPassphrase, setRevealPassphrase] = useState(false);
  const [groupPickerOpen, setGroupPickerOpen] = useState(false);
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

  if (!showConnectionForm) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <div className="modal card">
        <div className="modal-header">
          <div>
            <h3>{connectionDraft.id ? t('connectionModalEditTitle') : t('connectionModalNewTitle')}</h3>
          </div>
          <button className="icon-button" onClick={closeConnectionForm} type="button">
            <X size={18} />
          </button>
        </div>

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
            <select value={connectionDraft.authMethod} onChange={(event) => updateConnectionDraft('authMethod', event.target.value)}>
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

        {validationKey ? <p className="field-hint validation-hint">{t(validationKey)}</p> : null}
        {connectionTestResult ? (
          <p className={`field-hint connection-test-result ${connectionTestResult.kind === 'error' ? 'is-error' : 'is-success'}`}>
            {connectionTestResult.message}
          </p>
        ) : null}

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
            <h3>{t('tunnelModalTitle')}</h3>
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

    return orderedConnections.filter((connection) => {
      return isConnectionGroupOrChildPath(connection.groupPath, selectedGroupPath);
    });
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
            <button className="primary-button" onClick={() => openConnectionForm()} type="button">
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
                      <div className="connection-table-actions">
                        <button className="ghost-button slim" onClick={() => {
                          // 管理弹窗先关闭，再启动会话；避免连接建立时的状态刷新和弹窗布局同时竞争渲染。
                          onClose();
                          void openSession(connection.id);
                        }} type="button">
                          {t('connect')}
                        </button>
                        <button className="ghost-button slim" onClick={() => openConnectionForm(connection)} type="button">
                          {t('edit')}
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
    installUpdate,
    settings,
    testWebdavConnection,
    uploadSettings,
    downloadSettings,
    uploadConnections,
    downloadConnections,
    exportLocalConfig,
    importLocalConfig,
    persistSettings,
  } = useAppStore();
  const [revealWebdavPassword, setRevealWebdavPassword] = useState(false);
  const [settingsSaveMessage, setSettingsSaveMessage] = useState('');
  const [settingsActionRunning, setSettingsActionRunning] = useState('');
  const [draftSettings, setDraftSettings] = useState<AppSettings>(settings);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateCheckResult, setUpdateCheckResult] = useState<UpdateCheckResult | null>(null);
  const [updateCheckError, setUpdateCheckError] = useState('');
  const settingsSaveTimerRef = useRef<number | null>(null);

  const t = (key: TranslationKey, replacements?: Record<string, string | number>) =>
    translate(draftSettings.uiLanguage ?? settings.uiLanguage, key, replacements);
  const appVersion = import.meta.env.VITE_APP_VERSION ?? '0.1.3';
  const webdavPasswordToggleLabel = revealWebdavPassword ? t('hideSecret') : t('showSecret');
  const selectedLatinFontFamily = draftSettings.shellLatinFontFamily || draftSettings.shellFontFamily.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '') || 'JetBrains Mono';
  const selectedCjkFontFamily = draftSettings.shellCjkFontFamily || selectedLatinFontFamily;
  const latinOptions = ensureFontOption(latinFontOptions, selectedLatinFontFamily);
  const cjkOptions = ensureFontOption(cjkFontOptions, selectedCjkFontFamily);
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
  const showSettingsFeedback = (message: string) => {
    setSettingsSaveMessage(message);
    if (settingsSaveTimerRef.current !== null) {
      window.clearTimeout(settingsSaveTimerRef.current);
    }
    // 设置反馈只短暂停留，避免把工具面板变成常驻通知区。
    settingsSaveTimerRef.current = window.setTimeout(() => {
      setSettingsSaveMessage('');
      settingsSaveTimerRef.current = null;
    }, 1800);
  };
  const persistSettingsWithFeedback = async () => {
    const saved = await persistSettings(draftSettings);
    setDraftSettings(saved);
    showSettingsFeedback(t('statusSettingsSaved'));
  };
  const runSettingsAction = async (actionKey: string, action: () => Promise<void>, successMessage?: string) => {
    setSettingsActionRunning(actionKey);
    setSettingsSaveMessage(t('working'));
    try {
      await action();
      showSettingsFeedback(successMessage ?? useAppStore.getState().statusMessage);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      showSettingsFeedback(t('statusWebdavActionFailed', { reason }));
    } finally {
      setSettingsActionRunning('');
    }
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
    setUpdateCheckError('');
    setUpdateCheckResult(null);
    try {
      // 更新检测只读取 GitHub Release 元数据，用户确认后再通过 Release 页面下载新版安装包。
      const result = await checkForUpdates();
      setUpdateCheckResult(result);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setUpdateCheckError(t('statusUpdateCheckFailed', { reason }));
    } finally {
      setUpdateChecking(false);
    }
  };
  const handleInstallUpdate = async () => {
    if (!updateCheckResult) {
      return;
    }

    setUpdateInstalling(true);
    setUpdateCheckError('');
    try {
      // 安装动作只在用户点击后触发；后端会下载 Release 安装包并启动安装程序。
      await installUpdate(updateCheckResult);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setUpdateCheckError(t('statusUpdateInstallFailed', { reason }));
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
    }
  }, [open, settings]);

  useEffect(() => {
    return () => {
      if (settingsSaveTimerRef.current !== null) {
        window.clearTimeout(settingsSaveTimerRef.current);
      }
    };
  }, []);

  if (!open) {
    return null;
  }

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
                <div>
                  <h3>{t('appearanceTitle')}</h3>
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
                </div>

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
                      {settingsSaveMessage ? <span className="inline-save-feedback">{settingsSaveMessage}</span> : null}
                      <button className="secondary-button" disabled={Boolean(settingsActionRunning)} onClick={() => void runSettingsAction('test-webdav', () => testWebdavConnection(draftSettings), t('statusWebdavTestPassed'))} type="button">
                        <RefreshCw size={16} /> {settingsActionRunning === 'test-webdav' ? t('working') : t('testWebdavConnection')}
                      </button>
                      <button className="primary-button" disabled={Boolean(settingsActionRunning)} onClick={() => void persistSettingsWithFeedback()} type="button">
                        <Save size={16} /> {t('saveWebdavSettings')}
                      </button>
                    </div>
                  </div>

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
                    <label>
                      <span>{t('webdavSettingsPath')}</span>
                      <input value={draftSettings.webdav.remoteSettingsPath} onChange={(event) => updateDraftSettings((current) => ({ ...current, webdav: { ...current.webdav, remoteSettingsPath: event.target.value } }))} />
                    </label>
                    <label>
                      <span>{t('webdavConnectionsPath')}</span>
                      <input value={draftSettings.webdav.remoteConnectionsPath} onChange={(event) => updateDraftSettings((current) => ({ ...current, webdav: { ...current.webdav, remoteConnectionsPath: event.target.value } }))} />
                    </label>
                  </div>
                </section>

                <section className="settings-section-block">
                  <div>
                    <h3>{t('webdavTransferTitle')}</h3>
                  </div>

                  <div className="sync-transfer-grid">
                    <div className="sync-transfer-card">
                      <strong>{t('webdavTransferSettings')}</strong>
                      <div className="sync-transfer-actions">
                        <button className="primary-button" disabled={Boolean(settingsActionRunning)} onClick={() => void runSettingsAction('upload-settings', async () => {
                          await persistSettings(draftSettings);
                          await uploadSettings();
                        }, t('statusUploadedSettings'))} type="button">
                          <Upload size={16} /> {settingsActionRunning === 'upload-settings' ? t('working') : t('uploadSettings')}
                        </button>
                        <button className="secondary-button" disabled={Boolean(settingsActionRunning)} onClick={() => void runSettingsAction('download-settings', async () => {
                          await downloadSettings();
                          setDraftSettings(useAppStore.getState().settings);
                        }, t('statusDownloadedSettings'))} type="button">
                          <Download size={16} /> {settingsActionRunning === 'download-settings' ? t('working') : t('downloadSettings')}
                        </button>
                      </div>
                    </div>
                    <div className="sync-transfer-card">
                      <strong>{t('webdavTransferConnections')}</strong>
                      <div className="sync-transfer-actions">
                        <button className="primary-button" disabled={Boolean(settingsActionRunning)} onClick={() => void runSettingsAction('upload-connections', async () => {
                          await persistSettings(draftSettings);
                          await uploadConnections();
                        }, t('statusUploadedConnections'))} type="button">
                          <Upload size={16} /> {settingsActionRunning === 'upload-connections' ? t('working') : t('uploadConnections')}
                        </button>
                        <button className="secondary-button" disabled={Boolean(settingsActionRunning)} onClick={() => void runSettingsAction('download-connections', downloadConnections, t('statusDownloadedConnections'))} type="button">
                          <Download size={16} /> {settingsActionRunning === 'download-connections' ? t('working') : t('downloadConnections')}
                        </button>
                      </div>
                    </div>
                  </div>
                </section>

                <section className="settings-section-block">
                  <div>
                    <h3>{t('syncSectionLocal')}</h3>
                  </div>

                  <div className="action-grid">
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
                  {settingsSaveMessage ? <div className="settings-action-feedback">{settingsSaveMessage}</div> : null}
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
                    <button
                      className="secondary-button"
                      onClick={() => openExternalLink('https://github.com/CrazyFigure/MyShell')}
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
                  {updateCheckError ? <div className="update-check-result is-error">{updateCheckError}</div> : null}
                </section>
              </div>
            ) : null}
          </div>
        </div>
      </div>
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
  const [bottomTabByConnection, setBottomTabByConnection] = useState<Record<string, BottomPanelTab>>({});
  const [pathInput, setPathInput] = useState('~');
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenuState | null>(null);
  const [sessionContextMenu, setSessionContextMenu] = useState<SessionContextMenuState | null>(null);
  const [sessionTabDragState, setSessionTabDragState] = useState<SessionTabDragState>(null);
  const [sessionTabDropTarget, setSessionTabDropTarget] = useState<SessionTabDropTarget>(null);
  const [selectedFilePath, setSelectedFilePath] = useState('');
  const [selectedFilePaths, setSelectedFilePaths] = useState<string[]>([]);
  const [cpuCoresExpanded, setCpuCoresExpanded] = useState(false);
  const [bottomDockCollapsed, setBottomDockCollapsed] = useState(false);
  const [transferProgressItems, setTransferProgressItems] = useState<TransferProgressItem[]>([]);
  const [explorerColumnWidths, setExplorerColumnWidths] = useState(explorerDefaultColumnWidths);
  const pathByConnectionRef = useRef<Record<string, string>>({});
  const runtimeRefreshInFlightRef = useRef(false);
  const sessionTabDragStateRef = useRef<SessionTabDragState>(null);
  const sessionTabDropTargetRef = useRef<SessionTabDropTarget>(null);
  const sessionTabListRef = useRef<HTMLDivElement | null>(null);

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
    downloadRemoteFile,
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
    startTunnel,
    tunnels,
    uploadLocalFile,
  } = useAppStore();

  const t = (key: TranslationKey, replacements?: Record<string, string | number>) =>
    translate(settings.uiLanguage, key, replacements);

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

    // 高频轮询用于降低远端 PTY 回显延迟；in-flight 保护避免慢请求堆叠。
    let outputPollInFlight = false;
    const pollOutputs = () => {
      if (outputPollInFlight) {
        return;
      }

      outputPollInFlight = true;
      void pollTerminalOutputs().finally(() => {
        outputPollInFlight = false;
      });
    };

    pollOutputs();
    const timer = window.setInterval(() => {
      pollOutputs();
    }, 80);
    return () => window.clearInterval(timer);
  }, [pollTerminalOutputs, sessions.length]);

  const activeSession = useMemo(() => sessions.find((item) => item.id === activeSessionId), [activeSessionId, sessions]);
  // 远端文件、运行状态和历史都必须绑定到已经打开的终端会话，避免仅选中连接时提前拉取远端数据。
  const hasActiveRemoteSession = isUsableRemoteSession(activeSession?.status);
  const activeRemoteConnectionId = hasActiveRemoteSession ? activeSession?.connectionId : undefined;
  const activeRemoteConnection = useMemo(
    () => connections.find((item) => item.id === activeRemoteConnectionId),
    [activeRemoteConnectionId, connections],
  );
  // 左上运行状态直接以主机 IP 作为标题，减少说明性文字占位，把空间留给终端和文件表格。
  const runtimeHostLabel = runtimeOverview?.host ?? activeRemoteConnection?.host ?? '--';
  const activeCommand = activeSessionId ? commandBuffers[activeSessionId] ?? '' : '';
  const activeBottomTab = activeRemoteConnectionId ? bottomTabByConnection[activeRemoteConnectionId] ?? 'commands' : 'commands';
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
  const copySessionConnection = useCallback((session?: TerminalSession) => {
    if (!session) {
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
  const connectionHistory = useMemo(
    () => history.filter((item) => (activeRemoteConnectionId ? item.connectionId === activeRemoteConnectionId : true)),
    [activeRemoteConnectionId, history],
  );
  const shellClassName = [
    'app-shell',
    `theme-${settings.themeMode}`,
    settings.compactSidebar ? 'compact-sidebar' : '',
    sidebarCollapsed ? 'sidebar-collapsed' : '',
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
  }, [activeRemoteConnectionId, activeSessionId, refreshFiles, refreshRuntimeOverviewOnce]);

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
  }, [files, selectedFilePath]);
  const uploadFileWithProgress = useCallback((file: File) => {
    void runTransferProgress(`${t('upload')} ${file.name}`, async (setPercent) => {
      setPercent(24);
      await uploadLocalFile(file);
      setPercent(92);
    });
  }, [runTransferProgress, t, uploadLocalFile]);
  const downloadFileWithProgress = useCallback((path: string) => {
    const fileName = path.split('/').filter(Boolean).at(-1) ?? path;
    void runTransferProgress(`${t('download')} ${fileName}`, async (setPercent) => {
      setPercent(22);
      await downloadRemoteFile(path);
      setPercent(92);
    });
  }, [downloadRemoteFile, runTransferProgress, t]);
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

  return (
    <div className={shellClassName}>
      {!sidebarCollapsed ? (
      <aside className="sidebar card" style={{ width: sidebarWidth }}>
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

        <section className="sidebar-panel explorer-panel">
          <div className="explorer-toolbar">
            <div className="explorer-toolbar-actions">
              <label className="secondary-button slim file-upload-button" title={t('upload')}>
                <Upload size={14} />
                <input
                  className="hidden-file-input"
                  disabled={!hasActiveRemoteSession}
                  type="file"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      uploadFileWithProgress(file);
                    }
                    event.currentTarget.value = '';
                  }}
                />
              </label>
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
              className="explorer-list"
              onKeyDown={handleExplorerKeyDown}
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
                files.map((file) => {
                  const Icon = fileLabelIcon(file);
                  return (
                    <div
                      key={file.path}
                      className={`explorer-row ${selectedFilePaths.includes(file.path) ? 'is-selected' : ''}`}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        if (!selectedFilePaths.includes(file.path)) {
                          setSelectedFilePath(file.path);
                          setSelectedFilePaths([file.path]);
                        }
                        setFileContextMenu({ file, x: event.clientX, y: event.clientY });
                      }}
                      onDoubleClick={() => openRemoteFileEntry(file)}
                    >
                      <button
                        className="explorer-row-main"
                        disabled={!hasActiveRemoteSession}
                        onClick={(event) => selectExplorerFile(file, event)}
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
                })
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
            {selectedFilePaths.includes(fileContextMenu.file.path) && selectedFilePaths.length > 1 ? (
              <button className="context-menu-item danger" onClick={() => deleteSelectedRemotePaths(selectedFilePaths)} type="button">
                {t('fileMenuDeleteSelected')} ({selectedFilePaths.length})
              </button>
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
            {!fileContextMenu.file.isDir ? (
              <button className="context-menu-item" onClick={() => {
                downloadFileWithProgress(fileContextMenu.file.path);
                setFileContextMenu(null);
              }} type="button">{t('fileMenuDownload')}</button>
            ) : null}
            <button className="context-menu-item" onClick={() => {
              const nextName = window.prompt(t('rename'), fileContextMenu.file.name);
              if (nextName) {
                void renameRemotePath(fileContextMenu.file.path, nextName);
              }
              setFileContextMenu(null);
            }} type="button">{t('fileMenuRename')}</button>
            <button className="context-menu-item danger" onClick={() => {
              const paths = selectedFilePaths.includes(fileContextMenu.file.path) ? selectedFilePaths : [fileContextMenu.file.path];
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
            return (
              <>
                <button className="context-menu-item" onClick={() => closeSessionBatch([sessionContextSession.id])} type="button">
                  <X size={14} /> {t('closeSessionAction')}
                </button>
                <button className="context-menu-item" disabled={!leftSessionIds.length} onClick={() => closeSessionBatch(leftSessionIds)} type="button">
                  <X size={14} /> {t('closeSessionsLeft')}
                </button>
                <button className="context-menu-item" disabled={!rightSessionIds.length} onClick={() => closeSessionBatch(rightSessionIds)} type="button">
                  <X size={14} /> {t('closeSessionsRight')}
                </button>
                <button className="context-menu-item" disabled={!otherSessionIds.length} onClick={() => closeSessionBatch(otherSessionIds)} type="button">
                  <X size={14} /> {t('closeOtherSessions')}
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
              setSidebarWidth(clamp(startWidth + (moveEvent.clientX - startX), 320, Math.min(window.innerWidth * 0.58, 560)));
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
                const sessionLabel = connections.find((item) => item.id === session.connectionId)?.name ?? session.title;
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
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="workspace-toolbar-actions">
            <button className="secondary-button" onClick={() => setConnectionsOpen(true)} type="button">
              <FolderTree size={16} /> {t('manageConnections')}
            </button>
            <button
              className="secondary-button"
              onClick={() => {
                setSettingsTab('appearance');
                setSettingsOpen(true);
              }}
              type="button"
            >
              <Settings size={16} /> {t('openSettings')}
            </button>
            <button className="primary-button" onClick={() => openConnectionForm()} type="button">
              <Plus size={16} /> {t('newConnection')}
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
              <div className="panel-tab-actions">
                <button
                  className="secondary-button slim"
                  onClick={() => setBottomDockCollapsed((current) => !current)}
                  title={bottomDockCollapsed ? t('expandBottomDock') : t('collapseBottomDock')}
                  type="button"
                >
                  {bottomDockCollapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  <span>{bottomDockCollapsed ? t('expandBottomDock') : t('collapseBottomDock')}</span>
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
                    type="button"
                  >
                    <Play size={16} /> {t('sendToTerminal')}
                  </button>
                ) : null}
                {activeBottomTab === 'tunnels' ? (
                  <>
                    <button
                      className="secondary-button"
                      disabled={!connectionTunnels.some((item) => item.status !== 'running')}
                      onClick={() => {
                        void Promise.all(connectionTunnels.filter((item) => item.status !== 'running').map((item) => startTunnel(item.id))).then(() => {
                          setStatusMessage(t('statusAllTunnelsStarted'));
                        });
                      }}
                      type="button"
                    >
                      <Play size={16} /> {t('tunnelStartAll')}
                    </button>
                    <button
                      className="secondary-button"
                      disabled={!connectionTunnels.some((item) => item.status === 'running')}
                      onClick={() => {
                        void Promise.all(connectionTunnels.filter((item) => item.status === 'running').map((item) => closeTunnel(item.id))).then(() => {
                          setStatusMessage(t('statusAllTunnelsStopped'));
                        });
                      }}
                      type="button"
                    >
                      <Square size={16} /> {t('tunnelStopAll')}
                    </button>
                    <button className="primary-button" disabled={!activeConnectionId} onClick={() => void openTunnel()} type="button">
                      <Plus size={16} /> {t('newTunnel')}
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
                    type="button"
                  >
                    <RefreshCw size={14} /> {t('refresh')}
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

      <ConnectionManagerModal open={connectionsOpen} onClose={() => setConnectionsOpen(false)} />
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
