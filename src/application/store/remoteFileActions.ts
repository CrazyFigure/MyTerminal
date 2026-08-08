import { backend } from '../../backend';
import { parentRemotePath } from '../../domain/terminal/navigation';
import { resolveBoundConnectionId } from './sessionRuntime';
import { toBase64, uploadRemoteName } from '../../infrastructure/fileTransfer';
import type { StoreGet, StoreSet, StoreState } from './contracts';
import { statusText } from './status';

type RemoteFileActionKeys =
  | 'refreshFiles'
  | 'uploadLocalFile'
  | 'uploadLocalFiles'
  | 'uploadLocalPaths'
  | 'downloadRemoteFile'
  | 'downloadRemotePaths'
  | 'deleteRemotePath'
  | 'deleteRemotePaths'
  | 'renameRemotePath'
  | 'copyRemotePaths'
  | 'openRemoteFile'
  | 'closeEditorDocument'
  | 'setEditorContent'
  | 'saveEditorDocument';

export type RemoteFileActions = Pick<StoreState, RemoteFileActionKeys>;

type RemoteFilesRefreshRequest = { connectionId: string; path: string; seq: number };

// 文件刷新协调器保存“执行中 + 最后意图”两级队列；Shell cwd 回传也读取同一状态，避免旧预判覆盖真实路径。
let remoteFilesRefreshSeq = 0;
let remoteFilesRefreshInFlight = false;
let remoteFilesActiveRequest: RemoteFilesRefreshRequest | undefined;
let remoteFilesQueuedRequest: RemoteFilesRefreshRequest | undefined;

const normalizeRemoteFilesPath = (path: string) => {
  const normalized = path.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!normalized) {
    return '~';
  }
  return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
};

const isSameRemoteFilesTarget = (
  request: Pick<RemoteFilesRefreshRequest, 'connectionId' | 'path'> | undefined,
  connectionId: string,
  path: string,
) => Boolean(
  request
  && request.connectionId === connectionId
  && normalizeRemoteFilesPath(request.path) === normalizeRemoteFilesPath(path),
);

export const remoteFilesRequestCoordinator = {
  // 排队项代表最新用户意图；没有排队项时，执行项才是当前文件管理目标。
  latestPending: () => remoteFilesQueuedRequest ?? remoteFilesActiveRequest,
  isSameTarget: isSameRemoteFilesTarget,
};

