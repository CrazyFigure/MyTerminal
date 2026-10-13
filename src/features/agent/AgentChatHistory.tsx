import { useEffect, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { CornerDownRight, GitBranchPlus, Trash2 } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import { Tooltip } from "../../components/Tooltip";
import { ViewportClampedMenu } from "../../shared/ui/ViewportClampedMenu";

export type AgentChatHistoryItem = {
  id: string;
  title: string;
  updatedAt: number;
  /** 由其它会话接续而来时展示接续标记。 */
  continued?: boolean;
  /** 绑定的模型 id，帮助用户分辨同名对话。 */
  modelId?: string;
};

type Props = {
  activeId: string;
  items: AgentChatHistoryItem[];
  onContinue: (conversationId: string) => void;
  onDelete: (conversationId: string) => void;
  onSelect: (conversationId: string) => void;
  t: (
    key: TranslationKey,
    replacements?: Record<string, string | number>,
  ) => string;
};

type MenuTarget = { id: string; x: number; y: number };

// 历史列表只负责选择、删除与接续意图，端点恢复和持久化事务由对话编排层统一处理。
export function AgentChatHistory({
  activeId,
  items,
  onContinue,
  onDelete,
  onSelect,
  t,
}: Props) {
  const [menu, setMenu] = useState<MenuTarget | null>(null);

  // 菜单打开期间：点击菜单外、按 Esc、窗口失焦或滚动都收起，避免菜单悬浮在已变化的列表上。
  useEffect(() => {
    if (!menu) {
      return;
    }
    const close = () => setMenu(null);
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target as Element | null)?.closest(".agent-chat-history-menu")) {
        close();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const openMenu = (event: MouseEvent, id: string) => {
    event.preventDefault();
    setMenu({ id, x: event.clientX, y: event.clientY });
  };

  // 菜单动作执行后立即收起，动作本身的反馈由上层的提示条负责。
  const runMenuAction = (action: (id: string) => void) => {
    if (menu) {
      action(menu.id);
    }
    setMenu(null);
  };

  return (
    <div className="agent-chat-history" onScroll={() => setMenu(null)}>
      {items.length ? (
        items.map((item) => (
          <div
            key={item.id}
            className={`agent-chat-history-item ${item.id === activeId ? "is-active" : ""} ${menu?.id === item.id ? "is-menu-open" : ""}`}
            onContextMenu={(event) => openMenu(event, item.id)}
          >
            <button onClick={() => onSelect(item.id)} type="button">
              <span>
                {item.continued ? (
                  <CornerDownRight
                    aria-label={t("agentChatContinuedBadge")}
                    className="agent-chat-history-continued"
                    size={12}
                  />
                ) : null}
                {item.title}
              </span>
              <small>
                {new Date(item.updatedAt).toLocaleString()}
                {item.modelId ? <> · {item.modelId}</> : null}
              </small>
            </button>
            <Tooltip content={t("agentChatDelete")} side="top">
              <button
                aria-label={t("agentChatDelete")}
                className="icon-button"
                onClick={() => onDelete(item.id)}
                type="button"
              >
                <Trash2 size={13} />
              </button>
            </Tooltip>
          </div>
        ))
      ) : (
        <div className="empty-state">{t("agentChatHistoryEmpty")}</div>
      )}
      {items.length ? (
        <p className="agent-chat-history-tip">{t("agentChatHistoryTip")}</p>
      ) : null}

      {/* 菜单挂到 .app-shell：既脱离列表的滚动裁剪，又能继承主题 CSS 变量。 */}
      {menu ? createPortal(
        <ViewportClampedMenu
          className="context-menu agent-chat-history-menu"
          x={menu.x}
          y={menu.y}
        >
          <button
            className="context-menu-item"
            onClick={() => runMenuAction(onContinue)}
            type="button"
          >
            <GitBranchPlus size={14} /> {t("agentChatContinueInNew")}
          </button>
          <div className="context-menu-separator" role="separator" />
          <button
            className="context-menu-item is-danger"
            onClick={() => runMenuAction(onDelete)}
            type="button"
          >
            <Trash2 size={14} /> {t("agentChatDelete")}
          </button>
        </ViewportClampedMenu>,
        document.querySelector(".app-shell") ?? document.body,
      ) : null}
    </div>
  );
}
