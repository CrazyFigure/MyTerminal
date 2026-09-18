# MyTerminal 架构约定

本项目采用“功能域优先、分层依赖、渐进式重构”的结构。目标不是完整照搬服务端 DDD，而是让终端、连接、文件、隧道、运行状态和 Agent 等业务规则拥有清晰归属，同时保持 Tauri 桌面应用所需的直接性。

## 技术选型前提

本项目对标 FinalShell 一类的“一体化”远程管理工具，但在实现路径上刻意规避其基于 JVM 的先天代价：内存占用偏高、海量文本输出时渲染卡顿、闭源且强制绑定云端账号。以下取舍是后续架构决策的前提，没有新的实测数据不必重复讨论：

- 采用 Tauri 混合架构而非纯 Rust 原生 GUI。终端渲染内核、SFTP 树形交互与监控图表的成熟生态都在前端；用 Slint / egui / iced 从零实现同等完备度的文本渲染与控件，工作量与风险都不可接受。
- 终端渲染固定使用 `xterm.js`，利用其 WebGL 加速与完整的转义序列覆盖，不在 Rust 侧重写渲染引擎；本地终端通过 `portable-pty` 走系统真实 PTY（Windows 下即 ConPTY），远端文件编辑固定使用 `Monaco Editor`。这三者都是前端与系统层的成熟实现，不替换、不自研。
- 本地优先：配置与凭证在本地加密落盘，不强制绑定云端账号；同步是可选的 WebDAV 或自建服务。
- 不做依赖服务端的专有网络加速等特性。

## 前端分层

```text
src/
├─ App.tsx                 # 页面组合根，只编排功能区与跨域交互
├─ components/             # 仍在迁移中的较大独立视图：连接、设置、编辑器、本地终端等弹窗
├─ features/               # 按用户功能组织的展示规则和子视图
│  ├─ agent/               # AI 对话侧栏、审批请求面板与请求摘要规则
│  ├─ files/               # SFTP 浏览器、右键菜单与文件展示规则
│  ├─ runtime/             # 运行状态侧栏、概览订阅与明细轮询
│  ├─ sessions/            # 会话标签栏与标签右键菜单
│  ├─ settings/            # 设置导航与各分页受控视图
│  ├─ terminal/            # 分屏布局纯算法、拖拽落点、分隔条与每格标签栏
│  └─ workspace/           # 标题栏、底部功能栏、动作区与传输进度
├─ application/            # 有状态用例服务，例如 Store action factory、终端输入缓冲与串行写入
│  ├─ store/               # Store 总契约及连接、会话、文件、设置、收藏、隧道用例切片
│  └─ terminal/            # PTY 输入背压与分片发送策略
├─ domain/                 # 无 Zustand、React、Tauri 依赖的业务规则
│  ├─ connections/         # 连接分组路径与草稿规范化
│  ├─ network/             # 端口范围钳制
│  ├─ sessions/            # 会话可用性判定（远端 / 本地 / 命令面板输入门槛）
│  ├─ settings/            # 设置与本地终端默认值
│  ├─ terminal/            # 远端路径推导与命令文本导航
│  └─ tunnels/             # 隧道草稿与字段校验
├─ infrastructure/         # 文件编码、平台接口等技术实现
├─ shared/                 # 无业务含义的基础工具
│  └─ ui/                  # 通用展示组件（浮动提示）
├─ app/                    # 兼容中的应用级公共工具，逐步向上述层次归位
├─ terminal/               # xterm 行号、高亮、布局、滚动条等交互控制器
│  ├─ terminalOutputHub.ts # 与渲染实例数量无关的终端全局单例状态
│  └─ support/             # 契约、选区、提示符高亮、展示策略与主题纯算法
├─ backend/                # 网关输入规范化与非 Tauri 预览数据
└─ store.ts                # Zustand 初始状态与 action factory 装配根
```

模块根目录另有 `terminalCache.ts`（输出缓存分桶与容量回收）与 `terminalFonts.ts`（终端字体装配）等应用级单文件模块。

依赖方向约束：

```text
UI / Store → Features / Application → Domain / Shared
                                  ↘ Infrastructure gateway
```