// 远端文件 action factory 把串行刷新、传输与编辑器缓存归为同一应用服务切片。
export const createRemoteFileActions = (set: StoreSet, get: StoreGet): RemoteFileActions => ({
  refreshFiles: async (path) => {
    const { currentRemotePath } = get();
    // 文件管理跟随绑定会话，与当前聚焦的分屏无关：点别的格子不该让文件树重拉或清空。
    const boundConnectionId = resolveBoundConnectionId(get());
    if (!boundConnectionId) {
      return;
    }

    const requestedPath = normalizeRemoteFilesPath(path ?? currentRemotePath);
    if (remoteFilesRefreshInFlight) {
      if (isSameRemoteFilesTarget(remoteFilesQueuedRequest, boundConnectionId, requestedPath)) {
        // 最新排队项已经覆盖同一路径，无需再次增加序号或重复列举。
        return;
      }
      if (isSameRemoteFilesTarget(remoteFilesActiveRequest, boundConnectionId, requestedPath)) {
        if (remoteFilesQueuedRequest && remoteFilesActiveRequest) {
          // 真实 cwd 回到当前执行路径时，撤销冲突的排队项，并把执行项提升为最新请求以允许其结果落地。
          remoteFilesQueuedRequest = undefined;
          remoteFilesActiveRequest.seq = ++remoteFilesRefreshSeq;
        }
        return;
      }

      // SFTP 刷新串行执行，正在刷新时只保留最后一次目标路径，避免快速 cd/双击目录堆出多条 SSH 请求。
      remoteFilesQueuedRequest = {
        connectionId: boundConnectionId,
        path: requestedPath,
        seq: ++remoteFilesRefreshSeq,
      };
      return;
    }

    const firstRequest: RemoteFilesRefreshRequest = {
      connectionId: boundConnectionId,
      path: requestedPath,
      seq: ++remoteFilesRefreshSeq,
    };
    // 当前列表为空时才显示加载动画；已有旧文件内容时静默刷新，避免闪烁。
    if (!get().files.length) {
      set({ filesLoading: true });
    }
    remoteFilesRefreshInFlight = true;
    let request: typeof firstRequest | undefined = firstRequest;
    try {
      while (request) {
        const currentRequest = request;
        remoteFilesActiveRequest = currentRequest;
        remoteFilesQueuedRequest = undefined;
        try {
          const files = await backend.listRemoteFiles(currentRequest.connectionId, currentRequest.path);
          if (currentRequest.seq !== remoteFilesRefreshSeq || resolveBoundConnectionId(get()) !== currentRequest.connectionId) {
            request = remoteFilesQueuedRequest;
            continue;
          }

          set({ files, currentRemotePath: currentRequest.path, filesLoading: false, statusMessage: statusText(get().settings, 'statusLoadedPath', { path: currentRequest.path }) });
        } catch (error) {
          if (currentRequest.seq !== remoteFilesRefreshSeq || resolveBoundConnectionId(get()) !== currentRequest.connectionId) {
            request = remoteFilesQueuedRequest;
            continue;
          }

          set((state) => ({
            filesLoading: false,
            statusMessage: statusText(state.settings, 'statusRemoteFilesFailed', {
              reason: error instanceof Error ? error.message : String(error),
            }),
          }));
        }

        request = remoteFilesQueuedRequest;
      }
    } finally {
      remoteFilesRefreshInFlight = false;
      remoteFilesActiveRequest = undefined;
      remoteFilesQueuedRequest = undefined;
      // 兜底：无论中途 continue 还是异常，最终都清掉加载态，避免动画卡死。
      if (get().filesLoading) {
        set({ filesLoading: false });
      }
    }
  },

  uploadLocalFile: async (file) => {
    const { currentRemotePath } = get();
    const activeConnectionId = resolveBoundConnectionId(get());
    if (!activeConnectionId) {
      return;
    }

    try {
      const contentBase64 = await toBase64(file);
      await backend.uploadRemoteFile(activeConnectionId, currentRemotePath, file.name, contentBase64);
      await get().refreshFiles(currentRemotePath);
      set({ statusMessage: statusText(get().settings, 'statusUploadedFile', { name: file.name }) });
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusFileOperationFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
      throw error;
    }
  },

  uploadLocalFiles: async (files) => {
    const { currentRemotePath } = get();
    const activeConnectionId = resolveBoundConnectionId(get());
    const uploadFiles = files.filter((file) => file.name);
    if (!activeConnectionId || !uploadFiles.length) {
      return;
    }

    try {
      // 文件夹上传按文件顺序串行写入，避免大量并发 base64 编码和 SFTP create 同时挤占前端内存与远端连接。
      for (const file of uploadFiles) {
        const contentBase64 = await toBase64(file);
        await backend.uploadRemoteFile(activeConnectionId, currentRemotePath, uploadRemoteName(file), contentBase64);
      }
      await get().refreshFiles(currentRemotePath);
      set({
        statusMessage: uploadFiles.length === 1
          ? statusText(get().settings, 'statusUploadedFile', { name: uploadFiles[0].name })
          : statusText(get().settings, 'statusUploadedFiles', { count: uploadFiles.length }),
      });
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusFileOperationFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
      throw error;
    }
  },

  uploadLocalPaths: async (localPaths) => {
    const { currentRemotePath } = get();
    const activeConnectionId = resolveBoundConnectionId(get());
    const uploadPaths = Array.from(new Set(localPaths.map((path) => path.trim()).filter(Boolean)));
    if (!activeConnectionId || !uploadPaths.length) {
      return;
    }

    try {
      // 桌面拖放上传直接把本机路径交给后端递归读取，避免大文件和目录树经过前端 base64 中转。
      await backend.uploadLocalPaths(activeConnectionId, currentRemotePath, uploadPaths);
      await get().refreshFiles(currentRemotePath);
      set({
        statusMessage: uploadPaths.length === 1
          ? statusText(get().settings, 'statusUploadedFile', { name: uploadPaths[0].split(/[\\/]/).pop() ?? uploadPaths[0] })
          : statusText(get().settings, 'statusUploadedPaths', { count: uploadPaths.length }),
      });
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusFileOperationFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
      throw error;
    }
  },

  downloadRemoteFile: async (path) => {
    const activeConnectionId = resolveBoundConnectionId(get());
    if (!activeConnectionId) {
      return;
    }

    try {
      const localPath = await backend.downloadRemoteFile(activeConnectionId, path);
      set({ statusMessage: statusText(get().settings, 'statusDownloadedFile', { path: localPath }) });
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusFileOperationFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
      throw error;
    }
  },

  downloadRemotePaths: async (paths, localDir) => {
    const activeConnectionId = resolveBoundConnectionId(get());
    const normalizedPaths = Array.from(new Set(paths.filter(Boolean)));
    if (!activeConnectionId || !normalizedPaths.length) {
      return;
    }

    try {
      const summary = await backend.downloadRemotePaths(activeConnectionId, normalizedPaths, localDir);
      set({
        statusMessage: normalizedPaths.length === 1
          ? statusText(get().settings, 'statusDownloadedFile', { path: summary.destinations[0] ?? normalizedPaths[0] })
          : statusText(get().settings, 'statusDownloadedPaths', {
              count: normalizedPaths.length,
              path: summary.destinations[0] ?? localDir ?? '',
            }),
      });
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusFileOperationFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
      throw error;
    }
  },

  deleteRemotePath: async (path) => {
    const { currentRemotePath } = get();
    const activeConnectionId = resolveBoundConnectionId(get());
    if (!activeConnectionId) {
      return;
    }

    try {
      await backend.deleteRemotePath(activeConnectionId, path);
      await get().refreshFiles(currentRemotePath);
      set({ statusMessage: statusText(get().settings, 'statusDeletedPath', { path }) });
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusFileOperationFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
      throw error;
    }
  },

  deleteRemotePaths: async (paths) => {
    const { currentRemotePath } = get();
    const activeConnectionId = resolveBoundConnectionId(get());
    const normalizedPaths = Array.from(new Set(paths.filter(Boolean)));
    if (!activeConnectionId || !normalizedPaths.length) {
      return;
    }

    try {
      // 多选删除使用后端批量 SFTP 命令，删除完再刷新一次目录，避免连续刷新拖慢 UI。
      await backend.deleteRemotePaths(activeConnectionId, normalizedPaths);
      await get().refreshFiles(currentRemotePath);
      set({
        statusMessage: normalizedPaths.length === 1
          ? statusText(get().settings, 'statusDeletedPath', { path: normalizedPaths[0] })
          : statusText(get().settings, 'statusDeletedPaths', { count: normalizedPaths.length }),
      });
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusFileOperationFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
      throw error;
    }
  },

  renameRemotePath: async (path, newName) => {
    const { currentRemotePath } = get();
    const activeConnectionId = resolveBoundConnectionId(get());
    if (!activeConnectionId || !newName.trim()) {
      return;
    }

    try {
      const nextPath = `${parentRemotePath(path).replace(/\/$/, '')}/${newName.trim()}`.replace('//', '/');
      await backend.renameRemotePath(activeConnectionId, path, nextPath);
      await get().refreshFiles(currentRemotePath);
      set({ statusMessage: statusText(get().settings, 'statusRenamedPath', { name: newName.trim() }) });
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusFileOperationFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
      throw error;
    }
  },

  copyRemotePaths: async (sources, targetDir) => {
    const { currentRemotePath } = get();
    const activeConnectionId = resolveBoundConnectionId(get());
    const normalizedSources = Array.from(new Set(sources.filter(Boolean)));
    const destination = targetDir || currentRemotePath;
    if (!activeConnectionId || !normalizedSources.length) {
      return;
    }

    try {
      // 复制走后端一次辅助会话，粘贴完统一刷新目标目录，避免逐项刷新拖慢界面。
      await backend.copyRemotePaths(activeConnectionId, normalizedSources, destination);
      await get().refreshFiles(currentRemotePath);
      set({ statusMessage: statusText(get().settings, 'statusCopiedPaths', { count: normalizedSources.length }) });
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusFileOperationFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
      throw error;
    }
  },


  openRemoteFile: async (path) => {
    const activeConnectionId = resolveBoundConnectionId(get());
    if (!activeConnectionId) {
      return;
    }

    try {
      const editorDocument = await backend.loadEditorDocument(activeConnectionId, path);
      set({ editorDocument, statusMessage: statusText(get().settings, 'statusOpenedFile', { path }) });
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusFileOperationFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
      throw error;
    }
  },

  closeEditorDocument: () =>
    set({
      editorDocument: undefined,
    }),

  setEditorContent: (content) =>
    set((state) => ({
      editorDocument: state.editorDocument
        ? {
            ...state.editorDocument,
            content,
            dirty: true,
          }
        : undefined,
    })),

  saveEditorDocument: async () => {
    const { editorDocument } = get();
    if (!editorDocument) {
      return;
    }

    try {
      await backend.saveEditorDocument(editorDocument.connectionId, editorDocument.path, editorDocument.content);
      set({
        editorDocument: { ...editorDocument, dirty: false },
        statusMessage: statusText(get().settings, 'statusSavedFile', { path: editorDocument.path }),
      });
      await get().refreshFiles(parentRemotePath(editorDocument.path) || '~');
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusFileOperationFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
    }
  },

});
