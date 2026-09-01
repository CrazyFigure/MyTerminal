//! 前后端契约输入的统一规范化规则，所有真实调用与浏览器回退共用同一边界。

import type {
  AppSettings,
  ConnectionProfile,
  LocalTerminalSettings,
  SshJumpHost,
  SshProxyConfig,
  TunnelOpenRequest,
} from "../types";

export const isTauriRuntime = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const nowIso = () => new Date().toISOString();

const clampInteger = (
  value: number,
  min: number,
  max: number,
  fallback: number,
) => {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
};

export const clampU16 = (value: number, fallback: number) =>
  clampInteger(value, 0, 65535, fallback);
const clampPort = (value: number, fallback = 22) =>
  clampInteger(value, 1, 65535, fallback);
const clampFontSize = (value: number, fallback = 15) =>
  clampInteger(value, 8, 48, fallback);
// 行高是小数倍数，不能复用取整的 clampInteger；xterm 对 lineHeight < 1 会直接抛错，下限锁死在 1。
const clampLineHeight = (value: number | undefined, fallback: number) => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  // 保留两位小数，避免浮点误差写进配置文件。
  return Math.round(Math.min(2.5, Math.max(1, numericValue)) * 100) / 100;
};
// 进程/线程和连接明细是独立接口，默认 3 秒；概览固定每秒由 Rust worker 推送。
const clampResourceRefreshInterval = (value: number, fallback = 3) =>
  clampInteger(value, 1, 300, fallback);
const clampRatio = (value: number | undefined, fallback: number) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(1, Math.max(0, value));
};

const terminalBackgroundImageFits = new Set<
  AppSettings["terminalBackgroundImageFit"]
>(["cover", "contain", "stretch", "tile", "center"]);
// 长行展示模式只接受前端枚举值，旧配置或手动编辑错误时回落到自动换行。
const terminalLineWrapModes = new Set<AppSettings["terminalLineWrapMode"]>([
  "wrap",
  "horizontal",
]);
// 资源来源白名单与设置下拉、Rust 远端采集分支保持一致，防止 Podman 配置在加载时被回退成系统进程。
const runtimeResourceSources = new Set<AppSettings["runtimeResourceSource"]>([
  "system",
  "docker",
  "podman",
  "kubernetes",
]);

const normalizeSingleFontFamily = (value: string) => {
  // 旧配置可能保存过一整串 fallback 字体；设置页只展示和保存用户明确选择的单个字体。
  const firstFont = value
    .split(",")
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
    .find(Boolean);
  return firstFont ?? "JetBrains Mono";
};

// 中英文字体拆分后仍同步旧字段，避免旧配置、Monaco 编辑器和旧版本数据读取到空字体。
const normalizeFontPair = (settings: AppSettings) => {
  const legacyFontFamily = normalizeSingleFontFamily(
    settings.shellFontFamily ?? "JetBrains Mono",
  );
  const shellLatinFontFamily = normalizeSingleFontFamily(
    settings.shellLatinFontFamily ?? legacyFontFamily,
  );
  const shellCjkFontFamily = normalizeSingleFontFamily(
    settings.shellCjkFontFamily ?? shellLatinFontFamily,
  );
  return {
    shellLatinFontFamily,
    shellCjkFontFamily,
    // 旧字段保留为 CSS 字体族组合，供编辑器和旧版本配置继续读取。
    shellFontFamily: [shellLatinFontFamily, shellCjkFontFamily]
      .filter((fontFamily, index, array) => array.indexOf(fontFamily) === index)
      .join(", "),
  };
};

export const normalizeRuntimeResourceSource = (
  value: unknown,
): AppSettings["runtimeResourceSource"] => {
  // 旧配置可能保存过 auto/compose；auto 不再展示，按系统进程处理，compose 由 Docker 覆盖。
  if (value === "compose") {
    return "docker";
  }
  return runtimeResourceSources.has(
    value as AppSettings["runtimeResourceSource"],
  )
    ? (value as AppSettings["runtimeResourceSource"])
    : "system";
};

const trimToUndefined = (value?: string) => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const keepTextIfPresent = (value?: string) => {
  if (typeof value !== "string") {
    return undefined;
  }

  return value.trim() ? value : undefined;
};

// 跳板机作为连接链路的一部分，保存和测试前必须按主连接同一规则整理认证与端口。
const normalizeJumpHost = (jumpHost: SshJumpHost): SshJumpHost => {
  const authMethod =
    jumpHost.authMethod === "privateKey" ? "privateKey" : "password";
  return {
    id: jumpHost.id,
    name: trimToUndefined(jumpHost.name),
    host: jumpHost.host.trim(),
    port: clampPort(jumpHost.port),
    username: jumpHost.username.trim(),
    authMethod,
    password: authMethod === "password" ? (jumpHost.password ?? "") : undefined,
    privateKeyPath:
      authMethod === "privateKey"
        ? trimToUndefined(jumpHost.privateKeyPath)
        : undefined,
    privateKeyText:
      authMethod === "privateKey"
        ? keepTextIfPresent(jumpHost.privateKeyText)
        : undefined,
    passphrase:
      authMethod === "privateKey"
        ? keepTextIfPresent(jumpHost.passphrase)
        : undefined,
  };
};

