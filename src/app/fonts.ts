/* 本模块由 App 入口按功能域拆出，保留原组件行为与状态订阅方式。 */
import { buildAgentChatFontFamily, buildTerminalFontFamily } from '../terminalFonts';
import type { AppSettings } from '../types';

export const buildPreviewFontFamily = (settings: AppSettings) =>
  buildTerminalFontFamily(
    settings.shellLatinFontFamily ?? settings.shellFontFamily,
    settings.shellCjkFontFamily ?? settings.shellFontFamily,
  );

/**
 * 全局界面 UI 字体栈：
 * 未设置时默认跟随终端区域配置的英文字体与中文字体；
 * 采用现代界面无衬线备选兜底，防止出现点阵宋体。
 */
export const resolveUiFontFamily = (
  settings: AppSettings,
  installedFontFamilies?: readonly string[],
) => {
  const latin =
    settings.uiLatinFontFamily ||
    settings.shellLatinFontFamily ||
    settings.shellFontFamily ||
    'JetBrains Mono';
  const cjk =
    settings.uiCjkFontFamily ||
    settings.shellCjkFontFamily ||
    settings.shellFontFamily ||
    'Maple Mono Normal NF CN';
  return buildAgentChatFontFamily(latin, cjk, installedFontFamilies);
};
