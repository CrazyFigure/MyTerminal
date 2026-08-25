import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import {
  Activity,
  Cable,
  ChevronLeft,
  ChevronRight,
  HardDrive,
  MemoryStick,
  RefreshCw,
} from 'lucide-react';

import { translate, type TranslationKey } from './i18n';
import { backend } from './backend';
import { writeClipboardText } from './clipboard';
import { useAppStore } from './store';
// useShallow 让组件按“选中字段的浅比较”订阅 store，避免订阅整个 store 导致终端 cwd/status
// 等高频更新触发无关组件（尤其是未打开的弹窗）重渲染。
import { useShallow } from 'zustand/react/shallow';
import { UpdateModal, type UpdateDownloadProgress } from './UpdateModal';
import type { AgentBridgeRequest, AgentProvider, RemoteFileEntry, RuntimeResourceSource, TerminalSession, TunnelRecord } from './types';
import { useDraggableModals } from './useDraggableModals';
import { ConnectionFormModal } from './components/ConnectionFormModal';
import { ConnectionManagerModal } from './components/ConnectionManagerModal';
import { EditorModal } from './components/EditorModal';
import { LocalTerminalManagerModal } from './components/LocalTerminalManagerModal';
import { SettingsModal } from './components/SettingsModal';
import type { SettingsTab } from './features/settings';
import { TunnelFormModal } from './components/TunnelFormModal';
import { beginResize, clamp } from './app/layout';
import { isTauriRuntime } from './app/runtime';
import { translateUpdateCheckError } from './app/updates';
import { isUsableRemoteSession } from './domain/sessions/model';
import {
  AgentRequestPanel,
  AgentSidebar,
  agentBridgeNotificationApproveActionId,
  agentBridgeNotificationRejectActionId,
  agentBridgeNotificationTagPrefix,
  getAgentRequestMachineLabel,
  getAgentRequestSummary,
} from './features/agent';
import {
  FileContextMenu,
  FileExplorerPanel,
  explorerColumnLimits,
  explorerDefaultColumnWidths,
  explorerOverscanRows,
  explorerRowHeight,
  isEditableFile,
  type FileContextMenuTarget,
  type RemoteFileClipboard,
} from './features/files';
import { parseMetricPercent, RuntimePanel, useRuntimeMonitor } from './features/runtime';
import { SessionContextMenu, type SessionContextMenuTarget } from './features/sessions';
import {
  AppTitlebar,
  BottomDock,
  estimateInlineButtonWidth,
  type BottomPanelTab,
  mainWorkspaceMinWidth,
  resolveRuntimePanelMaxHeight,
  resolveSidePanelMaxWidth,
  sidePanelMinWidth,
  sidebarRuntimeMinHeight,
  TransferProgressStack,
  useTransferProgress,
} from './features/workspace';
import { setTerminalProtocolReplySender } from './terminal/terminalOutputHub';
// 终端内核不是绘制应用骨架的前置条件；懒加载边界下沉到分屏容器内部，
// 让标题栏、侧栏和操作区先进入可用状态。
import { TerminalSplitGrid, type SplitDropTarget } from './features/terminal';

