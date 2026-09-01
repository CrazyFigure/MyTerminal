# 性能监控事件推送重构实施方案

> 本文是实施指令，不是讨论稿。执行者必须按依赖顺序完成一次性重构，不保留旧刷新链路或兼容开关，也不要擅自扩大到趋势图、图表库或终端渲染器重构。需要回退时直接使用 Git 恢复原版。

执行过程中必须遵守仓库 `AGENTS.md`：新增/修改的全局状态、接口、公共方法、内部流程、关键分支、循环、边界、异常、远程调用和锁操作都补充中文前置注释；保留仍然正确的原有注释，不无故整文件重写。

## 后续产品决策（覆盖下文冲突项）

- 概览在面板可见时固定每 1 秒由 Rust worker 采样推送，不再保留“运行状态刷新频率”设置。
- 删除存储最大文件展开列表、对应 Rust 查询命令/DTO/mock/CSS 和“大文件刷新频率”设置；存储总用量仍属于每秒概览。
- “资源”设置页只保留展开明细刷新频率、资源明细来源和 SSH 保活。
- 进程/线程与连接展开明细共用“展开明细刷新频率”。
- Rust 使用 Webview 定向 `emit_to` 时，前端必须使用 `getCurrentWebviewWindow().listen`，不能使用全局 `event.listen`。
- subscriptionId 与单调 generation 必须由前端 effect 预先生成；ID 随 start/pause/refresh/stop 全部命令传递，generation 防止迟到的旧 start 覆盖新 worker。

下文涉及“存储展开扫描”“大文件刷新频率”或“可配置概览间隔”的步骤均不再执行。

## 最终结论

本阶段应直接重构为“Rust 常驻采样 + Tauri 定向事件推送”，但不能只把前端 `setInterval` 搬到 Rust 线程里。必须同时完成以下边界调整：

- 运行概览使用监控专用 SSH 会话，不能再锁住文件管理共用的 `AuxiliarySshSession`。
- Rust 采样器持有 CPU 上一次累计值，用相邻正式采样计算差值；删除远端命令里的 `sleep 0.2`。
- Rust 返回数值 DTO 和采样时间，不再让前端从展示字符串反解百分比。
- 监控状态移入 `features/runtime` 下的独立 React 子树，事件到达时不能更新 App 顶层 Zustand 状态。
- 前端只负责订阅、生命周期控制和展示；概览不再使用固定 `setInterval` 发起 IPC。
- 进度条增加宽度/颜色过渡，并尊重 `prefers-reduced-motion`。
- 进程/线程和连接明细仍按展开态按需请求，不改成常驻推送；它们使用监控明细专用会话，不能阻塞 SFTP。

最终数据流：

```text
RuntimeSidebar（独立 React 子树）
  │ 监听已先注册；前端生成 subscriptionId
  ├─ start / pause / resume / refresh / stop 命令
  ▼
RuntimeOverviewMonitor（每个 Webview 最多一个 worker）
  │ 独占一条阻塞式 ssh2::Session
  │ 单线程、自调度、无并发重入、失败退避
  ▼
单次动态采样命令（/proc/stat 只读一次，无 sleep）
  │ Rust 保存上次 CPU counters 并计算 delta
  ▼
app_handle.emit_to(webviewLabel, "runtime-overview-updated", typed payload)
  │ subscriptionId + connectionId + sequence 过滤迟到事件
  ▼
RuntimeSidebar 局部 setState → RuntimePanel
  │
  └─ App / TerminalSplitGrid / TerminalWorkspace 不因采样而重渲染

展开明细 ──invoke──> RuntimeDetailSession（另一条按需缓存 SSH）
文件/SFTP ──invoke──> AuxiliarySshSession（保持现有文件专用缓存）
```

## 当前仓库事实

实施前先理解这些事实，禁止照搬旧对话中的过期判断：