- `domain` 不得导入 React、Zustand、Tauri 或 `backend`。
- `features` 通过各目录的 `index.ts` 向上层提供稳定入口；上层不应依赖功能域内部文件。
- `application` 可以持有队列、计时器和并发状态，但只暴露用例级操作；会话切片再按生命周期、输入背压和输出归并组合。
- `store.ts` 只负责初始状态和 action factory 装配；连接、会话、文件、设置、收藏和隧道副作用分别归属 `application/store`。
- `features/terminal` 的分屏判定（`splitLayout.ts`、`splitRatios.ts`）是纯函数，不依赖 DOM、React 与 Store，可独立推理与测试；`TerminalSplitGrid.tsx` 只负责把布局渲染成 2×2 网格。
- 分屏后终端区会同时挂载多个渲染实例，凡“与会话数量无关”的终端状态（输出缓存、`XTVERSION` 回包、逻辑行时间线）必须收敛到 `terminal/terminalOutputHub.ts` 单例，不能让各实例各持一份，否则同一条输出会被重复缓存、同一次能力协商会被重复回包。
- `terminal` 控制器按共享坐标系和交互状态机划分，不把帧调度、DOM 测量重新塞回 `TerminalWorkspace.tsx`。
- 自绘拖拽交互（终端选区覆盖层、竖向滚动条、分屏分隔条）不能把 `mouseup` 当作唯一收敛信号：Tauri Webview 在应用窗口之外松手时收不到该事件，只依赖它的拖拽状态会永久残留。指针移动事件里必须用 `event.buttons & 1` 复核左键是否仍按着，并优先把校验挂到 `window` 的**捕获阶段**；用于复核的“是否仍按着”状态要与“是否观察到 mouseup”解耦，否则会被 window 捕获阶段的 handler 提前清掉而把复核短路。
- `backend.ts` 是前端访问 Tauri 的统一网关，组件不直接散落 `invoke` 调用；输入规范化和浏览器预览数据分别归属 `backend/normalizers.ts` 与 `backend/mockState.ts`。
- `app/` 与 `components/` 是过渡层：新增业务规则不得继续落在其中，应直接进入对应的 `domain` / `application` / `features` 目录。

## Rust 后端分层

```text
src-tauri/src/
├─ commands.rs                 # Tauri 命令与跨模块用例装配
├─ commands/
│  ├─ agent.rs                 # Agent Bridge 与内置对话命令适配器
│  ├─ connections.rs           # 连接校验、RDP 与连接 CRUD
│  ├─ local_terminal.rs        # 本地 PTY 启动、默认终端解析和读写循环
│  ├─ shell_detector.rs        # 系统已安装终端探测（注册表 / PATH / WSL）
│  ├─ remote_files.rs          # 远端文件与编辑器应用服务
│  ├─ ssh_sessions.rs          # SSH Shell 与辅助会话生命周期
│  ├─ ssh_transport.rs         # 认证、代理、跳板机与隧道传输
│  ├─ updates.rs               # 更新、远程资源和系统外链
│  ├─ font_pack.rs             # 应用内字体包下载、哈希校验与原子安装
│  ├─ shell_output.rs          # Shell 输出同步协议领域状态机
│  ├─ remote_access.rs         # SFTP、历史和运行指标基础设施适配器
│  ├─ config_sync.rs           # 本地配置与 WebDAV 同步用例
│  ├─ runtime_monitor.rs       # 运行概览独占 Worker、控制流与进程/连接明细查询
│  ├─ runtime_daemons.rs       # 后台关闭、保活与隧道健康监控
│  ├─ shell_runtime.rs         # 输出队列、Agent 可见进度与 cwd 协议辅助
│  ├─ ssh_transport/tunnels.rs # 隧道 SSH 连接池与监听器
│  └─ remote_access/runtime_metrics/resource_usage.rs
│                               # 系统、容器与 Kubernetes 资源明细
├─ models.rs                   # 领域模型兼容门面
├─ models/
│  ├─ settings.rs             # 设置、WebDAV 与 AI 配置
│  ├─ connections.rs          # 连接、会话、本地终端与历史
│  ├─ favorites.rs            # 收藏命令实体
│  ├─ runtime.rs              # 文件与运行状态采集模型
│  └─ contracts.rs            # 启动、隧道、字体包、系统字体、更新与持久化交换契约
├─ agent_bridge.rs             # Broker、Agent 会话与命令执行编排
├─ agent_bridge/
│  ├─ files.rs                 # Agent 文件读写和递归传输子域
│  ├─ requests.rs              # 审批请求生命周期状态机
│  └─ http.rs                  # 本地 HTTP Broker 协议适配器
├─ agent_chat.rs               # 内置对话内核：消息模型、三协议适配与工具调用循环
├─ agent_tools.rs              # 内置 Agent 工具集与系统提示词
├─ bin/myterminal-cli.rs       # MCP stdio 桥接 CLI（Broker 客户端与进程入口）
├─ crypto.rs                   # 敏感字段加解密
├─ storage.rs                  # 本地 JSON 持久化、原子写入与备份
├─ webdav.rs                   # WebDAV 客户端适配
├─ state.rs                    # 应用共享状态、会话表与 PTY 控制通道
└─ error.rs / main.rs / lib.rs # 错误契约、进程入口与模块导出
```

