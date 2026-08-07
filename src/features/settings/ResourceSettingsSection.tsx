import { RotateCcw, Save } from 'lucide-react';

import { CustomSelect } from '../../CustomSelect';
import type { TranslationKey } from '../../i18n';
import type { AppSettings, RuntimeResourceSource } from '../../types';
import {
  numericSettingInputProps,
  readBoundedIntegerInput,
  resourceSettingsDefaults,
} from './model';

type Props = {
  draftSettings: AppSettings;
  hasDefaultChanges: boolean;
  hasSettingsChanges: boolean;
  onSave: () => void | Promise<unknown>;
  onUpdate: (updater: (settings: AppSettings) => AppSettings) => void;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
};

// 资源设置分区是受控草稿视图；重置只覆盖本页字段，取消弹窗仍可无缝回退。
export function ResourceSettingsSection({
  draftSettings,
  hasDefaultChanges,
  hasSettingsChanges,
  onSave,
  onUpdate,
  t,
}: Props) {
  return (
    <div className="stack gap-16">
      <section className="settings-section-block">
        <div><h3>{t('runtimeResourceSettingsTitle')}</h3></div>
        <div className="form-grid settings-single-column-grid settings-compact-form-grid">
          <label>
            <span>{t('fieldRuntimeRefreshInterval')}</span>
            <input {...numericSettingInputProps} aria-label={t('fieldRuntimeRefreshInterval')} value={draftSettings.runtimeRefreshIntervalSec} onChange={(event) =>
              onUpdate((current) => ({ ...current, runtimeRefreshIntervalSec: readBoundedIntegerInput(event.target.value, 1, 60, 1) }))
            } />
          </label>
          <label>
            <span>{t('fieldRuntimeResourceRefreshInterval')}</span>
            <input {...numericSettingInputProps} aria-label={t('fieldRuntimeResourceRefreshInterval')} value={draftSettings.runtimeResourceRefreshIntervalSec ?? 3} onChange={(event) =>
              onUpdate((current) => ({ ...current, runtimeResourceRefreshIntervalSec: readBoundedIntegerInput(event.target.value, 1, 300, 3) }))
            } />
          </label>
          <label>
            <span>{t('fieldRuntimeStorageRefreshInterval')}</span>
            <input {...numericSettingInputProps} aria-label={t('fieldRuntimeStorageRefreshInterval')} value={draftSettings.runtimeStorageRefreshIntervalSec ?? 5} onChange={(event) =>
              onUpdate((current) => ({ ...current, runtimeStorageRefreshIntervalSec: readBoundedIntegerInput(event.target.value, 5, 300, 5) }))
            } />
          </label>
          <label>
            <span>{t('fieldSshKeepaliveInterval')}</span>
            <input {...numericSettingInputProps} aria-label={t('fieldSshKeepaliveInterval')} value={draftSettings.sshKeepaliveIntervalSec ?? 30} onChange={(event) =>
              onUpdate((current) => ({ ...current, sshKeepaliveIntervalSec: readBoundedIntegerInput(event.target.value, 0, 300, 0) }))
            } />
          </label>
          <div className="form-field">
            <span>{t('fieldRuntimeResourceSource')}</span>
            <CustomSelect
              aria-label={t('fieldRuntimeResourceSource')}
              value={draftSettings.runtimeResourceSource ?? 'system'}
              onChange={(value) => onUpdate((current) => ({ ...current, runtimeResourceSource: value as RuntimeResourceSource }))}
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
        <button className="secondary-button resource-settings-reset-button" disabled={!hasDefaultChanges} onClick={() => {
          onUpdate((current) => ({ ...current, ...resourceSettingsDefaults }));
        }} type="button">
          <RotateCcw size={16} /> {t('resetResourceSettings')}
        </button>
        <button className="primary-button" disabled={!hasSettingsChanges} onClick={() => void onSave()} type="button">
          <Save size={16} /> {t('saveResourceSettings')}
        </button>
      </div>
    </div>
  );
}
