import { Copy } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import type { AgentBridgeStatus } from "../../types";
import { buildAgentMcpConfig } from "./model";

type ActionFeedback = {
  kind: "is-success" | "is-error";
  message: string;
};

type Props = {
  copyFeedback?: ActionFeedback;
  enabled: boolean;
  onCopyConfig: () => void | Promise<unknown>;
  onEnabledChange: (enabled: boolean) => void | Promise<unknown>;
  status: AgentBridgeStatus | null;
  switchBusy: boolean;
  switchLabel: string;
  t: (
    key: TranslationKey,
    replacements?: Record<string, string | number>,
  ) => string;
};

// Agent Bridge 分区聚合运行状态、启停意图与接入配置，状态切换事务仍由弹窗编排层负责。
export function AgentBridgeSettingsSection({
  copyFeedback,
  enabled,
  onCopyConfig,
  onEnabledChange,
  status,
  switchBusy,
  switchLabel,
  t,
}: Props) {
  return (
    <div className="stack gap-16 settings-mcp-pane">
      <section
        className={`settings-section-block agent-bridge-control ${switchBusy ? "is-pending" : ""}`}
      >
        <div className="agent-bridge-control-main">
          <div>
            <h3>{t("agentBridgeTitle")}</h3>
          </div>
        </div>
        <div
          className={`agent-toggle-field agent-bridge-power ${switchBusy ? "is-pending" : ""}`}
        >
          <span>{t("fieldAgentBridgeEnabled")}</span>
          <input
            aria-label={t("fieldAgentBridgeEnabled")}
            checked={enabled}
            disabled={switchBusy}
            type="checkbox"
            onChange={(event) => void onEnabledChange(event.target.checked)}
          />
          <strong>{switchLabel}</strong>
        </div>

        <div className="settings-about-grid agent-bridge-status-grid">
          <span>{t("agentBridgeRunState")}</span>
          <strong>
            {status?.running
              ? t("statusRunningLabel")
              : t("statusStoppedLabel")}
          </strong>
          <span>{t("agentBridgePort")}</span>
          <strong>{status?.port ?? t("metricUnavailable")}</strong>
          <span>{t("agentBridgeDiscoveryPath")}</span>
          <strong>{status?.discoveryPath ?? t("metricUnavailable")}</strong>
        </div>
      </section>

      <section className="settings-section-block">
        <div className="section-row">
          <div>
            <h3>{t("agentBridgeUsageTitle")}</h3>
            <p>{t("agentBridgeUsageDesc")}</p>
          </div>
          <button
            className="secondary-button"
            onClick={() => void onCopyConfig()}
            type="button"
          >
            <Copy size={16} /> {t("copyAgentBridgeConfig")}
          </button>
        </div>
        {copyFeedback ? (
          <div className={`sync-action-feedback ${copyFeedback.kind}`}>
            {copyFeedback.message}
          </div>
        ) : null}
        <div className="agent-bridge-code-grid">
          <label className="span-2">
            <span>{t("agentBridgeMcpConfig")}</span>
            {/* MCP 配置通常包含多行环境变量与启动参数，增加默认高度以减少查看时滚动。 */}
            <textarea
              readOnly
              rows={15}
              spellCheck={false}
              value={buildAgentMcpConfig(status)}
            />
          </label>
        </div>
      </section>
    </div>
  );
}
