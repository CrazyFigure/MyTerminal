import { Eye, EyeOff, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";

import { CustomSelect } from "../../CustomSelect";
import type { TranslationKey } from "../../i18n";
import type { AgentModel, AgentProtocol, AgentProvider } from "../../types";
import { Tooltip } from "../../components/Tooltip";
import { agentProtocolUrlSpec, previewAgentRequestUrl } from "./model";

type Props = {
  hasChanges: boolean;
  onAddModel: (providerId: string) => void;
  onAddProvider: () => void;
  onOpenExecutionSettings: () => void;
  onRemoveModel: (providerId: string, modelIndex: number) => void;
  onRemoveProvider: (providerId: string) => void;
  onSave: () => void | Promise<unknown>;
  onToggleApiKey: (providerId: string) => void;
  onUpdateModel: (
    providerId: string,
    modelIndex: number,
    patch: Partial<AgentModel>,
  ) => void;
  onUpdateProvider: (providerId: string, patch: Partial<AgentProvider>) => void;
  providers: AgentProvider[];
  revealedApiKeys: Record<string, boolean>;
  t: (
    key: TranslationKey,
    replacements?: Record<string, string | number>,
  ) => string;
};

// AI 端点分区只编辑端点聚合草稿；协议地址推导和模型列表操作都收敛在此功能边界内。
export function AgentProviderSettingsSection({
  hasChanges,
  onAddModel,
  onAddProvider,
  onOpenExecutionSettings,
  onRemoveModel,
  onRemoveProvider,
  onSave,
  onToggleApiKey,
  onUpdateModel,
  onUpdateProvider,
  providers,
  revealedApiKeys,
  t,
}: Props) {
  return (
    <div className="stack gap-16">
      <section className="settings-section-block">
        <div className="section-row">
          <div>
            <h3>{t("agentProvidersTitle")}</h3>
            <p>{t("agentProvidersDesc")}</p>
          </div>
          <div className="section-row compact">
            {/* AI 助手页只提供共享执行规则的快捷入口，避免复制一份会产生状态分叉的表单。 */}
            <button
              className="secondary-button slim agent-provider-header-action"
              onClick={onOpenExecutionSettings}
              type="button"
            >
              <ShieldCheck size={14} /> {t("openExecutionSettings")}
            </button>
            <button
              className="secondary-button slim agent-provider-header-action"
              onClick={onAddProvider}
              type="button"
            >
              <Plus size={14} /> {t("agentProviderAdd")}
            </button>
          </div>
        </div>

        {providers.length ? (
          <div className="stack gap-12">
            {providers.map((provider) => (
              <div key={provider.id} className="agent-provider-card">
                <div className="section-row compact">
                  <strong>{provider.name || provider.id}</strong>
                  <Tooltip content={t("agentProviderDelete")} side="top">
                    <button
                      aria-label={t("agentProviderDelete")}
                      className="icon-button"
                      onClick={() => onRemoveProvider(provider.id)}
                      type="button"
                    >
                      <Trash2 size={14} />
                    </button>
                  </Tooltip>
                </div>
                <div className="form-grid">
                  <label>
                    <span>{t("agentProviderName")}</span>
                    <input
                      onChange={(event) =>
                        onUpdateProvider(provider.id, {
                          name: event.target.value,
                        })
                      }
                      value={provider.name}
                    />
                  </label>
                  <div className="form-field">
                    <span>{t("agentProviderProtocol")}</span>
                    <CustomSelect
                      aria-label={t("agentProviderProtocol")}
                      onChange={(value) =>
                        onUpdateProvider(provider.id, {
                          protocol: value as AgentProtocol,
                        })
                      }
                      options={[
                        { value: "anthropic", label: "Anthropic Messages" },
                        {
                          value: "openai-chat",
                          label: "OpenAI Chat Completions",
                        },
                        {
                          value: "openai-responses",
                          label: "OpenAI Responses",
                        },
                      ]}
                      value={provider.protocol}
                    />
                    {/* 大部分第三方代理是 Chat Completions 兼容，选错会直接 400，这里点明。 */}
                    <small className="agent-provider-hint">
                      {t("agentProviderProtocolHint")}
                    </small>
                  </div>
                  <label className="span-2">
                    <span>{t("agentProviderBaseUrl")}</span>
                    <input
                      onChange={(event) =>
                        onUpdateProvider(provider.id, {
                          baseUrl: event.target.value,
                        })
                      }
                      placeholder={
                        agentProtocolUrlSpec[provider.protocol].placeholder
                      }
                      value={provider.baseUrl}
                    />
                    <small className="agent-provider-hint">
                      {t("agentProviderBaseUrlHint", {
                        path: agentProtocolUrlSpec[provider.protocol].path,
                      })}
                    </small>
                    {/* 直接把最终请求地址显示出来，用户不必猜自己填的会被拼成什么。 */}
                    <small className="agent-provider-url-preview">
                      {t("agentProviderResolvedUrl")}
                      <code>
                        {previewAgentRequestUrl(
                          provider.baseUrl,
                          provider.protocol,
                        )}
                      </code>
                    </small>
                  </label>
                  <label className="span-2">
                    <span>{t("agentProviderApiKey")}</span>
                    <div className="password-field">
                      <input
                        onChange={(event) =>
                          onUpdateProvider(provider.id, {
                            apiKey: event.target.value,
                          })
                        }
                        placeholder="sk-..."
                        type={
                          revealedApiKeys[provider.id] ? "text" : "password"
                        }
                        value={provider.apiKey ?? ""}
                      />
                      <Tooltip
                        content={
                          revealedApiKeys[provider.id]
                            ? t("hideSecret")
                            : t("showSecret")
                        }
                        side="top"
                      >
                        <button
                          aria-label={
                            revealedApiKeys[provider.id]
                              ? t("hideSecret")
                              : t("showSecret")
                          }
                          className="secondary-button slim password-toggle-button"
                          onClick={() => onToggleApiKey(provider.id)}
                          type="button"
                        >
                          {revealedApiKeys[provider.id] ? (
                            <EyeOff size={16} />
                          ) : (
                            <Eye size={16} />
                          )}
                          <span>
                            {revealedApiKeys[provider.id]
                              ? t("hideSecret")
                              : t("showSecret")}
                          </span>
                        </button>
                      </Tooltip>
                    </div>
                  </label>
                  <div className="span-2">
                    <div className="agent-model-header">
                      <span>{t("agentProviderModels")}</span>
                      <button
                        className="secondary-button slim"
                        onClick={() => onAddModel(provider.id)}
                        type="button"
                      >
                        <Plus size={14} /> {t("agentProviderModelAdd")}
                      </button>
                    </div>
                    {provider.models.length > 0 ? (
                      <div className="agent-model-list">
                        <div className="agent-model-row agent-model-row-header">
                          <span>{t("agentProviderModelId")}</span>
                          <span>{t("agentProviderModelContext")}</span>
                          <span>{t("agentProviderModelMaxTokens")}</span>
                          <span />
                        </div>
                        {provider.models.map((model, modelIndex) => (
                          <div key={modelIndex} className="agent-model-row">
                            <input
                              onChange={(event) =>
                                onUpdateModel(provider.id, modelIndex, {
                                  id: event.target.value,
                                })
                              }
                              placeholder={t("agentProviderModelIdPlaceholder")}
                              spellCheck={false}
                              value={model.id}
                            />
                            <input
                              min={1}
                              onChange={(event) => {
                                const val = parseInt(event.target.value, 10);
                                if (!isNaN(val) && val > 0) {
                                  onUpdateModel(provider.id, modelIndex, {
                                    contextWindow: val,
                                  });
                                }
                              }}
                              type="number"
                              value={model.contextWindow}
                            />
                            <input
                              min={1}
                              onChange={(event) => {
                                const val = parseInt(event.target.value, 10);
                                if (!isNaN(val) && val > 0) {
                                  onUpdateModel(provider.id, modelIndex, {
                                    maxTokens: val,
                                  });
                                }
                              }}
                              type="number"
                              value={model.maxTokens}
                            />
                            <Tooltip content={t("agentProviderModelRemove")} side="top">
                              <button
                                aria-label={t("agentProviderModelRemove")}
                                className="icon-button"
                                onClick={() =>
                                  onRemoveModel(provider.id, modelIndex)
                                }
                                type="button"
                              >
                                <Trash2 size={14} />
                              </button>
                            </Tooltip>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <small className="agent-provider-hint">
                      {t("agentProviderModelsHint")}
                    </small>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">{t("agentProvidersEmpty")}</div>
        )}

        <div className="section-row compact">
          <button
            className="primary-button"
            disabled={!hasChanges}
            onClick={() => void onSave()}
            type="button"
          >
            <Save size={16} /> {t("agentProvidersSave")}
          </button>
        </div>
      </section>
    </div>
  );
}
