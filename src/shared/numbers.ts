// 数值钳制是无业务状态的共享基础规则，布局、设置输入等上层模块可单向依赖。
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
