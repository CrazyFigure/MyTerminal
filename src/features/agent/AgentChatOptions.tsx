import { CustomSelect } from "../../CustomSelect";
import type { TranslationKey } from "../../i18n";
import type { AgentEffort, AgentProvider, AgentRunOptions } from "../../types";

type Props = {
  activeProvider?: AgentProvider;
  modelId: string;
  onUpdate: (updater: (current: AgentRunOptions) => AgentRunOptions) => void;
  runOptions: AgentRunOptions;
  t: (
    key: TranslationKey,
    replacements?: Record<string, string | number>,
  ) => string;
};

// 运行选项是受控视图；推理强度与自动压缩阈值只更新当前对话草稿，不直接触发远程调用。
export function AgentChatOptions({
  activeProvider,
  modelId,
  onUpdate,
  runOptions,
  t,
}: Props) {
  return (
    <div className="agent-chat-options">
      <label>
        <span>{t("agentChatEffort")}</span>
        <CustomSelect
          aria-label={t("agentChatEffort")}
          onChange={(value) =>
            onUpdate((current) => ({
              ...current,
              effort: value as AgentEffort,
            }))
          }
          options={[
            { value: "default", label: t("agentChatEffortDefault") },
            { value: "low", label: "low" },
            { value: "medium", label: "medium" },
            { value: "high", label: "high" },
            { value: "xhigh", label: "xhigh" },
            { value: "max", label: "max" },
          ]}
          value={runOptions.effort}
        />
      </label>
      <label className="agent-chat-option-inline">
        <input
          checked={runOptions.autoCompact}
          onChange={(event) =>
            onUpdate((current) => ({
              ...current,
              autoCompact: event.target.checked,
            }))
          }
          type="checkbox"
        />
        <span title={t("agentChatAutoCompactDesc")}>
          {t("agentChatAutoCompact")}
        </span>
      </label>
      {runOptions.autoCompact ? (
        <label>
          <span>
            {t("agentChatCompactThreshold")}（
            {Math.round(runOptions.compactThreshold * 100)}%）
          </span>
          {/* 1% 步进：阈值对压缩时机影响敏感，粗调容易一次跨过头。 */}
          <input
            max={95}
            min={30}
            onChange={(event) =>
              onUpdate((current) => ({
                ...current,
                compactThreshold: Number(event.target.value) / 100,
              }))
            }
            step={1}
            type="range"
            value={Math.round(runOptions.compactThreshold * 100)}
          />
        </label>
      ) : null}
      <p className="agent-chat-option-hint">
        {t("agentChatContextHint", {
          window:
            activeProvider?.models.find((item) => item.id === modelId)
              ?.contextWindow ?? 0,
        })}
      </p>
    </div>
  );
}
