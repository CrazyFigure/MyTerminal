//! Claude 类 TUI 输入框的“点击定位光标”纯算法：输入区几何、点击列钳制与方向键步数。
//
// TUI 自己维护输入缓冲与光标，宿主无法直接改写其光标位置；只能把一次点击翻译成等效的方向键序列，
// 由程序按自身的折行与字形规则移动。本模块只做与 DOM、React 无关的计算，便于独立推理。

import type { IBufferLine } from "@xterm/xterm";

import {
  measureTerminalBufferLineContentColumns,
  measureTerminalPromptGlyphEndColumn,
  terminalPromptBorderMinCharacters,
} from "./core";

// 输入框最多向下查找的行数；超过仍未遇到下边线时只把提示符所在行视为输入区，避免误吞状态栏。
export const terminalPromptClickMaxInputRows = 40;

// 按下与抬起之间的位移超过该像素即视为拖拽选区，不再当作点击定位。
export const terminalPromptClickMaxDragPx = 4;

// 跨行定位先发上下键，等 TUI 重绘静默这么久后再按实际光标位置补发左右键。
export const terminalPromptClickSettleMs = 40;

// 跨行定位的整体时限；TUI 迟迟不响应（忙碌、卡死）时放弃，绝不在之后的任意时刻补发按键。
export const terminalPromptClickTimeoutMs = 800;

// 上下键可能因程序按逻辑行而非视觉行移动而一次到不了位；按实际结果最多补发这么多轮。
export const terminalPromptClickMaxVerticalAttempts = 3;

// 单次定位最多发送的方向键数量，防止异常坐标生成超长输入。
export const terminalPromptClickMaxSteps = 2000;

// 点击定位可用的输入区：首尾行为 buffer 绝对行号（含），textStartColumn 为文字起始列。
export type TerminalPromptInputRegion = {
  startRow: number;
  endRow: number;
  textStartColumn: number;
};

// 输入框边线：新版 Claude 为整行 `─`，旧版圆角框首尾带 `╭╮` / `╰╯`。
const isTerminalPromptFrameBorderText = (text: string) => {
  const compact = text.replace(/\s/g, "");
  return (
    compact.length >= terminalPromptBorderMinCharacters &&
    /^[╭╰]?[─━═-]+[╮╯]?$/.test(compact)
  );
};

// 以提示符行为起点，向下直到输入框下边线为止都是输入内容；找不到下边线时退回提示符所在的软换行组。
export const resolveTerminalPromptInputRegion = (
  readLine: (row: number) => IBufferLine | undefined,
  promptStartRow: number,
  promptEndRow: number,
  lastVisibleRow: number,
  columns: number,
): TerminalPromptInputRegion | undefined => {
  const promptLine = readLine(promptStartRow);
  if (!promptLine) {
    return undefined;
  }

  // 有提示符时文字从提示符及其后空格之后开始；提示符被擦掉时退回行首缩进。
  let textStartColumn = measureTerminalPromptGlyphEndColumn(promptLine, columns);
  if (textStartColumn <= 0) {
    const text = promptLine.translateToString(true);
    textStartColumn = text.length - text.trimStart().length;
  }

  let endRow = Math.max(promptStartRow, promptEndRow);
  const searchEnd = Math.min(
    lastVisibleRow,
    promptStartRow + terminalPromptClickMaxInputRows,
  );
  for (let row = promptStartRow + 1; row <= searchEnd; row += 1) {
    const line = readLine(row);
    if (!line) {
      break;
    }
    if (isTerminalPromptFrameBorderText(line.translateToString(true))) {
      endRow = Math.max(endRow, row - 1);
      break;
    }
  }

  return { startRow: promptStartRow, endRow, textStartColumn };
};

// 把点击列钳制到该行文字范围内：宽字符右半格归到字符起点，越过行尾时停在最后一个字符之后。
// 不能越界，否则左/右键会被 TUI 解释为跨行移动，把光标带到上一行或下一行。
export const clampTerminalPromptClickColumn = (
  line: IBufferLine,
  columns: number,
  column: number,
  textStartColumn: number,
) => {
  let target = Math.max(0, Math.min(column, columns - 1));
  if (target > 0 && line.getCell(target)?.getWidth() === 0) {
    target -= 1;
  }
  const contentEnd = Math.max(
    textStartColumn,
    measureTerminalBufferLineContentColumns(line, columns),
  );
  return Math.min(Math.max(target, textStartColumn), contentEnd);
};

// 同一行内从 fromColumn 走到 toColumn 需要的左右键次数：每个字形（宽字符、组合 emoji）只算一步，
// 宽字符的占位格（宽度 0）不计数。正数表示向右，负数表示向左。
export const countTerminalPromptHorizontalSteps = (
  line: IBufferLine,
  fromColumn: number,
  toColumn: number,
) => {
  const start = Math.min(fromColumn, toColumn);
  const end = Math.max(fromColumn, toColumn);
  let steps = 0;
  for (let column = start; column < end; column += 1) {
    if ((line.getCell(column)?.getWidth() ?? 1) > 0) {
      steps += 1;
    }
  }
  steps = Math.min(steps, terminalPromptClickMaxSteps);
  return toColumn >= fromColumn ? steps : -steps;
};

// 方向键编码随 DECCKM 变化：应用光标键模式下为 SS3 形式，否则为 CSI 形式，与 xterm 键盘输入保持一致。
export const buildTerminalArrowKeySequence = (
  direction: "up" | "down" | "left" | "right",
  count: number,
  applicationCursorKeys: boolean,
) => {
  const finalByte = { up: "A", down: "B", right: "C", left: "D" }[direction];
  const key = applicationCursorKeys ? `\x1bO${finalByte}` : `\x1b[${finalByte}`;
  return key.repeat(Math.max(0, Math.min(count, terminalPromptClickMaxSteps)));
};
