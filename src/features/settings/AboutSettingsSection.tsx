import { ExternalLink, RefreshCw, Save } from 'lucide-react';

import type { TranslationKey } from '../../i18n';
import type { UpdateChannel, UpdateCheckResult } from '../../types';
import { Tooltip } from '../../components/Tooltip';
import { CustomSelect } from '../../CustomSelect';

type Props = {
  appVersion: string;
  checking: boolean;
  formatReleaseTime: (value?: string) => string;
  installing: boolean;
  onCheck: () => void | Promise<unknown>;
  onOpenRepository: () => void;
  onOpenCnbRepository: () => void;
  channel: UpdateChannel;
  channelChanged: boolean;
  onChannelChange: (channel: UpdateChannel) => void;
  onSaveChannel: () => void;
  savingChannel: boolean;
  onOpenUpdateModal: () => void;
  result: UpdateCheckResult | null;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
};

// 关于分区展示版本、渠道与仓库入口，下载、安装和外链副作用由设置应用层提供。
export function AboutSettingsSection({
  appVersion,
  checking,
  formatReleaseTime,
  installing,
  onCheck,
  onOpenRepository,
  onOpenCnbRepository,
  channel,
  channelChanged,
  onChannelChange,
  onSaveChannel,
  savingChannel,
  onOpenUpdateModal,
  result,
  t,
}: Props) {
  return (
    <div className="stack gap-16">
      <section className="settings-section-block settings-about-section">
        <div className="section-row">
          <div><h3>{t('aboutTitle')}</h3></div>
          <div className="section-row compact">
            <button className="secondary-button" onClick={onOpenRepository} type="button">
              <ExternalLink size={16} /> {t('githubRepository')}
            </button>
            <button className="secondary-button" onClick={onOpenCnbRepository} type="button">
              <ExternalLink size={16} /> {t('cnbRepository')}
            </button>
          </div>
        </div>
        <div className="section-row compact settings-update-channel-row">
          <Tooltip content={t('updateChannelHint')}>
            <div className="section-row compact settings-update-channel-fields">
              <span className="settings-update-channel-label">{t('updateChannel')}</span>
              <CustomSelect
                className="settings-update-channel-select"
                aria-label={t('updateChannel')}
                value={channel}
                disabled={checking || installing || savingChannel}
                onChange={(value) => onChannelChange(value as UpdateChannel)}
                options={[
                  { value: 'github', label: 'GitHub' },
                  { value: 'cnb', label: t('cnbChannel') },
                ]}
              />
            </div>
          </Tooltip>
          <button className="primary-button" type="button" disabled={!channelChanged || checking || installing || savingChannel} onClick={onSaveChannel}>
            <Save size={16} /> {savingChannel ? t('working') : t('save')}
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
