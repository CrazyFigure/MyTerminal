import { backend } from '../../backend';
import { moveItemToEnd, moveItemToInsert, type InsertPlacement } from '../../app/connectionGroups';
import type { StoreGet, StoreSet, StoreState } from './contracts';
import type { FavoriteCommand } from '../../types';

type FavoriteActionKeys =
  | 'openFavoriteModal'
  | 'closeFavoriteModal'
  | 'saveFavoriteCommand'
  | 'deleteFavoriteCommand'
  | 'reorderFavoriteCommands'
  | 'reorderFavoriteCommandsToEnd';

export type FavoriteActions = Pick<StoreState, FavoriteActionKeys>;

// 收藏命令 action factory：管理常用命令的增删改、弹窗状态、拖拽排序与本地持久化
export const createFavoriteActions = (set: StoreSet, get: StoreGet): FavoriteActions => ({
  // 打开收藏编辑弹窗，可传入初始命令与备注
  openFavoriteModal: (initialData) => {
    set({
      favoriteModalState: {
        isOpen: true,
        initialData,
      },
    });
  },

  // 关闭收藏编辑弹窗
  closeFavoriteModal: () => {
    set({ favoriteModalState: null });
  },

  // 保存新增或编辑的收藏命令并立即持久化落盘
  saveFavoriteCommand: async (payload) => {
    const trimmedCommand = payload.command.trim();
    if (!trimmedCommand) {
      return;
    }

    const { favoriteCommands } = get();
    const now = new Date().toISOString();
    let nextCommands: FavoriteCommand[];

    if (payload.id && favoriteCommands.some((item) => item.id === payload.id)) {
      // 编辑已有命令项
      nextCommands = favoriteCommands.map((item) =>
        item.id === payload.id
          ? {
              ...item,
              command: trimmedCommand,
              remark: payload.remark?.trim() ?? '',
              updatedAt: now,
            }
          : item
      );
    } else {
      // 新建收藏命令项，自动生成唯一 ID 并追加到末尾
      const newFavorite: FavoriteCommand = {
        id: crypto.randomUUID(),
        command: trimmedCommand,
        remark: payload.remark?.trim() ?? '',
        createdAt: now,
        updatedAt: now,
      };
      nextCommands = [...favoriteCommands, newFavorite];
    }

    // 乐观更新前端内存状态并异步写入持久化存储
    set({ favoriteCommands: nextCommands, favoriteModalState: null });
    try {
      const persisted = await backend.saveFavoriteCommands(nextCommands);
      set({ favoriteCommands: persisted });
    } catch (err) {
      console.error('Failed to save favorite commands:', err);
    }
  },

  // 删除指定的收藏命令并持久化
  deleteFavoriteCommand: async (id) => {
    const { favoriteCommands } = get();
    const nextCommands = favoriteCommands.filter((item) => item.id !== id);
    set({ favoriteCommands: nextCommands });
    try {
      const persisted = await backend.saveFavoriteCommands(nextCommands);
      set({ favoriteCommands: persisted });
    } catch (err) {
      console.error('Failed to delete favorite command:', err);
    }
  },

  // 拖动排序插入：根据目标位置前后计算新序列并持久化
  reorderFavoriteCommands: async (sourceId: string, targetId: string, placement: InsertPlacement) => {
    const { favoriteCommands } = get();
    const currentIds = favoriteCommands.map((item) => item.id);
    const nextIds = moveItemToInsert(currentIds, sourceId, targetId, placement);
    const itemMap = new Map(favoriteCommands.map((item) => [item.id, item]));
    const reordered = nextIds.map((id) => itemMap.get(id)!).filter(Boolean);

    set({ favoriteCommands: reordered });
    try {
      const persisted = await backend.saveFavoriteCommands(reordered);
      set({ favoriteCommands: persisted });
    } catch (err) {
      console.error('Failed to reorder favorite commands:', err);
    }
  },

  // 拖动排序移至列表末尾并持久化
  reorderFavoriteCommandsToEnd: async (sourceId: string) => {
    const { favoriteCommands } = get();
    const currentIds = favoriteCommands.map((item) => item.id);
    const nextIds = moveItemToEnd(currentIds, sourceId);
    const itemMap = new Map(favoriteCommands.map((item) => [item.id, item]));
    const reordered = nextIds.map((id) => itemMap.get(id)!).filter(Boolean);

    set({ favoriteCommands: reordered });
    try {
      const persisted = await backend.saveFavoriteCommands(reordered);
      set({ favoriteCommands: persisted });
    } catch (err) {
      console.error('Failed to move favorite command to end:', err);
    }
  },
});
