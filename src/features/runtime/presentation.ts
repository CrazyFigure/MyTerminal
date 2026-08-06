/* 功能域展示规则：不持有 React 页面状态，只把输入转换成稳定的显示结果。 */
import { clamp } from '../../shared/numbers';

// 内存展开区只展示前 4 项，降低远端 ps 查询和前端渲染负担。
export const runtimeResourceDetailLimit = 4;



export const parseMetricPercent = (value: string) => {
  const match = value.match(/\((\d+(?:\.\d+)?)%\)|(\d+(?:\.\d+)?)\s*%/);
  const rawPercent = match?.[1] ?? match?.[2];
  if (!rawPercent) {
    return undefined;
  }

  const percent = Number(rawPercent);
  return Number.isFinite(percent) ? clamp(percent, 0, 100) : undefined;
};



// 运行状态颜色只表达资源紧张程度，阈值保持简单直观，方便快速扫一眼定位高占用。
export const metricTone = (percent?: number) => {
  if (percent === undefined) {
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
