import { useMemo } from 'react';
import { Download, ExternalLink, X } from 'lucide-react';
import type { UpdateCheckResult } from './types';
import type { TranslationKey } from './i18n';
import { FloatingToast } from './shared/ui/FloatingToast';
import { UpdateReleaseHistory } from './features/updates';
import { Tooltip } from './components/Tooltip';

export type UpdateDownloadProgress = {
  downloadedBytes: number;
  totalBytes?: number;
  percent?: number;
};

type UpdateModalProps = {
  open: boolean;
  result: UpdateCheckResult | null;
  downloading: boolean;
  progress: UpdateDownloadProgress | null;
  error?: string | null;
  // 手动检测失败时的提示文案；非空时以“更新”结果弹窗形式展示错误，不再要求 result 存在。
  checkError?: string | null;
  // 打开 GitHub Release 下载页地址，供“已是最新/检测失败”结果弹窗的“打开下载页”按钮使用。
  releaseUrl?: string;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
  onClose: () => void;
  onDownload: () => void;
  onErrorDismiss?: () => void;
  onOpenRelease: (url: string) => void;
};

const formatBytes = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

export function UpdateModal({
  open,
  result,
  downloading,
  progress,
  error,
  checkError,
  releaseUrl,
  t,
  onClose,
  onDownload,
  onErrorDismiss,
  onOpenRelease,
}: UpdateModalProps) {
  // 发布说明交由共享历史视图处理，检测结果和下载阶段使用同一份版本数据。
  // 是否展示“更新详情”弹窗：仅当确实检测到可用新版本时才走完整详情布局。
  const showUpdateDetail = Boolean(result?.updateAvailable);

  const sizeText = useMemo(() => {
    const size = result?.installerSize;
    if (!size) {
      return t('metricUnavailable');
    }
    return formatBytes(size);
  }, [result?.installerSize, t]);

  const progressPercent = useMemo(() => {
    if (progress?.percent !== undefined) {
      return Math.min(100, Math.max(0, progress.percent));
    }
    if (progress && progress.totalBytes && progress.totalBytes > 0) {
      return Math.min(100, Math.max(0, Math.round((progress.downloadedBytes / progress.totalBytes) * 100)));
    }
    return 0;
  }, [progress]);

  const progressText = useMemo(() => {
    if (!progress) {
      return '';
    }
    const totalText = progress.totalBytes ? formatBytes(progress.totalBytes) : t('metricUnavailable');
    return `${formatBytes(progress.downloadedBytes)} / ${totalText}`;
  }, [progress, t]);

  if (!open) {
    return null;
  }

  // 无新版本或检测失败时，展示简单结果弹窗（标题"更新"，正文提示，底部取消+打开下载页）。
  if (!showUpdateDetail) {
    const bodyText = checkError
      ? checkError
      : t('updateUpToDateDetail', { app: t('appName'), version: result?.currentVersion ?? '' });
    const fallbackUrl = releaseUrl ?? result?.releaseUrl ?? '';
    return (
      <div className="modal-backdrop">
        <div className="modal card update-result-modal">
          <div className="modal-header">
            <h3>{t('updateResultTitle')}</h3>
            <Tooltip content={t('updateCancel')}>
              <button aria-label={t('updateCancel')} className="icon-button" onClick={onClose} type="button">
                <X size={18} />
              </button>
            </Tooltip>
          </div>
          <div className="update-result-modal-body">
            <p>{bodyText}</p>
          </div>
          <div className="modal-footer">
            <div className="modal-actions">
              <button className="secondary-button" onClick={onClose} type="button">
                {t('updateCancel')}
              </button>
              {fallbackUrl ? (
                <button className="primary-button" onClick={() => onOpenRelease(fallbackUrl)} type="button">
                  <ExternalLink size={16} /> {t('openRelease')}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!result) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <div className="modal card update-modal">
        <div className="modal-header">
          <div>
            <h3>{t('updateModalTitle')}</h3>
            <p className="update-modal-version">
              {t('currentVersion')}: {result.currentVersion} → {result.latestVersion}
            </p>
          </div>
          <Tooltip content={t('updateCancel')}>
            <button aria-label={t('updateCancel')} className="icon-button" disabled={downloading} onClick={onClose} type="button">
              <X size={18} />
            </button>
          </Tooltip>
        </div>

        {error ? (
          <FloatingToast message={error} onDismiss={() => onErrorDismiss?.()} tone="error" />
        ) : null}

        <div className="update-modal-body">
          <div className="update-modal-meta">
            <span>{t('releasePublishedAt')}</span>
            <strong>{result.publishedAt ? new Date(result.publishedAt).toLocaleString() : t('metricUnavailable')}</strong>
            <span>{t('updateSize')}</span>
            <strong>{sizeText}</strong>
          </div>

          {/* 重新打开或切换升级目标时恢复默认折叠；下载进度变化不会重置用户展开状态。 */}
          <UpdateReleaseHistory key={`${result.currentVersion}:${result.latestVersion}`} result={result} t={t} />

        </div>

        <div className="update-modal-footer">
          {/* 下载进度属于持续状态，继续固定在底部；瞬时错误由当前更新弹窗内的悬浮提示承载。 */}
          {(downloading || progress) && (
            <div className="update-modal-footer-info">
              {downloading || progress ? (
                <div className="update-modal-progress">
                  <div className="update-modal-progress-header">
                    <span>{t('updateDownloadProgress')}</span>
                    <span>{progressText}</span>
                  </div>
                  <div className="update-modal-progress-bar">
                    <div
                      className="update-modal-progress-fill"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                  <div className="update-modal-progress-percent">{progressPercent}%</div>
                </div>
              ) : null}
            </div>
          )}

          <div className="modal-actions">
            <button className="secondary-button" disabled={downloading} onClick={onClose} type="button">
              {t('updateCancel')}
            </button>
            <button
              className="secondary-button"
              disabled={downloading}
              onClick={() => onOpenRelease(result.releaseUrl)}
              type="button"
            >
              <ExternalLink size={16} /> {t('openRelease')}
            </button>
            <button
              className="primary-button"
              disabled={downloading || !result.installerDownloadUrl || !result.installerAssetName}
              onClick={onDownload}
              type="button"
            >
              <Download size={16} />
              {downloading ? t('updateDownloading') : t('updateDownloadAndInstall')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