- `App.tsx` 当前通过 `useShallow` 订阅 Store，并不是每次 Store 任意字段变化都无条件刷新；但 `runtimeOverview` 本身仍由 App 订阅，因此每次概览更新仍会让 App 函数组件重新执行。
- `useRuntimeMonitor.ts` 已经存在，但自定义 Hook 的 state 属于调用它的组件；它当前由 App 调用，所以仅“把逻辑放进 Hook”并没有建立渲染隔离。
- 当前概览在 `App.tsx` 使用最低 5 秒的 `setInterval`，而设置默认值和输入下限是 1 秒，实际行为与设置语义不一致。
- 当前概览刷新已做单请求飞行保护和迟到响应序号校验，这些正确语义要迁移，不能丢掉。
- 概览采集已经合并为一次 `sh -lc` 执行，不是 CPU/内存/磁盘各执行一条命令；问题是命令内部固定等待 `sleep 0.2`，采样窗口短且占住本次 channel。
- `RuntimeOverview` 仍主要是展示字符串，前端通过 `parseMetricPercent` 正则反解 CPU、内存和存储百分比。
- `RuntimeResourceUsage`、`RuntimeStorageFiles` 已经包含 `capturedAt`，但概览没有。
- `AuxiliarySshSession` 同时服务文件、历史和全部运行状态查询；`with_auxiliary_session` 在整个阻塞操作期间持有单个 Mutex。
- `ssh2` 当前锁定版本是 0.9.5。该库的阻塞读会阻塞同一底层 Session 上的其他调用，因此克隆 Session 或多开 channel 不能解决并发阻塞，必须使用独立 Session 或完整的非阻塞复用器。本项目本次选择独立 Session。
- 侧栏折叠时 `RuntimePanel` 会被卸载，这是停止订阅的天然边界；窗口失焦或页面隐藏时组件仍可能存在，需要显式 pause。
- `.metric-progress-fill` 当前没有 transition，宽度和颜色会硬切。

## 本次范围

必须完成：

- 运行概览专用 worker、事件协议、启动/暂停/恢复/手动刷新/停止生命周期。
- 数值化概览 DTO 和无 `sleep 0.2` 的跨采样 CPU delta。
- 监控概览与监控明细的 SSH 会话隔离。
- Runtime React 子树隔离、Store 旧字段清理、旧轮询删除。
- 浏览器预览兼容、错误保留旧数据、快速切换连接防串数据。
- CSS 平滑过渡、Reduced Motion、必要验证。
- `ARCHITECTURE.md` 同步更新模块职责。

本次不要做：

- 不引入 ECharts、Recharts 等图表库。
- 不新增 sparkline 或历史趋势持久化；新 DTO 为后续趋势预留数值和时间即可。
- 不把大文件扫描、进程/线程明细改成事件常驻任务。
- 不重构 xterm、分屏、终端输出队列。
- 不通过给所有组件盲目加 `React.memo` 掩盖状态边界问题。
- 不保留旧 `fetch_runtime_overview` command、旧字符串 DTO、旧 Store action、双写逻辑或 feature flag；Git 是唯一回退手段。
- 不执行 `git commit` 或 `git push`。

## 数据契约

### 数值快照

在 Rust `src-tauri/src/models/runtime.rs` 与前端 `src/types.ts` 定义一一对应的契约。字段命名经 serde 统一为 camelCase。不可用的数值使用 `Option`/`null`，禁止重新引入 `"--"` 作为领域值。

```ts
type RuntimePercentMetric = {
  percent: number | null;
};

type RuntimeMemoryMetric = RuntimePercentMetric & {
  usedKib: number | null;
  totalKib: number | null;
};

type RuntimeStorageMetric = RuntimePercentMetric & {
  mount: string;
  usedKib: number | null;
  totalKib: number | null;
};

type RuntimeConnectionMetric = {
  tcpEstablished: number | null;
  sshEstablished: number | null;
};

type RuntimeOverviewSnapshot = {
  schemaVersion: 1;
  host: string;
  os: string;
  primaryAddress: string | null;
  capturedAt: string;
  cpu: RuntimePercentMetric;
  cpuCores: Array<{ name: string; percent: number }>;
  memory: RuntimeMemoryMetric;
  storage: RuntimeStorageMetric;
  connections: RuntimeConnectionMetric;
  uptimeSeconds: number | null;
};
```

约束：

