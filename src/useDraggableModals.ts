import { useEffect } from 'react';

// 弹窗距离应用窗口边缘的最小安全间距，保证拖动后外框和阴影仍完整可见。
const MODAL_VIEWPORT_MARGIN = 8;
// 标题栏内的交互控件继续执行自身动作，不能被公共拖动手势截获。
const MODAL_DRAG_IGNORE_SELECTOR = [
  'button',
  'a',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  '[role="button"]',
  '[contenteditable="true"]',
  '[data-modal-drag-ignore]',
].join(',');

type ModalDragSession = {
  modal: HTMLElement;
  handle: HTMLElement;
  pointerId: number;
  startPointerX: number;
  startPointerY: number;
  startOffsetX: number;
  startOffsetY: number;
  minOffsetX: number;
  maxOffsetX: number;
  minOffsetY: number;
  maxOffsetY: number;
};

// 把目标值限制在允许区间内；弹窗接近窗口边缘时用于阻止继续越界。
const clampModalOffset = (value: number, minimum: number, maximum: number) => (
  Math.min(maximum, Math.max(minimum, value))
);

// 读取当前拖动偏移；值只保存在本次挂载的 DOM 节点上，弹窗关闭卸载后不会带到下次打开。
const readModalOffset = (modal: HTMLElement, property: '--modal-drag-x' | '--modal-drag-y') => {
  const value = Number.parseFloat(modal.style.getPropertyValue(property));
  return Number.isFinite(value) ? value : 0;
};

/**
 * 为统一的弹窗结构注册标题栏拖动能力。
 * 主要流程：从标题栏开始主指针拖动、按视口边界钳制位置、结束时释放捕获；偏移不写入任何持久状态。
 */
export function useDraggableModals() {
  useEffect(() => {
    // 当前手势只允许控制一个弹窗，避免多指或嵌套弹窗同时移动。
    let dragSession: ModalDragSession | null = null;

    const finishDrag = (pointerId?: number) => {
      if (!dragSession || (pointerId !== undefined && dragSession.pointerId !== pointerId)) {
        return;
      }

      const { modal, handle, pointerId: activePointerId } = dragSession;
      modal.classList.remove('is-dragging');
      document.documentElement.classList.remove('is-modal-dragging');
      if (handle.hasPointerCapture(activePointerId)) {
        handle.releasePointerCapture(activePointerId);
      }
      dragSession = null;
    };

    const handlePointerDown = (event: PointerEvent) => {
      // 仅响应主指针的左键/触摸，右键菜单和第二根手指都不应改变弹窗位置。
      if (!event.isPrimary || event.button !== 0 || dragSession) {
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      const handle = target?.closest<HTMLElement>('.modal-header');
      const modal = handle?.closest<HTMLElement>('.modal');
      if (!target || !handle || !modal || !modal.closest('.modal-backdrop')) {
        return;
      }

      // 关闭按钮等标题栏控件必须保持原点击行为，只有标题栏空白和标题文案区域可发起拖动。
      if (target.closest(MODAL_DRAG_IGNORE_SELECTOR)) {
        return;
      }

      const rect = modal.getBoundingClientRect();
      const startOffsetX = readModalOffset(modal, '--modal-drag-x');
      const startOffsetY = readModalOffset(modal, '--modal-drag-y');
      dragSession = {
        modal,
        handle,
        pointerId: event.pointerId,
        startPointerX: event.clientX,
        startPointerY: event.clientY,
        startOffsetX,
        startOffsetY,
        // 边界基于按下时的真实位置计算，兼容不同宽高和已经拖动过的弹窗。
        minOffsetX: startOffsetX + MODAL_VIEWPORT_MARGIN - rect.left,
        maxOffsetX: startOffsetX + window.innerWidth - MODAL_VIEWPORT_MARGIN - rect.right,
        minOffsetY: startOffsetY + MODAL_VIEWPORT_MARGIN - rect.top,
        maxOffsetY: startOffsetY + window.innerHeight - MODAL_VIEWPORT_MARGIN - rect.bottom,
      };

      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      modal.classList.add('is-dragging');
      document.documentElement.classList.add('is-modal-dragging');
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!dragSession || dragSession.pointerId !== event.pointerId) {
        return;
      }

      const nextOffsetX = clampModalOffset(
        dragSession.startOffsetX + event.clientX - dragSession.startPointerX,
        dragSession.minOffsetX,
        dragSession.maxOffsetX,
      );
      const nextOffsetY = clampModalOffset(
        dragSession.startOffsetY + event.clientY - dragSession.startPointerY,
        dragSession.minOffsetY,
        dragSession.maxOffsetY,
      );
      dragSession.modal.style.setProperty('--modal-drag-x', `${Math.round(nextOffsetX)}px`);
      dragSession.modal.style.setProperty('--modal-drag-y', `${Math.round(nextOffsetY)}px`);
      event.preventDefault();
    };

    const handlePointerUp = (event: PointerEvent) => finishDrag(event.pointerId);

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('pointermove', handlePointerMove, { passive: false });
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerUp);

    return () => {
      finishDrag();
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointercancel', handlePointerUp);
    };
  }, []);
}
