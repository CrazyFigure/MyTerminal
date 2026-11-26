/* Windows ConPTY 缩放光标预测与同步序列单元测试。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildConptyCursorAlignmentSequence,
  predictConptyCursorRowAfterResize,
  type ConptyViewportLineSnapshot,
} from './conptyResizeSync';

const makeWrappedPair = (tailWidth: number, firstRowIsWrapped = false): ConptyViewportLineSnapshot[] => [
  { isWrapped: firstRowIsWrapped, trimmedWidth: 80, hasWideCharWrapGap: false },
  { isWrapped: true, trimmedWidth: tailWidth, hasWideCharWrapGap: false },
];

test('predictConptyCursorRowAfterResize: 80x26 拉宽到 95x26 时精确匹配 OpenConsole 实测行号', () => {
  // 复现实测场景：80x26 视口顶部是 1 行孤立续行（上段已在 scrollback），接着 12 条 88 列折行（24 行），第 26 行是提示符。
  const viewportLines: ConptyViewportLineSnapshot[] = [
    { isWrapped: true, trimmedWidth: 8, hasWideCharWrapGap: false },
  ];
  for (let i = 0; i < 12; i += 1) {
    viewportLines.push(...makeWrappedPair(8));
  }
  viewportLines.push({ isWrapped: false, trimmedWidth: 38, hasWideCharWrapGap: false });

  // OpenConsole 实测 CUP 为 ESC[14;38H，对应 0-based cursorY = 13。
  const predicted = predictConptyCursorRowAfterResize({
    oldCols: 80,
    oldRows: 26,
    nextCols: 95,
    nextRows: 26,
    oldCursorY: 25,
    viewportLines,
  });
  assert.equal(predicted, 13);
});

test('predictConptyCursorRowAfterResize: 覆盖拉宽+增高、拉宽+变矮、缩窄+增高与中间行缩窄四种组合', () => {
  // 1. Widen + Grow (80x20 -> 95x26)：1 行孤立续行 + 9 条 88 列折行 -> 1 + 9 = 10（OpenConsole 实测 ESC[11;38H）。
  const widenGrowLines: ConptyViewportLineSnapshot[] = [
    { isWrapped: true, trimmedWidth: 8, hasWideCharWrapGap: false },
  ];
  for (let i = 0; i < 9; i += 1) {
    widenGrowLines.push(...makeWrappedPair(8));
  }
  widenGrowLines.push({ isWrapped: false, trimmedWidth: 38, hasWideCharWrapGap: false });
  assert.equal(
    predictConptyCursorRowAfterResize({
      oldCols: 80,
      oldRows: 20,
      nextCols: 95,
      nextRows: 26,
      oldCursorY: 19,
      viewportLines: widenGrowLines,
    }),
    10,
  );

  // 2. Widen + Shrink (80x26 -> 95x20)：先 reflow 到 13，再裁剪底部空行，结果仍为 13（OpenConsole 实测 ESC[14;38H）。
  const widenShrinkLines: ConptyViewportLineSnapshot[] = [
    { isWrapped: true, trimmedWidth: 8, hasWideCharWrapGap: false },
  ];
  for (let i = 0; i < 12; i += 1) {
    widenShrinkLines.push(...makeWrappedPair(8));
  }
  widenShrinkLines.push({ isWrapped: false, trimmedWidth: 38, hasWideCharWrapGap: false });
  assert.equal(
    predictConptyCursorRowAfterResize({
      oldCols: 80,
      oldRows: 26,
      nextCols: 95,
      nextRows: 20,
      oldCursorY: 25,
      viewportLines: widenShrinkLines,
    }),
    13,
  );

  // 3. Narrow + Grow (95x20 -> 80x26)：19 条 88 列单行折成 38 行，钳制到底行 25（OpenConsole 实测 ESC[26;38H）。
  const narrowGrowLines: ConptyViewportLineSnapshot[] = Array.from({ length: 19 }, () => ({
    isWrapped: false,
    trimmedWidth: 88,
    hasWideCharWrapGap: false,
  }));
  narrowGrowLines.push({ isWrapped: false, trimmedWidth: 38, hasWideCharWrapGap: false });
  assert.equal(
    predictConptyCursorRowAfterResize({
      oldCols: 95,
      oldRows: 20,
      nextCols: 80,
      nextRows: 26,
      oldCursorY: 19,
      viewportLines: narrowGrowLines,
    }),
    25,
  );

  // 4. 光标在中间行时缩窄列宽 (95x26 -> 80x26)：2 条短行 + 8 条 88 列单行 -> 2 + 16 = 18（OpenConsole 实测 ESC[19;38H）。
  const midNarrowLines: ConptyViewportLineSnapshot[] = [
    { isWrapped: false, trimmedWidth: 38, hasWideCharWrapGap: false },
    { isWrapped: false, trimmedWidth: 50, hasWideCharWrapGap: false },
    ...Array.from({ length: 8 }, () => ({
      isWrapped: false,
      trimmedWidth: 88,
      hasWideCharWrapGap: false,
    })),
    { isWrapped: false, trimmedWidth: 38, hasWideCharWrapGap: false },
  ];
  assert.equal(
    predictConptyCursorRowAfterResize({
      oldCols: 95,
      oldRows: 26,
      nextCols: 80,
      nextRows: 26,
      oldCursorY: 10,
      viewportLines: midNarrowLines,
    }),
    18,
  );
});

test('predictConptyCursorRowAfterResize: 宽字符折行空占位与多行提示符偏移处理正确', () => {
  // 10 列宽下前一行末尾因 2 列宽汉字留空 1 列（有效宽 9），续行占 2 列，总宽 11；
  // 扩到 11 列时应合并为 1 行，而不是被错算成 12 列占 2 行。
  const wideGapLines: ConptyViewportLineSnapshot[] = [
    { isWrapped: false, trimmedWidth: 9, hasWideCharWrapGap: false },
    { isWrapped: true, trimmedWidth: 2, hasWideCharWrapGap: true },
    { isWrapped: false, trimmedWidth: 5, hasWideCharWrapGap: false },
  ];
  assert.equal(
    predictConptyCursorRowAfterResize({
      oldCols: 10,
      oldRows: 10,
      nextCols: 11,
      nextRows: 10,
      oldCursorY: 2,
      viewportLines: wideGapLines,
    }),
    1,
  );

  // 光标位于 2 行折行命令的第二行时，保留光标在当前逻辑行内的 1 行偏移。
  const wrappedPromptLines: ConptyViewportLineSnapshot[] = [
    { isWrapped: false, trimmedWidth: 80, hasWideCharWrapGap: false },
    { isWrapped: true, trimmedWidth: 10, hasWideCharWrapGap: false },
    { isWrapped: false, trimmedWidth: 80, hasWideCharWrapGap: false },
    { isWrapped: true, trimmedWidth: 12, hasWideCharWrapGap: false },
  ];
  assert.equal(
    predictConptyCursorRowAfterResize({
      oldCols: 80,
      oldRows: 20,
      nextCols: 100,
      nextRows: 20,
      oldCursorY: 3,
      viewportLines: wrappedPromptLines,
    }),
    2,
  );
});

test('buildConptyCursorAlignmentSequence: 按偏差方向生成标准 VT 对齐序列', () => {
  assert.equal(buildConptyCursorAlignmentSequence(25, 25, 26), '');
  assert.equal(
    buildConptyCursorAlignmentSequence(25, 13, 26),
    `\x1b7\x1b[0m\x1b[26;1H${'\n'.repeat(12)}\x1b8\x1b[14d`,
  );
  assert.equal(
    buildConptyCursorAlignmentSequence(10, 18, 26),
    '\x1b7\x1b[0m\x1b[1;1H\x1b[8L\x1b8\x1b[19d',
  );
});
