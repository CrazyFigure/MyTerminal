//! 非 Tauri 环境的预览数据，只为浏览器开发回退提供稳定契约。

import type {
  AgentBridgeStatus,
  AppSettings,
  BootstrapState,
  ConnectionProfile,
  HistoryEntry,
  LocalTerminalSettings,
  RemoteFileEntry,
  RuntimeConnectionList,
  RuntimeOverview,
  RuntimeResourceUsage,
  RuntimeStorageFiles,
  TunnelRecord,
  UpdateCheckResult,
} from "../types";
import { normalizeProxyConfig, nowIso } from "./normalizers";

export const mockSettings: AppSettings = {
  uiLanguage: "zh-CN",
  themeMode: "light",
  runtimeRefreshIntervalSec: 1,
  runtimeStorageRefreshIntervalSec: 5,
  runtimeResourceRefreshIntervalSec: 3,
  runtimeResourceSource: "system",
  sshKeepaliveIntervalSec: 30,
  shellLatinFontFamily: "JetBrains Mono",
  shellCjkFontFamily: "Microsoft YaHei UI",
  shellFontFamily: "JetBrains Mono",
  shellFontSize: 15,
  shellLineHeight: 1.18,
  terminalBackground: "#f7f7f7",
  terminalForeground: "#111111",
  accentColor: "#4f46e5",
  backgroundImage: "",
  terminalBackgroundImageOpacity: 0.18,
  terminalBackgroundImageFit: "cover",
  terminalRightClickBehavior: "paste",
  terminalLineWrapMode: "wrap",
  terminalMatchSelection: true,
  terminalGutterShowLineNumber: true,
  terminalGutterShowTimestamp: true,
  compactSidebar: false,
  showCommandGhost: true,
  hardwareAcceleration: true,
  connectionGroups: ["ology", "ology/ology-old"],
  connectionOrder: ["windows-demo-1", "local-demo-1"],
  quickCommands: ["pwd", "ls -la", "docker ps"],
  webdav: {
    baseUrl: "",
    username: "",
    password: "",
    syncPassphrase: "",
    remotePath: "/myterminal",
  },
  agentBridge: {
    enabled: false,
    autoExecute: false,
    allowedConnectionIds: [],
    defaultTimeoutSec: 60,
    maxOutputBytes: 200000,
    visibleExecution: true,
  },
};

export const mockLocalTerminals: LocalTerminalSettings = {
  shellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  commands: [
    { id: "shell", name: "本地终端", command: "", builtIn: true },
    { id: "claude", name: "claude", command: "claude", builtIn: true },
    { id: "codex", name: "codex", command: "codex", builtIn: true },
    { id: "opencode", name: "opencode", command: "opencode", builtIn: true },
  ],
  profiles: [],
};

export const mockConnections: ConnectionProfile[] = [
  {
    id: "windows-demo-1",
    protocol: "rdp",
    name: "Windows Build Server",
    groupPath: "ology/ology-old",
    host: "192.168.12.36",
    port: 3389,
    username: "Administrator",
    authMethod: "password",
    password: "password",
    jumpHosts: [],
    proxy: normalizeProxyConfig(undefined),
    note: "Windows 远程桌面预览连接。",
  },
  {
    id: "local-demo-1",
    protocol: "ssh",
    name: "Ubuntu Demo",
    groupPath: "ology/ology-old",
    host: "192.168.12.28",
    port: 22,
    username: "root",
    authMethod: "password",
    password: "password",
    jumpHosts: [],
    proxy: {
      enabled: false,
      type: "socks5",
      host: "",
      port: 1080,
    },
    note: "Stub connection for UI preview.",
  },
];

export const mockHistory: HistoryEntry[] = [
  {
    id: "hist-1",
    connectionId: "local-demo-1",
    command: "ls -la",
    executedAt: nowIso(),
  },
  {
    id: "hist-2",
    connectionId: "local-demo-1",
    command: "docker ps",
    executedAt: nowIso(),
  },
  {
    id: "hist-3",
    connectionId: "local-demo-1",
    command: "tail -f /var/log/syslog",
    executedAt: nowIso(),
  },
];

export const mockFiles: RemoteFileEntry[] = [
  { name: "etc", path: "/etc", isDir: true, size: 0, modifiedAt: nowIso() },
  { name: "var", path: "/var", isDir: true, size: 0, modifiedAt: nowIso() },
  {
    name: "logs",
    path: "/srv/app/logs",
    isDir: true,
    isSymlink: true,
    size: 0,
    modifiedAt: nowIso(),
  },
  {
    name: "nginx.conf",
    path: "/etc/nginx/nginx.conf",
    isDir: false,
    size: 4380,
    modifiedAt: nowIso(),
  },
  {
    name: "app.env",
    path: "/srv/app/.env",
    isDir: false,
    size: 214,
    modifiedAt: nowIso(),
  },
];

