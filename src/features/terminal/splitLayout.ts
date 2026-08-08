/* 功能域规则：分屏布局的全部判定都是纯函数，不依赖 DOM、React 或 Store，可独立推理与测试。 */

// 分屏最多 2×2 四格，且形态封闭（整屏 / 左右 / 上下 / 三分 / 四分）。因此不用嵌套二叉树，
// 直接把每个分屏表达为 2×2 网格上的一个矩形，用 4 bit 掩码表示它占据哪些单元：
//
//   bit0 = 左上   bit1 = 右上
//   bit2 = 左下   bit3 = 右下
//
// 这样「矩形是否合法」「关掉一格后剩下的还是不是矩形」都退化成位运算，
// 三分格（一格独占整个半边）也只是一个跨两单元的掩码，不需要特殊分支。

export type SplitCellMask = number;

export type SplitPane = {
  // 分屏格自身的稳定标识，跨重排保持不变，供 React key 与拖拽落点引用。
  id: string;
  mask: SplitCellMask;
  // 该格自己的标签页顺序。每格都有独立标签栏，因此一格可以挂多个会话。
  // 空数组表示这是一个空位：只在四分格关掉其中一格时保留，其余情况都会被回收。
  sessionIds: string[];
  // 该格当前显示的标签。非空格子里它必定是 sessionIds 中的一项，由 normalizePaneActive 保证。
  activeSessionId?: string;
};

export type SplitLayout = {
  panes: SplitPane[];
};

export type SplitDirection = 'left' | 'right' | 'top' | 'bottom';

export type SplitDropTarget =
  // 在 mask 处新开一格，把这个标签放进去；其余格子按 mask 收缩。
  | { kind: 'split'; mask: SplitCellMask }
  // 已在分屏中的格子重塑自身跨度到 mask（例如「右上」拖成「右半」，原下方格子相应变成左下）。
  | { kind: 'reshape'; mask: SplitCellMask; paneId: string }
  // 把这个标签移进已有格子，追加到那格的标签栏末尾。只搬这一个标签，不动别的。
  | { kind: 'move'; paneId: string }
  // 落点就是标签当前所在的格子：不改布局，但指示器仍要把这块高亮出来，
  // 否则指针一回到自己那格提示就消失，用户会以为拖拽已经失效。
  | { kind: 'keep'; mask: SplitCellMask; paneId: string };

// 八个吸附点：四角对应单元格，四边对应半边。拖动时淡淡显示，吸附后整块预览目标区域。
// 每个点直接对应一个目标掩码，因此落点判定退化为「找最近的点」，不需要再推算方向和跨度。
export type SplitAnchor = {
  id: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'top' | 'bottom' | 'left' | 'right';
  mask: SplitCellMask;
  // 吸附点在终端区里的归一化中心坐标（0~1），即该掩码矩形的几何中心。
  x: number;
  y: number;
};

const CELL_TOP_LEFT = 0b0001;
const CELL_TOP_RIGHT = 0b0010;
const CELL_BOTTOM_LEFT = 0b0100;
const CELL_BOTTOM_RIGHT = 0b1000;

const MASK_TOP = CELL_TOP_LEFT | CELL_TOP_RIGHT;
const MASK_BOTTOM = CELL_BOTTOM_LEFT | CELL_BOTTOM_RIGHT;
const MASK_LEFT = CELL_TOP_LEFT | CELL_BOTTOM_LEFT;
const MASK_RIGHT = CELL_TOP_RIGHT | CELL_BOTTOM_RIGHT;
export const SPLIT_FULL_MASK = MASK_TOP | MASK_BOTTOM;

// 四个单元格掩码，按视觉顺序（左上→右上→左下→右下）；补空位时按此顺序生成。
const SPLIT_CELL_MASKS: SplitCellMask[] = [
  CELL_TOP_LEFT,
  CELL_TOP_RIGHT,
  CELL_BOTTOM_LEFT,
  CELL_BOTTOM_RIGHT,
];

