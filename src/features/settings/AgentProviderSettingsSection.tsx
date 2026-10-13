import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Plus, Save, ShieldCheck } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import type { AgentModel, AgentProvider } from "../../types";
import { Tooltip } from "../../components/Tooltip";
import { AgentProviderCard } from "./AgentProviderCard";
import { numericSettingInputProps } from "./model";

type Props = {
  /** 自动压缩是全局对话设置，与端点草稿一起在本页保存。 */
  autoCompact: boolean;
  compactThreshold: number;
  hasChanges: boolean;
  onAddModel: (providerId: string) => void;
  /** 新建端点并返回其 id，便于新卡片自动展开。 */
  onAddProvider: () => string;
  onOpenExecutionSettings: () => void;
  onRemoveModel: (providerId: string, modelIndex: number) => void;
  onRemoveProvider: (providerId: string) => void;
  /** 把 fromIndex 的端点移动到 toIndex 之前（toIndex 等于列表长度表示移到末尾）。 */
  onReorderProviders: (fromIndex: number, toIndex: number) => void;
  onSave: () => void | Promise<unknown>;
  onToggleApiKey: (providerId: string) => void;
  onUpdateCompaction: (patch: {
    autoCompact?: boolean;
    compactThreshold?: number;
    pasteBlockThreshold?: number;
  }) => void;
  onUpdateModel: (
    providerId: string,
    modelIndex: number,
    patch: Partial<AgentModel>,
  ) => void;
  onUpdateProvider: (providerId: string, patch: Partial<AgentProvider>) => void;
  /** 粘贴超过该字数时折叠为文本块，0 表示关闭。 */
  pasteBlockThreshold: number;
  providers: AgentProvider[];
  revealedApiKeys: Record<string, boolean>;
  t: (
    key: TranslationKey,
    replacements?: Record<string, string | number>,
  ) => string;
};

type DragSession = { id: string; fromIndex: number; dropIndex: number };

