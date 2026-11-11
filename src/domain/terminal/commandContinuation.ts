/* 判断 Shell 命令文本是否尚未结束：未结束时 Shell 会在下一行显示续行提示符（bash `> `、pwsh `>> `）。
   纯字符串规则，不依赖 xterm，供终端“输入区着色”区分续行命令与普通输出。 */

export type TerminalShellDialect = 'posix' | 'powershell' | 'cmd';

export type TerminalCommandContinuationState = {
  dialect: TerminalShellDialect;
  // 跨行未闭合的引号。
  quote: '' | "'" | '"';
  // 未闭合的 () 与 {}。
  bracketDepth: number;
  // POSIX 复合命令关键字深度：if/fi、case/esac、do/done。
  keywordDepth: number;
  // 等待结束的 heredoc（POSIX）或 here-string（PowerShell）分隔行。
  pendingDelimiters: string[];
  // 行尾是续行符、管道或逻辑运算符，下一行必然接续。
  trailingJoin: boolean;
};

export const createTerminalCommandContinuationState = (
  dialect: TerminalShellDialect,
): TerminalCommandContinuationState => ({
  dialect,
  quote: '',
  bracketDepth: 0,
  keywordDepth: 0,
  pendingDelimiters: [],
  trailingJoin: false,
});

export const isTerminalCommandContinuationOpen = (state: TerminalCommandContinuationState) =>
  state.dialect !== 'cmd'
  && (
    state.quote !== ''
    || state.bracketDepth > 0
    || state.keywordDepth > 0
    || state.pendingDelimiters.length > 0
    || state.trailingJoin
  );

// 续行提示符：只认 Shell 默认的 PS2，`>>>`（Python REPL）等不会被误判。
export const matchTerminalContinuationPrompt = (dialect: TerminalShellDialect, lineText: string) => {
  if (dialect === 'posix') {
    return /^> (?!>)/.test(lineText) || lineText === '>' ? 2 : undefined;
  }
  if (dialect === 'powershell') {
    return /^>> (?!>)/.test(lineText) || lineText === '>>' ? 3 : undefined;
  }
  return undefined;
};

const posixBlockOpenKeywords = new Set(['if', 'case', 'do']);
const posixBlockCloseKeywords = new Set(['fi', 'esac', 'done']);
// 这些关键字之后紧跟的仍是命令位置，例如 `then echo`、`do rm`。
const posixCommandPositionKeywords = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'time']);

const isWordBreak = (char: string) => /[\s;&|(){}<>]/.test(char);

// 读取 heredoc 分隔符：支持 <<EOF、<<-EOF、<< 'EOF'、<<"EOF"，返回分隔符与结束下标。
const readPosixHeredocDelimiter = (text: string, start: number) => {
  let index = start;
  if (text[index] === '-') {
    index += 1;
  }
  while (text[index] === ' ' || text[index] === '\t') {
    index += 1;
  }
  const quote = text[index] === "'" || text[index] === '"' ? text[index] : '';
  if (quote) {
    const end = text.indexOf(quote, index + 1);
    if (end < 0) {
      return undefined;
    }
    return { delimiter: text.slice(index + 1, end), end: end + 1 };
  }
  let end = index;
  while (end < text.length && !isWordBreak(text[end])) {
    end += 1;
  }
  const delimiter = text.slice(index, end).replace(/\\/g, '');
  return delimiter ? { delimiter, end } : undefined;
};

