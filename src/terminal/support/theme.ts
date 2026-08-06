//! 终端主题、ANSI 调色板、单元格颜色与对比度计算。

import type { IBufferCell } from "@xterm/xterm";

import type { AppSettings, TerminalSession } from "../../types";
import {
  terminalManagedCursorCommandNames,
  terminalSoftDarkBlockLightBackground,
} from "./core";
import {
  extractTerminalExecutableName,
  resolveLocalSessionCommandText,
} from "./presentation";

export const defaultLightTerminalBackground = "#f7f7f7";

export const defaultLightTerminalForeground = "#111111";

export const defaultDarkTerminalBackground = "#1e1e2e";

export const defaultDarkTerminalForeground = "#e0e0e0";

export type TerminalRgbColor = {
  red: number;
  green: number;
  blue: number;
};

// 主题色来自颜色选择器时通常是 hex，这里额外兼容 rgb/rgba，供透明背景和光标对比度共用。
export const parseTerminalRgbColor = (
  value: string,
): TerminalRgbColor | undefined => {
  const trimmed = value.trim();
  const shortHexMatch = trimmed.match(
    /^#([\da-f])([\da-f])([\da-f])(?:[\da-f])?$/i,
  );
  if (shortHexMatch) {
    return {
      red: parseInt(shortHexMatch[1].repeat(2), 16),
      green: parseInt(shortHexMatch[2].repeat(2), 16),
      blue: parseInt(shortHexMatch[3].repeat(2), 16),
    };
  }

  const hexMatch = trimmed.match(
    /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})(?:[\da-f]{2})?$/i,
  );
  if (hexMatch) {
    return {
      red: parseInt(hexMatch[1], 16),
      green: parseInt(hexMatch[2], 16),
      blue: parseInt(hexMatch[3], 16),
    };
  }

  const rgbMatch = trimmed.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(?:0|1|\d?\.\d+)\s*)?\)$/i,
  );
  if (!rgbMatch) {
    return undefined;
  }

  const red = Number(rgbMatch[1]);
  const green = Number(rgbMatch[2]);
  const blue = Number(rgbMatch[3]);
  if (
    [red, green, blue].some(
      (channel) => !Number.isInteger(channel) || channel < 0 || channel > 255,
    )
  ) {
    return undefined;
  }
  return { red, green, blue };
};

// 根据主题自动选择终端背景/前景色：如果用户仍为默认值则跟随主题切换，自定义过的保持不变。
export const resolveTerminalColors = (settings: AppSettings) => {
  const isDarkTheme = settings.themeMode === "dark";
  const isDefaultLightBg =
    settings.terminalBackground === defaultLightTerminalBackground;
  const isDefaultLightFg =
    settings.terminalForeground === defaultLightTerminalForeground;
  const isDefaultDarkBg =
    settings.terminalBackground === defaultDarkTerminalBackground;
  const isDefaultDarkFg =
    settings.terminalForeground === defaultDarkTerminalForeground;
  const background = isDarkTheme
    ? isDefaultLightBg
      ? defaultDarkTerminalBackground
      : settings.terminalBackground
    : isDefaultDarkBg
      ? defaultLightTerminalBackground
      : settings.terminalBackground;
  const foreground = isDarkTheme
    ? isDefaultLightFg
      ? defaultDarkTerminalForeground
      : settings.terminalForeground
    : isDefaultDarkFg
      ? defaultLightTerminalForeground
      : settings.terminalForeground;
  return { background, foreground };
};

// xterm 反色属性会用默认背景的 RGB 作为反色前景；背景仍需 alpha=0，避免遮住终端背景图和选区 SVG。
export const buildTransparentTerminalThemeBackground = (background: string) => {
  const rgb = parseTerminalRgbColor(background);
  if (rgb) {
    return `rgba(${rgb.red}, ${rgb.green}, ${rgb.blue}, 0)`;
  }

  // 非常规 CSS 颜色无法可靠保留色相并透明化；保留原有透明兜底，避免意外遮挡背景图。
  return "rgba(0, 0, 0, 0)";
};

// 光标颜色只跟随应用主题：浅色模式黑色，深色模式白色，避免不同 TUI 之间切换时颜色跳变。
export const resolveTerminalCursorTheme = (isDarkTheme: boolean) =>
  isDarkTheme
    ? { cursor: "#f8fafc", cursorAccent: "#111827" }
    : { cursor: "#111827", cursorAccent: "#f8fafc" };

