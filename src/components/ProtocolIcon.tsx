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
 * 渲染 SSH 终端与 Windows 远程桌面矢量图标，统一连接列表与表单中的协议标识。
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
        style={{ flexShrink: 0 }}
        viewBox="0 0 24 24"
        width={size}
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* 透明底窗格以兼顾明暗背景的蓝色填充，并与 public/icons/rdp.svg 保持一致。 */}
        <path
          d="M2 5L10 3.9V11H2V5ZM11.5 3.7L22 2V11H11.5V3.7ZM2 12.5H10V20.1L2 19V12.5ZM11.5 12.5H22V22L11.5 20.3V12.5Z"
          fill="#0088d9"
        />
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
