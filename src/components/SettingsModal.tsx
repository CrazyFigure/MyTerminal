/* 本模块由 App 入口按功能域拆出，保留原组件行为与状态订阅方式。 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { X } from 'lucide-react';
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
import type { AgentBridgeStatus, AgentModel, AgentProvider, AppSettings, UpdateCheckResult } from '../types';
import { buildConnectionGroupTree, normalizeConnectionGroupPath } from '../app/connectionGroups';
import { buildPreviewFontFamily } from '../app/fonts';
import { isTauriRuntime } from '../app/runtime';
import { translateUpdateCheckError } from '../app/updates';
import { FloatingToast, type FloatingToastTone } from '../shared/ui/FloatingToast';
import { BackupSelectorModal } from '../features/settings/BackupSelectorModal';
import {
  AboutSettingsSection,
  AgentBridgeSettingsSection,
  AgentProviderSettingsSection,
  AppearanceSettingsSection,
  ExecutionSettingsSection,
  ResourceSettingsSection,
  SettingsNavigation,
  SyncSettingsSection,
} from '../features/settings';
import {
  buildAgentMcpConfig,
  findFontOption,
  mergeInstalledFontOptions,
  resourceSettingsDefaults,
  serializeAgentProvidersForCompare,
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
  const [settingsActionRunning, setSettingsActionRunning] = useState('');
  const [draftSettings, setDraftSettings] = useState<AppSettings>(settings);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [updateCheckResult, setUpdateCheckResult] = useState<UpdateCheckResult | null>(null);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [updateDownloadProgress, setUpdateDownloadProgress] = useState<UpdateDownloadProgress | null>(null);
  const [updateModalError, setUpdateModalError] = useState<string | null>(null);
  // 设置页手动检测失败时的错误文案，传给弹窗展示；成功但无更新时为 null（弹窗用 result 判断）。
  const [updateCheckError, setUpdateCheckError] = useState<string | null>(null);
  const [agentBridgeStatus, setAgentBridgeStatus] = useState<AgentBridgeStatus | null>(null);
  const [agentBridgeTransition, setAgentBridgeTransition] = useState<'starting' | 'stopping' | ''>('');
  // 设置弹窗只保留一个局部提示槽；递增编号保证连续相同文案也会重新启动一秒展示周期。
  const settingsFeedbackSequenceRef = useRef(0);
  const [settingsFeedback, setSettingsFeedback] = useState<{
    id: number;
    tone: FloatingToastTone;
    message: string;
  } | null>(null);
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
      lineHeight: draftSettings.shellLineHeight ?? 1.18,
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
      lineHeight: draftSettings.agentChatLineHeight ?? 1.6,
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
  const showSettingsFeedback = (tone: FloatingToastTone, message: string) => {
    settingsFeedbackSequenceRef.current += 1;
    setSettingsFeedback({ id: settingsFeedbackSequenceRef.current, tone, message });
  };
  const persistSettingsWithFeedback = async () => {
    try {
      const saved = await persistSettings(draftSettings);
      setDraftSettings(saved);
      void refreshAgentBridgeStatus();
      showSettingsFeedback('success', t('statusSettingsSaved'));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      showSettingsFeedback('error', `${t('statusSettingsFailed')} ${reason}`.trim());
    }
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
    try {
      await writeClipboardText(buildAgentMcpConfig(agentBridgeStatus));
      showSettingsFeedback('success', t('statusAgentBridgeConfigCopied'));
    } catch (error) {
      showSettingsFeedback('error', error instanceof Error ? error.message : String(error));
    }
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
      showSettingsFeedback('success', t('statusSettingsSaved'));
    } catch (error) {
      showSettingsFeedback('error', error instanceof Error ? error.message : String(error));
    }
  };

  const runSettingsAction = async (actionKey: string, action: () => Promise<void>, successMessage?: string) => {
    setSettingsActionRunning(actionKey);
    // 新动作开始时清除上一条提示，避免执行中的旧结果被误认为本次动作已经完成。
    setSettingsFeedback(null);
    try {
      await action();
      const message = successMessage ?? useAppStore.getState().statusMessage;
      showSettingsFeedback('success', message);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // 用户主动取消（如下载弹窗点取消），不展示错误提示
      if (reason === t('downloadCancelled')) {
        setSettingsActionRunning('');
        return;
      }
      const message = t('statusWebdavActionFailed', { reason });
      showSettingsFeedback('error', message);
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
      showSettingsFeedback('success', enabled ? t('statusAgentBridgeStarted') : t('statusAgentBridgeStopped'));
    } catch (error) {
      applyEnabled(previousEnabled);
      const status = await refreshAgentBridgeStatus();
      if (status) {
        applyEnabled(status.enabled);
      }
      const reason = error instanceof Error ? error.message : String(error);
      showSettingsFeedback('error', t('statusAgentBridgeToggleFailed', { reason }));
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
    setSettingsFeedback(null);
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
    setSettingsFeedback(null);
    setUpdateModalError(null);
    setUpdateDownloadProgress(null);
    try {
      // 安装动作只在用户点击后触发；后端会下载 Release 安装包并启动安装程序。
      const installerPath = await installUpdate(updateCheckResult);
      // 下载完成且安装器已启动，关闭更新弹窗，并在它所属的设置弹窗内显示一秒成功提示。
      setUpdateModalOpen(false);
      showSettingsFeedback('success', t('statusUpdateInstallStartedWithPath', { path: installerPath }));
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

  // 配置恢复后统一刷新设置草稿和 AI 端点聚合，避免 WebDAV 下载与本地导入各自维护一套易分叉流程。
  const refreshDraftsAfterConfigRestore = async () => {
    setDraftSettings(useAppStore.getState().settings);
    const providers = await backend.listAgentProviders();
    setAgentProviderDrafts(providers);
    setAgentProvidersBaseline(providers);
    onAgentProvidersSaved(providers);
  };

  // 同步页动作由编排层负责远程调用、反馈和恢复后的跨功能刷新，分区组件只表达用户意图。
  const handleTestWebdavConnection = () =>
    runSettingsAction('test-webdav', () => testWebdavConnection(draftSettings), t('statusWebdavTestPassed'));
  const handleUploadConfig = () =>
    runSettingsAction('upload-config', async () => {
      await persistSettings(draftSettings);
      await uploadConfig();
    }, t('statusUploadedConfig'));
  const handleDownloadConfig = () =>
    runSettingsAction('download-config', async () => {
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
      await refreshDraftsAfterConfigRestore();
    }, t('statusDownloadedConfig'));
  const handleImportLocalConfig = async (file: File) => {
    // 导入覆盖本地配置前保留原确认时机；取消时不进入动作状态，也不产生错误反馈。
    if (!window.confirm(t('importLocalConfigConfirm'))) {
      return;
    }
    await runSettingsAction('import-local', async () => {
      await importLocalConfig(file);
      await refreshDraftsAfterConfigRestore();
    });
  };

  useEffect(() => {
    if (open) {
      setDraftSettings(settings);
      setSettingsFeedback(null);
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

        {settingsFeedback ? (
          <FloatingToast
            key={settingsFeedback.id}
            message={settingsFeedback.message}
            onDismiss={() => setSettingsFeedback(null)}
            tone={settingsFeedback.tone}
          />
        ) : null}

        <div className="settings-shell">
<SettingsNavigation activeTab={activeTab} onTabChange={onTabChange} t={t} />

          <div className="settings-content">
            {activeTab === 'appearance' ? (
              <AppearanceSettingsSection
                agentChatCjkOptions={agentChatCjkOptions}
                agentChatLatinOptions={agentChatLatinOptions}
                agentChatPreviewStyle={agentChatPreviewStyle}
                cjkOptions={cjkOptions}
                draftSettings={draftSettings}
                hasSettingsChanges={hasSettingsChanges}
                latinOptions={latinOptions}
                onChooseLocalBackgroundImage={handleLocalBackgroundImage}
                onLoadSystemFonts={loadSystemFontsOnce}
                onSave={persistSettingsWithFeedback}
                onUpdate={updateDraftSettings}
                selectedCjkFontFamily={selectedCjkFontFamily}
                selectedLatinFontFamily={selectedLatinFontFamily}
                t={t}
                terminalPreviewStyle={terminalPreviewStyle}
              />
            ) : null}

            {activeTab === 'resources' ? (
              <ResourceSettingsSection
                draftSettings={draftSettings}
                hasDefaultChanges={hasResourceSettingsChangesFromDefaults}
                hasSettingsChanges={hasSettingsChanges}
                onSave={persistSettingsWithFeedback}
                onUpdate={updateDraftSettings}
                t={t}
              />
            ) : null}

            {activeTab === 'sync' ? (
<SyncSettingsSection
                hasChanges={hasSettingsChanges}
                onDownload={handleDownloadConfig}
                onExportLocal={handleExportLocalConfig}
                onImportLocal={handleImportLocalConfig}
                onSave={persistSettingsWithFeedback}
                onTestConnection={handleTestWebdavConnection}
                onTogglePassword={() => setRevealWebdavPassword((value) => !value)}
                onUpdate={updateDraftSettings}
                onUpload={handleUploadConfig}
                passwordRevealed={revealWebdavPassword}
                passwordToggleLabel={webdavPasswordToggleLabel}
                runningAction={settingsActionRunning}
                settings={draftSettings}
                t={t}
              />
            ) : null}

            {activeTab === 'agent' ? (
<AgentBridgeSettingsSection
                enabled={draftSettings.agentBridge.enabled}
                onCopyConfig={copyAgentMcpConfig}
                onEnabledChange={setAgentBridgeEnabled}
                onOpenExecutionSettings={() => onTabChange('execution')}
                status={agentBridgeStatus}
                switchBusy={agentBridgeSwitchBusy}
                switchLabel={agentBridgeSwitchLabel}
                t={t}
              />
            ) : null}

            {activeTab === 'agentChat' ? (
<AgentProviderSettingsSection
                hasChanges={hasAgentProviderChanges}
                onAddModel={addAgentModel}
                onAddProvider={addAgentProvider}
                onOpenExecutionSettings={() => onTabChange('execution')}
                onRemoveModel={removeAgentModel}
                onRemoveProvider={removeAgentProvider}
                onSave={saveAgentProviders}
                onToggleApiKey={(providerId) =>
                  setRevealApiKeys((current) => ({
                    ...current,
                    [providerId]: !current[providerId],
                  }))
                }
                onUpdateModel={updateAgentModel}
                onUpdateProvider={updateAgentProvider}
                providers={agentProviderDrafts}
                revealedApiKeys={revealApiKeys}
                t={t}
              />
            ) : null}

            {activeTab === 'execution' ? (
<ExecutionSettingsSection
                actionRunning={Boolean(settingsActionRunning)}
                bridgeSwitchBusy={agentBridgeSwitchBusy}
                connections={agentSshConnections}
                draftSettings={draftSettings}
                groups={agentAutoGroups}
                hasChanges={hasSettingsChanges}
                onSave={saveExecutionSettings}
                onToggleConnection={toggleAgentAutoConnection}
                onUpdate={updateDraftSettings}
                saving={settingsActionRunning === 'save-execution-settings'}
                t={t}
                ungroupedConnections={agentAutoUngroupedConnections}
              />
            ) : null}

            {activeTab === 'about' ? (
              <AboutSettingsSection
                appVersion={appVersion}
                checking={updateChecking}
                formatReleaseTime={formatReleaseTime}
                installing={updateInstalling}
                onCheck={handleCheckForUpdates}
                onOpenRepository={() => openExternalLink('https://github.com/CrazyFigure/MyTerminal')}
                onOpenUpdateModal={() => setUpdateModalOpen(true)}
                result={updateCheckResult}
                t={t}
              />
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
        onErrorDismiss={() => setUpdateModalError(null)}
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
