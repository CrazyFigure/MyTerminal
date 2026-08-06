export type ThemeMode = 'light' | 'dark';
export type UiLanguage = 'zh-CN' | 'en-US';
/** 管理连接支持的远程协议；旧配置缺少该字段时统一按 SSH 处理。 */
export type ConnectionProtocol = 'ssh' | 'rdp';
export type SshAuthMethod = 'password' | 'privateKey';
export type SshProxyType = 'http' | 'socks5';
export type WorkspacePanel = 'files' | 'editor' | 'tunnels' | 'sync' | 'settings' | 'history';
export type SessionStatus = 'idle' | 'connecting' | 'connected' | 'stub' | 'error' | 'closed';
export type TerminalSessionKind = 'ssh' | 'local';
export type TerminalRightClickBehavior = 'paste' | 'menu';
/** SSH 终端长行展示模式；本地终端与 TUI 始终自动换行。 */
export type TerminalLineWrapMode = 'wrap' | 'horizontal';
/** 运行状态资源明细来源；Docker 同时覆盖 Docker Compose，Podman 使用独立命令采集。 */
export type RuntimeResourceSource = 'system' | 'docker' | 'podman' | 'kubernetes';
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
  /** SSH 打开内置终端，RDP 调用 Windows 系统远程桌面客户端。 */
  protocol: ConnectionProtocol;
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
  /** AI 命令是否在用户可见的终端标签中执行；关闭后回到后台隐藏通道。 */
  visibleExecution: boolean;
}

/** 内置 Agent 支持的三种接口协议。 */
export type AgentProtocol = 'anthropic' | 'openai-chat' | 'openai-responses';

export interface AgentModel {
  /** 调用 API 时使用的模型 id。 */
  id: string;
  /** 界面展示名称；为空时回退显示 id。 */
  name: string;
  /** 单次回复最大 token 数。 */
  maxTokens: number;
  /** 上下文窗口大小（token），用于估算何时自动压缩。 */
  contextWindow: number;
}

/** 思考强度；default 表示不下发该参数，走模型自身默认。 */
export type AgentEffort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 持久化到本地的一条 AI 对话。messages 对后端不透明，由前端定义形状。 */
export interface StoredAgentConversation {
  id: string;
  title: string;
  /** 最后更新时间（毫秒时间戳）。 */
  updatedAt: number;
  providerId: string;
  modelId: string;
  messages: AgentChatMessage[];
}

/** 一轮对话的运行参数，每次发送时携带。 */
export interface AgentRunOptions {
  effort: AgentEffort;
  /** 上下文占用超过该比例时自动压缩。 */
  compactThreshold: number;
  autoCompact: boolean;
}

export interface AgentProvider {
  id: string;
  name: string;
  protocol: AgentProtocol;
  baseUrl: string;
  /** 是否已配置密钥（后端按密钥串是否为空归一）。 */
  hasApiKey: boolean;
  /** 明文密钥：与 WebDAV 密码同一策略，后端明文下发，可随时查看或修改。 */
  apiKey?: string;
  models: AgentModel[];
}

/** 一次工具调用在对话中的展示状态。 */
export interface AgentChatToolCall {
  id: string;
  name: string;
  arguments: unknown;
  /** 工具返回内容；尚未完成时为空。 */
  result?: string;
  isError?: boolean;
}

/** 助手消息按到达顺序保存的展示片段；文本段与工具段交替，渲染据此还原「先工具、后总结」的真实顺序。 */
export type AgentChatPart =
  | { type: 'text'; text: string }
  | { type: 'tool'; call: AgentChatToolCall };

export interface AgentChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls: AgentChatToolCall[];
  /** 有序的展示片段；缺省时（旧存档）按 content 在前、toolCalls 在后兜底。 */
  parts?: AgentChatPart[];
}

export interface AppSettings {
  uiLanguage: UiLanguage;
  themeMode: ThemeMode;
  runtimeRefreshIntervalSec: number;
  /** 存储行展开后的大文件列表刷新频率，独立控制较重的文件系统扫描。 */
  runtimeStorageRefreshIntervalSec: number;
  /** 内存行展开后的进程/线程资源明细刷新频率，只影响资源明细接口。 */
  runtimeResourceRefreshIntervalSec: number;
  /** 内存行展开后的资源明细默认来源，容器环境可切到 Docker/Compose、Podman 或 K8s。 */
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
  /** 右侧 AI 对话英文字体；为空表示跟随终端英文字体。 */
  agentChatLatinFontFamily?: string;
  /** 右侧 AI 对话中文字体；为空表示跟随终端中文字体。 */
  agentChatCjkFontFamily?: string;
  /** 右侧 AI 对话字体大小（px）；0 表示跟随终端字体大小。 */
  agentChatFontSize?: number;
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
  /** 后端 PTY 初建或 resize 真正生效后的列数；与 rows 成对出现并先于对应输出入队。 */
  cols?: number;
  /** 后端 PTY 初建或 resize 真正生效后的行数；缓存重放据此还原当时的解析几何。 */
  rows?: number;
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

// 连接明细展开区的单条 ESTABLISHED 连接；isSsh 标记本地端口命中最终 sshd 端口的管理连接。
export interface RuntimeConnectionItem {
  local: string;
  remote: string;
  isSsh: boolean;
}

// 连接明细的后端响应；total 为远端 ESTABLISHED 总数，超出单次输出上限时用它提示剩余条数。
export interface RuntimeConnectionList {
  items: RuntimeConnectionItem[];
  total: number;
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
  // 当前实际数据目录，前端据此在 MCP 配置里注入 MYTERMINAL_DATA_DIR，保证 CLI 无论从哪启动都能定位 Broker。
  dataDir: string;
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
  /** 内置 AI 对话发起的审批会带对话 ID；外部 MCP 请求为空。 */
  conversationId?: string;
  /** 发起审批的工具调用 ID，用于把审批操作准确显示在原工具卡片中。 */
  toolCallId?: string;
}

export interface ConnectionDraft {
  id: string;
  /** 类型切换会同步调整常用端口，但用户手工填写的非默认端口必须保留。 */
  protocol: ConnectionProtocol;
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
