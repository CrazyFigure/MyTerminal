import { Save } from "lucide-react";

import type { ConnectionGroupNode } from "../../app/connectionGroups";
import type { TranslationKey } from "../../i18n";
import type { AppSettings, ConnectionProfile } from "../../types";
import { AgentAutoConnectionTree } from "./AgentAutoConnectionTree";

type Props = {
  actionRunning: boolean;
  bridgeSwitchBusy: boolean;
  connections: ConnectionProfile[];
  draftSettings: AppSettings;
  groups: ConnectionGroupNode[];
  hasChanges: boolean;
  onSave: () => void | Promise<unknown>;
  onToggleConnection: (connectionId: string, checked: boolean) => void;
  onUpdate: (updater: (settings: AppSettings) => AppSettings) => void;
  saving: boolean;
  t: (
    key: TranslationKey,
    replacements?: Record<string, string | number>,
  ) => string;
  ungroupedConnections: ConnectionProfile[];
};

// 执行设置围绕 AgentBridge 策略聚合草稿，连接白名单仅在关闭全局自动执行时参与展示和判定。
export function ExecutionSettingsSection({
  actionRunning,
  bridgeSwitchBusy,
  connections,
  draftSettings,
  groups,
  hasChanges,
  onSave,
  onToggleConnection,
  onUpdate,
  saving,
  t,
  ungroupedConnections,
}: Props) {
  return (
    <div className="stack gap-16 settings-execution-pane">
      <section className="settings-section-block">
        <div className="section-row">
          <div>
            <h3>{t("executionSettingsTitle")}</h3>
            <p>{t("executionSettingsDesc")}</p>
          </div>
          <button
            className="primary-button"
            disabled={actionRunning || bridgeSwitchBusy || !hasChanges}
            onClick={() => void onSave()}
            type="button"
          >
            <Save size={16} />{" "}
            {saving ? t("working") : t("saveExecutionSettings")}
          </button>
        </div>
        <div className="form-grid settings-single-column-grid">
          <div className="agent-toggle-field settings-inline-toggle">
            <span>{t("fieldAgentBridgeAutoExecute")}</span>
            <div className="settings-inline-toggle-control">
              <input
                aria-label={t("fieldAgentBridgeAutoExecute")}
                checked={draftSettings.agentBridge.autoExecute}
                type="checkbox"
                onChange={(event) =>
                  onUpdate((current) => ({
                    ...current,
                    agentBridge: {
                      ...current.agentBridge,
                      autoExecute: event.target.checked,
                    },
                  }))
                }
              />
              <strong>
                {draftSettings.agentBridge.autoExecute
                  ? t("enabled")
                  : t("disabled")}
              </strong>
            </div>
          </div>
          <div className="agent-toggle-field settings-inline-toggle">
            <span title={t("fieldAgentBridgeVisibleExecutionDesc")}>
              {t("fieldAgentBridgeVisibleExecution")}
            </span>
            <div className="settings-inline-toggle-control">
              <input
                aria-label={t("fieldAgentBridgeVisibleExecution")}
                checked={draftSettings.agentBridge.visibleExecution}
                type="checkbox"
                onChange={(event) =>
                  onUpdate((current) => ({
                    ...current,
                    agentBridge: {
                      ...current.agentBridge,
                      visibleExecution: event.target.checked,
                    },
                  }))
                }
              />
              <strong>
                {draftSettings.agentBridge.visibleExecution
                  ? t("enabled")
                  : t("disabled")}
              </strong>
            </div>
          </div>
          <label>
            <span>{t("fieldAgentBridgeTimeout")}</span>
            <input
              min={1}
              max={3600}
              type="number"
              value={draftSettings.agentBridge.defaultTimeoutSec}
              onChange={(event) =>
                onUpdate((current) => ({
                  ...current,
                  agentBridge: {
                    ...current.agentBridge,
                    defaultTimeoutSec: Number(event.target.value) || 60,
                  },
                }))
              }
              onWheel={(event) => event.currentTarget.blur()}
            />
          </label>
          <label>
            <span>{t("fieldAgentBridgeMaxOutput")}</span>
            <input
              min={1024}
              type="number"
              value={draftSettings.agentBridge.maxOutputBytes}
              onChange={(event) =>
                onUpdate((current) => ({
                  ...current,
                  agentBridge: {
                    ...current.agentBridge,
                    maxOutputBytes: Number(event.target.value) || 200000,
                  },
                }))
              }
              onWheel={(event) => event.currentTarget.blur()}
            />
          </label>
        </div>

        {/* 全局自动执行开启时白名单不再参与判断，隐藏连接范围以免用户误以为勾选仍有限制作用。 */}
        {!draftSettings.agentBridge.autoExecute ? (
          <div className="agent-auto-connections-panel">
            <div>
              <h4>{t("executionConnectionsTitle")}</h4>
              <p>{t("executionConnectionsDesc")}</p>
            </div>
            <div className="agent-connection-list">
              {connections.length ? (
                <AgentAutoConnectionTree
                  allowedConnectionIds={
                    draftSettings.agentBridge.allowedConnectionIds
                  }
                  nodes={groups}
                  ungroupedConnections={ungroupedConnections}
                  ungroupedLabel={t("ungroupedConnections")}
                  onToggleConnection={onToggleConnection}
                />
              ) : (
                <div className="empty-state">{t("connectionManagerEmpty")}</div>
              )}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
