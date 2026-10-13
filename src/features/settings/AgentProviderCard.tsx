import type { KeyboardEvent, PointerEvent } from "react";
import {
  ChevronRight,
  Eye,
  EyeOff,
  GripVertical,
  KeyRound,
  Plus,
  Trash2,
} from "lucide-react";

import { CustomSelect } from "../../CustomSelect";
import type { TranslationKey } from "../../i18n";
import type {
  AgentAuthStyle,
  AgentModel,
  AgentProtocol,
  AgentProvider,
} from "../../types";
import { Tooltip } from "../../components/Tooltip";
import { agentProtocolUrlSpec, previewAgentRequestUrl } from "./model";

const protocolLabels: Record<AgentProtocol, string> = {
  anthropic: "Anthropic Messages",
  "openai-chat": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
};

type Props = {
  expanded: boolean;
  /** 拖拽排序中的视觉状态：被拖动的卡片半透明，插入位置画一条强调色指示线。 */
  dragState: "" | "dragging" | "drop-before" | "drop-after";
  onAddModel: () => void;
  onMoveByKeyboard: (offset: -1 | 1) => void;
  onRemove: () => void;
  onRemoveModel: (modelIndex: number) => void;
  onStartDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  onToggleApiKey: () => void;
  onToggleExpanded: () => void;
  onUpdate: (patch: Partial<AgentProvider>) => void;
  onUpdateModel: (modelIndex: number, patch: Partial<AgentModel>) => void;
  provider: AgentProvider;
  revealApiKey: boolean;
  t: (
    key: TranslationKey,
    replacements?: Record<string, string | number>,
  ) => string;
};

