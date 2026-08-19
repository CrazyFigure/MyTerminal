// 终端英文字体只允许等宽字体参与首选匹配；比例字体会让 xterm 依据宽字形放大整张字符网格。
// 优先推荐内置的 JetBrains Mono Light（细体）与标准体、以及 Maple Mono
export const terminalLatinFontOptions = [
  'JetBrains Mono Light',
  'JetBrains Mono',
  'Maple Mono Normal NF CN Light',
  'Maple Mono Normal NF CN',
  'Maple Mono Normal NF CN Regular',
  'Cascadia Mono',
  'Consolas',
  'Fira Code',
  'Roboto Mono',
  'Source Code Pro',
  'Monaco',
  'Courier New',
];

// 中文字体仍允许选择系统中的任意字体族；真正的 ASCII 单元格宽度始终由已验证的等宽英文字体决定。
// 优先推荐内置的 Maple Mono Normal NF CN Light 与标准体
export const terminalCjkFontOptions = [
  'Maple Mono Normal NF CN Light',
  'Maple Mono Normal NF CN',
  'Maple Mono Normal NF CN Regular',
  'Microsoft YaHei UI',
  'Microsoft YaHei',
  'SimSun',
  'SimHei',
  'Microsoft JhengHei UI',
  'Noto Sans CJK SC',
  'Sarasa Mono SC',
  'PingFang SC',
];

// 跨平台等宽兜底按常见可用性排序；只有首选字体缺失或不是等宽字体时才会接管 ASCII。
const terminalMonospaceFallbacks = [
  'JetBrains Mono Light',
  'JetBrains Mono',
  'Maple Mono Normal NF CN Light',
  'Maple Mono Normal NF CN',
  'Cascadia Mono',
  'Consolas',
  'SFMono-Regular',
  'Menlo',
  'Monaco',
  'DejaVu Sans Mono',
  'Liberation Mono',
  'Noto Sans Mono',
  'Ubuntu Mono',
  'Roboto Mono',
  'Source Code Pro',
  'Fira Code',
  'Hack',
  'IBM Plex Mono',
  'Courier New',
] as const;

// 软件内置字体集合（随安装包打包，开箱即用，始终可用且优先于系统缺失探测）
export const builtinTerminalFontFamilies = new Set([
  'jetbrains mono',
  'jetbrains mono light',
  'maple mono normal nf cn',
  'maple mono normal nf cn light',
  'maple mono normal nf cn regular',
]);

const genericFontFamilies = new Set(['monospace', 'sans-serif', 'serif', 'cursive', 'fantasy', 'system-ui', 'ui-monospace']);
const fontDetectionFallbacks = ['monospace', 'sans-serif', 'serif'] as const;
const fontDetectionSamples = ['mmmmmmmmmmlliWW', '0123456789@#%&', 'BESbswy'] as const;
const fontDetectionSize = 72;
const fontMetricTolerance = 0.05;
const fontAvailabilityCache = new Map<string, boolean>();
const fontMonospaceCache = new Map<string, boolean>();
let fontMeasurementContext: CanvasRenderingContext2D | null | undefined;

