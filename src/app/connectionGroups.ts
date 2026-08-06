/* 本模块由原 App 入口按业务边界拆出；迁移仅调整依赖方向，不改变运行逻辑。 */
import { useLayoutEffect, useRef, type DependencyList, type RefObject } from 'react';
import type { ConnectionProfile } from '../types';

export type InsertPlacement = 'before' | 'after';


export type ConnectionGroupNode = {
  name: string;
  path: string;
  children: ConnectionGroupNode[];
  connections: ConnectionProfile[];
};


export type ConnectionManagerDragState =
  | { type: 'connection'; id: string; label: string; originX: number; originY: number; currentX: number; currentY: number }
  | { type: 'group'; path: string; label: string; originX: number; originY: number; currentX: number; currentY: number }
  | null;


export type ConnectionManagerDropTarget =
  | { type: 'connection-insert'; connectionId: string; placement: InsertPlacement }
  | { type: 'connection-end' }
  | { type: 'connection-group'; groupPath: string }
  | { type: 'connection-ungrouped' }
  | { type: 'group-insert'; groupPath: string; placement: InsertPlacement }
  | { type: 'group-end' }
  | null;



export const ungroupedGroupPath = '__ungrouped__';



// 名称列优先容纳可读机器名；主机与用户名仍可拖拽扩宽，操作按钮保持完整露出且不引入横向滚动条。
export const connectionTableDefaultColumnWidths = [24, 184, 130, 54, 94];


export const connectionTableColumnLimits = [
  { min: 24, max: 24 },
  { min: 96, max: 360 },
  { min: 120, max: 400 },
  { min: 48, max: 96 },
  { min: 72, max: 220 },
];


// 连接管理左右分栏保留足够的分组可读宽度和连接表格操作空间，拖动只在当前弹窗内生效。
export const connectionManagerSidebarDefaultWidth = 280;


export const connectionManagerSidebarMinWidth = 200;


export const connectionManagerSidebarMaxWidth = 480;


export const connectionManagerTableMinWidth = 360;


export const connectionManagerResizerWidth = 12;


export const connectionTableActionMinWidth = 220;



// 连接分组需要合并显式分组和连接自带 groupPath，保证空分组也能展示和继续维护。
export const normalizeConnectionGroupPath = (value?: string) =>
  (value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/');



// 删除和筛选分组时要包含子分组，但不能把同名前缀误判为子级。
export const isConnectionGroupOrChildPath = (value: string | undefined, groupPath: string) => {
  const normalized = normalizeConnectionGroupPath(value);
  return Boolean(groupPath) && (normalized === groupPath || normalized.startsWith(`${groupPath}/`));
};



// 管理页右侧列表只展示当前目录直属连接，父目录不混入子目录连接，方便用户按层级管理。
export const isConnectionInExactGroupPath = (value: string | undefined, groupPath: string) =>
  normalizeConnectionGroupPath(value) === normalizeConnectionGroupPath(groupPath);



// 拖拽排序只移动现有项位置，不改写路径含义；目标项作为插入锚点，上下半区决定插入方向。
export const moveItemToInsert = (items: string[], source: string, target: string, placement: InsertPlacement) => {
  if (source === target) {
    return items;
  }

  const nextItems = items.filter((item) => item !== source);
  const targetIndex = nextItems.indexOf(target);
  if (targetIndex < 0) {
    return nextItems;
  }

  nextItems.splice(targetIndex + (placement === 'after' ? 1 : 0), 0, source);
  return nextItems;
};



export const moveItemToEnd = (items: string[], source: string) => [...items.filter((item) => item !== source), source];



// 分组支持父子路径，拖动父分组时要把子分组作为一个块一起移动，避免树结构被排序拆散。
export const moveGroupBlockToInsert = (groupPaths: string[], source: string, target: string, placement: InsertPlacement) => {
  if (source === target || isConnectionGroupOrChildPath(target, source)) {
    return groupPaths;
  }

  const sourceBlock = groupPaths.filter((path) => path === source || path.startsWith(`${source}/`));
  const remaining = groupPaths.filter((path) => !sourceBlock.includes(path));
  const targetIndex = remaining.indexOf(target);
  if (targetIndex < 0) {
    return remaining;
  }

  const targetBlockEndIndex = remaining.reduce((lastIndex, path, index) => {
    return path === target || path.startsWith(`${target}/`) ? index : lastIndex;
  }, targetIndex);
  const insertIndex = placement === 'after' ? targetBlockEndIndex + 1 : targetIndex;
  remaining.splice(insertIndex, 0, ...sourceBlock);
  return remaining;
};



export const moveGroupBlockToEnd = (groupPaths: string[], source: string) => {
  const sourceBlock = groupPaths.filter((path) => path === source || path.startsWith(`${source}/`));
  const remaining = groupPaths.filter((path) => !sourceBlock.includes(path));
  return [...remaining, ...sourceBlock];
};



export const resolveInsertPlacement = (event: PointerEvent, element: HTMLElement): InsertPlacement => {
  const rect = element.getBoundingClientRect();
  return event.clientY > rect.top + rect.height / 2 ? 'after' : 'before';
};



export const resolveInlineInsertPlacement = (event: PointerEvent, element: HTMLElement): InsertPlacement => {
  const rect = element.getBoundingClientRect();
  return event.clientX > rect.left + rect.width / 2 ? 'after' : 'before';
};



export const isPointInsideElement = (event: PointerEvent, element: HTMLElement | null) => {
  if (!element) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
};



// 列表拖拽落位后用 FLIP 动画补齐“从旧位置到新位置”的过渡，避免排序结果突然跳变。
export const useFlipListAnimation = (containerRef: RefObject<HTMLElement | null>, selector: string, deps: DependencyList) => {
  const previousRectsRef = useRef<Map<string, DOMRect>>(new Map());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const elements = Array.from(container.querySelectorAll<HTMLElement>(selector));
    const nextRects = new Map<string, DOMRect>();
    elements.forEach((element) => {
      const key = element.dataset.connectionId
        ? `connection:${element.dataset.connectionId}`
        : element.dataset.groupPath
          ? `group:${element.dataset.groupPath}`
          : element.dataset.sessionId
            ? `session:${element.dataset.sessionId}`
            : '';
      if (!key) {
        return;
      }

      const currentRect = element.getBoundingClientRect();
      const previousRect = previousRectsRef.current.get(key);
      nextRects.set(key, currentRect);
      if (!previousRect) {
        return;
      }

      const deltaX = previousRect.left - currentRect.left;
      const deltaY = previousRect.top - currentRect.top;
      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) {
        return;
      }

      element.animate(
        [
          { transform: `translate(${deltaX}px, ${deltaY}px)` },
          { transform: 'translate(0, 0)' },
        ],
        {
          duration: 180,
          easing: 'cubic-bezier(0.2, 0, 0, 1)',
        },
      );
    });

    previousRectsRef.current = nextRects;
  }, deps);
};