- `commands.rs` 只保留参数接收、状态查找、事务顺序和事件编排。
- `shell_output` 采用状态机模式：输入任意分片的 PTY 字节流，输出可见文本、cwd 更新和命令边界事件。
- `shell_detector` 只做只读探测：按注册表 / `where.exe` / WSL 发行版枚举结果拼装候选终端，不写入任何配置；探测在用户手动触发时执行，不在启动路径上跑。
- `remote_access` 采用适配器模式：隐藏辅助 SSH 会话、SFTP 递归、Linux 指标命令与解析细节。
- `config_sync` 作为独立用例模块，恢复配置时仍复用统一的“停止运行时 → 备份 → 保存 → 重载”流程。
- `agent_chat` 与 `agent_tools` 共同构成内置对话：三种协议（Anthropic Messages / OpenAI Chat Completions / OpenAI Responses）在内部收敛为同一套消息与工具模型，只有请求构造与 SSE 解析按协议分派，工具循环完全共用；工具实现全部复用 `agent_bridge` 能力并经同一个审批闸门，与外部 MCP 客户端不存在策略差异。API Key 只在后端内存与加密文件之间流转，永不下发到 WebView。
- `state.rs` 持有共享状态与 PTY 控制通道，`SessionControl::Input` 与 `AgentInput` 走同一条写入路径以保证顺序，但只有后者不计入用户输入活跃度，避免 Agent 自己写入的命令被误判成用户在敲字。
- `storage.rs`、`webdav.rs`、`crypto.rs` 分别承担本地持久化、远端同步与加解密，业务模块不直接读写文件或拼装 WebDAV 请求。
- `bin/myterminal-cli.rs` 是面向 MCP 客户端的独立入口，只通过 discovery 文件与本地 Broker 通信；其启动路径由设置页生成的 MCP 配置决定，不依赖 GUI 进程内存。
- Tauri 宏生成符号不能通过普通 `pub use` 转发；子模块命令必须在 `main.rs` 使用真实模块路径注册，前端命令名保持不变。

## MCP Bridge 接入

MCP Bridge 的面向用户介绍只在两份 `README` 中保留功能点，工作方式、客户端配置与工具清单属于接入参考，集中记录在本节。

工作方式：

