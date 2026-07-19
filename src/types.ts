export type ThemeMode = 'light' | 'dark';
export type UiLanguage = 'zh-CN' | 'en-US';
export type SshAuthMethod = 'password' | 'privateKey';
export type SshProxyType = 'http' | 'socks5';
export type WorkspacePanel = 'files' | 'editor' | 'tunnels' | 'sync' | 'settings' | 'history';
export type SessionStatus = 'idle' | 'connecting' | 'connected' | 'stub' | 'error' | 'closed';
export type TerminalSessionKind = 'ssh' | 'local';
export type TerminalRightClickBehavior = 'paste' | 'menu';
/** SSH 终端长行展示模式；本地终端与 TUI 始终自动换行。 */
export type TerminalLineWrapMode = 'wrap' | 'horizontal';
/** 运行状态资源明细来源；Docker 同时覆盖 Docker Compose 容器场景。 */
export type RuntimeResourceSource = 'system' | 'docker' | 'kubernetes';
export type RuntimeResourceMetric = 'cpu' | 'memory';
export type RuntimeResourceTarget = 'process' | 'thread';

export interface SshJumpHost {
  /** 跳板机条目稳定 id，用于表单增删排序时保持 React key 与保存结构稳定。 */
  id: string;
  /** 可选显示名，仅用于用户区分多级跳板，不参与实际 SSH 连接。 */
  name?: string;
  /** 当前跳板机的 SSH 地址；多级跳板按数组顺序逐级连接。 */
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  password?: string;
  privateKeyPath?: string;
  privateKeyText?: string;
  passphrase?: string;
}

export interface SshProxyConfig {
  /** 代理开关关闭时保留字段但连接层忽略，便于用户临时启停配置。 */
  enabled: boolean;
  /** HTTP 表示 CONNECT 代理，SOCKS5 表示标准 SOCKS5 代理。 */
  type: SshProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

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
  /** 多级跳板按顺序串接，最后一级跳板再连目标 SSH 主机。 */
  jumpHosts?: SshJumpHost[];
  /** 代理仅作用于第一跳网络连接：无跳板时连目标，有跳板时连第一个跳板。 */
  proxy?: SshProxyConfig;
  note?: string;
  tags: string[];
}

export interface WebDavSettings {
  baseUrl: string;
  username: string;
  password: string;
  syncPassphrase: string;
  remotePath: string;
}

export interface AgentBridgeSettings {
  /** AI Bridge 默认关闭，开启后本地 Broker 才会监听 127.0.0.1。 */
  enabled: boolean;
  /** 自动执行开启时全部连接跳过 GUI 审批；关闭时仅 allowedConnectionIds 中的连接自动执行。 */
  autoExecute: boolean;
  /** 自动执行关闭时仍允许自动执行的连接白名单。 */
  allowedConnectionIds: string[];
  /** Agent 命令默认超时秒数，防止外部工具长时间占用远端 channel。 */
  defaultTimeoutSec: number;
  /** 单次命令最大输出字节数，超出后后端截断并标记 truncated。 */
  maxOutputBytes: number;
}

export interface AppSettings {
  uiLanguage: UiLanguage;
  themeMode: ThemeMode;
  runtimeRefreshIntervalSec: number;
  /** 存储行展开后的大文件列表刷新频率，独立控制较重的文件系统扫描。 */
  runtimeStorageRefreshIntervalSec: number;
  /** 内存行展开后的进程/线程资源明细刷新频率，只影响资源明细接口。 */
  runtimeResourceRefreshIntervalSec: number;
  /** 内存行展开后的资源明细默认来源，容器环境可切到 Docker/Compose/K8s。 */
  runtimeResourceSource: RuntimeResourceSource;
  /** SSH 保活间隔（秒），0 表示关闭；作用于交互终端、文件/状态辅助会话与隧道池会话。 */
  sshKeepaliveIntervalSec: number;
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
  /** SSH 终端长行展示方式；本地终端与 TUI 不读取该设置，始终按窗口自动换行。 */
  terminalLineWrapMode: TerminalLineWrapMode;
  /** 选中终端文本时，自动高亮可滚动缓冲区中完全一致的匹配内容。 */
  terminalMatchSelection: boolean;
  /** 终端左侧行号栏是否显示行号；软换行的续行以 - 占位。 */
  terminalGutterShowLineNumber: boolean;
  /** 终端左侧行号栏是否显示每行到达时刻的时间戳。 */
  terminalGutterShowTimestamp: boolean;
  compactSidebar: boolean;
  showCommandGhost: boolean;
  /** Windows 硬件加速开关（重启生效）；关闭后使用软件渲染兼容模式，实际内存收益取决于本机环境。 */
  hardwareAcceleration: boolean;
  /** 连接管理中显式维护的分组路径；即使分组下暂无连接，也需要持久保留。 */
  connectionGroups: string[];
  /** 连接列表的人工排序；旧配置没有该字段时按连接文件原顺序兜底。 */
  connectionOrder: string[];
  quickCommands: string[];
  webdav: WebDavSettings;
  agentBridge: AgentBridgeSettings;
}

