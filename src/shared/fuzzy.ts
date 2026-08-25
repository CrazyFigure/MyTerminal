/**
 * 模糊匹配纯算法：
 * 优先级依次为完全匹配、前缀、连续包含和字符子序列；分词后每一项都必须命中。
 * 返回分值越小匹配度越高，未命中返回 undefined。
 */
export const scoreFuzzyText = (source: string, query: string): number | undefined => {
  const normalizedSource = source.normalize('NFKC').toLocaleLowerCase();
  const terms = query
    .normalize('NFKC')
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) {
    return 0;
  }

  let totalScore = 0;
  for (const term of terms) {
    if (normalizedSource === term) {
      continue;
    }
    if (normalizedSource.startsWith(term)) {
      totalScore += 10 + normalizedSource.length - term.length;
      continue;
    }
    const containedAt = normalizedSource.indexOf(term);
    if (containedAt >= 0) {
      totalScore += 30 + containedAt;
      continue;
    }

    let sourceIndex = 0;
    let gapScore = 0;
    for (const character of term) {
      const matchedAt = normalizedSource.indexOf(character, sourceIndex);
      if (matchedAt < 0) {
        return undefined;
      }
      gapScore += matchedAt - sourceIndex;
      sourceIndex = matchedAt + 1;
    }
    totalScore += 100 + gapScore;
  }
  return totalScore;
};

/**
 * 历史命令匹配规则（精准快速的前后缀与连续子串包含匹配）：
 * 1. 支持按空格拆分多个关键词（分词），所有关键词都必须命中（AND 逻辑）。
 * 2. 匹配模式优先级：完全匹配 (0) > 前缀匹配 (10+) > 后缀匹配 (20+) > 连续子串包含 (30+)。
 * 3. 避免散落单字子序列跨越匹配（如 "olology" 不会误匹配 "/ology/ology-server/"）。
 * 4. 复杂度为 O(N) 纯原生子串匹配，性能极高无额外开销。
 */
export const scoreCommandMatch = (command: string, query: string): number | undefined => {
  const normalizedCommand = command.normalize('NFKC').toLocaleLowerCase();
  const terms = query
    .normalize('NFKC')
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!terms.length) {
    return 0;
  }

  let totalScore = 0;

  for (const term of terms) {
    if (normalizedCommand === term) {
      continue;
    }
    if (normalizedCommand.startsWith(term)) {
      totalScore += 10 + (normalizedCommand.length - term.length);
      continue;
    }
    if (normalizedCommand.endsWith(term)) {
      totalScore += 20 + (normalizedCommand.length - term.length);
      continue;
    }
    const index = normalizedCommand.indexOf(term);
    if (index >= 0) {
      totalScore += 30 + index;
      continue;
    }

    return undefined;
  }

  return totalScore;
};
