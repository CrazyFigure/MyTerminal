/* 功能域规则：分屏比例的推导全部是纯函数，不依赖 DOM、React 或 Store，可独立推理与测试。 */

import type { SplitCellMask, SplitLayout, SplitPane } from './splitLayout';

// 2×2 网格上最多只存在一条竖线和一条横线，因此整个分屏的可调自由度就是两个数字：
// column 是竖线的横向位置，row 是横线的纵向位置，都是相对终端区的归一化比例（0~1）。
//
// 二分屏、三分格、四分格的差别**不在这两个数字**，而在每条线的线段跨度：
// 三分格「左上/右上/下半」里，竖线只存在于上半行，下半是一整块没有可拖之处。
// 这个跨度由 resolveSplitDividers 直接从掩码几何推导，因此不需要为 2/3/4 分屏各写一套分支，
// 带空位的布局（四分格关掉一格）也自然落在同一条规则里。
export type SplitRatios = {
  column: number;
  row: number;
};

export const DEFAULT_SPLIT_RATIOS: SplitRatios = { column: 0.5, row: 0.5 };

/** 把比例写进容器的 CSS 变量。网格轨道、分隔条定位、落点指示层都读这两个变量，
 *  所以一次写入就能让三者保持一致；拖拽中的高频更新也走这里，不触发 React 重渲染。 */
export function applySplitRatiosToElement(element: HTMLElement, ratios: SplitRatios): void {
  element.style.setProperty('--split-column-ratio', String(ratios.column));
  element.style.setProperty('--split-row-ratio', String(ratios.row));
}

// 每格至少要留下的宽/高。只卡比例的话，窗口很宽时 15% 仍嫌宽、窗口很窄时 15% 已看不清内容，
// 因此比例与像素两个下限取更严格的一方。上限压在 0.45：容器极小时若下限越过 0.5，
// 可调范围会首尾颠倒（min > max），clamp 结果反而跳到另一侧。
const MIN_PANE_RATIO = 0.15;
const MIN_PANE_PX = 140;
const MAX_MIN_PANE_RATIO = 0.45;

// containerSize 是该方向上终端区的像素长度（竖线看宽度，横线看高度）。
export const resolveMinPaneRatio = (containerSize: number) => {
  if (!Number.isFinite(containerSize) || containerSize <= 0) {
    return MIN_PANE_RATIO;
  }
  return Math.min(MAX_MIN_PANE_RATIO, Math.max(MIN_PANE_RATIO, MIN_PANE_PX / containerSize));
};

// 把比例夹在「两侧都不小于最小值」的区间内，保证任何一格都不会被拖成一条缝。
export const clampSplitRatio = (ratio: number, containerSize: number) => {
  const min = resolveMinPaneRatio(containerSize);
  if (!Number.isFinite(ratio)) {
    return 0.5;
  }
  return Math.min(1 - min, Math.max(min, ratio));
};

// 单元格 (row, col) 对应的掩码位，与 splitLayout 的 bit 约定一致：
// bit0 左上 / bit1 右上 / bit2 左下 / bit3 右下，即 1 << (row * 2 + col)。
const cellBit = (row: number, col: number): SplitCellMask => 1 << (row * 2 + col);

const paneAtCell = (panes: SplitPane[], row: number, col: number): SplitPane | undefined =>
  panes.find((pane) => (pane.mask & cellBit(row, col)) !== 0);

// 线段沿自身法线方向的跨度：full 贯穿整个终端区，first 只占分隔线之前那半，second 只占之后那半。
// 对竖线来说 first/second 指上半/下半（由横线定界），对横线来说指左半/右半（由竖线定界）。
export type SplitDividerSpan = 'full' | 'first' | 'second';

export type SplitDividerAxis = 'column' | 'row' | 'both';

export type SplitDivider =
  | { id: 'column'; axis: 'column'; span: SplitDividerSpan }
  | { id: 'row'; axis: 'row'; span: SplitDividerSpan }
  // 四分格中心：两条线在此交汇，给一个能同时改变两个比例的手柄，省去分别拖两次。
  | { id: 'center'; axis: 'both' };

// 两段都在 → 贯穿；只有一段 → 按它落在前半还是后半收缩；一段都没有 → 该方向没有可拖的线。
const resolveSpan = (segments: number[]): SplitDividerSpan | null => {
  if (segments.length === 2) {
    return 'full';
  }
  if (segments.length === 0) {
    return null;
  }
  return segments[0] === 0 ? 'first' : 'second';
};

// 从布局推导出该画哪几条分隔条。
//
// 判定只有一条：竖线在第 r 行存在，当且仅当该行左右两个单元格**分属不同格子**；
// 横线在第 c 列存在，判定完全对称。跨两个单元格的格子（半边、整屏）自然不会和自己产生分隔线，
// 于是三分格里那条半长的竖线、二分屏里唯一的一条线都由同一段代码得出。
export const resolveSplitDividers = (layout: SplitLayout): SplitDivider[] => {
  const { panes } = layout;

  const columnRows = [0, 1].filter((row) => {
    const left = paneAtCell(panes, row, 0);
    const right = paneAtCell(panes, row, 1);
    return Boolean(left && right && left.id !== right.id);
  });
  const rowColumns = [0, 1].filter((col) => {
    const top = paneAtCell(panes, 0, col);
    const bottom = paneAtCell(panes, 1, col);
    return Boolean(top && bottom && top.id !== bottom.id);
  });

  const columnSpan = resolveSpan(columnRows);
  const rowSpan = resolveSpan(rowColumns);

  const dividers: SplitDivider[] = [];
  if (columnSpan) {
    dividers.push({ id: 'column', axis: 'column', span: columnSpan });
  }
  if (rowSpan) {
    dividers.push({ id: 'row', axis: 'row', span: rowSpan });
  }
  // 只有两条线都贯穿（即真正的四分格）时中心才是一个交点；三分格的中心落在某一格内部，
  // 放手柄会挡住终端内容，也没有"同时拖两个方向"的语义。
  if (columnSpan === 'full' && rowSpan === 'full') {
    dividers.push({ id: 'center', axis: 'both' });
  }
  return dividers;
};
