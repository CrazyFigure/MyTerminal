//! Windows ConPTY 终端尺寸同步适配器：桥接 xterm 缓冲区快照与纯领域光标预测算法。

import type { IWindowsPty, Terminal } from '@xterm/xterm';

import {
  buildConptyCursorAlignmentSequence,
  predictConptyCursorRowAfterResize,
  type ConptyViewportLineSnapshot,
} from '../../domain/terminal/conptyResizeSync';
import type { TerminalSession } from '../../types';
import { measureTerminalBufferLineContentColumns } from './core';
import { isWindowsTerminalHost } from './presentation';

// 随包附带新版 OpenConsole（1.24 / Windows 11 24H2+）：
// - 指定 backend + buildNumber 使 xterm 在行数增大时向底部补空行而非从 scrollback 拉回历史，与 ConPTY 对齐；
// - buildNumber >= 21376 保持 reflow 开启，且不启用旧版 Win10 换行启发式。
export const windowsConptyTerminalOptions: IWindowsPty = {
  backend: 'conpty',
  buildNumber: 26100,
};

// 只有 Windows 本机托管的本地终端走 ConPTY；SSH 会话连向远端 Unix PTY，不应套用 ConPTY 规则。
export const isWindowsConptySession = (session?: TerminalSession): boolean =>
  session?.kind === 'local' && isWindowsTerminalHost();

export type ConptyResizeSyncOptions = {
  isWindowsConpty: boolean;
  /// xterm WriteBuffer 当前是否仍有未解析完的实时输出分片；有则通过 FIFO 屏障后再按残余偏差校正。
  hasPendingWrites?: boolean;
};

// 按当前 xterm 可见视口快照计算 ConPTY 缩放后的期望光标行号，并在存在 scrollback 偏差时用标准 VT 序列回正。
export const resizeTerminalWithConptySync = (
  terminal: Terminal,
  nextCols: number,
  nextRows: number,
  options: ConptyResizeSyncOptions,
): void => {
  const oldCols = terminal.cols;
  const oldRows = terminal.rows;
  if (oldCols === nextCols && oldRows === nextRows) {
    return;
  }

  const bufferBefore = terminal.buffer.active;
  const shouldAlignReflow = options.isWindowsConpty
    && bufferBefore.type === 'normal'
    && bufferBefore.baseY > 0
    && oldCols !== nextCols;

  let expectedConptyCursorY: number | undefined;
  if (shouldAlignReflow) {
    const oldBaseY = bufferBefore.baseY;
    const oldCursorY = Math.min(Math.max(0, bufferBefore.cursorY), Math.max(0, oldRows - 1));
    const viewportLines: ConptyViewportLineSnapshot[] = [];
    for (let row = 0; row <= oldCursorY; row += 1) {
      const line = bufferBefore.getLine(oldBaseY + row);
      const isWrapped = Boolean(line?.isWrapped);
      const trimmedWidth = line ? measureTerminalBufferLineContentColumns(line, oldCols) : 0;
      let hasWideCharWrapGap = false;
      if (row > 0 && isWrapped && line) {
        const previousLine = bufferBefore.getLine(oldBaseY + row - 1);
        const previousLastCell = previousLine?.getCell(oldCols - 1);
        const continuationFirstCell = line.getCell(0);
        hasWideCharWrapGap =
          continuationFirstCell?.getWidth() === 2
          && !previousLastCell?.getChars().trim();
      }
      viewportLines.push({
        isWrapped,
        trimmedWidth,
        hasWideCharWrapGap,
      });
    }
    expectedConptyCursorY = predictConptyCursorRowAfterResize({
      oldCols,
      oldRows,
      nextCols,
      nextRows,
      oldCursorY,
      viewportLines,
    });
  }

  terminal.resize(nextCols, nextRows);

  if (expectedConptyCursorY === undefined) {
    return;
  }
  const bufferAfter = terminal.buffer.active;
  if (bufferAfter.type !== 'normal') {
    return;
  }
  const rawDelta = bufferAfter.cursorY - expectedConptyCursorY;
  if (rawDelta === 0) {
    return;
  }

  if (!options.hasPendingWrites) {
    const sequence = buildConptyCursorAlignmentSequence(
      bufferAfter.cursorY,
      expectedConptyCursorY,
      terminal.rows,
    );
    if (sequence) {
      terminal.write(sequence);
    }
    return;
  }

  // 流式输出尚未排空时等前序写入落地后再复核：期间新滚入的行已经把多拉回的 scrollback 顶回去了，只补剩余差额。
  const baseYAfterResize = bufferAfter.baseY;
  const targetExpectedY = expectedConptyCursorY;
  terminal.write('', () => {
    const settledBuffer = terminal.buffer.active;
    if (
      settledBuffer.type !== 'normal'
      || terminal.cols !== nextCols
      || terminal.rows !== nextRows
    ) {
      return;
    }
    if (rawDelta > 0) {
      const scrolledDuringWait = Math.max(0, settledBuffer.baseY - baseYAfterResize);
      const remainingDelta = rawDelta - scrolledDuringWait;
      if (remainingDelta <= 0) {
        return;
      }
      const sequence = buildConptyCursorAlignmentSequence(
        settledBuffer.cursorY,
        settledBuffer.cursorY - remainingDelta,
        terminal.rows,
      );
      if (sequence) {
        terminal.write(sequence);
      }
      return;
    }

    if (settledBuffer.baseY !== baseYAfterResize) {
      return;
    }
    const sequence = buildConptyCursorAlignmentSequence(
      settledBuffer.cursorY,
      targetExpectedY,
      terminal.rows,
    );
    if (sequence) {
      terminal.write(sequence);
    }
  });
};
