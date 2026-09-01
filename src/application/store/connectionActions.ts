import { backend } from '../../backend';
import {
  buildConnectionProfile,
  emptyConnectionDraft,
  emptyJumpHostDraft,
  emptyProxyDraft,
  getConnectionDraftValidationKey,
  isGroupOrChildPath,
  mergeConnectionGroups,
  normalizeConnectionGroupPath,
  normalizeLoadedConnection,
} from '../../domain/connections/model';
import type { ConnectionProfile } from '../../types';
import type { StoreGet, StoreSet, StoreState } from './contracts';
import { statusText } from './status';

type ConnectionActionKeys =
  | 'openConnectionForm'
  | 'closeConnectionForm'
  | 'updateConnectionDraft'
  | 'saveConnectionDraft'
  | 'testConnectionDraft'
  | 'deleteConnection'
  | 'duplicateConnection'
  | 'createConnectionGroup'
  | 'renameConnectionGroup'
  | 'deleteConnectionGroup'
  | 'reorderConnectionGroups'
  | 'reorderConnections'
  | 'moveConnectionToGroup';

export type ConnectionActions = Pick<StoreState, ConnectionActionKeys>;

// 连接配置切片只管理持久化模型与分组树；真正打开 PTY 的会话生命周期由会话切片负责。
export const createConnectionActions = (set: StoreSet, get: StoreGet): ConnectionActions => ({
  openConnectionForm: (connection, groupPath) =>
    set({
      showConnectionForm: true,
      connectionTestResult: undefined,
      connectionDraft: connection
        ? {
            ...connection,
            protocol: connection.protocol === 'rdp' ? 'rdp' : 'ssh',
            authMethod: connection.authMethod ?? 'password',
            groupPath: connection.groupPath ?? '',
            password: connection.password ?? '',
            privateKeyPath: connection.privateKeyPath ?? '',
            privateKeyText: connection.privateKeyText ?? '',
            passphrase: connection.passphrase ?? '',
            jumpHosts: Array.isArray(connection.jumpHosts)
              ? connection.jumpHosts.map((jumpHost) => ({ ...emptyJumpHostDraft(), ...jumpHost }))
              : [],
            proxy: connection.proxy ? { ...emptyProxyDraft(), ...connection.proxy } : emptyProxyDraft(),
            note: connection.note ?? '',
          }
        : {
            ...emptyConnectionDraft(),
            // 从连接管理的当前目录新建时预填 groupPath，减少重复手输路径和误建到未分组的概率。
            groupPath: normalizeConnectionGroupPath(groupPath),
          },
    }),

  closeConnectionForm: () =>
    set({ showConnectionForm: false, connectionDraft: emptyConnectionDraft(), connectionTestResult: undefined }),

  updateConnectionDraft: (key, value) =>
    set((state) => ({
      connectionTestResult: undefined,
      connectionDraft: {
        ...state.connectionDraft,
        [key]: value,
      },
    })),

  saveConnectionDraft: async () => {
    const draft = get().connectionDraft;
    const validationKey = getConnectionDraftValidationKey(draft);
    if (validationKey) {
      set((state) => ({
        statusMessage: statusText(state.settings, validationKey),
      }));
      return;
    }

    const isExisting = Boolean(draft.id);
    const connection = buildConnectionProfile(draft);

    try {
      const saved = await backend.upsertConnection(connection, isExisting);
      const currentSettings = get().settings;
      const nextGroupPath = normalizeConnectionGroupPath(saved.groupPath);
      // 新连接默认放到排序顶部；编辑旧连接时保留原排序，只补齐缺失的 id。
      const knownOrder = currentSettings.connectionOrder.filter((connectionId) => connectionId !== saved.id);
      const nextConnectionOrder = isExisting
        ? [...currentSettings.connectionOrder, saved.id].filter((connectionId, index, array) => array.indexOf(connectionId) === index)
        : [saved.id, ...knownOrder];
      const nextSettings = await backend.saveSettings({
        ...currentSettings,
        connectionGroups: nextGroupPath
          ? mergeConnectionGroups(currentSettings.connectionGroups, [nextGroupPath])
          : currentSettings.connectionGroups,
        connectionOrder: nextConnectionOrder,
      });
      set((state) => {
        const exists = state.connections.some((item) => item.id === saved.id);
        return {
          settings: nextSettings,
          connections: exists
            ? state.connections.map((item) => (item.id === saved.id ? normalizeLoadedConnection(saved) : item))
            : [normalizeLoadedConnection(saved), ...state.connections],
          activeConnectionId: saved.id,
          showConnectionForm: false,
          connectionDraft: emptyConnectionDraft(),
          connectionTestResult: undefined,
          statusMessage: statusText(state.settings, 'statusSavedConnection', { name: saved.name }),
        };
      });
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusConnectionSaveFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
    }
  },

  testConnectionDraft: async () => {
    const draft = get().connectionDraft;
    const validationKey = getConnectionDraftValidationKey(draft);
    if (validationKey) {
      set((state) => ({
        statusMessage: statusText(state.settings, validationKey),
      }));
      return;
    }

    const connection = buildConnectionProfile(draft);
    set((state) => ({
      loading: true,
      connectionTestResult: undefined,
      statusMessage: statusText(state.settings, connection.protocol === 'rdp' ? 'statusTestingRdp' : 'statusTestingConnection'),
    }));

    try {
      // RDP 测试只验证目标端口可达，不能把它表述成账号认证成功。
      const message = statusText(get().settings, connection.protocol === 'rdp' ? 'statusRdpTestPassed' : 'statusConnectionTestPassed', {
        name: connection.name || connection.host,
      });
      await backend.testConnection(connection);
      set({
        loading: false,
        connectionTestResult: { kind: 'success', message },
        statusMessage: message,
      });
    } catch (error) {
      const message = statusText(get().settings, 'statusConnectionTestFailed', {
        reason: error instanceof Error ? error.message : String(error),
      });
      set({
        loading: false,
        connectionTestResult: { kind: 'error', message },
        statusMessage: message,
      });
    }
  },


  deleteConnection: async (connectionId) => {
    await backend.deleteConnection(connectionId);
    const nextSettings = await backend.saveSettings({
      ...get().settings,
      // 删除连接时同步清理人工排序，避免后续拖拽列表夹带无效 id。
      connectionOrder: get().settings.connectionOrder.filter((item) => item !== connectionId),
    });
    set((state) => {
      const removedSessionIds = state.sessions
        .filter((item) => item.connectionId === connectionId)
        .map((item) => item.id);
      const nextSessions = state.sessions.filter((item) => item.connectionId !== connectionId);
      const nextActiveSessionId = removedSessionIds.includes(state.activeSessionId ?? '')
        ? nextSessions[0]?.id
        : state.activeSessionId;
      const nextActiveConnectionId = nextActiveSessionId
        ? nextSessions.find((item) => item.id === nextActiveSessionId)?.connectionId
        : state.activeConnectionId === connectionId
          ? state.connections.find((item) => item.id !== connectionId)?.id
          : state.activeConnectionId;
      const deletedActiveConnection = state.activeConnectionId === connectionId;

      const nextCommandBuffers = { ...state.commandBuffers };
      const nextSuggestions = { ...state.suggestions };
      removedSessionIds.forEach((sessionId) => {
        delete nextCommandBuffers[sessionId];
        delete nextSuggestions[sessionId];
      });

      return {
        settings: nextSettings,
        connections: state.connections.filter((item) => item.id !== connectionId),
        sessions: nextSessions,
        activeConnectionId: nextActiveConnectionId,
        activeSessionId: nextActiveSessionId,
        files: deletedActiveConnection ? [] : state.files,
        currentRemotePath: deletedActiveConnection ? nextSessions.find((item) => item.id === nextActiveSessionId)?.cwd ?? '' : state.currentRemotePath,
        commandBuffers: nextCommandBuffers,
        suggestions: nextSuggestions,
        statusMessage: statusText(state.settings, 'statusConnectionDeleted'),
      };
    });
  },

  duplicateConnection: async (connectionId, groupPath) => {
    const { connections, settings } = get();
    const source = connections.find((item) => item.id === connectionId);
    if (!source) {
      return;
    }

    const targetGroupPath = normalizeConnectionGroupPath(groupPath);
    const baseName = `${source.name} 副本`;
    const existingNames = new Set(connections.map((connection) => connection.name));
    let nextName = baseName;
    let copyIndex = 2;
    while (existingNames.has(nextName)) {
      nextName = `${baseName} ${copyIndex}`;
      copyIndex += 1;
    }

    // 复制连接时保留认证和备注等配置，只替换 id、名称和当前分组选区，避免误改原连接。
    const duplicatedConnection: ConnectionProfile = {
      ...source,
      id: crypto.randomUUID(),
      name: nextName,
      groupPath: targetGroupPath || undefined,
    };
    const saved = await backend.upsertConnection(duplicatedConnection, false);
    const sourceIndex = settings.connectionOrder.indexOf(source.id);
    const nextConnectionOrder = settings.connectionOrder.filter((item) => item !== saved.id);
    if (sourceIndex >= 0) {
      nextConnectionOrder.splice(sourceIndex + 1, 0, saved.id);
    } else {
      nextConnectionOrder.unshift(saved.id);
    }

    const nextSettings = await backend.saveSettings({
      ...settings,
      connectionGroups: targetGroupPath
        ? mergeConnectionGroups(settings.connectionGroups, [targetGroupPath])
        : settings.connectionGroups,
      connectionOrder: nextConnectionOrder,
    });

    set((state) => ({
      settings: nextSettings,
      connections: [normalizeLoadedConnection(saved), ...state.connections.filter((item) => item.id !== saved.id)],
      activeConnectionId: saved.id,
      statusMessage: statusText(nextSettings, 'statusConnectionDuplicated', { name: saved.name }),
    }));
  },

  createConnectionGroup: async (groupPath) => {
    const normalized = normalizeConnectionGroupPath(groupPath);
    if (!normalized) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'validationGroupPathRequired'),
      }));
      return undefined;
    }

    const { connections, settings } = get();
    const exists = mergeConnectionGroups(settings.connectionGroups, connections.map((connection) => connection.groupPath))
      .some((item) => item === normalized);
    if (exists) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'validationGroupPathDuplicate'),
      }));
      return undefined;
    }

    // 新增空分组只写入 settings；没有连接时也必须能在连接管理里立即显示。
    const nextSettings = await backend.saveSettings({
      ...settings,
      connectionGroups: mergeConnectionGroups(settings.connectionGroups, [normalized]),
    });

    set({
      settings: nextSettings,
      statusMessage: statusText(nextSettings, 'statusGroupSaved', { path: normalized }),
    });
    return normalized;
  },

  renameConnectionGroup: async (currentPath, nextPath) => {
    const current = normalizeConnectionGroupPath(currentPath);
    const next = normalizeConnectionGroupPath(nextPath);
    if (!current || !next) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'validationGroupPathRequired'),
      }));
      return undefined;
    }
    if (current === next) {
      return current;
    }
    if (isGroupOrChildPath(next, current)) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'validationGroupMoveIntoSelf'),
      }));
      return undefined;
    }

    const { connections, settings } = get();
    const duplicated = mergeConnectionGroups(settings.connectionGroups, connections.map((connection) => connection.groupPath))
      .some((item) => item === next && !isGroupOrChildPath(item, current));
    if (duplicated) {
      set({
        statusMessage: statusText(settings, 'validationGroupPathDuplicate'),
      });
      return undefined;
    }

    const movePath = (value: string | undefined) => {
      const normalized = normalizeConnectionGroupPath(value);
      if (!isGroupOrChildPath(normalized, current)) {
        return normalized || undefined;
      }

      const suffix = normalized.slice(current.length).replace(/^\//, '');
      return suffix ? `${next}/${suffix}` : next;
    };

    // 重命名分组会级联改写子分组与连接 groupPath，逐条保存可避免并发写连接文件。
    const nextConnections = connections.map((connection) => {
      const movedPath = movePath(connection.groupPath);
      return movedPath === connection.groupPath ? connection : { ...connection, groupPath: movedPath };
    });
    for (const connection of nextConnections) {
      const previous = connections.find((item) => item.id === connection.id);
      if (previous?.groupPath !== connection.groupPath) {
        await backend.upsertConnection(connection, true);
      }
    }

    const movedSettingsGroups = settings.connectionGroups.map((group) => movePath(group));
    const nextSettings = await backend.saveSettings({
      ...settings,
      connectionGroups: mergeConnectionGroups(movedSettingsGroups, nextConnections.map((connection) => connection.groupPath)),
    });

    set({
      settings: nextSettings,
      connections: nextConnections,
      statusMessage: statusText(nextSettings, 'statusGroupRenamed', { path: next }),
    });
    return next;
  },

  deleteConnectionGroup: async (groupPath) => {
    const normalized = normalizeConnectionGroupPath(groupPath);
    if (!normalized) {
      return;
    }

    const { connections, settings } = get();
    const targets = connections.filter((connection) => isGroupOrChildPath(connection.groupPath, normalized));

    // 删除分组按用户选择执行级联删除：分组、子分组和其中连接全部删除，不再移动到未分组。
    for (const connection of targets) {
      await get().deleteConnection(connection.id);
    }

    const nextSettings = await backend.saveSettings({
      ...get().settings,
      connectionGroups: settings.connectionGroups.filter((item) => !isGroupOrChildPath(item, normalized)),
    });

    set({
      settings: nextSettings,
      statusMessage: statusText(nextSettings, 'statusGroupDeleted', { path: normalized }),
    });
  },

  reorderConnectionGroups: async (groupPaths) => {
    const { connections, settings } = get();
    // 分组排序保存完整显式分组列表，并补上连接中仍在使用但旧设置未显式保存的分组。
    const nextSettings = await backend.saveSettings({
      ...settings,
      connectionGroups: mergeConnectionGroups(groupPaths, settings.connectionGroups, connections.map((connection) => connection.groupPath)),
    });
    set({ settings: nextSettings, statusMessage: statusText(nextSettings, 'statusSettingsSaved') });
  },

  reorderConnections: async (connectionIds) => {
    const { connections, settings } = get();
    const existingIds = connections.map((connection) => connection.id);
    // 连接排序只保存仍存在的连接 id，未参与拖拽的新连接追加到末尾，保证列表不会丢项。
    const nextOrder = [
      ...connectionIds.filter((connectionId) => existingIds.includes(connectionId)),
      ...existingIds.filter((connectionId) => !connectionIds.includes(connectionId)),
    ];
    const nextSettings = await backend.saveSettings({ ...settings, connectionOrder: nextOrder });
    set({ settings: nextSettings, statusMessage: statusText(nextSettings, 'statusSettingsSaved') });
  },

  moveConnectionToGroup: async (connectionId, groupPath) => {
    const normalized = normalizeConnectionGroupPath(groupPath);
    const { connections, settings } = get();
    const connection = connections.find((item) => item.id === connectionId);
    if (!connection) {
      return;
    }

    // 拖到未分组时清空 groupPath；拖到真实分组时先保存连接，再补齐显式分组列表。
    const nextConnection: ConnectionProfile = {
      ...connection,
      groupPath: normalized || undefined,
    };
    const saved = await backend.upsertConnection(nextConnection, true);
    const nextSettings = await backend.saveSettings({
      ...settings,
      connectionGroups: normalized ? mergeConnectionGroups(settings.connectionGroups, [normalized]) : settings.connectionGroups,
    });

    set((state) => ({
      settings: nextSettings,
      connections: state.connections.map((item) => (item.id === saved.id ? normalizeLoadedConnection(saved) : item)),
      statusMessage: statusText(nextSettings, 'statusSavedConnection', { name: saved.name }),
    }));
  },

});
