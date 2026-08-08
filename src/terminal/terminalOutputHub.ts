// 终端输出分发中枢。
//
// 拆分背景：分屏后终端区会同时挂载多个 TerminalWorkspace 实例。原实现里每个实例都自己监听
// window 上的全局输出事件、自己持有一份 TerminalOutputCache、自己回包 XTVERSION 查询。
// 一旦渲染多份，同一条输出会被缓存 N 次（内存 ×N），同一条能力协商查询会被回包 N 次写进同一条 PTY，
// 远端 TUI 会收到重复响应。
//
// 因此把「与渲染实例数量无关」的三类状态收敛到本模块级单例：
//   1. TerminalOutputCache —— 全局唯一，按 sessionId 分桶，容量上限也因此仍是全局口径；
//   2. XTVERSION 协议回包状态机 —— 每条查询只回一次，与有几个格子在渲染无关；
//   3. 行号逻辑行时间线 —— 同一会话若同时出现在两个格子里，行号与时间戳必须一致。
//
// 各 TerminalWorkspace 实例只按自己的 sessionId 订阅，拿到属于自己的分片。

import { TerminalOutputCache, type TerminalReplayEntry } from '../terminalCache';
import type { TerminalOutputChunk } from '../types';
import {
  countTerminalXtVersionQueries,
  terminalGutterMaxTrackedLines,
  terminalOutputEventName,
  terminalXtVersionReplyBatchSize,
  terminalXtVersionResponse,
  type TerminalGutterSessionData,
  type TerminalXtVersionQueryParserState,
} from './support';

// 订阅方收到的已入缓存分片；replayEntry 为空表示该分片只携带尺寸元数据、没有正文。
export type TerminalOutputSubscriber = (
  chunk: TerminalOutputChunk,
  replayEntry: TerminalReplayEntry | undefined,
) => void;

// 协议回包必须交回应用层写入 PTY；Hub 只负责判定「该回几次」，不直接触碰后端。
export type TerminalProtocolReplySender = (sessionId: string, data: string) => void;

const outputCache = new TerminalOutputCache();
// 同一 sessionId 可能有多个订阅者（同一会话出现在多个格子里时）；用 Set 保证各自都收到。
const subscribers = new Map<string, Set<TerminalOutputSubscriber>>();
const xtVersionParserStateBySession = new Map<string, TerminalXtVersionQueryParserState>();
const gutterSessionData: Record<string, TerminalGutterSessionData> = {};

let protocolReplySender: TerminalProtocolReplySender | undefined;
let listening = false;

// 应用层在挂载时注入协议回包通道；Hub 不直接依赖 backend，保持可测试。
export const setTerminalProtocolReplySender = (sender: TerminalProtocolReplySender | undefined) => {
  protocolReplySender = sender;
};

// XTVERSION 查询可能横跨分片；按会话维护小状态机，并对本分片内的完整查询按批回包。
const replyXtVersionQueries = (chunk: TerminalOutputChunk) => {
  const queryProgress = countTerminalXtVersionQueries(
    chunk.content,
    xtVersionParserStateBySession.get(chunk.sessionId) ?? 0,
  );
  if (queryProgress.state === 0) {
    xtVersionParserStateBySession.delete(chunk.sessionId);
  } else {
    xtVersionParserStateBySession.set(chunk.sessionId, queryProgress.state);
  }

  let remainingReplies = queryProgress.count;
  while (remainingReplies > 0) {
    // 每批大小固定，异常远端即使连续查询也不会触发一次巨大的 repeat 分配。
    const replyCount = Math.min(remainingReplies, terminalXtVersionReplyBatchSize);
    protocolReplySender?.(chunk.sessionId, terminalXtVersionResponse.repeat(replyCount));
    remainingReplies -= replyCount;
  }
};

