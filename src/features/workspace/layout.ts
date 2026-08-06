/* 功能域展示规则：不持有 React 页面状态，只把输入转换成稳定的显示结果。 */

// 左右侧栏允许比旧版 320px 更窄，展开双侧栏时优先把横向空间留给终端和底部操作区。
export const sidePanelMinWidth = 240;


export const sidePanelMaxWidth = 560;


// AI 对话栏承载长文本与代码块，需要比文件树宽得多；按窗口比例上限，大屏时能拖到接近 3/5。
export const agentSidebarMaxWidthRatio = 0.6;


// AI 栏展开时主工作区可以让到更窄——终端本身在窄宽下仍可用，用户是主动选择看对话。
export const agentSidebarMainWorkspaceMinWidth = 420;


// 左侧上下分区都保留约 120px 最小可用高度，避免文件管理区被限制成半屏起步。
export const sidebarRuntimeMinHeight = 120;


export const sidebarExplorerMinHeight = 120;


// app 外壳 padding、sidebar padding、分隔拖拽条和 gap 都要从可分配高度里预留出来。
export const sidebarVerticalChromeBudget = 28;


// 主工作区保底宽度用于反推侧栏最大可拖宽度，避免左右栏继续挤压中间按钮和终端。
export const mainWorkspaceMinWidth = 720;


// 应用外壳左右 padding 和侧栏拖拽柄宽度参与宽度预算，保证 JS 钳制与 CSS 网格尺寸一致。
export const appShellHorizontalPadding = 8;


export const sidePanelResizeHandleWidth = 4;



export const resolveSidePanelMaxWidth = (
  oppositePanelVisible: boolean,
  oppositePanelWidth: number,
  // AI 对话栏用更宽的上限与更小的主工作区保底，其余侧栏维持原有克制的尺寸。
  isAgentPanel = false,
) => {
  if (typeof window === 'undefined') {
    return isAgentPanel ? Math.round(1180 * agentSidebarMaxWidthRatio) : sidePanelMaxWidth;
  }

  const occupiedByChrome =
    appShellHorizontalPadding +
    sidePanelResizeHandleWidth +
    (oppositePanelVisible ? sidePanelResizeHandleWidth + oppositePanelWidth : 0);
  const workspaceFloor = isAgentPanel
    ? agentSidebarMainWorkspaceMinWidth
    : mainWorkspaceMinWidth;
  const ceiling = isAgentPanel
    ? Math.round(window.innerWidth * agentSidebarMaxWidthRatio)
    : sidePanelMaxWidth;
  const availableWidth = window.innerWidth - occupiedByChrome - workspaceFloor;
  return Math.max(sidePanelMinWidth, Math.min(ceiling, Math.floor(availableWidth)));
};



// 运行状态区域最大高度由文件管理区最小高度反推，拖拽到底时仍给文件管理保留可操作空间。
export const resolveRuntimePanelMaxHeight = () => {
  if (typeof window === 'undefined') {
    return 380;
  }

  return Math.max(
    sidebarRuntimeMinHeight,
    window.innerHeight - sidebarExplorerMinHeight - sidebarVerticalChromeBudget,
  );
};
