/* 设置功能域内部模块；只暴露稳定的数据规则或独立视图。 */
import type { WheelEvent as ReactWheelEvent } from 'react';
import type { TranslationKey } from '../../i18n';
import type { AgentBridgeStatus, AgentProtocol, AgentProvider, AppSettings } from '../../types';
import { clamp } from '../../shared/numbers';

// “执行”是内置 AI 助手与外部 MCP 的共享配置页，不能继续归属于任一接入方式。
export type SettingsTab = 'appearance' | 'resources' | 'sync' | 'agent' | 'agentChat' | 'execution' | 'about';




// 设置里的秒数字段同样不用 number 类型，避免上下步进按钮和鼠标滚轮隐式改配置。
export const numericSettingInputProps = {
  type: 'text',
  inputMode: 'numeric',
  pattern: '[0-9]*',
  autoComplete: 'off',
  onWheel: (event: ReactWheelEvent<HTMLInputElement>) => {
    event.currentTarget.blur();
  },
} as const;




// 资源页“重置”只恢复本页字段的产品默认值；这些值先写入草稿，仍需点击保存才会持久化并生效。
export const resourceSettingsDefaults = {
  runtimeResourceRefreshIntervalSec: 3,
  runtimeResourceSource: 'system',
  sshKeepaliveIntervalSec: 30,
} satisfies Pick<
  AppSettings,
  | 'runtimeResourceRefreshIntervalSec'
  | 'runtimeResourceSource'
  | 'sshKeepaliveIntervalSec'
>;

// 外观页“重置”按单个字段恢复产品默认值（只改该字段，不影响同区域其它设置）。
// 终端字号/行高取 defaults.ts 的历史值；AI 对话字号 0 表示跟随终端，行高独立默认 1.6。
export const appearanceFieldDefaults: Record<
  'shellFontSize' | 'shellLineHeight' | 'agentChatFontSize' | 'agentChatLineHeight',
  number
> = {
  shellFontSize: 15,
  shellLineHeight: 1.18,
  agentChatFontSize: 0,
  agentChatLineHeight: 1.6,
};