// 2×2 网格上全部合法矩形：四个单元格、四个半边、整屏。任何布局中的格子必须是其中之一。
const VALID_RECT_MASKS: SplitCellMask[] = [
  CELL_TOP_LEFT,
  CELL_TOP_RIGHT,
  CELL_BOTTOM_LEFT,
  CELL_BOTTOM_RIGHT,
  MASK_TOP,
  MASK_BOTTOM,
  MASK_LEFT,
  MASK_RIGHT,
  SPLIT_FULL_MASK,
];

// 指针落在格子中央这一圈内视为「整格」意图（替换或互换），不再判定切分方向。
const CENTER_ZONE_RATIO = 0.28;
// 切分方向确定后，若指针足够贴近垂直于该方向的中线，新格提升为独占整个半边（即三分格）。
const SPAN_PROMOTION_RATIO = 0.22;

export const SPLIT_MAX_PANES = 4;

// 八个吸附点，顺序即视觉优先级（相同距离时先命中角，角比边更精确地表达意图）。
export const SPLIT_ANCHORS: SplitAnchor[] = [
  { id: 'top-left', mask: CELL_TOP_LEFT, x: 0.25, y: 0.25 },
  { id: 'top-right', mask: CELL_TOP_RIGHT, x: 0.75, y: 0.25 },
  { id: 'bottom-left', mask: CELL_BOTTOM_LEFT, x: 0.25, y: 0.75 },
  { id: 'bottom-right', mask: CELL_BOTTOM_RIGHT, x: 0.75, y: 0.75 },
  { id: 'top', mask: MASK_TOP, x: 0.5, y: 0.16 },
  { id: 'bottom', mask: MASK_BOTTOM, x: 0.5, y: 0.84 },
  { id: 'left', mask: MASK_LEFT, x: 0.16, y: 0.5 },
  { id: 'right', mask: MASK_RIGHT, x: 0.84, y: 0.5 },
];

// 指针距吸附点小于该半径（归一化单位）才吸附；超出则不产生落点，避免误触。
// 0.42 略大于相邻点间距的一半，保证整个终端区都有归属，不会出现"哪个点都够不着"的死区。
const ANCHOR_SNAP_RADIUS = 0.42;

const popcount = (mask: SplitCellMask) => {
  let count = 0;
  for (let bit = 0; bit < 4; bit += 1) {
    if (mask & (1 << bit)) {
      count += 1;
    }
  }
  return count;
};

const isValidRect = (mask: SplitCellMask) => VALID_RECT_MASKS.includes(mask);

// 掩码 → 网格边界（0/1 起点与 1/2 终点），供命中判定与 CSS Grid 定位共用。
export const splitMaskToBounds = (mask: SplitCellMask) => {
  const hasLeft = Boolean(mask & MASK_LEFT);
  const hasRight = Boolean(mask & MASK_RIGHT);
  const hasTop = Boolean(mask & MASK_TOP);
  const hasBottom = Boolean(mask & MASK_BOTTOM);
  return {
    colStart: hasLeft ? 0 : 1,
    colEnd: hasRight ? 2 : 1,
    rowStart: hasTop ? 0 : 1,
    rowEnd: hasBottom ? 2 : 1,
  };
};

// CSS Grid 用 1 基线号；这里统一转换，避免各处重复 +1。
export const splitMaskToGridArea = (mask: SplitCellMask) => {
  const bounds = splitMaskToBounds(mask);
  return {
    gridColumn: `${bounds.colStart + 1} / ${bounds.colEnd + 1}`,
    gridRow: `${bounds.rowStart + 1} / ${bounds.rowEnd + 1}`,
  };
};

// 归一化坐标（0~1）落在掩码矩形内。
const isPointInMask = (mask: SplitCellMask, x: number, y: number) => {
  const { colStart, colEnd, rowStart, rowEnd } = splitMaskToBounds(mask);
  return x >= colStart / 2 && x <= colEnd / 2 && y >= rowStart / 2 && y <= rowEnd / 2;
};

