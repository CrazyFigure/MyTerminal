/* 功能域展示规则：不持有 React 页面状态，只把输入转换成稳定的显示结果。 */
import type { AgentBridgeRequest, ConnectionProfile } from '../../types';

// AI 执行通知用稳定 tag 去重，避免 MCP 客户端重试时 Windows 通知中心堆出重复消息。
export const agentBridgeNotificationTagPrefix = 'myterminal-agent-bridge';


// Windows toast 按钮的动作 ID 和 Rust 端保持一致，前端事件回来后直接分派审批结果。
export const agentBridgeNotificationApproveActionId = 'approve-agent-request';


export const agentBridgeNotificationRejectActionId = 'reject-agent-request';


// 通知正文只保留短摘要，防止长命令或长路径把 Windows toast 挤得难以阅读。
export const agentRequestSummaryMaxLength = 160;



export const normalizeAgentRequestSummary = (value: string, maxLength = agentRequestSummaryMaxLength) => {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
};



export const getAgentRequestSummary = (request: AgentBridgeRequest) => {
  // 审批卡片和系统通知共用同一套摘要规则，保证收起态与通知里看到的是同一个执行目标。
  if (request.kind === 'run_command' && request.command?.trim()) {
    return normalizeAgentRequestSummary(request.command);
  }
  if (request.path) {
    const pathSummary = request.newPath ? `${request.path} -> ${request.newPath}` : request.path;
    return normalizeAgentRequestSummary(pathSummary);
  }
  if (request.contentPreview?.trim()) {
    return normalizeAgentRequestSummary(request.contentPreview);
  }
  return normalizeAgentRequestSummary(request.title || request.kind);
};



export const getAgentRequestMachineLabel = (request: AgentBridgeRequest, connections: ConnectionProfile[]) => {
  const connection = connections.find((item) => item.id === request.connectionId);
  if (!connection) {
    return request.connectionId;
  }

  // SSH 机器信息只展示定位字段，避免把认证材料或备注等敏感配置带入通知和收起态。
  return `${connection.name} · ${connection.username}@${connection.host}:${connection.port}`;
};
