import type { AgentChatMessage, AgentChatToolCall } from "../../types";

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
}

// 将界面聚合的工具结果拆成紧随助手调用的用户回合，满足三种后端协议的共同消息顺序。
export const buildWireHistory = (
  messages: AgentChatMessage[],
): WireMessage[] => {
  const wire: WireMessage[] = [];
  for (const message of messages) {
    const hasContent = message.content.trim().length > 0;
    if (hasContent || message.toolCalls.length) {
      wire.push({
        role: message.role,
        content: message.content,
        toolCalls: message.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
        toolResults: [],
      });
    }

    const finished = message.toolCalls.filter(
      (call) => call.result !== undefined,
    );
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
      });
    }
  }
  return wire;
};

// 历史标题取首条用户消息首行，保持列表简短且可辨认。
export const deriveTitle = (messages: AgentChatMessage[], fallback: string) => {
  const first = messages.find(
    (item) => item.role === "user" && item.content.trim(),
  );
  if (!first) {
    return fallback;
  }
  const line = first.content.trim().split("\n")[0];
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
};
