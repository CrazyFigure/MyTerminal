import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  Activity,
  Cable,
  Download,
  Eye,
  EyeOff,
  FileCode2,
  FileSymlink,
  FileText,
  Folder,
  FolderOpen,
  FolderTree,
  GripVertical,
  HardDrive,
  History,
  MemoryStick,
  Pencil,
  Play,
  Plus,
  RefreshCw,
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
import { useAppStore } from './store';
import type { ConnectionDraft, ConnectionProfile, RemoteFileEntry, SessionStatus, UiLanguage } from './types';

const MonacoEditor = lazy(() => import('./MonacoEditor'));

type BottomPanelTab = 'commands' | 'tunnels' | 'history';
type SettingsTab = 'appearance' | 'sync';
type FileContextMenuState = {
  file: RemoteFileEntry;
  x: number;
  y: number;
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

const replaceLastLine = (value: string, nextLine: string) => {
  const lines = value.split(/\r?\n/);
  lines[lines.length - 1] = nextLine;
  return lines.join('\n');
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

// 拖拽排序只移动现有项位置，不改写路径含义；目标项作为插入锚点使用。
const moveItemBefore = (items: string[], source: string, target: string) => {
  if (source === target) {
    return items;
  }

  const nextItems = items.filter((item) => item !== source);
  const targetIndex = nextItems.indexOf(target);
  if (targetIndex < 0) {
    return nextItems;
  }

  nextItems.splice(targetIndex, 0, source);
  return nextItems;
};

// 分组支持父子路径，拖动父分组时要把子分组作为一个块一起移动，避免树结构被排序拆散。
const moveGroupBlockBefore = (groupPaths: string[], source: string, target: string) => {
  if (source === target || isConnectionGroupOrChildPath(target, source)) {
    return groupPaths;
  }

  const sourceBlock = groupPaths.filter((path) => path === source || path.startsWith(`${source}/`));
  const remaining = groupPaths.filter((path) => !sourceBlock.includes(path));
  const targetIndex = remaining.indexOf(target);
  if (targetIndex < 0) {
    return remaining;
  }

  remaining.splice(targetIndex, 0, ...sourceBlock);
  return remaining;
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
            className={`connection-group-row ${selectedPath === node.path ? 'is-selected' : ''} ${dragState?.type === 'group' && dragState.path === node.path ? 'is-dragging' : ''}`}
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
  const dragStateRef = useRef<ConnectionManagerDragState>(null);
  const managerWasOpenRef = useRef(false);
  const {
    connections,
    createConnectionGroup,
    deleteConnection,
    deleteConnectionGroup,
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
    void moveConnectionToGroup(connectionId, groupPath === ungroupedGroupPath ? undefined : groupPath);
  };
  const handleReorderGroup = (sourcePath: string, targetPath: string) => {
    setDragState(null);
    void reorderConnectionGroups(moveGroupBlockBefore(orderedGroupPaths, sourcePath, targetPath));
  };
  const handleReorderConnection = (sourceId: string, targetId: string) => {
    setDragState(null);
    const currentIds = orderedConnections.map((connection) => connection.id);
    void reorderConnections(moveItemBefore(currentIds, sourceId, targetId));
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
    if (!open) {
      managerWasOpenRef.current = false;
      setDragState(null);
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
      setDragState((current) => (current ? { ...current, currentX: event.clientX, currentY: event.clientY } : current));
    };

    const handlePointerUp = (event: PointerEvent) => {
      const currentDrag = dragStateRef.current;
      if (!currentDrag) {
        setDragState(null);
        return;
      }

      const target = document.elementFromPoint(event.clientX, event.clientY);
      const targetConnection = target?.closest<HTMLElement>('[data-connection-id]');
      const targetGroup = target?.closest<HTMLElement>('[data-group-path]');
      const targetUngrouped = target?.closest<HTMLElement>('[data-ungrouped-drop-target]');

      // 落点按最具体的连接行优先，其次分组行，最后是固定的未分组入口。
      if (currentDrag.type === 'connection') {
        const targetConnectionId = targetConnection?.dataset.connectionId;
        const targetGroupPath = targetGroup?.dataset.groupPath;
        if (targetConnectionId && targetConnectionId !== currentDrag.id) {
          handleReorderConnection(currentDrag.id, targetConnectionId);
          return;
        }
        if (targetGroupPath) {
          handleDropConnectionToGroup(currentDrag.id, targetGroupPath);
          return;
        }
        if (targetUngrouped) {
          handleDropConnectionToGroup(currentDrag.id, ungroupedGroupPath);
          return;
        }
      }

      if (currentDrag.type === 'group') {
        const targetGroupPath = targetGroup?.dataset.groupPath;
        if (targetGroupPath && targetGroupPath !== currentDrag.path) {
          handleReorderGroup(currentDrag.path, targetGroupPath);
          return;
        }
      }

      setDragState(null);
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
          <aside className="connection-groups-sidebar">
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
              onStartGroupDrag={(event, path, label) => startConnectionManagerDrag(event, { type: 'group', path, label })}
              deleteLabel={t('deleteGroup')}
              editLabel={t('editGroup')}
            />
            <div
              data-ungrouped-drop-target="true"
              className={`connection-group-row connection-group-row-ungrouped ${selectedGroupPath === ungroupedGroupPath ? 'is-selected' : ''}`}
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
              <div className="connection-table-header">
                <span />
                <span>{t('fieldName')}</span>
                <span>{t('fieldHost')}</span>
                <span>{t('fieldPort')}</span>
                <span>{t('fieldUsername')}</span>
                <span>{t('fieldActions')}</span>
              </div>

              <div className="connection-table-body">
                {visibleConnections.length ? (
                  visibleConnections.map((connection) => (
                    <div
                      key={connection.id}
                      data-connection-id={connection.id}
                      className={`connection-table-row ${dragState?.type === 'connection' && dragState.id === connection.id ? 'is-dragging' : ''}`}
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
                        <button className="ghost-button slim" onClick={() => void openSession(connection.id).then(onClose)} type="button">
                          {t('connect')}
                        </button>
                        <button className="ghost-button slim" onClick={() => openConnectionForm(connection)} type="button">
                          {t('edit')}
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

function EditorModal() {
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
            <button className="primary-button" onClick={() => void saveEditorDocument()} type="button">
              <Save size={16} />
              {editorDocument.dirty ? t('saveToRemote') : t('saved')}
            </button>
          </div>
        </div>

        <div className="editor-shell modal-editor-shell">
          <Suspense fallback={<div className="empty-state">{t('working')}</div>}>
            <MonacoEditor
              fontFamily={settings.shellFontFamily}
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
  const [revealWebdavPassword, setRevealWebdavPassword] = useState(false);
  const [settingsSaveMessage, setSettingsSaveMessage] = useState('');
  const settingsSaveTimerRef = useRef<number | null>(null);
  const {
    settings,
    updateSettings,
    uploadSettings,
    downloadSettings,
    uploadConnections,
    downloadConnections,
    exportLocalConfig,
    importLocalConfig,
    persistSettings,
  } = useAppStore();

  const t = (key: TranslationKey, replacements?: Record<string, string | number>) =>
    translate(settings.uiLanguage, key, replacements);
  const webdavPasswordToggleLabel = revealWebdavPassword ? t('hideSecret') : t('showSecret');
  const persistSettingsWithFeedback = async () => {
    await persistSettings();
    setSettingsSaveMessage(t('statusSettingsSaved'));
    if (settingsSaveTimerRef.current !== null) {
      window.clearTimeout(settingsSaveTimerRef.current);
    }
    // 保存反馈只短暂停留，避免设置面板常驻状态文字占用操作区。
    settingsSaveTimerRef.current = window.setTimeout(() => {
      setSettingsSaveMessage('');
      settingsSaveTimerRef.current = null;
    }, 1800);
  };

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
                    <select value={settings.themeMode} onChange={(event) => updateSettings((current) => ({ ...current, themeMode: event.target.value as 'light' | 'dark' }))}>
                      <option value="light">{t('light')}</option>
                      <option value="dark">{t('dark')}</option>
                    </select>
                  </label>
                  <label>
                    <span>{t('fieldLanguage')}</span>
                    <select value={settings.uiLanguage} onChange={(event) => updateSettings((current) => ({ ...current, uiLanguage: event.target.value as UiLanguage }))}>
                      <option value="zh-CN">{t('languageZhCn')}</option>
                      <option value="en-US">{t('languageEnUs')}</option>
                    </select>
                  </label>
                  <label>
                    <span>{t('fieldFontFamily')}</span>
                    <input value={settings.shellFontFamily} onChange={(event) => updateSettings((current) => ({ ...current, shellFontFamily: event.target.value }))} />
                  </label>
                  <label>
                    <span>{t('fieldFontSize')}</span>
                    <input type="number" value={settings.shellFontSize} onChange={(event) => updateSettings((current) => ({ ...current, shellFontSize: Number(event.target.value) || 15 }))} />
                  </label>
                  <label>
                    <span>{t('fieldRuntimeRefreshInterval')}</span>
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={settings.runtimeRefreshIntervalSec}
                      onChange={(event) =>
                        updateSettings((current) => ({
                          ...current,
                          runtimeRefreshIntervalSec: Number(event.target.value) || 1,
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>{t('fieldTerminalBackground')}</span>
                    <input type="color" value={settings.terminalBackground} onChange={(event) => updateSettings((current) => ({ ...current, terminalBackground: event.target.value }))} />
                  </label>
                  <label>
                    <span>{t('fieldTerminalForeground')}</span>
                    <input type="color" value={settings.terminalForeground} onChange={(event) => updateSettings((current) => ({ ...current, terminalForeground: event.target.value }))} />
                  </label>
                  <label>
                    <span>{t('fieldAccentColor')}</span>
                    <input type="color" value={settings.accentColor} onChange={(event) => updateSettings((current) => ({ ...current, accentColor: event.target.value }))} />
                  </label>
                  <label className="span-2">
                    <span>{t('fieldBackgroundImage')}</span>
                    <input value={settings.backgroundImage ?? ''} onChange={(event) => updateSettings((current) => ({ ...current, backgroundImage: event.target.value }))} />
                  </label>
                  <label className="toggle-row span-2">
                    <span>{t('fieldCompactSidebar')}</span>
                    <input type="checkbox" checked={settings.compactSidebar} onChange={(event) => updateSettings((current) => ({ ...current, compactSidebar: event.target.checked }))} />
                  </label>
                  <label className="toggle-row span-2">
                    <span>{t('fieldGhostSuggestions')}</span>
                    <input type="checkbox" checked={settings.showCommandGhost} onChange={(event) => updateSettings((current) => ({ ...current, showCommandGhost: event.target.checked }))} />
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
                      <button className="primary-button" onClick={() => void persistSettingsWithFeedback()} type="button">
                      <Save size={16} /> {t('saveWebdavSettings')}
                      </button>
                    </div>
                  </div>

                  <div className="form-grid">
                    <label className="span-2">
                      <span>{t('webdavBaseUrl')}</span>
                      <input value={settings.webdav.baseUrl} onChange={(event) => updateSettings((current) => ({ ...current, webdav: { ...current.webdav, baseUrl: event.target.value } }))} />
                    </label>
                    <label>
                      <span>{t('fieldUsername')}</span>
                      <input value={settings.webdav.username} onChange={(event) => updateSettings((current) => ({ ...current, webdav: { ...current.webdav, username: event.target.value } }))} />
                    </label>
                    <label>
                      <span>{t('fieldPassword')}</span>
                      <div className="password-field">
                        <input
                          type={revealWebdavPassword ? 'text' : 'password'}
                          value={settings.webdav.password}
                          onChange={(event) => updateSettings((current) => ({ ...current, webdav: { ...current.webdav, password: event.target.value } }))}
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
                      <input value={settings.webdav.remoteSettingsPath} onChange={(event) => updateSettings((current) => ({ ...current, webdav: { ...current.webdav, remoteSettingsPath: event.target.value } }))} />
                    </label>
                    <label>
                      <span>{t('webdavConnectionsPath')}</span>
                      <input value={settings.webdav.remoteConnectionsPath} onChange={(event) => updateSettings((current) => ({ ...current, webdav: { ...current.webdav, remoteConnectionsPath: event.target.value } }))} />
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
                        <button className="primary-button" onClick={() => void uploadSettings()} type="button">
                          <Upload size={16} /> {t('uploadSettings')}
                        </button>
                        <button className="secondary-button" onClick={() => void downloadSettings()} type="button">
                          <Download size={16} /> {t('downloadSettings')}
                        </button>
                      </div>
                    </div>
                    <div className="sync-transfer-card">
                      <strong>{t('webdavTransferConnections')}</strong>
                      <div className="sync-transfer-actions">
                        <button className="primary-button" onClick={() => void uploadConnections()} type="button">
                          <Upload size={16} /> {t('uploadConnections')}
                        </button>
                        <button className="secondary-button" onClick={() => void downloadConnections()} type="button">
                          <Download size={16} /> {t('downloadConnections')}
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
                    <button className="primary-button" onClick={() => void exportLocalConfig()} type="button">
                      <Download size={16} /> {t('exportLocalConfig')}
                    </button>
                    <label className="secondary-button file-upload-button">
                      <Upload size={16} /> {t('importLocalConfig')}
                      <input
                        accept="application/json,.json"
                        className="hidden-file-input"
                        type="file"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file && window.confirm(t('importLocalConfigConfirm'))) {
                            void importLocalConfig(file);
                          }
                          event.currentTarget.value = '';
                        }}
                      />
                    </label>
                  </div>
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
  const [runtimePanelHeight, setRuntimePanelHeight] = useState(128);
  const [bottomHeight, setBottomHeight] = useState(180);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('appearance');
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [bottomTabByConnection, setBottomTabByConnection] = useState<Record<string, BottomPanelTab>>({});
  const [pathInput, setPathInput] = useState('~');
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenuState | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState('');
  const [explorerColumnWidths, setExplorerColumnWidths] = useState(explorerDefaultColumnWidths);
  const pathByConnectionRef = useRef<Record<string, string>>({});
  const runtimeRefreshInFlightRef = useRef(false);

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
    deleteRemotePath,
    downloadRemoteFile,
    files,
    history,
    openConnectionForm,
    openRemoteFile,
    openTunnel,
    pollTerminalOutputs,
    refreshFiles,
    refreshRemoteHistory,
    refreshRuntimeOverview,
    renameRemotePath,
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
    const closeContextMenu = () => setFileContextMenu(null);
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFileContextMenu(null);
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
  const connectionTunnels = useMemo(
    () => (activeConnectionId ? tunnels.filter((item) => item.connectionId === activeConnectionId) : []),
    [activeConnectionId, tunnels],
  );
  const connectionHistory = useMemo(
    () => history.filter((item) => (activeRemoteConnectionId ? item.connectionId === activeRemoteConnectionId : true)),
    [activeRemoteConnectionId, history],
  );
  const commandSuggestions = useMemo(() => {
    const lastLine = activeCommand.split(/\r?\n/).at(-1)?.trim() ?? '';
    if (!settings.showCommandGhost || !lastLine) {
      return [];
    }

    return Array.from(
      new Set(
        connectionHistory
          .map((item) => item.command)
          .filter((command) => command.startsWith(lastLine) && command !== lastLine),
      ),
    ).slice(0, 6);
  }, [activeCommand, connectionHistory, settings.showCommandGhost]);

  const shellClassName = [
    'app-shell',
    `theme-${settings.themeMode}`,
    settings.compactSidebar ? 'compact-sidebar' : '',
    settings.backgroundImage?.trim() ? 'has-background' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const shellStyle = useMemo<CSSProperties | undefined>(() => {
    const backgroundImage = settings.backgroundImage?.trim();
    if (!backgroundImage) {
      return undefined;
    }

    const overlay =
      settings.themeMode === 'dark'
        ? 'linear-gradient(rgba(2, 6, 23, 0.78), rgba(15, 23, 42, 0.82))'
        : 'linear-gradient(rgba(255, 255, 255, 0.58), rgba(248, 250, 252, 0.76))';

    return {
      backgroundImage: `${overlay}, url("${backgroundImage}")`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
      backgroundAttachment: 'fixed',
    };
  }, [settings.backgroundImage, settings.themeMode]);
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
    { icon: Activity, label: t('metricCpu'), value: runtimeOverview?.cpu ?? t('metricUnavailable'), percent: parseMetricPercent(runtimeOverview?.cpu ?? '') },
    { icon: MemoryStick, label: t('metricMemory'), value: runtimeOverview?.memory ?? t('metricUnavailable'), percent: parseMetricPercent(runtimeOverview?.memory ?? '') },
    { icon: HardDrive, label: t('metricStorage'), value: runtimeOverview?.storage ?? t('metricUnavailable'), percent: parseMetricPercent(runtimeOverview?.storage ?? '') },
    { icon: RefreshCw, label: t('metricUptime'), value: runtimeOverview?.uptime ?? t('metricUnavailable'), percent: undefined },
  ];
  const openRemoteFileEntry = useCallback((file: RemoteFileEntry) => {
    // 打开动作统一从文件条目入口走，保证单击选中、双击打开和回车打开使用同一套规则。
    setSelectedFilePath(file.path);
    if (file.isDir) {
      void refreshFiles(file.path);
      return;
    }
    if (isEditableFile(file.path)) {
      void openRemoteFile(file.path);
      return;
    }
    void downloadRemoteFile(file.path);
  }, [downloadRemoteFile, openRemoteFile, refreshFiles]);
  const handleExplorerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!hasActiveRemoteSession || !files.length) {
      return;
    }

    const selectedIndex = files.findIndex((file) => file.path === selectedFilePath);
    const moveSelection = (nextIndex: number) => {
      event.preventDefault();
      setSelectedFilePath(files[clamp(nextIndex, 0, files.length - 1)].path);
    };

    // 文件列表只接管导航键和回车键，不影响终端本体的输入体验。
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
  }, [files, hasActiveRemoteSession, openRemoteFileEntry, selectedFilePath]);

  useEffect(() => {
    // 目录刷新或断开连接后清理悬空选择，避免键盘上下键落到上一个目录的旧文件。
    if (!hasActiveRemoteSession || (selectedFilePath && !files.some((file) => file.path === selectedFilePath))) {
      setSelectedFilePath('');
    }
  }, [files, hasActiveRemoteSession, selectedFilePath]);

  return (
    <div className={shellClassName} style={shellStyle}>
      <aside className="sidebar card" style={{ width: sidebarWidth }}>
        <section className="sidebar-panel runtime-panel" style={{ height: runtimePanelHeight }}>
          <div className="section-row runtime-header">
            <h3>{runtimeHostLabel}</h3>
            <button className="icon-button" disabled={!hasActiveRemoteSession} onClick={refreshRuntimeOverviewOnce} type="button">
              <RefreshCw size={16} />
            </button>
          </div>

          <div className="runtime-list">
            {runtimeItems.map(({ icon: Icon, label, percent, value }) => (
              <div key={label} className={`runtime-row metric-tone-${metricTone(percent)}`}>
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
              setRuntimePanelHeight(clamp(startHeight + (moveEvent.clientY - startY), 92, 240));
            });
          }}
        />

        <section className="sidebar-panel explorer-panel">
          <div className="explorer-toolbar">
            <div className="explorer-toolbar-actions">
              <button className="secondary-button slim" disabled={!hasActiveRemoteSession} onClick={() => void refreshFiles(parentPath(currentRemotePath))} type="button">
                {t('up')}
              </button>
              <span className="explorer-toolbar-spacer" />
              <label className="secondary-button slim file-upload-button" title={t('upload')}>
                <Upload size={14} />
                <input
                  className="hidden-file-input"
                  disabled={!hasActiveRemoteSession}
                  type="file"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      void uploadLocalFile(file);
                    }
                    event.currentTarget.value = '';
                  }}
                />
              </label>
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
                      className={`explorer-row ${selectedFilePath === file.path ? 'is-selected' : ''}`}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setSelectedFilePath(file.path);
                        setFileContextMenu({ file, x: event.clientX, y: event.clientY });
                      }}
                      onDoubleClick={() => openRemoteFileEntry(file)}
                    >
                      <button
                        className="explorer-row-main"
                        disabled={!hasActiveRemoteSession}
                        onClick={() => setSelectedFilePath(file.path)}
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

        {fileContextMenu ? (
          <div className="context-menu" style={{ left: fileContextMenu.x, top: fileContextMenu.y }} onClick={(event) => event.stopPropagation()}>
            {fileContextMenu.file.isDir ? (
              <button className="context-menu-item" onClick={() => {
                void refreshFiles(fileContextMenu.file.path);
                setFileContextMenu(null);
              }} type="button">{t('fileMenuOpen')}</button>
            ) : null}
            {!fileContextMenu.file.isDir && isEditableFile(fileContextMenu.file.path) ? (
              <button className="context-menu-item" onClick={() => {
                void openRemoteFile(fileContextMenu.file.path);
                setFileContextMenu(null);
              }} type="button">{t('fileMenuEdit')}</button>
            ) : null}
            {!fileContextMenu.file.isDir ? (
              <button className="context-menu-item" onClick={() => {
                void downloadRemoteFile(fileContextMenu.file.path);
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
              if (window.confirm(t('deleteConfirm', { path: fileContextMenu.file.path }))) {
                void deleteRemotePath(fileContextMenu.file.path);
              }
              setFileContextMenu(null);
            }} type="button">{t('fileMenuDelete')}</button>
          </div>
        ) : null}
      </aside>

      <div
        className="resize-handle resize-handle-main"
        onPointerDown={(event) => {
          const startWidth = sidebarWidth;
          beginResize(event, (moveEvent, startX) => {
            setSidebarWidth(clamp(startWidth + (moveEvent.clientX - startX), 320, Math.min(window.innerWidth * 0.58, 560)));
          });
        }}
      />

      <main className="workspace">
        <section className="workspace-toolbar card">
          <div className="workspace-title">
            {/* 软件内标题栏图标与 Tauri 窗口、任务栏和托盘图标使用同一资源，避免不同入口品牌不一致。 */}
            <img alt="" className="app-logo" src="/MyShell.ico" />
            <h1>{t('appName')}</h1>
          </div>

          <div className="session-strip">
            <div className="tab-list">
              {sessions.map((session) => (
                <div key={session.id} className={`session-tab ${session.id === activeSessionId ? 'is-active' : ''}`}>
                  <button className="session-tab-trigger" onClick={() => selectSession(session.id)} type="button">
                    <span aria-label={translateStatus(settings.uiLanguage, session.status)} className={sessionStatusClassName(session.status)} title={translateStatus(settings.uiLanguage, session.status)} />
                    <span>{connections.find((item) => item.id === session.connectionId)?.name ?? session.title}</span>
                  </button>
                  <button
                    aria-label={t('closeSessionAction')}
                    className="session-tab-close"
                    onClick={() => void closeSession(session.id)}
                    title={t('closeSessionAction')}
                    type="button"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
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

        <div className="terminal-area">
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
              const startHeight = bottomHeight;
              beginResize(event, (moveEvent, _startX, startY) => {
                setBottomHeight(clamp(startHeight + (startY - moveEvent.clientY), 180, Math.min(window.innerHeight * 0.58, 460)));
              });
            }}
          />

          <section className="bottom-dock card" style={{ height: bottomHeight }}>
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
            </header>

            <div className="panel-body dock-body">
              {activeBottomTab === 'commands' ? (
                <div className="stack command-panel fill-height">
                  <div className="section-row panel-action-row">
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
                  </div>

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

                  {commandSuggestions.length ? (
                    <div className="suggestion-strip">
                      {commandSuggestions.map((suggestion) => (
                        <button
                          key={suggestion}
                          className="ghost-button slim"
                          onClick={() => {
                            if (!activeSessionId) {
                              return;
                            }
                            setCommandBuffer(activeSessionId, replaceLastLine(activeCommand, suggestion));
                          }}
                          type="button"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {activeBottomTab === 'tunnels' ? (
                <div className="stack panel-stack">
                  <div className="section-row panel-action-row">
                    <div className="section-row compact">
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
                    </div>
                  </div>

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
                  <div className="section-row panel-action-row">
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
                  </div>

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
      <EditorModal />
      <ConnectionFormModal />
      <TunnelFormModal />
    </div>
  );
}