// 推进一行命令文本后的续行状态；lineText 不含提示符与续行提示符。
export const advanceTerminalCommandContinuation = (
  previous: TerminalCommandContinuationState,
  lineText: string,
): TerminalCommandContinuationState => {
  const state: TerminalCommandContinuationState = {
    ...previous,
    pendingDelimiters: [...previous.pendingDelimiters],
    trailingJoin: false,
  };
  if (state.dialect === 'cmd') {
    return state;
  }

  // heredoc / here-string 正文行只负责等待结束分隔行，内容不参与分词。
  if (state.pendingDelimiters.length > 0) {
    const delimiter = state.pendingDelimiters[0];
    const closes = state.dialect === 'powershell'
      ? lineText.startsWith(delimiter)
      : lineText.replace(/^\t+/, '').trimEnd() === delimiter;
    if (closes) {
      state.pendingDelimiters.shift();
    }
    return state;
  }

  const isPosix = state.dialect === 'posix';
  const escapeChar = isPosix ? '\\' : '`';
  const newDelimiters: string[] = [];
  let commandPosition = state.quote === '';
  let index = 0;
  let lastSignificant = '';

  while (index < lineText.length) {
    const char = lineText[index];

    if (state.quote === "'") {
      // 单引号内没有转义；PowerShell 的 '' 会被视作关闭后立即重新打开，结果一致。
      if (char === "'") {
        state.quote = '';
        lastSignificant = char;
      }
      index += 1;
      continue;
    }

    if (char === escapeChar) {
      // 行尾转义符即续行。
      if (index === lineText.length - 1) {
        state.trailingJoin = true;
        return finalizeLine(state, newDelimiters);
      }
      index += 2;
      lastSignificant = 'x';
      commandPosition = false;
      continue;
    }

    if (state.quote === '"') {
      if (char === '"') {
        state.quote = '';
        lastSignificant = char;
      }
      index += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      state.quote = char;
      commandPosition = false;
      index += 1;
      continue;
    }

    // 行内注释：# 只在词首生效，之后的内容全部忽略。
    if (char === '#' && (index === 0 || /\s/.test(lineText[index - 1]))) {
      break;
    }

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '(' || char === '{') {
      // PowerShell 的 @( / @{ / $( 同样需要闭合。
      state.bracketDepth += 1;
      commandPosition = true;
      lastSignificant = char;
      index += 1;
      continue;
    }

    if (char === ')' || char === '}') {
      // case 分支的 `a)` 没有对应左括号，钳到 0 即可。
      state.bracketDepth = Math.max(0, state.bracketDepth - 1);
      commandPosition = char === '}';
      lastSignificant = char;
      index += 1;
      continue;
    }

    if (char === ';' || char === '&' || char === '|') {
      commandPosition = true;
      if (char !== ';' && lineText[index + 1] === char) {
        lastSignificant = char + char;
        index += 2;
      } else {
        lastSignificant = char;
        index += 1;
      }
      continue;
    }

    // here-string `<<<` 是单行输入，整体跳过，不能被当成 heredoc。
    if (isPosix && lineText.startsWith('<<<', index)) {
      index += 3;
      lastSignificant = 'x';
      commandPosition = false;
      continue;
    }

    if (isPosix && char === '<' && lineText[index + 1] === '<') {
      const heredoc = readPosixHeredocDelimiter(lineText, index + 2);
      if (heredoc) {
        newDelimiters.push(heredoc.delimiter);
        index = heredoc.end;
      } else {
        index += 2;
      }
      lastSignificant = 'x';
      commandPosition = false;
      continue;
    }

    if (!isPosix && char === '@' && (lineText[index + 1] === '"' || lineText[index + 1] === "'")) {
      // here-string 必须以 @" 或 @' 结尾一行才会生效。
      if (lineText.slice(index + 2).trim() === '') {
        newDelimiters.push(`${lineText[index + 1]}@`);
        return finalizeLine(state, newDelimiters);
      }
    }

    // 普通词：POSIX 仅在命令位置识别复合命令关键字，避免 `echo if` 这类参数被计入深度。
    let end = index;
    while (end < lineText.length && !isWordBreak(lineText[end]) && lineText[end] !== "'" && lineText[end] !== '"') {
      end += 1;
    }
    if (end === index) {
      end = index + 1;
    }
    const word = lineText.slice(index, end);
    if (isPosix && commandPosition) {
      if (posixBlockOpenKeywords.has(word)) {
        state.keywordDepth += 1;
      } else if (posixBlockCloseKeywords.has(word)) {
        state.keywordDepth = Math.max(0, state.keywordDepth - 1);
      }
      commandPosition = posixCommandPositionKeywords.has(word);
    } else {
      commandPosition = false;
    }
    lastSignificant = word;
    index = end;
  }

  // 行尾为管道或逻辑运算符时 Shell 会继续等待下一行。
  if (state.quote === '' && (lastSignificant === '|' || lastSignificant === '&&' || lastSignificant === '||')) {
    state.trailingJoin = true;
  }
  return finalizeLine(state, newDelimiters);
};

const finalizeLine = (state: TerminalCommandContinuationState, newDelimiters: string[]) => {
  state.pendingDelimiters.push(...newDelimiters);
  return state;
};