- 所有百分比在 Rust 端夹到 `0..=100`，前端展示前仍做一次防御性 clamp。
- 第一次采样只有 CPU 累计计数，没有 delta；允许 `cpu.percent = null` 且 `cpuCores = []`。默认 1 秒时，第二个快照再出现 CPU 数值。
- 内存优先 `MemAvailable`，缺失时沿用当前 `MemFree` 兼容逻辑。
- 存储仍只展示 `/` 所在文件系统。
- `capturedAt` 是成功采样完成时间的 RFC 3339 字符串。
- 格式化 GB/MB、百分比、uptime 文本放到前端 `features/runtime/presentation.ts`，Rust 不再输出展示字符串。

### 事件联合类型

Rust 使用 serde tagged enum，前端使用判别联合。事件名固定为 `runtime-overview-updated`。

```ts
type RuntimeOverviewEvent =
  | {
      kind: 'snapshot';
      subscriptionId: string;
      connectionId: string;
      sequence: number;
      snapshot: RuntimeOverviewSnapshot;
    }
  | {
      kind: 'error';
      subscriptionId: string;
      connectionId: string;
      sequence: number;
      attemptedAt: string;
      message: string;
      retryInMs: number;
    };
```

事件处理约束：

- `sequence` 在同一订阅内严格递增，成功和失败事件都占用一个序号。
- 前端必须同时校验 `subscriptionId`、`connectionId` 和 `sequence > lastSequence`。
- error 事件保留上一份成功快照，只更新错误/陈旧状态；首次连接就失败时才显示不可用占位。
- 事件处理函数保持同步，不在 handler 内 await；即使未来事件出现乱序，sequence 也会丢弃旧包。
- 事件只发给发起订阅的 Webview，不用全局 `AppHandle.emit` 广播。

## Rust 目标设计

### 文件职责

- 新增 `src-tauri/src/commands/runtime_monitor.rs`
  - 放置 Tauri 监控命令、worker 循环、退避和定向 emit 编排。
  - 也承接现有三个监控明细 command，使 `commands.rs` 不再堆运行状态用例。
- 修改 `src-tauri/src/commands/remote_access/runtime_metrics.rs`
  - 只负责命令生成、原始结果解析、CPU counter/delta 等纯采集规则。
  - 暴露“使用给定 Session 采一份原始快照”的内部函数，不持有 AppState，不 emit。
- 修改 `src-tauri/src/commands/remote_access.rs`
  - 通过稳定的 `pub(super)` 入口向监控用例暴露采集适配器。
- 修改 `src-tauri/src/commands/ssh_sessions.rs`
  - 保留现有文件辅助会话。
  - 新增监控明细专用缓存的 get/connect/retry/drop/evict 辅助方法；不要复制 SFTP、用户名和组名缓存到这个类型。
- 修改 `src-tauri/src/state.rs`
  - 存放运行期句柄和互斥容器，不放采集业务流程。
- 修改 `src-tauri/src/commands/runtime_daemons.rs`
  - 应用退出时停止所有监控 worker，并清空监控明细 SSH 缓存。
- 修改 `src-tauri/src/commands/connections.rs`
  - 覆盖/删除连接前，停止该连接对应的 monitor，并丢弃该连接的监控明细 Session。
- 修改 `src-tauri/src/main.rs`
  - 注册真实模块路径下的新命令；不要通过 `pub use` 转发带 Tauri 宏的命令。

### AppState 运行期结构

建议结构如下，名字可以微调，语义不能变：

```rust
pub enum RuntimeOverviewMonitorControl {
    Pause,
    Resume,
    Refresh,
    Stop,
}

pub struct RuntimeOverviewMonitorRuntime {
    pub subscription_id: String,
    pub connection_id: String,
    pub control_tx: Sender<RuntimeOverviewMonitorControl>,
}

pub struct RuntimeDetailSshSession {
    pub session: Session,
    pub last_used_at: Instant,
}

pub struct AppState {
    // key 是 Webview label；同一窗口任意时刻最多保留一个概览 worker。
    pub runtime_overview_monitors: Mutex<HashMap<String, RuntimeOverviewMonitorRuntime>>,
    pub runtime_detail_sessions: Mutex<HashMap<String, Arc<Mutex<RuntimeDetailSshSession>>>>,
    pub runtime_detail_session_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    // 其它现有字段保持不变。
}
```