let nextPaneSequence = 0;

const createPaneId = () => {
  nextPaneSequence += 1;
  return `pane-${nextPaneSequence}`;
};

export const createSplitLayout = (sessionId?: string): SplitLayout => ({
  panes: [{
    id: createPaneId(),
    mask: SPLIT_FULL_MASK,
    sessionIds: sessionId ? [sessionId] : [],
    activeSessionId: sessionId,
  }],
});

export const findSplitPaneAt = (layout: SplitLayout, x: number, y: number) =>
  layout.panes.find((pane) => isPointInMask(pane.mask, x, y));

// 会话现在挂在格子的标签列表里，因此"它在哪一格"要查列表而不是单个字段。
export const findSplitPaneBySession = (layout: SplitLayout, sessionId: string) =>
  layout.panes.find((pane) => pane.sessionIds.includes(sessionId));

// 空位判定统一走这里：标签列表为空即空位，避免各处重复判断 sessionIds.length。
const isPaneEmpty = (pane: SplitPane) => pane.sessionIds.length === 0;

// 摘掉标签后 activeSessionId 可能悬空；这里保证它始终指向列表里真实存在的一项。
// 被关掉的标签由右邻接替（没有右邻则取左邻），与常规标签栏的行为一致。
const normalizePaneActive = (pane: SplitPane, removedIndex?: number): SplitPane => {
  if (isPaneEmpty(pane)) {
    return { ...pane, sessionIds: [], activeSessionId: undefined };
  }
  if (pane.activeSessionId && pane.sessionIds.includes(pane.activeSessionId)) {
    return pane;
  }
  const fallbackIndex = Math.min(removedIndex ?? 0, pane.sessionIds.length - 1);
  return { ...pane, activeSessionId: pane.sessionIds[Math.max(0, fallbackIndex)] };
};

// 从所有格子里摘掉某个标签，并顺带修正受影响格子的激活项。
const detachSession = (panes: SplitPane[], sessionId: string): SplitPane[] =>
  panes.map((pane) => {
    const index = pane.sessionIds.indexOf(sessionId);
    if (index < 0) {
      return pane;
    }
    return normalizePaneActive(
      { ...pane, sessionIds: pane.sessionIds.filter((item) => item !== sessionId) },
      index,
    );
  });

// 布局里全部标签的扁平列表，供剪枝和"会话是否已上屏"判定使用。
export const collectSplitLayoutSessionIds = (layout: SplitLayout) =>
  layout.panes.flatMap((pane) => pane.sessionIds);

// 从一格里挖掉目标区域后，剩下的可能是 L 形（例如整屏被挖掉一个角）。
// 网格只能摆矩形，因此收缩到"仍被完整包含在剩余区域内的最大合法矩形"。
// 挖角时这会退化成半边：整屏挖掉右上角 → 剩下左半（而不是无法表达的 L 形），
// 空出来的那一格随后由 reflowPanes 并给相邻格。
const subtractMask = (paneMask: SplitCellMask, removedMask: SplitCellMask): SplitCellMask => {
  const remaining = paneMask & ~removedMask;
  if (remaining === 0 || isValidRect(remaining)) {
    return remaining;
  }
  let best = 0;
  for (const rect of VALID_RECT_MASKS) {
    if ((rect & ~remaining) === 0 && popcount(rect) > popcount(best)) {
      best = rect;
    }
  }
  return best;
};

