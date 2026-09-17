/* 本模块由 App 入口按功能域拆出，保留原组件行为与状态订阅方式。 */
import { convertFileSrc } from '@tauri-apps/api/core';
import type { LocalTerminalProfile, TerminalSession } from '../types';

// 本地终端首次打开时默认指向当前工作区，用户仍可在弹窗内切换任意目录。
export const defaultLocalTerminalCwd = 'C:\\Software\\WorkSpace\\MyTerminal';

// 将文件路径、网络图片或内置路径解析为前端 img 可访问的 URL
export const resolveIconDisplayUrl = (icon?: string | null): string | undefined => {
  if (!icon || icon === 'none') {
    return undefined;
  }
  const trimmed = icon.trim();
  if (!trimmed) {
    return undefined;
  }
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('data:')
  ) {
    return trimmed;
  }
  try {
    return convertFileSrc(trimmed);
  } catch {
    return trimmed;
  }
};



export const nowIso = () => new Date().toISOString();

// 空命令代表直接打开本地 shell，是本地终端和 AI CLI 之间的兜底启动项。
export const localTerminalShellCommand = { id: 'shell', name: '本地终端', command: '', builtIn: true };



// Pi 名称很短，必须按独立命令词匹配，避免把 pip、spin 等普通命令误识别成 Pi Coding Agent。
export const matchesPiLocalTerminalCommand = (name: string, command: string) => {
  const piCommandPattern = /(^|[\s\\/'"]+)pi(?:\.(?:exe|cmd|bat|ps1))?(?=$|[\s'"])/i;
  return piCommandPattern.test(name) || piCommandPattern.test(command);
};



// 格式化系统终端名称，精简冗余前后缀
export const cleanShellName = (name: string): string => {
  const trimmed = name.trim();
  if (trimmed === '命令提示符 CMD' || trimmed === '命令提示符') {
    return 'CMD';
  }
  // Windows PowerShell 规范简写为 PowerShell 5，与 PowerShell 7 形成清晰版本对比
  if (trimmed === 'Windows PowerShell' || trimmed === 'PowerShell') {
    return 'PowerShell 5';
  }
  if (trimmed.startsWith('WSL · ') || trimmed.startsWith('WSL ·')) {
    return 'WSL';
  }
  return trimmed;
};

export interface CommandIconItem {
  id: string;
  name: string;
  path: string;
  category: 'ai' | 'shell';
}

// AI 助手预设图标列表
export const AI_COMMAND_ICONS: CommandIconItem[] = [
  { id: 'claude', name: 'Claude', path: '/icons/claude.svg', category: 'ai' },
  { id: 'codex', name: 'Codex', path: '/icons/codex.svg', category: 'ai' },
  { id: 'qwen', name: 'Qwen', path: '/icons/qwen.svg', category: 'ai' },
  { id: 'opencode', name: 'OpenCode', path: '/icons/opencode.svg', category: 'ai' },
  { id: 'gemini', name: 'Gemini', path: '/icons/gemini.svg', category: 'ai' },
  { id: 'deepseek', name: 'DeepSeek', path: '/icons/deepseek.svg', category: 'ai' },
  { id: 'copilot', name: 'Copilot', path: '/icons/copilot.svg', category: 'ai' },
  { id: 'cursor', name: 'Cursor', path: '/icons/cursor.svg', category: 'ai' },
  { id: 'openai', name: 'OpenAI', path: '/icons/openai.svg', category: 'ai' },
  { id: 'pi', name: 'Pi', path: '/icons/pi.svg', category: 'ai' },
  { id: 'grok', name: 'Grok', path: '/icons/grok.svg', category: 'ai' },
  { id: 'kimi', name: 'Kimi', path: '/icons/kimi.svg', category: 'ai' },
  { id: 'mistral', name: 'Mistral', path: '/icons/mistral.svg', category: 'ai' },
];

// 系统终端 Shell 预设图标列表
export const SHELL_COMMAND_ICONS: CommandIconItem[] = [
  { id: 'pwsh-7', name: 'PowerShell 7', path: '/icons/powershell7.svg', category: 'shell' },
  { id: 'powershell', name: 'PowerShell 5', path: '/icons/powershell.svg', category: 'shell' },
  { id: 'cmd', name: 'CMD', path: '/icons/cmd.svg', category: 'shell' },
  { id: 'git', name: 'Git Bash', path: '/icons/git.svg', category: 'shell' },
  { id: 'ubuntu', name: 'Ubuntu', path: '/icons/ubuntu.svg', category: 'shell' },
  { id: 'wsl', name: 'WSL', path: '/icons/wsl.svg', category: 'shell' },
];

// 综合图标列表（优先 AI 工具，紧接着系统终端 Shell）
export const AVAILABLE_COMMAND_ICONS: CommandIconItem[] = [
  ...AI_COMMAND_ICONS,
  ...SHELL_COMMAND_ICONS,
];

// 权威解析系统终端 Shell 图标，纠正历史持久化数据中的旧路径，并精准匹配 Windows Terminal 规范图标
export const getSystemShellIcon = (shell: {
  id: string;
  name: string;
  command?: string;
  args?: string[];
  icon?: string;
}): string => {
  const lowerId = (shell.id || '').toLowerCase();
  const lowerName = (shell.name || '').toLowerCase();
  const lowerCmd = (shell.command || '').toLowerCase();
  const argsStr = (shell.args || []).join(' ').toLowerCase();

  // 1. 优先判定 PowerShell 7 / pwsh（无论旧配置存了什么，均优先使用 powershell7.svg）
  if (
    lowerId === 'pwsh-7' ||
    lowerId === 'pwsh' ||
    lowerName.includes('powershell 7') ||
    lowerName.includes('pwsh 7') ||
    lowerName === 'pwsh' ||
    lowerCmd.includes('pwsh.exe') ||
    lowerCmd.includes('powershell\\7')
  ) {
    return '/icons/powershell7.svg';
  }

  // 2. Windows PowerShell (5.1 经典蓝色)
  if (
    lowerId === 'powershell' ||
    lowerName.includes('powershell') ||
    lowerCmd.includes('windowspowershell')
  ) {
    return '/icons/powershell.svg';
  }

  // 3. 命令提示符 CMD (Windows 4-pane 磁贴徽标)
  if (
    lowerId === 'cmd' ||
    lowerName.includes('cmd') ||
    lowerName.includes('命令提示符') ||
    lowerCmd.includes('cmd.exe')
  ) {
    return '/icons/cmd.svg';
  }

  // 4. Git Bash (Git for Windows 官方 4 色菱形终端徽标)
  if (
    lowerId === 'git-bash' ||
    lowerId === 'git' ||
    lowerName.includes('git bash') ||
    lowerCmd.includes('bash.exe')
  ) {
    return '/icons/git.svg';
  }

  // 5. WSL 发行版 (若名称为通用的 WSL 则统一展示官方通用 WSL 企鹅图标；明确指定 Ubuntu/Debian 时展示对应发行版图标)
  if (lowerId.startsWith('wsl') || lowerName.includes('wsl') || lowerCmd.includes('wsl.exe')) {
    if (lowerName === 'wsl') {
      return '/icons/wsl.svg';
    }
    if (lowerName.includes('ubuntu') || argsStr.includes('ubuntu')) {
      return '/icons/ubuntu.svg';
    }
    if (lowerName.includes('debian') || argsStr.includes('debian')) {
      return '/icons/debian.svg';
    }
    return '/icons/wsl.svg';
  }

  // 6. Nushell
  if (lowerId === 'nushell' || lowerName.includes('nu') || lowerCmd.includes('nu.exe')) {
    return '/icons/nu.svg';
  }

  // 7. 如果 shell.icon 存在且不是旧的 powershell.svg / local.svg
  if (shell.icon && shell.icon !== '/icons/powershell.svg' && shell.icon !== '/icons/local.svg') {
    return shell.icon;
  }

  return '/icons/powershell7.svg';
};

// 根据命令名称和实际命令内容动态匹配工具图标；纯 Shell 使用本地图标，未匹配的自定义命令不显示图标。
export const getLocalTerminalIcon = (name: string, command: string, customIcon?: string) => {
  if (customIcon !== undefined) {
    if (!customIcon || customIcon === 'none') {
      return undefined;
    }
    return customIcon;
  }
  const lowerName = name.toLowerCase();
  const lowerCmd = command.toLowerCase();
  if (lowerCmd.startsWith('shell:')) {
    const shellId = lowerCmd.slice(6);
    return getSystemShellIcon({ id: shellId, name, command });
  }
  if (lowerName.includes('pwsh') || lowerName.includes('powershell 7') || lowerCmd.includes('pwsh')) {
    return '/icons/powershell7.svg';
  }
  if (lowerName.includes('cmd') || lowerCmd.includes('cmd.exe') || lowerName.includes('命令提示符')) {
    return '/icons/cmd.svg';
  }
  if (lowerName.includes('git') || lowerCmd.includes('bash.exe')) {
    return '/icons/git.svg';
  }
  if (lowerName.includes('ubuntu')) {
    return '/icons/ubuntu.svg';
  }
  if (lowerName.includes('debian')) {
    return '/icons/debian.svg';
  }
  if (lowerName.includes('wsl') || lowerCmd.includes('wsl.exe')) {
    return '/icons/wsl.svg';
  }
  if (lowerName.includes('powershell') || lowerCmd.includes('powershell')) {
    return '/icons/powershell.svg';
  }
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
  if (lowerName.includes('amazon') || lowerCmd.includes('amazon') || lowerName.includes('aws') || lowerName.includes('aws')) {
    return '/icons/amazon.svg';
  }
  if (lowerName.includes('groq') || lowerCmd.includes('groq')) {
    return '/icons/groq.svg';
  }
  if (lowerName.includes('kimi') || lowerCmd.includes('kimi') || lowerName.includes('moonshot') || lowerName.includes('moonshot')) {
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
