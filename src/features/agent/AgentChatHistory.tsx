import { Trash2 } from "lucide-react";

import type { TranslationKey } from "../../i18n";

export type AgentChatHistoryItem = {
  id: string;
  title: string;
  updatedAt: number;
};

type Props = {
  activeId: string;
  items: AgentChatHistoryItem[];
  onDelete: (conversationId: string) => void;
  onSelect: (conversationId: string) => void;
  t: (
    key: TranslationKey,
    replacements?: Record<string, string | number>,
  ) => string;
};

// 历史列表只负责选择与删除意图，端点恢复和持久化事务由对话编排层统一处理。
export function AgentChatHistory({
  activeId,
  items,
  onDelete,
  onSelect,
  t,
}: Props) {
  return (
    <div className="agent-chat-history">
      {items.length ? (
        items.map((item) => (
          <div
            key={item.id}
            className={`agent-chat-history-item ${item.id === activeId ? "is-active" : ""}`}
          >
            <button onClick={() => onSelect(item.id)} type="button">
              <span>{item.title}</span>
              <small>{new Date(item.updatedAt).toLocaleString()}</small>
            </button>
            <button
              className="icon-button"
              onClick={() => onDelete(item.id)}
              title={t("agentChatDelete")}
              type="button"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))
      ) : (
        <div className="empty-state">{t("agentChatHistoryEmpty")}</div>
      )}
    </div>
  );
}
