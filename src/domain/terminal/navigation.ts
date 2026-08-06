/* 本模块从 Store 中按业务边界提取；领域规则不得依赖 Zustand，应用服务只暴露稳定操作。 */


export const parentRemotePath = (path: string) => {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  parts.pop();
  return normalized.startsWith('/') ? `/${parts.join('/')}` || '/' : parts.join('/');
};



export const stripWrappedQuotes = (value: string) => value.replace(/^['"]|['"]$/g, '');



export const guessNextRemotePath = (currentPath: string, commandText: string) => {
  const lastLine = commandText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);

  if (!lastLine) {
    return undefined;
  }

  const match = lastLine.match(/^cd(?:\s+(.+?))?\s*;?$/);
  if (!match) {
    return undefined;
  }

  const rawTarget = stripWrappedQuotes((match[1]?.trim() ?? '').replace(/^--\s+/, ''));
  if (!rawTarget || rawTarget === '~') {
    return '~';
  }
  if (rawTarget === '.') {
    return currentPath || '~';
  }
  if (rawTarget === '..') {
    return parentRemotePath(currentPath) || '~';
  }
  if (rawTarget.startsWith('/') || rawTarget.startsWith('~')) {
    return rawTarget;
  }

  return `${currentPath.replace(/\/$/, '')}/${rawTarget}`.replace(/\/+/g, '/');
};
