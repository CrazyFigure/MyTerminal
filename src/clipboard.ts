import { invoke, isTauri } from '@tauri-apps/api/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';

// 剪贴板非文本内容：资源管理器复制的文件给出原路径，截图等位图由后端落盘为临时 PNG 后给出路径。
export type ClipboardAttachment =
  | { kind: 'files'; paths: string[] }
  | { kind: 'image'; path: string };

// 文本为空时再读取文件/图片；浏览器预览环境无法访问系统剪贴板文件，直接视为无附件。
export const readClipboardAttachment = async (): Promise<ClipboardAttachment | null> => {
  if (!isTauri()) {
    return null;
  }
  return invoke<ClipboardAttachment | null>('read_clipboard_attachment').catch(() => null);
};

// 把附件转成终端可粘贴的路径文本：含空白或引号敏感字符的路径加双引号，多个路径以空格分隔。
export const formatClipboardAttachmentPaths = (attachment: ClipboardAttachment) => {
  const paths = attachment.kind === 'files' ? attachment.paths : [attachment.path];
  return paths
    .filter(Boolean)
    .map((path) => (/[\s'&()^;,]/.test(path) ? `"${path}"` : path))
    .join(' ');
};

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

// 在原生输入框、textarea 与普通文档选区中读取复制瞬间的纯文本，作为 WebView 未填充 clipboardData 时的兜底。
const readDomSelectionText = (target: EventTarget | null) => {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    try {
      const start = target.selectionStart;
      const end = target.selectionEnd;
      if (start !== null && end !== null && end > start) {
        return target.value.slice(start, end);
      }
    } catch {
      // 部分 input 类型不支持 selectionStart；继续尝试读取普通 DOM 选区。
    }
  }

  return document.getSelection()?.toString() ?? '';
};

/**
 * 把 WebView 内所有复制/剪切操作同步写入系统剪贴板。
 *
 * 事件捕获阶段先保存普通 DOM 选区，再在本轮事件结束后读取 clipboardData：Monaco 会在目标阶段
 * 才把真实编辑器选区写入 clipboardData，而 textarea 的剪切默认行为又会在事件结束前删除原选区。
 * 不阻止默认事件，以保留 Monaco 的多光标元数据、网页富文本以及浏览器预览环境的原有行为。
 */
export const installSystemClipboardBridge = () => {
  if (!isTauri()) {
    return () => undefined;
  }

  const mirrorCopiedText = (event: ClipboardEvent) => {
    const fallbackText = readDomSelectionText(event.target);

    queueMicrotask(() => {
      const text = event.clipboardData?.getData('text/plain') || fallbackText;
      if (!text) {
        return;
      }

      // 原生写入失败不应打断 WebView 已完成的默认复制；失败时仍保留应用内原有粘贴能力。
      void writeClipboardText(text).catch(() => undefined);
    });
  };

  // 捕获阶段监听可覆盖会停止冒泡的编辑器组件；复制与剪切都应把文本交给 Windows 系统剪贴板。
  document.addEventListener('copy', mirrorCopiedText, true);
  document.addEventListener('cut', mirrorCopiedText, true);

  return () => {
    document.removeEventListener('copy', mirrorCopiedText, true);
    document.removeEventListener('cut', mirrorCopiedText, true);
  };
};
