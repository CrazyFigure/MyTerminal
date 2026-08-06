//! 命令缓冲、建议、快捷命令与终端输入背压动作。

import { backend } from "../../backend";
import {
  isUsableRemoteSession,
  isUsableTerminalSession,
} from "../../domain/sessions/model";
import { guessNextRemotePath } from "../../domain/terminal/navigation";
import {
  extractCompletedTerminalInputLines,
  flushQueuedTerminalInput,
  isBulkTerminalInput,
  normalizeCommandPanelTerminalInput,
  normalizeRemoteTerminalContinuationEnter,
  queueTerminalInput,
  shouldFlushTerminalInputImmediately,
  terminalBulkInputFlushDelayMs,
  terminalInteractiveInputFlushDelayMs,
} from "../terminal/inputQueue";
import type { StoreGet, StoreSet, StoreState } from "./contracts";
import { statusText } from "./status";

type TerminalInputActionKeys =
  | "setCommandBuffer"
  | "acceptSuggestion"
  | "requestSuggestions"
  | "sendCommand"
  | "sendTerminalData"
  | "passthroughTab"
  | "runQuickCommand";

export type TerminalInputActions = Pick<StoreState, TerminalInputActionKeys>;

// 输入工厂负责把 UI 意图转换成有序 PTY 写入，并维护命令历史与远端路径预判。
export const createTerminalInputActions = (
  set: StoreSet,
  get: StoreGet,
): TerminalInputActions => ({
  setCommandBuffer: (sessionId, value) =>
    set((state) => ({
      commandBuffers: {
        ...state.commandBuffers,
        [sessionId]: value,
      },
    })),

  acceptSuggestion: (sessionId, suggestion) =>
    set((state) => ({
      commandBuffers: {
        ...state.commandBuffers,
        [sessionId]: suggestion,
      },
      suggestions: {
        ...state.suggestions,
        [sessionId]: suggestion ? [suggestion] : [],
      },
    })),

  requestSuggestions: async (sessionId, connectionId, prefix) => {
    if (!prefix.trim()) {
      set((state) => ({
        suggestions: { ...state.suggestions, [sessionId]: [] },
      }));
      return;
    }

    const suggestions = await backend.getSuggestions(connectionId, prefix);
    set((state) => ({
      suggestions: {
        ...state.suggestions,
        [sessionId]: suggestions,
      },
    }));
  },

  sendCommand: async (sessionId) => {
    const state = get();
    const rawCommand = state.commandBuffers[sessionId] ?? "";
    const command = rawCommand.trim();
    if (!command) {
      return;
    }

    const session = state.sessions.find((item) => item.id === sessionId);
    if (!isUsableTerminalSession(session)) {
      return;
    }
    const nextRemotePath =
      isUsableRemoteSession(session) &&
      session?.connectionId === state.activeConnectionId
        ? // cd 相对路径必须以终端 Shell 的 cwd 为基准，不能使用可能已被用户单独浏览到别处的文件管理路径。
          guessNextRemotePath(
            session.cwd || state.currentRemotePath || "~",
            rawCommand,
          )
        : undefined;

    await flushQueuedTerminalInput(sessionId);
    // SSH 底栏统一按交互 PTY 语义发送：普通换行是 Enter，行尾反斜杠换行固定为 LF 续行；本地程序保持原输入协议。
    const terminalPayload = isUsableRemoteSession(session)
      ? normalizeCommandPanelTerminalInput(rawCommand)
      : rawCommand.endsWith("\n")
        ? rawCommand
        : `${rawCommand}\n`;
    if (isUsableRemoteSession(session)) {
      // 底栏与终端本体共用同一 PTY，命令跟踪状态也必须消费完全相同的 payload，避免后续 Enter 读取到旧行。
      extractCompletedTerminalInputLines(sessionId, terminalPayload);
    }
    await backend.writeTerminalInput(sessionId, terminalPayload);

    set((prev) => ({
      commandBuffers: { ...prev.commandBuffers, [sessionId]: "" },
      suggestions: { ...prev.suggestions, [sessionId]: [] },
      statusMessage: statusText(prev.settings, "statusSentCommand", {
        target: session?.title ?? "session",
      }),
    }));

    void get().pollTerminalOutputs();
    if (isUsableRemoteSession(session) && session?.connectionId) {
      void get().refreshRemoteHistory(session.connectionId);
    }
    if (nextRemotePath) {
      void get().refreshFiles(nextRemotePath);
    }
  },

  sendTerminalData: async (sessionId, data) => {
    const state = get();
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!isUsableTerminalSession(session)) {
      return;
    }

    // 只修正 SSH Shell 的反斜杠续行 Enter；本地 TUI/程序依赖原始键码，不能套用 Shell 规则。
    const terminalData = isUsableRemoteSession(session)
      ? normalizeRemoteTerminalContinuationEnter(sessionId, data)
      : data;

    let nextRemotePath: string | undefined;
    let completedInputLines: string[] = [];
    let continuationLineBreaks = 0;
    if (
      isUsableRemoteSession(session) &&
      session.connectionId === state.activeConnectionId
    ) {
      // 文件管理器允许独立浏览；终端内连续 cd 的相对路径始终从 Shell cwd 推导，避免 cd .. 被面板路径带偏。
      let pathCursor = session.cwd || state.currentRemotePath || "~";
      const trackedInput = extractCompletedTerminalInputLines(
        sessionId,
        terminalData,
      );
      completedInputLines = trackedInput.completedLines;
      continuationLineBreaks = trackedInput.continuationLineBreaks;
      for (const completedLine of completedInputLines) {
        const guessedPath = guessNextRemotePath(pathCursor, completedLine);
        if (guessedPath) {
          pathCursor = guessedPath;
          nextRemotePath = guessedPath;
        }
      }
    } else if (isUsableRemoteSession(session)) {
      // 非当前连接也必须维护续行缓冲，否则切换回来后 Enter 无法判断前一字符是否为反斜杠。
      const trackedInput = extractCompletedTerminalInputLines(
        sessionId,
        terminalData,
      );
      completedInputLines = trackedInput.completedLines;
      continuationLineBreaks = trackedInput.continuationLineBreaks;
    }

    const hasLineBreak =
      terminalData.includes("\r") || terminalData.includes("\n");
    // 单独的反斜杠续行仍处于同一条逻辑命令，不触发“命令已提交”后的轮询和目录刷新。
    const submittedInput =
      hasLineBreak &&
      (completedInputLines.length > 0 || continuationLineBreaks === 0);
    const flushDelayMs = shouldFlushTerminalInputImmediately(terminalData)
      ? 0
      : isBulkTerminalInput(terminalData)
        ? terminalBulkInputFlushDelayMs
        : terminalInteractiveInputFlushDelayMs;
    queueTerminalInput(sessionId, terminalData, flushDelayMs);
    if (hasLineBreak) {
      await flushQueuedTerminalInput(sessionId);
      if (submittedInput) {
        void get().pollTerminalOutputs();
        if (nextRemotePath) {
          // 终端本体里粘贴或手输 cd 不经过命令面板，先用输入侧预测兜底刷新；后端真实 PWD 标记回来后会再次校正。
          void get().refreshFiles(nextRemotePath);
        }
      }
      return;
    }
  },

  passthroughTab: async (sessionId) => {
    queueTerminalInput(sessionId, "\t");
    await flushQueuedTerminalInput(sessionId);
    void get().pollTerminalOutputs();
  },

  runQuickCommand: async (command) => {
    const { activeSessionId } = get();
    if (!activeSessionId) {
      return;
    }

    set((state) => ({
      commandBuffers: {
        ...state.commandBuffers,
        [activeSessionId]: command,
      },
    }));
    await get().sendCommand(activeSessionId);
  },
});