// 目标掩码可否落位：每一格让出目标区域后（必要时收缩成最大合法矩形）都必须还剩下内容，
// 否则该格会被整个吞掉。收缩由 subtractMask 负责，因此挖角这类会产生 L 形的落点同样合法。
const canPlaceMask = (layout: SplitLayout, mask: SplitCellMask) => {
  if (!isValidRect(mask)) {
    return false;
  }
  return layout.panes.every((pane) => subtractMask(pane.mask, mask) !== 0);
};// 空闲单元并进相邻格子，直到重新铺满整个 2×2。
//
// 这里必须是**确定性**的：早期版本每轮挑"扩张收益最大"的一格，收益相同时结果取决于数组顺序，
// 而数组顺序又会被删除/插入改变——于是同样的操作偶尔会得到不同的布局，用户看到的就是
// "分区结构以我不想要的方式变了"。现在改为固定优先级：
//   1. 先按空闲单元的视觉顺序（左上→右上→左下→右下）逐个消化，保证从哪开始是确定的；
//   2. 每个空闲单元交给"能合法吞下它、且自身最靠左上"的格子，顺序由 paneOrder 唯一确定。
// pinnedIds 里的格子不参与扩张：刚落位的新格必须严格保持用户选中的那个吸附掩码。
const paneOrderKey = (pane: SplitPane) => {
  const bounds = splitMaskToBounds(pane.mask);
  return bounds.rowStart * 2 + bounds.colStart;
};

const reflowPanes = (panes: SplitPane[], pinnedIds?: ReadonlySet<string>): SplitPane[] => {
  let result = panes.filter((pane) => pane.mask !== 0);
  if (result.length === 0) {
    return [];
  }

  // 按“整块扩张”而不是“逐个单元并入”：一格能不能长大，看的是它连同空闲单元一起
  // 所能覆盖的**最大合法矩形**。逐单元并入会卡在中间形状上——例如只剩左半一格、
  // 右上和右下都空着时，左半+右上、左半+右下都不是矩形，于是谁都吞不下，
  // 最后凭空多出两个空格子；而按整块看，左半直接长成整屏。
  for (let guard = 0; guard < SPLIT_CELL_MASKS.length; guard += 1) {
    const covered = result.reduce((accumulator, pane) => accumulator | pane.mask, 0);
    if (covered === SPLIT_FULL_MASK) {
      break;
    }

    const free = SPLIT_FULL_MASK & ~covered;
    // 视觉顺序（左上→右上→左下→右下）决定谁先扩张，结果与数组顺序无关，因此是确定的。
    const growable = [...result]
      .map((pane, index) => ({ pane, index }))
      .sort((left, right) => paneOrderKey(left.pane) - paneOrderKey(right.pane));

    let grown = false;
    for (const { pane, index } of growable) {
      if (pinnedIds?.has(pane.id)) {
        continue;
      }

      // 只在“包含自身、且不越出空闲区域”的矩形里挑最大的那个。
      const reachable = pane.mask | free;
      let best = pane.mask;
      for (const rect of VALID_RECT_MASKS) {
        if ((pane.mask & ~rect) !== 0 || (rect & ~reachable) !== 0) {
          continue;
        }
        if (popcount(rect) > popcount(best)) {
          best = rect;
        }
      }
      if (best !== pane.mask) {
        result = result.map((item, itemIndex) => (
          itemIndex === index ? { ...item, mask: best } : item
        ));
        grown = true;
        break;
      }
    }

    if (!grown) {
      // 本轮没人能扩张，再扫也不会变；剩下的空洞交给 fillGapsWithEmptyPanes 兜底。
      break;
    }
  }

  return result;
};

// 找离指针最近的吸附点。返回 null 表示指针不在任何点的吸附半径内。
export const resolveNearestAnchor = (x: number, y: number): SplitAnchor | null => {
  let nearest: SplitAnchor | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const anchor of SPLIT_ANCHORS) {
    const distance = Math.hypot(x - anchor.x, y - anchor.y);
    // 严格小于：SPLIT_ANCHORS 顺序把角排在边之前，等距时角先命中。
    if (distance < nearestDistance) {
      nearest = anchor;
      nearestDistance = distance;
    }
  }
  return nearestDistance <= ANCHOR_SNAP_RADIUS ? nearest : null;
};

