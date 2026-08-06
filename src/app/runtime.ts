/* 本模块由 App 入口按功能域拆出，保留原组件行为与状态订阅方式。 */


export const isTauriRuntime = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
