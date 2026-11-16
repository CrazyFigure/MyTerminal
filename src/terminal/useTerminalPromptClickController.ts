import { useRef, type RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';

import {
  buildTerminalArrowKeySequence,
  clampTerminalPromptClickColumn,
  countTerminalPromptHorizontalSteps,
  resolveTerminalPromptInputRegion,
  terminalPromptClickMaxDragPx,
  terminalPromptClickMaxVerticalAttempts,
  terminalPromptClickSettleMs,
  terminalPromptClickTimeoutMs,
  type TerminalPromptAnchor,
} from './support';

type TerminalPromptClickControllerOptions = {
  terminalRef: RefObject<Terminal | null>;
  // 当前会话是否为 Claude 类自绘输入框的 TUI（启动命令识别或画面结构探测）。
  isPromptClickEnabled: () => boolean;
  // 复用 IME 锚点的输入框识别结果，保证“点哪里”和“候选框在哪里”判定口径一致。
  resolveTerminalPromptAnchor: () => TerminalPromptAnchor | undefined;
  // 走与键盘输入完全相同的写入通道；返回 false 表示当前不可输入（重放、断开等）。
  sendTerminalInput: (data: string) => boolean;
};

type PendingPromptClick = {
  targetRow: number;
  targetColumn: number;
  deadline: number;
  verticalAttempts: number;
};

type PromptClickPointerDown = {
  x: number;
  y: number;
};

// Claude 类 TUI 在主缓冲区不接管鼠标，单击输入框只会被 xterm 当作清除选区；
// 本控制器把单击翻译成方向键，让光标像在普通编辑框里一样直接跳到点击位置。
export function useTerminalPromptClickController({
  terminalRef,
  isPromptClickEnabled,
  resolveTerminalPromptAnchor,
  sendTerminalInput,
}: TerminalPromptClickControllerOptions) {
  const pointerDownRef = useRef<PromptClickPointerDown | null>(null);
  const pendingClickRef = useRef<PendingPromptClick | null>(null);
  const settleTimerRef = useRef<number | null>(null);

  const clearSettleTimer = () => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  };

  const cancelPendingPromptClick = () => {
    clearSettleTimer();
    pendingClickRef.current = null;
  };

  // 仅在“程序没开鼠标上报、主缓冲区、真实光标正停在输入框里”时介入；否则点击保持 xterm 原生语义。
  const resolveActivePromptRegion = () => {
    const terminal = terminalRef.current;
    if (
      !terminal
      || !isPromptClickEnabled()
      || terminal.buffer.active.type !== 'normal'
      || terminal.modes.mouseTrackingMode !== 'none'
    ) {
      return undefined;
    }
    const anchor = resolveTerminalPromptAnchor();
    if (!anchor) {
      return undefined;
    }
    const buffer = terminal.buffer.active;
    const lastVisibleRow = Math.min(buffer.length - 1, buffer.viewportY + terminal.rows - 1);
    return resolveTerminalPromptInputRegion(
      (row) => buffer.getLine(row),
      anchor.promptStartRow,
      anchor.promptEndRow,
      lastVisibleRow,
      terminal.cols,
    );
  };

  // 光标已与目标同行：按行内字形数补发左右键，完成本次定位。
  const moveCursorWithinRow = (targetColumn: number) => {
    const terminal = terminalRef.current;
    const region = resolveActivePromptRegion();
    if (!terminal || !region) {
      return;
    }
    const buffer = terminal.buffer.active;
    const cursorRow = buffer.baseY + buffer.cursorY;
    const line = buffer.getLine(cursorRow);
    if (!line || cursorRow < region.startRow || cursorRow > region.endRow) {
      return;
    }
    const clampedColumn = clampTerminalPromptClickColumn(line, terminal.cols, targetColumn, region.textStartColumn);
    const steps = countTerminalPromptHorizontalSteps(line, buffer.cursorX, clampedColumn);
    if (steps === 0) {
      return;
    }
    sendTerminalInput(buildTerminalArrowKeySequence(
      steps > 0 ? 'right' : 'left',
      Math.abs(steps),
      terminal.modes.applicationCursorKeysMode,
    ));
  };

  // 上下键按实际光标所在行与目标行的差值发送；TUI 重绘静默后再根据新位置决定继续纵移还是转入行内定位。
  const advancePendingPromptClick = () => {
    settleTimerRef.current = null;
    const pending = pendingClickRef.current;
    const terminal = terminalRef.current;
    if (!pending || !terminal) {
      return;
    }
    if (performance.now() > pending.deadline) {
      pendingClickRef.current = null;
      return;
    }

    const region = resolveActivePromptRegion();
    const buffer = terminal.buffer.active;
    const cursorRow = buffer.baseY + buffer.cursorY;
    // 输入框消失或光标离开输入框（提交、弹出菜单等）时立即放弃，不能把方向键发给别的界面。
    if (
      !region
      || cursorRow < region.startRow
      || cursorRow > region.endRow
      || pending.targetRow < region.startRow
      || pending.targetRow > region.endRow
    ) {
      pendingClickRef.current = null;
      return;
    }

    const rowDelta = pending.targetRow - cursorRow;
    if (rowDelta === 0) {
      pendingClickRef.current = null;
      moveCursorWithinRow(pending.targetColumn);
      return;
    }
    if (pending.verticalAttempts >= terminalPromptClickMaxVerticalAttempts) {
      pendingClickRef.current = null;
      return;
    }
    pending.verticalAttempts += 1;
    const sent = sendTerminalInput(buildTerminalArrowKeySequence(
      rowDelta > 0 ? 'down' : 'up',
      Math.abs(rowDelta),
      terminal.modes.applicationCursorKeysMode,
    ));
    if (!sent) {
      pendingClickRef.current = null;
      return;
    }
    settleTimerRef.current = window.setTimeout(advancePendingPromptClick, terminalPromptClickSettleMs);
  };

  // 输出分片到达说明 TUI 仍在重绘；推迟结算，保证读到的是最终帧的光标位置而不是中间帧。
  const notifyTerminalPromptClickOutput = () => {
    if (!pendingClickRef.current) {
      return;
    }
    clearSettleTimer();
    settleTimerRef.current = window.setTimeout(advancePendingPromptClick, terminalPromptClickSettleMs);
  };

  // 只记录无修饰键的左键单击；双击/三击保留给 xterm 选词选行。
  const handleTerminalPromptClickMouseDown = (event: MouseEvent) => {
    pointerDownRef.current = event.button === 0
      && event.detail <= 1
      && !event.shiftKey
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      ? { x: event.clientX, y: event.clientY }
      : null;
  };

  const handleTerminalPromptClickMouseUp = (event: MouseEvent) => {
    const pointerDown = pointerDownRef.current;
    pointerDownRef.current = null;
    const terminal = terminalRef.current;
    if (
      !pointerDown
      || !terminal
      || event.button !== 0
      || Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > terminalPromptClickMaxDragPx
      || terminal.hasSelection()
      || terminal.cols <= 0
      || terminal.rows <= 0
    ) {
      return;
    }

    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) {
      return;
    }
    const screenRect = screen.getBoundingClientRect();
    const cellWidth = screenRect.width / terminal.cols;
    const cellHeight = screenRect.height / terminal.rows;
    if (cellWidth <= 0 || cellHeight <= 0) {
      return;
    }
    const viewportRow = Math.floor((event.clientY - screenRect.top) / cellHeight);
    const targetColumn = Math.floor((event.clientX - screenRect.left) / cellWidth);
    if (viewportRow < 0 || viewportRow >= terminal.rows || targetColumn < 0) {
      return;
    }

    const region = resolveActivePromptRegion();
    const buffer = terminal.buffer.active;
    const targetRow = buffer.viewportY + viewportRow;
    const cursorRow = buffer.baseY + buffer.cursorY;
    if (
      !region
      || targetRow < region.startRow
      || targetRow > region.endRow
      || cursorRow < region.startRow
      || cursorRow > region.endRow
    ) {
      return;
    }

    // 新的点击覆盖尚未完成的旧定位，避免两次点击的方向键交错叠加。
    cancelPendingPromptClick();
    if (targetRow === cursorRow) {
      moveCursorWithinRow(targetColumn);
      return;
    }
    pendingClickRef.current = {
      targetRow,
      targetColumn,
      deadline: performance.now() + terminalPromptClickTimeoutMs,
      verticalAttempts: 0,
    };
    advancePendingPromptClick();
  };

  // 卸载或切换会话时丢弃未完成的定位，迟到的计时器不能把方向键发给新会话。
  const disposeTerminalPromptClickController = () => {
    cancelPendingPromptClick();
    pointerDownRef.current = null;
  };

  return {
    cancelPendingPromptClick,
    disposeTerminalPromptClickController,
    handleTerminalPromptClickMouseDown,
    handleTerminalPromptClickMouseUp,
    notifyTerminalPromptClickOutput,
  };
}
