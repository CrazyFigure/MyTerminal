import type { TranslationKey } from "../../i18n";
import type { AgentRunOptions } from "../../types";
import { AgentEffortSlider } from "./AgentEffortSlider";

type Props = {
  onUpdate: (updater: (current: AgentRunOptions) => AgentRunOptions) => void;
  runOptions: AgentRunOptions;
  t: (
    key: TranslationKey,
    replacements?: Record<string, string | number>,
  ) => string;
};

// 运行选项是受控视图；推理强度只更新当前对话草稿，不直接触发远程调用。
// 自动压缩属于全局设置，统一在“设置 → AI 助手”中调整，这里不再重复展示。
export function AgentChatOptions({ onUpdate, runOptions, t }: Props) {
  return (
    <div className="agent-chat-options">
      <span className="agent-chat-options-title">{t("agentChatEffort")}</span>
      <AgentEffortSlider
        ariaLabel={t("agentChatEffort")}
        defaultLabel={t("agentChatEffortDefault")}
        onChange={(effort) => onUpdate((current) => ({ ...current, effort }))}
        value={runOptions.effort}
      />
    </div>
  );
}
