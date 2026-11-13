/* 终端窗口标题（OSC 0 / OSC 2）解析规则：纯函数，不依赖 React、Zustand 与 Tauri。 */

// 单条标题序列的最长缓冲长度；超过即视为异常数据直接丢弃，防止未闭合序列无限增长。
const maxPendingTitleLength = 1024;

// 标题序列引导符：OSC 0 同时设置图标名与窗口标题，OSC 2 只设置窗口标题，二者都代表"标签标题"。
const titleIntroducers = ['\x1b]0;', '\x1b]2;'];

export type TerminalTitleScanResult = {
  /** 本分片内最后一条完整标题；undefined 表示本分片没有出现完整的标题序列。 */
  title: string | undefined;
  /** 跨分片未闭合的标题序列尾部，下次扫描时需要拼在新分片前面。 */
  pending: string;
};

// 判断文本尾部是否可能是某个标题引导符的前缀（如单独的 ESC 或 "ESC ]"），这类尾巴要留到下个分片再判定。
const resolveIntroducerPrefixTail = (text: string) => {
  const maxPrefixLength = Math.min(text.length, titleIntroducers[0].length - 1);
  for (let length = maxPrefixLength; length > 0; length -= 1) {
    const tail = text.slice(-length);
    if (titleIntroducers.some((introducer) => introducer.startsWith(tail))) {
      return tail;
    }
  }
  return '';
};

// 在终端输出中提取最后一条完整的窗口标题；序列可能被 PTY 读循环截断在任意位置，因此需要 pending 续接。
export const scanTerminalTitle = (content: string, pending = ''): TerminalTitleScanResult => {
  const text = pending + content;
  let title: string | undefined;
  let cursor = 0;

  while (cursor < text.length) {
    // 找到距离游标最近的标题引导符。
    let start = -1;
    for (const introducer of titleIntroducers) {
      const index = text.indexOf(introducer, cursor);
      if (index !== -1 && (start === -1 || index < start)) {
        start = index;
      }
    }
    if (start === -1) {
      break;
    }

    const bodyStart = start + titleIntroducers[0].length;
    // 标题以 BEL 或 ST（ESC \）结束，取更早出现的那个。
    const belIndex = text.indexOf('\x07', bodyStart);
    const stIndex = text.indexOf('\x1b\\', bodyStart);
    const end = belIndex === -1
      ? stIndex
      : stIndex === -1 ? belIndex : Math.min(belIndex, stIndex);
    if (end === -1) {
      // 序列尚未闭合：保留到下个分片续接，超长则视为脏数据丢弃。
      const unterminated = text.slice(start);
      return {
        title,
        pending: unterminated.length > maxPendingTitleLength ? '' : unterminated,
      };
    }

    title = text.slice(bodyStart, end);
    cursor = end + (end === stIndex ? 2 : 1);
  }

  return { title, pending: resolveIntroducerPrefixTail(text.slice(cursor)) };
};

// 只代表程序名、不代表会话内容的通用标题；Agent 启动后、首次对话前通常显示这些。
const genericAgentTitles = new Set(['claude', 'claude code', 'codex', 'gemini', 'gemini cli']);

// 把原始标题规范成"会话主要内容"；Shell 自身设置的程序路径、user@host 提示符等噪声返回 undefined。
export const normalizeTerminalSessionTopic = (rawTitle: string, ...ignoredTitles: string[]) => {
  const title = rawTitle
    // 去掉控制字符，避免残留不可见字符撑开 Tooltip。
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    // Claude Code 等 Agent 在标题前用旋转字符（盲文点阵、✳ 等）表示忙闲状态，只保留文字部分。
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) {
    return undefined;
  }
  // ConPTY / cmd 默认把可执行文件路径写成标题（含 "cmd.exe - xxx" 形式），不属于会话内容。
  if (/\.exe\b/i.test(title) || /^[a-z]:[\\/]/i.test(title)) {
    return undefined;
  }
  // bash/zsh 常见的 "user@host: ~/path" 提示符标题随 cd 频繁变化，属于噪声。
  if (/^[^\s@]+@[^\s:]+:/.test(title)) {
    return undefined;
  }
  const lowerTitle = title.toLowerCase();
  if (genericAgentTitles.has(lowerTitle)) {
    return undefined;
  }
  // 与标签本身展示内容重复时没有补充价值。
  if (ignoredTitles.some((ignored) => ignored.trim().toLowerCase() === lowerTitle)) {
    return undefined;
  }
  return title;
};