// 代理配置只作用在第一跳，关闭时仍随连接保存，便于用户临时启停。
export const normalizeProxyConfig = (proxy?: SshProxyConfig): SshProxyConfig => ({
  enabled: Boolean(proxy?.enabled),
  type: proxy?.type === "http" ? "http" : "socks5",
  host: proxy?.host?.trim() ?? "",
  port: clampPort(proxy?.port ?? 1080, 1080),
  username: trimToUndefined(proxy?.username),
  password: keepTextIfPresent(proxy?.password),
});

export const normalizeSettings = (settings: AppSettings): AppSettings => ({
  ...settings,
  ...normalizeFontPair(settings),
  shellFontSize: clampFontSize(settings.shellFontSize),
  shellLineHeight: clampLineHeight(settings.shellLineHeight, 1.18),
  // AI 对话字体为空表示跟随终端字体，字号 0 表示跟随终端字号；避免升级后对话区观感突变。
  agentChatLatinFontFamily: trimToUndefined(settings.agentChatLatinFontFamily),
  agentChatCjkFontFamily: trimToUndefined(settings.agentChatCjkFontFamily),
  // 对话行高与终端行高相互独立，没有“0 表示跟随”的语义，缺省直接回落到正文默认值。
  agentChatLineHeight: clampLineHeight(settings.agentChatLineHeight, 1.6),
  agentChatFontSize: (() => {
    const value = Math.round(Number(settings.agentChatFontSize));
    if (!Number.isFinite(value) || value <= 0) {
      return 0;
    }
    return clampFontSize(value);
  })(),
  runtimeResourceRefreshIntervalSec: clampResourceRefreshInterval(
    settings.runtimeResourceRefreshIntervalSec,
  ),
  runtimeResourceSource: normalizeRuntimeResourceSource(
    settings.runtimeResourceSource,
  ),
  // SSH 保活间隔：0 表示关闭；否则夹在 10~300 秒之间，避免过于频繁或形同虚设。
  sshKeepaliveIntervalSec: (() => {
    const value = Math.round(Number(settings.sshKeepaliveIntervalSec));
    if (!Number.isFinite(value) || value <= 0) {
      return 0;
    }
    return Math.min(300, Math.max(10, value));
  })(),
  terminalBackgroundImageOpacity: clampRatio(
    settings.terminalBackgroundImageOpacity,
    0.18,
  ),
  terminalBackgroundImageFit: terminalBackgroundImageFits.has(
    settings.terminalBackgroundImageFit,
  )
    ? settings.terminalBackgroundImageFit
    : "cover",
  terminalRightClickBehavior:
    settings.terminalRightClickBehavior === "menu" ? "menu" : "paste",
  // 旧配置没有长行展示字段时保持原来的自动换行，避免升级后突然改变终端布局。
  terminalLineWrapMode: terminalLineWrapModes.has(settings.terminalLineWrapMode)
    ? settings.terminalLineWrapMode
    : "wrap",
  // 旧配置没有匹配高亮字段时默认开启，符合新版本的终端阅读体验。
  terminalMatchSelection: settings.terminalMatchSelection !== false,
  // 旧配置没有行号栏字段时默认显示，避免升级后左侧信息突然消失。
  terminalGutterShowLineNumber: settings.terminalGutterShowLineNumber !== false,
  terminalGutterShowTimestamp: settings.terminalGutterShowTimestamp !== false,
  // 分组和连接排序来自用户拖拽结果，规范化时只去重清洗，不再按字母重新排序。
  connectionGroups: Array.from(
    new Set(
      (settings.connectionGroups ?? [])
        .map((groupPath) =>
          groupPath
            .trim()
            .replace(/\\/g, "/")
            .replace(/^\/+|\/+$/g, "")
            .replace(/\/+/g, "/"),
        )
        .filter(Boolean),
    ),
  ),
  connectionOrder: Array.from(
    new Set((settings.connectionOrder ?? []).filter(Boolean)),
  ),
  quickCommands: settings.quickCommands ?? [],
  webdav: {
    baseUrl: settings.webdav?.baseUrl ?? "",
    username: settings.webdav?.username ?? "",
    password: settings.webdav?.password ?? "",
    syncPassphrase: settings.webdav?.syncPassphrase ?? "",
    remotePath: settings.webdav?.remotePath ?? "/myterminal",
  },
  agentBridge: {
    enabled: Boolean(settings.agentBridge?.enabled),
    autoExecute: Boolean(settings.agentBridge?.autoExecute),
    allowedConnectionIds: Array.from(
      new Set(settings.agentBridge?.allowedConnectionIds ?? []),
    ),
    defaultTimeoutSec: Math.min(
      3600,
      Math.max(1, Number(settings.agentBridge?.defaultTimeoutSec) || 60),
    ),
    maxOutputBytes: Math.min(
      10_000_000,
      Math.max(1024, Number(settings.agentBridge?.maxOutputBytes) || 200_000),
    ),
    // 旧配置没有该字段时按默认开启处理，保持与后端 default 一致。
    visibleExecution: settings.agentBridge?.visibleExecution ?? true,
  },
});

