/* 本模块由 App 入口按功能域拆出，保留原组件行为与状态订阅方式。 */


// 端口只允许键盘录入，不使用 number 类型，避免浏览器步进按钮和鼠标滚轮隐式改值。
export const portTextInputProps = {
  type: 'text',
  inputMode: 'numeric',
  pattern: '[0-9]*',
} as const;
