/* 设置功能域内部模块；只暴露稳定的数据规则或独立视图。 */
import { useMemo, useState } from 'react';
import { Download, Trash2, X } from 'lucide-react';
import type { TranslationKey } from '../../i18n';

/* ── Backup Selector Modal ─────────────────────────────────────────────── */

export interface BackupItem {
  filename: string;
  timestamp: string;
  type: 'bundle' | 'settings' | 'connections';
}





export function BackupSelectorModal({
  open,
  backups,
  onSelect,
  onDelete,
  onClose,
  t,
}: {
  open: boolean;
  backups: string[];
  onSelect: (filename: string) => void;
  onDelete: (filename: string) => void;
  onClose: () => void;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
}) {
  const [deleting, setDeleting] = useState<string | null>(null);

  const parsed = useMemo<BackupItem[]>(() => {
    const items = backups.map((filename) => {
      let type: BackupItem['type'] = 'bundle';
      if (filename.startsWith('settings')) type = 'settings';
      else if (filename.startsWith('connections')) type = 'connections';

      // 从文件名提取时间戳: myterminal-config-20260611-160128.enc.json
      const match = filename.match(/(\d{8})-(\d{6})/);
      let timestamp = '-';
      let sortKey = '';
      if (match) {
        const [, date, time] = match;
        timestamp = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)} ${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4)}`;
        sortKey = date + time;
      }

      return { filename, timestamp, type, sortKey };
    });
    // 按时间戳倒序排列（最新的在前面）
    return items.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
  }, [backups]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card modal modal-backup-selector">
        <div className="modal-header">
          <h3>{t('selectBackupVersion')}</h3>
          <button className="icon-button" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </div>
        <div className="backup-table-shell">
          <div className="backup-table-header">
            <span className="backup-col-name">{t('fieldFilename')}</span>
            <span className="backup-col-time">{t('fieldTimestamp')}</span>
            <span className="backup-col-type">{t('backupType')}</span>
            <span className="backup-col-actions">{t('backupActions')}</span>
          </div>
          <div className="backup-table-body">
            {parsed.length === 0 ? (
              <div className="backup-empty">{t('noBackupsFound')}</div>
            ) : (
              parsed.map((item) => (
                <div key={item.filename} className="backup-table-row">
                  <span className="backup-col-name" title={item.filename}>{item.filename}</span>
                  <span className="backup-col-time">{item.timestamp}</span>
                  <span className="backup-col-type">
                    {item.type === 'bundle' ? t('typeBundle') : item.type === 'settings' ? t('typeSettings') : t('typeConnections')}
                  </span>
                  <div className="backup-col-actions">
                    <button
                      className="ghost-button slim backup-download-btn"
                      onClick={() => onSelect(item.filename)}
                      type="button"
                    >
                      <Download size={14} /> {t('actionDownload')}
                    </button>
                    <button
                      className="ghost-button slim danger-button"
                      disabled={deleting === item.filename}
                      onClick={() => {
                        setDeleting(item.filename);
                        onDelete(item.filename);
                      }}
                      type="button"
                    >
                      <Trash2 size={14} /> {t('actionDelete')}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose} type="button">
            {t('actionCancel')}
          </button>
        </div>
      </div>
    </div>
  );
}
