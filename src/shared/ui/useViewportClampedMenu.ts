import { useLayoutEffect, useRef } from 'react';

// 菜单与窗口边缘保留的最小间距。
const VIEWPORT_MARGIN = 8;

/**
 * 右键菜单首次测量后在绘制前收回视口内：右侧放不下时向左翻转到鼠标左侧，
 * 下方放不下时向上翻转到鼠标上方，翻转后仍溢出则贴边保留间距，保证菜单尽量完整可见。
 */
export function useViewportClampedMenu<T extends HTMLElement>(x: number, y: number) {
  const menuRef = useRef<T | null>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) {
      return;
    }
    const { width, height } = menu.getBoundingClientRect();
    const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN;
    const maxTop = window.innerHeight - height - VIEWPORT_MARGIN;
    let left = x;
    let top = y;
    // 右侧溢出时优先翻转到鼠标左侧，仍不够则贴右边缘。
    if (left > maxLeft) {
      left = x - width >= VIEWPORT_MARGIN ? x - width : maxLeft;
    }
    // 下方溢出时优先翻转到鼠标上方，仍不够则贴底边缘。
    if (top > maxTop) {
      top = y - height >= VIEWPORT_MARGIN ? y - height : maxTop;
    }
    menu.style.left = `${Math.max(VIEWPORT_MARGIN, left)}px`;
    menu.style.top = `${Math.max(VIEWPORT_MARGIN, top)}px`;
  }, [x, y]);

  return menuRef;
}
