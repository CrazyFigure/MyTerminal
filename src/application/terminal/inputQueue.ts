/* 本模块从 Store 中按业务边界提取；领域规则不得依赖 Zustand，应用服务只暴露稳定操作。 */
import { backend } from '../../backend';

// 终端输入跨 Tauri IPC 写入：交互按键只合并同一浏览器事件轮次，避免固定延迟造成远端 echo 成批出现。
const terminalInputBuffers = new Map<string, string>();


const terminalInputFlushPromises = new Map<string, Promise<void>>();


// 即时刷新任务只用微任务排队，不用 setTimeout；同一轮 onData 的多段输入会自然合并，下一轮按键会立刻发出。
const terminalInputImmediateFlushSessions = new Set<string>();


const terminalInputFlushTimers = new Map<string, number>();


const terminalInputFlushTimerDelays = new Map<string, number>();


// 终端直接输入不会经过命令面板；按会话记录当前命令行，用于识别回车后的 cd 并兜底刷新文件管理。
const terminalInputLineBuffers = new Map<string, string>();


// 大段粘贴保留极短合并窗口，避免一次粘贴拆成大量 IPC；普通按键和编辑键不走这个延迟。
export const terminalBulkInputFlushDelayMs = 8;


// 普通可打印字符使用单帧级合并，降低 WebView->Rust IPC 频率，同时把体感延迟压在不可感知范围内。
export const terminalInteractiveInputFlushDelayMs = 2;


// xterm 的方向键/Delete 等控制序列通常只有 3-4 字节；超过该阈值基本可视为粘贴或程序批量输入。
const terminalBulkInputThreshold = 64;



// 会话关闭或重连时清理尚未写入的输入，避免旧 PTY 已释放后仍被延迟刷新命中。
export const clearQueuedTerminalInput = (sessionId: string) => {
  const pendingTimer = terminalInputFlushTimers.get(sessionId);
  if (pendingTimer) {
    window.clearTimeout(pendingTimer);
    terminalInputFlushTimers.delete(sessionId);
    terminalInputFlushTimerDelays.delete(sessionId);
  }
  terminalInputImmediateFlushSessions.delete(sessionId);
  terminalInputBuffers.delete(sessionId);
  terminalInputLineBuffers.delete(sessionId);
};



// 输入刷新会串行写入后端，避免同一个会话出现并发写入导致字符顺序抖动。
export const flushQueuedTerminalInput = (sessionId: string) => {
  const pendingTimer = terminalInputFlushTimers.get(sessionId);
  if (pendingTimer) {
    window.clearTimeout(pendingTimer);
    terminalInputFlushTimers.delete(sessionId);
    terminalInputFlushTimerDelays.delete(sessionId);
  }

  const runningFlush = terminalInputFlushPromises.get(sessionId);
  if (runningFlush) {
    return runningFlush;
  }

  const flushPromise = (async () => {
    while (true) {
      const payload = terminalInputBuffers.get(sessionId);
      if (!payload) {
        terminalInputBuffers.delete(sessionId);
        return;
      }

      terminalInputBuffers.set(sessionId, '');
      await backend.writeTerminalInput(sessionId, payload);
    }
  })().finally(() => {
    terminalInputFlushPromises.delete(sessionId);
  });

  terminalInputFlushPromises.set(sessionId, flushPromise);
  return flushPromise;
};



// 交互输入入队后用微任务立即刷新，去掉固定毫秒级等待；这保持远端 echo 语义，不做本地假回显。
const scheduleImmediateTerminalInputFlush = (sessionId: string) => {
  if (terminalInputImmediateFlushSessions.has(sessionId)) {
    return;
  }
  terminalInputImmediateFlushSessions.add(sessionId);
  window.queueMicrotask(() => {
    terminalInputImmediateFlushSessions.delete(sessionId);
    void flushQueuedTerminalInput(sessionId).catch(() => undefined);
  });
};



// 批量输入才使用短定时窗口，多个粘贴分片会并成一次后端写入，降低 SSH channel 抖动。
const scheduleDelayedTerminalInputFlush = (sessionId: string, flushDelayMs: number) => {
  const pendingTimer = terminalInputFlushTimers.get(sessionId);
  if (pendingTimer) {
    const pendingDelayMs = terminalInputFlushTimerDelays.get(sessionId) ?? terminalBulkInputFlushDelayMs;
    if (flushDelayMs >= pendingDelayMs) {
      return;
    }
    window.clearTimeout(pendingTimer);
    terminalInputFlushTimers.delete(sessionId);
    terminalInputFlushTimerDelays.delete(sessionId);
  }

  const timer = window.setTimeout(() => {
    terminalInputFlushTimers.delete(sessionId);
    terminalInputFlushTimerDelays.delete(sessionId);
    void flushQueuedTerminalInput(sessionId).catch(() => undefined);
  }, flushDelayMs);
  terminalInputFlushTimers.set(sessionId, timer);
  terminalInputFlushTimerDelays.set(sessionId, flushDelayMs);
};



