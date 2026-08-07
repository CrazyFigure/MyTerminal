import { Download, Eye, EyeOff, RefreshCw, Save, Upload } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import type { AppSettings } from "../../types";

type Props = {
  hasChanges: boolean;
  onDownload: () => void | Promise<unknown>;
  onExportLocal: () => void | Promise<unknown>;
  onImportLocal: (file: File) => void | Promise<unknown>;
  onSave: () => void | Promise<unknown>;
  onTestConnection: () => void | Promise<unknown>;
  onTogglePassword: () => void;
  onUpdate: (updater: (settings: AppSettings) => AppSettings) => void;
  onUpload: () => void | Promise<unknown>;
  passwordRevealed: boolean;
  passwordToggleLabel: string;
  runningAction: string;
  settings: AppSettings;
  t: (
    key: TranslationKey,
    replacements?: Record<string, string | number>,
  ) => string;
};

// 同步设置分区只呈现 WebDAV 草稿和传输意图；远程调用、备份选择及恢复后的跨域刷新由编排层处理。
export function SyncSettingsSection({
  hasChanges,
  onDownload,
  onExportLocal,
  onImportLocal,
  onSave,
  onTestConnection,
  onTogglePassword,
  onUpdate,
  onUpload,
  passwordRevealed,
  passwordToggleLabel,
  runningAction,
  settings,
  t,
}: Props) {
  return (
    <div className="stack gap-16">
      <section className="settings-section-block">
        <div className="section-row">
          <div>
            <h3>{t("webdavSaveTitle")}</h3>
          </div>
          <div className="section-row compact">
            <button
              className="secondary-button"
              disabled={Boolean(runningAction)}
              onClick={() => void onTestConnection()}
              type="button"
            >
              <RefreshCw size={16} />{" "}
              {runningAction === "test-webdav"
                ? t("working")
                : t("testWebdavConnection")}
            </button>
            <button
              className="primary-button"
              disabled={Boolean(runningAction) || !hasChanges}
              onClick={() => void onSave()}
              type="button"
            >
              <Save size={16} /> {t("saveWebdavSettings")}
            </button>
          </div>
        </div>
        <div className="form-grid">
          <label className="span-2">
            <span>{t("webdavBaseUrl")}</span>
            <input
              value={settings.webdav.baseUrl}
              onChange={(event) =>
                onUpdate((current) => ({
                  ...current,
                  webdav: { ...current.webdav, baseUrl: event.target.value },
                }))
              }
            />
          </label>
          <label>
            <span>{t("fieldUsername")}</span>
            <input
              value={settings.webdav.username}
              onChange={(event) =>
                onUpdate((current) => ({
                  ...current,
                  webdav: { ...current.webdav, username: event.target.value },
                }))
              }
            />
          </label>
          <label>
            <span>{t("fieldPassword")}</span>
            <div className="password-field">
              <input
                type={passwordRevealed ? "text" : "password"}
                value={settings.webdav.password}
                onChange={(event) =>
                  onUpdate((current) => ({
                    ...current,
                    webdav: { ...current.webdav, password: event.target.value },
                  }))
                }
              />
              <button
                aria-label={passwordToggleLabel}
                className="secondary-button slim password-toggle-button"
                onClick={onTogglePassword}
                title={passwordToggleLabel}
                type="button"
              >
                {passwordRevealed ? <EyeOff size={16} /> : <Eye size={16} />}
                <span>{passwordToggleLabel}</span>
              </button>
            </div>
          </label>
          <label className="span-2">
            <span>{t("webdavRemoteDir")}</span>
            <input
              placeholder="/myterminal"
              value={settings.webdav.remotePath}
              onChange={(event) =>
                onUpdate((current) => ({
                  ...current,
                  webdav: { ...current.webdav, remotePath: event.target.value },
                }))
              }
            />
          </label>
        </div>
      </section>

      <section className="settings-section-block">
        <div>
          <h3>{t("webdavTransferTitle")}</h3>
          <p>{t("webdavTransferDesc")}</p>
        </div>

        <div className="sync-transfer-actions">
          <button
            className="primary-button"
            disabled={Boolean(runningAction)}
            onClick={() => void onUpload()}
            type="button"
          >
            <Upload size={16} />{" "}
            {runningAction === "upload-config"
              ? t("working")
              : t("uploadConfig")}
          </button>
          <button
            className="secondary-button"
            disabled={Boolean(runningAction)}
            onClick={() => void onDownload()}
            type="button"
          >
            <Download size={16} />{" "}
            {runningAction === "download-config"
              ? t("working")
              : t("downloadConfig")}
          </button>
        </div>
      </section>

      <section className="settings-section-block">
        <div>
          <h3>{t("syncSectionLocal")}</h3>
        </div>

        <div className="sync-transfer-actions">
          <button
            className="primary-button"
            disabled={Boolean(runningAction)}
            onClick={() => void onExportLocal()}
            type="button"
          >
            <Download size={16} />{" "}
            {runningAction === "export-local"
              ? t("working")
              : t("exportLocalConfig")}
          </button>
          <label
            className={`secondary-button file-upload-button ${runningAction ? "is-disabled" : ""}`}
          >
            <Upload size={16} />{" "}
            {runningAction === "import-local"
              ? t("working")
              : t("importLocalConfig")}
            <input
              accept="application/json,.json"
              className="hidden-file-input"
              disabled={Boolean(runningAction)}
              type="file"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void onImportLocal(file);
                }
                // 允许连续选择同一个文件，浏览器仍会再次触发 change。
                event.currentTarget.value = "";
              }}
            />
          </label>
        </div>
      </section>
    </div>
  );
}
