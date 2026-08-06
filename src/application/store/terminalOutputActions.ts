//! 终端输出拉取、元数据归并与掉线状态传播动作。

import { backend } from "../../backend";
import { isUsableRemoteSession } from "../../domain/sessions/model";
import type { SessionStatus, TerminalOutputChunk } from "../../types";
import type { StoreGet, StoreSet, StoreState } from "./contracts";
import { remoteFilesRequestCoordinator } from "./remoteFileActions";
import { cancelAutoReconnect, emitTerminalOutput } from "./sessionRuntime";

export type TerminalOutputActions = Pick<StoreState, "pollTerminalOutputs">;

// 输出工厂先广播高频内容，再将 cwd/status 低频元数据归并回 Store，避免终端帧触发整页渲染。
export const createTerminalOutputActions = (
  set: StoreSet,
  get: StoreGet,
): TerminalOutputActions => ({
  pollTerminalOutputs: async (targetSessionId) => {
    const { sessions } = get();
    const targetSessions = targetSessionId
      ? sessions.filter((session) => session.id === targetSessionId)
      : sessions;
    if (!targetSessions.length) {
      return;
    }

    // 后端输出事件携带 sessionId 时只拉取对应会话；兜底轮询不传 sessionId，仍覆盖全部会话。
    const settledOutputs = await Promise.allSettled(
      targetSessions.map((session) => backend.readTerminalOutput(session.id)),
    );
    const outputFailures = new Set<string>();
    settledOutputs.forEach((result, index) => {
      if (result.status === "rejected") {
        const sessionId = targetSessions[index]?.id ?? "";
        console.error(
          `[SSH-DIAG] readTerminalOutput rejected for session=${sessionId}:`,
          result.reason,
        );
        outputFailures.add(sessionId);
      }
    });
    const outputs = settledOutputs
      .filter(
        (result): result is PromiseFulfilledResult<TerminalOutputChunk[]> =>
          result.status === "fulfilled",
      )
      .map((result) => result.value);
    const chunks = outputs.flat();
    chunks.forEach(emitTerminalOutput);

    // 远端 Shell 通过后端元数据回传 cwd/status：cwd 同步文件管理，status 只更新标签图标。
    const cwdBySession = new Map<string, string>();
    const statusBySession = new Map<string, SessionStatus>();
    chunks.forEach((chunk) => {
      const cwd = chunk.cwd?.trim();
      if (cwd) {
        cwdBySession.set(chunk.sessionId, cwd);
      }
      if (chunk.status) {
        statusBySession.set(chunk.sessionId, chunk.status);
      }
    });

    outputFailures.forEach((sessionId) => {
      if (sessionId) {
        statusBySession.set(sessionId, "error");
      }
    });

    if (!cwdBySession.size && !statusBySession.size) {
      return;
    }

    let activeCwdToDisplay: string | undefined;
    let activeCwdToRefresh: string | undefined;
    // 本轮状态变化中需要启动/取消自动重连的会话；在 set 之后统一处理，避免在 reducer 内触发副作用。
    const disconnectedSessionIds: string[] = [];
    const reconnectedSessionIds: string[] = [];
    set((state) => {
      let sessionsChanged = false;
      const nextSessions = state.sessions.map((session) => {
        const cwd = cwdBySession.get(session.id);
        const status = statusBySession.get(session.id);
        let nextSession = session;

        if (cwd && session.cwd !== cwd) {
          nextSession = { ...nextSession, cwd };
          sessionsChanged = true;
        }
        if (status && session.status !== status) {
          nextSession = { ...nextSession, status };
          sessionsChanged = true;
          // 仅对“已成功连上”又掉线的远端会话启动自动重连，不对初次握手失败反复重试。
          if (
            session.kind !== "local" &&
            (status === "error" || status === "closed") &&
            session.status === "connected"
          ) {
            disconnectedSessionIds.push(session.id);
          }
          // 重新稳定连上 → 取消重连计划并复位计数。
          if (status === "connected" || status === "stub") {
            reconnectedSessionIds.push(session.id);
          }
        }

        if (
          cwd &&
          session.id === state.activeSessionId &&
          session.connectionId === state.activeConnectionId &&
          isUsableRemoteSession(nextSession)
        ) {
          const pendingRequest = remoteFilesRequestCoordinator.latestPending();
          const pendingMatchesCwd = remoteFilesRequestCoordinator.isSameTarget(
            pendingRequest,
            session.connectionId,
            cwd,
          );
          const pendingConflictsWithCwd = Boolean(
            pendingRequest &&
            pendingRequest.connectionId === session.connectionId &&
            !pendingMatchesCwd,
          );

          if (state.currentRemotePath !== cwd) {
            // cwd 元数据来自交互 Shell 的真实 PWD，路径栏先同步；慢 SFTP 只影响列表内容，不应拖住路径反馈。
            activeCwdToDisplay = cwd;
          }
          if (
            !pendingMatchesCwd &&
            (state.currentRemotePath !== cwd || pendingConflictsWithCwd)
          ) {
            // 即使面板此刻恰好已在 cwd，也必须覆盖尚未完成的错误预判，防止旧请求稍后把列表带到错误目录。
            activeCwdToRefresh = cwd;
          }
        }

        return nextSession;
      });

      const activeSession = nextSessions.find(
        (session) => session.id === state.activeSessionId,
      );
      const activeSessionBecameUnavailable = activeSession
        ? !isUsableRemoteSession(activeSession)
        : false;
      const shouldClearActiveRemoteData =
        activeSessionBecameUnavailable &&
        (state.files.length > 0 ||
          Boolean(state.runtimeOverview) ||
          Boolean(state.currentRemotePath));
      // 只要会话变为不可用（含握手失败、cwd 为空的场景），就无条件熄灭加载动画；
      // 这一步不依赖是否有旧数据可清，否则握手失败又没有旧内容时动画会一直空转。
      const shouldStopLoading =
        activeSessionBecameUnavailable &&
        (state.filesLoading || state.runtimeLoading || state.historyLoading);

      return {
        ...(sessionsChanged ? { sessions: nextSessions } : {}),
        ...(activeCwdToDisplay
          ? { currentRemotePath: activeCwdToDisplay }
          : {}),
        // 会话变为不可用（断开/异常）时清掉残留的远端数据，避免继续展示上一台主机的内容。
        ...(shouldClearActiveRemoteData
          ? { files: [], runtimeOverview: undefined, currentRemotePath: "" }
          : {}),
        // 加载动画的熄灭独立判断，覆盖“无旧数据可清但动画已点亮”的握手失败场景。
        ...(shouldStopLoading
          ? {
              filesLoading: false,
              runtimeLoading: false,
              historyLoading: false,
            }
          : {}),
      };
    });

    if (activeCwdToRefresh) {
      // 刷新队列本身只保留最新目录，因此真实 cwd 可以立即校正列表，无需再额外等待固定防抖时间。
      void get().refreshFiles(activeCwdToRefresh);
    }

    // 已恢复的会话先取消重连计划（复位计数），再为新掉线的会话启动重连。
    reconnectedSessionIds.forEach(cancelAutoReconnect);
    disconnectedSessionIds.forEach((id) => get().scheduleAutoReconnect(id));
  },

  // 历史 Tab 以远端 Shell 历史文件为来源，刷新当前连接时替换对应连接缓存。
});
