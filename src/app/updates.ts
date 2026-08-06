/* 本模块由 App 入口按功能域拆出，保留原组件行为与状态订阅方式。 */
import { translate } from '../i18n';
import type { UiLanguage } from '../types';

// 后端更新检查错误以 "update_error:{code}:{params}" 结构返回（避免内嵌语言造成中英混杂），
// 前端解析错误码后按当前界面语言翻译成完整文案；非该格式的错误（如 invoke 层异常）原样透传。
export const translateUpdateCheckError = (reason: string, language: UiLanguage): string => {
  const PREFIX = 'update_error:';
  if (!reason.startsWith(PREFIX)) {
    return translate(language, 'statusUpdateCheckFailed', { reason });
  }
  const rest = reason.slice(PREFIX.length);
  const sepIndex = rest.indexOf(':');
  const code = sepIndex >= 0 ? rest.slice(0, sepIndex) : rest;
  const params = sepIndex >= 0 ? rest.slice(sepIndex + 1) : '';
  switch (code) {
    case 'rate_limited': {
      // 参数是配额重置的 Unix 秒时间戳；按当前语言格式化为本地时间。
      const resetTs = Number(params);
      const resetText =
        Number.isFinite(resetTs) && resetTs > 0
          ? translate(language, 'statusUpdateErrorRateLimitReset', {
              time: new Date(resetTs * 1000).toLocaleTimeString(language, {
                hour: '2-digit',
                minute: '2-digit',
              }),
            })
          : '';
      return translate(language, 'statusUpdateErrorRateLimited', { resetText });
    }
    case 'forbidden':
      return translate(language, 'statusUpdateErrorForbidden');
    case 'network':
      return translate(language, 'statusUpdateErrorNetwork', { details: params });
    case 'http_status':
      return translate(language, 'statusUpdateErrorHttpStatus', { details: params });
    case 'parse':
      return translate(language, 'statusUpdateErrorParse', { details: params });
    default:
      return translate(language, 'statusUpdateCheckFailed', { reason });
  }
};
