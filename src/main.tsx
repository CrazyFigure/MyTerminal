import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { installSystemClipboardBridge } from './clipboard';
import './styles.css';
// 引入内置字体（JetBrains Mono 与 Maple Mono Normal NF CN）
import './styles/fonts.css';
// 功能样式按原文件中的先后顺序加载，避免拆分后改变同权重选择器的级联结果。
import './styles/agent.css';
import './styles/interaction-overrides.css';
import './styles/backup-selector.css';
import './styles/terminal-extras.css';
import './styles/update-modal.css';
import './styles/custom-select.css';

// 桌面端所有 WebView 复制/剪切统一同步到 Windows 系统剪贴板，覆盖文本框、Markdown 与内置编辑器。
const disposeSystemClipboardBridge = installSystemClipboardBridge();

// Vite 热更新时卸载旧监听，避免开发环境重复写入同一份剪贴板内容。
if (import.meta.hot) {
  import.meta.hot.dispose(disposeSystemClipboardBridge);
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
