import {
  Activity,
  Bot,
  Cable,
  Info,
  Settings,
  ShieldCheck,
  Upload,
} from "lucide-react";

import type { TranslationKey } from "../../i18n";
import type { SettingsTab } from "./model";

type Props = {
  activeTab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  t: (
    key: TranslationKey,
    replacements?: Record<string, string | number>,
  ) => string;
};

// 设置导航集中维护标签与图标映射，避免弹窗编排层随页面增加而继续膨胀。
export function SettingsNavigation({ activeTab, onTabChange, t }: Props) {
  return (
    <nav className="settings-nav">
      <button
        className={`settings-nav-item ${activeTab === "appearance" ? "is-active" : ""}`}
        onClick={() => onTabChange("appearance")}
        type="button"
      >
        <Settings size={16} />
        {t("settingsTabAppearance")}
      </button>
      <button
        className={`settings-nav-item ${activeTab === "resources" ? "is-active" : ""}`}
        onClick={() => onTabChange("resources")}
        type="button"
      >
        <Activity size={16} />
        {t("settingsTabResources")}
      </button>
      <button
        className={`settings-nav-item ${activeTab === "sync" ? "is-active" : ""}`}
        onClick={() => onTabChange("sync")}
        type="button"
      >
        <Upload size={16} />
        {t("settingsTabSync")}
      </button>
      <button
        className={`settings-nav-item ${activeTab === "agent" ? "is-active" : ""}`}
        onClick={() => onTabChange("agent")}
        type="button"
      >
        <Cable size={16} />
        {t("settingsTabAgent")}
      </button>
      <button
        className={`settings-nav-item ${activeTab === "agentChat" ? "is-active" : ""}`}
        onClick={() => onTabChange("agentChat")}
        type="button"
      >
        <Bot size={16} />
        {t("settingsTabAgentChat")}
      </button>
      <button
        className={`settings-nav-item ${activeTab === "execution" ? "is-active" : ""}`}
        onClick={() => onTabChange("execution")}
        type="button"
      >
        <ShieldCheck size={16} />
        {t("settingsTabExecution")}
      </button>
      <button
        className={`settings-nav-item ${activeTab === "about" ? "is-active" : ""}`}
        onClick={() => onTabChange("about")}
        type="button"
      >
        <Info size={16} />
        {t("settingsTabAbout")}
      </button>
    </nav>
  );
}
