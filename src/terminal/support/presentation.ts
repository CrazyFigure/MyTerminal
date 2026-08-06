//! 终端会话识别、横向列策略与背景图片展示规则。

import type { CSSProperties } from "react";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";

import type { AppSettings, TerminalSession } from "../../types";
import {
  terminalAiAgentCommandNames,
  terminalClaudeMinimumContrastRatio,
  terminalHideLocalCursorCommandNames,
  terminalHorizontalColumnGrowthStep,
  terminalHorizontalMaxColumns,
  terminalImeAnchorCommandNames,
  terminalLowerContrastCommandNames,
  terminalMinimumContrastRatio,
  terminalNativeCtrlVPasteCommandNames,
  terminalSoftDarkBlockCommandNames,
} from "./core";

export const roundHorizontalColumns = (
  requiredColumns: number,
  visibleColumns: number,
) => {
  if (requiredColumns <= visibleColumns) {
    return visibleColumns;
  }
  const roundedColumns =
    Math.ceil(requiredColumns / terminalHorizontalColumnGrowthStep) *
    terminalHorizontalColumnGrowthStep;
  return Math.min(
    terminalHorizontalMaxColumns,
    Math.max(visibleColumns, roundedColumns),
  );
};

// 本地终端新会话直接带 localCommand；旧会话或旧后端回退到“命令 · 目录”的标签格式解析。
export const resolveLocalSessionCommandText = (session?: TerminalSession) => {
  if (session?.kind !== "local") {
    return "";
  }
  if (session.localCommand?.trim()) {
    return session.localCommand.trim();
  }

  const titleSeparatorIndex = session.title.indexOf(" · ");
  return titleSeparatorIndex > 0
    ? session.title.slice(0, titleSeparatorIndex).trim()
    : "";
};

// 只取命令行第一个可执行文件名，兼容 PowerShell `&`、Windows 引号路径和 .cmd/.exe/.ps1/.bat 后缀。
export const extractTerminalExecutableName = (commandText: string) => {
  const commandHeadMatch = commandText.match(
    /^\s*(?:&\s*)?(?:"([^"]+)"|'([^']+)'|(\S+))/,
  );
  const commandHead =
    commandHeadMatch?.[1] ??
    commandHeadMatch?.[2] ??
    commandHeadMatch?.[3] ??
    "";
  const executableName = commandHead.replace(/\\/g, "/").split("/").pop() ?? "";
  return executableName.replace(/\.(?:cmd|exe|ps1|bat)$/i, "").toLowerCase();
};

// AI Agent 会话按全屏 TUI 处理，用于套用光标、滚轮和对比度等专用渲染策略。
export const isTerminalAiAgentSession = (session?: TerminalSession) => {
  const executableName = extractTerminalExecutableName(
    resolveLocalSessionCommandText(session),
  );
  return executableName
    ? terminalAiAgentCommandNames.has(executableName)
    : false;
};

// 部分 AI TUI 自绘输入光标，隐藏 xterm 光标可避免双光标；依赖终端光标的程序需排除。
export const shouldHideLocalTerminalCursor = (session?: TerminalSession) => {
  const executableName = extractTerminalExecutableName(
    resolveLocalSessionCommandText(session),
  );
  return executableName
    ? terminalHideLocalCursorCommandNames.has(executableName)
    : false;
};

// 只在浅色 AI TUI 内软化黑色背景块，避免影响普通终端里 top/htop 等标准 ANSI 表现。
export const shouldUseSoftDarkBlocks = (session?: TerminalSession) => {
  const executableName = extractTerminalExecutableName(
    resolveLocalSessionCommandText(session),
  );
  return executableName
    ? terminalSoftDarkBlockCommandNames.has(executableName)
    : false;
};

// Claude 菜单高亮依赖低对比浅色调，单独降低兜底强度以保留原始高亮语义。
export const resolveTerminalMinimumContrastRatio = (
  session?: TerminalSession,
) => {
  const executableName = extractTerminalExecutableName(
    resolveLocalSessionCommandText(session),
  );
  return executableName && terminalLowerContrastCommandNames.has(executableName)
    ? terminalClaudeMinimumContrastRatio
    : terminalMinimumContrastRatio;
};

