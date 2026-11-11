import type { CSSProperties } from "react";
import { Download, PackageCheck, RotateCcw, Save, Trash2, Upload } from "lucide-react";

import { clamp } from "../../app/layout";
import { CustomSelect, type CustomSelectOption } from "../../CustomSelect";
import { Tooltip } from "../../components/Tooltip";
import {
  defaultTerminalCommandInputLightColor,
  normalizeTerminalCommandInputColor,
  resolveTerminalCommandInputDisplayColor,
  resolveTerminalCommandInputPresetId,
  terminalCommandInputColorPresets,
} from "../../domain/settings/commandInputColor";
import type { TranslationKey } from "../../i18n";
import type { AppSettings, DownloadProgress, FontPackStatus, UiLanguage } from "../../types";
import {
  appearanceFieldDefaults,
  terminalBackgroundFitOptions,
} from "./model";

type Props = {
  agentChatCjkOptions: CustomSelectOption[];
  agentChatLatinOptions: CustomSelectOption[];
  agentChatPreviewStyle: CSSProperties;
  cjkOptions: CustomSelectOption[];
  draftSettings: AppSettings;
  fontPackActionRunning: "download" | "import" | "remove" | "";
  fontPackError: string | null;
  fontPackProgress: DownloadProgress | null;
  fontPackStatus: FontPackStatus | null;
  hasSettingsChanges: boolean;
  latinOptions: CustomSelectOption[];
  onChooseLocalBackgroundImage: () => void | Promise<unknown>;
  onDownloadFontPack: () => void;
  onImportFontPack: () => void;
  onLoadSystemFonts: () => void;
  onRemoveFontPack: () => void;
  onSave: () => void | Promise<unknown>;
  onUpdate: (updater: (settings: AppSettings) => AppSettings) => void;
  selectedCjkFontFamily: string;
  selectedLatinFontFamily: string;
  t: (
    key: TranslationKey,
    replacements?: Record<string, string | number>,
  ) => string;
  terminalPreviewStyle: CSSProperties;
  uiCjkOptions: CustomSelectOption[];
  uiLatinOptions: CustomSelectOption[];
  uiPreviewStyle: CSSProperties;
};

// 命令输入预设色的界面名称。
const terminalCommandInputColorPresetLabels: Record<
  (typeof terminalCommandInputColorPresets)[number]["id"],
  TranslationKey
> = {
  indigo: "terminalCommandInputColorIndigo",
  teal: "terminalCommandInputColorTeal",
  rose: "terminalCommandInputColorRose",
  amber: "terminalCommandInputColorAmber",
};