// 落点判定主入口：归一化坐标 + 当前布局 + 拖拽中的会话 → 该会话落下后会发生什么。
export const resolveSplitDropTarget = (
  layout: SplitLayout,
  x: number,
  y: number,
  sourceSessionId: string,
): SplitDropTarget | null => {
  const anchor = resolveNearestAnchor(x, y);
  if (!anchor) {
    return null;
  }

  const sourcePane = findSplitPaneBySession(layout, sourceSessionId);
  const paneAtAnchor = findSplitPaneAt(layout, anchor.x, anchor.y);
  const exactPane = layout.panes.find((pane) => pane.mask === anchor.mask);

  // 拖拽源已经在某一格里。
  if (sourcePane) {
    // 吸附点正好命中另一格 → 把这一个标签搬过去（不再互换整格内容）。
    if (exactPane && exactPane.id !== sourcePane.id) {
      return { kind: 'move', paneId: exactPane.id };
    }
    // 掩码不对应现有格子 → 重塑跨度。但源格里还有别的标签时，重塑会把它们一起带走，
    // 不符合"只移动一个标签"的预期；这种情况按新开一格处理，只把当前标签分出去。
    if (anchor.mask !== sourcePane.mask) {
      if (sourcePane.sessionIds.length > 1
        && layout.panes.length < SPLIT_MAX_PANES
        && canPlaceMask(layout, anchor.mask)) {
        return { kind: 'split', mask: anchor.mask };
      }
      return { kind: 'reshape', mask: anchor.mask, paneId: sourcePane.id };
    }
    return { kind: 'keep', mask: sourcePane.mask, paneId: sourcePane.id };
  }

  // 拖拽源来自某格的标签栏之外（尚未上屏）：空位直接填入，能开新格就开，否则并入命中的那格。
  if (paneAtAnchor && isPaneEmpty(paneAtAnchor)) {
    return { kind: 'move', paneId: paneAtAnchor.id };
  }
  if (layout.panes.length < SPLIT_MAX_PANES && canPlaceMask(layout, anchor.mask)) {
    return { kind: 'split', mask: anchor.mask };
  }
  return paneAtAnchor ? { kind: 'move', paneId: paneAtAnchor.id } : null;
};

// 整屏挖掉一个角之后，剩下的 L 形无法用一个矩形表达：宿主收缩成半边，
// 空出的那一格既不属于新格（新格被 pin 住不许扩张），也无法合法并回宿主。
// 这时把它变成一个空格子，用户可以再拖一个标签进来填满四格。
const fillGapsWithEmptyPanes = (panes: SplitPane[]): SplitPane[] => {
  const covered = panes.reduce((accumulator, pane) => accumulator | pane.mask, 0);
  let free = SPLIT_FULL_MASK & ~covered;
  if (!free) {
    return panes;
  }

  const result = [...panes];
  for (const cell of SPLIT_CELL_MASKS) {
    if (free & cell) {
      result.push({ id: createPaneId(), mask: cell, sessionIds: [] });
      free &= ~cell;
    }
  }
  return result;
};

