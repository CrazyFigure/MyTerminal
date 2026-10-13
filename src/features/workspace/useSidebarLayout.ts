import { useState, useSyncExternalStore } from 'react';

import { sidebarAutoCollapseMaxWidth } from './layout';

// 使用同一媒体查询监听断点变化，不随每次窗口拖动重复更新整个工作区。
const sidebarAutoCollapseQuery = `(max-width: ${sidebarAutoCollapseMaxWidth}px)`;

// 监听窄窗口保护的进入与退出；卸载后移除监听，不影响其他窗口事件。
function subscribeToSidebarAvailability(onChange: () => void) {
  const mediaQuery = window.matchMedia(sidebarAutoCollapseQuery);
  mediaQuery.addEventListener('change', onChange);
  return () => mediaQuery.removeEventListener('change', onChange);
}

// 媒体查询与浏览器布局采用同一宽度口径，覆盖断点恰好命中的边界。
function getSidebarsUnavailable() {
  return window.matchMedia(sidebarAutoCollapseQuery).matches;
}

// 无窗口的渲染环境不启用窄窗口保护，避免访问浏览器 API。
function getServerSidebarsUnavailable() {
  return false;
}

// 将用户折叠偏好与实际可见性分开：窄窗口暂时收起，拉宽后恢复，不覆盖用户选择。
// App 与标题栏共用有效状态，避免样式隐藏了侧栏、按钮和网格却仍显示展开。
export function useSidebarLayout() {
  const [sidebarPreferredCollapsed, setSidebarCollapsed] = useState(false);
  // AI 执行默认收起，只有用户点击或 MCP 新请求到达时才占用主窗口右侧空间。
  const [agentSidebarPreferredCollapsed, setAgentSidebarCollapsed] = useState(true);
  const sidebarsUnavailable = useSyncExternalStore(
    subscribeToSidebarAvailability,
    getSidebarsUnavailable,
    getServerSidebarsUnavailable,
  );

  return {
    sidebarCollapsed: sidebarsUnavailable || sidebarPreferredCollapsed,
    agentSidebarCollapsed: sidebarsUnavailable || agentSidebarPreferredCollapsed,
    setSidebarCollapsed,
    setAgentSidebarCollapsed,
    sidebarsUnavailable,
  };
}
