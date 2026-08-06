//! 终端提示符识别、文本匹配范围与 SVG 高亮路径算法。

import type { Terminal } from "@xterm/xterm";

import {
  terminalHighlightBorderWidthPx,
  terminalHighlightSvgNamespace,
  terminalMatchHighlightDarkBackground,
  terminalMatchHighlightDarkBorder,
  terminalMatchHighlightDarkForeground,
  terminalMatchHighlightLightBackground,
  terminalMatchHighlightLightBorder,
  terminalPromptHighlightMaxScanChars,
  type TerminalHighlightPoint,
  type TerminalHighlightStrip,
  type TerminalMatchRange,
  type TerminalPromptHighlightMatch,
  type TerminalPromptHighlightSegment,
  type TerminalPromptSegmentKind,
} from "./core";
import {
  stringLengthToTerminalBufferSize,
  translateTerminalBufferLineWithWrap,
} from "./selection";

export const terminalPromptUnixPattern =
  /^((?:\([^()\n]{1,64}\)\s+)*)([A-Za-z0-9._+-]+)(@)([A-Za-z0-9._-]+)(:)(\S*?)([#\$%])(?=\s|$)/;

export const terminalPromptUnixSpacePattern =
  /^((?:\([^()\n]{1,64}\)\s+)*)([A-Za-z0-9._+-]+)(@)([A-Za-z0-9._-]+)(\s+)(\S+?)(\s*)([#\$%])(?=\s|$)/;

export const terminalPromptBracketPattern =
  /^(\[)([A-Za-z0-9._+-]+)(@)([A-Za-z0-9._-]+)(\s+)(\S*?)(\])([#\$])(?=\s|$)/;

export const terminalPromptPowerShellPattern = /^(PS)(\s+)(.+?)(>)(?=\s|$)/;

export const terminalPromptCmdPattern = /^([A-Za-z]:[^<>|\n]*?)(>)(?=\s|$)/;

// 按正则捕获顺序累加字符串下标；渲染前再换算成 xterm 单元格列，兼容全角路径与组合字符。
export const buildTerminalPromptSegments = (
  parts: Array<{ text: string; kind: TerminalPromptSegmentKind }>,
) => {
  const segments: TerminalPromptHighlightSegment[] = [];
  let cursor = 0;
  for (const part of parts) {
    const start = cursor;
    cursor += part.text.length;
    if (cursor > start) {
      segments.push({ start, end: cursor, kind: part.kind });
    }
  }
  return segments;
};

// 返回提示符自身的彩色分段；命令正文不做改色，只由整条命令行的透明底色负责定位。
export const matchTerminalPromptSegments = (
  lineText: string,
): TerminalPromptHighlightSegment[] | undefined => {
  const text = lineText.slice(0, terminalPromptHighlightMaxScanChars);
  const unixMatch = terminalPromptUnixPattern.exec(text);
  if (unixMatch) {
    return buildTerminalPromptSegments([
      { text: unixMatch[1], kind: "separator" },
      { text: unixMatch[2], kind: "user" },
      { text: unixMatch[3], kind: "separator" },
      { text: unixMatch[4], kind: "host" },
      { text: unixMatch[5], kind: "separator" },
      { text: unixMatch[6], kind: "path" },
      { text: unixMatch[7], kind: "symbol" },
    ]);
  }

  const unixSpaceMatch = terminalPromptUnixSpacePattern.exec(text);
  if (unixSpaceMatch) {
    return buildTerminalPromptSegments([
      { text: unixSpaceMatch[1], kind: "separator" },
      { text: unixSpaceMatch[2], kind: "user" },
      { text: unixSpaceMatch[3], kind: "separator" },
      { text: unixSpaceMatch[4], kind: "host" },
      { text: unixSpaceMatch[5], kind: "separator" },
      { text: unixSpaceMatch[6], kind: "path" },
      { text: unixSpaceMatch[7], kind: "separator" },
      { text: unixSpaceMatch[8], kind: "symbol" },
    ]);
  }

  const bracketMatch = terminalPromptBracketPattern.exec(text);
  if (bracketMatch) {
    return buildTerminalPromptSegments([
      { text: bracketMatch[1], kind: "separator" },
      { text: bracketMatch[2], kind: "user" },
      { text: bracketMatch[3], kind: "separator" },
      { text: bracketMatch[4], kind: "host" },
      { text: bracketMatch[5], kind: "separator" },
      { text: bracketMatch[6], kind: "path" },
      { text: bracketMatch[7], kind: "separator" },
      { text: bracketMatch[8], kind: "symbol" },
    ]);
  }

  const powerShellMatch = terminalPromptPowerShellPattern.exec(text);
  if (powerShellMatch) {
    return buildTerminalPromptSegments([
      { text: powerShellMatch[1], kind: "user" },
      { text: powerShellMatch[2], kind: "separator" },
      { text: powerShellMatch[3], kind: "path" },
      { text: powerShellMatch[4], kind: "symbol" },
    ]);
  }

  const cmdMatch = terminalPromptCmdPattern.exec(text);
  if (cmdMatch) {
    return buildTerminalPromptSegments([
      { text: cmdMatch[1], kind: "path" },
      { text: cmdMatch[2], kind: "symbol" },
    ]);
  }
  return undefined;
};

// 从当前可视窗口收集提示符逻辑行；若窗口从软换行中间开始，先回溯到该逻辑行首再判断。
export const collectTerminalPromptHighlightMatches = (
  terminal: Terminal,
  firstRow: number,
  lastRowExclusive: number,
) => {
  const buffer = terminal.buffer.active;
  const matches: TerminalPromptHighlightMatch[] = [];
  let row = Math.max(0, firstRow);
  while (row > 0 && buffer.getLine(row)?.isWrapped) {
    row -= 1;
  }

  while (row < lastRowExclusive) {
    const line = buffer.getLine(row);
    if (!line || line.isWrapped) {
      row += 1;
      continue;
    }
    const logicalLine = translateTerminalBufferLineWithWrap(terminal, row);
    const segments = matchTerminalPromptSegments(logicalLine.text);
    if (segments && logicalLine.endRowExclusive > firstRow) {
      matches.push({ row, segments });
    }
    row = Math.max(row + 1, logicalLine.endRowExclusive);
  }
  return matches;
};

export const resolveTerminalMatchRange = (
  terminal: Terminal,
  logicalStartRow: number,
  offsets: number[],
  matchIndex: number,
  matchLength: number,
): TerminalMatchRange | undefined => {
  let startSegmentIndex = 0;
  while (
    startSegmentIndex < offsets.length - 1 &&
    matchIndex >= offsets[startSegmentIndex + 1]
  ) {
    startSegmentIndex += 1;
  }

  const matchEndIndex = matchIndex + matchLength;
  let endSegmentIndex = startSegmentIndex;
  while (
    endSegmentIndex < offsets.length - 1 &&
    matchEndIndex >= offsets[endSegmentIndex + 1]
  ) {
    endSegmentIndex += 1;
  }

  const startRow = logicalStartRow + startSegmentIndex;
  const endRow = logicalStartRow + endSegmentIndex;
  const startColumn = stringLengthToTerminalBufferSize(
    terminal,
    startRow,
    matchIndex - offsets[startSegmentIndex],
  );
  const endColumn = stringLengthToTerminalBufferSize(
    terminal,
    endRow,
    matchEndIndex - offsets[endSegmentIndex],
  );
  const size =
    endColumn -
    startColumn +
    terminal.cols * (endSegmentIndex - startSegmentIndex);
  return size > 0 ? { row: startRow, col: startColumn, size } : undefined;
};

export const collectTerminalMatchRanges = (
  terminal: Terminal,
  term: string,
  firstRow: number,
  lastRowExclusive: number,
  maxRanges: number,
) => {
  const buffer = terminal.buffer.active;
  const ranges: TerminalMatchRange[] = [];
  let row = Math.max(0, firstRow);

  while (row > 0 && buffer.getLine(row)?.isWrapped) {
    row -= 1;
  }

  while (row < lastRowExclusive && ranges.length < maxRanges) {
    const line = buffer.getLine(row);
    if (!line) {
      row += 1;
      continue;
    }
    if (line.isWrapped) {
      row += 1;
      continue;
    }

    const logicalLine = translateTerminalBufferLineWithWrap(terminal, row);
    if (logicalLine.endRowExclusive <= firstRow) {
      row = logicalLine.endRowExclusive;
      continue;
    }

    let matchIndex = logicalLine.text.indexOf(term);
    while (matchIndex >= 0 && ranges.length < maxRanges) {
      const range = resolveTerminalMatchRange(
        terminal,
        row,
        logicalLine.offsets,
        matchIndex,
        term.length,
      );
      if (
        range &&
        range.row < lastRowExclusive &&
        range.row + Math.ceil(range.size / Math.max(terminal.cols, 1)) >=
          firstRow
      ) {
        ranges.push(range);
      }
      matchIndex = logicalLine.text.indexOf(
        term,
        matchIndex + Math.max(term.length, 1),
      );
    }

    row = logicalLine.endRowExclusive;
  }

  return ranges;
};

export const formatTerminalHighlightSvgNumber = (value: number) => {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return value.toFixed(2).replace(/\.?0+$/, "");
};

export const isSameTerminalHighlightPoint = (
  first: TerminalHighlightPoint,
  second: TerminalHighlightPoint,
) => Math.abs(first.x - second.x) < 0.01 && Math.abs(first.y - second.y) < 0.01;

export const isTerminalHighlightPointCollinear = (
  previous: TerminalHighlightPoint,
  current: TerminalHighlightPoint,
  next: TerminalHighlightPoint,
) => {
  const cross =
    (current.x - previous.x) * (next.y - current.y) -
    (current.y - previous.y) * (next.x - current.x);
  return Math.abs(cross) < 0.01;
};

export const simplifyTerminalHighlightPolygon = (
  points: TerminalHighlightPoint[],
) => {
  const withoutDuplicates: TerminalHighlightPoint[] = [];
  for (const point of points) {
    if (
      !withoutDuplicates.length ||
      !isSameTerminalHighlightPoint(
        withoutDuplicates[withoutDuplicates.length - 1],
        point,
      )
    ) {
      withoutDuplicates.push(point);
    }
  }
  if (
    withoutDuplicates.length > 1 &&
    isSameTerminalHighlightPoint(
      withoutDuplicates[0],
      withoutDuplicates[withoutDuplicates.length - 1],
    )
  ) {
    withoutDuplicates.pop();
  }

  let simplified = withoutDuplicates;
  let changed = true;
  while (changed && simplified.length > 2) {
    changed = false;
    simplified = simplified.filter((point, index, list) => {
      const previous = list[(index - 1 + list.length) % list.length];
      const next = list[(index + 1) % list.length];
      const keep = !isTerminalHighlightPointCollinear(previous, point, next);
      changed ||= !keep;
      return keep;
    });
  }
  return simplified;
};

export const buildTerminalRoundedPolygonPath = (
  points: TerminalHighlightPoint[],
  radius: number,
) => {
  const simplified = simplifyTerminalHighlightPolygon(points);
  if (simplified.length < 3) {
    return "";
  }

  const commands: string[] = [];
  for (let index = 0; index < simplified.length; index += 1) {
    const previous =
      simplified[(index - 1 + simplified.length) % simplified.length];
    const current = simplified[index];
    const next = simplified[(index + 1) % simplified.length];
    const previousLength = Math.hypot(
      previous.x - current.x,
      previous.y - current.y,
    );
    const nextLength = Math.hypot(next.x - current.x, next.y - current.y);
    if (previousLength <= 0.01 || nextLength <= 0.01) {
      continue;
    }
    const cornerRadius = Math.min(radius, previousLength / 2, nextLength / 2);
    const entry = {
      x: current.x + ((previous.x - current.x) / previousLength) * cornerRadius,
      y: current.y + ((previous.y - current.y) / previousLength) * cornerRadius,
    };
    const exit = {
      x: current.x + ((next.x - current.x) / nextLength) * cornerRadius,
      y: current.y + ((next.y - current.y) / nextLength) * cornerRadius,
    };
    const entryPoint = `${formatTerminalHighlightSvgNumber(entry.x)} ${formatTerminalHighlightSvgNumber(entry.y)}`;
    const exitPoint = `${formatTerminalHighlightSvgNumber(exit.x)} ${formatTerminalHighlightSvgNumber(exit.y)}`;
    const controlPoint = `${formatTerminalHighlightSvgNumber(current.x)} ${formatTerminalHighlightSvgNumber(current.y)}`;
    if (index === 0) {
      commands.push(`M ${entryPoint}`);
    } else {
      commands.push(`L ${entryPoint}`);
    }
    commands.push(`Q ${controlPoint} ${exitPoint}`);
  }
  if (!commands.length) {
    return "";
  }
  commands.push("Z");
  return commands.join(" ");
};

export const buildTerminalHighlightPath = (
  strips: TerminalHighlightStrip[],
  radius: number,
) => {
  const orderedStrips = strips
    .filter((strip) => strip.right > strip.left && strip.bottom > strip.top)
    .sort(
      (first, second) => first.top - second.top || first.left - second.left,
    );
  if (!orderedStrips.length) {
    return "";
  }

  const firstStrip = orderedStrips[0];
  const lastStrip = orderedStrips[orderedStrips.length - 1];
  const points: TerminalHighlightPoint[] = [
    { x: firstStrip.left, y: firstStrip.top },
    { x: firstStrip.right, y: firstStrip.top },
  ];

  for (let index = 0; index < orderedStrips.length - 1; index += 1) {
    const current = orderedStrips[index];
    const next = orderedStrips[index + 1];
    points.push({ x: current.right, y: current.bottom });
    if (Math.abs(current.right - next.right) > 0.01) {
      points.push({ x: next.right, y: current.bottom });
    }
  }

  points.push({ x: lastStrip.right, y: lastStrip.bottom });
  points.push({ x: lastStrip.left, y: lastStrip.bottom });

  for (let index = orderedStrips.length - 1; index > 0; index -= 1) {
    const current = orderedStrips[index];
    const previous = orderedStrips[index - 1];
    points.push({ x: current.left, y: current.top });
    if (Math.abs(current.left - previous.left) > 0.01) {
      points.push({ x: previous.left, y: current.top });
    }
  }

  return buildTerminalRoundedPolygonPath(points, radius);
};

export const createTerminalHighlightPathElement = (
  className: string,
  color: string,
  borderColor: string,
  pathValue: string,
) => {
  const path = document.createElementNS(terminalHighlightSvgNamespace, "path");
  path.setAttribute("class", className);
  path.setAttribute("d", pathValue);
  path.setAttribute("fill", color);
  path.setAttribute("stroke", borderColor);
  path.setAttribute("stroke-width", `${terminalHighlightBorderWidthPx}`);
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("vector-effect", "non-scaling-stroke");
  return path;
};

// 匹配高亮需要按主题换底色，避免深色模式白色终端字压在浅灰命中块上读不清。
export const resolveTerminalMatchHighlightColors = (isDarkTheme: boolean) =>
  isDarkTheme
    ? {
        background: terminalMatchHighlightDarkBackground,
        border: terminalMatchHighlightDarkBorder,
        foreground: terminalMatchHighlightDarkForeground,
      }
    : {
        background: terminalMatchHighlightLightBackground,
        border: terminalMatchHighlightLightBorder,
        foreground: undefined,
      };

// 横向列数只在确实超过可视宽度时增长，并按固定步长取整来减少后端 resize 抖动。