export const applySplitDrop = (
  layout: SplitLayout,
  target: SplitDropTarget,
  sessionId: string,
): SplitLayout => {
  // 落在自己原本的跨度上：拖拽只是被"放回原处"，布局保持不动。
  if (target.kind === 'keep') {
    return layout;
  }

  // 搬一个标签进目标格：追加到末尾并设为激活，源格只少这一个标签。
  if (target.kind === 'move') {
    const detached = detachSession(layout.panes, sessionId);
    const moved = detached.map((pane) => (
      pane.id === target.paneId
        ? { ...pane, sessionIds: [...pane.sessionIds, sessionId], activeSessionId: sessionId }
        : pane
    ));
    // 源格被搬空时整格回收，让出的单元先由相邻格吞并，吞不下的补成空格子，保证始终铺满。
    const survivors = reflowPanes(moved.filter((pane) => !isPaneEmpty(pane)));
    return { panes: fillGapsWithEmptyPanes(survivors) };
  }

  // 重塑：目标格自己扩到新掩码，其余格子让出被占的单元；让空的格子被回收后重新铺满。
  // 例如「左上/右上/下」里把右上拖成右半 → 右上扩成右半，原来的下半收缩成左下。
  if (target.kind === 'reshape') {
    const reshaped = layout.panes.find((pane) => pane.id === target.paneId);
    if (!reshaped) {
      return layout;
    }

    // 新跨度可能把某一格**完整**盖掉（四分格里把一格拖成半边，相邻那格就整格消失）。
    // 这时它的标签必须并进重塑后的格子：若跟着掩码一起丢掉，那些会话会从布局里凭空不见，
    // 剩下的格子再重排一次，就成了「分区结构莫名其妙变了」。
    const absorbed: string[] = [];
    const others = layout.panes
      .filter((pane) => pane.id !== target.paneId && !isPaneEmpty(pane))
      .map((pane) => {
        const nextMask = subtractMask(pane.mask, target.mask);
        if (nextMask === 0) {
          absorbed.push(...pane.sessionIds);
        }
        return { ...pane, mask: nextMask };
      })
      .filter((pane) => pane.mask !== 0);

    return {
      panes: fillGapsWithEmptyPanes(reflowPanes(
        [...others, {
          ...reshaped,
          mask: target.mask,
          sessionIds: [...reshaped.sessionIds, ...absorbed],
          // 正在拖的那个标签保持激活，与其他落点的行为一致。
          activeSessionId: sessionId,
        }],
        new Set([reshaped.id]),
      )),
    };
  }

  // 新开一格承载这个标签；源格失去该标签后若空了就被回收。
  // 与 reshape 同理：被新格完整盖掉的格子，其标签并进新格，绝不能连同掩码一起丢弃。
  const absorbed: string[] = [];
  const detached = detachSession(layout.panes, sessionId)
    .filter((pane) => !isPaneEmpty(pane))
    .map((pane) => {
      const nextMask = subtractMask(pane.mask, target.mask);
      if (nextMask === 0) {
        absorbed.push(...pane.sessionIds);
      }
      return { ...pane, mask: nextMask };
    })
    .filter((pane) => pane.mask !== 0);
  const newPaneId = createPaneId();
  const placed = reflowPanes(
    [...detached, {
      id: newPaneId,
      mask: target.mask,
      sessionIds: [sessionId, ...absorbed],
      activeSessionId: sessionId,
    }],
    new Set([newPaneId]),
  );
  return { panes: fillGapsWithEmptyPanes(placed) };
};

// 关掉一格：四格全满时保留空位（用户可以再拖一个标签进来填回去），其余情况一律回收并重排。
export const closeSplitPane = (layout: SplitLayout, paneId: string): SplitLayout => {
  const target = layout.panes.find((pane) => pane.id === paneId);
  if (!target) {
    return layout;
  }

  const isFullyOccupiedQuad =
    layout.panes.length === SPLIT_MAX_PANES && layout.panes.every((pane) => !isPaneEmpty(pane));
  if (isFullyOccupiedQuad) {
    return {
      panes: layout.panes.map((pane) => (
        pane.id === paneId ? { ...pane, sessionIds: [], activeSessionId: undefined } : pane
      )),
    };
  }

  // 不在保留场景时，本次关掉的格子和此前留下的空位一并回收，剩余格子重新铺满。
  const remaining = layout.panes.filter((pane) => pane.id !== paneId && !isPaneEmpty(pane));
  if (remaining.length === 0) {
    return createSplitLayout();
  }
  return { panes: fillGapsWithEmptyPanes(reflowPanes(remaining)) };
};

// 会话被关闭时同步收拾分屏：格子里还有别的标签就只摘掉这一个，标签全没了才回收整格。
export const removeSessionFromSplitLayout = (layout: SplitLayout, sessionId: string): SplitLayout => {
  const pane = findSplitPaneBySession(layout, sessionId);
  if (!pane) {
    return layout;
  }

  if (pane.sessionIds.length > 1) {
    return { panes: detachSession(layout.panes, sessionId) };
  }
  return closeSplitPane(layout, pane.id);
};

