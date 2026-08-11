// 终端功能域公共入口。
export { TerminalSplitGrid } from './TerminalSplitGrid';
export {
  applySplitDrop,
  assignSessionToPane,
  closeSplitPane,
  createSplitLayout,
  findSplitPaneAt,
  findSplitPaneBySession,
  isSplitLayoutActive,
  pruneSplitLayout,
  removeSessionFromSplitLayout,
  replaceSessionInSplitLayout,
  resolveSplitDropTarget,
  resolveTopLeftPane,
  splitMaskToBounds,
  splitMaskToGridArea,
  SPLIT_FULL_MASK,
  SPLIT_MAX_PANES,
  type SplitCellMask,
  type SplitDirection,
  type SplitDropTarget,
  type SplitLayout,
  type SplitPane,
} from './splitLayout';
export {
  clampSplitRatio,
  DEFAULT_SPLIT_RATIOS,
  resolveMinPaneRatio,
  resolveSplitDividers,
  type SplitDivider,
  type SplitRatios,
} from './splitRatios';