export interface TerminalSession {
  id: string;
  /** 会话来源决定是否启用 SSH 文件、运行状态和隧道面板。 */
  kind: TerminalSessionKind;
  connectionId: string;
  /** 本地终端启动项 id 用于重开和复制信息，SSH 会话为空。 */
  localProfileId?: string;
  /** 本地终端实际启动命令，用于前端识别全屏 TUI 类命令并套用专用渲染策略。 */
  localCommand?: string;
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

export interface FileTransferSummary {
  /** 普通文件数量；目录内文件会计入此值。 */
  files: number;
  /** 目录数量；空目录也会计入此值。 */
  directories: number;
  /** 已复制字节数，后端递归统计。 */
  bytes: number;
  /** 传输根目标路径列表，用于状态栏展示和问题定位。 */
  destinations: string[];
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
  /** 远端主机已建立 TCP 连接数，并附带最终 sshd 实际端口的连接数；无法可靠采集时 SSH 显示不可用。 */
  connections: string;
  network: string;
  uptime: string;
}

export interface RuntimeResourceUsageRequest {
  source: RuntimeResourceSource;
  metric: RuntimeResourceMetric;
  target: RuntimeResourceTarget;
  limit: number;
}

export interface RuntimeResourceUsageItem {
  rank: number;
  id: string;
  name: string;
  context: string;
  cpu: string;
  memory: string;
  detail: string;
  cpuPercent?: number;
  memoryPercent?: number;
}

export interface RuntimeResourceUsage {
  source: RuntimeResourceSource;
  metric: RuntimeResourceMetric;
  target: RuntimeResourceTarget;
  items: RuntimeResourceUsageItem[];
  capturedAt: string;
  error?: string;
}

// 存储展开列表的单文件数据，名称用于紧凑展示，路径用于定位和悬浮完整查看。
export interface RuntimeStorageFileItem {
  rank: number;
  name: string;
  path: string;
  size: string;
  sizeKib: number;
}

// 存储展开列表的后端响应，只在存储行展开时刷新，error 直接显示在列表区域。
export interface RuntimeStorageFiles {
  items: RuntimeStorageFileItem[];
  capturedAt: string;
  error?: string;
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
  /** running=监听中且底层 SSH 可达；error=后台监控探测到底层连接断开；stopped=已手动停止。 */
  status: 'running' | 'stopped' | 'stub' | 'error';
}

export interface TunnelOpenRequest {
  connectionId: string;
  name: string;
  bindAddress: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

// 隧道编辑必须携带已有记录 id，其余字段沿用新增请求，便于后端按同一套规则校验端点。
export interface TunnelUpdateRequest extends TunnelOpenRequest {
  id: string;
}

export interface TunnelDraft {
  // 表单草稿保留 id 与连接 id，用来区分新增/编辑，并避免切换活动连接时误保存到其他连接。
  id: string;
  connectionId: string;
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
  releaseBody?: string;
}

export interface LocalTerminalCommand {
  id: string;
  name: string;
  command: string;
  /** 内置命令固定包含 claude/codex/opencode，允许排序但不允许删除。 */
  builtIn: boolean;
}

export interface LocalTerminalProfile {
  id: string;
  title: string;
  cwd: string;
  command: string;
  lastUsedAt: string;
}

export interface LocalTerminalSettings {
  shellPath: string;
  commands: LocalTerminalCommand[];
  profiles: LocalTerminalProfile[];
}

export interface BootstrapState {
  settings: AppSettings;
  localTerminals: LocalTerminalSettings;
  connections: ConnectionProfile[];
  history: HistoryEntry[];
  sessions: TerminalSession[];
  tunnels: TunnelRecord[];
}

export interface AgentBridgeStatus {
  enabled: boolean;
  running: boolean;
  port?: number;
  token?: string;
  discoveryPath: string;
  cliCommand: string;
  mcpCommand: string;
  cliPath?: string;
}

export interface AgentBridgeRequest {
  id: string;
  kind: 'run_command' | 'file_write' | 'file_upload' | 'file_download' | 'file_delete' | 'file_rename' | 'file_mkdir' | string;
  status: 'pending' | 'running' | 'completed' | 'rejected' | 'error' | string;
  connectionId: string;
  sessionId?: string;
  title: string;
  command?: string;
  path?: string;
  newPath?: string;
  contentPreview?: string;
  logs: string[];
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
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
  /** 表单草稿中的跳板机保留敏感字段明文，保存前由后端加密落盘。 */
  jumpHosts: SshJumpHost[];
  /** 表单草稿中的代理配置支持临时关闭但保留输入值。 */
  proxy: SshProxyConfig;
  note?: string;
  tags: string[] | string;
}
