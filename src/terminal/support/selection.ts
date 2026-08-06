//! 终端选区快照、缓冲区文本读取与字符宽度换算。

import type { Terminal } from "@xterm/xterm";

import type { TerminalSelectionPosition } from "./core";

export const normalizeTerminalMatchSelection = (selection: string) => {
  const normalized = selection.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized || !normalized.trim() || normalized.includes("\n")) {
    return "";
  }
  return normalized;
};

export const normalizeTerminalSelectionSnapshotText = (selection: string) =>
  selection
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ");

export const cloneTerminalSelectionPosition = (
  position: TerminalSelectionPosition,
): TerminalSelectionPosition => ({
  start: { x: position.start.x, y: position.start.y },
  end: { x: position.end.x, y: position.end.y },
});

export const terminalSelectionPositionHasRange = (
  position: TerminalSelectionPosition,
) => position.start.x !== position.end.x || position.start.y !== position.end.y;

export const resolveTerminalSelectionLength = (
  position: TerminalSelectionPosition,
  cols: number,
) =>
  (position.end.y - position.start.y) * cols -
  position.start.x +
  position.end.x;

// 选区快照校验直接从当前缓冲区重读文本，避免把已经被 scrollback trim 或 resize reflow 改写的旧坐标硬恢复出来。
export const readTerminalSelectionTextFromBuffer = (
  terminal: Terminal,
  position: TerminalSelectionPosition,
) => {
  const buffer = terminal.buffer.active;
  if (
    position.start.y < 0 ||
    position.end.y < position.start.y ||
    position.start.y >= buffer.length ||
    position.end.y >= buffer.length
  ) {
    return "";
  }

  const result: string[] = [];
  const firstLine = buffer.getLine(position.start.y);
  if (!firstLine) {
    return "";
  }

  const firstRowEndColumn =
    position.start.y === position.end.y ? position.end.x : undefined;
  result.push(
    firstLine.translateToString(true, position.start.x, firstRowEndColumn),
  );

  for (let row = position.start.y + 1; row <= position.end.y - 1; row += 1) {
    const line = buffer.getLine(row);
    if (!line) {
      return "";
    }
    const lineText = line.translateToString(true);
    if (line.isWrapped && result.length > 0) {
      result[result.length - 1] += lineText;
    } else {
      result.push(lineText);
    }
  }

  if (position.start.y !== position.end.y) {
    const finalLine = buffer.getLine(position.end.y);
    if (!finalLine) {
      return "";
    }
    const lineText = finalLine.translateToString(true, 0, position.end.x);
    if (finalLine.isWrapped && result.length > 0) {
      result[result.length - 1] += lineText;
    } else {
      result.push(lineText);
    }
  }

  return result.join("\n");
};

// 复用 xterm search addon 的行合并思路：软换行需要当成同一条逻辑行搜索，硬换行才截断。
export const translateTerminalBufferLineWithWrap = (
  terminal: Terminal,
  startRow: number,
) => {
  const buffer = terminal.buffer.active;
  const parts: string[] = [];
  const offsets = [0];
  let row = startRow;
  let line = buffer.getLine(row);

  while (line) {
    const nextLine = buffer.getLine(row + 1);
    const wrapsToNextLine = Boolean(nextLine?.isWrapped);
    let text = line.translateToString(!wrapsToNextLine);
    if (wrapsToNextLine && nextLine) {
      const lastCell = line.getCell(line.length - 1);
      const firstNextCell = nextLine.getCell(0);
      // 宽字符被软换行拆到下一行时，xterm 会在上一行末尾留下占位空格；搜索文本里需要去掉这个视觉占位。
      if (
        lastCell?.getCode() === 0 &&
        lastCell.getWidth() === 1 &&
        firstNextCell?.getWidth() === 2
      ) {
        text = text.slice(0, -1);
      }
    }

    parts.push(text);
    if (!wrapsToNextLine) {
      break;
    }
    offsets.push(offsets[offsets.length - 1] + text.length);
    row += 1;
    line = nextLine;
  }

  return {
    text: parts.join(""),
    offsets,
    endRowExclusive: startRow + offsets.length,
  };
};

// 字符串索引要转换回终端单元格宽度，组合字符和全角字符都不能按 JS length 直接当列数。
export const stringLengthToTerminalBufferSize = (
  terminal: Terminal,
  row: number,
  length: number,
) => {
  const line = terminal.buffer.active.getLine(row);
  if (!line) {
    return 0;
  }

  let bufferSize = length;
  for (let column = 0; column < bufferSize; column += 1) {
    const cell = line.getCell(column);
    if (!cell) {
      break;
    }
    const chars = cell.getChars();
    if (chars.length > 1) {
      bufferSize -= chars.length - 1;
    }
    const nextCell = line.getCell(column + 1);
    if (nextCell?.getWidth() === 0) {
      bufferSize += 1;
    }
  }
  return bufferSize;
};

// 常见 Unix、RHEL、PowerShell 与 cmd 提示符都要求从逻辑行首完整命中，避免把日志里的邮箱、路径或大于号误认成命令行。
