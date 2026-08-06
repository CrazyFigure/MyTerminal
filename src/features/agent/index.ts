// Agent 功能域公共入口：上层只依赖请求展示与通知规则，不感知内部文件布局。
export {
  agentBridgeNotificationApproveActionId,
  agentBridgeNotificationRejectActionId,
  agentBridgeNotificationTagPrefix,
  getAgentRequestMachineLabel,
  getAgentRequestSummary,
} from './requestPresentation';