const handleTerminalOutput = (event: Event) => {
  const chunk = (event as CustomEvent<TerminalOutputChunk>).detail;
  if (!chunk?.sessionId) {
    return;
  }

  // 尺寸元数据由后端在 PTY 初建/resize 真正生效后按输出时序发出；缓存后续分片必须先绑定该几何。
  if (Number.isInteger(chunk.cols) && Number.isInteger(chunk.rows)) {
    outputCache.recordTerminalSize(chunk.sessionId, chunk.cols as number, chunk.rows as number);
  }
  if (!chunk.content) {
    return;
  }

  // 只扫描后端实时分片并立刻按原会话回包；缓存重放只经过 xterm parser，因此不会重复响应。
  replyXtVersionQueries(chunk);

  // 有订阅者即视为「该会话正在被渲染」，套用活动会话的更宽缓存上限。
  const sessionSubscribers = subscribers.get(chunk.sessionId);
  const replayEntry = outputCache.append(
    chunk.sessionId,
    chunk.content,
    Boolean(sessionSubscribers?.size),
  );

  if (!sessionSubscribers?.size) {
    return;
  }
  // 拷贝一份再遍历：订阅者回调里可能因会话切换而退订，直接遍历会漏掉后续订阅者。
  for (const subscriber of [...sessionSubscribers]) {
    subscriber(chunk, replayEntry);
  }
};

// 首个订阅者到达时才挂监听；全局只挂一次，与渲染实例数量无关。
const ensureListening = () => {
  if (listening || typeof window === 'undefined') {
    return;
  }
  window.addEventListener(terminalOutputEventName, handleTerminalOutput);
  listening = true;
};

// 订阅某会话的实时输出，返回退订函数。
export const subscribeTerminalOutput = (sessionId: string, subscriber: TerminalOutputSubscriber) => {
  ensureListening();
  let sessionSubscribers = subscribers.get(sessionId);
  if (!sessionSubscribers) {
    sessionSubscribers = new Set();
    subscribers.set(sessionId, sessionSubscribers);
  }
  sessionSubscribers.add(subscriber);

  return () => {
    const currentSubscribers = subscribers.get(sessionId);
    if (!currentSubscribers) {
      return;
    }
    currentSubscribers.delete(subscriber);
    if (currentSubscribers.size === 0) {
      subscribers.delete(sessionId);
    }
  };
};

// 按会话取重放序列；语义与原组件内缓存一致。
export const replayTerminalEntries = (sessionId: string) => outputCache.replayEntries(sessionId);

// 会话列表变化时统一回收：输出缓存、行号时间线和协议状态机都按同一份存活集合裁剪。
export const retainTerminalSessions = (liveSessionIds: Iterable<string>) => {
  const live = liveSessionIds instanceof Set ? liveSessionIds : new Set(liveSessionIds);
  outputCache.retain(live);
  for (const sessionId of Object.keys(gutterSessionData)) {
    if (!live.has(sessionId)) {
      delete gutterSessionData[sessionId];
    }
  }
  for (const sessionId of [...xtVersionParserStateBySession.keys()]) {
    if (!live.has(sessionId)) {
      xtVersionParserStateBySession.delete(sessionId);
    }
  }
};

// 行号时间线按会话共享：同一会话在多个格子里渲染时，行号与时间戳必须完全一致。
export const getTerminalGutterSessionData = () => gutterSessionData;

// 取（必要时初始化）某会话的稳定逻辑行时间线。
export const ensureTerminalGutterSessionData = (sessionId: string) => {
  let data = gutterSessionData[sessionId];
  if (!data) {
    data = { times: [], base: 0 };
    gutterSessionData[sessionId] = data;
  }
  return data;
};

// 新逻辑行首次落屏时追加时间；超出上限从最旧端回收并累加 base，保证累计编号不回退。
export const appendTerminalGutterLogicalLine = (sessionId: string, nowMs: number) => {
  const data = ensureTerminalGutterSessionData(sessionId);
  data.times.push(nowMs);
  if (data.times.length > terminalGutterMaxTrackedLines) {
    const drop = data.times.length - terminalGutterMaxTrackedLines;
    data.times.splice(0, drop);
    data.base += drop;
  }
};

// 供诊断使用：确认全局只有一份缓存。
export const terminalOutputHubStats = () => outputCache.stats();
