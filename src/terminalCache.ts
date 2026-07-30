// 终端原始输出的有界分片缓存。
//
// 旧实现用 `Record<string, string>`，每次输出都做 `旧全量 + 新分片` 拼接并按字符截断，
// 持续输出时反复复制大字符串、制造 GC 压力，且关闭会话后缓存一直保留到应用退出。
//
// 本模块改为按会话保存分片队列，只累加分片、不整体拼接；并加每会话与全局字节上限、LRU 淘汰、
// 显式 dropSession 回收。每个分片同时记录它生成时的 PTY 尺寸，重放时按原尺寸解析后再适配当前窗口：
// 这能保证 scp/curl 等依赖 CR 覆盖当前行的动态进度不会因标签切换后的列宽差异膨胀成多行。
//
// ponytail: 字节按 UTF-16 code unit（string.length）近似计量，不做精确 UTF-8 编码，省去每分片
// 一次 TextEncoder 复制。中文场景下该近似偏小约一半，若未来需要严格字节上限再换精确编码。

// 活动会话主要历史仍由 xterm scrollback 提供，这里只服务切换会话/改字号主题时的重放，1 MiB 足够。
const ACTIVE_SESSION_MAX_BYTES = 1024 * 1024;
// 后台会话不占用可视区，给更紧的上限，避免多个后台会话叠加常驻。
const BACKGROUND_SESSION_MAX_BYTES = 512 * 1024;
// 所有会话缓存的全局上限，超过后按 LRU 从最久未访问会话丢弃最旧分片。
const GLOBAL_MAX_BYTES = 8 * 1024 * 1024;
// 发生过淘汰时，重放开头插入一条非侵入提示，避免用户误以为终端完整保留了历史。
const TRUNCATION_NOTICE = '\r\n\x1b[2m[较早的输出因超出缓存上限已被回收]\x1b[0m\r\n';
// 后端创建 SSH 与本地 PTY 时统一使用 120x32；仅在旧后端未上报尺寸元数据的兼容路径下兜底。
const INITIAL_TERMINAL_SIZE: TerminalReplaySize = { cols: 120, rows: 32 };

type SessionCache = {
  // 分片队列，按到达顺序追加；每块携带生成时的 PTY 尺寸，淘汰时从队首移除最旧分片。
  chunks: TerminalReplayEntry[];
  // 该会话已缓存的近似字节数（UTF-16 code unit 之和）。
  bytes: number;
  // 是否曾因超限丢弃过分片；重放时据此决定是否插入截断提示。
  truncated: boolean;
  // 单调递增的最近访问序号，用于全局 LRU 淘汰，避免依赖 Date.now。
  lastAccess: number;
  // 后端确认生效的最新 PTY 尺寸；后续输出必须绑定到这个尺寸，不能使用当前活动标签的渲染宽度猜测。
  terminalSize?: TerminalReplaySize;
};

// 输出生成时真正生效的 PTY 尺寸；列数决定 CR 动态行是否会软换行，行数还会影响滚动区/TUI 解析。
export type TerminalReplaySize = {
  cols: number;
  rows: number;
};

// 缓存重放项保持原始输出不变，只额外携带当时的终端几何信息。
export type TerminalReplayEntry = TerminalReplaySize & {
  content: string;
};

export class TerminalOutputCache {
  private sessions = new Map<string, SessionCache>();
  private globalBytes = 0;
  // 单调时钟：每次访问自增，充当 LRU 排序键，避免 Date.now 抖动与时钟回拨。
  private clock = 0;

  private touch(cache: SessionCache): void {
    this.clock += 1;
    cache.lastAccess = this.clock;
  }

  private ensure(sessionId: string): SessionCache {
    let cache = this.sessions.get(sessionId);
    if (!cache) {
      cache = { chunks: [], bytes: 0, truncated: false, lastAccess: 0 };
      this.sessions.set(sessionId, cache);
    }
    return cache;
  }

