// MyTerminal 统一 Tooltip 悬浮提示组件
// 基于 @radix-ui/react-tooltip 封装，自适应明亮/暗黑主题，支持自定义延迟（默认 100ms）与微动效，防止遮挡
import React from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';

export interface TooltipProps {
  /** 提示文本或节点 */
  content: React.ReactNode;
  /** 可选：快捷键文本，以微型按键徽标形式在右侧展示 */
  shortcut?: string;
  /** 触发元素 */
  children: React.ReactNode;
  /** 弹出方向，默认 'bottom' */
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** 对齐方式，默认 'center' */
  align?: 'start' | 'center' | 'end';
  /** 与触发源的间距，默认 6px */
  sideOffset?: number;
  /** 是否将属性直接合并至子节点（默认 true） */
  asChild?: boolean;
  /** 是否禁用 Tooltip */
  disabled?: boolean;
  /** 显式指定延迟时间（毫秒），默认 100ms */
  delayDuration?: number;
}

/**
 * Tooltip 根 Provider，提供统一的延迟配置（100ms）与邻近快速触发体验
 */
export function TooltipProvider({
  children,
  delayDuration = 100,
  skipDelayDuration = 300,
}: {
  children: React.ReactNode;
  delayDuration?: number;
  skipDelayDuration?: number;
}) {
  return (
    <RadixTooltip.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      disableHoverableContent
    >
      {children}
    </RadixTooltip.Provider>
  );
}

/**
 * 通用 Tooltip 组件
 */
export function Tooltip({
  content,
  shortcut,
  children,
  side = 'bottom',
  align = 'center',
  sideOffset = 6,
  asChild = true,
  disabled = false,
  delayDuration = 100,
}: TooltipProps) {
  // 无内容或显式禁用时，直接返回子节点
  if (disabled || (!content && !shortcut)) {
    return <>{children}</>;
  }

  return (
    <RadixTooltip.Root delayDuration={delayDuration}>
      <RadixTooltip.Trigger asChild={asChild}>
        {children}
      </RadixTooltip.Trigger>
      {/* 使用 Portal 挂载到 body，结合超高 z-index 确保永远不会被内部滚动容器或弹窗遮挡在底部 */}
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          className="mt-tooltip-content"
        >
          {typeof content === 'string' ? <span>{content}</span> : content}
          {shortcut && (
            <kbd className="mt-tooltip-kbd">
              {shortcut}
            </kbd>
          )}
          <RadixTooltip.Arrow className="mt-tooltip-arrow" width={8} height={4} />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
