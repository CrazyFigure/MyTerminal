export type ThemeMode = 'light' | 'dark';
export type UiLanguage = 'zh-CN' | 'en-US';
export type SshAuthMethod = 'password' | 'privateKey';
export type WorkspacePanel = 'files' | 'editor' | 'tunnels' | 'sync' | 'settings' | 'history';
export type SessionStatus = 'idle' | 'connecting' | 'connected' | 'stub' | 'error' | 'closed';
export type TerminalRightClickBehavior = 'paste' | 'menu';

export interface ConnectionProfile {
  id: string;
  name: string;
  groupPath?: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  password?: string;
  privateKeyPath?: string;
  privateKeyText?: string;
  passphrase?: string;
  note?: string;
  tags: string[];
}

export interface WebDavSettings {
  baseUrl: string;
  username: string;
  password: string;
  syncPassphrase: string;
  remoteSettingsPath: string;
  remoteConnectionsPath: string;
}

export interface AppSettings {
  uiLanguage: UiLanguage;
  themeMode: ThemeMode;
  runtimeRefreshIntervalSec: number;
  /** 终端英文字体优先用于 ASCII、数字和常见符号。 */
  shellLatinFontFamily: string;
  /** 终端中文字体优先用于 CJK 字符，避免中英文宽度互相影响。 */
  shellCjkFontFamily: string;
  /** 旧配置兼容字段；保存时会同步为中英文字体组合。 */
  shellFontFamily: string;
  shellFontSize: number;
  terminalBackground: string;
  terminalForeground: string;
  accentColor: string;
  backgroundImage?: string;
  /** 终端背景图透明度，0 表示不可见，1 表示原图完全显示。 */
  terminalBackgroundImageOpacity?: number;
  /** 终端背景图填充方式，仅作用于终端区域。 */
  terminalBackgroundImageFit?: 'cover' | 'contain' | 'stretch' | 'tile' | 'center';
  /** 终端区域右键行为：直接粘贴，或弹出复制/粘贴菜单。 */
  terminalRightClickBehavior: TerminalRightClickBehavior;
  compactSidebar: boolean;
  showCommandGhost: boolean;
  /** 连接管理中显式维护的分组路径；即使分组下暂无连接，也需要持久保留。 */
  connectionGroups: string[];
  /** 连接列表的人工排序；旧配置没有该字段时按连接文件原顺序兜底。 */
  connectionOrder: string[];
  quickCommands: string[];
  webdav: WebDavSettings;
}

export interface TerminalSession {
  id: string;
  connectionId: string;
  title: string;
  status: SessionStatus;
  cwd?: string;
}

export interface TerminalOutputChunk {
  sessionId: string;
  /** 远端 Shell 当前目录；为空时表示这是一段普通终端输出。 */
  cwd?: string;
  /** 会话状态由后端结构化回传，前端只更新标签图标，不写入终端正文。 */
  status?: SessionStatus;
  content: string;
}

export interface RemoteFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink?: boolean;
  size: number;
  modifiedAt?: string;
  /** 权限文本遵循类 Unix rwx 格式，用于文件表格紧凑扫描。 */
  permissions?: string;
  /** SFTP 通常只返回 uid，这里优先展示可读名称，缺失时前端保持占位。 */
  owner?: string;
  /** SFTP 通常只返回 gid，这里优先展示可读名称，缺失时前端保持占位。 */
  group?: string;
}

export interface RuntimeOverview {
  host: string;
  os: string;
  cpu: string;
  /** 每个 CPU 核心的占用率，点击 CPU 行展开展示。 */
  cpuCores: Array<{
    name: string;
    percent: number;
  }>;
  memory: string;
  storage: string;
  network: string;
  uptime: string;
}

export interface EditorDocument {
  connectionId: string;
  path: string;
  content: string;
  language: string;
  dirty: boolean;
}

export interface TunnelRecord {
  id: string;
  connectionId: string;
  name: string;
  bindAddress: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  status: 'running' | 'stopped' | 'stub';
}

export interface TunnelOpenRequest {
  connectionId: string;
  name: string;
  bindAddress: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

export interface TunnelDraft {
  name: string;
  bindAddress: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

export interface HistoryEntry {
  id: string;
  connectionId?: string;
  command: string;
  executedAt: string;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  releaseName?: string;
  releaseUrl: string;
  publishedAt?: string;
  updateAvailable: boolean;
  installerAssetName?: string;
  installerDownloadUrl?: string;
  installerSize?: number;
}

export interface BootstrapState {
  settings: AppSettings;
  connections: ConnectionProfile[];
  history: HistoryEntry[];
  sessions: TerminalSession[];
  tunnels: TunnelRecord[];
}

export interface ConnectionDraft {
  id: string;
  name: string;
  groupPath: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  password: string;
  privateKeyPath: string;
  privateKeyText: string;
  passphrase: string;
  note?: string;
  tags: string[] | string;
}
