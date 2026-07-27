/**
 * 面向 AI 流式回复的轻量 Markdown 解析器。
 *
 * 为什么不用 react-markdown / marked：
 * 1. 首屏体积敏感（项目有 check:bundle 守卫），这里只需要常见子集。
 * 2. 流式场景要求「未闭合也能渲染」——代码块只写了开头的 ``` 就要立刻显示成代码块，
 *    标准解析器会把它当普通文本，直到收到结尾才突然重排，观感很差。
 */

export type MarkdownNode =
  | { type: 'paragraph'; spans: InlineSpan[] }
  | { type: 'heading'; level: number; spans: InlineSpan[] }
  | { type: 'code'; lang: string; text: string; closed: boolean }
  | { type: 'list'; ordered: boolean; start: number; items: InlineSpan[][] }
  | { type: 'quote'; spans: InlineSpan[] }
  | { type: 'divider' }
  | {
      type: 'table';
      headers: InlineSpan[][];
      rows: InlineSpan[][][];
      aligns: Array<'left' | 'center' | 'right' | null>;
    };

export type InlineSpan =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string }
  | { type: 'link'; text: string; href: string };

/** 行内标记的匹配顺序很重要：先粗体再斜体，否则 `**x**` 会被拆成两个斜体。
 *  强调标记要求内侧紧邻非空白，先挡掉 `2 * 3 * 4` 这类乘法式误报；
 *  下划线强调的单词边界校验放在 isEmphasisAllowed 里按上下文判断。 */
const INLINE_PATTERN =
  /(`[^`]+`)|(\*\*[^*\s](?:[^*\n]*?[^*\s])?\*\*)|(__[^_\s](?:[^_\n]*?[^_\s])?__)|(\*[^*\s](?:[^*\n]*?[^*\s])?\*)|(_[^_\s](?:[^_\n]*?[^_\s])?_)|(\[[^\]]*\]\([^)\s]+\))/;

const isAsciiWordChar = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

/** 强调匹配的上下文边界校验，不通过则降级为纯文本。 */
function isEmphasisAllowed(token: string, before: string | undefined, after: string | undefined) {
  if (token.startsWith('_')) {
    // 词内下划线按字面量处理（CommonMark 同款行为），保护 my_var_name 这类标识符。
    return !isAsciiWordChar(before) && !isAsciiWordChar(after);
  }
  if (token.startsWith('*')) {
    // 闭合星号后面紧跟字母数字时拒绝，否则 src/*.ts 与 src/*.tsx 会被渲染成斜体。
    return after === undefined || !/[A-Za-z0-9]/.test(after);
  }
  return true;
}

/** 解析一行里的行内标记。未闭合的标记按纯文本处理，避免流式过程中闪烁。 */
export function parseInline(source: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let rest = source;

  while (rest) {
    const match = INLINE_PATTERN.exec(rest);
    if (!match || match.index === undefined) {
      spans.push({ type: 'text', text: rest });
      break;
    }

    const token = match[0];
    const before = rest[match.index - 1];
    const after = rest[match.index + token.length];

    // 边界校验失败时，只把匹配的首字符按字面量输出，再从其后继续扫描——
    // 不能整段跳过，token 内部可能还存在合法匹配。
    if (!isEmphasisAllowed(token, before, after)) {
      spans.push({ type: 'text', text: rest.slice(0, match.index + 1) });
      rest = rest.slice(match.index + 1);
      continue;
    }

    if (match.index > 0) {
      spans.push({ type: 'text', text: rest.slice(0, match.index) });
    }

    if (token.startsWith('`')) {
      spans.push({ type: 'code', text: token.slice(1, -1) });
    } else if (token.startsWith('**') || token.startsWith('__')) {
      spans.push({ type: 'bold', text: token.slice(2, -2) });
    } else if (token.startsWith('[')) {
      const divider = token.indexOf('](');
      spans.push({
        type: 'link',
        text: token.slice(1, divider),
        href: token.slice(divider + 2, -1),
      });
    } else {
      spans.push({ type: 'italic', text: token.slice(1, -1) });
    }

    rest = rest.slice(match.index + token.length);
  }

  return spans.filter((span) => span.type !== 'text' || span.text.length > 0);
}

/** 表格分隔行里允许的「横线」字符：ASCII 连字符、全角连字符、em/en dash、制表符横线。
 *  中文模型常输出 `|——|——|` 这种破折号分隔行，标准 GFM 解析器会判失败，这里放宽匹配。 */
const DASH_LIKE = /[-－—–─]/;

/** 一行是否是表格分隔行：每个单元格去掉冒号/空白后只含横线类字符，且至少有一个。 */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) {
    return false;
  }
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells = inner.split('|');
  return cells.every((cell) => {
    const stripped = cell.replace(/[:\s]/g, '');
    return stripped.length > 0 && [...stripped].every((ch) => DASH_LIKE.test(ch));
  });
}