不要保存 `JoinHandle` 后在关闭流程同步 join。SSH 阻塞调用即使设置超时也可能拖慢关闭；关闭时发送 Stop、移出注册表并让线程自行退出即可。worker 每次 emit 前还要检查 `state.is_shutting_down`。

### Tauri 命令

在 `commands/runtime_monitor.rs` 实现并在 `main.rs` 注册：

```text
start_runtime_overview_monitor(connectionId, subscriptionId, intervalSec)
set_runtime_overview_monitor_paused(subscriptionId, paused)
refresh_runtime_overview_monitor(subscriptionId)
stop_runtime_overview_monitor(subscriptionId)

fetch_runtime_resource_usage(connectionId, request)     # 原命令名不变，迁移模块
fetch_runtime_connection_list(connectionId)             # 原命令名不变，迁移模块
```

命令函数直接接收 `tauri::WebviewWindow`，通过 `webview_window.label()` 确认 owner。start 的规则：

1. Rust 再次把 `intervalSec` 夹到 1～60 秒，不能信任前端输入。
2. 校验 connection 和非空 subscriptionId。
3. 以 Webview label 为 key 原子替换旧 runtime；先取出旧值并发送 Stop，再插入新 runtime。
4. worker 使用前端生成的 subscriptionId。前端在 invoke 前就知道 ID，可消除“首事件先于 start 返回”的竞态。
5. start 只负责登记并启动线程，SSH 握手和首采样在 worker 内执行；invoke 要快速返回。
6. stop/pause/refresh 只有在 owner label 与 subscriptionId 都匹配当前 runtime 时才生效。旧 effect 的 cleanup 不能停止后来建立的新订阅。

### Worker 调度

worker 独占自己的阻塞式 `ssh2::Session`，不要包进共享 Mutex，也不要克隆到其他线程。伪流程：

```text
初始化：session=None, previousCpu=None, paused=false, failures=0, sequence=0

loop:
  若 Stop 或 app shutting_down：退出
  若 paused：阻塞等待 Resume/Stop；Resume 后立即采样
  确保专用 SSH 已连接；连接成功后重新读取静态 OS/地址信息
  执行一次动态采样（/proc/stat 只读一次）
  成功：
    使用 previousCpu 计算总 CPU/各核心 delta
    保存本次 counters
    failures=0
    sequence += 1
    使用 AppHandle.emit_to(webviewLabel, ...) 向当前 Webview emit snapshot
    recv_timeout(interval) 等待 Refresh/Pause/Resume/Stop
  失败：
    丢弃 session 和 previousCpu
    failures += 1
    retry = max(interval, 1/2/4/8/15/30 秒退避值)，上限为 max(interval, 30 秒)
    sequence += 1
    emit error（含 retryInMs）
    recv_timeout(retry)；Refresh/Resume 可以提前唤醒一次重试
```

硬性要求：

- 等上一次采样结束后再等待下一间隔，永不并发采样，也不补跑积压的多个 tick。
- Refresh 只合并成“一次尽快采样”，连续点击不创建并发任务。
- worker 每次收到控制消息后用 `try_iter` 排空当前队列并折叠状态：Stop 优先级最高，Pause/Resume 只保留最终态，多个 Refresh 合成一个布尔标记；不能让无界 mpsc 队列按点击次数逐条补采样。
- Pause 时不采样；Resume 后立即采一次，而不是先等待完整 interval。
- 连接或采样发生传输级错误时丢弃专用 Session，下次按退避重新握手。
- 新建专用 Session 后复用现有 `AUXILIARY_IO_TIMEOUT` 设置阻塞调用超时，不能保留 ssh2 默认无限阻塞；Stop/Pause 在一次正在进行的阻塞调用结束后生效，迟到事件仍由前端订阅标识过滤。
- 任何一次重连都清空 CPU baseline，防止跨重启/跨连接计算错误 delta。
- CPU total delta 为 0、计数器倒退、核心消失或新核心出现时，对该项返回不可用，不 panic、不产生负数。
- 不在 worker 内持有 `runtime_overview_monitors`、连接表或存储锁执行 SSH 阻塞调用。
- emit 失败不 panic；目标 Webview 已销毁时退出 worker并清理注册项（清理时仍校验 subscriptionId，不能删掉替代者）。

