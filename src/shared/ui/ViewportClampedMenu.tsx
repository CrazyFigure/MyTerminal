import type { ReactNode } from 'react';

import { useViewportClampedMenu } from './useViewportClampedMenu';

type Props = {
  children: ReactNode;
  className: string;
  x: number;
  y: number;
};

// 通用右键菜单容器：按鼠标坐标定位并自动收回视口内，点击菜单内部不冒泡触发全局关闭。
export function ViewportClampedMenu({ children, className, x, y }: Props) {
  const menuRef = useViewportClampedMenu<HTMLDivElement>(x, y);

  return (
    <div ref={menuRef} className={className} style={{ left: x, top: y }} onClick={(event) => event.stopPropagation()}>
      {children}
    </div>
  );
}
