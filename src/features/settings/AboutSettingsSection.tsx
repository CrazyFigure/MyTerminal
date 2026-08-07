import { ExternalLink, RefreshCw } from 'lucide-react';

import type { TranslationKey } from '../../i18n';
import type { UpdateCheckResult } from '../../types';

type Props = {
  appVersion: string;
  checking: boolean;
  formatReleaseTime: (value?: string) => string;
  installing: boolean;
  onCheck: () => void | Promise<unknown>;
  onOpenRepository: () => void;
  onOpenUpdateModal: () => void;
  result: UpdateCheckResult | null;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
};

// 关于分区只展示版本和更新入口；下载、安装及外链副作用由设置应用层提供。
export function AboutSettingsSection({
  appVersion,
  checking,
  formatReleaseTime,
  installing,
  onCheck,
  onOpenRepository,
  onOpenUpdateModal,
  result,
  t,
}: Props) {
  return (
    <div className="stack gap-16">
      <section className="settings-section-block settings-about-section">
        <div className="section-row">
          <div><h3>{t('aboutTitle')}</h3></div>
          <button className="secondary-button" onClick={onOpenRepository} type="button">
            <ExternalLink size={16} /> {t('githubRepository')}
          </button>
        </div>
        <div className="settings-about-grid">
          <span>{t('currentVersion')}</span>
          <strong>{result?.currentVersion ?? appVersion}</strong>
          <span>{t('latestVersion')}</span>
          <strong>{result?.latestVersion ?? t('metricUnavailable')}</strong>
          <span>{t('releasePublishedAt')}</span>
          <strong>{formatReleaseTime(result?.publishedAt)}</strong>
        </div>
        <div className="section-row compact settings-update-actions">
          <button className="primary-button" disabled={checking} onClick={() => void onCheck()} type="button">
            <RefreshCw size={16} /> {checking ? t('working') : t('checkUpdates')}
          </button>
          {result?.updateAvailable ? (
            <button className="secondary-button" disabled={installing} onClick={onOpenUpdateModal} type="button">
              {t('updateModalTitle')}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