// 终端输入默认立即刷新；仅对大段文本启用短窗口合并，避免牺牲单字符输入跟手感。
export const queueTerminalInput = (sessionId: string, data: string, flushDelayMs = 0) => {
  terminalInputBuffers.set(sessionId, `${terminalInputBuffers.get(sessionId) ?? ''}${data}`);

  if (flushDelayMs <= 0) {
    const pendingTimer = terminalInputFlushTimers.get(sessionId);
    if (pendingTimer) {
      window.clearTimeout(pendingTimer);
      terminalInputFlushTimers.delete(sessionId);
      terminalInputFlushTimerDelays.delete(sessionId);
    }
    scheduleImmediateTerminalInputFlush(sessionId);
    return;
  }

  scheduleDelayedTerminalInputFlush(sessionId, flushDelayMs);
};



const isTerminalEditingInput = (data: string) => data.includes('\x7f') || data.includes('\b') || data.includes('\x1b[3~');


// 回车、Tab、控制序列和编辑键必须立即送到远端；粘贴文本里包含换行时也要立刻刷新，避免命令执行和 cwd 同步滞后。
export const shouldFlushTerminalInputImmediately = (data: string) =>
  data.includes('\r') ||
  data.includes('\n') ||
  data === '\t' ||
  data.includes('\x1b') ||
  isTerminalEditingInput(data);


// 大段文本不属于逐键交互，允许 8ms 合并；普通字符走 2ms 合并，控制序列仍立即进入远端 PTY。
export const isBulkTerminalInput = (data: string) => data.length > terminalBulkInputThreshold && !isTerminalEditingInput(data);



// 命令行预测只关心用户输入的可见文本；终端能力响应和控制序列必须先剥离，避免 XTVERSION 等回包污染下一条 cd。
const terminalBracketedPasteBoundaryPattern = /\x1b\[(?:200|201)~/g;


const terminalStringEscapeSequencePattern = /\x1b(?:P|\]|\^|_|X)[\s\S]*?(?:\x07|\x1b\\)/g;


const terminalCsiSequencePattern = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;


const terminalShortEscapeSequencePattern = /\x1b./g;



const normalizeTerminalInputForCommandTracking = (data: string) =>
  data
    .replace(terminalBracketedPasteBoundaryPattern, '')
    .replace(terminalStringEscapeSequencePattern, '')
    .replace(terminalCsiSequencePattern, '')
    .replace(terminalShortEscapeSequencePattern, '');



// Shell 只把奇数个行尾反斜杠中的最后一个视为续行转义；偶数个表示最后一个反斜杠本身已被转义。
const hasUnescapedTrailingBackslash = (value: string) => {
  let count = 0;
  for (let index = value.length - 1; index >= 0 && value[index] === '\\'; index -= 1) {
    count += 1;
  }
  return count % 2 === 1;
};



// xterm 的 Enter 默认是 CR；行尾反斜杠必须与 LF 组成明确的 `\\\n`，避免远端 stty 的 CR 映射差异把它提前提交。
export const normalizeRemoteTerminalContinuationEnter = (sessionId: string, data: string) => (
  (data === '\r' || data === '\n')
  && hasUnescapedTrailingBackslash(terminalInputLineBuffers.get(sessionId) ?? '')
    ? '\n'
    : data
);



// “命令”底栏可能同时包含多条命令与续行：普通换行按终端 Enter 发送 CR，反斜杠后的换行固定发送 LF。
// 最后一行没有换行时按其结尾补 Enter 或续行 LF；若文本已停在换行后，则不再擅自二次提交。
export const normalizeCommandPanelTerminalInput = (rawCommand: string) => {
  const normalized = rawCommand.replace(/\r\n?/g, '\n');
  let payload = '';
  let currentLine = '';
  for (const character of normalized) {
    if (character !== '\n') {
      currentLine += character;
      payload += character;
      continue;
    }
    payload += hasUnescapedTrailingBackslash(currentLine) ? '\n' : '\r';
    currentLine = '';
  }
  if (!normalized.endsWith('\n')) {
    payload += hasUnescapedTrailingBackslash(currentLine) ? '\n' : '\r';
  }
  return payload;
};



export const extractCompletedTerminalInputLines = (sessionId: string, data: string) => {
  let currentLine = terminalInputLineBuffers.get(sessionId) ?? '';
  const completedLines: string[] = [];
  let continuationLineBreaks = 0;

  for (const character of normalizeTerminalInputForCommandTracking(data)) {
    if (character === '\x03' || character === '\x15') {
      // Ctrl+C / Ctrl+U 会放弃当前命令行，前端预测也必须同步清空，避免下一次回车误判旧 cd。
      currentLine = '';
      continue;
    }
    if (character === '\x7f' || character === '\b') {
      currentLine = currentLine.slice(0, -1);
      continue;
    }
    if (character === '\r' || character === '\n') {
      if (hasUnescapedTrailingBackslash(currentLine)) {
        // Shell 解析时会删除反斜杠与紧随其后的换行；前端命令跟踪也按同样规则拼接后续物理行。
        currentLine = currentLine.slice(0, -1);
        continuationLineBreaks += 1;
        continue;
      }
      const completedLine = currentLine.trim();
      if (completedLine) {
        completedLines.push(completedLine);
      }
      currentLine = '';
      continue;
    }
    if (character === '\t' || character >= ' ') {
      currentLine += character;
    }
  }

  if (currentLine) {
    terminalInputLineBuffers.set(sessionId, currentLine);
  } else {
    terminalInputLineBuffers.delete(sessionId);
  }

  return { completedLines, continuationLineBreaks };
};