export default function App() {
  // 所有业务弹窗复用标题栏拖动能力；偏移仅存在于本次打开的 DOM 节点，关闭后自动复位。
  useDraggableModals();
  // 标签拖到终端区时的落点：由标签栏在拖动过程中上报，分屏容器和四方格指示器共用同一份判定结果。
  const [splitDropTarget, setSplitDropTarget] = useState<SplitDropTarget | null>(null);
  // 指针是否正悬在终端区上方（决定指示器是否显示）；与具体落点分开，避免无有效落点时骨架闪烁。
  const [splitDragActive, setSplitDragActive] = useState(false);
  // 标签栏判定落点与指示器渲染共用同一个网格矩形，必须指向同一个 DOM 节点。
  const splitGridRef = useRef<HTMLDivElement | null>(null);
  // 右侧 AI 栏分为对话与审批两个页签；默认停在对话，审批有新请求时会自动切过去。
  const [agentSidebarTab, setAgentSidebarTab] = useState<'chat' | 'requests'>('chat');
  // AI 端点列表（含明文密钥）缓存在前端，供侧边栏对话与设置页共用。
  const [agentProviders, setAgentProviders] = useState<AgentProvider[]>([]);
  // 左侧栏初始宽度默认取最小宽度稍多一点，避免打开时占用过多空间
  const [sidebarWidth, setSidebarWidth] = useState(sidePanelMinWidth + 20);
  const [runtimePanelHeight, setRuntimePanelHeight] = useState(() => {
    if (typeof window === 'undefined') {
      return 220;
    }
    // 左侧默认给运行状态约 1/3 高度，文件管理保持约 2/3，CPU 展开时不至于被文件区挤掉。
    return clamp(Math.round(window.innerHeight * 0.3), 190, Math.min(resolveRuntimePanelMaxHeight(), 300));
  });
  const [bottomHeight, setBottomHeight] = useState(180);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('appearance');
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [localTerminalsOpen, setLocalTerminalsOpen] = useState(false);
  const [globalBottomTab, setGlobalBottomTab] = useState<BottomPanelTab>('commands');
  const [bottomTabByConnection, setBottomTabByConnection] = useState<Record<string, BottomPanelTab>>({});
  // AI 执行右侧栏宽度独立于左侧栏，避免 MCP 审批展开时影响用户已经调整好的主机列表宽度。
  // 对话栏默认取约 1/3 窗口宽：AI 回复常含多行说明与命令块，需要足够宽；
  // 上限仍套用拖拽钳制逻辑，小窗口或双侧栏展开时不会挤掉主工作区。
  const [agentSidebarWidth, setAgentSidebarWidth] = useState(() => {
    if (typeof window === 'undefined') {
      return 460;
    }
    const preferred = Math.round(window.innerWidth / 3);
    const ceiling = resolveSidePanelMaxWidth(!sidebarCollapsed, sidePanelMinWidth + 20, true);
    return clamp(preferred, 380, ceiling);
  });
  // AI 执行默认收起，只有用户点击或 MCP 新请求到达时才占用主窗口右侧空间。
  const [agentSidebarCollapsed, setAgentSidebarCollapsed] = useState(true);
  // 首次展开前不加载 AI 对话模块；展开过后保持挂载，收起侧栏也不能中断正在进行的流式响应。
  const [agentSidebarMounted, setAgentSidebarMounted] = useState(false);
  const [pathInput, setPathInput] = useState('~');
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenuTarget | null>(null);
  // 文件右键“复制”暂存待粘贴的远端路径；记录来源连接以便仅在同主机内启用粘贴。
  const [fileClipboard, setFileClipboard] = useState<RemoteFileClipboard | null>(null);
  const [sessionContextMenu, setSessionContextMenu] = useState<SessionContextMenuTarget | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState('');
  const [selectedFilePaths, setSelectedFilePaths] = useState<string[]>([]);
  const [localFileDropActive, setLocalFileDropActive] = useState(false);
  const [remoteDownloadDragPaths, setRemoteDownloadDragPaths] = useState<string[]>([]);
  // 运行状态区的展开态独立保存；存储明细只在 storageFilesExpanded 为 true 时触发远端扫描。
  const [cpuCoresExpanded, setCpuCoresExpanded] = useState(false);
  const [memoryResourcesExpanded, setMemoryResourcesExpanded] = useState(false);
  const [storageFilesExpanded, setStorageFilesExpanded] = useState(false);
  // 连接数展开态与明细数据独立保存；明细只在 connectionsExpanded 为 true 时触发远端采集。
  const [connectionsExpanded, setConnectionsExpanded] = useState(false);
  // 底部功能栏默认收起：日常操作集中在终端，命令/隧道/历史面板按需展开，把纵向空间让给终端。
  const [bottomDockCollapsed, setBottomDockCollapsed] = useState(true);
  const [agentBridgeRequests, setAgentBridgeRequests] = useState<AgentBridgeRequest[]>([]);
  const [agentCommandEdits, setAgentCommandEdits] = useState<Record<string, string>>({});
  const [agentExpandedRequestIds, setAgentExpandedRequestIds] = useState<Record<string, boolean>>({});
  const [explorerColumnWidths, setExplorerColumnWidths] = useState(explorerDefaultColumnWidths);
  const pathByConnectionRef = useRef<Record<string, string>>({});
  const explorerListRef = useRef<HTMLDivElement | null>(null);
  const bottomPanelActionsRef = useRef<HTMLDivElement | null>(null);
  const explorerScrollRafRef = useRef<number | null>(null);
  const explorerPanelRef = useRef<HTMLElement | null>(null);
  const agentKnownRequestIdsRef = useRef<Set<string>>(new Set());
  // 右侧 AI 执行栏新请求追加在底部，记录滚动容器用于新请求到达后自动露出最新卡片。
  const agentSidebarBodyRef = useRef<HTMLDivElement | null>(null);
  // 上一轮审批状态用于识别 pending -> running/completed/rejected/error，保证执行后自动折叠一次。
  const agentRequestStatusRef = useRef<Record<string, string>>({});
  const [explorerViewport, setExplorerViewport] = useState({ height: 0, scrollTop: 0 });
  // 首页工具栏“更新”按钮触发的弹窗状态，与设置页内的更新弹窗独立，避免互相抢占打开状态。
  const [appUpdateModalOpen, setAppUpdateModalOpen] = useState(false);
  const [appUpdateInstalling, setAppUpdateInstalling] = useState(false);
  const [appUpdateProgress, setAppUpdateProgress] = useState<UpdateDownloadProgress | null>(null);
  const [appUpdateError, setAppUpdateError] = useState<string | null>(null);
  // 标题栏”更新”按钮主动检测时的进行态，用于图标旋转反馈并避免重复点击。
  const [appUpdateChecking, setAppUpdateChecking] = useState(false);
  // 标题栏手动检测失败时的错误文案，传给弹窗展示。
  const [appUpdateCheckError, setAppUpdateCheckError] = useState<string | null>(null);

  const {
    activeConnectionId,
    activeSessionId,
    bootstrapped,
    bootstrap,
    checkForUpdates,
    closeSession,
    closeTunnel,
    applyTunnelStatusChange,
    commandBuffers,
    connections,
    currentRemotePath,
    deleteRemotePaths,
    copyRemotePaths,
    downloadRemotePaths,
    duplicateSession: duplicateSessionById,
    editTunnel,
    files,
    filesLoading,
    adoptSession,
    history,
    historyLoading,
    installUpdate,
    openConnectionForm,
    openRemoteFile,
    openTunnel,
    persistSettings,
    pollTerminalOutputs,
    refreshFiles,
    refreshRemoteHistory,
    refreshRuntimeOverview,
    reconnectSession: reconnectSessionById,
    renameRemotePath,
    reorderSessions,
    reorderPaneSessions,
    runtimeOverview,
    runtimeLoading,
    selectSession,
    sendCommand,
    sendTerminalData,
    sessions,
    setCommandBuffer,
    setStatusMessage,
    settings,
    splitLayout,
    applySplitDrop,
    closeSplitPane,
    startAllTunnels,
    startTunnel,
    stopAllTunnels,
    tunnels,
    updateCheckResult,
    uploadLocalFiles,
    uploadLocalPaths,
  } = useAppStore(
    useShallow((state) => ({
      activeConnectionId: state.activeConnectionId,
      activeSessionId: state.activeSessionId,
      bootstrapped: state.bootstrapped,
      bootstrap: state.bootstrap,
      checkForUpdates: state.checkForUpdates,
      closeSession: state.closeSession,
      closeTunnel: state.closeTunnel,
      applyTunnelStatusChange: state.applyTunnelStatusChange,
      commandBuffers: state.commandBuffers,
      connections: state.connections,
      currentRemotePath: state.currentRemotePath,
      deleteRemotePaths: state.deleteRemotePaths,
      copyRemotePaths: state.copyRemotePaths,
      downloadRemotePaths: state.downloadRemotePaths,
      duplicateSession: state.duplicateSession,
      editTunnel: state.editTunnel,
      files: state.files,
      filesLoading: state.filesLoading,
      history: state.history,
      historyLoading: state.historyLoading,
      adoptSession: state.adoptSession,
      installUpdate: state.installUpdate,
      openConnectionForm: state.openConnectionForm,
      openRemoteFile: state.openRemoteFile,
      openTunnel: state.openTunnel,
      persistSettings: state.persistSettings,
      pollTerminalOutputs: state.pollTerminalOutputs,
      refreshFiles: state.refreshFiles,
      refreshRemoteHistory: state.refreshRemoteHistory,
      refreshRuntimeOverview: state.refreshRuntimeOverview,
      reconnectSession: state.reconnectSession,
      renameRemotePath: state.renameRemotePath,
      reorderSessions: state.reorderSessions,
      reorderPaneSessions: state.reorderPaneSessions,
      runtimeOverview: state.runtimeOverview,
      runtimeLoading: state.runtimeLoading,
      selectSession: state.selectSession,
      sendCommand: state.sendCommand,
      sendTerminalData: state.sendTerminalData,
      sessions: state.sessions,
      setCommandBuffer: state.setCommandBuffer,
      setStatusMessage: state.setStatusMessage,
      settings: state.settings,
      splitLayout: state.splitLayout,
      applySplitDrop: state.applySplitDrop,
      closeSplitPane: state.closeSplitPane,
      startAllTunnels: state.startAllTunnels,
      startTunnel: state.startTunnel,
      stopAllTunnels: state.stopAllTunnels,
      tunnels: state.tunnels,
      updateCheckResult: state.updateCheckResult,
      uploadLocalFiles: state.uploadLocalFiles,
      uploadLocalPaths: state.uploadLocalPaths,
    })),
  );

  const t = useCallback((key: TranslationKey, replacements?: Record<string, string | number>) =>
    translate(settings.uiLanguage, key, replacements), [settings.uiLanguage]);
  const {
    dismiss: dismissTransferProgress,
    items: transferProgressItems,
    run: runTransferProgress,
  } = useTransferProgress(t('saved'));
  const runtimeResourceSourceLabel = useCallback((source: RuntimeResourceSource) => {
    const labelKeyBySource: Record<RuntimeResourceSource, TranslationKey> = {
      system: 'runtimeResourceSourceSystem',
      docker: 'runtimeResourceSourceDocker',
      podman: 'runtimeResourceSourcePodman',
      kubernetes: 'runtimeResourceSourceKubernetes',
    };
    return t(labelKeyBySource[source] ?? 'runtimeResourceSourceSystem');
  }, [t]);

  // 首页工具栏“更新”按钮和设置页共用后端安装接口，但下载进度与弹窗状态各自独立。
  const openAppExternalLink = useCallback((url: string) => {
    if (!isTauriRuntime()) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    void backend.openExternalUrl(url).catch(() => {
      window.open(url, '_blank', 'noopener,noreferrer');
    });
  }, []);
  const handleAppInstallUpdate = useCallback(async () => {
    if (!updateCheckResult) {
      return;
    }
    setAppUpdateInstalling(true);
    setAppUpdateError(null);
    setAppUpdateProgress(null);
    try {
      await installUpdate(updateCheckResult);
      // 安装程序已由后端启动，关闭首页弹窗即可，避免遮挡安装器窗口。
      setAppUpdateModalOpen(false);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason === t('downloadCancelled')) {
        setAppUpdateInstalling(false);
        return;
      }
      setAppUpdateError(t('statusUpdateInstallFailed', { reason }));
    } finally {
      setAppUpdateInstalling(false);
      setAppUpdateProgress(null);
    }
  }, [installUpdate, t, updateCheckResult]);

  // 标题栏更新按钮：用户主动点击时立即检测一次；无论结果如何都弹窗展示，否则由 store 写入”已是最新”状态提示。
  const handleTitlebarCheckUpdate = useCallback(async () => {
    if (appUpdateChecking) {
      return;
    }
    setAppUpdateChecking(true);
    setAppUpdateCheckError(null);
    try {
      await checkForUpdates();
      // 无论是否有新版本，都弹窗展示结果。
      setAppUpdateModalOpen(true);
    } catch (error) {
      // 网络异常或 GitHub 不可达时弹窗展示错误；与设置页一致，后端错误码按当前界面语言翻译。
      const reason = error instanceof Error ? error.message : String(error);
      setAppUpdateCheckError(translateUpdateCheckError(reason, settings.uiLanguage));
      setAppUpdateModalOpen(true);
    } finally {
      setAppUpdateChecking(false);
    }
  }, [appUpdateChecking, checkForUpdates, t, settings.uiLanguage]);

  // 标题栏主题按钮：在深浅色之间切换并立即持久化，无需打开设置页。
  const handleToggleTheme = useCallback(() => {
    const nextMode = settings.themeMode === 'dark' ? 'light' : 'dark';
    void persistSettings({ ...settings, themeMode: nextMode }).catch(() => undefined);
  }, [persistSettings, settings]);

  // 标签栏在拖拽过程中持续上报预览；回调必须稳定，否则会让标签栏的上报 effect 反复重跑。
  const handleSplitDragPreview = useCallback((preview: { active: boolean; target: SplitDropTarget | null }) => {
    setSplitDragActive(preview.active);
    setSplitDropTarget(preview.target);
  }, []);

  // 提示语跟随落点语义变化：新开分屏 / 移入某格 / 改变跨度，让用户松手前就知道结果。
  const splitDropHint = splitDropTarget?.kind === 'split'
    ? t('splitDropHintSplit')
    : splitDropTarget?.kind === 'move'
      ? t('splitDropHintMove')
      : splitDropTarget?.kind === 'reshape'
        ? t('splitDropHintReshape')
        : '';

  // 侧栏与下栏跟随当前聚焦的标签：点到哪一格，文件树、运行状态和命令都指向那台机器。
  const focusedSession = useMemo(
    () => sessions.find((item) => item.id === activeSessionId),
    [activeSessionId, sessions],
  );
  // 终端能力协商（XTVERSION）由 terminalOutputHub 全局判定并按原会话 ID 回包：分屏后终端区会挂载多个
  // 实例，若由实例各自回包，同一条查询会被重复响应写进同一条 PTY。这里只注入写入通道。
  useEffect(() => {
    setTerminalProtocolReplySender((sessionId, data) => {
      void sendTerminalData(sessionId, data);
    });
    return () => setTerminalProtocolReplySender(undefined);
  }, [sendTerminalData]);
  // 远端文件、运行状态和历史都必须绑定到已经打开的终端会话，避免仅选中连接时提前拉取远端数据。
  const hasActiveRemoteSession = isUsableRemoteSession(focusedSession);
  const activeRemoteConnectionId = hasActiveRemoteSession ? focusedSession?.connectionId : undefined;
  const activeRemoteConnection = useMemo(
    () => connections.find((item) => item.id === activeRemoteConnectionId),
    [activeRemoteConnectionId, connections],
  );
  const {
    refreshRuntimeOverviewOnce,
    runtimeConnections,
    runtimeConnectionsError,
    runtimeConnectionsLoading,
    runtimeResourceError,
    runtimeResourceLoading,
    runtimeResourceMetric,
    runtimeResourceTarget,
    runtimeResourceUsage,
    runtimeStorageFiles,
    runtimeStorageFilesError,
    runtimeStorageFilesLoading,
    setRuntimeResourceMetric,
    setRuntimeResourceTarget,
  } = useRuntimeMonitor({
    activeRemoteConnectionId,
    connectionsExpanded,
    memoryResourcesExpanded,
    refreshRuntimeOverview,
    setConnectionsExpanded,
    setCpuCoresExpanded,
    setMemoryResourcesExpanded,
    setStorageFilesExpanded,
    settings,
    storageFilesExpanded,
  });

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const clampExpandedSidebars = () => {
      // 窗口变化或双侧栏同时展开时，只压缩超出预算的侧栏宽度，保留用户已经调小的宽度选择。
      setSidebarWidth((current) => {
        if (sidebarCollapsed) {
          return current;
        }
        return clamp(current, sidePanelMinWidth, resolveSidePanelMaxWidth(!agentSidebarCollapsed, agentSidebarWidth));
      });
      setAgentSidebarWidth((current) => {
        if (agentSidebarCollapsed) {
          return current;
        }
        return clamp(
          current,
          sidePanelMinWidth,
          resolveSidePanelMaxWidth(!sidebarCollapsed, sidebarWidth, true),
        );
      });
      // 窗口缩小时重新钳制运行状态高度，确保文件管理区仍保留最小可操作高度。
      setRuntimePanelHeight((current) => clamp(current, sidebarRuntimeMinHeight, resolveRuntimePanelMaxHeight()));
    };

    clampExpandedSidebars();
    window.addEventListener('resize', clampExpandedSidebars);
    return () => window.removeEventListener('resize', clampExpandedSidebars);
  }, [agentSidebarCollapsed, agentSidebarWidth, sidebarCollapsed, sidebarWidth]);

  const openAgentRequestPanel = useCallback(async (focusWindow = false) => {
    // MCP 审批入口已经迁到右侧栏，新请求只展开右栏，不再改动底部命令/隧道/历史的当前 tab。
    setAgentSidebarCollapsed(false);
    // 有待审批请求时必须切到审批页签，否则用户停在对话页会完全看不到卡片。
    setAgentSidebarTab('requests');

    if (!isTauriRuntime()) {
      return;
    }

    try {
      const { getCurrentWindow, UserAttentionType } = await import('@tauri-apps/api/window');
      const currentWindow = getCurrentWindow();
      await currentWindow.show();
      await currentWindow.unminimize();
      if (focusWindow) {
        await currentWindow.setFocus();
      } else {
        // 未点击通知时只闪烁任务栏，避免外部 agent 请求突然打断用户当前窗口焦点。
        await currentWindow.requestUserAttention(UserAttentionType.Informational).catch(() => undefined);
      }
    } catch {
      // Web 预览或系统拒绝聚焦时不影响审批列表本身展示。
    }
  }, []);

  const showAgentRequestNotification = useCallback(async (request: AgentBridgeRequest) => {
    if (typeof window === 'undefined') {
      return;
    }

    const machine = getAgentRequestMachineLabel(request, connections);
    const summary = getAgentRequestSummary(request);
    const body = t('agentRequestNotificationBody', { machine, summary });

    try {
      if (isTauriRuntime()) {
        const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification');
        let permissionGranted = await isPermissionGranted();
        if (!permissionGranted) {
          permissionGranted = (await requestPermission()) === 'granted';
        }
        if (!permissionGranted) {
          return;
        }

        try {
          await backend.showAgentBridgeNotification({
            requestId: request.id,
            title: t('agentRequestNotificationTitle'),
            body,
            approveLabel: t('approveAgentRequest'),
            rejectLabel: t('rejectAgentRequest'),
          });
          return;
        } catch {
          // 带动作 toast 不可用时退回普通系统通知；右侧栏已经自动展开，审批入口不会丢失。
        }

        if ('Notification' in window) {
          new window.Notification(t('agentRequestNotificationTitle'), {
            body,
          });
        }
        return;
      }

      if (!('Notification' in window)) {
        return;
      }
      let permissionGranted = window.Notification.permission === 'granted';
      if (!permissionGranted && window.Notification.permission !== 'denied') {
        permissionGranted = (await window.Notification.requestPermission()) === 'granted';
      }
      if (!permissionGranted) {
        return;
      }

      const notification = new window.Notification(t('agentRequestNotificationTitle'), {
        body,
        data: { source: 'agent-bridge', requestId: request.id },
        tag: `${agentBridgeNotificationTagPrefix}-${request.id}`,
      });
      notification.onclick = () => {
        notification.close();
        void openAgentRequestPanel(true);
      };
    } catch {
      // 通知权限、系统策略或 WebView 实现差异都不能阻塞 GUI 审批入口自动展开。
    }
  }, [connections, openAgentRequestPanel, t]);

  const refreshAgentBridgeRequests = useCallback(async () => {
    try {
      const requests = await backend.listAgentBridgeRequests();
      const previousRequestStatuses = agentRequestStatusRef.current;
      const pendingNewRequests = requests.filter((request) =>
        request.status === 'pending' && !agentKnownRequestIdsRef.current.has(request.id),
      );
      agentKnownRequestIdsRef.current = new Set(requests.map((request) => request.id));
      setAgentBridgeRequests(requests);
      setAgentCommandEdits((current) => {
        const activeIds = new Set(requests.map((request) => request.id));
        const next: Record<string, string> = {};
        Object.entries(current).forEach(([requestId, value]) => {
          if (activeIds.has(requestId)) {
            next[requestId] = value;
          }
        });
        requests.forEach((request) => {
          if (request.kind === 'run_command' && request.command && next[request.id] === undefined) {
            next[request.id] = request.command;
          }
        });
        return next;
      });
      setAgentExpandedRequestIds((current) => {
        const activeIds = new Set(requests.map((request) => request.id));
        const next: Record<string, boolean> = {};
        Object.entries(current).forEach(([requestId, value]) => {
          if (activeIds.has(requestId)) {
            next[requestId] = value;
          }
        });
        requests.forEach((request) => {
          if (previousRequestStatuses[request.id] === 'pending' && request.status !== 'pending') {
            next[request.id] = false;
          }
        });
        return next;
      });
      agentRequestStatusRef.current = Object.fromEntries(requests.map((request) => [request.id, request.status]));
      // 内置 AI 对话的审批直接挂在原工具调用下方；侧栏被收起时重新展开到对话页，确保审批入口可见。
      const pendingChatRequests = pendingNewRequests.filter((request) => Boolean(request.conversationId));
      if (pendingChatRequests.length) {
        setAgentSidebarCollapsed(false);
        setAgentSidebarTab('chat');
      }
      // 只有外部 MCP 请求才进入独立审批页。
      const pendingExternalRequests = pendingNewRequests.filter((request) => !request.conversationId);
      if (pendingExternalRequests.length) {
        void openAgentRequestPanel(false);
        void showAgentRequestNotification(pendingExternalRequests[0]);
      }
    } catch {
      setAgentBridgeRequests([]);
      agentRequestStatusRef.current = {};
    }
  }, [openAgentRequestPanel, showAgentRequestNotification]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return undefined;
    }

    let unlistenFn: (() => void) | undefined;
    let isMounted = true;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<{ requestId?: string; actionId?: string }>('agent-bridge-notification-action', (event) => {
        const actionId = event.payload.actionId;
        const requestId = event.payload.requestId;
        if (!requestId) {
          void openAgentRequestPanel(true);
          return;
        }

        if (actionId === agentBridgeNotificationApproveActionId) {
          void backend.approveAgentBridgeRequest(requestId).then(() => {
            void refreshAgentBridgeRequests();
          }).catch((error) => {
            setStatusMessage(error instanceof Error ? error.message : String(error));
          });
          return;
        }

        if (actionId === agentBridgeNotificationRejectActionId) {
          void backend.rejectAgentBridgeRequest(requestId, 'rejected from notification').then(() => {
            void refreshAgentBridgeRequests();
          }).catch((error) => {
            setStatusMessage(error instanceof Error ? error.message : String(error));
          });
          return;
        }

        void openAgentRequestPanel(true);
      }),
    ).then((unlisten) => {
      if (isMounted) {
        unlistenFn = unlisten;
      } else {
        unlisten();
      }
    }).catch(() => {
      // 自定义通知动作事件不可用时，右侧栏自动展开和普通按钮审批仍可使用。
    });

    return () => {
      isMounted = false;
      unlistenFn?.();
    };
  }, [openAgentRequestPanel, refreshAgentBridgeRequests, setStatusMessage]);

  useEffect(() => {
    if (!bootstrapped) {
      void bootstrap();
    }
  }, [bootstrap, bootstrapped]);

  useEffect(() => {
    if (!agentSidebarCollapsed) {
      setAgentSidebarMounted(true);
    }
  }, [agentSidebarCollapsed]);

  // 启动后立即检测一次更新，之后每 10 分钟复检一次；网络失败时静默忽略，不打扰用户。
  useEffect(() => {
    if (!isTauriRuntime()) {
      return undefined;
    }
    const runSilentCheck = () => {
      void checkForUpdates().catch(() => {
        // 网络异常或 GitHub 不可达时不报错，仅在后台静默失败。
      });
    };
    runSilentCheck();
    const timer = window.setInterval(runSilentCheck, 10 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [checkForUpdates]);

  // 下载进度事件由后端统一发出，首页和设置页弹窗共用同一个事件名，分别更新各自进度状态。
  useEffect(() => {
    if (!isTauriRuntime()) {
      return undefined;
    }
    let unlistenFn: (() => void) | undefined;
    let isMounted = true;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen('myterminal-update-download-progress', (event) => {
        const payload = event.payload as UpdateDownloadProgress;
        setAppUpdateProgress(payload);
      }),
    ).then((unlisten) => {
      if (isMounted) {
        unlistenFn = unlisten;
      } else {
        unlisten();
      }
    }).catch(() => undefined);
    return () => {
      isMounted = false;
      unlistenFn?.();
    };
  }, []);

  // 主题切换时同步 Tauri 窗口主题和 document 颜色方案，确保标题栏、表单控件立即跟随。
  useEffect(() => {
    const isDark = settings.themeMode === 'dark';
    document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
    document.body.classList.toggle('theme-dark', isDark);
    if (isTauriRuntime()) {
      void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
        const currentWindow = getCurrentWindow();
        void currentWindow.setTheme(isDark ? 'dark' : 'light');
      }).catch(() => undefined);
    }
  }, [settings.themeMode]);

  useEffect(() => {
    const disableContextMenu = (event: MouseEvent) => event.preventDefault();
    window.addEventListener('contextmenu', disableContextMenu);
    return () => window.removeEventListener('contextmenu', disableContextMenu);
  }, []);

  useEffect(() => {
    // 原生层会统一关闭 WebView 浏览器加速键；这里专门兜底旧版 WebView2 的刷新键，避免任意面板或弹窗触发整页重载。
    const suppressWebviewReloadFallback = (event: KeyboardEvent) => {
      const isReloadShortcut = event.key === 'F5'
        || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r');
      if (!isReloadShortcut) {
        return;
      }

      // Monaco 需要把 Ctrl+R 映射为替换，xterm 也需要接收终端功能键；两者会自行消费按键并阻止浏览器默认行为。
      const target = event.target;
      if (target instanceof Element && target.closest('.monaco-editor, .xterm')) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
    };

    window.addEventListener('keydown', suppressWebviewReloadFallback, true);
    return () => window.removeEventListener('keydown', suppressWebviewReloadFallback, true);
  }, []);

  useEffect(() => {
    const closeContextMenu = () => {
      setFileContextMenu(null);
      setSessionContextMenu(null);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setFileContextMenu(null);
        setSessionContextMenu(null);
      }
    };

    window.addEventListener('click', closeContextMenu);
    window.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('click', closeContextMenu);
      window.removeEventListener('keydown', onEscape);
    };
  }, []);

  useEffect(() => {
    if (!sessions.length) {
      return;
    }

    // 后端 shell 线程在读到数据后通过 Tauri 事件推送通知；事件携带 sessionId，前端只拉取对应会话输出。
    let outputPollInFlight = false;
    // dirty 标记：poll 进行中收到的事件不会丢失；多个会话同时变脏时降级为全量拉取。
    let outputDirty = false;
    let dirtyAllSessions = false;
    let dirtySessionId: string | undefined;
    const markDirtySession = (sessionId?: string) => {
      if (!sessionId || dirtyAllSessions) {
        dirtyAllSessions = true;
        dirtySessionId = undefined;
        return;
      }
      if (dirtySessionId && dirtySessionId !== sessionId) {
        dirtyAllSessions = true;
        dirtySessionId = undefined;
        return;
      }
      dirtySessionId = sessionId;
    };
    const pollOutputs = (sessionId?: string) => {
      if (outputPollInFlight) {
        outputDirty = true;
        markDirtySession(sessionId);
        return;
      }

      outputPollInFlight = true;
      outputDirty = false;
      dirtyAllSessions = false;
      dirtySessionId = undefined;
      void pollTerminalOutputs(sessionId).finally(() => {
        outputPollInFlight = false;
        // poll 期间有新事件到达，立即再拉一次
        if (outputDirty) {
          pollOutputs(dirtyAllSessions ? undefined : dirtySessionId);
        }
      });
    };

    pollOutputs();

    // Tauri 事件驱动：后端每次 queue_output 后会 emit "terminal-output-ready"，payload 为 sessionId。
    let unlistenFn: (() => void) | undefined;
    let isMounted = true;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<string>('terminal-output-ready', (event) => {
        pollOutputs(typeof event.payload === 'string' ? event.payload : undefined);
      }),
    ).then((unlisten) => {
      if (isMounted) {
        unlistenFn = unlisten;
      } else {
        unlisten();
      }
    }).catch(() => {
      // 非 Tauri 环境（Web 开发模式）下 fallback 到轮询
    });

    // 低频兜底定时器，仅用于处理事件丢失等极端场景，不再承担回显即时性职责。
    const fallbackTimer = window.setInterval(() => {
      pollOutputs();
    }, 2000);

    return () => {
      isMounted = false;
      window.clearInterval(fallbackTimer);
      unlistenFn?.();
    };
  }, [pollTerminalOutputs, sessions.length]);

  // 启动时加载 AI 端点列表（含明文密钥），供侧边栏对话与设置页共用。
  const refreshAgentProviders = useCallback(async () => {
    try {
      setAgentProviders(await backend.listAgentProviders());
    } catch {
      // 端点未配置或读取失败不影响其它功能，对话面板会提示去设置里添加。
    }
  }, []);

  useEffect(() => {
    void refreshAgentProviders();
  }, [refreshAgentProviders]);

  // AI 可见执行会在没有可用标签时自行开一个终端；前端未发起过 openSession，必须靠事件登记进标签栏。
  // 依赖数组刻意为空：首个由后端创建的会话到达时 sessions 还是空的，不能因依赖变化错过订阅。
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    let isMounted = true;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<TerminalSession>('terminal-session-opened', (event) => {
        if (event.payload && typeof event.payload === 'object') {
          adoptSession(event.payload);
        }
      }),
    ).then((unlisten) => {
      if (isMounted) {
        unlistenFn = unlisten;
      } else {
        unlisten();
      }
    }).catch(() => {
      // 非 Tauri 环境没有该事件；可见执行本身也不可用，忽略即可。
    });

    return () => {
      isMounted = false;
      unlistenFn?.();
    };
  }, [adoptSession]);

  // 监听后台隧道健康监控线程发出的状态变化事件，实时将隧道“运行中/异常”状态同步到面板。
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    let isMounted = true;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen<TunnelRecord>('tunnel-status-changed', (event) => {
        if (event.payload && typeof event.payload === 'object') {
          applyTunnelStatusChange(event.payload);
        }
      }),
    ).then((unlisten) => {
      if (isMounted) {
        unlistenFn = unlisten;
      } else {
        unlisten();
      }
    }).catch(() => {
      // 非 Tauri 环境（Web 开发模式）下无事件通道，静默忽略。
    });

    return () => {
      isMounted = false;
      unlistenFn?.();
    };
  }, [applyTunnelStatusChange]);


  useEffect(() => {
    void refreshAgentBridgeRequests();

    if (!isTauriRuntime()) {
      const timer = window.setInterval(() => {
        void refreshAgentBridgeRequests();
      }, 1000);
      return () => window.clearInterval(timer);
    }

    let unlistenFn: (() => void) | undefined;
    let isMounted = true;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen('agent-bridge-requests-changed', () => {
        void refreshAgentBridgeRequests();
      }),
    ).then((unlisten) => {
      if (isMounted) {
        unlistenFn = unlisten;
      } else {
        unlisten();
      }
    }).catch(() => {
      // 事件监听失败时保留初次刷新结果；下一次界面操作仍会主动刷新请求列表。
    });

    return () => {
      isMounted = false;
      unlistenFn?.();
    };
  }, [refreshAgentBridgeRequests]);

  // 左上运行状态直接以主机 IP 作为标题，减少说明性文字占位，把空间留给终端和文件表格。
  const runtimeHostLabel = runtimeOverview?.host ?? activeRemoteConnection?.host ?? '--';
  // 命令输入框按会话分别暂存，切换标签时各自的半句命令都还在。
  const activeCommand = activeSessionId ? commandBuffers[activeSessionId] ?? '' : '';
  const activeBottomTab = activeRemoteConnectionId ? bottomTabByConnection[activeRemoteConnectionId] ?? globalBottomTab : globalBottomTab;
  const sessionContextSession = useMemo(
    () => sessions.find((session) => session.id === sessionContextMenu?.sessionId),
    [sessionContextMenu?.sessionId, sessions],
  );
  const closeSessionBatch = useCallback((sessionIds: string[]) => {
    setSessionContextMenu(null);
    // 批量关闭标签按顺序执行，避免 activeSessionId 在多个异步关闭之间来回跳。
    void (async () => {
      for (const sessionId of sessionIds) {
        await closeSession(sessionId);
      }
    })().catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    });
  }, [closeSession, setStatusMessage]);
  const reconnectSession = useCallback((session?: TerminalSession) => {
    if (!session) {
      return;
    }

    setSessionContextMenu(null);
    // 重连交给 store 在原标签位置替换会话，避免关闭后新标签被追加到最右侧。
    void reconnectSessionById(session.id).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    });
  }, [reconnectSessionById, setStatusMessage]);
  const duplicateSession = useCallback((session?: TerminalSession) => {
    if (!session) {
      return;
    }

    setSessionContextMenu(null);
    // 复制标签在源标签右侧新开一条同类会话；SSH 走登录默认目录，本地终端沿用原目录与启动命令。
    void duplicateSessionById(session.id).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    });
  }, [duplicateSessionById, setStatusMessage]);
  const approveAgentBridgeRequest = useCallback((request: AgentBridgeRequest) => {
    const editedCommand = request.kind === 'run_command' ? agentCommandEdits[request.id] : undefined;
    void backend.approveAgentBridgeRequest(request.id, editedCommand).then(() => {
      void refreshAgentBridgeRequests();
    }).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    });
  }, [agentCommandEdits, refreshAgentBridgeRequests, setStatusMessage]);
  const toggleAgentRequestExpanded = useCallback((request: AgentBridgeRequest) => {
    setAgentExpandedRequestIds((current) => {
      const defaultExpanded = request.status === 'pending';
      return { ...current, [request.id]: !(current[request.id] ?? defaultExpanded) };
    });
  }, []);
  const rejectAgentBridgeRequest = useCallback((request: AgentBridgeRequest) => {
    void backend.rejectAgentBridgeRequest(request.id, 'rejected by user').then(() => {
      void refreshAgentBridgeRequests();
    }).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    });
  }, [refreshAgentBridgeRequests, setStatusMessage]);
  const clearAgentBridgeRequests = useCallback(() => {
    void backend.clearAgentBridgeRequests().then(() => {
      void refreshAgentBridgeRequests();
    }).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    });
  }, [refreshAgentBridgeRequests, setStatusMessage]);
  const copySessionConnection = useCallback((session?: TerminalSession) => {
    if (!session) {
      return;
    }

    if (session.kind === 'local') {
      const text = `${session.title} ${session.cwd ?? ''}`.trim();
      setSessionContextMenu(null);
      void writeClipboardText(text).catch(() => undefined);
      setStatusMessage(t('statusLocalTerminalInfoCopied'));
      return;
    }

    const connection = connections.find((item) => item.id === session.connectionId);
    const text = connection
      ? `${connection.name} ${connection.username}@${connection.host}:${connection.port}`
      : session.title;
    setSessionContextMenu(null);
    // 复制连接信息只包含定位字段，不复制密码、私钥等敏感内容。
    void writeClipboardText(text).catch(() => undefined);
    setStatusMessage(t('statusConnectionInfoCopied'));
  }, [connections, setStatusMessage, t]);
  const connectionTunnels = useMemo(
    () => (activeConnectionId ? tunnels.filter((item) => item.connectionId === activeConnectionId) : []),
    [activeConnectionId, tunnels],
  );
  // 历史命令只属于已打开的远端会话；未连接时保持空列表，避免缓存历史被误认为当前会话内容。
  const connectionHistory = useMemo(
    () => activeRemoteConnectionId
      ? history.filter((item) => item.connectionId === activeRemoteConnectionId)
      : [],
    [activeRemoteConnectionId, history],
  );
  const shellClassName = [
    'app-shell',
    `theme-${settings.themeMode}`,
    settings.compactSidebar ? 'compact-sidebar' : '',
    sidebarCollapsed ? 'sidebar-collapsed' : '',
    agentSidebarCollapsed ? 'agent-sidebar-collapsed' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const explorerGridTemplate = useMemo(() => explorerColumnWidths.map((width) => `${width}px`).join(' '), [explorerColumnWidths]);
  const explorerGridMinWidth = useMemo(
    () => explorerColumnWidths.reduce((total, width) => total + width, 0) + 46,
    [explorerColumnWidths],
  );
  const explorerGridStyle = useMemo<CSSProperties>(
    () => ({ gridTemplateColumns: explorerGridTemplate, minWidth: explorerGridMinWidth }),
    [explorerGridMinWidth, explorerGridTemplate],
  );
  const selectedFilePathSet = useMemo(() => new Set(selectedFilePaths), [selectedFilePaths]);
  const explorerVirtualRange = useMemo(() => {
    const total = files.length;
    if (!total) {
      return { start: 0, end: 0, entries: [] as Array<{ file: RemoteFileEntry; index: number }> };
    }

    const viewportHeight = explorerViewport.height || 360;
    const visibleCount = Math.ceil(viewportHeight / explorerRowHeight) + explorerOverscanRows * 2;
    const start = Math.max(0, Math.floor(explorerViewport.scrollTop / explorerRowHeight) - explorerOverscanRows);
    const end = Math.min(total, start + visibleCount);
    return {
      start,
      end,
      entries: files.slice(start, end).map((file, offset) => ({ file, index: start + offset })),
    };
  }, [explorerViewport.height, explorerViewport.scrollTop, files]);
  const updateExplorerViewport = useCallback(() => {
    const list = explorerListRef.current;
    if (!list) {
      return;
    }

    const nextViewport = { height: list.clientHeight, scrollTop: list.scrollTop };
    setExplorerViewport((current) => (
      current.height === nextViewport.height && current.scrollTop === nextViewport.scrollTop
        ? current
        : nextViewport
    ));
  }, []);
  const handleExplorerScroll = useCallback(() => {
    if (explorerScrollRafRef.current !== null) {
      return;
    }

    // 滚动事件可能一帧内触发多次，合并到下一帧再刷新可视行，避免 React 跟着滚轮高频重绘。
    explorerScrollRafRef.current = window.requestAnimationFrame(() => {
      explorerScrollRafRef.current = null;
      updateExplorerViewport();
    });
  }, [updateExplorerViewport]);
  useEffect(() => {
    updateExplorerViewport();
    const list = explorerListRef.current;
    if (!list || typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateExplorerViewport);
      return () => window.removeEventListener('resize', updateExplorerViewport);
    }

    const observer = new ResizeObserver(updateExplorerViewport);
    observer.observe(list);
    return () => observer.disconnect();
  }, [files.length, sidebarWidth, runtimePanelHeight, updateExplorerViewport]);
  useEffect(() => () => {
    if (explorerScrollRafRef.current !== null) {
      window.cancelAnimationFrame(explorerScrollRafRef.current);
    }
  }, []);
  const beginExplorerColumnResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>, columnIndex: number) => {
    const startWidth = explorerColumnWidths[columnIndex] ?? explorerDefaultColumnWidths[columnIndex] ?? 100;
    const limits = explorerColumnLimits[columnIndex] ?? { min: 60, max: 240 };

    // 文件列宽只影响当前界面状态，不写入配置，避免一次临时拉宽引发设置文件迁移。
    beginResize(event, (moveEvent, startX) => {
      const nextWidth = clamp(startWidth + moveEvent.clientX - startX, limits.min, limits.max);
      setExplorerColumnWidths((current) => current.map((width, index) => (index === columnIndex ? nextWidth : width)));
    });
  }, [explorerColumnWidths]);

  useEffect(() => {
    if (!activeRemoteConnectionId) {
      return;
    }

    // 只在切换连接或聚焦会话时恢复文件路径；终端内 cd 的目录变化由 cwd 元数据单独刷新，避免旧记忆路径覆盖真实 PWD。
    const rememberedPath = pathByConnectionRef.current[activeRemoteConnectionId];
    void refreshFiles(rememberedPath ?? focusedSession?.cwd ?? '~');
    refreshRuntimeOverviewOnce();
  }, [activeRemoteConnectionId, activeSessionId, focusedSession?.status, refreshFiles, refreshRuntimeOverviewOnce]);

  useEffect(() => {
    if (!activeRemoteConnectionId) {
      return;
    }

    pathByConnectionRef.current[activeRemoteConnectionId] = currentRemotePath;
  }, [activeRemoteConnectionId, currentRemotePath]);

  useEffect(() => {
    if (!activeRemoteConnectionId || activeBottomTab !== 'history') {
      return;
    }

    void refreshRemoteHistory(activeRemoteConnectionId);
  }, [activeBottomTab, activeRemoteConnectionId, refreshRemoteHistory]);

  useEffect(() => {
    // 没有打开远端会话时地址栏保持空白，避免刚启动软件就像已经浏览某个远端目录。
    setPathInput(hasActiveRemoteSession ? currentRemotePath || '~' : '');
  }, [currentRemotePath, hasActiveRemoteSession]);

  useEffect(() => {
    if (!activeRemoteConnectionId) {
      return;
    }

    // 运行状态会发起多条远端命令；自动刷新保持最低 5 秒间隔，避免拖慢终端输入、选区和文件列表滚动。
    const timer = window.setInterval(refreshRuntimeOverviewOnce, Math.max(5, settings.runtimeRefreshIntervalSec) * 1000);
    return () => window.clearInterval(timer);
  }, [activeRemoteConnectionId, refreshRuntimeOverviewOnce, settings.runtimeRefreshIntervalSec]);

  const runtimeItems = [
    { id: 'cpu', icon: Activity, label: t('metricCpu'), value: runtimeOverview?.cpu ?? t('metricUnavailable'), percent: parseMetricPercent(runtimeOverview?.cpu ?? '') },
    { id: 'memory', icon: MemoryStick, label: t('metricMemory'), value: runtimeOverview?.memory ?? t('metricUnavailable'), percent: parseMetricPercent(runtimeOverview?.memory ?? '') },
    { id: 'storage', icon: HardDrive, label: t('metricStorage'), value: runtimeOverview?.storage ?? t('metricUnavailable'), percent: parseMetricPercent(runtimeOverview?.storage ?? '') },
    { id: 'connections', icon: Cable, label: t('metricConnections'), value: runtimeOverview?.connections ?? t('metricUnavailable'), percent: undefined },
    { id: 'uptime', icon: RefreshCw, label: t('metricUptime'), value: runtimeOverview?.uptime ?? t('metricUnavailable'), percent: undefined },
  ];
  const selectExplorerFile = useCallback((file: RemoteFileEntry, event?: ReactMouseEvent<HTMLElement>) => {
    const filePath = file.path;
    if (event?.ctrlKey || event?.metaKey) {
      const nextPaths = selectedFilePathSet.has(filePath)
        ? selectedFilePaths.filter((path) => path !== filePath)
        : [...selectedFilePaths, filePath];
      setSelectedFilePath(nextPaths.at(-1) ?? '');
      setSelectedFilePaths(nextPaths);
      return;
    }

    if (event?.shiftKey && selectedFilePath) {
      const anchorIndex = files.findIndex((item) => item.path === selectedFilePath);
      const targetIndex = files.findIndex((item) => item.path === filePath);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const [startIndex, endIndex] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        // Shift 范围选择遵循当前列表顺序，方便批量删除连续文件，同时保留最后点击项作为键盘锚点。
        setSelectedFilePath(filePath);
        setSelectedFilePaths(files.slice(startIndex, endIndex + 1).map((item) => item.path));
        return;
      }
    }

    setSelectedFilePath(filePath);
    setSelectedFilePaths([filePath]);
  }, [files, selectedFilePath, selectedFilePathSet, selectedFilePaths]);
  const uploadFilesWithProgress = useCallback((uploadFiles: File[]) => {
    const filesToUpload = uploadFiles.filter((file) => file.name);
    if (!filesToUpload.length) {
      return;
    }

    const title = filesToUpload.length === 1
      ? `${t('upload')} ${filesToUpload[0].name}`
      : `${t('upload')} ${filesToUpload.length}`;
    void runTransferProgress(title, async (setPercent) => {
      setPercent(24);
      await uploadLocalFiles(filesToUpload);
      setPercent(92);
    });
  }, [runTransferProgress, t, uploadLocalFiles]);
  const uploadFolderWithProgress = useCallback((folderFiles: File[]) => {
    const uploadFiles = folderFiles.filter((file) => file.name);
    if (!uploadFiles.length) {
      return;
    }

    // 浏览器目录选择会把根目录名放在 webkitRelativePath 第一段；没有该字段时用数量兜底，避免进度标题为空。
    const firstRelativePath = (uploadFiles[0] as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
    const folderName = firstRelativePath.split('/').filter(Boolean)[0] ?? `${uploadFiles.length} ${t('fileLabel')}`;
    void runTransferProgress(`${t('uploadFolder')} ${folderName}`, async (setPercent) => {
      setPercent(18);
      await uploadLocalFiles(uploadFiles);
      setPercent(92);
    });
  }, [runTransferProgress, t, uploadLocalFiles]);
  const uploadLocalPathsWithProgress = useCallback((localPaths: string[]) => {
    const uploadPaths = Array.from(new Set(localPaths.map((path) => path.trim()).filter(Boolean)));
    if (!uploadPaths.length) {
      return;
    }

    const title = uploadPaths.length === 1
      ? `${t('upload')} ${uploadPaths[0].split(/[\\/]/).pop() ?? uploadPaths[0]}`
      : `${t('upload')} ${uploadPaths.length}`;
    void runTransferProgress(title, async (setPercent) => {
      setPercent(18);
      await uploadLocalPaths(uploadPaths);
      setPercent(92);
    });
  }, [runTransferProgress, t, uploadLocalPaths]);
  const selectDownloadDirectory = useCallback(async () => {
    // 下载文件和文件夹前必须让用户明确选择本地目录，避免内容静默落到默认下载目录里找不到。
    const selected = await openFileDialog({
      directory: true,
      multiple: false,
      title: t('selectDownloadDirectory'),
    });
    return Array.isArray(selected) ? selected[0] : selected ?? undefined;
  }, [t]);
  const downloadPathsWithProgress = useCallback((paths: string[]) => {
    const downloadPaths = Array.from(new Set(paths.filter(Boolean)));
    if (!downloadPaths.length) {
      return;
    }

    void (async () => {
      const localDir = await selectDownloadDirectory();
      if (!localDir) {
        return;
      }

      const title = downloadPaths.length === 1
        ? `${t('download')} ${downloadPaths[0].split('/').filter(Boolean).at(-1) ?? downloadPaths[0]}`
        : `${t('download')} ${downloadPaths.length}`;
      void runTransferProgress(title, async (setPercent) => {
        setPercent(22);
        await downloadRemotePaths(downloadPaths, localDir);
        setPercent(92);
      });
    })().catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    });
  }, [downloadRemotePaths, runTransferProgress, selectDownloadDirectory, setStatusMessage, t]);
  const downloadFileWithProgress = useCallback((path: string) => {
    downloadPathsWithProgress([path]);
  }, [downloadPathsWithProgress]);
  const isDragPositionInsideExplorer = useCallback((position: { x: number; y: number }) => {
    const rect = explorerPanelRef.current?.getBoundingClientRect();
    if (!rect) {
      return false;
    }

    const isInside = (clientX: number, clientY: number) =>
      clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    // 不同平台/缩放下 Tauri 拖放坐标可能表现为物理像素或 CSS 像素；两种坐标都接受，避免拖入文件区后松开无反应。
    const scale = window.devicePixelRatio || 1;
    return isInside(position.x, position.y) || isInside(position.x / scale, position.y / scale);
  }, []);
  const startRemoteDownloadDrag = useCallback((file: RemoteFileEntry, event: ReactDragEvent<HTMLElement>) => {
    const dragPaths = selectedFilePathSet.has(file.path) ? selectedFilePaths : [file.path];
    if (!selectedFilePathSet.has(file.path)) {
      setSelectedFilePath(file.path);
      setSelectedFilePaths([file.path]);
    }

    setRemoteDownloadDragPaths(dragPaths);
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', dragPaths.join('\n'));
  }, [selectedFilePathSet, selectedFilePaths]);
  const dropRemoteSelectionToDownload = useCallback((event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    const textPaths = event.dataTransfer
      .getData('text/plain')
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter(Boolean);
    const paths = remoteDownloadDragPaths.length ? remoteDownloadDragPaths : textPaths;
    setRemoteDownloadDragPaths([]);
    downloadPathsWithProgress(paths);
  }, [downloadPathsWithProgress, remoteDownloadDragPaths]);

  useEffect(() => {
    if (!hasActiveRemoteSession) {
      setLocalFileDropActive(false);
      return;
    }

    let unlisten: (() => void) | undefined;
    let isMounted = true;
    let dropInsideExplorer = false;
    const updateDropActive = (active: boolean) => {
      if (dropInsideExplorer === active) {
        return;
      }
      dropInsideExplorer = active;
      setLocalFileDropActive(active);
    };
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) =>
      getCurrentWindow().onDragDropEvent((event) => {
        if (event.payload.type === 'enter') {
          updateDropActive(isDragPositionInsideExplorer(event.payload.position));
          return;
        }
        if (event.payload.type === 'over') {
          updateDropActive(isDragPositionInsideExplorer(event.payload.position));
          return;
        }
        if (event.payload.type === 'drop') {
          const shouldUpload = dropInsideExplorer || isDragPositionInsideExplorer(event.payload.position);
          updateDropActive(false);
          if (shouldUpload && event.payload.paths.length) {
            uploadLocalPathsWithProgress(event.payload.paths);
          }
          return;
        }
        updateDropActive(false);
      }),
    ).then((nextUnlisten) => {
      if (isMounted) {
        unlisten = nextUnlisten;
      } else {
        nextUnlisten();
      }
    }).catch(() => {
      // Web 预览环境没有 Tauri Webview 拖放 API，保留普通文件选择上传能力即可。
    });

    return () => {
      isMounted = false;
      unlisten?.();
    };
  }, [hasActiveRemoteSession, isDragPositionInsideExplorer, uploadLocalPathsWithProgress]);

  const openRemoteFileWithProgress = useCallback((path: string) => {
    const fileName = path.split('/').filter(Boolean).at(-1) ?? path;
    void runTransferProgress(`SFTP ${fileName}`, async (setPercent) => {
      setPercent(26);
      await openRemoteFile(path);
      setPercent(92);
    });
  }, [openRemoteFile, runTransferProgress]);
  const saveRemoteFileWithProgress = useCallback((path: string, saveTask: () => Promise<void>) => {
    const fileName = path.split('/').filter(Boolean).at(-1) ?? path;
    void runTransferProgress(`${t('saveToRemote')} ${fileName}`, async (setPercent) => {
      setPercent(28);
      await saveTask();
      setPercent(92);
    });
  }, [runTransferProgress, t]);
  const deleteSelectedRemotePaths = useCallback((paths: string[]) => {
    const normalizedPaths = Array.from(new Set(paths.filter(Boolean)));
    if (!normalizedPaths.length) {
      return;
    }

    const confirmText = normalizedPaths.length === 1
      ? t('deleteConfirm', { path: normalizedPaths[0] })
      : t('deleteMultipleConfirm', { count: normalizedPaths.length });
    if (!window.confirm(confirmText)) {
      return;
    }

    setFileContextMenu(null);
    void runTransferProgress(`${t('delete')} ${normalizedPaths.length}`, async (setPercent) => {
      setPercent(20);
      await deleteRemotePaths(normalizedPaths);
      setPercent(92);
      setSelectedFilePath('');
      setSelectedFilePaths([]);
    });
  }, [deleteRemotePaths, runTransferProgress, t]);
  // 复制名称：写入系统剪贴板，name 为文件名、fullPath 为从 / 起的完整路径。
  const copyFileNameToClipboard = useCallback((text: string) => {
    setFileContextMenu(null);
    void writeClipboardText(text)
      .then(() => setStatusMessage(t('statusCopiedName', { name: text })))
      .catch((error) => setStatusMessage(error instanceof Error ? error.message : String(error)));
  }, [setStatusMessage, t]);
  // 复制：把选中（或右键命中）的远端路径暂存到内部剪贴板，供后续在目标目录粘贴。
  const copyRemoteSelection = useCallback((paths: string[]) => {
    const normalizedPaths = Array.from(new Set(paths.filter(Boolean)));
    setFileContextMenu(null);
    if (!activeConnectionId || !normalizedPaths.length) {
      return;
    }
    setFileClipboard({ connectionId: activeConnectionId, paths: normalizedPaths });
    setStatusMessage(t('statusClipboardReady', { count: normalizedPaths.length }));
  }, [activeConnectionId, setStatusMessage, t]);
  // 粘贴：仅当剪贴板来源与当前连接一致时可用，复制走后端服务器本地 cp，无需经客户端中转。
  const pasteRemoteClipboard = useCallback(() => {
    setFileContextMenu(null);
    if (!fileClipboard || fileClipboard.connectionId !== activeConnectionId || !fileClipboard.paths.length) {
      return;
    }
    const sources = fileClipboard.paths;
    void runTransferProgress(`${t('fileMenuPaste')} ${sources.length}`, async (setPercent) => {
      setPercent(24);
      await copyRemotePaths(sources, currentRemotePath);
      setPercent(92);
    });
  }, [activeConnectionId, copyRemotePaths, currentRemotePath, fileClipboard, runTransferProgress, t]);
  const openRemoteFileEntry = useCallback((file: RemoteFileEntry) => {
    // 打开动作统一从文件条目入口走，保证单击选中、双击打开和回车打开使用同一套规则。
    setSelectedFilePath(file.path);
    setSelectedFilePaths([file.path]);
    if (file.isDir) {
      void refreshFiles(file.path);
      return;
    }
    if (isEditableFile(file.path)) {
      openRemoteFileWithProgress(file.path);
      return;
    }
    downloadFileWithProgress(file.path);
  }, [downloadFileWithProgress, openRemoteFileWithProgress, refreshFiles]);
  const handleExplorerKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!hasActiveRemoteSession || !files.length) {
      return;
    }

    const selectedIndex = files.findIndex((file) => file.path === selectedFilePath);
    const moveSelection = (nextIndex: number) => {
      event.preventDefault();
      const nextPath = files[clamp(nextIndex, 0, files.length - 1)].path;
      setSelectedFilePath(nextPath);
      setSelectedFilePaths([nextPath]);
    };

    // 文件列表只接管导航键和回车键，不影响终端本体的输入体验。
    if (event.key === 'Delete' && selectedFilePaths.length) {
      event.preventDefault();
      deleteSelectedRemotePaths(selectedFilePaths);
      return;
    }
    if (event.key === 'ArrowDown') {
      moveSelection(selectedIndex < 0 ? 0 : selectedIndex + 1);
      return;
    }
    if (event.key === 'ArrowUp') {
      moveSelection(selectedIndex < 0 ? files.length - 1 : selectedIndex - 1);
      return;
    }
    if (event.key === 'Home') {
      moveSelection(0);
      return;
    }
    if (event.key === 'End') {
      moveSelection(files.length - 1);
      return;
    }
    if (event.key === 'Enter' && selectedIndex >= 0) {
      event.preventDefault();
      openRemoteFileEntry(files[selectedIndex]);
    }
  }, [deleteSelectedRemotePaths, files, hasActiveRemoteSession, openRemoteFileEntry, selectedFilePath, selectedFilePaths]);

  useEffect(() => {
    // 目录刷新或断开连接后清理悬空选择，避免键盘上下键落到上一个目录的旧文件。
    const existingPaths = new Set(files.map((file) => file.path));
    if (!hasActiveRemoteSession || (selectedFilePath && !existingPaths.has(selectedFilePath))) {
      setSelectedFilePath('');
      setSelectedFilePaths([]);
      return;
    }
    setSelectedFilePaths((current) => current.filter((path) => existingPaths.has(path)));
  }, [files, hasActiveRemoteSession, selectedFilePath]);

  const orderedAgentBridgeRequests = useMemo(() => {
    // 右侧栏按消息流惯例从旧到新排列；后端仍保留 newest-first 队列，避免改变 MCP 等待逻辑。
    return agentBridgeRequests
      .map((request, index) => ({ request, index }))
      .sort((left, right) => {
        const leftTime = Date.parse(left.request.createdAt);
        const rightTime = Date.parse(right.request.createdAt);
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
          return leftTime - rightTime;
        }
        // createdAt 极端相同时，按后端原始 newest-first 下标反转，尽量维持真实入队先后。
        return right.index - left.index;
      })
      .map(({ request }) => request);
  }, [agentBridgeRequests]);
  // AI 对话审批仍保留在执行审批列表作为审计记录，同时传回对话面板完成原位审批。
  const agentChatApprovalRequests = useMemo(
    () => agentBridgeRequests.filter((request) => Boolean(request.conversationId && request.toolCallId)),
    [agentBridgeRequests],
  );
  const newestAgentRequestId = orderedAgentBridgeRequests.length
    ? orderedAgentBridgeRequests[orderedAgentBridgeRequests.length - 1].id
    : '';
  const bottomActionLabels = useMemo(() => {
    const labels = [bottomDockCollapsed ? t('expandBottomDock') : t('collapseBottomDock')];
    if (activeBottomTab === 'commands') {
      labels.push(t('sendToTerminal'));
    } else if (activeBottomTab === 'tunnels') {
      labels.push(t('tunnelStartAll'), t('tunnelStopAll'), t('newTunnel'));
    } else if (activeBottomTab === 'history') {
      labels.push(t('refresh'));
    }
    return labels;
  }, [activeBottomTab, bottomDockCollapsed, t]);
  const [bottomPanelActionsWidth, setBottomPanelActionsWidth] = useState(0);
  const bottomPanelNeedsCompactActions = useMemo(() => {
    if (!bottomPanelActionsWidth) {
      return false;
    }
    // 动作区宽度判断基于底部工具栏容器整体宽度，包含 Tab 列表占用（约 175px）、历史 Tab 搜索框保底（约 80px）与动作按钮自然展开宽度
    const tabListWidth = 175;
    const searchWidth = activeBottomTab === 'history' ? 80 : 0;
    const actionsRequiredWidth = bottomActionLabels.reduce((total, label) => total + estimateInlineButtonWidth(label), 0)
      + Math.max(0, bottomActionLabels.length - 1) * 6
      + 8;
    const totalRequiredWidth = tabListWidth + searchWidth + actionsRequiredWidth + 12;
    return totalRequiredWidth > bottomPanelActionsWidth;
  }, [activeBottomTab, bottomActionLabels, bottomPanelActionsWidth]);

  useLayoutEffect(() => {
    if (agentSidebarCollapsed || !newestAgentRequestId) {
      return;
    }
    const sidebarBody = agentSidebarBodyRef.current;
    if (!sidebarBody) {
      return;
    }
    // 新请求显示在底部，侧栏展开时同步滚到底部，避免用户只看到旧审批卡片。
    sidebarBody.scrollTop = sidebarBody.scrollHeight;
  }, [agentSidebarCollapsed, newestAgentRequestId]);

  useLayoutEffect(() => {
    const actionsElement = bottomPanelActionsRef.current;
    if (!actionsElement) {
      return undefined;
    }

    const updateActionsWidth = () => setBottomPanelActionsWidth(actionsElement.clientWidth);
    updateActionsWidth();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateActionsWidth);
      return () => window.removeEventListener('resize', updateActionsWidth);
    }

    const resizeObserver = new ResizeObserver(updateActionsWidth);
    resizeObserver.observe(actionsElement);
    return () => resizeObserver.disconnect();
  }, [activeBottomTab, agentSidebarCollapsed, sidebarCollapsed]);

  const appShellStyle = {
    // 主窗口列结构由左右侧栏折叠状态驱动，保证右侧 AI 栏展开时不会挤乱左侧栏和终端主体的顺序。
    '--app-grid-columns': `${sidebarCollapsed ? '' : 'auto 4px '}minmax(0, 1fr)${agentSidebarCollapsed ? '' : ' 4px auto'}`,
    '--main-workspace-min-width': `${mainWorkspaceMinWidth}px`,
  } as CSSProperties;
  // 审批视图通过功能组件复用；App 只提供排序结果和审批用例。
  const agentRequestPanel = (
    <AgentRequestPanel
      approveRequest={approveAgentBridgeRequest}
      commandEdits={agentCommandEdits}
      connections={connections}
      expandedRequestIds={agentExpandedRequestIds}
      rejectRequest={rejectAgentBridgeRequest}
      requests={orderedAgentBridgeRequests}
      setCommandEdits={setAgentCommandEdits}
      t={t}
      toggleExpanded={toggleAgentRequestExpanded}
    />
  );

  return (
    <div className={shellClassName} style={appShellStyle}>
      {/* 自定义标题栏：关闭原生装饰后承载操作入口和窗口控制，中间空白区作为拖动手柄。 */}
      <AppTitlebar
        agentSidebarCollapsed={agentSidebarCollapsed}
        checkingUpdate={appUpdateChecking}
        onCheckUpdate={handleTitlebarCheckUpdate}
        onCreateConnection={() => openConnectionForm()}
        onManageConnections={() => setConnectionsOpen(true)}
        onManageLocalTerminals={() => setLocalTerminalsOpen(true)}
        onOpenSettings={() => {
          setSettingsTab('appearance');
          setSettingsOpen(true);
        }}
        onToggleAgentSidebar={() => setAgentSidebarCollapsed((current) => !current)}
        onToggleSidebar={() => setSidebarCollapsed((current) => !current)}
        onToggleTheme={handleToggleTheme}
        sidebarCollapsed={sidebarCollapsed}
        t={t}
        themeMode={settings.themeMode}
        updateAvailable={Boolean(updateCheckResult?.updateAvailable)}
      />

      <div className="app-body">
      {!sidebarCollapsed ? (
      <aside className="sidebar card" style={{ minWidth: sidePanelMinWidth, width: sidebarWidth }}>
        <RuntimePanel
          activeRemoteConnectionId={activeRemoteConnectionId}
          connectionsExpanded={connectionsExpanded}
          cpuCoresExpanded={cpuCoresExpanded}
          hasActiveRemoteSession={hasActiveRemoteSession}
          height={runtimePanelHeight}
          memoryResourcesExpanded={memoryResourcesExpanded}
          onRefresh={refreshRuntimeOverviewOnce}
          runtimeConnections={runtimeConnections ?? undefined}
          runtimeConnectionsError={runtimeConnectionsError}
          runtimeConnectionsLoading={runtimeConnectionsLoading}
          runtimeHostLabel={runtimeHostLabel}
          runtimeItems={runtimeItems}
          runtimeLoading={runtimeLoading}
          runtimeOverview={runtimeOverview}
          runtimeResourceError={runtimeResourceError}
          runtimeResourceLoading={runtimeResourceLoading}
          runtimeResourceMetric={runtimeResourceMetric}
          runtimeResourceSource={settings.runtimeResourceSource ?? 'system'}
          runtimeResourceSourceLabel={runtimeResourceSourceLabel}
          runtimeResourceTarget={runtimeResourceTarget}
          runtimeResourceUsage={runtimeResourceUsage ?? undefined}
          runtimeStorageFiles={runtimeStorageFiles ?? undefined}
          runtimeStorageFilesError={runtimeStorageFilesError}
          runtimeStorageFilesLoading={runtimeStorageFilesLoading}
          setConnectionsExpanded={setConnectionsExpanded}
          setCpuCoresExpanded={setCpuCoresExpanded}
          setMemoryResourcesExpanded={setMemoryResourcesExpanded}
          setRuntimeResourceMetric={setRuntimeResourceMetric}
          setRuntimeResourceTarget={setRuntimeResourceTarget}
          setStorageFilesExpanded={setStorageFilesExpanded}
          storageFilesExpanded={storageFilesExpanded}
          t={t}
        />        <div
          className="resize-handle resize-handle-sidebar-horizontal"
          onPointerDown={(event) => {
            const startHeight = runtimePanelHeight;
            beginResize(event, (moveEvent, _startX, startY) => {
              setRuntimePanelHeight(clamp(startHeight + (moveEvent.clientY - startY), sidebarRuntimeMinHeight, resolveRuntimePanelMaxHeight()));
            });
          }}
        />

        <FileExplorerPanel
          beginColumnResize={beginExplorerColumnResize}
          currentRemotePath={currentRemotePath}
          downloadPaths={downloadPathsWithProgress}
          dropRemoteSelectionToDownload={dropRemoteSelectionToDownload}
          explorerGridMinWidth={explorerGridMinWidth}
          explorerGridStyle={explorerGridStyle}
          explorerListRef={explorerListRef}
          explorerPanelRef={explorerPanelRef}
          files={files}
          filesLoading={filesLoading}
          handleKeyDown={handleExplorerKeyDown}
          handleScroll={handleExplorerScroll}
          hasActiveRemoteSession={hasActiveRemoteSession}
          localFileDropActive={localFileDropActive}
          openEntry={openRemoteFileEntry}
          pathInput={pathInput}
          refreshFiles={refreshFiles}
          remoteDownloadDragPaths={remoteDownloadDragPaths}
          selectFile={selectExplorerFile}
          selectedFilePathSet={selectedFilePathSet}
          selectedFilePaths={selectedFilePaths}
          setFileContextMenu={setFileContextMenu}
          setPathInput={setPathInput}
          setRemoteDownloadDragPaths={setRemoteDownloadDragPaths}
          setSelectedFilePath={setSelectedFilePath}
          setSelectedFilePaths={setSelectedFilePaths}
          startRemoteDownloadDrag={startRemoteDownloadDrag}
          t={t}
          uploadFiles={uploadFilesWithProgress}
          uploadFolder={uploadFolderWithProgress}
          virtualEntries={explorerVirtualRange.entries}
        />
      </aside>
      ) : null}

      {fileContextMenu ? (
        <FileContextMenu
          activeConnectionId={activeConnectionId}
          clipboard={fileClipboard}
          copyName={copyFileNameToClipboard}
          copySelection={copyRemoteSelection}
          deletePaths={deleteSelectedRemotePaths}
          downloadFile={downloadFileWithProgress}
          downloadPaths={downloadPathsWithProgress}
          onClose={() => setFileContextMenu(null)}
          openEditor={openRemoteFileWithProgress}
          pasteClipboard={pasteRemoteClipboard}
          refreshFiles={refreshFiles}
          renamePath={renameRemotePath}
          selectedFilePathSet={selectedFilePathSet}
          selectedFilePaths={selectedFilePaths}
          t={t}
          target={fileContextMenu}
        />
      ) : null}

      {sessionContextMenu && sessionContextSession ? (
        <SessionContextMenu
          closeSessionBatch={closeSessionBatch}
          copyConnection={copySessionConnection}
          duplicateSession={duplicateSession}
          reconnectSession={reconnectSession}
          session={sessionContextSession}
          sessions={sessions}
          t={t}
          target={sessionContextMenu}
        />
      ) : null}

      {!sidebarCollapsed ? (
        <div
          className="resize-handle resize-handle-main"
          onPointerDown={(event) => {
            const startWidth = sidebarWidth;
            beginResize(event, (moveEvent, startX) => {
              setSidebarWidth(clamp(
                startWidth + (moveEvent.clientX - startX),
                sidePanelMinWidth,
                resolveSidePanelMaxWidth(!agentSidebarCollapsed, agentSidebarWidth),
              ));
            });
          }}
        />
      ) : null}

      <main className="workspace">
        <div className={`terminal-area ${bottomDockCollapsed ? 'is-bottom-collapsed' : ''}`}>
          {/* 标签栏已下沉到每个分屏格子内部（见 SplitPaneTabBar），窗口级不再保留统一工具栏，
              省下的高度全部还给终端。侧栏开关在标题栏。 */}
          <TerminalSplitGrid
            activeSessionId={activeSessionId}
            connections={connections}
            containerRef={splitGridRef}
            dragActive={splitDragActive}
            dropHint={splitDropHint}
            dropTarget={splitDropTarget}
            layout={splitLayout}
            onCloseSession={closeSession}
            onOpenContextMenu={(sessionId, x, y) => {
              setSessionContextMenu({ sessionId, x, y });
            }}
            onReorderPaneSessions={reorderPaneSessions}
            onSelectSession={selectSession}
            onSendTerminalData={(sessionId, data) => {
              void sendTerminalData(sessionId, data);
            }}
            onSplitDragPreview={handleSplitDragPreview}
            onSplitDrop={(target, sessionId) => {
              setSplitDragActive(false);
              setSplitDropTarget(null);
              applySplitDrop(target, sessionId);
            }}
            onUpdateSettings={(partial) => {
              // 行号栏右键切换的显示项直接落盘持久化，保证重启和多端同步后仍生效。
              void persistSettings({ ...settings, ...partial }).catch(() => undefined);
            }}
            sessions={sessions}
            settings={settings}
            t={t}
          />

          <div
            className="resize-handle resize-handle-horizontal"
            onPointerDown={(event) => {
              if (bottomDockCollapsed) {
                return;
              }
              const startHeight = bottomHeight;
              beginResize(event, (moveEvent, _startX, startY) => {
                setBottomHeight(clamp(startHeight + (startY - moveEvent.clientY), 180, Math.min(window.innerHeight * 0.58, 460)));
              });
            }}
          />

          <BottomDock
            actionsRef={bottomPanelActionsRef}
            activeBottomTab={activeBottomTab}
            activeCommand={activeCommand}
            activeConnectionId={activeConnectionId}
            activeRemoteConnectionId={activeRemoteConnectionId}
            activeSessionId={activeSessionId}
            collapsed={bottomDockCollapsed}
            compactActions={bottomPanelNeedsCompactActions}
            connectionHistory={connectionHistory}
            connectionTunnels={connectionTunnels}
            hasActiveRemoteSession={hasActiveRemoteSession}
            height={bottomHeight}
            historyLoading={historyLoading}
            onChangeCommand={(command) => {
              if (activeSessionId) {
                setCommandBuffer(activeSessionId, command);
              }
            }}
            onChangeTab={(tab) => {
              setGlobalBottomTab(tab);
              if (activeRemoteConnectionId) {
                setBottomTabByConnection((current) => ({ ...current, [activeRemoteConnectionId]: tab }));
              }
            }}
            onCloseTunnel={closeTunnel}
            onEditTunnel={editTunnel}
            onOpenTunnel={openTunnel}
            onRefreshHistory={() => activeRemoteConnectionId ? refreshRemoteHistory(activeRemoteConnectionId) : undefined}
            onSelectHistory={(command) => {
              if (!activeSessionId) {
                return;
              }
              setCommandBuffer(activeSessionId, command);
              if (activeRemoteConnectionId) {
                setBottomTabByConnection((current) => ({ ...current, [activeRemoteConnectionId]: 'commands' }));
              }
            }}
            onSendCommand={() => activeSessionId ? sendCommand(activeSessionId) : undefined}
            onStartAllTunnels={startAllTunnels}
            onStartTunnel={startTunnel}
            onStopAllTunnels={stopAllTunnels}
            onToggleCollapsed={() => setBottomDockCollapsed((current) => !current)}
            t={t}
            uiLanguage={settings.uiLanguage}
          />
        </div>
      </main>

      {/* AI 侧栏默认收起时不创建重组件；展开后的页签切换仍只隐藏 DOM，保留流式对话状态。 */}
      <>
        {(!agentSidebarCollapsed || agentSidebarMounted) ? <>
        <div
          className={`resize-handle resize-handle-main resize-handle-agent-sidebar ${agentSidebarCollapsed ? 'is-hidden' : ''}`}
          onPointerDown={(event) => {
            const startWidth = agentSidebarWidth;
            beginResize(event, (moveEvent, startX) => {
              setAgentSidebarWidth(clamp(
                startWidth + (startX - moveEvent.clientX),
                sidePanelMinWidth,
                resolveSidePanelMaxWidth(!sidebarCollapsed, sidebarWidth, true),
              ));
            });
          }}
        />
        <AgentSidebar
          approvalRequests={agentChatApprovalRequests}
          bodyRef={agentSidebarBodyRef}
          collapsed={agentSidebarCollapsed}
          mounted={agentSidebarMounted}
          onApproveRequest={approveAgentBridgeRequest}
          onClearRequests={clearAgentBridgeRequests}
          onRejectRequest={rejectAgentBridgeRequest}
          onTabChange={setAgentSidebarTab}
          providers={agentProviders}
          requestPanel={agentRequestPanel}
          settings={settings}
          t={t}
          tab={agentSidebarTab}
          width={agentSidebarWidth}
        />
        </> : null}
      </>
      </div>

      <ConnectionManagerModal open={connectionsOpen} onClose={() => setConnectionsOpen(false)} />
      <LocalTerminalManagerModal open={localTerminalsOpen} onClose={() => setLocalTerminalsOpen(false)} />
      <SettingsModal
        activeTab={settingsTab}
        onAgentProvidersSaved={setAgentProviders}
        onClose={() => setSettingsOpen(false)}
        onTabChange={setSettingsTab}
        open={settingsOpen}
      />
      <UpdateModal
        checkError={appUpdateCheckError}
        downloading={appUpdateInstalling}
        error={appUpdateError}
        onClose={() => {
          setAppUpdateModalOpen(false);
          setAppUpdateProgress(null);
          setAppUpdateError(null);
          setAppUpdateCheckError(null);
        }}
        onDownload={() => void handleAppInstallUpdate()}
        onErrorDismiss={() => setAppUpdateError(null)}
        onOpenRelease={(url) => openAppExternalLink(url)}
        open={appUpdateModalOpen}
        progress={appUpdateProgress}
        result={updateCheckResult}
        t={t}
      />
      <EditorModal onSaveWithProgress={saveRemoteFileWithProgress} />
      <ConnectionFormModal />
      <TunnelFormModal />
      <TransferProgressStack dismiss={dismissTransferProgress} items={transferProgressItems} />
    </div>
  );
}