export type TerminalThemeOptions = {
  softenDarkBlocks?: boolean;
};

// 终端彩色文本使用清晰的 ANSI 调色板；浅色终端里 ANSI white 也要落到深灰，避免 ls 高亮发白发虚。
// xterm theme background 始终设为透明，让选区 SVG 覆盖层可以从 canvas 后面透出来。
export const buildTerminalTheme = (
  settings: AppSettings,
  options: TerminalThemeOptions = {},
) => {
  const isDarkTheme = settings.themeMode === "dark";
  const { background, foreground } = resolveTerminalColors(settings);
  const cursorTheme = resolveTerminalCursorTheme(isDarkTheme);
  const shouldSoftenDarkBlocks =
    !isDarkTheme && Boolean(options.softenDarkBlocks);
  const resolvedForeground = shouldSoftenDarkBlocks
    ? terminalSoftDarkBlockLightBackground
    : foreground;
  const resolvedAnsiBlack = shouldSoftenDarkBlocks
    ? terminalSoftDarkBlockLightBackground
    : isDarkTheme
      ? "#020617"
      : "#111827";

  return {
    // canvas 背景透明，但 RGB 取真实背景色，保证 top 等反色行在浅色模式下不会变成黑底黑字。
    background: buildTransparentTerminalThemeBackground(background),
    foreground: resolvedForeground,
    cursor: cursorTheme.cursor,
    cursorAccent: cursorTheme.cursorAccent,
    // 终端选区使用用户指定的柔和紫色，xterm 原生层负责保持文字清晰可读。
    selectionBackground: "#c7c7fb",
    selectionInactiveBackground: "#c7c7fb",
    black: resolvedAnsiBlack,
    red: isDarkTheme ? "#dc2626" : "#b91c1c",
    green: isDarkTheme ? "#059669" : "#047857",
    yellow: isDarkTheme ? "#f59e0b" : "#92400e",
    blue: isDarkTheme ? "#2563eb" : "#1d4ed8",
    magenta: isDarkTheme ? "#9333ea" : "#7e22ce",
    cyan: isDarkTheme ? "#0891b2" : "#0e7490",
    white: isDarkTheme ? "#e5e7eb" : "#374151",
    brightBlack: isDarkTheme ? "#64748b" : "#4b5563",
    brightRed: isDarkTheme ? "#ef4444" : "#991b1b",
    brightGreen: isDarkTheme ? "#10b981" : "#065f46",
    brightYellow: isDarkTheme ? "#fbbf24" : "#78350f",
    brightBlue: isDarkTheme ? "#3b82f6" : "#1e40af",
    brightMagenta: isDarkTheme ? "#a855f7" : "#6b21a8",
    brightCyan: isDarkTheme ? "#06b6d4" : "#155e75",
    brightWhite: isDarkTheme ? "#f9fafb" : "#111827",
  };
};

export type TerminalTheme = ReturnType<typeof buildTerminalTheme>;

// 覆盖光标需要避开 Codex 深浅混合输入行；按单元格实际背景选择反差最大的黑/白色。
export const resolveTerminalPaletteRgbColor = (
  paletteIndex: number,
  theme: TerminalTheme,
) => {
  const ansiPalette = [
    theme.black,
    theme.red,
    theme.green,
    theme.yellow,
    theme.blue,
    theme.magenta,
    theme.cyan,
    theme.white,
    theme.brightBlack,
    theme.brightRed,
    theme.brightGreen,
    theme.brightYellow,
    theme.brightBlue,
    theme.brightMagenta,
    theme.brightCyan,
    theme.brightWhite,
  ];
  const ansiColor = ansiPalette[paletteIndex];
  if (ansiColor) {
    return parseTerminalRgbColor(ansiColor);
  }

  if (paletteIndex >= 16 && paletteIndex <= 231) {
    const colorIndex = paletteIndex - 16;
    const redLevel = Math.floor(colorIndex / 36);
    const greenLevel = Math.floor((colorIndex % 36) / 6);
    const blueLevel = colorIndex % 6;
    const resolveLevel = (level: number) => (level === 0 ? 0 : 55 + level * 40);
    return {
      red: resolveLevel(redLevel),
      green: resolveLevel(greenLevel),
      blue: resolveLevel(blueLevel),
    };
  }

  if (paletteIndex >= 232 && paletteIndex <= 255) {
    const level = 8 + (paletteIndex - 232) * 10;
    return { red: level, green: level, blue: level };
  }

  return undefined;
};

