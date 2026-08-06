import { CloudDownload, FolderTree, Laptop, Moon, Plus, Settings, Sun } from 'lucide-react';

import { TitlebarWindowControls } from '../../components/TitlebarWindowControls';
import type { TranslationKey } from '../../i18n';
import type { AppSettings } from '../../types';

type Props = {
  checkingUpdate: boolean;
  onCheckUpdate: () => void | Promise<unknown>;
  onCreateConnection: () => void;
  onManageConnections: () => void;
  onManageLocalTerminals: () => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
  themeMode: AppSettings['themeMode'];
  updateAvailable: boolean;
};

// 自定义标题栏只承载窗口级入口与系统控制；业务弹窗状态和更新用例由 App 编排。
export function AppTitlebar({
  checkingUpdate,
  onCheckUpdate,
  onCreateConnection,
  onManageConnections,
  onManageLocalTerminals,
  onOpenSettings,
  onToggleTheme,
  t,
  themeMode,
  updateAvailable,
}: Props) {
  const darkMode = themeMode === 'dark';
  return (
    <header className="app-titlebar">
      <div className="app-titlebar-actions">
        <button aria-label={t('newConnection')} className="titlebar-action-button" onClick={onCreateConnection} title={t('newConnection')} type="button">
          <Plus size={16} /> <span className="button-label">{t('newConnection')}</span>
        </button>
        <button className="titlebar-action-button" onClick={onManageConnections} title={t('manageConnections')} type="button">
          <FolderTree size={16} /> <span className="button-label">{t('manageConnections')}</span>
        </button>
        <button className="titlebar-action-button" onClick={onManageLocalTerminals} title={t('localTerminalTitle')} type="button">
          <Laptop size={16} /> <span className="button-label">{t('localTerminalTitle')}</span>
        </button>
      </div>
      {/* 空白区专用于拖动窗口，避免按钮区误触发 Tauri 拖动。 */}
      <div className="app-titlebar-drag" data-tauri-drag-region />
      <div className="app-titlebar-system">
        <button
          aria-label={t('checkUpdates')}
          className="titlebar-icon-button"
          disabled={checkingUpdate}
          onClick={() => void onCheckUpdate()}
          title={t('checkUpdates')}
          type="button"
        >
          <CloudDownload className={checkingUpdate ? 'is-spinning' : ''} size={16} />
          {updateAvailable ? <span className="titlebar-badge-dot" /> : null}
        </button>
        <button
          aria-label={darkMode ? t('switchToLightMode') : t('switchToDarkMode')}
          className="titlebar-icon-button"
          onClick={onToggleTheme}
          title={darkMode ? t('switchToLightMode') : t('switchToDarkMode')}
          type="button"
        >
          {darkMode ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button aria-label={t('openSettings')} className="titlebar-icon-button" onClick={onOpenSettings} title={t('openSettings')} type="button">
          <Settings size={16} />
        </button>
        <TitlebarWindowControls t={t} />
      </div>
    </header>
  );
}