export const normalizeConnection = (
  connection: ConnectionProfile,
): ConnectionProfile => {
  // 旧连接没有 protocol；RDP 只保留密码认证和目标端点，不能把 SSH 私钥、跳板或代理误传给后端。
  const protocol = connection.protocol === "rdp" ? "rdp" : "ssh";
  const authMethod =
    protocol === "rdp"
      ? "password"
      : connection.authMethod === "privateKey"
        ? "privateKey"
        : "password";
  return {
    ...connection,
    protocol,
    groupPath: trimToUndefined(connection.groupPath)
      ?.replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, ""),
    port: clampPort(connection.port, protocol === "rdp" ? 3389 : 22),
    authMethod,
    password:
      authMethod === "privateKey" ? undefined : (connection.password ?? ""),
    privateKeyPath:
      authMethod === "privateKey"
        ? trimToUndefined(connection.privateKeyPath)
        : undefined,
    privateKeyText:
      authMethod === "privateKey"
        ? keepTextIfPresent(connection.privateKeyText)
        : undefined,
    passphrase:
      authMethod === "privateKey"
        ? keepTextIfPresent(connection.passphrase)
        : undefined,
    jumpHosts:
      protocol === "ssh" && Array.isArray(connection.jumpHosts)
        ? connection.jumpHosts.map((jumpHost) => normalizeJumpHost(jumpHost))
        : [],
    proxy:
      protocol === "ssh"
        ? normalizeProxyConfig(connection.proxy)
        : normalizeProxyConfig(undefined),
  };
};

// 隧道请求在进入 Tauri IPC 前统一清洗端点，避免前后端对空监听地址和端口默认值理解不一致。
export const normalizeTunnelRequest = (
  request: TunnelOpenRequest,
): TunnelOpenRequest => ({
  ...request,
  bindAddress: trimToUndefined(request.bindAddress) ?? "127.0.0.1",
  name: request.name.trim(),
  remoteHost: request.remoteHost.trim(),
  localPort: clampPort(request.localPort, 15432),
  remotePort: clampPort(request.remotePort, 5432),
});

// 本地终端配置在 Web stub 和 Tauri 后端之间保持同一套归一化规则，空命令表示纯 shell。
export const normalizeLocalTerminalSettings = (
  settings: LocalTerminalSettings,
): LocalTerminalSettings => {
  // 内置命令只强制补齐“本地终端”（id == "shell"），避免旧配置缺失本地终端，其余内置命令被删除后不强行补齐。
  const defaultCommands: LocalTerminalSettings["commands"] = [
    { id: "shell", name: "本地终端", command: "", builtIn: true },
  ];
  const commandMap = new Map<
    string,
    LocalTerminalSettings["commands"][number]
  >();
  [...(settings.commands ?? []), ...defaultCommands].forEach((item) => {
    const command = item.command.trim();
    const name = item.name.trim() || command || "本地终端";
    if (!command && !item.builtIn) {
      return;
    }
    const id = item.id.trim() || command || "shell";
    if (!commandMap.has(id)) {
      commandMap.set(id, { id, name, command, builtIn: Boolean(item.builtIn) });
    }
  });

  // 历史目录只要求目录有效；命令允许为空，空命令由后端解释为直接打开本地 shell。
  const profiles = (settings.profiles ?? [])
    .map((profile) => ({
      ...profile,
      id: profile.id?.trim() || crypto.randomUUID(),
      cwd: profile.cwd.trim(),
      command: profile.command.trim(),
      lastUsedAt: profile.lastUsedAt || "",
    }))
    .filter((profile) => profile.cwd)
    .map((profile) => ({
      ...profile,
      title:
        profile.title?.trim() ||
        (profile.command ? `${profile.command} · ${profile.cwd}` : profile.cwd),
    }));

  return {
    shellPath: settings.shellPath?.trim() ?? "",
    commands: Array.from(commandMap.values()),
    profiles,
  };
};