- 默认关闭，需在 **设置 > MCP** 中启用；启用状态与自动执行策略持久化，重启后按原配置恢复。
- MyTerminal 在 `127.0.0.1` 启动本地 Broker，并写入包含端口与 token 的 discovery 文件。
- 安装版与本地开发版使用不同的单实例标识和数据目录，可在同一台机器上同时运行，不会抢占 Broker 端口。
- 设置页生成的 MCP 配置使用 `latest` 选择策略：每次工具调用都连向后启动且健康的 Broker，该实例退出或崩溃后自动回退到仍存活的旧实例。删除 `MYTERMINAL_BRIDGE_SELECTION` 可改为固定使用 `MYTERMINAL_DATA_DIR` 对应的 Broker。
- 安装版由 MCP 客户端直接启动随应用分发的 `myterminal-cli`；开发态找不到 CLI 时才回退到项目内 `npx` launcher。
- Agent 应先列出连接；简单任务可直接把连接 ID（或唯一连接名称）作为远程工具的 `sessionId`，Bridge 会自动建立逻辑会话，需要独立生命周期时再显式打开与关闭。
- 只读工具（列连接、目录列表、读取文件）可直接执行；同一 Bridge 会话内的命令串行执行以保证远端状态顺序，不同会话可并发。
- 远程命令、本地上传、远端下载与写操作默认进入 MyTerminal 审批面板；新的待审批请求可自动展开面板并发送桌面通知。
- 自动执行可全局开启，也可仅在指定 SSH 连接上放行。

客户端配置（开发态示例，安装版把 `command` 换成 `cliPath`、`args` 换成 `["mcp", "--stdio"]`）：

```json
{
  "mcpServers": {
    "myterminal": {
      "type": "stdio",
      "command": "npx",
      "args": ["--yes", "<repo>/mcp/myterminal-mcp"],
      "env": {
        "MYTERMINAL_DATA_DIR": "<data-dir>",
        "MYTERMINAL_BRIDGE_SELECTION": "latest"
      }
    }
  }
}
```

可用工具：`myterminal_list_connections`、`myterminal_open_session`、`myterminal_close_session`、`myterminal_run_command`、`myterminal_file_list`、`myterminal_file_read`、`myterminal_file_write`、`myterminal_file_upload`、`myterminal_file_download`、`myterminal_file_delete`、`myterminal_file_rename`、`myterminal_file_mkdir`。

连接列表只返回名称、分组路径、主机、端口、用户名与备注，密码、私钥与口令不会通过 MCP 暴露。

## 运行状态监控约定

运行状态概览是全局 Store 之外唯一按秒级高频更新的数据流，其并发边界与渲染边界必须保持以下约束。实现位于 `commands/runtime_monitor.rs`（worker、控制流与定向推送）、`remote_access/runtime_metrics.rs`（纯采集与解析），前端为 `features/runtime/RuntimeSidebar.tsx`、`useRuntimeOverviewSubscription.ts`（概览订阅）与 `useRuntimeMonitor.ts`（按需明细轮询）。

- 概览推送、明细查询与文件 / SFTP 三类阻塞负载各用独立 SSH 会话，不得共用同一个 `Session` 或同一把会话 Mutex。`ssh2` 0.9.x 的阻塞 Channel 读取会阻塞同一底层 Session 上的其他调用，克隆 `Session` 或多开 channel 都不能解决，只能拆成独立 Session。
- 概览由 Rust 常驻 worker 主动推送，不再由前端定时轮询 IPC：worker 独占一条连接、单线程自调度，两次采样严格串行且不补跑积压 tick；控制指令折叠为最终态，Stop 优先级最高，连续 Refresh 合并成一次。采集失败按 1 / 2 / 4 / 8 / 15 / 30 秒退避重试，重试期间保留上一份成功快照，只有连接切换或主动停止才清空。
- CPU 利用率必须由相邻两次正式采样的累计计数求差得出，远端命令内部不做 `sleep` 等待。总计数为 0、计数器倒退或核心集合发生变化时该项返回不可用；任何一次重连都清空 baseline，避免跨重启或跨连接算出错误 delta。
- Rust 使用 `emit_to` 发送 Webview 定向事件时，前端必须用 `getCurrentWebviewWindow().listen` 接收；全局 `event.listen` 收不到定向事件。
- 订阅标识由前端在 `invoke` 之前生成：先注册监听再启动 worker，事件处理同时校验 `subscriptionId`、`connectionId` 与单调递增的 `sequence`，用于丢弃迟到事件和旧连接的包。
- 概览状态只存在于 `features/runtime` 子树内，不得回挂全局 Store；`App`、`TerminalSplitGrid` 与 `TerminalWorkspace` 不应随采样频率重渲染。
- 进程 / 线程与连接明细仍按需请求，不改为常驻推送；全部收起时停止下一轮调度并释放专用会话。侧栏折叠、连接切换与窗口失焦是停止或暂停 worker 的天然边界。
- 存储行只保留概览用量，不再做“最大文件查找”这类全盘扫描；需要目录级体积分析应另立独立用例，不复用每秒采样的概览通道。

