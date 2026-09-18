/* 本模块从 Store 中按业务边界提取；领域规则不得依赖 Zustand，应用服务只暴露稳定操作。 */
import type { TerminalSession } from '../../types';

// 只有可交互远端会话才允许驱动文件、历史和运行状态刷新，异常/关闭会话只保留终端残留输出用于排查。
export const isUsableRemoteSession = (session?: TerminalSession): session is TerminalSession =>
  session?.kind !== 'local' && (session?.status === 'connected' || session?.status === 'stub');


export const isUsableTerminalSession = (session?: TerminalSession): session is TerminalSession =>
  Boolean(session && !['closed', 'error'].includes(session.status));


// 本地终端的 PTY 控制通道在「打开标签」时就已建立，启动阶段的输入会排在通道里等线程就绪，
// 因此 connecting 也视为可写入；只有真正关闭或异常才拒绝。SSH 不适用这条，握手未完成前不能写入。
export const isUsableLocalSession = (session?: TerminalSession): session is TerminalSession =>
  session?.kind === 'local' && isUsableTerminalSession(session);


// 底部「命令」面板的输入能力：远端沿用「握手完成」原语义，本地终端按 isUsableLocalSession 判定。
export const canAcceptCommandInput = (session?: TerminalSession) =>
  isUsableRemoteSession(session) || isUsableLocalSession(session);