// 重连会换掉后端会话 ID，但用户视角里还是「同一个终端」；必须原地替换，不能让格子被回收。
export const replaceSessionInSplitLayout = (
  layout: SplitLayout,
  previousSessionId: string,
  nextSessionId: string,
): SplitLayout => {
  if (!findSplitPaneBySession(layout, previousSessionId)) {
    return layout;
  }
  return {
    panes: layout.panes.map((pane) => (
      pane.sessionIds.includes(previousSessionId)
        ? {
            ...pane,
            sessionIds: pane.sessionIds.map((item) => (item === previousSessionId ? nextSessionId : item)),
            activeSessionId: pane.activeSessionId === previousSessionId ? nextSessionId : pane.activeSessionId,
          }
        : pane
    )),
  };
};

// 把会话放进指定格子（新开会话、点击尚未上屏的标签都走这条路）：追加到末尾并设为激活。
export const assignSessionToPane = (
  layout: SplitLayout,
  paneId: string,
  sessionId: string,
): SplitLayout => {
  const targetPane = layout.panes.find((pane) => pane.id === paneId);
  if (!targetPane) {
    return layout;
  }
  // 已在目标格里：只切换激活项，不重复追加，也不改布局。
  if (targetPane.sessionIds.includes(sessionId)) {
    return {
      panes: layout.panes.map((pane) => (
        pane.id === paneId ? { ...pane, activeSessionId: sessionId } : pane
      )),
    };
  }

  const assigned = detachSession(layout.panes, sessionId).map((pane) => (
    pane.id === paneId
      ? { ...pane, sessionIds: [...pane.sessionIds, sessionId], activeSessionId: sessionId }
      : pane
  ));
  // 单格布局允许「暂时没有会话」（空态占位）；多格时被搬空的格子一律回收。
  if (assigned.length === 1) {
    return { panes: assigned };
  }
  return { panes: fillGapsWithEmptyPanes(reflowPanes(assigned.filter((pane) => !isPaneEmpty(pane)))) };
};

// 在格子内切换激活标签。paneId 由调用方给出（它通常刚查过），避免重复检索。
export const activateSessionInPane = (
  layout: SplitLayout,
  paneId: string,
  sessionId: string,
): SplitLayout => ({
  panes: layout.panes.map((pane) => (
    pane.id === paneId && pane.sessionIds.includes(sessionId)
      ? { ...pane, activeSessionId: sessionId }
      : pane
  )),
});

// 在同一格内重排标签顺序（格内拖拽排序）。
export const reorderSessionsInPane = (
  layout: SplitLayout,
  paneId: string,
  sessionIds: string[],
): SplitLayout => ({
  panes: layout.panes.map((pane) => (
    pane.id === paneId ? { ...pane, sessionIds } : pane
  )),
});

// 会话列表变化后清理悬空引用（重连换 ID、批量关闭等）；空位本身允许保留。
export const pruneSplitLayout = (layout: SplitLayout, liveSessionIds: Set<string>): SplitLayout => {
  const staleSessionIds = collectSplitLayoutSessionIds(layout)
    .filter((sessionId) => !liveSessionIds.has(sessionId));
  if (staleSessionIds.length === 0) {
    return layout;
  }

  let next = layout;
  for (const sessionId of staleSessionIds) {
    next = removeSessionFromSplitLayout(next, sessionId);
  }
  return next;
};

// 分屏数量 ≥ 2 时界面才需要区分「哪一格」，很多 UI 分支据此决定是否出现。
export const isSplitLayoutActive = (layout: SplitLayout) => layout.panes.length > 1;

// 左上角那一格：侧栏绑定的默认目标。按行、再按列取最靠前的格子，与视觉顺序一致。
export const resolveTopLeftPane = (layout: SplitLayout) =>
  [...layout.panes].sort((left, right) => {
    const leftBounds = splitMaskToBounds(left.mask);
    const rightBounds = splitMaskToBounds(right.mask);
    return leftBounds.rowStart - rightBounds.rowStart || leftBounds.colStart - rightBounds.colStart;
  })[0];
