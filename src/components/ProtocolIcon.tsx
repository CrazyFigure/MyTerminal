import React from 'react';
import type { ConnectionProtocol } from '../types';

interface ProtocolIconProps {
  /** 连接协议类型，默认兜底为 ssh */
  protocol?: ConnectionProtocol | string;
  /** 图标像素尺寸，默认为 18 */
  size?: number;
  /** 外部传入样式名 */
  className?: string;
  /** 辅助可访问性文本 */
  ariaLabel?: string;
}

/**
 * 渲染专业彩色的 SSH 终端与 Windows 远程桌面矢量图标。
 * 针对浅色与深色主题均经过精细对比度调优，并提供极高的辨识度。
 */
export function ProtocolIcon({
  protocol,
  size = 18,
  className,
  ariaLabel,
}: ProtocolIconProps) {
  const isRdp = protocol === 'rdp';

  if (isRdp) {
    return (
      <svg
        aria-label={ariaLabel ?? 'Windows 远程桌面'}
        className={className}
        fill="none"
        height={size}
        role="img"
        viewBox="0 0 24 24"
        width={size}
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="protocol-rdp-win-blue" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
            <stop stopColor="#0ea5e9" />
            <stop offset="0.4" stopColor="#0078d4" />
            <stop offset="1" stopColor="#0052cc" />
          </linearGradient>
        </defs>
        {/* 方案C微章底座：纯正微软 Windows 湛蓝渐变 */}
        <rect fill="url(#protocol-rdp-win-blue)" height="20" rx="4.5" stroke="#38bdf8" strokeOpacity="0.4" strokeWidth="1" width="20" x="2" y="2" />
        {/* 图标内部方正现代电脑屏幕（无老式支架） */}
        <rect fill="#ffffff" fillOpacity="0.18" height="12" rx="1.5" stroke="#ffffff" strokeWidth="1.3" width="15" x="4.5" y="4.5" />
        {/* 屏幕内远程控制交互箭头 */}
        <path d="M8.5 10.5H15.5M15.5 10.5L13 8M15.5 10.5L13 13" stroke="#ffffff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
        {/* 现代方正一体屏微边线 */}
        <line stroke="#ffffff" strokeLinecap="round" strokeOpacity="0.8" strokeWidth="1.2" x1="9" x2="15" y1="18.5" y2="18.5" />
      </svg>
    );
  }

  return (
    <svg
      aria-label={ariaLabel ?? 'SSH 终端'}
      className={className}
      fill="none"
      height={size}
      role="img"
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="protocol-ssh-term-bg" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
          <stop stopColor="#1e293b" />
          <stop offset="1" stopColor="#0f172a" />
        </linearGradient>
      </defs>
      {/* 终端控制台方正微章外框与深色底色 */}
      <rect fill="url(#protocol-ssh-term-bg)" height="20" rx="4.5" stroke="#334155" strokeWidth="1.2" width="20" x="2" y="2" />
      {/* 终端命令行翠绿色提示符与电光青色光标 */}
      <path d="M6 8L10.5 12L6 16" stroke="#22c55e" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" />
      <line stroke="#38bdf8" strokeLinecap="round" strokeWidth="2.2" x1="12.5" x2="17.5" y1="16" y2="16" />
      {/* 终端右上角金琥珀色状态徽标点 */}
      <circle cx="17" cy="7.5" fill="#f59e0b" r="1.5" />
    </svg>
  );
}
