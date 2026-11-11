//! 终端提示符识别、文本匹配范围与 SVG 高亮路径算法。

import type { Terminal } from "@xterm/xterm";

import {
  advanceTerminalCommandContinuation,
  createTerminalCommandContinuationState,
  isTerminalCommandContinuationOpen,
  matchTerminalContinuationPrompt,
  type TerminalCommandContinuationState,
  type TerminalShellDialect,
} from "../../domain/terminal/commandContinuation";
import {
  terminalHighlightBorderWidthPx,
  terminalHighlightSvgNamespace,
  terminalMatchHighlightDarkBackground,
  terminalMatchHighlightDarkBorder,
  terminalMatchHighlightDarkForeground,
  terminalMatchHighlightLightBackground,
  terminalMatchHighlightLightBorder,
  terminalPromptHighlightMaxScanChars,
  terminalPromptInputLookbackRows,
  type TerminalHighlightPoint,
  type TerminalHighlightStrip,
  type TerminalMatchDecorationRange,
  type TerminalMatchRange,
  type TerminalPromptHighlightMatch,
  type TerminalPromptHighlightSegment,
  type TerminalPromptInputLine,
  type TerminalPromptLineScan,
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

// 返回提示符自身的彩色分段；命令正文的着色由输入区扫描单独负责。
export const matchTerminalPromptSegments = (
  lineText: string,
): TerminalPromptHighlightSegment[] | undefined =>
  matchTerminalPromptLine(lineText)?.segments;

// 识别提示符并给出 Shell 方言：续行规则（bash `> ` / pwsh `>> `）与转义字符都依赖方言。
export const matchTerminalPromptLine = (
  lineText: string,
): { segments: TerminalPromptHighlightSegment[]; dialect: TerminalShellDialect } | undefined => {
  const segments = matchTerminalPromptSegmentsByPattern(lineText);
  if (!segments) {
    return undefined;
  }
  // 与分段匹配保持相同的优先级：Unix 系提示符优先，其次 PowerShell，最后 cmd。
  const text = lineText.slice(0, terminalPromptHighlightMaxScanChars);
  let dialect: TerminalShellDialect = 'cmd';
  if (
    terminalPromptUnixPattern.test(text)
    || terminalPromptUnixSpacePattern.test(text)
    || terminalPromptBracketPattern.test(text)
  ) {
    dialect = 'posix';
  } else if (terminalPromptPowerShellPattern.test(text)) {
    dialect = 'powershell';
  }
  return { segments, dialect };
};

const matchTerminalPromptSegmentsByPattern = (
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

// 逻辑行字符串下标 → 物理行与单元格列；与 resolveTerminalMatchRange 使用相同的分段边界规则。
export const resolveTerminalLogicalOffsetPosition = (
  terminal: Terminal,
  logicalStartRow: number,
  offsets: number[],
  index: number,
) => {
  let segmentIndex = 0;
  while (segmentIndex < offsets.length - 1 && index >= offsets[segmentIndex + 1]) {
    segmentIndex += 1;
  }
  const row = logicalStartRow + segmentIndex;
  return {
    row,
    column: stringLengthToTerminalBufferSize(terminal, row, index - offsets[segmentIndex]),
  };
};

// 一次扫描同时产出提示符分段与命令输入区：
// - 提示符之后到逻辑行末为输入；只按回车的空提示符记为 hasCommand=false；
// - 上一条命令未结束（引号/括号/heredoc/行尾续行符等）时，紧随的 `> `/`>> ` 续行也算输入；
// - 其余行（包括 AI CLI、REPL 等自定义程序的输出）一律视为普通输出，不着色。
// 续行判定需要上文，所以从可视区上方回看一段，但只返回与可视区相交的结果。
export const scanTerminalPromptLines = (
  terminal: Terminal,
  firstRow: number,
  lastRowExclusive: number,
): TerminalPromptLineScan => {
  const buffer = terminal.buffer.active;
  const matches: TerminalPromptHighlightMatch[] = [];
  const inputs: TerminalPromptInputLine[] = [];
  let row = Math.max(0, firstRow - terminalPromptInputLookbackRows);
  while (row > 0 && buffer.getLine(row)?.isWrapped) {
    row -= 1;
  }

  let continuation: TerminalCommandContinuationState | undefined;
  while (row < lastRowExclusive) {
    const line = buffer.getLine(row);
    if (!line || line.isWrapped) {
      row += 1;
      continue;
    }
    const logicalLine = translateTerminalBufferLineWithWrap(terminal, row);
    const isVisible = logicalLine.endRowExclusive > firstRow;
    const prompt = matchTerminalPromptLine(logicalLine.text);

    if (prompt) {
      const promptEnd = prompt.segments[prompt.segments.length - 1]?.end ?? 0;
      const commandText = logicalLine.text.slice(promptEnd);
      const hasCommand = commandText.trim().length > 0;
      const inputStart = hasCommand
        ? promptEnd + (commandText.length - commandText.trimStart().length)
        : promptEnd;
      if (isVisible) {
        matches.push({ row, segments: prompt.segments });
        const position = resolveTerminalLogicalOffsetPosition(terminal, row, logicalLine.offsets, inputStart);
        inputs.push({
          row,
          endRowExclusive: logicalLine.endRowExclusive,
          startRow: position.row,
          startColumn: position.column,
          hasCommand,
        });
      }
      const nextState = hasCommand
        ? advanceTerminalCommandContinuation(createTerminalCommandContinuationState(prompt.dialect), commandText)
        : undefined;
      continuation = nextState && isTerminalCommandContinuationOpen(nextState) ? nextState : undefined;
    } else if (continuation) {
      const markerLength = matchTerminalContinuationPrompt(continuation.dialect, logicalLine.text);
      if (markerLength === undefined) {
        // 命令已经结束，后续内容是程序输出。
        continuation = undefined;
      } else {
        if (isVisible) {
          const position = resolveTerminalLogicalOffsetPosition(
            terminal,
            row,
            logicalLine.offsets,
            Math.min(markerLength, logicalLine.text.length),
          );
          inputs.push({
            row,
            endRowExclusive: logicalLine.endRowExclusive,
            startRow: position.row,
            // 续行提示符被行尾裁剪时（光标停在 `> ` 后），从提示符之后的列开始。
            startColumn: Math.max(position.column, markerLength),
            hasCommand: true,
          });
        }
        const nextState = advanceTerminalCommandContinuation(
          continuation,
          logicalLine.text.slice(markerLength),
        );
        continuation = isTerminalCommandContinuationOpen(nextState) ? nextState : undefined;
      }
    }
    row = Math.max(row + 1, logicalLine.endRowExclusive);
  }
  return { matches, inputs };
};

// 把输入区拆成“默认前景色”的单元格连续段：Shell 自带的语法色（PSReadLine 命令名、参数等）、
// 反色、暗淡（自动补全幽灵文字）单元格保持原样；行尾空白一并覆盖，新键入的字符无需等待重建即可着色。
export const collectTerminalPromptInputCellRuns = (
  terminal: Terminal,
  input: TerminalPromptInputLine,
  firstRow: number,
  lastRowExclusive: number,
) => {
  const buffer = terminal.buffer.active;
  const runs: TerminalMatchDecorationRange[] = [];
  const firstRunRow = Math.max(input.startRow, firstRow);
  const lastRunRowExclusive = Math.min(input.endRowExclusive, lastRowExclusive);
  const reusableCell = buffer.getNullCell();
  for (let row = firstRunRow; row < lastRunRowExclusive; row += 1) {
    const line = buffer.getLine(row);
    if (!line) {
      continue;
    }
    let runStart = -1;
    let previousIsPlain = false;
    const startColumn = row === input.startRow ? input.startColumn : 0;
    for (let column = startColumn; column < terminal.cols; column += 1) {
      const cell = line.getCell(column, reusableCell);
      // 宽字符的第二个单元格（宽度 0）沿用前一格的判定，避免把一个汉字拆成两段。
      const isPlain: boolean = cell
        ? cell.getWidth() === 0
          ? previousIsPlain
          : cell.isFgDefault() && !cell.isInverse() && !cell.isDim()
        : true;
      if (isPlain && runStart < 0) {
        runStart = column;
      } else if (!isPlain && runStart >= 0) {
        runs.push({ row, column: runStart, width: column - runStart });
        runStart = -1;
      }
      previousIsPlain = isPlain;
    }
    if (runStart >= 0 && terminal.cols > runStart) {
      runs.push({ row, column: runStart, width: terminal.cols - runStart });
    }
  }
  return runs;
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
