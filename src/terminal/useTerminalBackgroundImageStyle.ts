import { useEffect, useMemo, useState, type CSSProperties } from 'react';

import { backend } from '../backend';
import type { AppSettings } from '../types';
import {
  buildTerminalBackgroundImageStyle,
  isRemoteHttpImage,
  resolveTerminalBackgroundImage,
} from './support/presentation';

// 解析终端背景图样式：整个分屏网格只调用一次，所有格子与标签栏共用同一张图，远程图也只下载一次。
export function useTerminalBackgroundImageStyle(settings: AppSettings): CSSProperties | undefined {
  // 远程 http(s) 背景图经后端下载后缓存的 data URL；null 表示无远程图或下载失败(回退到原始行为)。
  const [remoteBackgroundDataUrl, setRemoteBackgroundDataUrl] = useState<string | null>(null);
  useEffect(() => {
    const rawUrl = settings.backgroundImage?.trim();
    // 非远程图片(本地/asset/data)无需下载，清空缓存交给下方直接解析。
    if (!isRemoteHttpImage(rawUrl) || !rawUrl) {
      setRemoteBackgroundDataUrl(null);
      return;
    }
    let cancelled = false;
    setRemoteBackgroundDataUrl(null);
    backend
      .fetchRemoteBackgroundImage(rawUrl)
      .then((dataUrl) => {
        if (!cancelled) {
          setRemoteBackgroundDataUrl(dataUrl);
        }
      })
      .catch(() => {
        // 下载失败时回退为直接使用原始 URL，保持与旧行为一致(仍可能被防盗链拦截，但不影响其它功能)。
        if (!cancelled) {
          setRemoteBackgroundDataUrl(rawUrl);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [settings.backgroundImage]);

  return useMemo(() => {
    // 远程图片用下载得到的 data URL；本地/asset/data 走原解析逻辑。
    const resolvedImage = isRemoteHttpImage(settings.backgroundImage)
      ? remoteBackgroundDataUrl ?? undefined
      : resolveTerminalBackgroundImage(settings.backgroundImage);
    return buildTerminalBackgroundImageStyle(settings, resolvedImage);
  }, [
    settings.backgroundImage,
    settings.terminalBackgroundImageFit,
    settings.terminalBackgroundImageOpacity,
    remoteBackgroundDataUrl,
  ]);
}