// AI 助手页编辑端点聚合草稿与全局对话行为；协议地址推导和模型列表操作都收敛在此功能边界内。
export function AgentProviderSettingsSection({
  autoCompact,
  compactThreshold,
  hasChanges,
  onAddModel,
  onAddProvider,
  onOpenExecutionSettings,
  onRemoveModel,
  onRemoveProvider,
  onReorderProviders,
  onSave,
  onToggleApiKey,
  onUpdateCompaction,
  onUpdateModel,
  onUpdateProvider,
  pasteBlockThreshold,
  providers,
  revealedApiKeys,
  t,
}: Props) {
  // 端点卡片默认折叠，只记录用户展开过的卡片；新建的端点自动展开方便立即填写。
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [drag, setDrag] = useState<DragSession | null>(null);
  const dragRef = useRef<DragSession | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // 拖拽监听挂在 window 上，组件卸载时必须一并移除，避免残留的捕获监听影响其它页面。
  const dragCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  const toggleExpanded = (providerId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(providerId)) {
        next.delete(providerId);
      } else {
        next.add(providerId);
      }
      return next;
    });
  };

  // 以卡片纵向中点判断插入位置：指针在某张卡片上半部分时插到它之前，越过最后一张中点则放到末尾。
  const resolveDropIndex = (clientY: number) => {
    const cards = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-provider-id]") ?? [],
    );
    const index = cards.findIndex((card) => {
      const rect = card.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2;
    });
    return index < 0 ? cards.length : index;
  };

  /**
   * 指针拖拽排序：监听挂在 window 捕获阶段，应用窗口外松手收不到 pointerup 时，
   * 由移动事件里的 buttons 复核兜底结束拖拽，避免拖拽状态永久残留。
   */
  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>, providerId: string) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const fromIndex = providers.findIndex((item) => item.id === providerId);
    const session = { id: providerId, fromIndex, dropIndex: fromIndex };
    dragRef.current = session;
    setDrag(session);

    const finish = (commit: boolean) => {
      const current = dragRef.current;
      dragCleanupRef.current?.();
      dragRef.current = null;
      setDrag(null);
      if (commit && current) {
        onReorderProviders(current.fromIndex, current.dropIndex);
      }
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (!(moveEvent.buttons & 1)) {
        finish(true);
        return;
      }
      const dropIndex = resolveDropIndex(moveEvent.clientY);
      if (dragRef.current && dragRef.current.dropIndex !== dropIndex) {
        dragRef.current = { ...dragRef.current, dropIndex };
        setDrag(dragRef.current);
      }
    };
    const onUp = () => finish(true);
    const onKey = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape") {
        finish(false);
      }
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("keydown", onKey, true);
    dragCleanupRef.current = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("keydown", onKey, true);
      dragCleanupRef.current = null;
    };
  };

  // 指示线只在真正会改变顺序的位置出现：落回原位（自身前后）不画线。
  const dragStateOf = (index: number, providerId: string) => {
    if (!drag) {
      return "" as const;
    }
    if (drag.id === providerId) {
      return "dragging" as const;
    }
    const unchanged = drag.dropIndex === drag.fromIndex || drag.dropIndex === drag.fromIndex + 1;
    if (unchanged) {
      return "" as const;
    }
    if (drag.dropIndex === index) {
      return "drop-before" as const;
    }
    if (drag.dropIndex === providers.length && index === providers.length - 1) {
      return "drop-after" as const;
    }
    return "" as const;
  };

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
              onClick={() => {
                const providerId = onAddProvider();
                setExpandedIds((current) => new Set(current).add(providerId));
              }}
              type="button"
            >
              <Plus size={14} /> {t("agentProviderAdd")}
            </button>
          </div>
        </div>

        {providers.length ? (
          <div
            ref={listRef}
            className={`agent-provider-list ${drag ? "is-sorting" : ""}`}
          >
            {providers.map((provider, index) => (
              <AgentProviderCard
                key={provider.id}
                dragState={dragStateOf(index, provider.id)}
                expanded={expandedIds.has(provider.id)}
                onAddModel={() => onAddModel(provider.id)}
                onMoveByKeyboard={(offset) => {
                  const target = index + offset;
                  if (target >= 0 && target < providers.length) {
                    // 下移一位等价于插到下下张卡片之前。
                    onReorderProviders(index, offset > 0 ? target + 1 : target);
                  }
                }}
                onRemove={() => onRemoveProvider(provider.id)}
                onRemoveModel={(modelIndex) => onRemoveModel(provider.id, modelIndex)}
                onStartDrag={(event) => startDrag(event, provider.id)}
                onToggleApiKey={() => onToggleApiKey(provider.id)}
                onToggleExpanded={() => toggleExpanded(provider.id)}
                onUpdate={(patch) => onUpdateProvider(provider.id, patch)}
                onUpdateModel={(modelIndex, patch) => onUpdateModel(provider.id, modelIndex, patch)}
                provider={provider}
                revealApiKey={Boolean(revealedApiKeys[provider.id])}
                t={t}
              />
            ))}
          </div>
        ) : (
          <div className="empty-state">{t("agentProvidersEmpty")}</div>
        )}
      </section>

      {/* 上下文压缩对所有端点与模型生效，从对话侧栏的运行参数移到这里集中管理。 */}
      <section className="settings-section-block">
        <div>
          <h3>{t("agentChatContextTitle")}</h3>
          <p>{t("agentChatContextDesc")}</p>
        </div>
        <div className="form-grid settings-single-column-grid">
          <div className="agent-toggle-field settings-inline-toggle">
            <Tooltip content={t("agentChatAutoCompactDesc")} side="right">
              <span>{t("agentChatAutoCompact")}</span>
            </Tooltip>
            <div className="settings-inline-toggle-control">
              <input
                aria-label={t("agentChatAutoCompact")}
                checked={autoCompact}
                onChange={(event) =>
                  onUpdateCompaction({ autoCompact: event.target.checked })
                }
                type="checkbox"
              />
              <strong>{autoCompact ? t("enabled") : t("disabled")}</strong>
            </div>
          </div>
          <label
            className={`agent-compact-threshold ${autoCompact ? "" : "is-disabled"}`}
          >
            <span>{t("agentChatCompactThreshold")}</span>
            <div className="opacity-control">
              {/* 1% 步进：阈值对压缩时机影响敏感，粗调容易一次跨过头。 */}
              <input
                aria-label={t("agentChatCompactThreshold")}
                disabled={!autoCompact}
                max={95}
                min={30}
                onChange={(event) =>
                  onUpdateCompaction({
                    compactThreshold: Number(event.target.value) / 100,
                  })
                }
                step={1}
                type="range"
                value={Math.round(compactThreshold * 100)}
              />
              <output className="agent-compact-threshold-value">
                {Math.round(compactThreshold * 100)}%
              </output>
            </div>
          </label>
          <small className="agent-provider-hint">
            {t("agentChatCompactThresholdHint")}
          </small>
        </div>
      </section>

      <section className="settings-section-block">
        <div>
          <h3>{t("agentChatInputTitle")}</h3>
          <p>{t("agentChatInputDesc")}</p>
        </div>
        <div className="form-grid settings-single-column-grid">
          <label className="agent-paste-threshold">
            <span>{t("agentChatPasteBlockThreshold")}</span>
            <div className="agent-paste-threshold-control">
              {/* 文本型数字框：没有上下步进箭头，滚轮也不会隐式改值；清空视为 0（关闭）。 */}
              <input
                {...numericSettingInputProps}
                aria-label={t("agentChatPasteBlockThreshold")}
                onChange={(event) => {
                  const digits = event.target.value.replace(/\D/g, "").slice(0, 7);
                  onUpdateCompaction({ pasteBlockThreshold: digits ? Number(digits) : 0 });
                }}
                value={String(pasteBlockThreshold)}
              />
              <span>{t("agentChatPasteBlockUnit")}</span>
            </div>
          </label>
          <small className="agent-provider-hint">{t("agentChatPasteBlockHint")}</small>
        </div>
      </section>

      <div className="section-row compact">
        <button
          className="primary-button"
          disabled={!hasChanges}
          onClick={() => void onSave()}
          type="button"
        >
          <Save size={16} /> {t("agentAssistantSave")}
        </button>
      </div>
    </div>
  );
}
