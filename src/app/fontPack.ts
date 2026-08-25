import { convertFileSrc } from '@tauri-apps/api/core';

import { translate } from '../i18n';
import {
  packagedTerminalFontFamilies,
  setApplicationTerminalFontFamilies,
} from '../terminalFonts';
import type { AppSettings, FontPackStatus, UiLanguage } from '../types';

// 当前文档已注册的 FontFace 必须可追踪，删除或修复资源包时才能彻底撤销旧引用。
let activeFontFaces: FontFace[] = [];

const clearActiveFontFaces = () => {
  if (typeof document !== 'undefined' && 'fonts' in document) {
    activeFontFaces.forEach((fontFace) => document.fonts.delete(fontFace));
  }
  activeFontFaces = [];
  setApplicationTerminalFontFamilies([]);
};

/**
 * 把后端校验通过的本地文件注册到当前 WebView；不会调用 Windows 字体安装接口，
 * 应用退出后这些 FontFace 随文档一起销毁，系统与其它软件均不可见。
 */
export const activateFontPack = async (status: FontPackStatus): Promise<FontPackStatus> => {
  clearActiveFontFaces();
  if (status.state !== 'ready' || !status.faces.length || typeof document === 'undefined') {
    return status;
  }

  const pendingFaces = status.faces.map((descriptor) => {
    const assetUrl = convertFileSrc(descriptor.path);
    return new FontFace(
      descriptor.family,
      `url(${JSON.stringify(assetUrl)})`,
      {
        style: descriptor.style,
        weight: descriptor.weight,
        display: 'swap',
      },
    );
  });

  try {
    // 先加入 FontFaceSet 再主动加载，确保 load 完成的同一帧即可用于 Canvas/xterm 字形测量。
    pendingFaces.forEach((fontFace) => document.fonts.add(fontFace));
    await Promise.all(pendingFaces.map((fontFace) => fontFace.load()));
    activeFontFaces = pendingFaces;
    setApplicationTerminalFontFamilies(
      Array.from(new Set(status.faces.map((face) => face.family))),
    );
    return status;
  } catch (error) {
    pendingFaces.forEach((fontFace) => document.fonts.delete(fontFace));
    setApplicationTerminalFontFamilies([]);
    throw error;
  }
};

const packagedFontLookup = new Set(
  packagedTerminalFontFamilies.map((fontFamily) => fontFamily.toLowerCase()),
);

export const isPackagedFontFamily = (fontFamily: string) =>
  packagedFontLookup.has(fontFamily.trim().replace(/^['"]|['"]$/g, '').toLowerCase());

const buildInstalledFontLookup = (installedFonts: readonly string[]) =>
  new Map(installedFonts.map((fontFamily) => [fontFamily.toLowerCase(), fontFamily]));

/** 只有当前配置确实依赖字体包且系统中没有同名字体时才提示，避免给自定义字体用户制造无用下载。 */
export const shouldPromptForFontPack = (
  settings: AppSettings,
  installedFonts: readonly string[],
) => {
  const installed = buildInstalledFontLookup(installedFonts);
  const configured = [settings.shellLatinFontFamily, settings.shellCjkFontFamily]
    .filter(Boolean);
  return configured.some((fontFamily) => {
    const normalized = fontFamily.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
    return packagedFontLookup.has(normalized) && !installed.has(normalized);
  });
};

const chooseInstalledFont = (
  installed: Map<string, string>,
  candidates: readonly string[],
  genericFallback: string,
) => {
  for (const candidate of candidates) {
    const match = installed.get(candidate.toLowerCase());
    if (match) {
      return match;
    }
  }
  return genericFallback;
};

/** 用户拒绝或删除字体包时选取真实存在的 Windows 常用字体，设置页展示与实际渲染保持一致。 */
export const resolveSystemFontFallback = (installedFonts: readonly string[]) => {
  const installed = buildInstalledFontLookup(installedFonts);
  return {
    latin: chooseInstalledFont(
      installed,
      ['Cascadia Mono', 'Consolas', 'Courier New'],
      'monospace',
    ),
    cjk: chooseInstalledFont(
      installed,
      ['Microsoft YaHei UI', 'Microsoft YaHei', 'Microsoft JhengHei UI', 'SimSun'],
      'sans-serif',
    ),
  };
};

/** 后端只返回稳定错误码；用户可见内容在当前界面语言下完成。 */
export const translateFontPackError = (reason: string, language: UiLanguage) => {
  const prefix = 'font_pack_error:';
  if (!reason.startsWith(prefix)) {
    return translate(language, 'fontPackErrorGeneric', { reason });
  }
  const payload = reason.slice(prefix.length);
  const separator = payload.indexOf(':');
  const code = separator >= 0 ? payload.slice(0, separator) : payload;
  const detail = separator >= 0 ? payload.slice(separator + 1) : '';
  switch (code) {
    case 'download':
      return translate(language, 'fontPackErrorDownload', { reason: detail });
    case 'archive_size':
    case 'invalid_archive':
    case 'missing_file':
    case 'invalid_file':
      return translate(language, 'fontPackErrorInvalid');
    case 'read':
    case 'write':
    case 'install':
    case 'remove':
      return translate(language, 'fontPackErrorStorage', { reason: detail });
    default:
      return translate(language, 'fontPackErrorGeneric', { reason });
  }
};
