/* 本模块由 App 入口按功能域拆出，保留原组件行为与状态订阅方式。 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { Activity, Bot, Cable, Copy, Download, ExternalLink, Eye, EyeOff, Info, Plus, RefreshCw, RotateCcw, Save, Settings, ShieldCheck, Trash2, Upload, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { translate, type TranslationKey } from '../i18n';
import { backend } from '../backend';
import { writeClipboardText } from '../clipboard';
import { useAppStore } from '../store';
import {
  agentChatCjkFontOptions,
  agentChatLatinFontOptions,
  buildAgentChatFontFamily,
  isTerminalFontFamilyAvailable,
  isTerminalMonospaceFontFamily,
  resolveTerminalLatinFontFamily,
  terminalCjkFontOptions,
  terminalLatinFontOptions,
} from '../terminalFonts';
import { UpdateModal, type UpdateDownloadProgress } from '../UpdateModal';
import type { AgentBridgeStatus, AgentModel, AgentProtocol, AgentProvider, AppSettings, RuntimeResourceSource, UiLanguage, UpdateCheckResult } from '../types';
import { CustomSelect } from '../CustomSelect';
import { buildConnectionGroupTree, normalizeConnectionGroupPath } from '../app/connectionGroups';
import { buildPreviewFontFamily } from '../app/fonts';
import { clamp } from '../app/layout';
import { isTauriRuntime } from '../app/runtime';
import { translateUpdateCheckError } from '../app/updates';
import { AgentAutoConnectionTree } from '../features/settings/AgentAutoConnectionTree';
import { BackupSelectorModal } from '../features/settings/BackupSelectorModal';
import {
  agentProtocolUrlSpec,
  buildAgentMcpConfig,
  findFontOption,
  mergeInstalledFontOptions,
  numericSettingInputProps,
  previewAgentRequestUrl,
  readBoundedIntegerInput,
  resourceSettingsDefaults,
  serializeAgentProvidersForCompare,
  terminalBackgroundFitOptions,
  type SettingsTab,
} from '../features/settings/model';



export function SettingsModal({
  open,
  activeTab,
  onClose,
  onTabChange,
  onAgentProvidersSaved,
}: {
  open: boolean;
  activeTab: SettingsTab;
  onClose: () => void;
  onTabChange: (tab: SettingsTab) => void;
  /** AI 端点保存成功后回传给主组件，刷新侧边栏对话面板的端点下拉。 */
  onAgentProvidersSaved: (providers: AgentProvider[]) => void;
}) {
  const {
    checkForUpdates,
    connections,
    installUpdate,
    settings,
    testWebdavConnection,
    uploadConfig,
    downloadConfig,
    exportLocalConfig,
    importLocalConfig,
    persistSettings,
    updateCheckResult: storeUpdateCheckResult,
    updateSettings,
  } = useAppStore(
    useShallow((state) => ({
      checkForUpdates: state.checkForUpdates,
      connections: state.connections,
      installUpdate: state.installUpdate,
      settings: state.settings,
      testWebdavConnection: state.testWebdavConnection,
      uploadConfig: state.uploadConfig,
      downloadConfig: state.downloadConfig,
      exportLocalConfig: state.exportLocalConfig,
      importLocalConfig: state.importLocalConfig,
      persistSettings: state.persistSettings,
      updateCheckResult: state.updateCheckResult,
      updateSettings: state.updateSettings,
    })),
  );
  const [revealWebdavPassword, setRevealWebdavPassword] = useState(false);
  const [settingsSaveMessage, setSettingsSaveMessage] = useState('');
  const [settingsActionRunning, setSettingsActionRunning] = useState('');
  const [draftSettings, setDraftSettings] = useState<AppSettings>(settings);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateCheckResult, setUpdateCheckResult] = useState<UpdateCheckResult | null>(null);
  const [updateFeedback, setUpdateFeedback] = useState<{ kind: 'is-success' | 'is-error'; message: string } | null>(null);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [updateDownloadProgress, setUpdateDownloadProgress] = useState<UpdateDownloadProgress | null>(null);
  const [updateModalError, setUpdateModalError] = useState<string | null>(null);
  // 设置页手动检测失败时的错误文案，传给弹窗展示；成功但无更新时为 null（弹窗用 result 判断）。
  const [updateCheckError, setUpdateCheckError] = useState<string | null>(null);
  const [agentBridgeStatus, setAgentBridgeStatus] = useState<AgentBridgeStatus | null>(null);
  const [agentBridgeTransition, setAgentBridgeTransition] = useState<'starting' | 'stopping' | ''>('');
  const settingsSaveTimerRef = useRef<number | null>(null);
  const [actionFeedbackMap, setActionFeedbackMap] = useState<Record<string, { kind: 'is-success' | 'is-error'; message: string }>>({});
  const actionFeedbackTimerRef = useRef<Record<string, number>>({});
  const [backupSelectorOpen, setBackupSelectorOpen] = useState(false);
  const [backupList, setBackupList] = useState<string[]>([]);
  const backupSelectorResolveRef = useRef<((value: string | null) => void) | null>(null);
  // 本机已安装字体列表用于剔除不存在的推荐项，并限制英文字体下拉只展示真实等宽字体。
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [systemFontsLoaded, setSystemFontsLoaded] = useState(false);
  // AI 端点草稿：与其它设置一样先在本地编辑，点击保存才落盘。
  const [agentProviderDrafts, setAgentProviderDrafts] = useState<AgentProvider[]>([]);
  // 端点列表的基线快照：与草稿对比判断是否存在未保存修改，从而禁用保存按钮。
  const [agentProvidersBaseline, setAgentProvidersBaseline] = useState<AgentProvider[] | null>(null);
  // 每个端点独立控制密钥是否明文展示，与 WebDAV 密码同一交互。
  const [revealApiKeys, setRevealApiKeys] = useState<Record<string, boolean>>({});

  // 打开设置页时拉取端点列表；密钥随列表明文下发，可通过眼睛按钮切换显示。
  useEffect(() => {
    if (!open) {
      return;
    }
    backend
      .listAgentProviders()
      .then((providers) => {
        setAgentProviderDrafts(providers);
        // 基线同步记录拉取结果，草稿未改动时保存按钮保持禁用。
        setAgentProvidersBaseline(providers);
      })
      .catch(() => {
        setAgentProviderDrafts([]);
        // 拉取失败也落基线，否则新增端点后按钮会因基线缺失一直禁用。
        setAgentProvidersBaseline([]);
      });
  }, [open]);


  // 懒加载系统字体列表，仅在用户首次点击字体下拉时触发，避免打开设置时的卡顿。
  const loadSystemFontsOnce = () => {
    if (systemFontsLoaded) return;
    backend
      .listSystemFonts()
      .then((fonts) => {
        setSystemFonts(fonts);
        setSystemFontsLoaded(true);
      })
      .catch(() => {
        // 枚举失败时只保留前端实际测量为可用的字体，不能把整份推荐列表重新当作已安装字体。
        setSystemFontsLoaded(true);
      });
  };

  const t = (key: TranslationKey, replacements?: Record<string, string | number>) =>
    translate(draftSettings.uiLanguage ?? settings.uiLanguage, key, replacements);
  // 界面版本由 Vite 从 package.json 注入，避免关于页和发布元数据出现不同版本。
  const appVersion = import.meta.env.VITE_APP_VERSION;
  const webdavPasswordToggleLabel = revealWebdavPassword ? t('hideSecret') : t('showSecret');
  const configuredLatinFontFamily = draftSettings.shellLatinFontFamily || draftSettings.shellFontFamily.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '') || 'JetBrains Mono';
  const configuredCjkFontFamily = draftSettings.shellCjkFontFamily || configuredLatinFontFamily;
  const monospaceSystemFonts = useMemo(
    // 字体度量只在外观设置真正打开时执行，避免应用启动阶段为几百个系统字体做无用测量。
    () => open ? systemFonts.filter((fontFamily) => isTerminalMonospaceFontFamily(fontFamily)) : [],
    [open, systemFonts],
  );
  const latinOptions = mergeInstalledFontOptions(
    [...terminalLatinFontOptions, configuredLatinFontFamily],
    monospaceSystemFonts,
    isTerminalMonospaceFontFamily,
  );
  const cjkOptions = mergeInstalledFontOptions(
    [...terminalCjkFontOptions, configuredCjkFontFamily],
    systemFonts,
    isTerminalFontFamilyAvailable,
  );
  const resolvedLatinFontFamily = resolveTerminalLatinFontFamily(configuredLatinFontFamily);
  const selectedLatinFontFamily = findFontOption(latinOptions, configuredLatinFontFamily)
    ?? findFontOption(latinOptions, resolvedLatinFontFamily)
    ?? latinOptions[0]
    ?? resolvedLatinFontFamily;
  const selectedCjkFontFamily = findFontOption(cjkOptions, configuredCjkFontFamily)
    ?? cjkOptions[0]
    ?? selectedLatinFontFamily;
  // AI 对话正文允许比例字体，选项直接对全部系统字体做可用性筛选，不做等宽约束。
  const agentChatLatinOptions = mergeInstalledFontOptions(
    [...agentChatLatinFontOptions, draftSettings.agentChatLatinFontFamily].filter((item): item is string => Boolean(item)),
    systemFonts,
    isTerminalFontFamilyAvailable,
  );
  const agentChatCjkOptions = mergeInstalledFontOptions(
    [...agentChatCjkFontOptions, draftSettings.agentChatCjkFontFamily].filter((item): item is string => Boolean(item)),
    systemFonts,
    isTerminalFontFamilyAvailable,
  );
  // AI 执行只支持 SSH；RDP 连接保留在统一管理页，但不能进入远端命令白名单。
  const agentSshConnections = useMemo(
    () => connections.filter((connection) => connection.protocol !== 'rdp'),
    [connections],
  );
  const agentAutoGroups = useMemo(
    () => buildConnectionGroupTree(draftSettings.connectionGroups, agentSshConnections),
    [agentSshConnections, draftSettings.connectionGroups],
  );
  const agentAutoUngroupedConnections = useMemo(
    () => agentSshConnections.filter((connection) => !normalizeConnectionGroupPath(connection.groupPath)),
    [agentSshConnections],
  );
  const terminalPreviewStyle = useMemo<CSSProperties>(
    () => ({
      fontFamily: buildPreviewFontFamily(draftSettings),
      fontSize: draftSettings.shellFontSize,
      background: draftSettings.terminalBackground,
      color: draftSettings.terminalForeground,
    }),
    [draftSettings],
  );
  // AI 对话字体预览：空配置回落到终端中英文字体与字号，与右侧对话面板的实际渲染保持一致。
  const agentChatPreviewStyle = useMemo<CSSProperties>(
    () => ({
      fontFamily: buildAgentChatFontFamily(
        draftSettings.agentChatLatinFontFamily || configuredLatinFontFamily,
        draftSettings.agentChatCjkFontFamily || configuredCjkFontFamily,
      ),
      fontSize: draftSettings.agentChatFontSize || draftSettings.shellFontSize,
    }),
    [configuredCjkFontFamily, configuredLatinFontFamily, draftSettings],
  );
  const updateDraftSettings = (updater: (settings: AppSettings) => AppSettings) => {
    setDraftSettings((current) => updater(current));
  };
  // 草稿与已保存配置相同时禁用各页保存按钮，避免重复点击触发无意义的落盘；
  // 四个保存入口落盘的都是同一份完整设置，因此共用同一个"有修改"判断。
  const hasSettingsChanges = JSON.stringify(draftSettings) !== JSON.stringify(settings);
  // 重置按钮只比较资源页自身字段；草稿已是默认值时禁用，但不会影响尚待保存的其它设置。
  const hasResourceSettingsChangesFromDefaults =
    draftSettings.runtimeRefreshIntervalSec !== resourceSettingsDefaults.runtimeRefreshIntervalSec
    || draftSettings.runtimeStorageRefreshIntervalSec !== resourceSettingsDefaults.runtimeStorageRefreshIntervalSec
    || draftSettings.runtimeResourceRefreshIntervalSec !== resourceSettingsDefaults.runtimeResourceRefreshIntervalSec
    || draftSettings.runtimeResourceSource !== resourceSettingsDefaults.runtimeResourceSource
    || draftSettings.sshKeepaliveIntervalSec !== resourceSettingsDefaults.sshKeepaliveIntervalSec;
  // 端点保存按钮只在草稿相对基线有改动（含新输入密钥）时可用；基线未拉取完成前保持禁用。
  const hasAgentProviderChanges = agentProvidersBaseline !== null
    && serializeAgentProvidersForCompare(agentProviderDrafts) !== serializeAgentProvidersForCompare(agentProvidersBaseline);
  const toggleAgentAutoConnection = (connectionId: string, checked: boolean) => {
    updateDraftSettings((current) => {
      const currentIds = current.agentBridge.allowedConnectionIds;
      const allowedConnectionIds = checked
        ? Array.from(new Set([...currentIds, connectionId]))
        : currentIds.filter((item) => item !== connectionId);
      return { ...current, agentBridge: { ...current.agentBridge, allowedConnectionIds } };
    });
  };
  const showSettingsFeedback = (message: string) => {
    setSettingsSaveMessage(message);
    if (settingsSaveTimerRef.current !== null) {
      window.clearTimeout(settingsSaveTimerRef.current);
    }
    // 设置反馈只短暂停留，避免把工具面板变成常驻通知区。
    settingsSaveTimerRef.current = window.setTimeout(() => {
      setSettingsSaveMessage('');
      settingsSaveTimerRef.current = null;
    }, 3000);
  };
  const persistSettingsWithFeedback = async () => {
    const saved = await persistSettings(draftSettings);
    setDraftSettings(saved);
    void refreshAgentBridgeStatus();
    showSettingsFeedback(t('statusSettingsSaved'));
    showActionFeedback('save-webdav', 'is-success', t('statusSettingsSaved'));
  };
  const refreshAgentBridgeStatus = async () => {
    try {
      const status = await backend.agentBridgeStatus();
      setAgentBridgeStatus(status);
      return status;
    } catch {
      setAgentBridgeStatus(null);
      return null;
    }
  };
  const copyAgentMcpConfig = async () => {
    await writeClipboardText(buildAgentMcpConfig(agentBridgeStatus));
    showActionFeedback('copy-agent-config', 'is-success', t('statusAgentBridgeConfigCopied'));
  };
  const showActionFeedback = (actionKey: string, kind: 'is-success' | 'is-error', message: string) => {
    setActionFeedbackMap((prev) => ({ ...prev, [actionKey]: { kind, message } }));
    if (actionFeedbackTimerRef.current[actionKey]) {
      window.clearTimeout(actionFeedbackTimerRef.current[actionKey]);
    }
    actionFeedbackTimerRef.current[actionKey] = window.setTimeout(() => {
      setActionFeedbackMap((prev) => {
        const next = { ...prev };
        delete next[actionKey];
        return next;
      });
      delete actionFeedbackTimerRef.current[actionKey];
    }, 5000);
  };

  const addAgentProvider = () => {
    setAgentProviderDrafts((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        name: '',
        protocol: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        hasApiKey: false,
        apiKey: '',
        models: [],
      },
    ]);
  };

  const updateAgentProvider = (providerId: string, patch: Partial<AgentProvider>) => {
    setAgentProviderDrafts((current) =>
      current.map((item) => (item.id === providerId ? { ...item, ...patch } : item)),
    );
  };

  const removeAgentProvider = (providerId: string) => {
    setAgentProviderDrafts((current) => current.filter((item) => item.id !== providerId));
  };

  const updateAgentModel = (providerId: string, modelIndex: number, patch: Partial<AgentModel>) => {
    setAgentProviderDrafts((current) =>
      current.map((item) =>
        item.id === providerId
          ? {
              ...item,
              models: item.models.map((model, idx) =>
                idx === modelIndex ? { ...model, ...patch } : model,
              ),
            }
          : item,
      ),
    );
  };

  const removeAgentModel = (providerId: string, modelIndex: number) => {
    setAgentProviderDrafts((current) =>
      current.map((item) =>
        item.id === providerId
          ? { ...item, models: item.models.filter((_, idx) => idx !== modelIndex) }
          : item,
      ),
    );
  };

  const addAgentModel = (providerId: string) => {
    setAgentProviderDrafts((current) =>
      current.map((item) =>
        item.id === providerId
          ? {
              ...item,
              models: [
                ...item.models,
                { id: '', name: '', contextWindow: 200000, maxTokens: 16000 },
              ],
            }
          : item,
      ),
    );
  };

  const saveAgentProviders = async () => {
    try {
      const saved = await backend.saveAgentProviders(agentProviderDrafts);
      // 保存后回填后端归一化结果（含明文密钥），用户可继续查看或再次编辑。
      setAgentProviderDrafts(saved);
      // 基线与草稿同步后，未再次修改时保存按钮恢复禁用。
      setAgentProvidersBaseline(saved);
      onAgentProvidersSaved(saved);
      showActionFeedback('save-agent-providers', 'is-success', t('statusSettingsSaved'));
    } catch (error) {
      showActionFeedback(
        'save-agent-providers',
        'is-error',
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const runSettingsAction = async (actionKey: string, action: () => Promise<void>, successMessage?: string) => {
    setSettingsActionRunning(actionKey);
    // 清除该按钮的旧反馈，显示 working 状态
    setActionFeedbackMap((prev) => {
      const next = { ...prev };
      delete next[actionKey];
      return next;
    });
    try {
      await action();
      const message = successMessage ?? useAppStore.getState().statusMessage;
      showActionFeedback(actionKey, 'is-success', message);
      showSettingsFeedback(message);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // 用户主动取消（如下载弹窗点取消），不展示错误提示
      if (reason === t('downloadCancelled')) {
        setSettingsActionRunning('');
        return;
      }
      const message = t('statusWebdavActionFailed', { reason });
      showActionFeedback(actionKey, 'is-error', message);
      showSettingsFeedback(message);
    } finally {
      setSettingsActionRunning('');
    }
  };
  const waitForAgentBridgeState = async (enabled: boolean, initialStatus: AgentBridgeStatus | null) => {
    if (initialStatus?.running === enabled) {
      return initialStatus;
    }

    // Broker 启停通常很快；短轮询只兜底后端监听线程或端口释放稍慢的情况。
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      const status = await refreshAgentBridgeStatus();
      if (status?.running === enabled) {
        return status;
      }
    }
    return initialStatus;
  };
  const setAgentBridgeEnabled = async (enabled: boolean) => {
    const previousEnabled = draftSettings.agentBridge.enabled;
    const nextTransition = enabled ? 'starting' : 'stopping';
    const applyEnabled = (value: boolean) => {
      updateDraftSettings((current) => ({
        ...current,
        agentBridge: { ...current.agentBridge, enabled: value },
      }));
      updateSettings((current) => ({
        ...current,
        agentBridge: { ...current.agentBridge, enabled: value },
      }));
    };

    setAgentBridgeTransition(nextTransition);
    applyEnabled(enabled);
    try {
      const status = await backend.setAgentBridgeEnabled(enabled);
      const confirmedStatus = await waitForAgentBridgeState(enabled, status);
      if (confirmedStatus) {
        setAgentBridgeStatus(confirmedStatus);
      }
      showSettingsFeedback(enabled ? t('statusAgentBridgeStarted') : t('statusAgentBridgeStopped'));
    } catch (error) {
      applyEnabled(previousEnabled);
      const status = await refreshAgentBridgeStatus();
      if (status) {
        applyEnabled(status.enabled);
      }
      const reason = error instanceof Error ? error.message : String(error);
      showSettingsFeedback(t('statusAgentBridgeToggleFailed', { reason }));
    } finally {
      setAgentBridgeTransition('');
    }
  };
  // 执行规则由内置 AI 助手与外部 MCP 共用，统一从独立“执行”页保存并立即刷新 Bridge 状态。
  const saveExecutionSettings = async () => {
    await runSettingsAction(
      'save-execution-settings',
      async () => {
        const saved = await persistSettings(draftSettings);
        setDraftSettings(saved);
        await refreshAgentBridgeStatus();
      },
      t('statusExecutionSettingsSaved'),
    );
  };
  const openExternalLink = (url: string) => {
    const isDesktopRuntime = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    if (!isDesktopRuntime) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }

    // 桌面端外链交给 Rust 后端调用系统浏览器，避免 Tauri WebView 拦截 window.open。
    void backend.openExternalUrl(url).catch(() => {
      window.open(url, '_blank', 'noopener,noreferrer');
    });
  };
  const formatReleaseTime = (value?: string) => {
    if (!value) {
      return t('metricUnavailable');
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(draftSettings.uiLanguage);
  };
  const handleCheckForUpdates = async () => {
    setUpdateChecking(true);
    setUpdateFeedback(null);
    setUpdateCheckResult(null);
    setUpdateDownloadProgress(null);
    setUpdateCheckError(null);
    try {
      // 更新检测只读取 GitHub Release 元数据，用户确认后再通过 Release 页面下载新版安装包。
      const result = await checkForUpdates();
      setUpdateCheckResult(result);
      // 无论是否有新版本，都弹窗展示结果；UpdateModal 内部根据 updateAvailable 决定展示详情还是简单提示。
      setUpdateModalOpen(true);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // 后端错误码按当前界面语言翻译成完整文案，与首页标题栏的更新检测保持一致。
      setUpdateCheckError(translateUpdateCheckError(reason, draftSettings.uiLanguage));
      setUpdateModalOpen(true);
    } finally {
      setUpdateChecking(false);
    }
  };
  const handleInstallUpdate = async () => {
    if (!updateCheckResult) {
      return;
    }

    setUpdateInstalling(true);
    setUpdateFeedback(null);
    setUpdateModalError(null);
    setUpdateDownloadProgress(null);
    try {
      // 安装动作只在用户点击后触发；后端会下载 Release 安装包并启动安装程序。
      const installerPath = await installUpdate(updateCheckResult);
      // 下载完成且安装器已启动，关闭弹窗并在设置页内保留成功信息。
      setUpdateModalOpen(false);
      setUpdateFeedback({ kind: 'is-success', message: t('statusUpdateInstallStartedWithPath', { path: installerPath }) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // 用户主动取消（如下载弹窗点取消），不展示错误提示
      if (reason === t('downloadCancelled')) {
        setUpdateInstalling(false);
        return;
      }
      setUpdateModalError(t('statusUpdateInstallFailed', { reason }));
    } finally {
      setUpdateInstalling(false);
      setUpdateDownloadProgress(null);
    }
  };
  const handleLocalBackgroundImage = async () => {
    const selectedPath = await openFileDialog({
      multiple: false,
      filters: [
        {
          name: 'Images',
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'],
        },
      ],
    });
    if (!selectedPath || Array.isArray(selectedPath)) {
      return;
    }

    // 背景图需要持久保存真实本地路径，系统文件对话框会把所选文件加入 asset 协议作用域。
    updateDraftSettings((current) => ({ ...current, backgroundImage: selectedPath }));
  };
  const handleExportLocalConfig = async () => {
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+$/, '')
      .replace('T', '-');
    const selectedPath = await saveFileDialog({
      defaultPath: `myterminal-config-${timestamp}.json`,
      filters: [
        {
          name: 'JSON',
          extensions: ['json'],
        },
      ],
    });
    if (!selectedPath) {
      return;
    }

    // 本地导出由用户明确选择保存位置，避免按钮点击后只在默认目录静默生成文件。
    await runSettingsAction('export-local', () => exportLocalConfig(selectedPath));
  };

  useEffect(() => {
    if (open) {
      setDraftSettings(settings);
      setSettingsSaveMessage('');
      setSettingsActionRunning('');
      // 打开设置页时同步定时检测缓存的结果，避免首页已发现更新而关于页仍显示旧版本。
      setUpdateCheckResult(storeUpdateCheckResult);
      void refreshAgentBridgeStatus();
    }
  }, [open, settings, storeUpdateCheckResult]);

  useEffect(() => {
    if (!open || !systemFontsLoaded) {
      return;
    }
    // 旧配置引用已卸载字体时只修正设置草稿：预览立即使用真实字体，取消仍保持原配置，保存后才正式迁移。
    setDraftSettings((current) => {
      const currentLatin = current.shellLatinFontFamily || current.shellFontFamily.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '');
      const currentCjk = current.shellCjkFontFamily || currentLatin;
      if (currentLatin === selectedLatinFontFamily && currentCjk === selectedCjkFontFamily) {
        return current;
      }
      return {
        ...current,
        shellLatinFontFamily: selectedLatinFontFamily,
        shellCjkFontFamily: selectedCjkFontFamily,
      };
    });
  }, [open, selectedCjkFontFamily, selectedLatinFontFamily, systemFontsLoaded]);

  useEffect(() => {
    return () => {
      if (settingsSaveTimerRef.current !== null) {
        window.clearTimeout(settingsSaveTimerRef.current);
      }
      Object.values(actionFeedbackTimerRef.current).forEach((timer) => {
        window.clearTimeout(timer);
      });
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return undefined;
    }

    let unlistenFn: (() => void) | undefined;
    let isMounted = true;
    void import('@tauri-apps/api/event').then(({ listen }) =>
      listen('myterminal-update-download-progress', (event) => {
        const payload = event.payload as UpdateDownloadProgress;
        setUpdateDownloadProgress(payload);
      }),
    ).then((unlisten) => {
      if (isMounted) {
        unlistenFn = unlisten;
      } else {
        unlisten();
      }
    }).catch(() => {
      // 进度监听失败不影响下载安装本身，静默忽略。
    });

    return () => {
      isMounted = false;
      unlistenFn?.();
    };
  }, []);

  if (!open) {
    return null;
  }

  const agentBridgeSwitchBusy = Boolean(agentBridgeTransition);
  const agentBridgeSwitchLabel = agentBridgeTransition === 'starting'
    ? t('agentBridgeStarting')
    : agentBridgeTransition === 'stopping'
      ? t('agentBridgeStopping')
      : draftSettings.agentBridge.enabled
        ? t('enabled')
        : t('disabled');

  return (
    <div className="modal-backdrop">
      <div className="modal modal-settings card">
        <div className="modal-header">
          <div>
            <h3>{t('settingsModalTitle')}</h3>
          </div>
          <button className="icon-button" onClick={onClose} type="button">
            <X size={18} />
          </button>
        </div>

        <div className="settings-shell">
          <nav className="settings-nav">
            <button
              className={`settings-nav-item ${activeTab === 'appearance' ? 'is-active' : ''}`}
              onClick={() => onTabChange('appearance')}
              type="button"
            >
              <Settings size={16} />
              {t('settingsTabAppearance')}
            </button>
            <button
              className={`settings-nav-item ${activeTab === 'resources' ? 'is-active' : ''}`}
              onClick={() => onTabChange('resources')}
              type="button"
            >
              <Activity size={16} />
              {t('settingsTabResources')}
            </button>
            <button
              className={`settings-nav-item ${activeTab === 'sync' ? 'is-active' : ''}`}
              onClick={() => onTabChange('sync')}
              type="button"
            >
              <Upload size={16} />
              {t('settingsTabSync')}
            </button>
            <button
              className={`settings-nav-item ${activeTab === 'agent' ? 'is-active' : ''}`}
              onClick={() => onTabChange('agent')}
              type="button"
            >
              <Cable size={16} />
              {t('settingsTabAgent')}
            </button>
            <button
              className={`settings-nav-item ${activeTab === 'agentChat' ? 'is-active' : ''}`}
              onClick={() => onTabChange('agentChat')}
              type="button"
            >
              <Bot size={16} />
              {t('settingsTabAgentChat')}
            </button>
            <button
              className={`settings-nav-item ${activeTab === 'execution' ? 'is-active' : ''}`}
              onClick={() => onTabChange('execution')}
              type="button"
            >
              <ShieldCheck size={16} />
              {t('settingsTabExecution')}
            </button>
            <button
              className={`settings-nav-item ${activeTab === 'about' ? 'is-active' : ''}`}
              onClick={() => onTabChange('about')}
              type="button"
            >
              <Info size={16} />
              {t('settingsTabAbout')}
            </button>
          </nav>

          <div className="settings-content">
            {activeTab === 'appearance' ? (
              <div className="stack gap-16 settings-appearance-pane">
                {/* 外观页按用户认知路径分块：先配置应用偏好，再调整终端视觉与交互。 */}
                <section className="settings-section-block">
                  <div>
                    <h3>{t('appearanceBaseTitle')}</h3>
                  </div>

                  <div className="form-grid">
                    <div className="form-field">
                      <span>{t('fieldTheme')}</span>
                      <CustomSelect
                        aria-label={t('fieldTheme')}
                        value={draftSettings.themeMode}
                        onChange={(val) => updateDraftSettings((current) => ({ ...current, themeMode: val as 'light' | 'dark' }))}
                        options={[
                          { value: 'light', label: t('light') },
                          { value: 'dark', label: t('dark') },
                        ]}
                      />
                    </div>
                    <div className="form-field">
                      <span>{t('fieldLanguage')}</span>
                      <CustomSelect
                        aria-label={t('fieldLanguage')}
                        value={draftSettings.uiLanguage}
                        onChange={(val) => updateDraftSettings((current) => ({ ...current, uiLanguage: val as UiLanguage }))}
                        options={[
                          { value: 'zh-CN', label: t('languageZhCn') },
                          { value: 'en-US', label: t('languageEnUs') },
                        ]}
                      />
                    </div>
                  </div>
                </section>

                <section className="settings-section-block">
                  <div>
                    <h3>{t('appearanceFontTitle')}</h3>
                  </div>

                  <div className="form-grid">
                    <div className="form-field">
                      <span>{t('fieldLatinFontFamily')}</span>
                      <CustomSelect
                        aria-label={t('fieldLatinFontFamily')}
                        emptyText={t('fontSearchEmpty')}
                        value={selectedLatinFontFamily}
                        onChange={(val) => updateDraftSettings((current) => ({ ...current, shellLatinFontFamily: val }))}
                        onOpen={loadSystemFontsOnce}
                        options={latinOptions.map((fontFamily) => ({
                          value: fontFamily,
                          label: fontFamily,
                        }))}
                        searchable
                        searchPlaceholder={t('fontSearchPlaceholder')}
                      />
                    </div>
                    <div className="form-field">
                      <span>{t('fieldCjkFontFamily')}</span>
                      <CustomSelect
                        aria-label={t('fieldCjkFontFamily')}
                        emptyText={t('fontSearchEmpty')}
                        value={selectedCjkFontFamily}
                        onChange={(val) => updateDraftSettings((current) => ({ ...current, shellCjkFontFamily: val }))}
                        onOpen={loadSystemFontsOnce}
                        options={cjkOptions.map((fontFamily) => ({
                          value: fontFamily,
                          label: fontFamily,
                        }))}
                        searchable
                        searchPlaceholder={t('fontSearchPlaceholder')}
                      />
                    </div>
                    <label>
                      <span>{t('fieldFontSize')}</span>
                      <input
                        onChange={(event) => updateDraftSettings((current) => ({ ...current, shellFontSize: Number(event.target.value) || 15 }))}
                        onWheel={(event) => event.currentTarget.blur()}
                        type="number"
                        value={draftSettings.shellFontSize}
                      />
                    </label>
                    <div className="font-preview-panel span-2" style={terminalPreviewStyle}>
                      <span>0123456789 abcdefghABCDEFGH</span>
                      <strong>终端中文字体预览</strong>
                    </div>
                  </div>
                </section>

                <section className="settings-section-block">
                  <div>
                    <h3>{t('appearanceAgentChatFontTitle')}</h3>
                  </div>

                  <div className="form-grid">
                    <div className="form-field">
                      <span>{t('fieldLatinFontFamily')}</span>
                      <CustomSelect
                        aria-label={t('fieldLatinFontFamily')}
                        emptyText={t('fontSearchEmpty')}
                        value={draftSettings.agentChatLatinFontFamily ?? ''}
                        onChange={(val) => updateDraftSettings((current) => ({ ...current, agentChatLatinFontFamily: val || undefined }))}
                        onOpen={loadSystemFontsOnce}
                        options={[
                          { value: '', label: t('agentChatFontFollowTerminal') },
                          ...agentChatLatinOptions.map((fontFamily) => ({
                            value: fontFamily,
                            label: fontFamily,
                          })),
                        ]}
                        searchable
                        searchPlaceholder={t('fontSearchPlaceholder')}
                      />
                    </div>
                    <div className="form-field">
                      <span>{t('fieldCjkFontFamily')}</span>
                      <CustomSelect
                        aria-label={t('fieldCjkFontFamily')}
                        emptyText={t('fontSearchEmpty')}
                        value={draftSettings.agentChatCjkFontFamily ?? ''}
                        onChange={(val) => updateDraftSettings((current) => ({ ...current, agentChatCjkFontFamily: val || undefined }))}
                        onOpen={loadSystemFontsOnce}
                        options={[
                          { value: '', label: t('agentChatFontFollowTerminal') },
                          ...agentChatCjkOptions.map((fontFamily) => ({
                            value: fontFamily,
                            label: fontFamily,
                          })),
                        ]}
                        searchable
                        searchPlaceholder={t('fontSearchPlaceholder')}
                      />
                    </div>
                    <label>
                      <span>{t('fieldFontSize')}</span>
                      <input
                        max={48}
                        min={0}
                        onChange={(event) => updateDraftSettings((current) => ({ ...current, agentChatFontSize: Number(event.target.value) || 0 }))}
                        onWheel={(event) => event.currentTarget.blur()}
                        type="number"
                        value={draftSettings.agentChatFontSize ?? 0}
                      />
                    </label>
                    {/* 空字体与 0 字号都表示跟随终端设置，老配置升级后对话区观感保持不变。 */}
                    <p className="field-hint">{t('agentChatFontSizeHint')}</p>
                    <div className="font-preview-panel span-2" style={agentChatPreviewStyle}>
                      <span>0123456789 abcdefghABCDEFGH</span>
                      <strong>AI 对话字体预览</strong>
                    </div>
                  </div>
                </section>

                <section className="settings-section-block">
                  <div>
                    <h3>{t('appearanceBackgroundTitle')}</h3>
                  </div>

                  <div className="form-grid">
                    <label className="span-2">
                      <span>{t('fieldTerminalBackgroundImage')}</span>
                      <div className="background-image-field">
                        <input
                          placeholder="C:\\Pictures\\terminal.png 或 https://example.com/bg.png"
                          value={draftSettings.backgroundImage ?? ''}
                          onChange={(event) => updateDraftSettings((current) => ({ ...current, backgroundImage: event.target.value }))}
                        />
                        <button
                          className="secondary-button slim"
                          onClick={() => void handleLocalBackgroundImage()}
                          type="button"
                        >
                          <Upload size={14} /> {t('chooseLocalImage')}
                        </button>
                      </div>
                    </label>
                    <label>
                      <span>{t('fieldTerminalBackgroundImageOpacity')}</span>
                      <div className="opacity-control">
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={draftSettings.terminalBackgroundImageOpacity ?? 0.18}
                          onChange={(event) => updateDraftSettings((current) => ({ ...current, terminalBackgroundImageOpacity: Number(event.target.value) }))}
                        />
                        <input
                          aria-label={t('fieldTerminalBackgroundImageOpacity')}
                          type="number"
                          min={0}
                          max={100}
                          step={1}
                          value={Math.round((draftSettings.terminalBackgroundImageOpacity ?? 0.18) * 100)}
                          onChange={(event) => updateDraftSettings((current) => ({ ...current, terminalBackgroundImageOpacity: clamp(Number(event.target.value) || 0, 0, 100) / 100 }))}
                          onWheel={(event) => event.currentTarget.blur()}
                        />
                      </div>
                    </label>
                    <div className="form-field">
                      <span>{t('fieldTerminalBackgroundImageFit')}</span>
                      <CustomSelect
                        aria-label={t('fieldTerminalBackgroundImageFit')}
                        value={draftSettings.terminalBackgroundImageFit ?? 'cover'}
                        onChange={(val) =>
                          updateDraftSettings((current) => ({
                            ...current,
                            terminalBackgroundImageFit: val as NonNullable<AppSettings['terminalBackgroundImageFit']>,
                          }))
                        }
                        options={terminalBackgroundFitOptions.map((option) => ({
                          value: option.value,
                          label: t(option.labelKey),
                        }))}
                      />
                    </div>
                  </div>
                </section>

                <section className="settings-section-block">
                  <div>
                    <h3>{t('appearanceBehaviorTitle')}</h3>
                  </div>

                  <div className="form-grid settings-single-column-grid settings-compact-form-grid">
                    <div className="form-field">
                      <span>{t('fieldTerminalRightClickBehavior')}</span>
                      <CustomSelect
                        aria-label={t('fieldTerminalRightClickBehavior')}
                        value={draftSettings.terminalRightClickBehavior}
                        onChange={(val) => updateDraftSettings((current) => ({ ...current, terminalRightClickBehavior: val as AppSettings['terminalRightClickBehavior'] }))}
                        options={[
                          { value: 'paste', label: t('rightClickPaste') },
                          { value: 'menu', label: t('rightClickMenu') },
                        ]}
                      />
                    </div>
                    <div className="form-field">
                      <span>{t('fieldTerminalLineWrapMode')}</span>
                      <CustomSelect
                        aria-label={t('fieldTerminalLineWrapMode')}
                        value={draftSettings.terminalLineWrapMode ?? 'wrap'}
                        onChange={(val) => updateDraftSettings((current) => ({ ...current, terminalLineWrapMode: val as AppSettings['terminalLineWrapMode'] }))}
                        options={[
                          { value: 'wrap', label: t('terminalLineWrapModeWrap') },
                          { value: 'horizontal', label: t('terminalLineWrapModeHorizontal') },
                        ]}
                      />
                    </div>
                    <div className="agent-toggle-field settings-toggle-row settings-inline-toggle settings-centered-toggle">
                      <span id="terminal-match-selection-label">{t('fieldTerminalMatchSelection')}</span>
                      <div className="settings-inline-toggle-control">
                        <input
                          aria-label={t('fieldTerminalMatchSelection')}
                          checked={draftSettings.terminalMatchSelection ?? true}
                          type="checkbox"
                          onChange={(event) => updateDraftSettings((current) => ({ ...current, terminalMatchSelection: event.target.checked }))}
                        />
                        <strong>{(draftSettings.terminalMatchSelection ?? true) ? t('enabled') : t('disabled')}</strong>
                      </div>
                    </div>
                    <div className="agent-toggle-field settings-toggle-row settings-inline-toggle settings-centered-toggle">
                      <span id="hardware-acceleration-label">{t('fieldHardwareAcceleration')}</span>
                      <div className="settings-inline-toggle-control">
                        <input
                          aria-label={t('fieldHardwareAcceleration')}
                          checked={draftSettings.hardwareAcceleration ?? true}
                          type="checkbox"
                          onChange={(event) => updateDraftSettings((current) => ({ ...current, hardwareAcceleration: event.target.checked }))}
                        />
                        <strong>
                          {(draftSettings.hardwareAcceleration ?? true)
                            ? t('hardwareAccelerationEnabled')
                            : t('hardwareAccelerationDisabled')}
                        </strong>
                      </div>
                    </div>
                    {/* 渲染模式在 WebView2 创建前决定；提示用户重启生效，并明确软件渲染不保证更省内存。 */}
                    <p className="field-hint">{t('hardwareAccelerationHint')}</p>
                  </div>
                </section>

                <div className="modal-actions">
                  {settingsSaveMessage ? <span className="inline-save-feedback">{settingsSaveMessage}</span> : null}
                  <button className="primary-button" disabled={!hasSettingsChanges} onClick={() => void persistSettingsWithFeedback()} type="button">
                    <Save size={16} /> {t('saveAppearance')}
                  </button>
                </div>
              </div>
            ) : null}

            {activeTab === 'resources' ? (
              <div className="stack gap-16">
                <section className="settings-section-block">
                  <div>
                    <h3>{t('runtimeResourceSettingsTitle')}</h3>
                  </div>

                  <div className="form-grid settings-single-column-grid settings-compact-form-grid">
                    <label>
                      <span>{t('fieldRuntimeRefreshInterval')}</span>
                      <input
                        {...numericSettingInputProps}
                        aria-label={t('fieldRuntimeRefreshInterval')}
                        value={draftSettings.runtimeRefreshIntervalSec}
                        onChange={(event) =>
                          updateDraftSettings((current) => ({
                            ...current,
                            runtimeRefreshIntervalSec: readBoundedIntegerInput(event.target.value, 1, 60, 1),
                          }))
                        }
                      />
                    </label>
                    <label>
                      <span>{t('fieldRuntimeResourceRefreshInterval')}</span>
                      <input
                        {...numericSettingInputProps}
                        aria-label={t('fieldRuntimeResourceRefreshInterval')}
                        value={draftSettings.runtimeResourceRefreshIntervalSec ?? 3}
                        onChange={(event) =>
                          updateDraftSettings((current) => ({
                            ...current,
                            // 进程/线程明细是独立接口，允许比常规运行状态更贴近实时，但避免低于 1 秒。
                            runtimeResourceRefreshIntervalSec: readBoundedIntegerInput(event.target.value, 1, 300, 3),
                          }))
                        }
                      />
                    </label>
                    <label>
                      <span>{t('fieldRuntimeStorageRefreshInterval')}</span>
                      <input
                        {...numericSettingInputProps}
                        aria-label={t('fieldRuntimeStorageRefreshInterval')}
                        value={draftSettings.runtimeStorageRefreshIntervalSec ?? 5}
                        onChange={(event) =>
                          updateDraftSettings((current) => ({
                            ...current,
                            // 大文件扫描会遍历文件系统，前端最低 5 秒，保存时后端再次兜底。
                            runtimeStorageRefreshIntervalSec: readBoundedIntegerInput(event.target.value, 5, 300, 5),
                          }))
                        }
                      />
                    </label>
                    <label>
                      <span>{t('fieldSshKeepaliveInterval')}</span>
                      <input
                        {...numericSettingInputProps}
                        aria-label={t('fieldSshKeepaliveInterval')}
                        value={draftSettings.sshKeepaliveIntervalSec ?? 30}
                        onChange={(event) =>
                          updateDraftSettings((current) => ({
                            ...current,
                            // 0 表示关闭保活；其余值在保存归一化时夹到 10~300 秒。
                            sshKeepaliveIntervalSec: readBoundedIntegerInput(event.target.value, 0, 300, 0),
                          }))
                        }
                      />
                    </label>
                    <div className="form-field">
                      <span>{t('fieldRuntimeResourceSource')}</span>
                      <CustomSelect
                        aria-label={t('fieldRuntimeResourceSource')}
                        value={draftSettings.runtimeResourceSource ?? 'system'}
                        onChange={(val) =>
                          updateDraftSettings((current) => ({
                            ...current,
                            // 资源来源只作为内存行展开明细的默认采集策略，不影响常规运行状态轮询。
                            runtimeResourceSource: val as RuntimeResourceSource,
                          }))
                        }
                        options={[
                          { value: 'system', label: t('runtimeResourceSourceSystem') },
                          { value: 'docker', label: t('runtimeResourceSourceDocker') },
                          { value: 'podman', label: t('runtimeResourceSourcePodman') },
                          { value: 'kubernetes', label: t('runtimeResourceSourceKubernetes') },
                        ]}
                      />
                    </div>
                  </div>
                </section>

                <div className="modal-actions">
                  {settingsSaveMessage ? <span className="inline-save-feedback">{settingsSaveMessage}</span> : null}
                  <button
                    className="secondary-button resource-settings-reset-button"
                    disabled={!hasResourceSettingsChangesFromDefaults}
                    onClick={() => {
                      // 仅覆盖资源页草稿；不调用持久化接口，用户取消设置弹窗时会自然回退。
                      updateDraftSettings((current) => ({ ...current, ...resourceSettingsDefaults }));
                      setSettingsSaveMessage('');
                    }}
                    type="button"
                  >
                    <RotateCcw size={16} /> {t('resetResourceSettings')}
                  </button>
                  <button className="primary-button" disabled={!hasSettingsChanges} onClick={() => void persistSettingsWithFeedback()} type="button">
                    <Save size={16} /> {t('saveResourceSettings')}
                  </button>
                </div>
              </div>
            ) : null}

            {activeTab === 'sync' ? (
              <div className="stack gap-16">
                <section className="settings-section-block">
                  <div className="section-row">
                    <div>
                      <h3>{t('webdavSaveTitle')}</h3>
                    </div>
                    <div className="section-row compact">
                      <button className="secondary-button" disabled={Boolean(settingsActionRunning)} onClick={() => void runSettingsAction('test-webdav', () => testWebdavConnection(draftSettings), t('statusWebdavTestPassed'))} type="button">
                        <RefreshCw size={16} /> {settingsActionRunning === 'test-webdav' ? t('working') : t('testWebdavConnection')}
                      </button>
                      <button className="primary-button" disabled={Boolean(settingsActionRunning) || !hasSettingsChanges} onClick={() => void persistSettingsWithFeedback()} type="button">
                        <Save size={16} /> {t('saveWebdavSettings')}
                      </button>
                    </div>
                  </div>
                  {actionFeedbackMap['test-webdav'] ? <div className={`sync-action-feedback ${actionFeedbackMap['test-webdav'].kind}`}>{actionFeedbackMap['test-webdav'].message}</div> : null}
                  {actionFeedbackMap['save-webdav'] ? <div className={`sync-action-feedback ${actionFeedbackMap['save-webdav'].kind}`}>{actionFeedbackMap['save-webdav'].message}</div> : null}

                  <div className="form-grid">
                    <label className="span-2">
                      <span>{t('webdavBaseUrl')}</span>
                      <input value={draftSettings.webdav.baseUrl} onChange={(event) => updateDraftSettings((current) => ({ ...current, webdav: { ...current.webdav, baseUrl: event.target.value } }))} />
                    </label>
                    <label>
                      <span>{t('fieldUsername')}</span>
                      <input value={draftSettings.webdav.username} onChange={(event) => updateDraftSettings((current) => ({ ...current, webdav: { ...current.webdav, username: event.target.value } }))} />
                    </label>
                    <label>
                      <span>{t('fieldPassword')}</span>
                      <div className="password-field">
                        <input
                          type={revealWebdavPassword ? 'text' : 'password'}
                          value={draftSettings.webdav.password}
                          onChange={(event) => updateDraftSettings((current) => ({ ...current, webdav: { ...current.webdav, password: event.target.value } }))}
                        />
                        <button
                          aria-label={webdavPasswordToggleLabel}
                          className="secondary-button slim password-toggle-button"
                          onClick={() => setRevealWebdavPassword((value) => !value)}
                          title={webdavPasswordToggleLabel}
                          type="button"
                        >
                          {revealWebdavPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                          <span>{webdavPasswordToggleLabel}</span>
                        </button>
                      </div>
                    </label>
                    <label className="span-2">
                      <span>{t('webdavRemoteDir')}</span>
                      <input placeholder="/myterminal" value={draftSettings.webdav.remotePath} onChange={(event) => updateDraftSettings((current) => ({ ...current, webdav: { ...current.webdav, remotePath: event.target.value } }))} />
                    </label>
                  </div>
                </section>

                <section className="settings-section-block">
                  <div>
                    <h3>{t('webdavTransferTitle')}</h3>
                    <p>{t('webdavTransferDesc')}</p>
                  </div>

                  {(actionFeedbackMap['upload-config'] || actionFeedbackMap['download-config']) ? (
                    <div className={`sync-action-feedback ${actionFeedbackMap['upload-config'] ? actionFeedbackMap['upload-config'].kind : actionFeedbackMap['download-config']?.kind}`}>
                      {actionFeedbackMap['upload-config']?.message || actionFeedbackMap['download-config']?.message}
                    </div>
                  ) : null}

                  <div className="sync-transfer-actions">
                    <button className="primary-button" disabled={Boolean(settingsActionRunning)} onClick={() => void runSettingsAction('upload-config', async () => {
                      await persistSettings(draftSettings);
                      await uploadConfig();
                    }, t('statusUploadedConfig'))} type="button">
                      <Upload size={16} /> {settingsActionRunning === 'upload-config' ? t('working') : t('uploadConfig')}
                    </button>
                    <button className="secondary-button" disabled={Boolean(settingsActionRunning)} onClick={() => void runSettingsAction('download-config', async () => {
                      const backups = await backend.listConfigBackups();
                      if (backups.length === 0) {
                        throw new Error(t('noBackupsFound'));
                      }
                      const selected = await new Promise<string | null>((resolve) => {
                        setBackupList(backups);
                        backupSelectorResolveRef.current = resolve;
                        setBackupSelectorOpen(true);
                      });
                      if (!selected) {
                        throw new Error(t('downloadCancelled'));
                      }
                      await downloadConfig(selected);
                      setDraftSettings(useAppStore.getState().settings);
                      // 配置包可能包含 AI 端点，同步刷新端点草稿与侧栏下拉，避免继续展示旧配置。
                      const providers = await backend.listAgentProviders();
                      setAgentProviderDrafts(providers);
                      setAgentProvidersBaseline(providers);
                      onAgentProvidersSaved(providers);
                    }, t('statusDownloadedConfig'))} type="button">
                      <Download size={16} /> {settingsActionRunning === 'download-config' ? t('working') : t('downloadConfig')}
                    </button>
                  </div>
                </section>

                <section className="settings-section-block">
                  <div>
                    <h3>{t('syncSectionLocal')}</h3>
                  </div>

                  {(actionFeedbackMap['export-local'] || actionFeedbackMap['import-local']) ? (
                    <div className={`sync-action-feedback ${actionFeedbackMap['export-local'] ? actionFeedbackMap['export-local'].kind : actionFeedbackMap['import-local']?.kind}`}>
                      {actionFeedbackMap['export-local']?.message || actionFeedbackMap['import-local']?.message}
                    </div>
                  ) : null}

                  <div className="sync-transfer-actions">
                    <button className="primary-button" disabled={Boolean(settingsActionRunning)} onClick={() => void handleExportLocalConfig()} type="button">
                      <Download size={16} /> {settingsActionRunning === 'export-local' ? t('working') : t('exportLocalConfig')}
                    </button>
                    <label className={`secondary-button file-upload-button ${settingsActionRunning ? 'is-disabled' : ''}`}>
                      <Upload size={16} /> {settingsActionRunning === 'import-local' ? t('working') : t('importLocalConfig')}
                      <input
                        accept="application/json,.json"
                        className="hidden-file-input"
                        disabled={Boolean(settingsActionRunning)}
                        type="file"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file && window.confirm(t('importLocalConfigConfirm'))) {
                            void runSettingsAction('import-local', async () => {
                              await importLocalConfig(file);
                              setDraftSettings(useAppStore.getState().settings);
                              // 导入的配置可能包含 AI 端点，同步刷新端点草稿与侧栏下拉。
                              const providers = await backend.listAgentProviders();
                              setAgentProviderDrafts(providers);
                              setAgentProvidersBaseline(providers);
                              onAgentProvidersSaved(providers);
                            });
                          }
                          event.currentTarget.value = '';
                        }}
                      />
                    </label>
                  </div>
                </section>
              </div>
            ) : null}

            {activeTab === 'agent' ? (
              <div className="stack gap-16 settings-mcp-pane">
                <section className={`settings-section-block agent-bridge-control ${agentBridgeSwitchBusy ? 'is-pending' : ''}`}>
                  <div className="agent-bridge-control-main">
                    <div>
                      <h3>{t('agentBridgeTitle')}</h3>
                    </div>
                  </div>
                  <div className={`agent-toggle-field agent-bridge-power ${agentBridgeSwitchBusy ? 'is-pending' : ''}`}>
                    <span>{t('fieldAgentBridgeEnabled')}</span>
                    <input
                      aria-label={t('fieldAgentBridgeEnabled')}
                      checked={draftSettings.agentBridge.enabled}
                      disabled={agentBridgeSwitchBusy}
                      type="checkbox"
                      onChange={(event) => void setAgentBridgeEnabled(event.target.checked)}
                    />
                    <strong>{agentBridgeSwitchLabel}</strong>
                  </div>

                  <div className="settings-about-grid agent-bridge-status-grid">
                    <span>{t('agentBridgeRunState')}</span>
                    <strong>{agentBridgeStatus?.running ? t('statusRunningLabel') : t('statusStoppedLabel')}</strong>
                    <span>{t('agentBridgePort')}</span>
                    <strong>{agentBridgeStatus?.port ?? t('metricUnavailable')}</strong>
                    <span>{t('agentBridgeDiscoveryPath')}</span>
                    <strong>{agentBridgeStatus?.discoveryPath ?? t('metricUnavailable')}</strong>
                  </div>
                </section>

                <section className="settings-section-block">
                  <div className="section-row">
                    <div>
                      <h3>{t('agentBridgeUsageTitle')}</h3>
                      <p>{t('agentBridgeUsageDesc')}</p>
                    </div>
                    <button className="secondary-button" onClick={() => void copyAgentMcpConfig()} type="button">
                      <Copy size={16} /> {t('copyAgentBridgeConfig')}
                    </button>
                  </div>
                  {actionFeedbackMap['copy-agent-config'] ? <div className={`sync-action-feedback ${actionFeedbackMap['copy-agent-config'].kind}`}>{actionFeedbackMap['copy-agent-config'].message}</div> : null}
                  <div className="agent-bridge-code-grid">
                    <label className="span-2">
                      <span>{t('agentBridgeMcpConfig')}</span>
                      {/* MCP 配置通常包含多行环境变量与启动参数，增加默认高度以减少查看时滚动。 */}
                      <textarea readOnly rows={15} spellCheck={false} value={buildAgentMcpConfig(agentBridgeStatus)} />
                    </label>
                  </div>
                </section>
              </div>
            ) : null}

            {activeTab === 'agentChat' ? (
              <div className="stack gap-16">
                <section className="settings-section-block">
                  <div className="section-row">
                    <div>
                      <h3>{t('agentProvidersTitle')}</h3>
                      <p>{t('agentProvidersDesc')}</p>
                    </div>
                    <div className="section-row compact">
                      {/* AI 助手页只提供共享执行规则的快捷入口，避免复制一份会产生状态分叉的表单。 */}
                      <button className="secondary-button slim agent-provider-header-action" onClick={() => onTabChange('execution')} type="button">
                        <ShieldCheck size={14} /> {t('openExecutionSettings')}
                      </button>
                      <button className="secondary-button slim agent-provider-header-action" onClick={addAgentProvider} type="button">
                        <Plus size={14} /> {t('agentProviderAdd')}
                      </button>
                    </div>
                  </div>

                  {agentProviderDrafts.length ? (
                    <div className="stack gap-12">
                      {agentProviderDrafts.map((provider) => (
                        <div key={provider.id} className="agent-provider-card">
                          <div className="section-row compact">
                            <strong>{provider.name || provider.id}</strong>
                            <button
                              className="icon-button"
                              onClick={() => removeAgentProvider(provider.id)}
                              title={t('agentProviderDelete')}
                              type="button"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                          <div className="form-grid">
                            <label>
                              <span>{t('agentProviderName')}</span>
                              <input
                                onChange={(event) =>
                                  updateAgentProvider(provider.id, { name: event.target.value })
                                }
                                value={provider.name}
                              />
                            </label>
                            <div className="form-field">
                              <span>{t('agentProviderProtocol')}</span>
                              <CustomSelect
                                aria-label={t('agentProviderProtocol')}
                                onChange={(value) =>
                                  updateAgentProvider(provider.id, { protocol: value as AgentProtocol })
                                }
                                options={[
                                  { value: 'anthropic', label: 'Anthropic Messages' },
                                  { value: 'openai-chat', label: 'OpenAI Chat Completions' },
                                  { value: 'openai-responses', label: 'OpenAI Responses' },
                                ]}
                                value={provider.protocol}
                              />
                              {/* 大部分第三方代理是 Chat Completions 兼容，选错会直接 400，这里点明。 */}
                              <small className="agent-provider-hint">
                                {t('agentProviderProtocolHint')}
                              </small>
                            </div>
                            <label className="span-2">
                              <span>{t('agentProviderBaseUrl')}</span>
                              <input
                                onChange={(event) =>
                                  updateAgentProvider(provider.id, { baseUrl: event.target.value })
                                }
                                placeholder={agentProtocolUrlSpec[provider.protocol].placeholder}
                                value={provider.baseUrl}
                              />
                              <small className="agent-provider-hint">
                                {t('agentProviderBaseUrlHint', {
                                  path: agentProtocolUrlSpec[provider.protocol].path,
                                })}
                              </small>
                              {/* 直接把最终请求地址显示出来，用户不必猜自己填的会被拼成什么。 */}
                              <small className="agent-provider-url-preview">
                                {t('agentProviderResolvedUrl')}
                                <code>{previewAgentRequestUrl(provider.baseUrl, provider.protocol)}</code>
                              </small>
                            </label>
                            <label className="span-2">
                              <span>{t('agentProviderApiKey')}</span>
                              <div className="password-field">
                                <input
                                  onChange={(event) =>
                                    updateAgentProvider(provider.id, { apiKey: event.target.value })
                                  }
                                  placeholder="sk-..."
                                  type={revealApiKeys[provider.id] ? 'text' : 'password'}
                                  value={provider.apiKey ?? ''}
                                />
                                <button
                                  aria-label={revealApiKeys[provider.id] ? t('hideSecret') : t('showSecret')}
                                  className="secondary-button slim password-toggle-button"
                                  onClick={() =>
                                    setRevealApiKeys((current) => ({
                                      ...current,
                                      [provider.id]: !current[provider.id],
                                    }))
                                  }
                                  title={revealApiKeys[provider.id] ? t('hideSecret') : t('showSecret')}
                                  type="button"
                                >
                                  {revealApiKeys[provider.id] ? <EyeOff size={16} /> : <Eye size={16} />}
                                  <span>{revealApiKeys[provider.id] ? t('hideSecret') : t('showSecret')}</span>
                                </button>
                              </div>
                            </label>
                            <div className="span-2">
                              <div className="agent-model-header">
                                <span>{t('agentProviderModels')}</span>
                                <button
                                  className="secondary-button slim"
                                  onClick={() => addAgentModel(provider.id)}
                                  type="button"
                                >
                                  <Plus size={14} /> {t('agentProviderModelAdd')}
                                </button>
                              </div>
                              {provider.models.length > 0 ? (
                                <div className="agent-model-list">
                                  <div className="agent-model-row agent-model-row-header">
                                    <span>{t('agentProviderModelId')}</span>
                                    <span>{t('agentProviderModelContext')}</span>
                                    <span>{t('agentProviderModelMaxTokens')}</span>
                                    <span />
                                  </div>
                                  {provider.models.map((model, modelIndex) => (
                                    <div key={modelIndex} className="agent-model-row">
                                      <input
                                        onChange={(event) =>
                                          updateAgentModel(provider.id, modelIndex, { id: event.target.value })
                                        }
                                        placeholder={t('agentProviderModelIdPlaceholder')}
                                        spellCheck={false}
                                        value={model.id}
                                      />
                                      <input
                                        min={1}
                                        onChange={(event) => {
                                          const val = parseInt(event.target.value, 10);
                                          if (!isNaN(val) && val > 0) {
                                            updateAgentModel(provider.id, modelIndex, { contextWindow: val });
                                          }
                                        }}
                                        type="number"
                                        value={model.contextWindow}
                                      />
                                      <input
                                        min={1}
                                        onChange={(event) => {
                                          const val = parseInt(event.target.value, 10);
                                          if (!isNaN(val) && val > 0) {
                                            updateAgentModel(provider.id, modelIndex, { maxTokens: val });
                                          }
                                        }}
                                        type="number"
                                        value={model.maxTokens}
                                      />
                                      <button
                                        className="icon-button"
                                        onClick={() => removeAgentModel(provider.id, modelIndex)}
                                        title={t('agentProviderModelRemove')}
                                        type="button"
                                      >
                                        <Trash2 size={14} />
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                              <small className="agent-provider-hint">
                                {t('agentProviderModelsHint')}
                              </small>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-state">{t('agentProvidersEmpty')}</div>
                  )}

                  {actionFeedbackMap['save-agent-providers'] ? (
                    <div className={`sync-action-feedback ${actionFeedbackMap['save-agent-providers'].kind}`}>
                      {actionFeedbackMap['save-agent-providers'].message}
                    </div>
                  ) : null}

                  <div className="section-row compact">
                    <button className="primary-button" disabled={!hasAgentProviderChanges} onClick={() => void saveAgentProviders()} type="button">
                      <Save size={16} /> {t('agentProvidersSave')}
                    </button>
                  </div>
                </section>
              </div>
            ) : null}

            {activeTab === 'execution' ? (
              <div className="stack gap-16 settings-execution-pane">
                <section className="settings-section-block">
                  <div className="section-row">
                    <div>
                      <h3>{t('executionSettingsTitle')}</h3>
                      <p>{t('executionSettingsDesc')}</p>
                    </div>
                    <button
                      className="primary-button"
                      disabled={Boolean(settingsActionRunning) || agentBridgeSwitchBusy || !hasSettingsChanges}
                      onClick={() => void saveExecutionSettings()}
                      type="button"
                    >
                      <Save size={16} /> {settingsActionRunning === 'save-execution-settings' ? t('working') : t('saveExecutionSettings')}
                    </button>
                  </div>
                  {actionFeedbackMap['save-execution-settings'] ? <div className={`sync-action-feedback ${actionFeedbackMap['save-execution-settings'].kind}`}>{actionFeedbackMap['save-execution-settings'].message}</div> : null}

                  <div className="form-grid settings-single-column-grid">
                    <div className="agent-toggle-field settings-inline-toggle">
                      <span>{t('fieldAgentBridgeAutoExecute')}</span>
                      <div className="settings-inline-toggle-control">
                        <input
                          aria-label={t('fieldAgentBridgeAutoExecute')}
                          checked={draftSettings.agentBridge.autoExecute}
                          type="checkbox"
                          onChange={(event) =>
                            updateDraftSettings((current) => ({
                              ...current,
                              agentBridge: { ...current.agentBridge, autoExecute: event.target.checked },
                            }))
                          }
                        />
                        <strong>{draftSettings.agentBridge.autoExecute ? t('enabled') : t('disabled')}</strong>
                      </div>
                    </div>
                    <div className="agent-toggle-field settings-inline-toggle">
                      <span title={t('fieldAgentBridgeVisibleExecutionDesc')}>
                        {t('fieldAgentBridgeVisibleExecution')}
                      </span>
                      <div className="settings-inline-toggle-control">
                        <input
                          aria-label={t('fieldAgentBridgeVisibleExecution')}
                          checked={draftSettings.agentBridge.visibleExecution}
                          type="checkbox"
                          onChange={(event) =>
                            updateDraftSettings((current) => ({
                              ...current,
                              agentBridge: { ...current.agentBridge, visibleExecution: event.target.checked },
                            }))
                          }
                        />
                        <strong>{draftSettings.agentBridge.visibleExecution ? t('enabled') : t('disabled')}</strong>
                      </div>
                    </div>
                    <label>
                      <span>{t('fieldAgentBridgeTimeout')}</span>
                      <input
                        min={1}
                        max={3600}
                        type="number"
                        value={draftSettings.agentBridge.defaultTimeoutSec}
                        onChange={(event) =>
                          updateDraftSettings((current) => ({
                            ...current,
                            agentBridge: { ...current.agentBridge, defaultTimeoutSec: Number(event.target.value) || 60 },
                          }))
                        }
                        onWheel={(event) => event.currentTarget.blur()}
                      />
                    </label>
                    <label>
                      <span>{t('fieldAgentBridgeMaxOutput')}</span>
                      <input
                        min={1024}
                        type="number"
                        value={draftSettings.agentBridge.maxOutputBytes}
                        onChange={(event) =>
                          updateDraftSettings((current) => ({
                            ...current,
                            agentBridge: { ...current.agentBridge, maxOutputBytes: Number(event.target.value) || 200000 },
                          }))
                        }
                        onWheel={(event) => event.currentTarget.blur()}
                      />
                    </label>
                  </div>

                  {/* 全局自动执行开启时白名单不再参与判断，隐藏连接范围以免用户误以为勾选仍有限制作用。 */}
                  {!draftSettings.agentBridge.autoExecute ? (
                    <div className="agent-auto-connections-panel">
                      <div>
                        <h4>{t('executionConnectionsTitle')}</h4>
                        <p>{t('executionConnectionsDesc')}</p>
                      </div>
                      <div className="agent-connection-list">
                        {agentSshConnections.length ? (
                          <AgentAutoConnectionTree
                            allowedConnectionIds={draftSettings.agentBridge.allowedConnectionIds}
                            nodes={agentAutoGroups}
                            ungroupedConnections={agentAutoUngroupedConnections}
                            ungroupedLabel={t('ungroupedConnections')}
                            onToggleConnection={toggleAgentAutoConnection}
                          />
                        ) : (
                          <div className="empty-state">{t('connectionManagerEmpty')}</div>
                        )}
                      </div>
                    </div>
                  ) : null}
                </section>
              </div>
            ) : null}

            {activeTab === 'about' ? (
              <div className="stack gap-16">
                <section className="settings-section-block settings-about-section">
                  <div className="section-row">
                    <div>
                      <h3>{t('aboutTitle')}</h3>
                    </div>
                    {/* 关于页仓库入口固定指向当前 GitHub 仓库，仓库重命名后需要同步更新。 */}
                    <button
                      className="secondary-button"
                      onClick={() => openExternalLink('https://github.com/CrazyFigure/MyTerminal')}
                      type="button"
                    >
                      <ExternalLink size={16} /> {t('githubRepository')}
                    </button>
                  </div>

                  <div className="settings-about-grid">
                    <span>{t('currentVersion')}</span>
                    <strong>{updateCheckResult?.currentVersion ?? appVersion}</strong>
                    <span>{t('latestVersion')}</span>
                    <strong>{updateCheckResult?.latestVersion ?? t('metricUnavailable')}</strong>
                    <span>{t('releasePublishedAt')}</span>
                    <strong>{formatReleaseTime(updateCheckResult?.publishedAt)}</strong>
                  </div>

                  <div className="section-row compact settings-update-actions">
                    <button className="primary-button" disabled={updateChecking} onClick={() => void handleCheckForUpdates()} type="button">
                      <RefreshCw size={16} /> {updateChecking ? t('working') : t('checkUpdates')}
                    </button>
                    {updateCheckResult?.updateAvailable ? (
                      <button
                        className="secondary-button"
                        disabled={updateInstalling}
                        onClick={() => setUpdateModalOpen(true)}
                        type="button"
                      >
                        {t('updateModalTitle')}
                      </button>
                    ) : null}
                  </div>

                  {updateCheckResult && !updateCheckResult.updateAvailable ? (
                    <div className={`update-check-result is-up-to-date`}>
                      {t('statusUpdateNotAvailable')}
                    </div>
                  ) : null}
                  {updateFeedback ? (
                    <div className={`update-check-result ${updateFeedback.kind === 'is-success' ? 'is-success' : 'is-error'}`}>
                      {updateFeedback.message}
                    </div>
                  ) : null}
                </section>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <UpdateModal
        checkError={updateCheckError}
        downloading={updateInstalling}
        error={updateModalError}
        onClose={() => {
          setUpdateModalOpen(false);
          setUpdateDownloadProgress(null);
          setUpdateModalError(null);
          setUpdateCheckError(null);
        }}
        onDownload={() => void handleInstallUpdate()}
        onOpenRelease={(url) => openExternalLink(url)}
        open={updateModalOpen}
        progress={updateDownloadProgress}
        result={updateCheckResult}
        t={t}
      />
      <BackupSelectorModal
        open={backupSelectorOpen}
        backups={backupList}
        onSelect={(filename) => {
          setBackupSelectorOpen(false);
          const dir = draftSettings.webdav.remotePath.replace(/\/+$/, '');
          backupSelectorResolveRef.current?.(dir + '/' + filename);
          backupSelectorResolveRef.current = null;
        }}
        onDelete={(filename) => {
          setBackupList((prev) => prev.filter((f) => f !== filename));
        }}
        onClose={() => {
          setBackupSelectorOpen(false);
          backupSelectorResolveRef.current?.(null);
          backupSelectorResolveRef.current = null;
        }}
        t={t}
      />
    </div>
  );
}