## 本地终端约定

本地终端与 SSH 终端共用同一条 PTY 写入通道与同一套标签/分屏模型，差异集中在启动解析与换行语义上，以下规则属于契约而非实现细节。

- 默认系统终端只有一个真相源：`LocalTerminalSettings.defaultShellId`（引用 `shells` 中的 id）。启动解析优先级固定为“显式选择（须 `enabled` 且命令非空）→ `shellPath` 手动路径 → 第一个已开启的系统终端 → 系统探测兜底”，实现在 `commands/local_terminal.rs::resolve_default_shell`。不得再引入硬编码盘符路径；UI 上关闭某个系统终端时要同步清空指向它的 `defaultShellId`。
- 预设命令与启动项里的 `shell:<id>` 是显式引用；普通命令字符串才交给默认终端托管。`shell:<id>` 失效时必须降级为交互式打开并给出提示，不能把 `"shell:xxx"` 原样丢给 shell 执行。
- 命令拼装按可执行名分流（而不是按构建平台条件编译，否则 Linux/macOS 上的 `pwsh` 会被误判）：PowerShell / `pwsh` 用 `-NoLogo -NoExit -Command`，`cmd` 用 `/K`，`bash` / `sh` / `zsh` / `ksh` 用 `-lc`，`dash` / `ash` / `fish` / `csh` / `tcsh` / `nu` / `xonsh` / `elvish` 用 `-c`，未知终端在 Windows 传裸参数、类 Unix 用 `-lc`。
- WSL 必须显式走发行版内的登录交互 bash：`wsl.exe -d <distro> -- bash -lic "<cmd>"`。`wsl.exe` 是 exec 语义，整串命令会被当成单个可执行文件名，带参数的命令必然 not found。
- 本地会话的换行是 CR 而不是 LF：xterm 的 Enter 发 `\r`，ConPTY 也只认 CR 为回车。命令面板给本地会话拼 payload 必须逐个换行折成 CR，不能沿用远端那套（远端有反斜杠续行特判 + `\r`，本地没有续行语义）。
- 「能否向当前终端送内容」的判定用 `canAcceptCommandInput`（远端已握手 **或** 本地会话可用），不要用 `isUsableRemoteSession`——它第一句就是 `kind !== 'local'`，对本地恒为 false。`isUsableLocalSession` 刻意不收敛到 `isUsableTerminalSession`，以保留 SSH「握手未完成前不开输入」的原语义。

## 文档约定

根目录只保留 `README.md`（简体中文，默认）、`README_EN.md`、`ARCHITECTURE.md`、`AGENTS.md` 与 `START_BUILD.md`。两份 `README` 只面向普通使用者：保留功能点、下载入口与环境地址，环境准备、启动与打包细节一律交给 `START_BUILD.md`，MCP 等接入细节交给本文件，避免同一条命令或同一段配置在多处各写一份后漂移。功能清单每个条目只写一句话或一个短语，不展开实现说明。示意图命名与文档对应：中文版用 `img.png`，英文版用 `img_en.png`。需求调研、重构方案与结果报告属于过程稿，结论固化进 `ARCHITECTURE.md` 后即删除，不长期驻留仓库。

## 演进规则

1. 新功能先选择所属功能域，不把新的业务规则继续放进 `App.tsx`、`store.ts` 或 `commands.rs`。
2. 同一规则只能有一个来源。例如连接分组路径规范化由 `domain/connections` 提供，界面和 Store 共同复用。
3. 拆分时保持外部 API 不变，先迁移再优化算法；行为变更必须单独提交并增加对应验证。
4. 纯领域逻辑优先增加单元测试；涉及 Tauri、PTY 或 WebView 的代码至少执行 TypeScript 构建和 Rust 编译检查。
5. 避免跨功能域导入内部文件；确有共享价值时，将规则下沉到 `domain` 或 `shared`。