// 推荐字体与当前旧配置都必须通过真实可用性检测；系统枚举失败时也不能重新展示未安装字体。
export const mergeInstalledFontOptions = (
  curated: string[],
  systemFonts: string[],
  isFallbackAllowed: (fontFamily: string) => boolean,
) => {
  const installedFonts = new Map(systemFonts.map((fontFamily) => [fontFamily.toLowerCase(), fontFamily]));
  const seen = new Set<string>();
  const installedCurated = curated
    .map((fontFamily) => installedFonts.get(fontFamily.toLowerCase())
      ?? (isFallbackAllowed(fontFamily) ? fontFamily : undefined))
    .filter((fontFamily): fontFamily is string => {
      if (!fontFamily) {
        return false;
      }
      const key = fontFamily.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  const extras = systemFonts.filter((fontFamily) => {
    const key = fontFamily.toLowerCase();
    return !seen.has(key) && seen.add(key);
  });
  return [...installedCurated, ...extras];
};





export const findFontOption = (options: string[], fontFamily: string) => {
  const normalized = fontFamily.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
  return options.find((option) => option.toLowerCase() === normalized);
};





// 从 discovery 文件路径反推项目根目录，仅用于开发态 npx launcher 包的兜底路径。
// 安装版走 cliPath 直连分支，不会用到这里。
export const deriveAgentMcpPackagePath = (discoveryPath?: string) => {
  const normalized = discoveryPath?.trim().replace(/\\/g, '/');
  const marker = '/.myterminal-data/';
  const markerIndex = normalized?.lastIndexOf(marker) ?? -1;
  if (!normalized || markerIndex < 0) {
    return null;
  }
  // discovery 文件位于项目数据目录下，反推项目根目录后拼出本地 npx launcher 包。
  const rootPath = normalized.slice(0, markerIndex);
  return `${rootPath}/mcp/myterminal-mcp`;
};





export const buildAgentMcpConfig = (status?: AgentBridgeStatus | null) => {
  const cliPath = status?.cliPath?.trim();
  const dataDir = status?.dataDir?.trim();
  // 数据目录保留旧版固定发现的兼容兜底；latest 让安装版与开发版并存时自动选择后启动的健康 Broker，
  // 后启动实例退出后会回退到仍存活的旧实例，无需重启 MCP 客户端。
  const env = dataDir
    ? { MYTERMINAL_DATA_DIR: dataDir, MYTERMINAL_BRIDGE_SELECTION: 'latest' }
    : { MYTERMINAL_BRIDGE_SELECTION: 'latest' };

  // 后端把随应用分发的 CLI 固化到按内容指纹分版的用户目录；Codex 持有该稳定 stdio 进程，
  // 关闭 GUI、升级安装版或重新启动 dev 都不会再因 sidecar 被替换而丢失 MCP 注册。
  let server: Record<string, unknown>;
  if (cliPath) {
    server = { type: 'stdio', command: cliPath, args: ['mcp', '--stdio'] };
  } else {
    // 找不到 CLI（一般是开发态未构建 sidecar）时，项目目录可回退到本地 npx launcher；
    // 安装目录无法反推本地包时使用 PATH 中的 myterminal-cli，不能请求并未发布到 npm 的私有包。
    const packagePath = deriveAgentMcpPackagePath(status?.discoveryPath);
    server = packagePath
      ? { type: 'stdio', command: 'npx', args: ['--yes', packagePath] }
      : { type: 'stdio', command: 'myterminal-cli', args: ['mcp', '--stdio'] };
  }
  server.env = env;

  return JSON.stringify(
    {
      mcpServers: {
        myterminal: server,
      },
    },
    null,
    2,
  );
};





export const terminalBackgroundFitOptions: Array<{
  value: NonNullable<AppSettings['terminalBackgroundImageFit']>;
  labelKey: TranslationKey;
}> = [
  { value: 'cover', labelKey: 'backgroundFitCover' },
  { value: 'contain', labelKey: 'backgroundFitContain' },
  { value: 'stretch', labelKey: 'backgroundFitStretch' },
  { value: 'tile', labelKey: 'backgroundFitTile' },
  { value: 'center', labelKey: 'backgroundFitCenter' },
];




// 设置页数字输入只接收整数文本；越界值在录入时钳制，保存时后端还会再归一化一次。
export const readBoundedIntegerInput = (value: string, min: number, max: number, fallback: number) => {
  const numericText = value.replace(/\D/g, '');
  if (!numericText) {
    return fallback;
  }
  const numericValue = Number(numericText);
  return Number.isFinite(numericValue) ? clamp(Math.trunc(numericValue), min, max) : fallback;
};





// 侧栏最大宽度由当前窗口、另一侧栏宽度和主工作区保底宽度共同决定，避免双侧栏展开时互相抢占中间区域。
/**
 * 各协议的服务地址书写规范。
 * 三种协议的实际请求路径不同，用户无从凭空判断该填到哪一层，
 * 所以把「填什么」「会拼成什么」直接摆在输入框旁边。
 */
export const agentProtocolUrlSpec: Record<AgentProtocol, { placeholder: string; path: string }> = {
  anthropic: { placeholder: 'https://api.anthropic.com', path: '/v1/messages' },
  'openai-chat': { placeholder: 'https://api.openai.com', path: '/v1/chat/completions' },
  'openai-responses': { placeholder: 'https://api.openai.com', path: '/v1/responses' },
};





/**
 * 解析模型配置文本。每行一个模型，可选地用 `|` 指定上下文窗口与单次输出上限：
 *   claude-opus-5
 *   gpt-4o | 128000
 *   gpt-4o-mini | 128000 | 8000
 * 两个 token 值都省略时沿用该模型已有配置，新模型才落到默认值——
 * 上下文窗口无法可靠探测，必须让用户按自己的端点如实填写。
 */
// 端点改动对比：apiKey 为可选字段，基线与草稿的缺省形态可能不一致（undefined 与空串），
// 统一归一为空串后再序列化，避免刚拉取完就被误判为存在未保存修改。
export const serializeAgentProvidersForCompare = (providers: AgentProvider[]): string =>
  JSON.stringify(providers.map(({ apiKey, ...rest }) => ({ ...rest, apiKey: apiKey ?? '' })));





/**
 * 预览最终会请求的完整 URL，规则必须与后端 join_url 保持一致：
 * 已填到完整端点则原样使用；结尾是重复版本段（如 /v1）则剥掉后再拼。
 */
export const previewAgentRequestUrl = (baseUrl: string, protocol: AgentProtocol): string => {
  const path = agentProtocolUrlSpec[protocol].path;
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return `${agentProtocolUrlSpec[protocol].placeholder}${path}`;
  }
  if (trimmed.endsWith(path)) {
    return trimmed;
  }
  const version = path.split('/')[1];
  if (version && trimmed.endsWith(`/${version}`)) {
    return `${trimmed.slice(0, -(version.length + 1))}${path}`;
  }
  return `${trimmed}${path}`;
};