// 连接排序优先使用设置中的人工顺序，旧配置或新增连接没有记录时保留当前数组顺序兜底。
export const sortConnectionsByOrder = (connections: ConnectionProfile[], connectionOrder: string[]) => {
  const orderMap = new Map(connectionOrder.map((connectionId, index) => [connectionId, index]));
  return [...connections].sort((left, right) => {
    const leftOrder = orderMap.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = orderMap.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return connections.indexOf(left) - connections.indexOf(right);
  });
};



export const expandGroupPathWithParents = (groupPath: string) => {
  const segments = normalizeConnectionGroupPath(groupPath).split('/').filter(Boolean);
  return segments.map((_segment, index) => segments.slice(0, index + 1).join('/'));
};



// 显式分组和连接自带分组一起参与拖拽排序，父级路径也要补齐，避免旧配置里未持久化的分组在管理页消失。
export const collectOrderedGroupPaths = (groupPaths: string[], connections: ConnectionProfile[]) =>
  Array.from(
    new Set([
      ...groupPaths.flatMap(expandGroupPathWithParents),
      ...connections.flatMap((connection) => expandGroupPathWithParents(connection.groupPath ?? '')),
    ].filter(Boolean)),
  );



export const buildConnectionGroupTree = (groupPaths: string[], connections: ConnectionProfile[]): ConnectionGroupNode[] => {
  type MutableNode = {
    name: string;
    path: string;
    children: Map<string, MutableNode>;
    connections: ConnectionProfile[];
  };

  let nextGroupOrder = 0;
  const groupOrder = new Map<string, number>();
  const root: MutableNode = {
    name: '',
    path: '',
    children: new Map(),
    connections: [],
  };

  const ensureNode = (path: string) => {
    const segments = path.split('/').map((item) => item.trim()).filter(Boolean);
    let current = root;
    let currentPath = '';

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      if (!groupOrder.has(currentPath)) {
        groupOrder.set(currentPath, nextGroupOrder);
        nextGroupOrder += 1;
      }
      if (!current.children.has(segment)) {
        current.children.set(segment, {
          name: segment,
          path: currentPath,
          children: new Map(),
          connections: [],
        });
      }
      current = current.children.get(segment)!;
    }

    return current;
  };

  const orderedGroupPaths = Array.from(
    new Set([
      ...groupPaths.map((groupPath) => normalizeConnectionGroupPath(groupPath)),
      ...connections.map((connection) => normalizeConnectionGroupPath(connection.groupPath)),
    ].filter(Boolean)),
  );

  orderedGroupPaths.forEach((groupPath) => ensureNode(groupPath));

  for (const connection of connections) {
    const groupPath = normalizeConnectionGroupPath(connection.groupPath);
    if (groupPath) {
      ensureNode(groupPath).connections.push(connection);
    }
  }

  const finalize = (node: MutableNode): ConnectionGroupNode[] => {
    return [...node.children.values()]
      .sort((left, right) => (groupOrder.get(left.path) ?? 0) - (groupOrder.get(right.path) ?? 0))
      .map((child) => ({
        name: child.name,
        path: child.path,
        connections: child.connections,
        children: finalize(child),
      }));
  };

  return finalize(root);
};
