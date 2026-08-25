import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App';
import { installSystemClipboardBridge } from './clipboard';
import './styles.css';
// 可选字体包在启动阶段由 FontFace API 从应用数据目录注册；不再静态导入，避免字体进入每个安装包。
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
