/* 功能域展示规则：不持有 React 页面状态，只把输入转换成稳定的显示结果。 */


// 会话状态只在标签栏用紧凑图标表达，避免把连接/断开信息写进终端正文影响 Shell 阅读。
export const sessionStatusClassName = (status?: string) => `session-status-icon status-${status ?? 'idle'}`;