const formatFontPackBytes = (value?: number) => {
  if (!value || !Number.isFinite(value)) {
    return "—";
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
};

// 外观设置是纯受控草稿视图：即时预览读取草稿，只有父级保存事务成功后才正式生效。
export function AppearanceSettingsSection({
  agentChatCjkOptions,
  agentChatLatinOptions,
  agentChatPreviewStyle,
  cjkOptions,
  draftSettings,
  fontPackActionRunning,
  fontPackError,
  fontPackProgress,
  fontPackStatus,
  hasSettingsChanges,
  latinOptions,
  onChooseLocalBackgroundImage,
  onDownloadFontPack,
  onImportFontPack,
  onLoadSystemFonts,
  onRemoveFontPack,
  onSave,
  onUpdate,
  selectedCjkFontFamily,
  selectedLatinFontFamily,
  t,
  terminalPreviewStyle,
  uiCjkOptions,
  uiLatinOptions,
  uiPreviewStyle,
}: Props) {
  // 命令输入颜色相关派生值：取色器与色值展示按草稿主题显示实际生效的颜色。
  const commandInputHighlightEnabled = draftSettings.terminalCommandInputHighlight ?? true;
  const selectedCommandInputPresetId = resolveTerminalCommandInputPresetId(
    draftSettings.terminalCommandInputColor,
  );
  const commandInputDisplayColor = resolveTerminalCommandInputDisplayColor(
    draftSettings.terminalCommandInputColor,
    draftSettings.themeMode === "dark",
  );
  const fontPackBusy = Boolean(fontPackActionRunning);
  const fontPackReady = fontPackStatus?.state === "ready";
  const fontPackStatusText = fontPackStatus?.state === "ready"
    ? t("fontPackStatusReady", { version: fontPackStatus.version })
    : fontPackStatus?.state === "invalid"
      ? t("fontPackStatusInvalid")
      : t("fontPackStatusMissing");
  const fontPackTotalBytes = fontPackProgress?.totalBytes ?? fontPackStatus?.downloadSizeBytes;
  const fontPackPercent = fontPackProgress?.percent
    ?? (fontPackProgress && fontPackTotalBytes
      ? Math.round((fontPackProgress.downloadedBytes / fontPackTotalBytes) * 100)
      : 0);

  return (
    <div className="stack gap-16 settings-appearance-pane">
      {/* 外观页按用户认知路径分块：先配置应用偏好，再调整终端视觉与交互。 */}
      <section className="settings-section-block">
        <div>
          <h3>{t("appearanceBaseTitle")}</h3>
        </div>

        <div className="form-grid">
          <div className="form-field">
            <span>{t("fieldTheme")}</span>
            <CustomSelect
              aria-label={t("fieldTheme")}
              value={draftSettings.themeMode}
              onChange={(val) =>
                onUpdate((current) => ({
                  ...current,
                  themeMode: val as "light" | "dark",
                }))
              }
              options={[
                { value: "light", label: t("light") },
                { value: "dark", label: t("dark") },
              ]}
            />
          </div>
          <div className="form-field">
            <span>{t("fieldLanguage")}</span>
            <CustomSelect
              aria-label={t("fieldLanguage")}
              value={draftSettings.uiLanguage}
              onChange={(val) =>
                onUpdate((current) => ({
                  ...current,
                  uiLanguage: val as UiLanguage,
                }))
              }
              options={[
                { value: "zh-CN", label: t("languageZhCn") },
                { value: "en-US", label: t("languageEnUs") },
              ]}
            />
          </div>
        </div>
      </section>

      <section className="settings-section-block font-pack-settings-card">
        <div className="font-pack-settings-heading">
          <div>
            <h3>{t("fontPackSettingsTitle")}</h3>
            <p className="field-hint">{t("fontPackSettingsDescription")}</p>
          </div>
          <span className={`font-pack-status-badge is-${fontPackStatus?.state ?? "missing"}`}>
            <PackageCheck size={15} />
            {fontPackStatusText}
          </span>
        </div>

        <div className="font-pack-settings-meta">
          <span>{t("fontPackInstalledSize", { size: formatFontPackBytes(fontPackStatus?.installedSizeBytes) })}</span>
          <span>{t("fontPackPromptPrivacy")}</span>
        </div>

        {fontPackActionRunning === "download" ? (
          <div className="font-pack-progress" aria-live="polite">
            <div className="font-pack-progress-copy">
              <span>{t("fontPackDownloading")}</span>
              <span>{fontPackPercent}%</span>
            </div>
            <div className="font-pack-progress-track">
              <div className="font-pack-progress-fill" style={{ width: `${Math.min(100, Math.max(0, fontPackPercent))}%` }} />
            </div>
            <span className="field-hint">
              {t("fontPackDownloadProgress", {
                downloaded: formatFontPackBytes(fontPackProgress?.downloadedBytes),
                total: formatFontPackBytes(fontPackTotalBytes),
              })}
            </span>
          </div>
        ) : null}

        {fontPackError ? <p className="font-pack-error" role="alert">{fontPackError}</p> : null}

        <div className="font-pack-settings-actions">
          <button className="secondary-button font-pack-action-button" disabled={fontPackBusy} onClick={onImportFontPack} type="button">
            <Upload size={15} /> {t("fontPackImport")}
          </button>
          {fontPackReady ? (
            /* 删除字体包作为危险操作，保留次要按钮圆角与尺寸基类，并叠加危险色状态 */
            <button className="secondary-button danger-button font-pack-action-button" disabled={fontPackBusy} onClick={onRemoveFontPack} type="button">
              <Trash2 size={15} /> {t("fontPackRemove")}
            </button>
          ) : (
            <button className="primary-button font-pack-action-button" disabled={fontPackBusy} onClick={onDownloadFontPack} type="button">
              <Download size={15} />
              {fontPackActionRunning === "download"
                ? t("fontPackDownloading")
                : fontPackStatus?.state === "invalid"
                  ? t("fontPackRepair")
                  : t("fontPackDownloadAndEnable")}
            </button>
          )}
        </div>
      </section>

      <section className="settings-section-block">
        <div>
          <h3>{t("appearanceFontTitle")}</h3>
        </div>

        <div className="form-grid">
          <div className="form-field">
            <span>{t("fieldLatinFontFamily")}</span>
            <CustomSelect
              aria-label={t("fieldLatinFontFamily")}
              emptyText={t("fontSearchEmpty")}
              value={selectedLatinFontFamily}
              onChange={(val) =>
                onUpdate((current) => ({
                  ...current,
                  shellLatinFontFamily: val,
                }))
              }
              onOpen={onLoadSystemFonts}
              options={latinOptions}
              searchable
              searchPlaceholder={t("fontSearchPlaceholder")}
            />
          </div>
          <div className="form-field">
            <span>{t("fieldCjkFontFamily")}</span>
            <CustomSelect
              aria-label={t("fieldCjkFontFamily")}
              emptyText={t("fontSearchEmpty")}
              value={selectedCjkFontFamily}
              onChange={(val) =>
                onUpdate((current) => ({ ...current, shellCjkFontFamily: val }))
              }
              onOpen={onLoadSystemFonts}
              options={cjkOptions}
              searchable
              searchPlaceholder={t("fontSearchPlaceholder")}
            />
          </div>
          <label>
            <span>{t("fieldFontSize")}</span>
            <div className="field-with-reset">
              <input
                onChange={(event) =>
                  onUpdate((current) => ({
                    ...current,
                    shellFontSize:
                      Number(event.target.value) ||
                      appearanceFieldDefaults.shellFontSize,
                  }))
                }
                onWheel={(event) => event.currentTarget.blur()}
                type="number"
                value={draftSettings.shellFontSize}
              />
              <Tooltip content={t("resetResourceSettings")} side="top">
                <button
                  aria-label={t("resetResourceSettings")}
                  className="icon-button field-reset-button"
                  disabled={
                    draftSettings.shellFontSize ===
                    appearanceFieldDefaults.shellFontSize
                  }
                  onClick={() =>
                    onUpdate((current) => ({
                      ...current,
                      shellFontSize: appearanceFieldDefaults.shellFontSize,
                    }))
                  }
                  type="button"
                >
                  <RotateCcw size={14} />
                </button>
              </Tooltip>
            </div>
          </label>
          {/* 行高是字号的倍数；xterm 对小于 1 的行高会直接抛错，下限锁死在 1。 */}
          <label>
            <span>{t("fieldLineHeight")}</span>
            <div className="field-with-reset">
              <input
                max={2.5}
                min={1}
                onChange={(event) =>
                  onUpdate((current) => ({
                    ...current,
                    shellLineHeight:
                      Number(event.target.value) ||
                      appearanceFieldDefaults.shellLineHeight,
                  }))
                }
                onWheel={(event) => event.currentTarget.blur()}
                step={0.05}
                type="number"
                value={draftSettings.shellLineHeight}
              />
              <Tooltip content={t("resetResourceSettings")} side="top">
                <button
                  aria-label={t("resetResourceSettings")}
                  className="icon-button field-reset-button"
                  disabled={
                    draftSettings.shellLineHeight ===
                    appearanceFieldDefaults.shellLineHeight
                  }
                  onClick={() =>
                    onUpdate((current) => ({
                      ...current,
                      shellLineHeight: appearanceFieldDefaults.shellLineHeight,
                    }))
                  }
                  type="button"
                >
                  <RotateCcw size={14} />
                </button>
              </Tooltip>
            </div>
          </label>
          <div
            className="font-preview-panel span-2"
            style={terminalPreviewStyle}
          >
            <span>0123456789 abcdefghABCDEFGH</span>
            <strong>{t("terminalFontPreviewText")}</strong>
          </div>
        </div>
      </section>

      <section className="settings-section-block">
        <div>
          <h3>{t("appearanceAgentChatFontTitle")}</h3>
        </div>

        <div className="form-grid">
          <div className="form-field">
            <span>{t("fieldLatinFontFamily")}</span>
            <CustomSelect
              aria-label={t("fieldLatinFontFamily")}
              emptyText={t("fontSearchEmpty")}
              value={draftSettings.agentChatLatinFontFamily ?? ""}
              onChange={(val) =>
                onUpdate((current) => ({
                  ...current,
                  agentChatLatinFontFamily: val || undefined,
                }))
              }
              onOpen={onLoadSystemFonts}
              options={[
                { value: "", label: t("agentChatFontFollowTerminal") },
                ...agentChatLatinOptions,
              ]}
              searchable
              searchPlaceholder={t("fontSearchPlaceholder")}
            />
          </div>
          <div className="form-field">
            <span>{t("fieldCjkFontFamily")}</span>
            <CustomSelect
              aria-label={t("fieldCjkFontFamily")}
              emptyText={t("fontSearchEmpty")}
              value={draftSettings.agentChatCjkFontFamily ?? ""}
              onChange={(val) =>
                onUpdate((current) => ({
                  ...current,
                  agentChatCjkFontFamily: val || undefined,
                }))
              }
              onOpen={onLoadSystemFonts}
              options={[
                { value: "", label: t("agentChatFontFollowTerminal") },
                ...agentChatCjkOptions,
              ]}
              searchable
              searchPlaceholder={t("fontSearchPlaceholder")}
            />
          </div>
          <label>
            <span>{t("fieldFontSize")}</span>
            <div className="field-with-reset">
              <input
                max={48}
                min={0}
                onChange={(event) =>
                  onUpdate((current) => ({
                    ...current,
                    agentChatFontSize: Number(event.target.value) || 0,
                  }))
                }
                onWheel={(event) => event.currentTarget.blur()}
                type="number"
                value={
                  draftSettings.agentChatFontSize ??
                  appearanceFieldDefaults.agentChatFontSize
                }
              />
              <Tooltip content={t("resetResourceSettings")} side="top">
                <button
                  aria-label={t("resetResourceSettings")}
                  className="icon-button field-reset-button"
                  disabled={
                    (draftSettings.agentChatFontSize ??
                      appearanceFieldDefaults.agentChatFontSize) ===
                    appearanceFieldDefaults.agentChatFontSize
                  }
                  onClick={() =>
                    onUpdate((current) => ({
                      ...current,
                      agentChatFontSize:
                        appearanceFieldDefaults.agentChatFontSize,
                    }))
                  }
                  type="button"
                >
                  <RotateCcw size={14} />
                </button>
              </Tooltip>
            </div>
          </label>
          {/* 对话行高与终端行高相互独立，没有“0 表示跟随”语义；预览面板实时反映基准值效果。 */}
          <label>
            <span>{t("fieldLineHeight")}</span>
            <div className="field-with-reset">
              <input
                max={2.5}
                min={1}
                onChange={(event) =>
                  onUpdate((current) => ({
                    ...current,
                    agentChatLineHeight:
                      Number(event.target.value) ||
                      appearanceFieldDefaults.agentChatLineHeight,
                  }))
                }
                onWheel={(event) => event.currentTarget.blur()}
                step={0.05}
                type="number"
                value={
                  draftSettings.agentChatLineHeight ??
                  appearanceFieldDefaults.agentChatLineHeight
                }
              />
              <Tooltip content={t("resetResourceSettings")} side="top">
                <button
                  aria-label={t("resetResourceSettings")}
                  className="icon-button field-reset-button"
                  disabled={
                    (draftSettings.agentChatLineHeight ??
                      appearanceFieldDefaults.agentChatLineHeight) ===
                    appearanceFieldDefaults.agentChatLineHeight
                  }
                  onClick={() =>
                    onUpdate((current) => ({
                      ...current,
                      agentChatLineHeight:
                        appearanceFieldDefaults.agentChatLineHeight,
                    }))
                  }
                  type="button"
                >
                  <RotateCcw size={14} />
                </button>
              </Tooltip>
            </div>
          </label>
          {/* 空字体与 0 字号都表示跟随终端设置，老配置升级后对话区观感保持不变；扩展到整行避免挤在左半列。 */}
          <p className="field-hint span-2">{t("agentChatFontSizeHint")}</p>
          <div
            className="font-preview-panel span-2"
            style={agentChatPreviewStyle}
          >
            <span>0123456789 abcdefghABCDEFGH</span>
            <strong>{t("agentChatFontPreviewText")}</strong>
          </div>
        </div>
      </section>

      <section className="settings-section-block">
        <div>
          <h3>{t("appearanceUiFontTitle")}</h3>
        </div>

        <div className="form-grid">
          <div className="form-field">
            <span>{t("fieldLatinFontFamily")}</span>
            <CustomSelect
              aria-label={t("fieldLatinFontFamily")}
              emptyText={t("fontSearchEmpty")}
              value={draftSettings.uiLatinFontFamily ?? ""}
              onChange={(val) =>
                onUpdate((current) => ({
                  ...current,
                  uiLatinFontFamily: val || undefined,
                }))
              }
              onOpen={onLoadSystemFonts}
              options={[
                { value: "", label: t("uiFontFollowTerminal") },
                ...uiLatinOptions,
              ]}
              searchable
              searchPlaceholder={t("fontSearchPlaceholder")}
            />
          </div>
          <div className="form-field">
            <span>{t("fieldCjkFontFamily")}</span>
            <CustomSelect
              aria-label={t("fieldCjkFontFamily")}
              emptyText={t("fontSearchEmpty")}
              value={draftSettings.uiCjkFontFamily ?? ""}
              onChange={(val) =>
                onUpdate((current) => ({
                  ...current,
                  uiCjkFontFamily: val || undefined,
                }))
              }
              onOpen={onLoadSystemFonts}
              options={[
                { value: "", label: t("uiFontFollowTerminal") },
                ...uiCjkOptions,
              ]}
              searchable
              searchPlaceholder={t("fontSearchPlaceholder")}
            />
          </div>
          {/* 系统字体字号固定为基准 15px，保持与 UI 排版高度和图标比例严格协调，此处仅提供中西文字体族定制 */}
          <p className="field-hint span-2">
            {t("uiFontFollowTerminalHint")}
          </p>
          <div
            className="font-preview-panel span-2"
            style={uiPreviewStyle}
          >
            {/* 系统字体预览文本：与终端和 AI 对话保持一致的示例字符 */}
            <span>0123456789 abcdefghABCDEFGH</span>
            <strong>{t("uiFontPreviewText")}</strong>
          </div>
        </div>
      </section>

      <section className="settings-section-block">
        <div>
          <h3>{t("appearanceBackgroundTitle")}</h3>
        </div>

        <div className="form-grid">
          <label className="span-2">
            <span>{t("fieldTerminalBackgroundImage")}</span>
            <div className="background-image-field">
              <input
                placeholder="C:\\Pictures\\terminal.png 或 https://example.com/bg.png"
                value={draftSettings.backgroundImage ?? ""}
                onChange={(event) =>
                  onUpdate((current) => ({
                    ...current,
                    backgroundImage: event.target.value,
                  }))
                }
              />
              <button
                className="secondary-button slim"
                onClick={() => void onChooseLocalBackgroundImage()}
                type="button"
              >
                <Upload size={14} /> {t("chooseLocalImage")}
              </button>
            </div>
          </label>
          <label>
            <span>{t("fieldTerminalBackgroundImageOpacity")}</span>
            <div className="opacity-control">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={draftSettings.terminalBackgroundImageOpacity ?? 0.18}
                onChange={(event) =>
                  onUpdate((current) => ({
                    ...current,
                    terminalBackgroundImageOpacity: Number(event.target.value),
                  }))
                }
              />
              <input
                aria-label={t("fieldTerminalBackgroundImageOpacity")}
                type="number"
                min={0}
                max={100}
                step={1}
                value={Math.round(
                  (draftSettings.terminalBackgroundImageOpacity ?? 0.18) * 100,
                )}
                onChange={(event) =>
                  onUpdate((current) => ({
                    ...current,
                    terminalBackgroundImageOpacity:
                      clamp(Number(event.target.value) || 0, 0, 100) / 100,
                  }))
                }
                onWheel={(event) => event.currentTarget.blur()}
              />
            </div>
          </label>
          <div className="form-field">
            <span>{t("fieldTerminalBackgroundImageFit")}</span>
            <CustomSelect
              aria-label={t("fieldTerminalBackgroundImageFit")}
              value={draftSettings.terminalBackgroundImageFit ?? "cover"}
              onChange={(val) =>
                onUpdate((current) => ({
                  ...current,
                  terminalBackgroundImageFit: val as NonNullable<
                    AppSettings["terminalBackgroundImageFit"]
                  >,
                }))
              }
              options={terminalBackgroundFitOptions.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              }))}
            />
          </div>
        </div>
      </section>

      <section className="settings-section-block">
        <div>
          <h3>{t("appearanceBehaviorTitle")}</h3>
        </div>

        <div className="form-grid settings-single-column-grid settings-compact-form-grid">
          <div className="form-field">
            <span>{t("fieldTerminalRightClickBehavior")}</span>
            <CustomSelect
              aria-label={t("fieldTerminalRightClickBehavior")}
              value={draftSettings.terminalRightClickBehavior}
              onChange={(val) =>
                onUpdate((current) => ({
                  ...current,
                  terminalRightClickBehavior:
                    val as AppSettings["terminalRightClickBehavior"],
                }))
              }
              options={[
                { value: "paste", label: t("rightClickPaste") },
                { value: "menu", label: t("rightClickMenu") },
              ]}
            />
          </div>
          <div className="form-field">
            <span>{t("fieldTerminalLineWrapMode")}</span>
            <CustomSelect
              aria-label={t("fieldTerminalLineWrapMode")}
              value={draftSettings.terminalLineWrapMode ?? "wrap"}
              onChange={(val) =>
                onUpdate((current) => ({
                  ...current,
                  terminalLineWrapMode:
                    val as AppSettings["terminalLineWrapMode"],
                }))
              }
              options={[
                { value: "wrap", label: t("terminalLineWrapModeWrap") },
                {
                  value: "horizontal",
                  label: t("terminalLineWrapModeHorizontal"),
                },
              ]}
            />
          </div>
          <div className="agent-toggle-field settings-toggle-row settings-inline-toggle settings-centered-toggle">
            <span id="terminal-match-selection-label">
              {t("fieldTerminalMatchSelection")}
            </span>
            <div className="settings-inline-toggle-control">
              <input
                aria-label={t("fieldTerminalMatchSelection")}
                checked={draftSettings.terminalMatchSelection ?? true}
                type="checkbox"
                onChange={(event) =>
                  onUpdate((current) => ({
                    ...current,
                    terminalMatchSelection: event.target.checked,
                  }))
                }
              />
              <strong>
                {(draftSettings.terminalMatchSelection ?? true)
                  ? t("enabled")
                  : t("disabled")}
              </strong>
            </div>
          </div>
          {/* 命令输入区分：命令文字着色 + 行号栏/左侧侧标，默认开启。 */}
          <div className="agent-toggle-field settings-toggle-row settings-inline-toggle settings-centered-toggle">
            <Tooltip content={t("terminalCommandInputHighlightHint")} side="top">
              <span id="terminal-command-input-highlight-label">
                {t("fieldTerminalCommandInputHighlight")}
              </span>
            </Tooltip>
            <div className="settings-inline-toggle-control">
              <input
                aria-label={t("fieldTerminalCommandInputHighlight")}
                checked={draftSettings.terminalCommandInputHighlight ?? true}
                type="checkbox"
                onChange={(event) =>
                  onUpdate((current) => ({
                    ...current,
                    terminalCommandInputHighlight: event.target.checked,
                  }))
                }
              />
              <strong>
                {(draftSettings.terminalCommandInputHighlight ?? true)
                  ? t("enabled")
                  : t("disabled")}
              </strong>
            </div>
          </div>
          {/* 命令输入颜色：预设色随深浅主题换配套取值，取色器用于自定义；总开关关闭时整行禁用。 */}
          <div className="settings-command-input-color-row">
            <Tooltip content={t("terminalCommandInputColorHint")} side="top">
              <span id="terminal-command-input-color-label">
                {t("fieldTerminalCommandInputColor")}
              </span>
            </Tooltip>
            <div
              aria-labelledby="terminal-command-input-color-label"
              className="settings-command-input-color-control"
              role="group"
            >
              {terminalCommandInputColorPresets.map((preset) => {
                const isSelected = selectedCommandInputPresetId === preset.id;
                const swatchColor = draftSettings.themeMode === "dark" ? preset.dark : preset.light;
                return (
                  <Tooltip
                    content={t(terminalCommandInputColorPresetLabels[preset.id])}
                    key={preset.id}
                    side="top"
                  >
                    <button
                      aria-label={t(terminalCommandInputColorPresetLabels[preset.id])}
                      aria-pressed={isSelected}
                      className={`settings-color-swatch${isSelected ? " is-selected" : ""}`}
                      disabled={!commandInputHighlightEnabled}
                      onClick={() =>
                        onUpdate((current) => ({
                          ...current,
                          terminalCommandInputColor: preset.light,
                        }))
                      }
                      style={{ background: swatchColor }}
                      type="button"
                    />
                  </Tooltip>
                );
              })}
              <Tooltip content={t("terminalCommandInputColorCustom")} side="top">
                <label
                  className={`settings-color-picker${selectedCommandInputPresetId ? "" : " is-selected"}`}
                >
                  <input
                    aria-label={t("terminalCommandInputColorCustom")}
                    disabled={!commandInputHighlightEnabled}
                    onChange={(event) =>
                      onUpdate((current) => ({
                        ...current,
                        terminalCommandInputColor: normalizeTerminalCommandInputColor(event.target.value),
                      }))
                    }
                    type="color"
                    value={commandInputDisplayColor}
                  />
                </label>
              </Tooltip>
              <code className="settings-color-value">{commandInputDisplayColor}</code>
              <button
                className="secondary-button settings-color-reset"
                disabled={
                  !commandInputHighlightEnabled
                  || selectedCommandInputPresetId === "indigo"
                }
                onClick={() =>
                  onUpdate((current) => ({
                    ...current,
                    terminalCommandInputColor: defaultTerminalCommandInputLightColor,
                  }))
                }
                type="button"
              >
                {t("terminalCommandInputColorReset")}
              </button>
            </div>
          </div>
          <div className="agent-toggle-field settings-toggle-row settings-inline-toggle settings-centered-toggle">
            <Tooltip content={t("terminalCommandInputBoldHint")} side="top">
              <span id="terminal-command-input-bold-label">
                {t("fieldTerminalCommandInputBold")}
              </span>
            </Tooltip>
            <div className="settings-inline-toggle-control">
              <input
                aria-label={t("fieldTerminalCommandInputBold")}
                checked={draftSettings.terminalCommandInputBold ?? true}
                disabled={!commandInputHighlightEnabled}
                type="checkbox"
                onChange={(event) =>
                  onUpdate((current) => ({
                    ...current,
                    terminalCommandInputBold: event.target.checked,
                  }))
                }
              />
              <strong>
                {(draftSettings.terminalCommandInputBold ?? true)
                  ? t("enabled")
                  : t("disabled")}
              </strong>
            </div>
          </div>
        </div>
      </section>

      <div className="modal-actions">
        <button
          className="primary-button"
          disabled={!hasSettingsChanges}
          onClick={() => void onSave()}
          type="button"
        >
          <Save size={16} /> {t("saveAppearance")}
        </button>
      </div>
    </div>
  );
}
