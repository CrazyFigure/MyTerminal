import { Download, PackageOpen } from 'lucide-react';

import type { TranslationKey } from '../i18n';
import type { DownloadProgress, FontPackStatus } from '../types';

type FontPackPromptModalProps = {
  open: boolean;
  status: FontPackStatus | null;
  downloading: boolean;
  progress: DownloadProgress | null;
  error: string | null;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
  onDownload: () => void;
  onUseSystem: () => void;
};

const formatBytes = (value?: number) => {
  if (!value || !Number.isFinite(value)) {
    return '—';
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
};

/** 首次启动提示只提供两个明确结果：下载应用字体，或保存为真实系统字体；关闭应用不会擅自改变设置。 */
export function FontPackPromptModal({
  open,
  status,
  downloading,
  progress,
  error,
  t,
  onDownload,
  onUseSystem,
}: FontPackPromptModalProps) {
  if (!open) {
    return null;
  }
  const totalBytes = progress?.totalBytes ?? status?.downloadSizeBytes;
  const percent = progress?.percent
    ?? (progress && totalBytes
      ? Math.round((progress.downloadedBytes / totalBytes) * 100)
      : 0);

  return (
    <div className="modal-backdrop font-pack-prompt-backdrop">
      <div aria-labelledby="font-pack-prompt-title" aria-modal="true" className="modal card font-pack-prompt-modal" role="dialog">
        <div className="font-pack-prompt-icon" aria-hidden="true">
          <PackageOpen size={24} />
        </div>
        <div className="font-pack-prompt-copy">
          <h3 id="font-pack-prompt-title">{t('fontPackPromptTitle')}</h3>
          <p>{t('fontPackPromptDescription')}</p>
          <p className="field-hint">{t('fontPackPromptPrivacy')}</p>
        </div>

        {error ? <p className="font-pack-error" role="alert">{error}</p> : null}

        {downloading ? (
          <div className="font-pack-progress" aria-live="polite">
            <div className="font-pack-progress-copy">
              <span>{t('fontPackDownloading')}</span>
              <span>{percent}%</span>
            </div>
            <div className="font-pack-progress-track">
              <div className="font-pack-progress-fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
            </div>
            <span className="field-hint">
              {t('fontPackDownloadProgress', {
                downloaded: formatBytes(progress?.downloadedBytes),
                total: formatBytes(totalBytes),
              })}
            </span>
          </div>
        ) : null}

        <div className="modal-actions font-pack-prompt-actions">
          <button className="secondary-button font-pack-action-button" disabled={downloading} onClick={onUseSystem} type="button">
            {t('fontPackUseSystem')}
          </button>
          <button autoFocus className="primary-button font-pack-action-button" disabled={downloading} onClick={onDownload} type="button">
            <Download size={16} />
            {downloading ? t('fontPackDownloading') : t('fontPackDownloadAndEnable')}
          </button>
        </div>
      </div>
    </div>
  );
}