// 只有自绘输入框且 xterm cursor 与可见输入框分离的 CLI 需要重定位中文输入法锚点。
export const shouldAnchorTerminalImeToPrompt = (session?: TerminalSession) => {
  const executableName = extractTerminalExecutableName(
    resolveLocalSessionCommandText(session),
  );
  return executableName
    ? terminalImeAnchorCommandNames.has(executableName)
    : false;
};

// 宿主平台只用于决定是否把 Ctrl+V 交还给 WebView 原生 paste；其它平台保留 Claude 自己的快捷键绑定。
export const isWindowsTerminalHost = () =>
  typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

// 仅直接启动的本地 Claude 会话使用 Windows 原生 Ctrl+V 粘贴，其它终端程序继续收到 \x16。
export const shouldUseNativeCtrlVPaste = (session?: TerminalSession) => {
  const executableName = extractTerminalExecutableName(
    resolveLocalSessionCommandText(session),
  );
  return executableName
    ? terminalNativeCtrlVPasteCommandNames.has(executableName)
    : false;
};

export const directImageUrlPattern =
  /^(https?:|data:|blob:|asset:|http:\/\/asset\.localhost)/i;

export const windowsAbsolutePathPattern = /^[a-z]:[\\/]/i;

export const isLocalImagePath = (value: string) => {
  const trimmed = value.trim();
  return Boolean(
    trimmed.startsWith("file://") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    windowsAbsolutePathPattern.test(trimmed),
  );
};

export const normalizeLocalFilePath = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith("file://")) {
    return trimmed;
  }

  try {
    return decodeURIComponent(new URL(trimmed).pathname).replace(
      /^\/([a-z]:[\\/])/i,
      "$1",
    );
  } catch {
    return trimmed.replace(/^file:\/+/i, "");
  }
};

export const resolveTerminalBackgroundImage = (value?: string) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (directImageUrlPattern.test(trimmed)) {
    return trimmed;
  }
  if (isLocalImagePath(trimmed) && isTauri()) {
    return convertFileSrc(normalizeLocalFilePath(trimmed));
  }
  return trimmed;
};

// 远程 http(s) 背景图需要走后端下载绕开防盗链，其余(本地路径、data:、asset:)由 CSS 直接加载。
export const isRemoteHttpImage = (value?: string) => {
  const trimmed = value?.trim().toLowerCase();
  return Boolean(
    trimmed &&
    (trimmed.startsWith("http://") || trimmed.startsWith("https://")),
  );
};

// resolvedImage 由调用方决定：本地/asset 直接解析，远程 http(s) 图片先经后端下载成 data URL 再传入。
export const buildTerminalBackgroundImageStyle = (
  settings: AppSettings,
  resolvedImage: string | undefined,
): CSSProperties | undefined => {
  if (!resolvedImage) {
    return undefined;
  }

  const opacity = Math.min(
    1,
    Math.max(0, settings.terminalBackgroundImageOpacity ?? 0.18),
  );
  const fit = settings.terminalBackgroundImageFit ?? "cover";
  const baseStyle: CSSProperties = {
    backgroundImage: `url("${resolvedImage.replace(/"/g, '\\"')}")`,
    opacity,
  };

  // 背景适配只作用于终端区域，不影响应用外壳；不同图片比例由用户选择填充策略。
  if (fit === "contain") {
    return {
      ...baseStyle,
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
      backgroundSize: "contain",
    };
  }
  if (fit === "stretch") {
    return {
      ...baseStyle,
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
      backgroundSize: "100% 100%",
    };
  }
  if (fit === "tile") {
    return {
      ...baseStyle,
      backgroundPosition: "top left",
      backgroundRepeat: "repeat",
      backgroundSize: "auto",
    };
  }
  if (fit === "center") {
    return {
      ...baseStyle,
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
      backgroundSize: "auto",
    };
  }
  return {
    ...baseStyle,
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    backgroundSize: "cover",
  };
};

// 浅色模式的默认终端配色；深色模式使用暗底亮字避免白屏刺眼。
