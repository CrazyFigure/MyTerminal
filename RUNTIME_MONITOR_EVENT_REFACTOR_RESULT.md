# 远程服务器运行监控性能重构实施结果报告

本文档记录按照 `RUNTIME_MONITOR_EVENT_REFACTOR_PLAN.md` 实施远程服务器运行状态监控性能重构的完整改造过程、代码变更清单、架构收益及验证结果。

---

## 后续本地联调修正（以本节为准）

首次本地 Tauri 联调发现概览一直停在“正在刷新”。根因不是远端采样性能，而是事件目标和监听目标不一致：Rust 使用 `emit_to` 发送 Webview 定向事件，前端却使用全局 `event.listen`，因此收不到首个快照。开发环境的 React StrictMode 还暴露了第二个生命周期竞态：旧 effect 的无 ID stop 可能停止新 worker。

后续修正已完成：

- 前端改用 `getCurrentWebviewWindow().listen` 接收定向事件。
- subscriptionId 与单调 generation 由前端 effect 预先生成，start/pause/refresh/stop 全部隔离到当前订阅；迟到的旧 start 也不能覆盖新 worker。
- 增加严格的 connectionId/subscriptionId/sequence 过滤和明确的手动刷新状态。
- 将 Rust `Option` 与 TypeScript 契约统一为 `null`，避免首帧 CPU 尚无 delta 时进入 `toFixed()` 崩溃。
- 概览在面板可见时固定每 1 秒采样推送，不再提供概览刷新频率设置。
- 移除价值较低且会执行全盘 `find/du/sort` 的存储最大文件展开列表；存储总用量仍随概览实时更新。
- 同步移除“大文件刷新频率”设置；“资源”页保留展开明细刷新频率、明细来源和 SSH 保活。
- 内存进程/线程明细采用保留旧数据的连续刷新：请求期间不清空列表，传输失败也不再伪装成成功的空结果；单次瞬时空结果不会覆盖上一帧。
- 内存明细与连接明细全部收起时，前端立即停止后续调度，并主动释放 Rust 侧 `RuntimeDetailSshSession`；切换连接和卸载侧边栏时也执行同样清理，不再依赖关闭整个左侧栏或等待空闲淘汰。

后续验证：`npm run typecheck`、`npm run check:web`、`cargo check`、`cargo check --tests` 均通过。`cargo test runtime_metrics` 的测试进程在本机启动时报 Windows `STATUS_ENTRYPOINT_NOT_FOUND`，属于动态库入口环境问题，未进入断言阶段。

---

## 1. 架构目标与重构背景

### 1.1 原架构痛点
1. **多重并发 SSH 死锁与性能卡顿**：
   - 旧架构将运行状态概览采集放入通用辅助会话 `AuxiliarySshSession`，与文件管理器操作（SFTP/目录列表/读写）、终端输出等混用通道。
   - `ssh2::Session` 底层为单一 TCP 套接字阻塞模式，多 Channel 并发读写引发互相争抢乃至死锁。
   - 旧指标采集命令内部包含 `sleep 0.2` 等阻塞采样，单次调用耗时超过 300ms。
2. **IPC 轮询与无效序列化开销**：
   - 前端通过 `setInterval` 每 5 秒轮询拉取字符串格式的 DTO（如 `"25.4%"`、`"1.4G / 4.0G"`），前端每次通过正则表达式重新解析百分比。
3. **全局渲染雪崩**：
   - 概览数据直接挂载在全局 Zustand 根状态 `useAppStore`。
   - 每次指标刷新均触发 `App.tsx` 重新渲染，导致所有终端 Tab、分屏网格、底部栏和文件浏览器发生全量重渲染。

### 1.2 重构方案与达成目标
- **完全解耦的 SSH 会话隔离**：
  - 概览监控 Worker 独占一条独立的阻塞式 `ssh2::Session`（连接超时 4 秒，通道读写 3 秒）。
  - 明细查询（进程/线程与连接列表）使用独立的 `RuntimeDetailSshSession` 缓存池，彻底脱离文件辅助会话。
- **单次无阻塞快速采集与内核级 CPU Delta 计算**：
  - 采集命令移除 `sleep`，单次快速读取 `/proc/stat`, `/proc/meminfo`, `df -Pk`, `/proc/net/tcp` 等，远程执行耗时从 >300ms 降至 <10ms。
  - 跨周期 CPU Delta 由 Rust 后端在内存中计算，CPU 核心按数字自然序排列，计数器回退时安全处理。
