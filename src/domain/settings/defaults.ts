/* 本模块从 Store 中按业务边界提取；领域规则不得依赖 Zustand，应用服务只暴露稳定操作。 */
import type { AppSettings, LocalTerminalSettings } from '../../types';

export const defaultSettings: AppSettings = {
  uiLanguage: 'zh-CN',
  themeMode: 'light',
  runtimeRefreshIntervalSec: 1,
  // 大文件扫描独立于常规运行状态，默认 5 秒刷新一次。
  runtimeStorageRefreshIntervalSec: 5,
  // 进程/线程资源明细只在内存展开时刷新，默认 3 秒。
  runtimeResourceRefreshIntervalSec: 3,
  runtimeResourceSource: 'system',
  sshKeepaliveIntervalSec: 30,
  // 默认终端西文字体：内置 JetBrains Mono Light
  shellLatinFontFamily: 'JetBrains Mono Light',
  // 默认终端中文字体：内置 Maple Mono Normal NF CN Light
  shellCjkFontFamily: 'Maple Mono Normal NF CN Light',
  shellFontFamily: 'JetBrains Mono Light',
  shellFontSize: 15,
  // 终端行高沿用历史硬编码值，升级后画面密度保持不变。
  shellLineHeight: 1.18,
  terminalBackground: '#f7f7f7',
  terminalForeground: '#111111',
  accentColor: '#4f46e5',
  backgroundImage: '',
  terminalBackgroundImageOpacity: 0.18,
  terminalBackgroundImageFit: 'cover',
  terminalRightClickBehavior: 'paste',
  terminalLineWrapMode: 'wrap',
  terminalMatchSelection: true,
  // 行号栏默认显示行号与时间戳，与常见远程终端习惯保持一致。
  terminalGutterShowLineNumber: true,
  terminalGutterShowTimestamp: true,
  compactSidebar: false,
  showCommandGhost: true,
  // Windows 硬件加速默认开启；软件渲染仅作为显卡兼容与本机对照选项，不预设其一定更省内存。
  hardwareAcceleration: true,
  connectionGroups: [],
  connectionOrder: [],
  quickCommands: ['pwd', 'ls -la', 'docker ps'],
  webdav: {
    baseUrl: '',
    username: '',
    password: '',
    syncPassphrase: '',
    remotePath: '/myterminal',
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



// 本地终端默认提供“纯 shell”和常见 AI CLI，空命令由后端解释为打开系统 shell。
export const defaultLocalTerminals: LocalTerminalSettings = {
  shellPath: '',
  commands: [
    { id: 'shell', name: '本地终端', command: '', builtIn: true },
    { id: 'claude', name: 'claude', command: 'claude', builtIn: true },
    { id: 'codex', name: 'codex', command: 'codex', builtIn: true },
    { id: 'opencode', name: 'opencode', command: 'opencode', builtIn: true },
  ],
  profiles: [],
};
