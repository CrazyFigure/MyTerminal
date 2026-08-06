/* 本模块从 Store 中按业务边界提取；领域规则不得依赖 Zustand，应用服务只暴露稳定操作。 */


export const clampPort = (value: number | undefined, fallback = 22) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(65535, Math.max(1, Math.trunc(value)));
};



export const isValidPort = (value: number) => Number.isInteger(value) && value >= 1 && value <= 65535;
