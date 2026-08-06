import type { AgentChatMessage, AgentChatPart } from "../../types";

// 工具参数与结果只展示有限预览，防止单次大输出撑爆对话 DOM。
export const previewAgentChatText = (value: string, max = 4000) =>
  value.length > max ? `${value.slice(0, max)}…` : value;

// 旧存档没有 parts 时按“正文在前、工具在后”投影，保持历史数据向下兼容。
export const resolveAgentChatMessageParts = (
  message: AgentChatMessage,
): AgentChatPart[] => {
  if (message.parts && message.parts.length) {
    return message.parts;
  }
  const parts: AgentChatPart[] = [];
  if (message.content) {
    parts.push({ type: "text", text: message.content });
  }
  for (const call of message.toolCalls) {
    parts.push({ type: "tool", call });
  }
  return parts;
};
