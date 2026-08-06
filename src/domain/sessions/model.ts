/* 本模块从 Store 中按业务边界提取；领域规则不得依赖 Zustand，应用服务只暴露稳定操作。 */
import type { TerminalSession } from '../../types';

// 只有可交互远端会话才允许驱动文件、历史和运行状态刷新，异常/关闭会话只保留终端残留输出用于排查。
export const isUsableRemoteSession = (session?: TerminalSession): session is TerminalSession =>
  session?.kind !== 'local' && (session?.status === 'connected' || session?.status === 'stub');


export const isUsableTerminalSession = (session?: TerminalSession): session is TerminalSession =>
  Boolean(session && !['closed', 'error'].includes(session.status));