/** 把表格行按 `|` 切成单元格文本，去掉首尾管道符并 trim。 */
function splitTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) {
    body = body.slice(1);
  }
  if (body.endsWith('|')) {
    body = body.slice(0, -1);
  }
  return body.split('|').map((cell) => cell.trim());
}

/** 由分隔行单元格解析对齐方式。 */
function parseAlign(cell: string): 'left' | 'center' | 'right' | null {
  const trimmed = cell.trim();
  const left = trimmed.startsWith(':');
  const right = trimmed.endsWith(':');
  if (left && right) {
    return 'center';
  }
  if (right) {
    return 'right';
  }
  if (left) {
    return 'left';
  }
  return null;
}

/**
 * 把 Markdown 文本解析成块级节点。
 * 关键特性：遇到未闭合的 ``` 时，把余下全部内容当作代码块内容立即返回，
 * 并标记 closed=false，让界面可以显示「正在输出」的状态。
 */
export function parseMarkdown(source: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  const lines = source.split('\n');
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    // 代码块：未闭合时吃掉剩余全部内容，实现流式即时渲染。
    const fence = /^```(\S*)\s*$/.exec(trimmed);
    if (fence) {
      const lang = fence[1] ?? '';
      const body: string[] = [];
      index += 1;
      let closed = false;
      while (index < lines.length) {
        if (lines[index].trim() === '```') {
          closed = true;
          index += 1;
          break;
        }
        body.push(lines[index]);
        index += 1;
      }
      nodes.push({ type: 'code', lang, text: body.join('\n'), closed });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      nodes.push({
        type: 'heading',
        level: heading[1].length,
        spans: parseInline(heading[2]),
      });
      index += 1;
      continue;
    }

    if (/^([-*_])\1{2,}$/.test(trimmed)) {
      nodes.push({ type: 'divider' });
      index += 1;
      continue;
    }

    // 表格：当前行含 `|` 且下一行是分隔行才确认，避免把含 | 的普通文本误判成表头。
    // 流式时分隔行还没到，先按段落显示，分隔行一到下一帧即重排成表格。
    if (trimmed.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const headers = splitTableRow(line).map(parseInline);
      const aligns = splitTableRow(lines[index + 1]).map(parseAlign);
      index += 2;
      const rows: InlineSpan[][][] = [];
      while (index < lines.length) {
        const rowLine = lines[index];
        if (!rowLine.trim().includes('|')) {
          break;
        }
        rows.push(splitTableRow(rowLine).map(parseInline));
        index += 1;
      }
      nodes.push({ type: 'table', headers, rows, aligns });
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoted: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        quoted.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      nodes.push({ type: 'quote', spans: parseInline(quoted.join(' ')) });
      continue;
    }

    // 列表：连续的同类型条目合并成一个列表节点；同时保留原始起始序号。
    // AI 常在两个有序条目之间插入说明段落，此时会生成多个列表节点，若丢弃起始序号，
    // 每个独立的 <ol> 都会被浏览器错误地从 1 开始显示。
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    const ordered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || ordered) {
      const isOrdered = Boolean(ordered);
      // 无序列表不使用 start，但统一存为 1，保持节点结构简单且避免渲染层重复兜底。
      const start = ordered ? Number.parseInt(ordered[1], 10) : 1;
      const items: InlineSpan[][] = [];
      while (index < lines.length) {
        const current = lines[index].trim();
        const nextBullet = /^[-*+]\s+(.*)$/.exec(current);
        const nextOrdered = /^(\d+)[.)]\s+(.*)$/.exec(current);
        const matched = isOrdered ? nextOrdered : nextBullet;
        if (!matched) {
          break;
        }
        // 有序列表的第 1 个捕获组是序号，正文位于第 2 个捕获组；无序列表正文仍在第 1 组。
        items.push(parseInline(isOrdered ? matched[2] : matched[1]));
        index += 1;
      }
      nodes.push({ type: 'list', ordered: isOrdered, start, items });
      continue;
    }

    // 普通段落：连续非空行合并，遇到其它块级标记则中断。
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index];
      const currentTrimmed = current.trim();
      if (
        !currentTrimmed ||
        currentTrimmed.startsWith('```') ||
        currentTrimmed.startsWith('>') ||
        /^([-*_])\1{2,}$/.test(currentTrimmed) ||
        /^#{1,6}\s/.test(currentTrimmed) ||
        /^[-*+]\s/.test(currentTrimmed) ||
        /^\d+[.)]\s/.test(currentTrimmed)
      ) {
        break;
      }
      paragraph.push(currentTrimmed);
      index += 1;
    }
    if (paragraph.length) {
      nodes.push({ type: 'paragraph', spans: parseInline(paragraph.join(' ')) });
    }
  }

  return nodes;
}
