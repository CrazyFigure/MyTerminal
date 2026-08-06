//! 会话创建、复制、重连、排序与关闭的生命周期动作。

import { backend } from "../../backend";
import { isUsableRemoteSession } from "../../domain/sessions/model";
import type { LocalTerminalProfile, TerminalSession } from "../../types";
import { clearQueuedTerminalInput } from "../terminal/inputQueue";
import type { StoreGet, StoreSet, StoreState } from "./contracts";
import {
  autoReconnectBySession,
  autoReconnectDelayMs,
  autoReconnectMaxAttempts,
  cancelAutoReconnect,
  localTerminalCommandLabel,
} from "./sessionRuntime";
import { statusText } from "./status";

type LifecycleActionKeys =
  | "setActiveConnectionId"
  | "selectSession"
  | "openSession"
  | "adoptSession"
  | "saveLocalTerminals"
  | "openLocalTerminal"
  | "duplicateSession"
  | "reconnectSession"
  | "scheduleAutoReconnect"
  | "runAutoReconnect"
  | "reorderSessions"
  | "closeSession";

export type SessionLifecycleActions = Pick<StoreState, LifecycleActionKeys>;

// 生命周期工厂封装会话状态机和有限自动重连，输入输出动作通过 Store 契约与其协作。
export const createSessionLifecycleActions = (
  set: StoreSet,
  get: StoreGet,
): SessionLifecycleActions => ({
  setActiveConnectionId: (activeConnectionId) =>
    set((state) => {
      const matchedSession = activeConnectionId
        ? state.sessions.find(
            (item) => item.connectionId === activeConnectionId,
          )
        : undefined;
      const keepCurrentFiles = Boolean(
        matchedSession &&
        matchedSession.connectionId === state.activeConnectionId,
      );
      // 切到同一连接的其它会话时保留运行状态/文件旧内容，避免整块回退成空白；只有真正换连接才清空。
      const willRefreshRemote = isUsableRemoteSession(matchedSession);

      return {
        activeConnectionId,
        activeSessionId: matchedSession?.id,
        runtimeOverview: keepCurrentFiles ? state.runtimeOverview : undefined,
        // 只有换到别的连接且需要拉取远端时才进入加载态显示刷新动画；保留旧内容时不显示动画。
        runtimeLoading: willRefreshRemote && !keepCurrentFiles,
        files: keepCurrentFiles ? state.files : [],
        filesLoading: willRefreshRemote && !keepCurrentFiles,
        currentRemotePath: matchedSession?.cwd ?? "",
      };
    }),
  selectSession: (activeSessionId) =>
    set((state) => {
      const matchedSession = activeSessionId
        ? state.sessions.find((item) => item.id === activeSessionId)
        : undefined;
      const keepCurrentFiles = Boolean(
        matchedSession &&
        matchedSession.kind !== "local" &&
        matchedSession.connectionId === state.activeConnectionId,
      );
      const willRefreshRemote = isUsableRemoteSession(matchedSession);

      return {
        activeSessionId,
        activeConnectionId:
          matchedSession?.kind === "local"
            ? undefined
            : matchedSession?.connectionId,
        runtimeOverview: keepCurrentFiles ? state.runtimeOverview : undefined,
        runtimeLoading: willRefreshRemote && !keepCurrentFiles,
        files: keepCurrentFiles ? state.files : [],
        filesLoading: willRefreshRemote && !keepCurrentFiles,
        currentRemotePath:
          matchedSession?.kind === "local" ? "" : (matchedSession?.cwd ?? ""),
      };
    }),

  openSession: async (connectionId) => {
    const connection = get().connections.find(
      (item) => item.id === connectionId,
    );
    if (!connection) {
      return;
    }

    try {
      set({
        loading: true,
        statusMessage: statusText(
          get().settings,
          connection.protocol === "rdp"
            ? "statusOpeningRdp"
            : "statusOpeningSession",
          { name: connection.name },
        ),
      });
      if (connection.protocol === "rdp") {
        // RDP 交给系统 mstsc 独立窗口承载；启动成功后不创建 SSH 终端标签，也不刷新远端文件和运行状态。
        await backend.openRdpConnection(connectionId);
        set((state) => ({
          loading: false,
          statusMessage: statusText(state.settings, "statusRdpOpened", {
            name: connection.name,
          }),
        }));
        return;
      }
      const session = await backend.openSession(connectionId);
      const nextSession = { ...session, title: connection.name };
      set((state) => ({
        loading: false,
        sessions: [
          ...state.sessions.filter((item) => item.id !== nextSession.id),
          nextSession,
        ],
        activeSessionId: nextSession.id,
        activeConnectionId: connectionId,
        statusMessage: statusText(state.settings, "statusSessionReady", {
          name: connection.name,
        }),
        files: [],
        currentRemotePath: nextSession.cwd ?? "~",
        runtimeOverview: undefined,
        // 新开会话即将拉取远端数据，先点亮加载动画，等状态事件触发的刷新完成后自动熄灭。
        filesLoading: true,
        runtimeLoading: true,
      }));
      // SSH 握手在后端后台线程完成；连接状态事件回来后再刷新文件、运行状态和首屏输出。
      void get().pollTerminalOutputs(nextSession.id);
    } catch (error) {
      set((state) => ({
        loading: false,
        statusMessage: statusText(
          state.settings,
          "statusConnectionTestFailed",
          {
            reason: error instanceof Error ? error.message : String(error),
          },
        ),
      }));
    }
  },

  adoptSession: (session) => {
    const { sessions } = get();
    if (sessions.some((item) => item.id === session.id)) {
      return;
    }

    const connection = get().connections.find(
      (item) => item.id === session.connectionId,
    );
    set((state) => ({
      sessions: [
        ...state.sessions,
        { ...session, title: connection?.name ?? session.title },
      ],
      statusMessage: statusText(state.settings, "statusAgentTerminalOpened", {
        name: connection?.name ?? session.title,
      }),
    }));
    // 自动打开的标签要立刻切过去：内置 agent 与外部 MCP 开的 SSH 都走这条路径，
    // 用户希望直接看到 agent 在哪个终端里干活，而不是手动去找新标签。
    // 复用 selectSession 的面板切换逻辑，保证右侧文件/运行面板与手动点标签一致。
    // 注意只有「新建标签」才会触发 adoptSession；复用已有标签不抢焦点，避免每次工具调用都打断用户。
    get().selectSession(session.id);
    void get().pollTerminalOutputs(session.id);
  },

  saveLocalTerminals: async (settings) => {
    const saved = await backend.saveLocalTerminals(settings);
    set((state) => ({
      localTerminals: saved,
      statusMessage: statusText(state.settings, "statusSettingsSaved"),
    }));
    return saved;
  },

  openLocalTerminal: async (profile) => {
    try {
      const settings = get().settings;
      set({
        loading: true,
        statusMessage: statusText(settings, "statusLocalTerminalOpening", {
          command: localTerminalCommandLabel(settings, profile.command),
        }),
      });
      const session = await backend.openLocalTerminal(profile);
      const localTerminals = await backend.loadLocalTerminals();
      set((state) => ({
        loading: false,
        localTerminals,
        sessions: [
          ...state.sessions.filter((item) => item.id !== session.id),
          session,
        ],
        activeSessionId: session.id,
        activeConnectionId: undefined,
        files: [],
        currentRemotePath: "",
        runtimeOverview: undefined,
        // 本地终端没有远端面板，直接熄灭加载态，避免遗留卡死的动画。
        filesLoading: false,
        runtimeLoading: false,
        historyLoading: false,
        statusMessage: statusText(state.settings, "statusLocalTerminalOpened", {
          title: session.title,
        }),
      }));
      void get().pollTerminalOutputs(session.id);
    } catch (error) {
      set({
        loading: false,
        statusMessage: error instanceof Error ? error.message : String(error),
      });
    }
  },

  // 复制标签页：SSH 复用同一连接重新开一条会话（落在登录默认目录，不向远端注入 cd）；
  // 本地终端/TUI 复用同一启动项，因此新标签的目录与启动命令都与源标签一致。
  duplicateSession: async (sessionId) => {
    const state = get();
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) {
      return;
    }

    // 新标签紧跟源标签右侧插入，避免被追加到标签栏最末尾导致用户找不到。
    const insertAfterIndex = state.sessions.findIndex(
      (item) => item.id === sessionId,
    );
    const placeNextToSource = (
      current: StoreState,
      openedSession: TerminalSession,
    ) => {
      const filteredSessions = current.sessions.filter(
        (item) => item.id !== openedSession.id,
      );
      // 源标签可能在打开过程中被关闭，此时回退到追加，保证新会话不会丢失。
      const sourceIndex = filteredSessions.findIndex(
        (item) => item.id === sessionId,
      );
      const insertIndex =
        sourceIndex >= 0
          ? sourceIndex + 1
          : Math.min(insertAfterIndex + 1, filteredSessions.length);
      return [
        ...filteredSessions.slice(0, insertIndex),
        openedSession,
        ...filteredSessions.slice(insertIndex),
      ];
    };

    if (session.kind === "local") {
      // 目录与启动命令以会话自身为准：历史启动项会按目录去重覆盖，可能已被同目录的其它命令改写，
      // 而会话上的 cwd/localCommand 由后端在启动时写入，始终是这个标签真实使用的参数。
      const profile: LocalTerminalProfile = {
        // 沿用同一条历史启动项 id，复制标签只把它顶到历史列表最前，不额外新增一条重复记录。
        id: session.localProfileId ?? "",
        title: session.title,
        cwd: session.cwd ?? "",
        command: session.localCommand ?? "",
        lastUsedAt: "",
      };

      try {
        set({
          loading: true,
          statusMessage: statusText(
            state.settings,
            "statusLocalTerminalOpening",
            {
              command: localTerminalCommandLabel(
                state.settings,
                profile.command,
              ),
            },
          ),
        });
        const openedSession = await backend.openLocalTerminal(profile);
        const localTerminals = await backend.loadLocalTerminals();
        set((current) => ({
          loading: false,
          localTerminals,
          sessions: placeNextToSource(current, openedSession),
          activeSessionId: openedSession.id,
          activeConnectionId: undefined,
          files: [],
          currentRemotePath: "",
          runtimeOverview: undefined,
          // 本地终端没有远端面板，直接熄灭加载态。
          filesLoading: false,
          runtimeLoading: false,
          historyLoading: false,
          statusMessage: statusText(
            current.settings,
            "statusLocalTerminalOpened",
            { title: openedSession.title },
          ),
        }));
        void get().pollTerminalOutputs(openedSession.id);
      } catch (error) {
        set({
          loading: false,
          statusMessage: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    const connection = state.connections.find(
      (item) => item.id === session.connectionId,
    );
    if (!connection) {
      return;
    }

    try {
      set({
        loading: true,
        statusMessage: statusText(state.settings, "statusOpeningSession", {
          name: connection.name,
        }),
      });
      const openedSession = await backend.openSession(connection.id);
      const nextSession = { ...openedSession, title: connection.name };
      set((current) => ({
        loading: false,
        sessions: placeNextToSource(current, nextSession),
        activeSessionId: nextSession.id,
        activeConnectionId: connection.id,
        files: [],
        currentRemotePath: nextSession.cwd ?? "~",
        runtimeOverview: undefined,
        // 新会话即将拉取远端数据，先点亮加载动画，等状态事件触发的刷新完成后自动熄灭。
        filesLoading: true,
        runtimeLoading: true,
        statusMessage: statusText(current.settings, "statusSessionReady", {
          name: connection.name,
        }),
      }));
      void get().pollTerminalOutputs(nextSession.id);
    } catch (error) {
      set((current) => ({
        loading: false,
        statusMessage: statusText(
          current.settings,
          "statusConnectionTestFailed",
          {
            reason: error instanceof Error ? error.message : String(error),
          },
        ),
      }));
    }
  },

  reconnectSession: async (sessionId) => {
    // 手动重连会接管该会话，先取消尚在进行的自动重连计划，避免两者重复创建会话。
    cancelAutoReconnect(sessionId);
    const state = get();
    const session = state.sessions.find((item) => item.id === sessionId);
    if (!session) {
      return;
    }

    if (session.kind === "local") {
      const profile = state.localTerminals.profiles.find(
        (item) => item.id === session.localProfileId,
      ) ?? {
        id: session.localProfileId ?? crypto.randomUUID(),
        title: session.title,
        cwd: session.cwd ?? "",
        command: "",
        lastUsedAt: "",
      };
      const previousIndex = Math.max(
        0,
        state.sessions.findIndex((item) => item.id === sessionId),
      );
      clearQueuedTerminalInput(sessionId);
      set({
        loading: true,
        statusMessage: statusText(
          state.settings,
          "statusLocalTerminalReopening",
          {
            command: localTerminalCommandLabel(state.settings, profile.command),
          },
        ),
      });

      try {
        await backend.closeSession(sessionId).catch(() => undefined);
        const openedSession = await backend.openLocalTerminal(profile);
        const localTerminals = await backend.loadLocalTerminals();
        set((current) => {
          const filteredSessions = current.sessions.filter(
            (item) => item.id !== sessionId && item.id !== openedSession.id,
          );
          const insertIndex = Math.min(previousIndex, filteredSessions.length);
          const nextCommandBuffers = { ...current.commandBuffers };
          const nextSuggestions = { ...current.suggestions };
          delete nextCommandBuffers[sessionId];
          delete nextSuggestions[sessionId];

          return {
            loading: false,
            localTerminals,
            sessions: [
              ...filteredSessions.slice(0, insertIndex),
              openedSession,
              ...filteredSessions.slice(insertIndex),
            ],
            activeSessionId: openedSession.id,
            activeConnectionId: undefined,
            commandBuffers: nextCommandBuffers,
            suggestions: nextSuggestions,
            files: [],
            currentRemotePath: "",
            runtimeOverview: undefined,
            // 本地终端无远端面板，熄灭加载态。
            filesLoading: false,
            runtimeLoading: false,
            historyLoading: false,
            statusMessage: statusText(
              current.settings,
              "statusLocalTerminalOpened",
              { title: openedSession.title },
            ),
          };
        });
        void get().pollTerminalOutputs(openedSession.id);
      } catch (error) {
        set({
          loading: false,
          statusMessage: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    const connection = state.connections.find(
      (item) => item.id === session.connectionId,
    );
    if (!connection) {
      return;
    }

    const previousIndex = Math.max(
      0,
      state.sessions.findIndex((item) => item.id === sessionId),
    );
    clearQueuedTerminalInput(sessionId);
    set({
      loading: true,
      statusMessage: statusText(state.settings, "statusOpeningSession", {
        name: connection.name,
      }),
    });

    try {
      try {
        await backend.closeSession(sessionId);
      } catch {
        // 重连以重新打开会话为主；旧后端会话已断开时仍继续创建新 PTY。
      }

      const openedSession = await backend.openSession(connection.id);
      const nextSession = { ...openedSession, title: connection.name };
      set((current) => {
        const filteredSessions = current.sessions.filter(
          (item) => item.id !== sessionId && item.id !== nextSession.id,
        );
        const insertIndex = Math.min(previousIndex, filteredSessions.length);
        const nextSessions = [
          ...filteredSessions.slice(0, insertIndex),
          nextSession,
          ...filteredSessions.slice(insertIndex),
        ];
        const nextCommandBuffers = { ...current.commandBuffers };
        const nextSuggestions = { ...current.suggestions };
        delete nextCommandBuffers[sessionId];
        delete nextSuggestions[sessionId];

        return {
          loading: false,
          sessions: nextSessions,
          activeSessionId: nextSession.id,
          activeConnectionId: connection.id,
          commandBuffers: nextCommandBuffers,
          suggestions: nextSuggestions,
          files: [],
          currentRemotePath: nextSession.cwd ?? "~",
          runtimeOverview: undefined,
          // 重连后即将重新拉取远端数据，先点亮加载动画。
          filesLoading: true,
          runtimeLoading: true,
          statusMessage: statusText(current.settings, "statusSessionReady", {
            name: connection.name,
          }),
        };
      });

      // 重连后保持原标签位置；后台连上后由状态事件触发远端文件和运行状态首刷。
      void get().pollTerminalOutputs(nextSession.id);
    } catch (error) {
      set((current) => ({
        loading: false,
        statusMessage: statusText(
          current.settings,
          "statusConnectionTestFailed",
          {
            reason: error instanceof Error ? error.message : String(error),
          },
        ),
      }));
    }
  },

  scheduleAutoReconnect: (sessionId) => {
    const state = get();
    const session = state.sessions.find((item) => item.id === sessionId);
    // 仅对远端 SSH 会话自动重连；本地终端不在此机制内。
    if (!session || session.kind === "local") {
      return;
    }
    // 已在重连计划中则不重复调度，由既有计划/看门狗继续推进。
    if (autoReconnectBySession.has(sessionId)) {
      return;
    }
    const connection = state.connections.find(
      (item) => item.id === session.connectionId,
    );
    if (!connection) {
      return;
    }
    autoReconnectBySession.set(sessionId, {
      attempts: 0,
      connectionId: session.connectionId,
    });
    void get().runAutoReconnect(sessionId);
  },

  runAutoReconnect: async (sessionId) => {
    const entry = autoReconnectBySession.get(sessionId);
    if (!entry) {
      return;
    }
    const state = get();
    const session = state.sessions.find((item) => item.id === sessionId);
    // 会话已被移除（用户关闭标签）→ 结束计划。
    if (!session) {
      cancelAutoReconnect(sessionId);
      return;
    }
    // 已恢复到可用态 → 结束计划并复位计数，后续再掉线可重新获得完整重试次数。
    if (session.status === "connected" || session.status === "stub") {
      cancelAutoReconnect(sessionId);
      return;
    }
    const connection = state.connections.find(
      (item) => item.id === entry.connectionId,
    );
    if (!connection) {
      cancelAutoReconnect(sessionId);
      return;
    }
    if (entry.attempts >= autoReconnectMaxAttempts) {
      cancelAutoReconnect(sessionId);
      set((current) => ({
        statusMessage: statusText(
          current.settings,
          "statusAutoReconnectGaveUp",
          { name: connection.name },
        ),
      }));
      return;
    }

    entry.attempts += 1;
    // 仅当掉线会话本身是当前活动标签时才转移焦点到新会话，后台标签重连不打断用户当前操作。
    const wasActive = state.activeSessionId === sessionId;
    const previousIndex = Math.max(
      0,
      state.sessions.findIndex((item) => item.id === sessionId),
    );
    clearQueuedTerminalInput(sessionId);
    set((current) => ({
      statusMessage: statusText(current.settings, "statusAutoReconnecting", {
        name: connection.name,
        attempt: entry.attempts,
        max: autoReconnectMaxAttempts,
      }),
    }));

    try {
      try {
        await backend.closeSession(sessionId);
      } catch {
        // 旧会话可能已断开；忽略关闭错误，继续创建新 PTY。
      }
      const openedSession = await backend.openSession(connection.id);
      const nextSession = { ...openedSession, title: connection.name };
      // 迁移重连计划到新会话 ID：保留累计尝试次数，握手期由看门狗接管后续重试。
      autoReconnectBySession.delete(sessionId);
      autoReconnectBySession.set(nextSession.id, entry);
      set((current) => {
        const filteredSessions = current.sessions.filter(
          (item) => item.id !== sessionId && item.id !== nextSession.id,
        );
        const insertIndex = Math.min(previousIndex, filteredSessions.length);
        const nextSessions = [
          ...filteredSessions.slice(0, insertIndex),
          nextSession,
          ...filteredSessions.slice(insertIndex),
        ];
        const nextCommandBuffers = { ...current.commandBuffers };
        const nextSuggestions = { ...current.suggestions };
        delete nextCommandBuffers[sessionId];
        delete nextSuggestions[sessionId];
        return {
          sessions: nextSessions,
          commandBuffers: nextCommandBuffers,
          suggestions: nextSuggestions,
          // 只有原本处于活动标签时才把焦点与远端面板切到新会话。
          ...(wasActive
            ? {
                activeSessionId: nextSession.id,
                activeConnectionId: connection.id,
                currentRemotePath: nextSession.cwd ?? "~",
                files: [],
                runtimeOverview: undefined,
                filesLoading: true,
                runtimeLoading: true,
              }
            : {}),
        };
      });
      void get().pollTerminalOutputs(nextSession.id);
      // 看门狗：给足握手时间；到点若仍未连上则由 runAutoReconnect 递增尝试后再次重连。
      entry.timer = window.setTimeout(() => {
        void get().runAutoReconnect(nextSession.id);
      }, autoReconnectDelayMs(entry.attempts));
    } catch {
      // openSession 直接失败（如网络不可达）：按退避安排下一次尝试，会话 ID 未变。
      entry.timer = window.setTimeout(() => {
        void get().runAutoReconnect(sessionId);
      }, autoReconnectDelayMs(entry.attempts));
    }
  },

  reorderSessions: (sessionIds) =>
    set((state) => {
      const orderedIds = Array.from(new Set(sessionIds));
      const orderedSessions = orderedIds
        .map((sessionId) =>
          state.sessions.find((session) => session.id === sessionId),
        )
        .filter((session): session is TerminalSession => Boolean(session));
      const remainingSessions = state.sessions.filter(
        (session) => !orderedIds.includes(session.id),
      );

      // 标签排序只改前端顺序，不触碰后端 PTY；缺失 id 兜底追加，避免拖拽中状态刷新造成标签丢失。
      return { sessions: [...orderedSessions, ...remainingSessions] };
    }),

  closeSession: async (sessionId) => {
    // 用户主动关闭标签：取消自动重连，避免关闭瞬间迟到的 error 事件又拉起重连。
    cancelAutoReconnect(sessionId);
    clearQueuedTerminalInput(sessionId);
    try {
      await backend.closeSession(sessionId);
    } catch {
      // 关闭标签以清理前端状态为主；后端会话已丢失时仍允许用户从界面移除坏标签。
    }
    set((state) => {
      const nextSessions = state.sessions.filter(
        (item) => item.id !== sessionId,
      );
      const nextActiveSessionId =
        state.activeSessionId === sessionId
          ? nextSessions[0]?.id
          : state.activeSessionId;
      const nextActiveSession = nextActiveSessionId
        ? nextSessions.find((item) => item.id === nextActiveSessionId)
        : undefined;
      const nextActiveConnectionId =
        nextActiveSession?.kind === "local"
          ? undefined
          : nextActiveSession?.connectionId;
      const closedActiveSession = state.activeSessionId === sessionId;
      const nextCommandBuffers = { ...state.commandBuffers };
      const nextSuggestions = { ...state.suggestions };
      delete nextCommandBuffers[sessionId];
      delete nextSuggestions[sessionId];

      // 关闭当前会话后切到了另一条远端连接时，紧接着会重新拉取远端数据，需要点亮加载动画；
      // 切到本地/无会话则熄灭，避免遗留空转动画。
      const switchedToOtherRemote =
        closedActiveSession &&
        Boolean(nextActiveConnectionId) &&
        nextActiveConnectionId !== state.activeConnectionId;

      return {
        sessions: nextSessions,
        activeSessionId: nextActiveSessionId,
        activeConnectionId: nextActiveConnectionId,
        runtimeOverview: nextActiveConnectionId
          ? state.runtimeOverview
          : undefined,
        files:
          closedActiveSession && !nextActiveConnectionId ? [] : state.files,
        currentRemotePath: closedActiveSession
          ? nextActiveConnectionId
            ? (nextActiveSession?.cwd ?? "")
            : ""
          : state.currentRemotePath,
        filesLoading: switchedToOtherRemote,
        runtimeLoading: switchedToOtherRemote,
        historyLoading: false,
        commandBuffers: nextCommandBuffers,
        suggestions: nextSuggestions,
        statusMessage: statusText(state.settings, "statusSessionClosed"),
      };
    });
  },
});
