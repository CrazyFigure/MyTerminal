//! 终端输入延迟探针：默认关闭，仅用于定位“按键到画面更新”之间的耗时落在哪一段。
//
// 开启方式（开发者工具控制台）：localStorage.setItem('myterminal.debug.inputLatency', '1')，刷新后生效；
// 关闭：localStorage.removeItem('myterminal.debug.inputLatency')。
//
// 每次按键分段记录：
//   写入完成 —— 前端经 Tauri IPC 把按键交给后端 PTY 的耗时（主线程/IPC 拥堵会体现在这里）；
//   首个回显 —— 按键到第一块输出到达前端（包含 TUI 自身处理与 ConPTY 合帧）；
//   解析完成 —— xterm 把这批回显解析进缓冲区；
//   画面更新 —— 解析后的下一帧，即用户真正看到变化的时刻。
// 同时用 longtask 观察前端主线程是否出现 50ms 以上的阻塞。

const probeStorageKey = 'myterminal.debug.inputLatency';
// 回显静默这么久视为一次按键的回显结束，输出一条记录。
const echoSettleMs = 120;
// 每累计这么多条记录输出一次分位统计。
const summaryEvery = 20;

type InputLatencySample = {
  sessionId: string;
  keyAt: number;
  // 本条记录覆盖的按键次数；大于 1 说明上一次按键的回显还没回来就又按了键（会合并成一次跳动）。
  keyCount: number;
  writtenAt?: number;
  firstEchoAt?: number;
  lastEchoAt?: number;
  parsedAt?: number;
  renderedAt?: number;
  echoBytes: number;
};

const readProbeEnabled = () => {
  try {
    return window.localStorage.getItem(probeStorageKey) === '1';
  } catch {
    return false;
  }
};

// 只在模块加载时读取一次，关闭状态下所有埋点都是一次布尔判断。
const probeEnabled = typeof window !== 'undefined' && readProbeEnabled();
const samplesBySession = new Map<string, InputLatencySample>();
const settleTimers = new Map<string, number>();
const echoToRenderHistory: number[] = [];
let longTaskObserverStarted = false;

const formatMs = (value: number | undefined) => (value === undefined ? '—' : `${Math.round(value)}ms`);

const percentile = (values: number[], ratio: number) => {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
};

// 主线程长任务会直接表现为“好几个位置一下子跳过去”，单独打印出来与按键记录对照。
const ensureLongTaskObserver = () => {
  if (longTaskObserverStarted || typeof PerformanceObserver === 'undefined') {
    return;
  }
  longTaskObserverStarted = true;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        console.warn(`[输入延迟] 前端主线程阻塞 ${Math.round(entry.duration)}ms`);
      }
    });
    observer.observe({ type: 'longtask', buffered: false });
  } catch {
    // 运行时不支持 longtask 时只保留分段计时。
  }
};

const flushSample = (sessionId: string) => {
  settleTimers.delete(sessionId);
  const sample = samplesBySession.get(sessionId);
  samplesBySession.delete(sessionId);
  if (!sample || sample.firstEchoAt === undefined) {
    return;
  }
  const relative = (value: number | undefined) => (value === undefined ? undefined : value - sample.keyAt);
  const renderLatency = relative(sample.renderedAt ?? sample.parsedAt);
  console.log(
    `[输入延迟] 按键×${sample.keyCount} | 写入完成 ${formatMs(relative(sample.writtenAt))}`
    + ` | 首个回显 ${formatMs(relative(sample.firstEchoAt))}`
    + ` | 回显结束 ${formatMs(relative(sample.lastEchoAt))}`
    + ` | 解析完成 ${formatMs(relative(sample.parsedAt))}`
    + ` | 画面更新 ${formatMs(renderLatency)}`
    + ` | 回显 ${(sample.echoBytes / 1024).toFixed(1)}KB`,
  );
  if (renderLatency !== undefined) {
    echoToRenderHistory.push(renderLatency);
    if (echoToRenderHistory.length >= summaryEvery) {
      console.log(
        `[输入延迟] 最近 ${echoToRenderHistory.length} 次按键→画面更新：`
        + `P50 ${formatMs(percentile(echoToRenderHistory, 0.5))}`
        + ` / P90 ${formatMs(percentile(echoToRenderHistory, 0.9))}`
        + ` / 最大 ${formatMs(Math.max(...echoToRenderHistory))}`,
      );
      echoToRenderHistory.length = 0;
    }
  }
};

const scheduleSampleFlush = (sessionId: string) => {
  const pending = settleTimers.get(sessionId);
  if (pending !== undefined) {
    window.clearTimeout(pending);
  }
  settleTimers.set(sessionId, window.setTimeout(() => flushSample(sessionId), echoSettleMs));
};

// 用户按键（xterm onData）时调用；上一条记录尚未收到回显时合并计数，用于判断按键是否被成批回显。
export const markTerminalInputKey = (sessionId: string) => {
  if (!probeEnabled) {
    return;
  }
  ensureLongTaskObserver();
  const previous = samplesBySession.get(sessionId);
  if (previous && previous.firstEchoAt === undefined) {
    previous.keyCount += 1;
    return;
  }
  if (previous) {
    flushSample(sessionId);
  }
  samplesBySession.set(sessionId, { sessionId, keyAt: performance.now(), keyCount: 1, echoBytes: 0 });
};

// 后端 PTY 写入的 IPC 调用返回时调用。
export const markTerminalInputWritten = (sessionId: string) => {
  if (!probeEnabled) {
    return;
  }
  const sample = samplesBySession.get(sessionId);
  if (sample && sample.writtenAt === undefined) {
    sample.writtenAt = performance.now();
  }
};

// 一块实时输出到达前端时调用。
export const markTerminalOutputArrived = (sessionId: string, bytes: number) => {
  if (!probeEnabled) {
    return;
  }
  const sample = samplesBySession.get(sessionId);
  if (!sample) {
    return;
  }
  const now = performance.now();
  sample.firstEchoAt ??= now;
  sample.lastEchoAt = now;
  sample.echoBytes += bytes;
  scheduleSampleFlush(sessionId);
};

// xterm 解析完一块输出时调用；下一帧记为画面更新时刻。
export const markTerminalOutputParsed = (sessionId: string) => {
  if (!probeEnabled) {
    return;
  }
  const sample = samplesBySession.get(sessionId);
  if (!sample || sample.firstEchoAt === undefined) {
    return;
  }
  sample.parsedAt = performance.now();
  window.requestAnimationFrame(() => {
    if (samplesBySession.get(sessionId) === sample) {
      sample.renderedAt = performance.now();
    }
  });
};
