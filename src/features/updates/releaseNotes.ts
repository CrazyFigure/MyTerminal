// 更新日志的分组与摘要属于展示规则；保留原始 Markdown 正文，避免样式调整损失代码块或表格。
export type ReleaseNoteKind = 'added' | 'fixed' | 'improved' | 'other';

export type ReleaseNoteSection = {
  title: string | null;
  kind: ReleaseNoteKind;
  source: string;
  count: number;
};

/** 按中英文小节标题选择摘要圆点和正文标题的配色，未知标题仍保留展示。 */
function detectKind(title: string): ReleaseNoteKind {
  if (/新增|新功能|\b(feat(?:ures?)?|added|new)\b/i.test(title)) return 'added';
  if (/修复|修正|\b(fix(?:ed|es)?|bugs?)\b/i.test(title)) return 'fixed';
  if (/优化|改进|调整|变更|重构|性能|\b(improve(?:d|ments?)?|perf(?:ormance)?|changes?|refactor)\b/i.test(title)) return 'improved';
  return 'other';
}

/** 兼容发布脚本的“新增：”、Markdown 标题及整行加粗标题。 */
function matchHeading(line: string): string | null {
  const title = /^#{1,6}\s+(.+?)\s*#*$/.exec(line)?.[1]
    ?? /^\*\*(.+?)\*\*\s*[：:]?$/.exec(line)?.[1]
    ?? /^([^\s*+\-].{0,15}?)\s*[：:]$/.exec(line)?.[1];
  return title?.replace(/[：:]$/, '').trim() || null;
}

/**
 * 拆分更新说明并统计各节顶层条目；嵌套说明、代码围栏和“本次暂无”占位不计为改动。
 * 无标题正文原样保留，不生成推测性的分类摘要；统计不会改写展示内容。
 */
export function parseReleaseNotes(body: string): ReleaseNoteSection[] {
  const sections: ReleaseNoteSection[] = [];
  let current: ReleaseNoteSection | undefined;
  let lines: string[] = [];
  let items: Array<{ indent: number; text: string }> = [];
  let paragraphs = 0;
  let fence: string | undefined;

  // 切换小节或结束输入时统一收尾；空分组保留标题，但不显示零条摘要。
  const finishSection = () => {
    if (!current) return;
    current.source = lines.join('\n').trim();
    const rootIndent = Math.min(...items.map((item) => item.indent));
    current.count = items.length ? items.filter((item) => item.indent === rootIndent
      && !/^本次暂无.*项[。.!！]?$/.test(item.text)).length : paragraphs;
    sections.push(current);
    lines = [];
    items = [];
    paragraphs = 0;
  };

  for (const rawLine of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    // 围栏中的标题、列表和空行都属于代码，不能拆成新的更新分组或计入摘要。
    const marker = /^(`{3,}|~{3,})/.exec(line)?.[1];
    const inCode = Boolean(fence || marker);
    if (marker) {
      if (!fence) fence = marker;
      else if (new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = undefined;
    }
    const title = inCode ? null : matchHeading(line);
    if (title) {
      finishSection();
      current = { title, kind: detectKind(title), source: '', count: 0 };
      continue;
    }
    if (!current) {
      if (!line) continue;
      current = { title: null, kind: 'other', source: '', count: 0 };
    }
    lines.push(rawLine);
    if (!line || inCode) continue;
    const item = /^(\s*)(?:[-*+]|\d+[.)])\s+(.+)$/.exec(rawLine);
    if (item) items.push({ indent: item[1].length, text: item[2].trim() });
    else paragraphs += 1;
  }
  finishSection();
  return sections;
}
