import { translate } from "../../i18n";
import type { AppSettings, TerminalOutputChunk } from "../../types";

// 本地终端命令为空时回退可读标题，状态栏不能展示空白动作。
export const localTerminalCommandLabel = (
  settings: AppSettings,
  command: string,
) => command.trim() || translate(settings.uiLanguage, "localTerminalTitle");

const terminalOutputEventName = "myterminal-terminal-output";

// 高频终端输出通过浏览器事件直达 xterm，避免写入 React 状态导致整页重渲染。
export const emitTerminalOutput = (chunk: TerminalOutputChunk) => {
  const hasTerminalSize =
    Number.isInteger(chunk.cols) && Number.isInteger(chunk.rows);
  if (typeof window === "undefined" || (!chunk.content && !hasTerminalSize)) {
    return;
  }
  window.dispatchEvent(
    new CustomEvent(terminalOutputEventName, { detail: chunk }),
  );
};

export type AutoReconnectEntry = {
  attempts: number;
  timer?: number;
  connectionId: string;
};

// 自动重连状态跨生命周期和输出动作共享，确保掉线检测与手动关闭操作同一份计划。
export const autoReconnectBySession = new Map<string, AutoReconnectEntry>();
export const autoReconnectMaxAttempts = 6;
export const autoReconnectDelayMs = (attempt: number) =>
  Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));

// 用户主动关闭、手动重连或会话恢复时必须取消旧计时器，避免迟到任务重开标签。
export const cancelAutoReconnect = (sessionId: string) => {
  const entry = autoReconnectBySession.get(sessionId);
  if (entry?.timer) {
    window.clearTimeout(entry.timer);
  }
  autoReconnectBySession.delete(sessionId);
};