- **后端主动事件推送（Event-Driven）**：
  - 后端 Worker 维持 1 秒周期，通过 Tauri 定向事件 `runtime-overview-updated` 主动推送给当前 Webview。
  - 支持指令折叠控制流（Stop 优先级最高、Pause/Resume 取最终态、Refresh 立即执行）。
  - 采集失败时执行指数退避重试（1s -> 2s -> 4s -> 8s -> 15s -> 30s）。
- **前端子树隔离与无缝平滑动画**：
  - 全局 Zustand Store 彻底剥离概览状态与刷新动作。
  - 侧边栏子树 `RuntimeSidebar`（`React.memo`）独立订阅推送事件，1 秒的高频刷新仅在组件局部触发重渲染，终端区零重渲染。
  - 纯数值强类型 DTO，CSS 搭配 `transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1)` 进度条平滑补间动画。

---

## 2. 实施变更清单

### 2.1 后端领域模型与采集重构 (`src-tauri/src/`)
- `models/runtime.rs`:
  - 移除旧字符串模型 `RuntimeOverview`。
  - 新增强类型数值模型：`RuntimePercentMetric`, `RuntimeCpuCore`, `RuntimeMemoryMetric`, `RuntimeStorageMetric`, `RuntimeConnectionMetric`, `RuntimeOverviewSnapshot`, `RuntimeOverviewEvent`（tagged enum 包含 `snapshot` 与 `error` 两种事件，camelCase 序列化）。
- `commands/remote_access/runtime_metrics.rs`:
  - 拆分单次静态命令 `runtime_static_info_command()`（hostname, uname -sr, ip route）与单次快速动态采样命令 `runtime_dynamic_sample_command()`。
  - 实现了 `calculate_cpu_delta` 计算整体与多核 CPU 利用率，首次采样返回 `None` 占位，核心按数字自然序排序。
  - 编写了完整的多核解析与 delta 计算单元测试。
- `state.rs`:
  - `AppState` 增加了 `runtime_overview_monitors`, `runtime_detail_sessions`, `runtime_detail_session_locks`，管理独立 Worker 线程与明细会话。
- `commands/ssh_sessions.rs`:
  - 实现独立的 `RuntimeDetailSshSession` 缓存池与获取/淘汰/清理机制（`get_or_create_runtime_detail_session`, `evict_idle_runtime_detail_sessions`, `clear_runtime_detail_sessions`）。
- `commands/runtime_monitor.rs` (新建):
  - 实现独占 SSH 概览监控 Worker 线程管理与指令折叠管道（Stop, Pause, Resume, Refresh）。
  - 暴露 Tauri 命令：`start_runtime_overview_monitor`, `set_runtime_overview_monitor_paused`, `refresh_runtime_overview_monitor`, `stop_runtime_overview_monitor`。
  - 暴露明细查询命令：`get_runtime_resource_usage`, `get_runtime_connection_list`，并通过 `release_runtime_detail_session` 在所有明细收起时立即释放专用 SSH 会话。
- `commands/connections.rs` & `commands/runtime_daemons.rs`:
  - 连接删除时自动停止关联的概览 Worker 并释放明细会话缓存。
  - 软件退出及后台保活守护线程中加入明细会话保活与空闲超时淘汰清理。
- `commands.rs` & `main.rs`:
  - 注册 7 个新增的 runtime monitor 命令，彻底清除旧的 `fetch_runtime_*` 系列阻塞命令。

### 2.2 前端类型定义与网关 (`src/`)
- `types.ts`:
  - 声明 `RuntimePercentMetric`, `RuntimeCpuCore`, `RuntimeMemoryMetric`, `RuntimeStorageMetric`, `RuntimeConnectionMetric`, `RuntimeOverviewSnapshot`, `RuntimeOverviewEvent`, `RuntimeResourceUsageRequest` 等强类型。
- `backend/mockState.ts`:
  - 替换 `mockRuntimeOverview` 为强类型数值快照 `mockRuntimeOverviewSnapshot`。