export const normalizeTerminalFontFamily = (fontFamily: string) =>
  fontFamily.trim().replace(/^['"]|['"]$/g, '');

export const quoteTerminalFontFamily = (fontFamily: string) => {
  const cleaned = normalizeTerminalFontFamily(fontFamily);
  if (!cleaned) {
    return undefined;
  }
  return /\s/.test(cleaned) && !genericFontFamilies.has(cleaned.toLowerCase())
    ? `"${cleaned.replace(/"/g, '\\"')}"`
    : cleaned;
};

// 字体测量只创建一个离屏 canvas，并缓存每个字体的结论，避免设置页枚举大量字体时反复分配 DOM 对象。
const getFontMeasurementContext = () => {
  if (fontMeasurementContext !== undefined) {
    return fontMeasurementContext;
  }
  if (typeof document === 'undefined') {
    fontMeasurementContext = null;
    return fontMeasurementContext;
  }
  const canvas = document.createElement('canvas');
  fontMeasurementContext = canvas.getContext('2d');
  if (fontMeasurementContext) {
    fontMeasurementContext.fontKerning = 'none';
  }
  return fontMeasurementContext;
};

const measureFontSamples = (context: CanvasRenderingContext2D, fontFamily: string) => {
  context.font = `${fontDetectionSize}px ${fontFamily}`;
  return fontDetectionSamples.map((sample) => context.measureText(sample).width);
};

// FontFaceSet.check 对不存在的本机字体也可能因 fallback 可用而返回 true；改用三种基线宽度识别真实字体命中。
export const isTerminalFontFamilyAvailable = (fontFamily: string) => {
  const cleaned = normalizeTerminalFontFamily(fontFamily);
  const normalized = cleaned.toLowerCase();
  if (!cleaned) {
    return false;
  }
  // 通用族名与内置打包字体始终可用
  if (genericFontFamilies.has(normalized) || builtinTerminalFontFamilies.has(normalized)) {
    return true;
  }
  const cached = fontAvailabilityCache.get(normalized);
  if (cached !== undefined) {
    return cached;
  }

  const context = getFontMeasurementContext();
  if (!context) {
    // 非浏览器环境无法做字形测量，由调用方提供的系统字体列表继续完成确定性筛选。
    return true;
  }
  const quoted = quoteTerminalFontFamily(cleaned) ?? cleaned;
  const available = fontDetectionFallbacks.some((fallback) => {
    const baseline = measureFontSamples(context, fallback);
    const candidate = measureFontSamples(context, `${quoted}, ${fallback}`);
    return candidate.some((width, index) => Math.abs(width - baseline[index]) > fontMetricTolerance);
  });
  fontAvailabilityCache.set(normalized, available);
  return available;
};

// xterm 的字符格要求 ASCII 字符等宽；比较窄字、宽字、数字和符号，避免只凭字体名称猜测。
export const isTerminalMonospaceFontFamily = (fontFamily: string) => {
  const cleaned = normalizeTerminalFontFamily(fontFamily);
  const normalized = cleaned.toLowerCase();
  if (!cleaned) {
    return false;
  }
  // 通用等宽与内置等宽字体始终判定为等宽可用
  if (normalized === 'monospace' || normalized === 'ui-monospace' || builtinTerminalFontFamilies.has(normalized)) {
    return true;
  }
  const cached = fontMonospaceCache.get(normalized);
  if (cached !== undefined) {
    return cached;
  }
  if (!isTerminalFontFamilyAvailable(cleaned)) {
    fontMonospaceCache.set(normalized, false);
    return false;
  }

  const context = getFontMeasurementContext();
  if (!context) {
    const knownMonospaceFonts = new Set(
      [...terminalLatinFontOptions, ...terminalMonospaceFallbacks].map((candidate) => candidate.toLowerCase()),
    );
    return knownMonospaceFonts.has(normalized);
  }
  const quoted = quoteTerminalFontFamily(cleaned) ?? cleaned;
  context.font = `${fontDetectionSize}px ${quoted}`;
  const widths = ['i', 'W', '0', '@', ' '].map((character) => context.measureText(character).width);
  const monospace = widths.every((width) => Math.abs(width - widths[0]) <= fontMetricTolerance);
  fontMonospaceCache.set(normalized, monospace);
  return monospace;
};

const buildInstalledFontLookup = (installedFontFamilies?: readonly string[]) => {
  if (!installedFontFamilies?.length) {
    return undefined;
  }
  return new Map(
    installedFontFamilies
      .map((fontFamily) => normalizeTerminalFontFamily(fontFamily))
      .filter(Boolean)
      .map((fontFamily) => [fontFamily.toLowerCase(), fontFamily]),
  );
};

// 首选字体缺失、被卸载或实际为比例字体时，选择本机可用的等宽字体，阻止中文 fallback 接管 xterm 的 W 宽度测量。
export const resolveTerminalLatinFontFamily = (
  preferredFontFamily: string,
  installedFontFamilies?: readonly string[],
) => {
  const installedFonts = buildInstalledFontLookup(installedFontFamilies);
  const candidates = [normalizeTerminalFontFamily(preferredFontFamily), ...terminalMonospaceFallbacks];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase();
    if (!candidate || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    // 优先命中系统字体；若系统未安装但属于软件内置字体，仍判定命中
    const installedName = installedFonts
      ? (installedFonts.get(normalized) ?? (builtinTerminalFontFamilies.has(normalized) ? candidate : undefined))
      : candidate;
    if (!installedName || !isTerminalMonospaceFontFamily(installedName)) {
      continue;
    }
    return installedName;
  }
  return 'monospace';
};

// AI 对话正文允许比例字体参与，推荐列表同时覆盖常见界面字体与等宽字体。
export const agentChatLatinFontOptions = [
  'Segoe UI',
  'Arial',
  'Tahoma',
  'Verdana',
  'Helvetica Neue',
  'Georgia',
  'Times New Roman',
  'JetBrains Mono Light',
  'JetBrains Mono',
  'Cascadia Mono',
  'Consolas',
  'Fira Code',
  'Source Code Pro',
];

// AI 对话中文字体允许任意字体族；代码块单独使用终端等宽字体栈，不受这里影响。
export const agentChatCjkFontOptions = [
  'Maple Mono Normal NF CN Light',
  'Maple Mono Normal NF CN',
  'Microsoft YaHei UI',
  'Microsoft YaHei',
  'PingFang SC',
  'Noto Sans CJK SC',
  'Noto Serif CJK SC',
  'SimHei',
  'SimSun',
  'KaiTi',
  'Microsoft JhengHei UI',
  'Sarasa UI SC',
  'Sarasa Mono SC',
];

// AI 对话字体栈的跨平台界面字体兜底；与终端不同，这里不要求 ASCII 等宽。
const agentChatFallbackFonts = [
  'Segoe UI',
  'PingFang SC',
  'Helvetica Neue',
  'Noto Sans CJK SC',
  'Arial',
  'DejaVu Sans',
  'Liberation Sans',
] as const;

// AI 对话正文不要求等宽：首选字体只做可用性检测，缺失时按界面字体兜底逐级回落。
export const buildAgentChatFontFamily = (
  latinFontFamily: string,
  cjkFontFamily: string,
  installedFontFamilies?: readonly string[],
) => {
  const installedFonts = buildInstalledFontLookup(installedFontFamilies);
  const candidates = [normalizeTerminalFontFamily(latinFontFamily), ...agentChatFallbackFonts];
  let primaryFont = 'sans-serif';
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase();
    if (!candidate || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    // 优先命中系统字体；若系统未安装但属于软件内置字体，仍判定命中
    const installedName = installedFonts
      ? (installedFonts.get(normalized) ?? (builtinTerminalFontFamilies.has(normalized) ? candidate : undefined))
      : candidate;
    if (installedName && isTerminalFontFamilyAvailable(installedName)) {
      primaryFont = quoteTerminalFontFamily(installedName) ?? 'sans-serif';
      break;
    }
  }
  const cjkFont = quoteTerminalFontFamily(cjkFontFamily);
  const fallbackFonts = agentChatFallbackFonts
    .map((fallback) => quoteTerminalFontFamily(fallback))
    .filter((fallback): fallback is string => Boolean(fallback));

  return [primaryFont, cjkFont, ...fallbackFonts, 'sans-serif']
    .filter((fontFamily): fontFamily is string => Boolean(fontFamily))
    .filter((fontFamily, index, array) => {
      const normalized = normalizeTerminalFontFamily(fontFamily).toLowerCase();
      return array.findIndex((candidate) => normalizeTerminalFontFamily(candidate).toLowerCase() === normalized) === index;
    })
    .join(', ');
};

// 终端与设置预览必须共享同一字体栈，确保用户预览到的字符宽度就是保存后 xterm 实际采用的宽度。
export const buildTerminalFontFamily = (
  latinFontFamily: string,
  cjkFontFamily: string,
  installedFontFamilies?: readonly string[],
) => {
  const resolvedLatin = resolveTerminalLatinFontFamily(latinFontFamily, installedFontFamilies);
  const primaryFont = quoteTerminalFontFamily(resolvedLatin) ?? 'monospace';
  const cjkFont = quoteTerminalFontFamily(cjkFontFamily);
  const normalizedPrimary = normalizeTerminalFontFamily(primaryFont).toLowerCase();
  const normalizedCjk = cjkFont ? normalizeTerminalFontFamily(cjkFont).toLowerCase() : undefined;
  const fallbackFonts = terminalMonospaceFallbacks
    .filter((fallback) => fallback.toLowerCase() !== normalizedPrimary && fallback.toLowerCase() !== normalizedCjk)
    .map((fallback) => quoteTerminalFontFamily(fallback))
    .filter((fallback): fallback is string => Boolean(fallback));

  return [primaryFont, cjkFont, ...fallbackFonts, 'monospace']
    .filter((fontFamily): fontFamily is string => Boolean(fontFamily))
    .filter((fontFamily, index, array) => {
      const normalized = normalizeTerminalFontFamily(fontFamily).toLowerCase();
      return array.findIndex((candidate) => normalizeTerminalFontFamily(candidate).toLowerCase() === normalized) === index;
    })
    .join(', ');
};