### 采样命令与解析

将当前命令拆成静态信息和动态信息两类：

- 静态信息在每次新建专用 SSH Session 后采一次：`uname`、主地址。
- 动态信息每轮采样：单次 `/proc/stat`、`/proc/meminfo`、`df -Pk /`、连接计数、`/proc/uptime`。
- 删除 `sleep 0.2` 和第二次 `grep /proc/stat`。
- 继续使用明确的 section marker，不能改成依赖本地化文本的解析。
- 继续兼容 `/proc/net/tcp*`、`ss`、`netstat` 的连接数降级路径。
- shell 不支持某条命令时只让对应字段为 null，不能使整份快照失败；只有 channel/transport/协议执行失败才产生 error 事件。

CPU 解析先得到内部累计模型，不能直接在 parser 内格式化字符串：

```rust
struct CpuCounters {
    idle: u64,
    total: u64,
}

struct RawRuntimeSample {
    aggregate_cpu: Option<CpuCounters>,
    cpu_cores: HashMap<String, CpuCounters>,
    // 其余原始数值……
}
```

### 监控明细 SSH 隔离

现有进程/线程与连接明细查询继续是 invoke，但把：

```text
with_auxiliary_session(...)
```

替换为：

```text
with_runtime_detail_session(...)
```

`RuntimeDetailSshSession` 按 connectionId 缓存并复用，具备与现有辅助会话相同的“传输错误后丢弃并重试一次”和空闲淘汰语义。它不含 SFTP、uid/gid 映射，因此不会阻塞文件列表、上传下载或概览 worker。

保活守护线程可以对空闲的 runtime detail Session 发送 keepalive，但必须用 `try_lock`；拿不到锁就跳过，绝不能等待正在执行的明细查询。

## 前端目标设计

### 文件职责

- 新增 `src/features/runtime/RuntimeSidebar.tsx`
  - 独立容器组件，持有四个展开态、概览/明细 Hook，并组合 `RuntimePanel`。
  - 使用 `memo` 导出，避免 App 其他状态变化重复进入本子树。
- 新增 `src/features/runtime/useRuntimeOverviewSubscription.ts`
  - 只负责事件监听、start/pause/resume/refresh/stop、序号过滤和概览局部状态。
- 修改 `src/features/runtime/useRuntimeMonitor.ts`
  - 删除概览 `refreshRuntimeOverviewOnce` 逻辑，只保留三个按需明细。
  - 两类明细轮询从固定 `setInterval` 改为“本次完成后再 setTimeout”的自调度链，cleanup 清理 timer 和序号。
- 修改 `src/features/runtime/presentation.ts`
  - 增加 typed snapshot 的显示格式化函数；删除最终不再使用的 `parseMetricPercent`。
- 修改 `src/features/runtime/RuntimePanel.tsx`
  - 继续作为纯展示组件；显示最近采样/错误状态，使用数值 percent。
- 修改 `src/features/runtime/index.ts`
  - 只向 App 暴露 `RuntimeSidebar` 和确有跨域用途的稳定类型。
- 修改 `src/backend.ts`
  - 增加监控命令与 webview-specific listen 网关，组件不直接散落 Tauri API。
- 修改 `src/types.ts`
  - 增加新 snapshot/event 契约，并在同一重构中删除旧字符串概览接口。
- 修改 `src/i18n.ts`
  - 为最近采样、已暂停、正在重连和采集失败等新增中英文文案，禁止在组件里硬编码只支持一种语言的状态文本。
- 修改 `src/App.tsx`
  - 只传连接 ID、连接 host、可用状态、高度、设置值和翻译函数给 `RuntimeSidebar`。
  - 删除所有概览 Store 选择、runtimeItems、概览 effect 和 App 内四个展开 state。

### 订阅 Hook 生命周期

严格遵守以下顺序：