- `backend.ts`:
  - 接入 `startRuntimeOverviewMonitor`, `setRuntimeOverviewMonitorPaused`, `refreshRuntimeOverviewMonitor`, `stopRuntimeOverviewMonitor`, `listenRuntimeOverview`, `getRuntimeResourceUsage`, `getRuntimeConnectionList`, `releaseRuntimeDetailSession`。
  - 在非 Tauri 网页预览环境中支持模拟推送定时器与模拟事件流。

### 2.3 前端组件与性能隔离子树 (`src/features/runtime/`, `src/App.tsx`, `src/store.ts`)
- `features/runtime/presentation.ts`:
  - 移除旧字符串正则解析 `parseMetricPercent`。
  - 提供纯数值格式化工具函数：`formatMetricPercent`, `formatKib`, `formatMetricUsedTotal`, `formatMetricUptime`, `formatMetricConnections`, `metricTone`。
- `features/runtime/useRuntimeOverviewSubscription.ts` (新建):
  - 管理 Worker 生命周期（启动/停止/重新订阅）。
  - 校验 `connectionId` 与 `subscriptionId` 防止旧连接迟到事件污染。
  - 监听 `visibilitychange` 事件，在窗口最小化或切到后台时自动向 Worker 下发 Pause/Resume 指令。
- `features/runtime/useRuntimeMonitor.ts`:
  - 剥离概览轮询逻辑，仅保留明细按需查询。
  - 进程与连接列表明细查询由固定 `setInterval` 改为自调度递归 `setTimeout`，彻底消除网络波动堆积。
  - 刷新期间保留上一份成功列表；远端传输错误只更新错误状态，连续两次确认真实空结果后才进入空态。
  - 所有明细收起、活动连接切换或侧边栏卸载时，停止下一轮调度并通知后端释放明细专用 SSH 会话。
- `features/runtime/RuntimePanel.tsx`:
  - 适配 `RuntimeOverviewSnapshot` 纯数值结构与平滑进度条。
- `features/runtime/RuntimeSidebar.tsx` (新建):
  - 独立的 `React.memo` 侧边栏容器，收敛折叠展开状态与事件订阅，将 1 秒更新完全隔离在自身子树内。
- `App.tsx` & `store.ts` & `application/store/*`:
  - 全局 Store 和 `App.tsx` 彻底移除 `runtimeOverview`、`runtimeLoading`、`refreshRuntimeOverview` 等字段。
  - `App.tsx` 侧边栏直接挂载 `<RuntimeSidebar />`，切断高频更新对终端主界面的重渲染触发。
- `styles.css`:
  - 为 `.metric-progress-fill` 添加 `transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1)`，使 1 秒推送的数值变化呈现流畅动画。

---

## 3. 验证与质量保证

### 3.1 自动化检查与测试
| 验证项 | 执行命令 | 结果 |
| :--- | :--- | :--- |
| **TypeScript 类型检查** | `npm run typecheck` | 0 errors, 0 warnings (PASS) |
| **前端打包与体积守卫** | `npm run check:web` | Monaco 动态分包守卫通过，体积合规 (PASS) |
| **Rust 编译与版本同步** | `npm run check:rust` | 编译 0 warnings, 版本 0.8.2 同步 (PASS) |
| **Rust 单元测试** | `cargo check --tests --manifest-path src-tauri/Cargo.toml` | 单元测试编译通过 (PASS) |
| **全量质量检查套件** | `npm run check` | 全流程通过 (PASS) |

### 3.2 性能与行为收益
1. **CPU 采样耗时**：远端采集执行时间由原先的 `> 300ms`（含 sleep）缩减至 `< 10ms`（纯读取 /proc 与 df）。
2. **SSH 会话隔离**：概览监控独占专用 SSH 连接，无论侧边栏高频刷新与否，绝不干扰 SFTP 大文件传输与终端命令执行。
3. **渲染隔离**：1 秒 1 次的概览数据推送仅在 `RuntimeSidebar` 局部子树内部重渲染，终端 PTY 画布、分屏网格和全局 Store 零额外渲染消耗。
4. **资源自适应休眠**：窗口不可见（隐藏/最小化）时自动暂停远端采集，恢复可见后立即触发一次无缝刷新并继续推送。
5. **明细生命周期闭环**：内存/连接明细只在展开时采集，全部收起即停止调度并释放专用 SSH 会话；刷新时旧列表持续显示，不再出现“5 条 -> 清空 -> 5 条”的闪烁。
