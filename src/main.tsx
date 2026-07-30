import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { installSystemClipboardBridge } from './clipboard';
import './styles.css';

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
