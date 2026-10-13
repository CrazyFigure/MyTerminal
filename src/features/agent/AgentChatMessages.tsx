import { Fragment, useState, type RefObject } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Play,
  Terminal as TerminalIcon,
  User,
  X,
} from "lucide-react";

import { MarkdownView } from "../../MarkdownView";
import type { TranslationKey } from "../../i18n";
import type {
  AgentBridgeRequest,
  AgentChatAttachment,
  AgentChatMessage,
  AgentConversationOrigin,
} from "../../types";
import { AgentMessageAttachments } from "./AgentChatAttachments";
import {
  previewAgentChatText,
  resolveAgentChatMessageParts,
} from "./chatPresentation";

type Props = {
  activeConversationId: string;
  approvalRequests: AgentBridgeRequest[];
  bodyRef: RefObject<HTMLDivElement | null>;
  /** 接续来源：在复制来的历史末尾画分隔线，标明此后由新模型继续。 */
  continuedFrom?: AgentConversationOrigin;
  messages: AgentChatMessage[];
  onApproveRequest: (request: AgentBridgeRequest) => void;
  onPreviewImage: (
    attachment: Extract<AgentChatAttachment, { kind: "image" }>,
  ) => void;
  onRejectRequest: (request: AgentBridgeRequest) => void;
  onStickToBottomChange: (stuck: boolean) => void;
  t: (
    key: TranslationKey,
    replacements?: Record<string, string | number>,
  ) => string;
};

// 消息时间线独立管理工具详情展开状态；审批仍通过稳定的对话与工具调用标识交给上层处理。
export function AgentChatMessages({
  activeConversationId,
  approvalRequests,
  bodyRef,
  continuedFrom,
  messages,
  onApproveRequest,
  onPreviewImage,
  onRejectRequest,
  onStickToBottomChange,
  t,
}: Props) {
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>(
    {},
  );

  return (
    <div
      className="agent-chat-body"
      onScroll={(event) => {
        const node = event.currentTarget;
        // 距底部 40px 内视为“贴底”，用户上翻后停止自动滚动。
        onStickToBottomChange(
          node.scrollHeight - node.scrollTop - node.clientHeight < 40,
        );
      }}
      ref={bodyRef}
    >
      {messages.length ? (
        messages.map((message, messageIndex) => (
          <Fragment key={message.id}>
          <div
            className={`agent-chat-message is-${message.role}`}
          >
            <div className="agent-chat-message-role">
              {message.role === "user" ? <User size={13} /> : <Bot size={13} />}
            </div>
            <div className="agent-chat-message-body">
              {message.role === "user" ? (
                <>
                  {message.attachments?.length ? (
                    <AgentMessageAttachments
                      attachments={message.attachments}
                      onPreview={onPreviewImage}
                      t={t}
                    />
                  ) : null}
                  {/* 用户输入保持纯文本原样展示，不按 Markdown 解析。 */}
                  {message.content ? (
                    <p className="agent-chat-user-text">{message.content}</p>
                  ) : null}
                </>
              ) : (
                <>
                  {/* 助手回复按到达顺序渲染：文本段与工具段交替，保证「先工具、后总结」与真实执行一致。 */}
                  {resolveAgentChatMessageParts(message).map(
                    (part, partIndex) => {
                      if (part.type === "text") {
                        return part.text ? (
                          <MarkdownView key={partIndex} source={part.text} />
                        ) : null;
                      }
                      const call = part.call;
                      const expanded = expandedTools[call.id] ?? false;
                      // 审批记录按对话与工具调用双重匹配，避免并发或同名工具把按钮挂到错误位置。
                      const approvalRequest = approvalRequests.find(
                        (request) =>
                          request.conversationId === activeConversationId &&
                          request.toolCallId === call.id,
                      );
                      return (
                        <div
                          key={partIndex}
                          className={`agent-chat-tool ${call.isError ? "is-error" : ""}`}
                        >
                          <button
                            aria-expanded={expanded}
                            className="agent-chat-tool-header"
                            onClick={() =>
                              setExpandedTools((current) => ({
                                ...current,
                                [call.id]: !expanded,
                              }))
                            }
                            type="button"
                          >
                            {expanded ? (
                              <ChevronDown size={13} />
                            ) : (
                              <ChevronRight size={13} />
                            )}
                            <TerminalIcon size={13} />
                            <strong>{call.name}</strong>
                            <span>
                              {call.result === undefined
                                ? t("agentChatToolRunning")
                                : call.isError
                                  ? t("agentChatToolFailed")
                                  : t("agentChatToolDone")}
                            </span>
                          </button>
                          {approvalRequest ? (
                            <div
                              className={`agent-chat-approval status-${approvalRequest.status}`}
                            >
                              <div className="agent-chat-approval-status">
                                <span>{t("panelAgentRequests")}</span>
                                <span
                                  className={`status-badge status-${approvalRequest.status}`}
                                >
                                  {approvalRequest.status}
                                </span>
                              </div>
                              {approvalRequest.status === "pending" ? (
                                <div className="section-row compact">
                                  <button
                                    className="primary-button"
                                    onClick={() =>
                                      onApproveRequest(approvalRequest)
                                    }
                                    type="button"
                                  >
                                    <Play size={14} />{" "}
                                    {t("approveAgentRequest")}
                                  </button>
                                  <button
                                    className="secondary-button"
                                    onClick={() =>
                                      onRejectRequest(approvalRequest)
                                    }
                                    type="button"
                                  >
                                    <X size={14} /> {t("rejectAgentRequest")}
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                          {expanded ? (
                            <>
                              <pre className="agent-chat-tool-payload">
                                {previewAgentChatText(
                                  JSON.stringify(call.arguments, null, 2),
                                )}
                              </pre>
                              {call.result !== undefined ? (
                                <pre className="agent-chat-tool-payload">
                                  {previewAgentChatText(call.result)}
                                </pre>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      );
                    },
                  )}
                  {!message.content && !message.toolCalls.length ? (
                    <p className="agent-chat-thinking">
                      {t("agentChatThinking")}
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </div>
          {/* 接续分隔线紧跟复制来的最后一条消息，此后的内容才属于当前模型。 */}
          {continuedFrom && messageIndex === continuedFrom.messageCount - 1 ? (
            <div className="agent-chat-continued-divider" role="separator">
              <span>
                <CornerDownRight size={12} />
                {t("agentChatContinuedDivider", {
                  count: continuedFrom.messageCount,
                  title: continuedFrom.title,
                })}
              </span>
              <small>
                {continuedFrom.modelId
                  ? t("agentChatContinuedFromModel", {
                      model: continuedFrom.modelId,
                    })
                  : null}
                {messageIndex === messages.length - 1
                  ? `${continuedFrom.modelId ? " · " : ""}${t("agentChatContinuedNext")}`
                  : null}
              </small>
            </div>
          ) : null}
          </Fragment>
        ))
      ) : (
        <div className="empty-state">{t("agentChatEmpty")}</div>
      )}
    </div>
  );
}
