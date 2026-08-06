import { translate } from '../../i18n';
import type { AppSettings } from '../../types';

// 所有 Store 切片使用同一状态文案入口，保证语言设置和占位参数语义一致。
export const statusText = (
  settings: AppSettings,
  key: Parameters<typeof translate>[1],
  replacements?: Parameters<typeof translate>[2],
) => translate(settings.uiLanguage, key, replacements);