// 单个端点卡片：折叠态只展示辨识信息，展开后才是完整表单；拖拽排序只从左侧抓手发起，避免误触表单。
export function AgentProviderCard({
  expanded,
  dragState,
  onAddModel,
  onMoveByKeyboard,
  onRemove,
  onRemoveModel,
  onStartDrag,
  onToggleApiKey,
  onToggleExpanded,
  onUpdate,
  onUpdateModel,
  provider,
  revealApiKey,
  t,
}: Props) {
  const title = provider.name || t("agentProviderUnnamed");
  const hasKey = Boolean(provider.apiKey?.trim());

  // 抓手支持方向键微调顺序，键盘用户不必依赖拖拽。
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      onMoveByKeyboard(event.key === "ArrowUp" ? -1 : 1);
    }
  };

  return (
    <div
      className={`agent-provider-card ${expanded ? "is-expanded" : ""} ${dragState ? `is-${dragState}` : ""}`}
      data-provider-id={provider.id}
    >
      <div className="agent-provider-card-header">
        <Tooltip content={t("agentProviderDragHint")} side="top">
          <button
            aria-label={t("agentProviderDragHint")}
            className="drag-handle agent-provider-drag"
            onKeyDown={handleKeyDown}
            onPointerDown={onStartDrag}
            type="button"
          >
            <GripVertical size={15} />
          </button>
        </Tooltip>
        <button
          aria-expanded={expanded}
          className="agent-provider-card-summary"
          onClick={onToggleExpanded}
          type="button"
        >
          <ChevronRight className="agent-provider-card-chevron" size={15} />
          <span className="agent-provider-card-title">
            <strong>{title}</strong>
            <small>{previewAgentRequestUrl(provider.baseUrl, provider.protocol)}</small>
          </span>
          <span className="agent-provider-card-meta">
            <span className="agent-provider-badge">{protocolLabels[provider.protocol]}</span>
            <span className="agent-provider-badge">
              {t("agentProviderModelCount", { count: provider.models.length })}
            </span>
            <span className={`agent-provider-key-state ${hasKey ? "is-ready" : "is-missing"}`}>
              <KeyRound size={12} />
              {hasKey ? t("agentProviderKeyReady") : t("agentProviderKeyMissing")}
            </span>
          </span>
        </button>
        <Tooltip content={t("agentProviderDelete")} side="top">
          <button
            aria-label={t("agentProviderDelete")}
            className="icon-button agent-provider-delete"
            onClick={onRemove}
            type="button"
          >
            <Trash2 size={14} />
          </button>
        </Tooltip>
      </div>

      {expanded ? (
        <div className="form-grid agent-provider-card-body">
          <label>
            <span>{t("agentProviderName")}</span>
            <input
              onChange={(event) => onUpdate({ name: event.target.value })}
              value={provider.name}
            />
          </label>
          <div className="form-field">
            <span>{t("agentProviderProtocol")}</span>
            <CustomSelect
              aria-label={t("agentProviderProtocol")}
              onChange={(value) => onUpdate({ protocol: value as AgentProtocol })}
              options={[
                { value: "anthropic", label: protocolLabels.anthropic },
                { value: "openai-chat", label: protocolLabels["openai-chat"] },
                { value: "openai-responses", label: protocolLabels["openai-responses"] },
              ]}
              value={provider.protocol}
            />
            {/* 大部分第三方代理是 Chat Completions 兼容，选错会直接 400，这里点明。 */}
            <small className="agent-provider-hint">{t("agentProviderProtocolHint")}</small>
          </div>
          <label className="span-2">
            <span>{t("agentProviderBaseUrl")}</span>
            <input
              onChange={(event) => onUpdate({ baseUrl: event.target.value })}
              placeholder={agentProtocolUrlSpec[provider.protocol].placeholder}
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
              <code>{previewAgentRequestUrl(provider.baseUrl, provider.protocol)}</code>
            </small>
          </label>
          <label className={provider.protocol === "anthropic" ? "" : "span-2"}>
            <span>{t("agentProviderApiKey")}</span>
            <div className="password-field">
              <input
                onChange={(event) => onUpdate({ apiKey: event.target.value })}
                placeholder="sk-..."
                type={revealApiKey ? "text" : "password"}
                value={provider.apiKey ?? ""}
              />
              <Tooltip content={revealApiKey ? t("hideSecret") : t("showSecret")} side="top">
                <button
                  aria-label={revealApiKey ? t("hideSecret") : t("showSecret")}
                  className="secondary-button slim password-toggle-button"
                  onClick={onToggleApiKey}
                  type="button"
                >
                  {revealApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  <span>{revealApiKey ? t("hideSecret") : t("showSecret")}</span>
                </button>
              </Tooltip>
            </div>
          </label>
          {/* Anthropic 官方用 x-api-key，多数中转与 ANTHROPIC_AUTH_TOKEN 只认 Bearer；其它协议固定 Bearer，不显示该项。 */}
          {provider.protocol === "anthropic" ? (
            <div className="form-field">
              <span>{t("agentProviderAuthStyle")}</span>
              <CustomSelect
                aria-label={t("agentProviderAuthStyle")}
                onChange={(value) => onUpdate({ authStyle: value as AgentAuthStyle })}
                options={[
                  { value: "", label: t("agentProviderAuthAuto") },
                  { value: "x-api-key", label: t("agentProviderAuthApiKey") },
                  { value: "bearer", label: t("agentProviderAuthBearer") },
                ]}
                value={provider.authStyle ?? ""}
              />
            </div>
          ) : null}
          <div className="span-2">
            <div className="agent-model-header">
              <span>{t("agentProviderModels")}</span>
              <button className="secondary-button slim" onClick={onAddModel} type="button">
                <Plus size={14} /> {t("agentProviderModelAdd")}
              </button>
            </div>
            {provider.models.length > 0 ? (
              <div className="agent-model-list">
                <div className="agent-model-row agent-model-row-header">
                  <span>{t("agentProviderModelId")}</span>
                  <span>{t("agentProviderModelContext")}</span>
                  <span>{t("agentProviderModelMaxTokens")}</span>
                  <Tooltip
                    content={
                      <span className="agent-model-multimodal-tooltip">
                        {t("agentProviderModelMultimodalDesc")}
                      </span>
                    }
                    side="top"
                  >
                    <span className="agent-model-multimodal-header">
                      {t("agentProviderModelMultimodal")}
                    </span>
                  </Tooltip>
                  <span />
                </div>
                {provider.models.map((model, modelIndex) => (
                  <div key={modelIndex} className="agent-model-row">
                    <input
                      onChange={(event) => onUpdateModel(modelIndex, { id: event.target.value })}
                      placeholder={t("agentProviderModelIdPlaceholder")}
                      spellCheck={false}
                      value={model.id}
                    />
                    <input
                      min={1}
                      onChange={(event) => {
                        const value = parseInt(event.target.value, 10);
                        if (!isNaN(value) && value > 0) {
                          onUpdateModel(modelIndex, { contextWindow: value });
                        }
                      }}
                      onWheel={(event) => event.currentTarget.blur()}
                      type="number"
                      value={model.contextWindow}
                    />
                    <input
                      min={1}
                      onChange={(event) => {
                        const value = parseInt(event.target.value, 10);
                        if (!isNaN(value) && value > 0) {
                          onUpdateModel(modelIndex, { maxTokens: value });
                        }
                      }}
                      onWheel={(event) => event.currentTarget.blur()}
                      type="number"
                      value={model.maxTokens}
                    />
                    {/* 多模态是模型能力声明：勾选后对话框才允许附带图片，纯文本模型保持不勾选可避免请求被拒。 */}
                    <label className="agent-model-check">
                      <input
                        aria-label={t("agentProviderModelMultimodal")}
                        checked={Boolean(model.multimodal)}
                        onChange={(event) =>
                          onUpdateModel(modelIndex, { multimodal: event.target.checked })
                        }
                        type="checkbox"
                      />
                    </label>
                    <Tooltip content={t("agentProviderModelRemove")} side="top">
                      <button
                        aria-label={t("agentProviderModelRemove")}
                        className="icon-button"
                        onClick={() => onRemoveModel(modelIndex)}
                        type="button"
                      >
                        <Trash2 size={14} />
                      </button>
                    </Tooltip>
                  </div>
                ))}
              </div>
            ) : null}
            <small className="agent-provider-hint">{t("agentProviderModelsHint")}</small>
          </div>
        </div>
      ) : null}
    </div>
  );
}