1. 组件拿到可用远端 connectionId 后生成 `crypto.randomUUID()`，立即写入 `activeSubscriptionRef`。
2. 先 `await backend.listenRuntimeOverview(...)` 注册当前 Webview 的定向监听。
3. 再 invoke `startRuntimeOverviewMonitor`。
4. effect cleanup 标记 cancelled，调用 unlisten，并 best-effort stop 当前 subscriptionId。
5. 如果 effect 已 cleanup 而异步 listen/start 才返回，立即 unlisten/stop，不得遗留 worker。
6. connectionId 变化时立即清空旧快照、错误和 sequence；不能短暂展示上一台主机。
7. 收到 snapshot 时只有三重校验通过才 setState。
8. 收到 error 时保留旧快照；记录错误信息和 retryInMs。

浏览器预览不是 Tauri，仍必须可用：

- 把 `mockRuntimeOverview` 直接改成 typed snapshot；非 Tauri Hook 用自调度 `setTimeout` 读取/生成 typed mock。
- typed mock 是浏览器预览基础设施，不得复用或保留 Rust 旧 `fetch_runtime_overview` 生产命令。
- Tauri 运行时只启动事件订阅，严禁同时运行 mock timeout。

### 可见性和焦点

- 侧栏折叠会卸载 `RuntimeSidebar`，cleanup 直接 stop worker。
- 页面 `document.visibilityState !== 'visible'` 或 Tauri 主窗口失焦时发送 Pause。
- 页面恢复可见且窗口重新聚焦时发送 Resume；worker 立即补一份快照。
- 焦点监听也通过 `backend.ts` 网关封装，并正确调用异步返回的 unlisten。
- Pause/Resume 只改变当前 subscriptionId；快速切换连接后旧监听不得操作新 worker。
- `runtimeRefreshIntervalSec` 保存后变化时，Hook cleanup 旧订阅并用新 subscriptionId 重启；不要为了这一项再增加第二套前端计时器。

### 手动刷新

- 刷新按钮调用 `refreshRuntimeOverviewMonitor`，不再直接 invoke 一次采集。
- 点击后记录当前 sequence，进入 `manualRefreshing`。
- 收到比点击时 sequence 更新的 snapshot 或 error 后结束 spinner。
- 连续点击只保持一个 pending 状态；后端也只合并为一次 Refresh。
- 使用现有自定义 `Tooltip` 显示刷新、最近采样时间或错误说明，禁止加原生 `title`。

### 渲染隔离

迁移完成后，以下字段不得继续存在于全局 Store：

```text
runtimeOverview
runtimeLoading
refreshRuntimeOverview
runtimeOverviewRefreshSeq
```

从这些文件清理关联读写：

- `src/store.ts`
- `src/application/store/contracts.ts`
- `src/application/store/sessionLifecycleActions.ts`
- `src/application/store/terminalOutputActions.ts`
- `src/application/store/settingsActions.ts`
- `src/application/store/connectionActions.ts`
- `src/App.tsx`

清理时不要破坏文件树自己的 `filesLoading`、路径跟随和历史加载逻辑。`panelFieldsForFocusedSession` 改回只管理文件/路径相关字段；运行监控由 `RuntimeSidebar` 根据 active connection 生命周期自行重置。

验证 React Profiler：默认 1 秒采样时，`RuntimeSidebar/RuntimePanel` 可以更新，但 `App`、`TerminalSplitGrid` 和 `TerminalWorkspace` 不得以同一节奏重复 render。不要用“全仓库加 memo”作为验收替代。

### 展示与动画

`RuntimeSidebar` 根据 typed snapshot 生成 `RuntimeSummaryItem[]`，用 `useMemo` 保持数组引用只在快照或语言变化时更新。格式化规则放在 `presentation.ts`：

- CPU：`xx%`。
- 内存、存储：`已用 / 总量 (xx%)`。
- 连接：`TCP n / SSH n`，不可用部分显示翻译后的不可用文本。
- uptime：由秒数格式化，保持当前 d/h/m 紧凑样式或改为翻译模板，但不能由 Rust 拼英文。

在 `src/styles.css` 为 `.metric-progress-fill` 添加：

```css
transition: width 600ms ease-out, background-color 160ms ease;
```

并在现有 `@media (prefers-reduced-motion: reduce)` 规则附近增加：

```css
.metric-progress-fill {
  transition: none;
}
```

不要用每帧 JavaScript 插值；CSS transition 足以衔接 1 秒快照。也不要给通用 `.metric-progress-fill` 增加永久 `will-change`，多核主机会因此创建过多合成层。

