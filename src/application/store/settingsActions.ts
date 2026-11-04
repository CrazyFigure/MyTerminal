import { backend } from '../../backend';
import { activateFontPack } from '../../app/fontPack';
import { normalizeLoadedConnection } from '../../domain/connections/model';
import type { AppSettings, FontPackStatus } from '../../types';
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
  | 'setUpdateChannel'
  | 'installUpdate'
  | 'refreshFontPack'
  | 'downloadFontPack'
  | 'importFontPack'
  | 'removeFontPack';

export type SettingsActions = Pick<StoreState, SettingsActionKeys>;

// 后端完成文件校验后，前端必须再确认 WebView 能实际加载；注册失败时标记 invalid，不能继续宣称字体可用。
const activateAndStoreFontPack = async (
  set: StoreSet,
  status: FontPackStatus,
): Promise<FontPackStatus> => {
  try {
    await activateFontPack(status);
    set({ fontPackStatus: status });
    return status;
  } catch (error) {
    const invalidStatus: FontPackStatus = { ...status, state: 'invalid', faces: [] };
    await activateFontPack(invalidStatus);
    set({ fontPackStatus: invalidStatus });
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`font_pack_error:install:${reason}`);
  }
};

// 设置切片统一处理草稿持久化、配置包同步和更新安装；任何全量配置替换都同时清理会话派生缓存。
export const createSettingsActions = (set: StoreSet, get: StoreGet): SettingsActions => {
  // 自动检测、手动渠道和普通设置保存共用队列，按执行时的最新状态合并渠道，避免互相覆盖。
  let settingsSaveQueue: Promise<unknown> = Promise.resolve();
  // 手动选择递增版本，后台检测的旧结果不能覆盖用户更新的渠道选择。
  let channelSelectionRevision = 0;
  const saveSettings = (resolve: () => AppSettings, skipUnchanged = false): Promise<AppSettings> => {
    const pending = settingsSaveQueue.catch(() => undefined).then(async () => {
      const nextSettings = resolve();
      if (skipUnchanged && nextSettings === get().settings) {
        return nextSettings;
      }
      const settings = await backend.saveSettings(nextSettings);
      set({ settings });
      return settings;
    });
    settingsSaveQueue = pending;
    return pending;
  };
  return {
    updateSettings: (updater) => set((state) => ({ settings: updater(state.settings) })),

    persistSettings: async (settingsDraft) => {
      // 设置页使用草稿编辑，只有用户点击保存时才把草稿写入全局状态和本地文件。
      const settings = await saveSettings(() => settingsDraft ?? get().settings);
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
        filesLoading: false,
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
        filesLoading: false,
        historyLoading: false,
        editorDocument: undefined,
        statusMessage: statusText(nextState.settings, 'statusImportedLocalConfig', { name: file.name }),
      });
    },

    checkForUpdates: async () => {
      // 手动与定时检测都优先已保存的渠道，成功后保存实际来源，下载由用户点击触发。
      await settingsSaveQueue.catch(() => undefined);
      const selectionRevision = channelSelectionRevision;
      const result = await backend.checkForUpdates();
      await saveSettings(() => {
        const current = get().settings;
        if (selectionRevision !== channelSelectionRevision || current.updateChannel === result.channel) {
          return current;
        }
        return { ...current, updateChannel: result.channel };
      }, true);
      set((state) => ({
        updateCheckResult: result,
        statusMessage: result.updateAvailable
          ? statusText(state.settings, 'statusUpdateAvailable', { version: result.latestVersion })
          : statusText(state.settings, 'statusUpdateNotAvailable'),
      }));
      return result;
    },

    setUpdateChannel: async (channel) => {
      channelSelectionRevision += 1;
      // 是否变化在队列内判断，避免前一个尚未落盘的渠道切换被后续检测错误跳过。
      await saveSettings(() => {
        const current = get().settings;
        return current.updateChannel === channel ? current : { ...current, updateChannel: channel };
      }, true);
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
        const installerPath = await backend.installUpdate(result, get().settings.updateChannel);
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

    refreshFontPack: async () => {
      const status = await backend.getFontPackStatus();
      return activateAndStoreFontPack(set, status);
    },

    downloadFontPack: async () => {
      const status = await backend.downloadFontPack();
      return activateAndStoreFontPack(set, status);
    },

    importFontPack: async (sourcePath) => {
      const status = await backend.importFontPack(sourcePath);
      return activateAndStoreFontPack(set, status);
    },

    removeFontPack: async () => {
      const status = await backend.removeFontPack();
      return activateAndStoreFontPack(set, status);
    },
  };
};