export const resolveTerminalTrueColorRgb = (
  color: number,
): TerminalRgbColor => ({
  red: (color >> 16) & 0xff,
  green: (color >> 8) & 0xff,
  blue: color & 0xff,
});

export const resolveTerminalCellColorRgb = (
  cell: IBufferCell,
  colorType: "foreground" | "background",
  theme: TerminalTheme,
  fallbackBackground: string,
) => {
  const isForeground = colorType === "foreground";
  if (isForeground ? cell.isFgRGB() : cell.isBgRGB()) {
    return resolveTerminalTrueColorRgb(
      isForeground ? cell.getFgColor() : cell.getBgColor(),
    );
  }

  if (isForeground ? cell.isFgPalette() : cell.isBgPalette()) {
    return resolveTerminalPaletteRgbColor(
      isForeground ? cell.getFgColor() : cell.getBgColor(),
      theme,
    );
  }

  return parseTerminalRgbColor(
    isForeground ? theme.foreground : fallbackBackground,
  );
};

export const resolveTerminalCellVisualBackgroundRgb = (
  cell: IBufferCell | undefined,
  theme: TerminalTheme,
  fallbackBackground: string,
) => {
  if (!cell) {
    return parseTerminalRgbColor(fallbackBackground);
  }

  // 反色单元格的视觉背景来自前景色；Codex 输入框经常用这种方式画当前编辑区。
  return cell.isInverse()
    ? resolveTerminalCellColorRgb(cell, "foreground", theme, fallbackBackground)
    : resolveTerminalCellColorRgb(
        cell,
        "background",
        theme,
        fallbackBackground,
      );
};

export const resolveTerminalRelativeLuminance = (color: TerminalRgbColor) => {
  const channels = [color.red, color.green, color.blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
};

// 仅对会在重绘中暴露临时原生光标位置的 TUI 启用宿主光标层，其它 TUI 保持协议原样。
export const shouldUseManagedTerminalCursor = (session?: TerminalSession) => {
  const executableName = extractTerminalExecutableName(
    resolveLocalSessionCommandText(session),
  );
  if (executableName && terminalManagedCursorCommandNames.has(executableName)) {
    return true;
  }
  // 老会话或异常回包可能缺少 localCommand；标题仍保留“codex · cwd”，严格限制在行首以避免误伤同名目录。
  return Boolean(
    session?.kind === "local" && /^\s*codex(?:\s|·|$)/i.test(session.title),
  );
};

// OSC 12 除普通 CSS 十六进制外还允许 rgb:RR/GG/BB 或 16 位分量；统一折算为 8 位 RGB 供光标对比度判断。
export const parseTerminalOscRgbColor = (
  value: string,
): TerminalRgbColor | undefined => {
  const parsedCssColor = parseTerminalRgbColor(value);
  if (parsedCssColor) {
    return parsedCssColor;
  }

  const rgbMatch = value
    .trim()
    .match(/^rgb:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})$/i);
  if (!rgbMatch) {
    return undefined;
  }
  const normalizeChannel = (channel: string) => {
    const rawValue = parseInt(channel, 16);
    const maximum = 16 ** channel.length - 1;
    return Math.round((rawValue / maximum) * 255);
  };
  return {
    red: normalizeChannel(rgbMatch[1]),
    green: normalizeChannel(rgbMatch[2]),
    blue: normalizeChannel(rgbMatch[3]),
  };
};

// 光标属于非文本交互指示物，按 WCAG 非文本对比度算法判断是否需要反色兜底。
export const resolveTerminalColorContrastRatio = (
  first: TerminalRgbColor,
  second: TerminalRgbColor,
) => {
  const lighter = Math.max(
    resolveTerminalRelativeLuminance(first),
    resolveTerminalRelativeLuminance(second),
  );
  const darker = Math.min(
    resolveTerminalRelativeLuminance(first),
    resolveTerminalRelativeLuminance(second),
  );
  return (lighter + 0.05) / (darker + 0.05);
};
