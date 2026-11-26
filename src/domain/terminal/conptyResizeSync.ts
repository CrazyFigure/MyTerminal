//! Windows ConPTY 缩放后的光标行号预测与同步序列构造。
//!
//! 背景：Windows ConPTY（OpenConsole）内部没有 scrollback（ybase 恒为 0），
//! 而 xterm.js 在存在大量历史日志（ybase > 0）时：
//! 1. 行数增大时，未启用 `windowsPty` 的 xterm 会从 scrollback 向下拉回历史行并下移光标，
//!    ConPTY 却保持光标原地不动并在底部补空行；
//! 2. 即使启用 `windowsPty`，列宽拉宽导致视口内折行合并时，xterm 的 `_reflowLargerAdjustViewport`
//!    仍会优先从 scrollback 拉回历史行并让提示符停在底部，而 ConPTY 会直接把光标上移；
//! 3. 列宽缩窄且光标下方存在空行时，xterm 仍把顶行推进 scrollback 而光标不动，
//!    ConPTY 则把光标下移占用底部空行。
//! 两侧一旦出现行号偏差，PSReadLine 下一次按键通过 `GetConsoleScreenBufferInfo` 读到旧行号并发出
//! `CSI row;col H`，就会把用户输入写到上方已经输出的日志区域里。
//!
//! 本模块不依赖 DOM、React 或 xterm 运行时，只做纯几何预测与控制序列拼装。

/// 缩放前 ConPTY 可见视口内的单个物理行快照（对应 xterm 的 `[baseY .. baseY + cursorY]`）。
export type ConptyViewportLineSnapshot = {
  /// 该行在 xterm 中是否为上一物理行的软换行续行。
  isWrapped: boolean;
  /// 去掉行尾空白后的显示列宽（0..oldCols）。
  trimmedWidth: number;
  /// 若该行是软换行续行，且因行首为 2 列宽字符导致上一物理行末留了 1 列空占位，则为 true。
  hasWideCharWrapGap: boolean;
};

export type ConptyCursorPredictionInput = {
  oldCols: number;
  oldRows: number;
  nextCols: number;
  nextRows: number;
  oldCursorY: number;
  /// 视口从顶部到光标所在行（含）的物理行快照，长度应为 `oldCursorY + 1`。
  viewportLines: readonly ConptyViewportLineSnapshot[];
};

/// 预测 Windows ConPTY 在 `ResizePseudoConsole(nextCols, nextRows)` 后的 0-based 光标行号。
///
/// 实测 OpenConsole 1.24 行为：先按 `nextCols` 对当前视口内（无 scrollback）的逻辑行做 reflow，
/// 再按 `nextRows` 裁剪/补齐底部空行，因此最终光标行号等于：
/// `min(nextRows - 1, 视口内光标逻辑行上方重排后的物理行数 + 光标在其逻辑行内的行偏移)`。
export const predictConptyCursorRowAfterResize = (
  input: ConptyCursorPredictionInput,
): number => {
  const {
    oldCols,
    nextCols,
    nextRows,
    oldCursorY,
    viewportLines,
  } = input;
  const maxNextRow = Math.max(0, nextRows - 1);
  if (oldCursorY <= 0 || oldCols <= 0 || nextCols <= 0 || viewportLines.length === 0) {
    return Math.min(maxNextRow, Math.max(0, oldCursorY));
  }

  const clampedCursorY = Math.min(oldCursorY, viewportLines.length - 1);
  if (oldCols === nextCols) {
    return Math.min(maxNextRow, clampedCursorY);
  }

  // 找到光标所在逻辑行在当前视口内的起始物理行；xterm 默认不重排光标所在逻辑行，保留其内部行偏移。
  let cursorLogicalStart = clampedCursorY;
  while (cursorLogicalStart > 0 && viewportLines[cursorLogicalStart].isWrapped) {
    cursorLogicalStart -= 1;
  }
  const cursorRowOffsetInLogicalLine = clampedCursorY - cursorLogicalStart;

  // 只把 `[0 .. cursorLogicalStart - 1]` 归组为 ConPTY 视口内的独立逻辑行：
  // 视口第 0 行在 ConPTY 里没有上方 scrollback 可衔接，即使原标记为 isWrapped 也必须视为独立行首。
  let nextRowsAboveCursorLogicalStart = 0;
  let lineStart = 0;
  while (lineStart < cursorLogicalStart) {
    let lineEnd = lineStart;
    while (
      lineEnd + 1 < cursorLogicalStart
      && viewportLines[lineEnd + 1].isWrapped
    ) {
      lineEnd += 1;
    }

    let totalColumns = 0;
    for (let row = lineStart; row < lineEnd; row += 1) {
      const gap = viewportLines[row + 1].hasWideCharWrapGap ? 1 : 0;
      totalColumns += Math.max(0, oldCols - gap);
    }
    totalColumns += Math.max(0, Math.min(oldCols, viewportLines[lineEnd].trimmedWidth));

    const reflowedPhysicalRows = totalColumns <= 0
      ? 1
      : Math.ceil(totalColumns / nextCols);
    nextRowsAboveCursorLogicalStart += reflowedPhysicalRows;
    lineStart = lineEnd + 1;
  }

  return Math.min(
    maxNextRow,
    nextRowsAboveCursorLogicalStart + cursorRowOffsetInLogicalLine,
  );
};

/// 根据 xterm 缩放后的光标行号与 ConPTY 预测行号，构造对齐视口所需的标准 VT 序列。
///
/// - `delta > 0`（xterm 光标偏低，常见于拉宽列宽后从 scrollback 拉回了 `delta` 行）：
///   在视口底行输出 `delta` 个换行把多拉回的顶行推回 scrollback，再将光标相对上移 `delta` 行。
/// - `delta < 0`（xterm 光标偏高，常见于缩窄列宽时 ConPTY 下移占用了底部空行而 xterm 推入了 scrollback）：
///   在视口顶行插入 `|delta|` 个空行（挤掉底部空行），再将光标相对下移 `|delta|` 行。
/// - `delta === 0` 时返回空串，不做任何写入。
export const buildConptyCursorAlignmentSequence = (
  xtermCursorY: number,
  expectedConptyCursorY: number,
  rows: number,
): string => {
  if (rows <= 0) {
    return '';
  }
  const clampedExpectedY = Math.min(rows - 1, Math.max(0, expectedConptyCursorY));
  const clampedXtermY = Math.min(rows - 1, Math.max(0, xtermCursorY));
  const delta = clampedXtermY - clampedExpectedY;
  if (delta === 0) {
    return '';
  }

  // 使用 DECSC/DECRC 保留当前 SGR、字符集与光标列号；先复位 SGR 再滚动/插行，避免新空行带入异常底色。
  // 注意：xterm.js 的 DECSC 按绝对行号 `ybase + y` 存盘，DECRC 还原时会减去滚屏后的新 ybase，
  // 且在 scrollback 写满（lines.isFull）时 ybase 不再递增；因此 DECRC 后必须用 VPA（CSI row d）
  // 显式落到目标 1-based 行号，既不依赖 scrollback 是否满载，也绝不会发生双重偏移。
  const targetRow = clampedExpectedY + 1;
  if (delta > 0) {
    return `\x1b7\x1b[0m\x1b[${rows};1H${'\n'.repeat(delta)}\x1b8\x1b[${targetRow}d`;
  }

  const shiftDown = -delta;
  return `\x1b7\x1b[0m\x1b[1;1H\x1b[${shiftDown}L\x1b8\x1b[${targetRow}d`;
};
