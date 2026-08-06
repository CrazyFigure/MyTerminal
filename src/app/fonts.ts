/* 本模块由 App 入口按功能域拆出，保留原组件行为与状态订阅方式。 */
import { buildTerminalFontFamily } from '../terminalFonts';
import type { AppSettings } from '../types';

export const buildPreviewFontFamily = (settings: AppSettings) =>
  buildTerminalFontFamily(
    settings.shellLatinFontFamily ?? settings.shellFontFamily,
    settings.shellCjkFontFamily ?? settings.shellFontFamily,
  );