## 实施顺序

下面的阶段只是修改依赖顺序，不是兼容期。最终应作为一套原子重构交付；任何阶段失败都在当前分支修复或用 Git 整体回退，不让新旧生产链路并存。

### 阶段 A：建立新契约和解析内核

1. 在 Rust 增加 raw counters、数值 metric 和 snapshot 类型。
2. 用单次 `/proc/stat` 的采样命令和纯解析函数替换旧双采样命令，删除 `sleep 0.2`。
3. 增加 CPU delta、数值解析、缺失字段和 counter reset 单元测试。
4. `cargo test --manifest-path src-tauri/Cargo.toml` 通过后再进入下一阶段。

### 阶段 B：增加后端 worker 和专用 SSH

1. 在 `state.rs` 增加 monitor runtime 与 detail session 容器。
2. 新增 `commands/runtime_monitor.rs` 和 start/pause/resume/refresh/stop 命令。
3. worker 使用专用 Session、前端提供的 subscriptionId、Webview 定向 emit、自调度与失败退避。
4. 把进程/线程与连接明细 command 移到真实模块路径，并切换到 runtime detail Session。
5. 接入连接更新/删除、空闲回收和应用退出清理。
6. 删除旧 `fetch_runtime_overview` command、旧缓存查询入口和 `main.rs` 旧注册项；注册新命令真实模块路径。
7. 更新 `ARCHITECTURE.md`。
8. 运行 Rust 测试与 `npm run check:rust`。

### 阶段 C：建立独立前端 Runtime 子树

1. 在 `types.ts`、`backend.ts` 增加 typed event、命令和定向 listener。
2. 实现 `useRuntimeOverviewSubscription.ts`，先 listener 后 start，完整处理异步 cleanup。
3. 把四个展开 state 与现有明细 Hook 移入新的 `RuntimeSidebar.tsx`。
4. 改 `RuntimePanel` 使用数值 DTO；增加错误保留、最近采样和手动刷新状态。
5. App 只渲染 `RuntimeSidebar`，删除 App 中概览 `setInterval`、首次 `refreshRuntimeOverviewOnce`、runtimeItems 和概览 Store 选择。
6. 删除 Store 概览 state/action/seq 及所有生命周期清理赋值，但保持文件、路径和历史状态逻辑不变。
7. 删除 `backend.ts` 的旧 `fetchRuntimeOverview` 调用与字符串 DTO；Tauri 只使用推送，非 Tauri 只使用 typed mock timeout。
8. 运行 `npm run typecheck`，再做浏览器预览和 Tauri 手工验证。

### 阶段 D：展示收尾与全量校验

1. 删除不再使用的 `parseMetricPercent`，确认字符串 `RuntimeOverview`、旧 Rust `fetch_runtime_overview` 和前端 `fetchRuntimeOverview` 已完全移除。
2. 补齐最近采样、暂停、重连和错误状态的中英文文案。
3. 给进度条增加 transition 和 Reduced Motion 规则。
4. 全仓搜索确认没有遗留生产轮询：

```powershell
rg -n "refreshRuntimeOverview|runtimeOverviewRefreshSeq|fetch_runtime_overview|parseMetricPercent" src src-tauri/src
rg -n "setInterval" src/features/runtime src/App.tsx
```

允许第二条仅命中与本功能无关的计时器；运行概览和两类监控明细不能再命中 `setInterval`。

## 必须补充的测试

### Rust 单元测试

至少覆盖：

- 正常两组 `/proc/stat` 计数计算总 CPU 百分比。
- 多核按名称配对，不依赖行号。
- total delta 为 0 返回 None。
- 计数器倒退（远端重启/溢出）返回 None 并重建 baseline。
- 新增/消失 CPU 核心不会误配。
- 百分比夹在 0～100。
- MemAvailable 缺失时回退 MemFree。
- `df -Pk` 异常/缺字段只让 storage null。
- SSH 端口无法识别时 `sshEstablished = None`，不能伪造 0。
- uptime 小数输入转为整数秒。
- event 序列化字段是 camelCase，kind 为 snapshot/error。
- registry 中同一 Webview 的新订阅替换旧订阅。
- 旧 subscriptionId 的 stop 不会停止新订阅。

