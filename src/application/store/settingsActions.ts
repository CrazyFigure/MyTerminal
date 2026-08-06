import { backend } from '../../backend';
import { normalizeLoadedConnection } from '../../domain/connections/model';
import type { StoreGet, StoreSet, StoreState } from './contracts';
import { statusText } from './status';

type SettingsActionKeys =
  | 'updateSettings'
  | 'persistSettings'
  | 'testWebdavConnection'
  | 'uploadConfig'
  | 'downloadConfig'
  | 'exportLocalConfig'
  | 'importLocalConfig'
  | 'checkForUpdates'
  | 'installUpdate';

export type SettingsActions = Pick<StoreState, SettingsActionKeys>;

// 设置切片统一处理草稿持久化、配置包同步和更新安装；任何全量配置替换都同时清理会话派生缓存。
export const createSettingsActions = (set: StoreSet, get: StoreGet): SettingsActions => ({
  updateSettings: (updater) => set((state) => ({ settings: updater(state.settings) })),

  persistSettings: async (settingsDraft) => {
    // 设置页使用草稿编辑，只有用户点击保存时才把草稿写入全局状态和本地文件。
    const settings = await backend.saveSettings(settingsDraft ?? get().settings);
    set({ settings, statusMessage: statusText(settings, 'statusSettingsSaved') });
    return settings;
  },

  testWebdavConnection: async (settingsDraft) => {
    const settings = settingsDraft ?? get().settings;
    await backend.testWebdavConnection(settings);
    set({ statusMessage: statusText(settings, 'statusWebdavTestPassed') });
  },

  uploadConfig: async () => {
    await get().persistSettings();
    const remotePath = await backend.uploadConfig();
    set({ statusMessage: statusText(get().settings, 'statusUploadedConfig', { path: remotePath }) });
  },

  downloadConfig: async (remotePath: string) => {
    const nextState = await backend.downloadConfig(remotePath);
    const nextActiveSessionId = nextState.sessions[0]?.id;
    const nextActiveConnectionId = nextState.sessions[0]?.connectionId;
    set({
      settings: nextState.settings,
      connections: nextState.connections.map((connection) => normalizeLoadedConnection(connection)),
      history: nextState.history,
      sessions: nextState.sessions,
      tunnels: nextState.tunnels,
      activeConnectionId: nextActiveConnectionId,
      activeSessionId: nextActiveSessionId,
      commandBuffers: {},
      suggestions: {},
      files: [],
      currentRemotePath: nextActiveSessionId ? '~' : '',
      runtimeOverview: undefined,
      filesLoading: false,
      runtimeLoading: false,
      historyLoading: false,
      editorDocument: undefined,
      statusMessage: statusText(nextState.settings, 'statusDownloadedConfig', { path: remotePath }),
    });
  },

  exportLocalConfig: async (targetPath) => {
    const path = await backend.exportLocalConfig(targetPath);
    set({ statusMessage: statusText(get().settings, 'statusExportedLocalConfig', { path }) });
  },

  importLocalConfig: async (file) => {
    const content = await file.text();
    const nextState = await backend.importLocalConfig(content);
    const nextActiveSessionId = nextState.sessions[0]?.id;
    const nextActiveConnectionId = nextState.sessions[0]?.connectionId;
    set({
      settings: nextState.settings,
      connections: nextState.connections.map((connection) => normalizeLoadedConnection(connection)),
      history: nextState.history,
      sessions: nextState.sessions,
      tunnels: nextState.tunnels,
      activeConnectionId: nextActiveConnectionId,
      activeSessionId: nextActiveSessionId,
      commandBuffers: {},
      suggestions: {},
      files: [],
      // 导入配置后只有已有会话才展示远端路径，避免刚导入就像已连接主机一样显示远端文件。
      currentRemotePath: nextActiveSessionId ? '~' : '',
      runtimeOverview: undefined,
      filesLoading: false,
      runtimeLoading: false,
      historyLoading: false,
      editorDocument: undefined,
      statusMessage: statusText(nextState.settings, 'statusImportedLocalConfig', { name: file.name }),
    });
  },

  checkForUpdates: async () => {
    // 更新检测走 GitHub Release 元数据，不直接下载安装，避免在未确认前产生外部副作用。
    const result = await backend.checkForUpdates();
    set((state) => ({
      updateCheckResult: result,
      statusMessage: result.updateAvailable
        ? statusText(state.settings, 'statusUpdateAvailable', { version: result.latestVersion })
        : statusText(state.settings, 'statusUpdateNotAvailable'),
    }));
    return result;
  },

  installUpdate: async (result) => {
    if (!result.installerDownloadUrl || !result.installerAssetName) {
      const message = statusText(get().settings, 'statusUpdateInstallerMissing');
      set({ statusMessage: message });
      throw new Error(message);
    }

    try {
      set((state) => ({
        loading: true,
        statusMessage: statusText(state.settings, 'statusUpdateDownloading'),
      }));
      // 后端返回下载后的安装包路径，设置页用它给用户一个可追踪的成功提示。
      const installerPath = await backend.installUpdate(result);
      set((state) => ({
        loading: false,
        statusMessage: statusText(state.settings, 'statusUpdateInstallStarted'),
      }));
      return installerPath;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      set((state) => ({
        loading: false,
        statusMessage: statusText(state.settings, 'statusUpdateInstallFailed', {
          reason,
        }),
      }));
      throw error instanceof Error ? error : new Error(reason);
    }
  },

});