  // 后端在 PTY 初建或 resize 真正生效时按输出队列顺序上报尺寸；只更新后续分片的几何基线。
  recordTerminalSize(sessionId: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
      return;
    }
    const cache = this.ensure(sessionId);
    cache.terminalSize = { cols, rows };
    this.touch(cache);
  }

  // 追加一段输出分片。isActive 决定使用活动会话还是后台会话的字节上限。
  // 返回写入的重放项，供调用方在正在重放时把实时输出按同一尺寸延后落屏。
  append(sessionId: string, content: string, isActive: boolean): TerminalReplayEntry | undefined {
    if (!content) {
      return undefined;
    }
    const cache = this.ensure(sessionId);
    // 尺寸元数据应先于对应输出到达；极端兼容场景缺少元数据时使用后端创建 PTY 的统一初始尺寸。
    const terminalSize = cache.terminalSize ?? INITIAL_TERMINAL_SIZE;
    const entry = { content, ...terminalSize };
    cache.chunks.push(entry);
    cache.bytes += content.length;
    this.globalBytes += content.length;
    this.touch(cache);

    // 先按会话上限淘汰本会话最旧分片，再按全局上限跨会话淘汰。
    const perSessionCap = isActive ? ACTIVE_SESSION_MAX_BYTES : BACKGROUND_SESSION_MAX_BYTES;
    this.enforceSessionLimit(cache, perSessionCap);
    this.enforceGlobalLimit();
    return entry;
  }

  // 单会话超上限时，从队首丢弃最旧分片直到回落，并标记已截断。
  private enforceSessionLimit(cache: SessionCache, cap: number): void {
    let dropped = false;
    while (cache.bytes > cap && cache.chunks.length > 0) {
      const oldest = cache.chunks.shift() as TerminalReplayEntry;
      cache.bytes -= oldest.content.length;
      this.globalBytes -= oldest.content.length;
      dropped = true;
    }
    if (dropped) {
      cache.truncated = true;
    }
  }

  // 全局超上限时，反复找到最久未访问且仍有分片的会话，丢弃其最旧分片，直到回落。
  private enforceGlobalLimit(): void {
    while (this.globalBytes > GLOBAL_MAX_BYTES) {
      let victim: SessionCache | undefined;
      for (const cache of this.sessions.values()) {
        if (cache.chunks.length === 0) {
          continue;
        }
        if (!victim || cache.lastAccess < victim.lastAccess) {
          victim = cache;
        }
      }
      if (!victim) {
        break; // 没有可淘汰的分片（理论上不会发生），跳出防止死循环。
      }
      const oldest = victim.chunks.shift() as TerminalReplayEntry;
      victim.bytes -= oldest.content.length;
      this.globalBytes -= oldest.content.length;
      victim.truncated = true;
    }
  }

  // 按分片顺序返回该会话的重放序列（曾截断则在最前面加一条提示）；无内容时返回空数组。
  // 返回浅拷贝，调用方可按相邻尺寸分组写入 xterm，避免把所有原始输出 join 成一个大字符串。
  replayEntries(sessionId: string): TerminalReplayEntry[] {
    const cache = this.sessions.get(sessionId);
    if (!cache || cache.chunks.length === 0) {
      return [];
    }
    this.touch(cache);
    // 截断提示绑定到当前最早保留分片的尺寸，保证提示本身不会改变后续原始流的解析几何。
    const firstSize = { cols: cache.chunks[0].cols, rows: cache.chunks[0].rows };
    const truncationEntry = { content: TRUNCATION_NOTICE, ...firstSize };
    // 拷贝分片引用（浅拷贝，不复制字符串内容），避免调用期间 append 改动队列。
    return cache.truncated ? [truncationEntry, ...cache.chunks] : [...cache.chunks];
  }

  // 显式回收单个会话缓存；关闭、重连、批量关闭标签时必须调用。
  dropSession(sessionId: string): void {
    const cache = this.sessions.get(sessionId);
    if (!cache) {
      return;
    }
    this.globalBytes -= cache.bytes;
    this.sessions.delete(sessionId);
  }

  // 只保留仍存活的会话，删除其余（已关闭的）会话缓存。
  retain(liveSessionIds: Iterable<string>): void {
    const live = liveSessionIds instanceof Set ? liveSessionIds : new Set(liveSessionIds);
    for (const sessionId of [...this.sessions.keys()]) {
      if (!live.has(sessionId)) {
        this.dropSession(sessionId);
      }
    }
  }

  // 供测试/诊断读取当前会话数与全局字节。
  stats(): { sessionCount: number; globalBytes: number } {
    return { sessionCount: this.sessions.size, globalBytes: this.globalBytes };
  }
}