worker 的 SSH 部分不要在单元测试连接真实服务器。把 backoff 计算、registry 替换和 CPU delta 提取成纯函数测试。

### 手工验收

使用至少一台 Linux SSH 主机逐项检查：

- 默认 1 秒设置确实约每秒收到一份快照，不再被硬夹到 5 秒。
- 首份快照可先显示内存/磁盘等，CPU 在下一份出现，界面不闪空。
- 持续终端输出、快速输入、滚动和框选时，监控更新不造成明显卡顿。
- React Profiler 中 App 和所有 TerminalWorkspace 不按采样频率 render。
- 进度条宽度平滑衔接；系统 Reduced Motion 开启后无动画。
- 快速切换 A/B 连接，多次切换后绝不显示错主机数据。
- 折叠左侧栏后停止 worker；展开后新订阅立即采样。
- 窗口失焦/最小化后 pause；恢复焦点后立即补刷。
- 连续点击刷新不会产生并发采样或多个 worker。
- 断网后保留旧快照并显示错误；重连按退避恢复，不每秒重新握手。
- 大文件上传/下载时概览仍更新；概览不会等待 SFTP Mutex。
- 修改或删除连接后旧 worker 停止，不再使用旧凭据持续连接。
- 开发模式 React StrictMode/HMR 后，每个 Webview 最多一个 worker、一个 listener。
- `npm run dev` 浏览器预览仍能展示 mock 数据，且没有同时运行两套刷新。
- 退出应用时没有本任务新增的残留线程或进程；本任务不应启动长期外部进程。

## 失败与回滚策略

- 不保留代码内回退分支、旧 one-shot command 或 feature flag。新事件链路无法达到验收标准时，使用 Git 整体恢复到重构前版本后重新修正方案。
- 某次 error 只更新状态，不清空最后成功快照；只有连接切换、会话不可用或主动 stop 才清空。
- 旧 worker 的迟到事件由 subscriptionId/connectionId/sequence 丢弃，因此无需为了“阻止最后一包”阻塞等待线程退出。
- 任一阶段检查失败，先修复当前阶段再继续；交付版本中不得出现新旧两套生产链路。

## 完成交付条件

以下条件同时满足才算完成：

- 生产 Tauri 路径的概览由 Rust worker 推送，前端没有概览 IPC 轮询。
- 概览 worker、监控明细、文件/SFTP 三类阻塞负载不会共用同一 SSH Session Mutex。
- 远端概览命令没有 `sleep 0.2`，CPU 来自相邻正式样本 delta。
- 概览 DTO 为数值 + capturedAt，前端没有百分比正则反解。
- Runtime 更新只重渲染 Runtime 子树，不驱动 App/终端树按秒更新。
- pause/resume/stop、连接切换、StrictMode、错误退避和应用退出均无泄漏。
- 进度条有平滑过渡并尊重 Reduced Motion。
- Rust 单测、TypeScript 类型检查、前端检查和手工 Tauri 场景通过。
- `ARCHITECTURE.md` 与实际新模块一致。

建议最终验证命令：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
npm run typecheck
npm run check:web
npm run check:rust
git diff --check
git status --short
```

不要自动执行 `git commit` 或 `git push`。交付时列出实际修改文件、验证结果、未覆盖的真实 SSH 环境场景和已知限制。

## 调研依据

- Tauri 2 官方事件文档：事件适合小体量推送；Webview 定向事件要使用对应 Webview listener；监听离开作用域时必须 unlisten；异步事件应考虑顺序问题。<https://v2.tauri.app/develop/calling-frontend/>
- Tauri 2 官方命令文档：command 可直接注入发起调用的 `tauri::WebviewWindow`。<https://v2.tauri.app/develop/calling-rust/#accessing-the-webviewwindow-in-commands>
- `ssh2::Session` 文档：同一底层 Session 内部同步；阻塞 Channel/Stream 读取会阻塞该 Session 上其他调用，需要独立 Session 或非阻塞模式实现真正并发。仓库锁定 0.9.5，本条语义与 0.9 系列文档一致。<https://docs.rs/ssh2/0.9.5/ssh2/struct.Session.html>
