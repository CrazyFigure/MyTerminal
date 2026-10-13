import type {
  AgentChatMessage,
  AgentChatToolCall,
  AgentConversationOrigin,
  AgentModel,
  AgentProvider,
} from "../../types";

// 后端 agent-chat-event 的稳定事件联合，按 conversationId 约束到所属对话。
export type AgentChatEvent =
  | { type: "textDelta"; conversationId: string; text: string }
  | {
      type: "toolCall";
      conversationId: string;
      id: string;
      name: string;
      arguments: unknown;
    }
  | {
      type: "toolResult";
      conversationId: string;
      id: string;
      name: string;
      content: string;
      isError: boolean;
    }
  | { type: "completed"; conversationId: string; stopReason: string }
  | { type: "compacted"; conversationId: string; droppedMessages: number }
  | { type: "failed"; conversationId: string; message: string };

// 一段可切换的历史对话，同时记住创建时使用的端点与模型。
export interface AgentConversation {
  id: string;
  title: string;
  messages: AgentChatMessage[];
  updatedAt: number;
  providerId?: string;
  modelId?: string;
  /** 通过会话 ID 接续而来时的来源会话；开头 messageCount 条消息复制自来源。 */
  continuedFrom?: AgentConversationOrigin;
}

export const newId = () => crypto.randomUUID();

// 历史对话只保留最近若干条，避免长期运行时无限占用内存。
export const MAX_CONVERSATIONS = 30;

// 由有序片段反推兼容字段，使协议投影、展示和持久化始终读取同一份语义。
export const withSyncedLegacy = (
  message: AgentChatMessage,
): AgentChatMessage => {
  const parts = message.parts ?? [];
  let content = "";
  const toolCalls: AgentChatToolCall[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      content += part.text;
    } else {
      toolCalls.push(part.call);
    }
  }
  return { ...message, content, toolCalls };
};

// 本会话自己产生的消息（排除接续时复制来的历史），绑定判定与历史列表都只看这一段。
export const ownMessages = (conversation?: AgentConversation) =>
  conversation
    ? conversation.messages.slice(conversation.continuedFrom?.messageCount ?? 0)
    : [];

export const hasOwnMessages = (conversation?: AgentConversation) =>
  ownMessages(conversation).length > 0;

/**
 * 对话是否已绑定端点与模型：本会话里至少有一条模型真正给出的回复（正文或工具调用）。
 * 首轮请求失败时空的助手占位会被移除，此时仍允许换模型重试；规则与后端 conversation_binding 保持一致。
 */
export const isConversationBound = (conversation?: AgentConversation) =>
  Boolean(conversation?.providerId && conversation.modelId) &&
  ownMessages(conversation).some(
    (message) =>
      message.role === "assistant" &&
      (message.content.trim().length > 0 || message.toolCalls.length > 0),
  );

export type ConversationBinding =
  | { locked: false }
  | {
      locked: true;
      providerId: string;
      modelId: string;
      provider?: AgentProvider;
      model?: AgentModel;
    };

// 解析当前对话锁定的端点与模型；端点或模型被删除时 provider/model 为空，界面据此提示无法继续。
export const resolveConversationBinding = (
  conversation: AgentConversation | undefined,
  providers: AgentProvider[],
): ConversationBinding => {
  if (!conversation || !isConversationBound(conversation)) {
    return { locked: false };
  }
  const providerId = conversation.providerId ?? "";
  const modelId = conversation.modelId ?? "";
  const provider = providers.find((item) => item.id === providerId);
  return {
    locked: true,
    providerId,
    modelId,
    provider,
    model: provider?.models.find((item) => item.id === modelId),
  };
};

/**
 * 以来源会话的完整消息创建接续会话：消息深拷贝进新会话，来源之后被删除也不影响继续；
 * 新会话尚未绑定模型，由用户当前选择的模型在首次发送时接手。
 */
export const buildContinuedConversation = (
  source: AgentConversation,
  targetId: string,
): AgentConversation => {
  const messages = structuredClone(source.messages);
  return {
    id: targetId,
    title: source.title,
    messages,
    updatedAt: Date.now(),
    continuedFrom: {
      id: source.id,
      title: source.title,
      providerId: source.providerId,
      modelId: source.modelId,
      messageCount: messages.length,
    },
  };
};

type WireAttachment =
  | { kind: "image"; name: string; path: string; mediaType: string; data: string }
  | { kind: "text"; name: string; path: string; content: string; truncated: boolean };

interface WireMessage {
  role: string;
  content: string;
  toolCalls: { id: string; name: string; arguments: unknown }[];
  toolResults: {
    toolCallId: string;
    name: string;
    content: string;
    isError: boolean;
  }[];
  attachments: WireAttachment[];
}

// 附件只保留协议需要的字段；缩略图尺寸、文件大小等展示信息不进请求体。
const toWireAttachments = (message: AgentChatMessage): WireAttachment[] =>
  (message.attachments ?? []).map((attachment) =>
    attachment.kind === "image"
      ? {
          kind: "image",
          name: attachment.name,
          path: attachment.path ?? "",
          mediaType: attachment.mediaType,
          data: attachment.data,
        }
      : {
          kind: "text",
          name: attachment.name,
          path: attachment.path ?? "",
          content: attachment.content,
          truncated: attachment.truncated,
        },
  );

// 将界面聚合的工具结果拆成紧随助手调用的用户回合，满足三种后端协议的共同消息顺序。
export const buildWireHistory = (
  messages: AgentChatMessage[],
): WireMessage[] => {
  const wire: WireMessage[] = [];
  for (const message of messages) {
    const hasContent = message.content.trim().length > 0;
    // 没有结果的工具调用（应用中途退出等）必须剔除：三种协议都要求每个调用紧跟对应结果，
    // 否则整段历史会被拒绝；接续到其它模型时尤其需要这份历史保持协议合法。
    const finished = message.toolCalls.filter(
      (call) => call.result !== undefined,
    );
    const attachments = toWireAttachments(message);
    if (hasContent || finished.length || attachments.length) {
      wire.push({
        role: message.role,
        content: message.content,
        toolCalls: finished.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
        toolResults: [],
        attachments,
      });
    }

    if (finished.length) {
      wire.push({
        role: "user",
        content: "",
        toolCalls: [],
        toolResults: finished.map((call) => ({
          toolCallId: call.id,
          name: call.name,
          content: call.result ?? "",
          isError: Boolean(call.isError),
        })),
        attachments: [],
      });
    }
  }
  return wire;
};

// 历史标题取首条用户消息首行；只发了附件时用首个附件名，保持列表简短且可辨认。
export const deriveTitle = (messages: AgentChatMessage[], fallback: string) => {
  const first = messages.find(
    (item) => item.role === "user" && item.content.trim(),
  );
  if (!first) {
    const attachment = messages.find((item) => item.attachments?.length)
      ?.attachments?.[0];
    return attachment?.name ?? fallback;
  }
  const line = first.content.trim().split("\n")[0];
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
};