export const mockRuntimeOverview: RuntimeOverview = {
  host: "192.168.12.28",
  os: "Linux demo-host 6.8 x86_64",
  cpu: "Load 0.21",
  cpuCores: [
    { name: "CPU 0", percent: 18 },
    { name: "CPU 1", percent: 24 },
    { name: "CPU 2", percent: 11 },
    { name: "CPU 3", percent: 35 },
  ],
  memory: "1423 / 4096 MB (35%)",
  storage: "18 / 64 GB (29%)",
  connections: "TCP 18 / SSH 1",
  network: "192.168.12.28",
  uptime: "3d 4h",
};

export const mockRuntimeResourceUsage: RuntimeResourceUsage = {
  source: "system",
  metric: "memory",
  target: "process",
  capturedAt: nowIso(),
  items: [
    {
      rank: 1,
      id: "3241",
      name: "postgres",
      context: "postgres",
      cpu: "4.3%",
      memory: "812 MB",
      detail: "postgres: writer",
      cpuPercent: 4.3,
      memoryPercent: 18.2,
    },
    {
      rank: 2,
      id: "1180",
      name: "java",
      context: "spring",
      cpu: "12.5%",
      memory: "640 MB",
      detail: "java -jar app.jar",
      cpuPercent: 12.5,
      memoryPercent: 14.4,
    },
    {
      rank: 3,
      id: "902",
      name: "node",
      context: "node",
      cpu: "2.1%",
      memory: "310 MB",
      detail: "node server.js",
      cpuPercent: 2.1,
      memoryPercent: 7.1,
    },
  ],
};

// 本地预览时模拟远端大文件列表，保持存储展开区在非 Tauri 环境也能完整渲染。
export const mockRuntimeStorageFiles: RuntimeStorageFiles = {
  capturedAt: nowIso(),
  items: [
    {
      rank: 1,
      name: "mysql.ibd",
      path: "/var/lib/mysql/ology/mysql.ibd",
      size: "12.4 GB",
      sizeKib: 13_002_342,
    },
    {
      rank: 2,
      name: "app.log",
      path: "/srv/ology/logs/app.log",
      size: "4.7 GB",
      sizeKib: 4_928_307,
    },
    {
      rank: 3,
      name: "container-json.log",
      path: "/var/lib/docker/containers/demo/demo-json.log",
      size: "2.1 GB",
      sizeKib: 2_202_009,
    },
  ],
};

// 本地预览时模拟远端连接明细，SSH 管理连接置顶并带标记，便于非 Tauri 环境查看展开效果。
export const mockRuntimeConnectionList: RuntimeConnectionList = {
  capturedAt: nowIso(),
  total: 4,
  items: [
    { local: "192.168.12.28:22", remote: "192.168.12.10:54231", isSsh: true },
    {
      local: "192.168.12.28:5432",
      remote: "192.168.12.10:48110",
      isSsh: false,
    },
    { local: "192.168.12.28:43210", remote: "10.0.0.9:3306", isSsh: false },
    { local: "[::1]:8080", remote: "[::1]:52344", isSsh: false },
  ],
};

export const mockTunnels: TunnelRecord[] = [
  {
    id: "tunnel-demo-1",
    connectionId: "local-demo-1",
    name: "Postgres 5432",
    bindAddress: "127.0.0.1",
    localPort: 15432,
    remoteHost: "127.0.0.1",
    remotePort: 5432,
    status: "stub",
  },
];

export const mockState: BootstrapState = {
  settings: mockSettings,
  localTerminals: mockLocalTerminals,
  connections: mockConnections,
  history: mockHistory,
  sessions: [],
  tunnels: mockTunnels,
};

export const mockAgentBridgeStatus: AgentBridgeStatus = {
  enabled: false,
  running: false,
  discoveryPath:
    "C:/Software/WorkSpace/MyTerminal/.myterminal-data/agent-bridge-discovery.json",
  cliCommand: "myterminal-cli bridge status --json",
  mcpCommand: "myterminal-cli mcp --stdio",
  cliPath:
    "C:/Software/WorkSpace/MyTerminal/src-tauri/target/debug/myterminal-cli.exe",
  dataDir: "C:/Software/WorkSpace/MyTerminal/.myterminal-data",
};

// 前端预览环境没有后端版本接口时，沿用 Vite 从 package.json 注入的版本作为展示与更新检查兜底。
export const mockAppVersion = import.meta.env.VITE_APP_VERSION;

export const mockUpdateCheckResult: UpdateCheckResult = {
  currentVersion: mockAppVersion,
  latestVersion: mockAppVersion,
  releaseName: "MyTerminal local preview",
  // 本地预览的更新结果也保持真实 Release 地址，便于关于页和安装链路一致跳转。
  releaseUrl: "https://github.com/CrazyFigure/MyTerminal/releases/latest",
  updateAvailable: false,
  releaseBody: "本地预览环境没有可用的更新内容。",
};
