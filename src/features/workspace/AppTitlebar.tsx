import {
  CloudDownload,
  FolderTree,
  Laptop,
  Moon,
  PanelLeft,
  PanelRight,
  Plus,
  Settings,
  Sun,
} from 'lucide-react';

import { TitlebarWindowControls } from '../../components/TitlebarWindowControls';
import { Tooltip } from '../../components/Tooltip';
import type { TranslationKey } from '../../i18n';
import type { AppSettings } from '../../types';

type Props = {
  agentSidebarCollapsed: boolean;
  checkingUpdate: boolean;
  onCheckUpdate: () => void | Promise<unknown>;
  onCreateConnection: () => void;
  onManageConnections: () => void;
  onManageLocalTerminals: () => void;
  onOpenSettings: () => void;
  onToggleAgentSidebar: () => void;
  onToggleSidebar: () => void;
  onToggleTheme: () => void;
  sidebarCollapsed: boolean;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
  themeMode: AppSettings['themeMode'];
  updateAvailable: boolean;
};

// 自定义标题栏只承载窗口级入口与系统控制；业务弹窗状态和更新用例由 App 编排。
export function AppTitlebar({
  agentSidebarCollapsed,
  checkingUpdate,
  onCheckUpdate,
  onCreateConnection,
  onManageConnections,
  onManageLocalTerminals,
  onOpenSettings,
  onToggleAgentSidebar,
  onToggleSidebar,
  onToggleTheme,
  sidebarCollapsed,
  t,
  themeMode,
  updateAvailable,
}: Props) {
  const darkMode = themeMode === 'dark';
  const sidebarLabel = sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar');
  const agentSidebarLabel = agentSidebarCollapsed ? t('expandAgentSidebar') : t('collapseAgentSidebar');
  return (
    <header className="app-titlebar">
      {/* 两个侧栏开关上移到标题栏：分屏后每个格子都有自己的标签栏，
          工具栏不复存在，窗口级的显隐开关归到窗口级的标题栏才说得通。
          用 PanelLeft/PanelRight 而非箭头——图标本身就画出了它控制的那块面板。 */}
      <div className="app-titlebar-panels">
        <Tooltip content={sidebarLabel} side="bottom">
          <button
            aria-label={sidebarLabel}
            aria-pressed={!sidebarCollapsed}
            className={`titlebar-icon-button ${sidebarCollapsed ? '' : 'is-active'}`}
            onClick={onToggleSidebar}
            type="button"
          >
            <PanelLeft size={16} />
          </button>
        </Tooltip>
        <Tooltip content={agentSidebarLabel} side="bottom">
          <button
            aria-label={agentSidebarLabel}
            aria-pressed={!agentSidebarCollapsed}
            className={`titlebar-icon-button ${agentSidebarCollapsed ? '' : 'is-active'}`}
            onClick={onToggleAgentSidebar}
            type="button"
          >
            <PanelRight size={16} />
          </button>
        </Tooltip>
      </div>
      <div className="app-titlebar-actions">
        <Tooltip content={t('newConnection')} side="bottom">
          <button aria-label={t('newConnection')} className="titlebar-action-button" onClick={onCreateConnection} type="button">
            <Plus size={16} /> <span className="button-label">{t('newConnection')}</span>
          </button>
        </Tooltip>
        <Tooltip content={t('manageConnections')} side="bottom">
          <button className="titlebar-action-button" onClick={onManageConnections} type="button">
            <FolderTree size={16} /> <span className="button-label">{t('manageConnections')}</span>
          </button>
        </Tooltip>
        <Tooltip content={t('localTerminalTitle')} side="bottom">
          <button className="titlebar-action-button" onClick={onManageLocalTerminals} type="button">
            <Laptop size={16} /> <span className="button-label">{t('localTerminalTitle')}</span>
          </button>
        </Tooltip>
      </div>
      {/* 空白区专用于拖动窗口，避免按钮区误触发 Tauri 拖动。 */}
      <div className="app-titlebar-drag" data-tauri-drag-region />
      <div className="app-titlebar-system">
        <Tooltip content={t('checkUpdates')} side="bottom">
          <button
            aria-label={t('checkUpdates')}
            className="titlebar-icon-button"
            disabled={checkingUpdate}
            onClick={() => void onCheckUpdate()}
            type="button"
          >
            <CloudDownload className={checkingUpdate ? 'is-spinning' : ''} size={16} />
            {updateAvailable ? <span className="titlebar-badge-dot" /> : null}
          </button>
        </Tooltip>
        <Tooltip content={darkMode ? t('switchToLightMode') : t('switchToDarkMode')} side="bottom">
          <button
            aria-label={darkMode ? t('switchToLightMode') : t('switchToDarkMode')}
            className="titlebar-icon-button"
            onClick={onToggleTheme}
            type="button"
          >
            {darkMode ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </Tooltip>
        <Tooltip content={t('openSettings')} side="bottom">
          <button aria-label={t('openSettings')} className="titlebar-icon-button" onClick={onOpenSettings} type="button">
            <Settings size={16} />
          </button>
        </Tooltip>
        <TitlebarWindowControls t={t} />
      </div>
    </header>
  );
}
