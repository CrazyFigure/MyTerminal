// 主工作区功能域公共入口：统一暴露动作区与布局预算，隐藏内部拆分。
export {
  bottomTabs,
  buildActionButtonStyle,
  estimateInlineButtonWidth,
  renderActionButtonLabel,
  type BottomPanelTab,
} from './actionButtons';
export {
  mainWorkspaceMinWidth,
  resolveRuntimePanelMaxHeight,
  resolveSidePanelMaxWidth,
  sidePanelMinWidth,
  sidebarRuntimeMinHeight,
} from './layout';
export { TransferProgressStack, type TransferProgressItem } from './TransferProgressStack';
export { BottomDock } from './BottomDock';
export { AppTitlebar } from './AppTitlebar';
export { useTransferProgress } from './useTransferProgress';
