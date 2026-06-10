import { isTauri } from '@tauri-apps/api/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';

// 读取剪贴板优先使用 Tauri 原生插件，避免桌面端 WebView 弹出浏览器权限请求。
export const readClipboardText = async () => {
  if (isTauri()) {
    return readText();
  }

  return navigator.clipboard?.readText() ?? '';
};

// 写入剪贴板同样走原生插件；浏览器预览环境保留 navigator.clipboard 作为开发兜底。
export const writeClipboardText = async (text: string) => {
  if (isTauri()) {
    await writeText(text);
    return;
  }

  await navigator.clipboard?.writeText(text);
};
