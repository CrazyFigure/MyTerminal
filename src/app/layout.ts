/* 本模块由原 App 入口按业务边界拆出；迁移仅调整依赖方向，不改变运行逻辑。 */
import type { PointerEvent as ReactPointerEvent } from 'react';
import { clamp } from '../shared/numbers';

// 保留原公共入口，现有界面模块无需感知共享工具的目录迁移。
export { clamp };



export const beginResize = (
  event: ReactPointerEvent<HTMLElement>,
  onMove: (moveEvent: PointerEvent, startX: number, startY: number) => void,
) => {
  event.preventDefault();
  const startX = event.clientX;
  const startY = event.clientY;

  const handleMove = (moveEvent: PointerEvent) => onMove(moveEvent, startX, startY);
  const handleUp = () => {
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', handleUp);
  };

  window.addEventListener('pointermove', handleMove);
  window.addEventListener('pointerup', handleUp);
};
