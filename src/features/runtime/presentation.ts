/* 功能域展示规则：不持有 React 页面状态，只把输入转换成稳定的显示结果。 */
import type { RuntimeConnectionMetric } from '../../types';

// 内存展开区只展示前 4 项，降低远端 ps 查询和前端渲染负担。
export const runtimeResourceDetailLimit = 4;

// 格式化百分比数值，保留必要精度
export const formatMetricPercent = (percent?: number | null): string => {
  if (percent == null || !Number.isFinite(percent)) {
    return '---';
  }
  const clamped = Math.max(0, Math.min(100, percent));
  return `${clamped.toFixed(1).replace(/\.0$/, '')}%`;
};

// 格式化 KiB 为易读大小（KB / MB / GB）
export const formatKib = (kib?: number | null): string => {
  if (kib == null || !Number.isFinite(kib)) {
    return '---';
  }
  if (kib >= 1024 * 1024) {
    return `${(kib / (1024 * 1024)).toFixed(1)} GB`;
  }
  if (kib >= 1024) {
    return `${(kib / 1024).toFixed(0)} MB`;
  }
  return `${kib} KB`;
};

// 格式化已用/总量
export const formatMetricUsedTotal = (usedKib?: number | null, totalKib?: number | null): string => {
  if (usedKib == null || totalKib == null) {
    return '---';
  }
  return `${formatKib(usedKib)} / ${formatKib(totalKib)}`;
};

// 格式化系统运行时间
export const formatMetricUptime = (uptimeSeconds?: number | null): string => {
  if (uptimeSeconds == null || !Number.isFinite(uptimeSeconds)) {
    return '---';
  }
  const days = Math.floor(uptimeSeconds / 86400);
  const hours = Math.floor((uptimeSeconds % 86400) / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${uptimeSeconds}s`;
};

// 格式化网络连接数
export const formatMetricConnections = (metric?: RuntimeConnectionMetric): string => {
  if (!metric || (metric.tcpEstablished == null && metric.sshEstablished == null)) {
    return '---';
  }
  const tcpStr = metric.tcpEstablished != null ? `${metric.tcpEstablished}` : '--';
  const sshStr = metric.sshEstablished != null ? `${metric.sshEstablished}` : '--';
  return `TCP ${tcpStr} / SSH ${sshStr}`;
};

// 运行状态颜色只表达资源紧张程度，阈值保持简单直观，方便快速扫一眼定位高占用。
export const metricTone = (percent?: number | null): 'neutral' | 'danger' | 'warning' | 'ok' => {
  if (percent == null || !Number.isFinite(percent)) {
    return 'neutral';
  }
  if (percent >= 85) {
    return 'danger';
  }
  if (percent >= 65) {
    return 'warning';
  }
  return 'ok';
};
