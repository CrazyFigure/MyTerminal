/* 终端窗口标题（OSC 0 / OSC 2）解析规则：纯函数，不依赖 React、Zustand 与 Tauri。 */

// 单条标题序列的最长缓冲长度；超过即视为异常数据直接丢弃，防止未闭合序列无限增长。
const maxPendingTitleLength = 1024;

// 标题序列引导符：OSC 0 同时设置图标名与窗口标题，OSC 2 只设置窗口标题，二者都代表"标签标题"。
const titleIntroducers = ['\x1b]0;', '\x1b]2;'];

export type TerminalTitleScanResult = {
  /** 本分片内按出现顺序排列的完整标题；空数组表示本分片没有出现完整的标题序列。 */
  titles: string[];
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

// 在终端输出中按顺序提取全部完整的窗口标题；序列可能被 PTY 读循环截断在任意位置，因此需要 pending 续接。
// 必须保留全部标题而非只取最后一条：临时状态标题（如"需要确认"）可能排在主题标题之后，不能把主题吞掉。
export const scanTerminalTitle = (content: string, pending = ''): TerminalTitleScanResult => {
  const text = pending + content;
  const titles: string[] = [];
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
        titles,
        pending: unterminated.length > maxPendingTitleLength ? '' : unterminated,
      };
    }

    titles.push(text.slice(bodyStart, end));
    cursor = end + (end === stIndex ? 2 : 1);
  }

  return { titles, pending: resolveIntroducerPrefixTail(text.slice(cursor)) };
};

// 常见 Agent 的程序名与缩写（长名在前，保证正则优先匹配完整名称）。
// 标题只有这些名字时不含会话信息；作为前缀出现时（如 OpenCode 的 "OC | 主题"）只剥掉前缀。
const agentNames = [
  'claude code', 'claude', 'codex', 'opencode', 'oc', 'gemini cli', 'gemini',
  'qwen code', 'qwen', 'kimi cli', 'kimi', 'cursor agent', 'cursor-agent',
  'github copilot', 'copilot', 'iflow', 'crush', 'aider', 'amp',
];

// Shell 自身的默认标题；出现即说明已回到 Shell，原会话主题失效。
const shellTitles = ['windows powershell', 'powershell', 'pwsh', 'command prompt', '命令提示符', 'cmd', 'bash', 'zsh', 'fish'];

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "程序名 + 分隔符 + 主题" 形式的前缀，如 "OC | 修复登录"、"clidex: xxx"；名称按长度倒序，保证优先匹配完整名称。
const buildProgramPrefixPattern = (programNames: string[]) => new RegExp(
  `^(?:${[...programNames].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})\\s*[|:：\\-–—]\\s*`,
  'i',
);

// 只描述运行状态的临时标题（Codex 的 "[ ! ] Action Required"、Gemini 的 "Ready (目录)" 等），不代表主题变化。
const transientStatusPattern = /action required|^(?:ready|idle|done|working|thinking|waiting|running|busy)\b[\s.…]*(?:\(.*\))?$/i;

// 状态动画字符：盲文点阵旋转符、✳ ✦ ◇ ● 等符号与 emoji，整个词都由它们组成时视为装饰。
const decorationTokenPattern = /^[\p{So}\p{Sk}\p{Co}•·∙…⋯]+$/u;

// 去掉装饰后残留在首尾的分隔符，如 "⠋ | 主题" 剥掉 "⠋" 后剩下的 "| "。
const edgeSeparatorPattern = /^[\s|:：\-–—·•]+|[\s|:：\-–—·•]+$/g;

export type TerminalSessionTopicUpdate =
  /** 标题携带会话主题，更新为该主题。 */
  | { type: 'set'; topic: string }
  /** 程序已退出或刚启动（Shell 默认标题、Agent 程序名），清空旧主题。 */
  | { type: 'clear' }
  /** 只是状态动画或临时状态，保留上一个主题。 */
  | { type: 'keep' };

// 取启动命令首个词的程序名（去掉路径与 .exe），用于识别"标题只是程序名"的情况，覆盖用户自定义的 Agent。
const resolveProgramName = (command: string) => {
  const firstToken = command.trim().match(/^"([^"]+)"|^(\S+)/);
  const program = firstToken?.[1] ?? firstToken?.[2] ?? '';
  return program.split(/[\\/]/).pop()?.replace(/\.exe$/i, '') ?? '';
};

// 把原始窗口标题规范成"会话主要内容"；不绑定具体 Agent，任何会设置 OSC 0/2 标题的程序都适用。
export const normalizeTerminalSessionTopic = (
  rawTitle: string,
  sessionTitle: string,
  localCommand: string,
): TerminalSessionTopicUpdate => {
  // 程序主动把标题设为空（如 OpenCode 退出时），视为会话结束。
  if (!rawTitle.trim()) {
    return { type: 'clear' };
  }
  // 内置 Agent 名单之外再加上本标签启动命令的程序名，自定义 Agent 无需登记也能被识别。
  const programName = resolveProgramName(localCommand);
  const programNames = [...agentNames, programName].filter(Boolean);
  const title = rawTitle
    // 去掉控制字符，避免残留不可见字符撑开 Tooltip。
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .split(/\s+/)
    // 各 Agent 用旋转字符表示忙闲状态（Claude 放在开头、Codex 可放在中间），按词剔除，只保留文字部分。
    .filter((token) => token && !decorationTokenPattern.test(token))
    .join(' ')
    .replace(edgeSeparatorPattern, '')
    .replace(buildProgramPrefixPattern(programNames), '')
    .replace(edgeSeparatorPattern, '');
  // 纯动画帧或临时状态：主题没有变化，不能清空，否则标签提示会随动画闪烁。
  if (!title || transientStatusPattern.test(title)) {
    return { type: 'keep' };
  }
  // ConPTY / cmd 默认把可执行文件路径写成标题（含 "管理员: xxx.exe" 形式），说明已回到 Shell。
  if (/\.exe\b/i.test(title) || /^[a-z]:[\\/]/i.test(title)) {
    return { type: 'clear' };
  }
  // bash/zsh 常见的 "user@host: ~/path" 提示符标题同样代表回到 Shell。
  if (/^[^\s@]+@[^\s:]+:/.test(title)) {
    return { type: 'clear' };
  }
  const lowerTitle = title.toLowerCase();
  const ignoredTitles = [
    ...programNames,
    ...shellTitles,
    sessionTitle,
    localCommand,
  ].map((item) => item.trim().toLowerCase()).filter(Boolean);
  // 只有程序名、或与标签名重复时没有补充价值；Agent 刚启动、尚未开始对话时通常就是这种标题。
  if (ignoredTitles.includes(lowerTitle)) {
    return { type: 'clear' };
  }
  return { type: 'set', topic: title };
};
