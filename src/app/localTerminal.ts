/* 本模块由 App 入口按功能域拆出，保留原组件行为与状态订阅方式。 */
import type { LocalTerminalProfile, TerminalSession } from '../types';

// 本地终端首次打开时默认指向当前工作区，用户仍可在弹窗内切换任意目录。
export const defaultLocalTerminalCwd = 'C:\\Software\\WorkSpace\\MyTerminal';



export const nowIso = () => new Date().toISOString();



// 空命令代表直接打开本地 shell，是本地终端和 AI CLI 之间的兜底启动项。
export const localTerminalShellCommand = { id: 'shell', name: '本地终端', command: '', builtIn: true };



// Pi 名称很短，必须按独立命令词匹配，避免把 pip、spin 等普通命令误识别成 Pi Coding Agent。
export const matchesPiLocalTerminalCommand = (name: string, command: string) => {
  const piCommandPattern = /(^|[\s\\/'"]+)pi(?:\.(?:exe|cmd|bat|ps1))?(?=$|[\s'"])/i;
  return piCommandPattern.test(name) || piCommandPattern.test(command);
};



// 根据命令名称和实际命令内容动态匹配工具图标；纯 Shell 使用本地图标，未匹配的自定义命令不显示图标。
export const getLocalTerminalIcon = (name: string, command: string) => {
  const lowerName = name.toLowerCase();
  const lowerCmd = command.toLowerCase();
  if (lowerName.includes('claude') || lowerCmd.includes('claude')) {
    return '/icons/claude.svg';
  }
  if (lowerName.includes('codex') || lowerCmd.includes('codex')) {
    return '/icons/codex.svg';
  }
  if (lowerName.includes('opencode') || lowerCmd.includes('opencode')) {
    return '/icons/opencode.svg';
  }
  if (lowerName.includes('qwen') || lowerCmd.includes('qwen')) {
    return '/icons/qwen.svg';
  }
  if (lowerName.includes('gemini') || lowerCmd.includes('gemini')) {
    return '/icons/gemini.svg';
  }
  if (lowerName.includes('deepseek') || lowerCmd.includes('deepseek')) {
    return '/icons/deepseek.svg';
  }
  if (lowerName.includes('copilot') || lowerCmd.includes('copilot')) {
    return '/icons/copilot.svg';
  }
  if (lowerName.includes('amazon') || lowerCmd.includes('amazon') || lowerName.includes('aws') || lowerCmd.includes('aws')) {
    return '/icons/amazon.svg';
  }
  if (lowerName.includes('groq') || lowerCmd.includes('groq')) {
    return '/icons/groq.svg';
  }
  if (lowerName.includes('kimi') || lowerCmd.includes('kimi') || lowerName.includes('moonshot') || lowerCmd.includes('moonshot')) {
    return '/icons/kimi.svg';
  }
  if (lowerName.includes('mistral') || lowerCmd.includes('mistral')) {
    return '/icons/mistral.svg';
  }
  if (lowerName.includes('cline') || lowerCmd.includes('cline')) {
    return '/icons/cline.svg';
  }
  if (lowerName.includes('cursor') || lowerCmd.includes('cursor')) {
    return '/icons/cursor.svg';
  }
  if (lowerName.includes('grok') || lowerCmd.includes('grok')) {
    return '/icons/grok.svg';
  }
  if (matchesPiLocalTerminalCommand(name, command)) {
    return '/icons/pi.svg';
  }
  if (lowerName === '本地终端' || !command.trim()) {
    return '/icons/local.svg';
  }
  return null;
};



// 专属图标直接复用统一匹配结果，避免新增工具时列表图标和标签标题规则不同步。
export const hasExclusiveLocalTerminalIcon = (name: string, command: string) => {
  const iconPath = getLocalTerminalIcon(name, command);
  return Boolean(iconPath && iconPath !== '/icons/local.svg');
};



// 本地终端标题要兼容空命令，避免纯 shell 会话显示成“ · 目录”。
export const normalizeLocalTerminalProfileTitle = (cwd: string, command: string) => command ? `${command} · ${cwd}` : cwd;



// 顶部 tab 宽度有限，本地目录只取最后一级；历史和会话详情仍保留完整路径。
export const getLocalTerminalDirectoryName = (cwd?: string, fallbackLabel = '本地终端') => {
  const normalized = cwd?.trim().replace(/[\\/]+$/, '');
  if (!normalized) {
    return fallbackLabel;
  }
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) || normalized;
};



// 本地终端 tab 用短标题展示，若匹配专属工具图标或无启动命令，则隐藏命令前缀以节省空间；否则加上命令前缀。
export const formatLocalTerminalTabLabel = (session: TerminalSession, fallbackLabel = '本地终端') => {
  const directoryName = getLocalTerminalDirectoryName(session.cwd, fallbackLabel);
  const fullCwd = session.cwd?.trim();
  const command = fullCwd && session.title.endsWith(` · ${fullCwd}`)
    ? session.title.slice(0, -` · ${fullCwd}`.length).trim()
    : '';
  if (!command) {
    return directoryName;
  }
  if (hasExclusiveLocalTerminalIcon(session.title, session.localCommand ?? '')) {
    return directoryName;
  }
  return `${command} · ${directoryName}`;
};



// 新建历史目录时同步生成标题和最近使用时间，后端会再次校验目录有效性。
export const createLocalTerminalProfile = (cwd: string, command: string): LocalTerminalProfile => ({
  id: crypto.randomUUID(),
  title: normalizeLocalTerminalProfileTitle(cwd, command),
  cwd,
  command,
  lastUsedAt: nowIso(),
});
