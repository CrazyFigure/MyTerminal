import type { CSSProperties } from "react";
import { Save, Upload } from "lucide-react";

import { clamp } from "../../app/layout";
import { CustomSelect } from "../../CustomSelect";
import type { TranslationKey } from "../../i18n";
import type { AppSettings, UiLanguage } from "../../types";
import { terminalBackgroundFitOptions } from "./model";

type Props = {
  agentChatCjkOptions: string[];
  agentChatLatinOptions: string[];
  agentChatPreviewStyle: CSSProperties;
  cjkOptions: string[];
  draftSettings: AppSettings;
  hasSettingsChanges: boolean;
  latinOptions: string[];
  onChooseLocalBackgroundImage: () => void | Promise<unknown>;
  onLoadSystemFonts: () => void;
  onSave: () => void | Promise<unknown>;
  onUpdate: (updater: (settings: AppSettings) => AppSettings) => void;
  selectedCjkFontFamily: string;
  selectedLatinFontFamily: string;
  t: (
    key: TranslationKey,
    replacements?: Record<string, string | number>,
  ) => string;
  terminalPreviewStyle: CSSProperties;
};

// 外观设置是纯受控草稿视图：即时预览读取草稿，只有父级保存事务成功后才正式生效。
export function AppearanceSettingsSection({
  agentChatCjkOptions,
  agentChatLatinOptions,
  agentChatPreviewStyle,
  cjkOptions,
  draftSettings,
  hasSettingsChanges,
  latinOptions,
  onChooseLocalBackgroundImage,
  onLoadSystemFonts,
  onSave,
  onUpdate,
  selectedCjkFontFamily,
  selectedLatinFontFamily,
  t,
  terminalPreviewStyle,
}: Props) {
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
              options={latinOptions.map((fontFamily) => ({
                value: fontFamily,
                label: fontFamily,
              }))}
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
              options={cjkOptions.map((fontFamily) => ({
                value: fontFamily,
                label: fontFamily,
              }))}
              searchable
              searchPlaceholder={t("fontSearchPlaceholder")}
            />
          </div>
          <label>
            <span>{t("fieldFontSize")}</span>
            <input
              onChange={(event) =>
                onUpdate((current) => ({
                  ...current,
                  shellFontSize: Number(event.target.value) || 15,
                }))
              }
              onWheel={(event) => event.currentTarget.blur()}
              type="number"
              value={draftSettings.shellFontSize}
            />
          </label>
          <div
            className="font-preview-panel span-2"
            style={terminalPreviewStyle}
          >
            <span>0123456789 abcdefghABCDEFGH</span>
            <strong>终端中文字体预览</strong>
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
                ...agentChatLatinOptions.map((fontFamily) => ({
                  value: fontFamily,
                  label: fontFamily,
                })),
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
                ...agentChatCjkOptions.map((fontFamily) => ({
                  value: fontFamily,
                  label: fontFamily,
                })),
              ]}
              searchable
              searchPlaceholder={t("fontSearchPlaceholder")}
            />
          </div>
          <label>
            <span>{t("fieldFontSize")}</span>
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
              value={draftSettings.agentChatFontSize ?? 0}
            />
          </label>
          {/* 空字体与 0 字号都表示跟随终端设置，老配置升级后对话区观感保持不变。 */}
          <p className="field-hint">{t("agentChatFontSizeHint")}</p>
          <div
            className="font-preview-panel span-2"
            style={agentChatPreviewStyle}
          >
            <span>0123456789 abcdefghABCDEFGH</span>
            <strong>AI 对话字体预览</strong>
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
          <div className="agent-toggle-field settings-toggle-row settings-inline-toggle settings-centered-toggle">
            <span id="hardware-acceleration-label">
              {t("fieldHardwareAcceleration")}
            </span>
            <div className="settings-inline-toggle-control">
              <input
                aria-label={t("fieldHardwareAcceleration")}
                checked={draftSettings.hardwareAcceleration ?? true}
                type="checkbox"
                onChange={(event) =>
                  onUpdate((current) => ({
                    ...current,
                    hardwareAcceleration: event.target.checked,
                  }))
                }
              />
              <strong>
                {(draftSettings.hardwareAcceleration ?? true)
                  ? t("hardwareAccelerationEnabled")
                  : t("hardwareAccelerationDisabled")}
              </strong>
            </div>
          </div>
          {/* 渲染模式在 WebView2 创建前决定；提示用户重启生效，并明确软件渲染不保证更省内存。 */}
          <p className="field-hint">{t("hardwareAccelerationHint")}</p>
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
