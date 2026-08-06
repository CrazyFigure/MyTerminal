/* 本模块由原 App 入口按业务边界拆出；迁移仅调整依赖方向，不改变运行逻辑。 */
import type { PointerEvent as ReactPointerEvent } from 'react';

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));



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
