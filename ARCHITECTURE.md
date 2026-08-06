# MyTerminal 架构约定

本项目采用“功能域优先、分层依赖、渐进式重构”的结构。目标不是完整照搬服务端 DDD，而是让终端、连接、文件、隧道、运行状态和 Agent 等业务规则拥有清晰归属，同时保持 Tauri 桌面应用所需的直接性。

## 前端分层

```text
src/
├─ App.tsx                 # 页面组合根，只编排功能区与跨域交互
├─ components/             # 仍在迁移中的较大独立视图
├─ features/               # 按用户功能组织的展示规则和子视图
│  ├─ agent/
│  ├─ files/
│  ├─ runtime/
│  ├─ sessions/
│  ├─ settings/
│  └─ workspace/
├─ application/            # 有状态用例服务，例如 Store action factory、终端输入缓冲与串行写入
│  ├─ store/               # Store 总契约及连接、会话、文件、设置、隧道用例切片
│  └─ terminal/            # PTY 输入背压与分片发送策略
├─ domain/                 # 无 Zustand、React、Tauri 依赖的业务规则
│  ├─ connections/
│  ├─ network/
│  ├─ sessions/
│  ├─ settings/
│  ├─ terminal/
│  └─ tunnels/
├─ infrastructure/         # 文件编码、平台接口等技术实现
├─ shared/                 # 无业务含义的基础工具
├─ app/                    # 兼容中的应用级公共工具，逐步向上述层次归位
├─ terminal/               # xterm 行号、高亮、布局、滚动条等交互控制器
│  └─ support/             # 契约、选区、提示符高亮、展示策略与主题纯算法
├─ backend/                # 网关输入规范化与非 Tauri 预览数据
└─ store.ts                # Zustand 初始状态与 action factory 装配根
```

依赖方向约束：

```text
UI / Store → Features / Application → Domain / Shared
                                  ↘ Infrastructure gateway
```

- `domain` 不得导入 React、Zustand、Tauri 或 `backend`。
- `features` 通过各目录的 `index.ts` 向上层提供稳定入口；上层不应依赖功能域内部文件。
- `application` 可以持有队列、计时器和并发状态，但只暴露用例级操作；会话切片再按生命周期、输入背压和输出归并组合。
- `store.ts` 只负责初始状态和 action factory 装配；连接、会话、文件、设置和隧道副作用分别归属 `application/store`。
- `terminal` 控制器按共享坐标系和交互状态机划分，不把帧调度、DOM 测量重新塞回 `TerminalWorkspace.tsx`。
- `backend.ts` 是前端访问 Tauri 的统一网关，组件不直接散落 `invoke` 调用；输入规范化和浏览器预览数据分别归属 `backend/normalizers.ts` 与 `backend/mockState.ts`。

## Rust 后端分层

```text
src-tauri/src/
├─ commands.rs                 # Tauri 命令与跨模块用例装配
├─ commands/
│  ├─ agent.rs                 # Agent Bridge 与内置对话命令适配器
│  ├─ connections.rs           # 连接校验、RDP 与连接 CRUD
│  ├─ local_terminal.rs        # 本地 PTY 启动和读写循环
│  ├─ remote_files.rs          # 远端文件与编辑器应用服务
│  ├─ ssh_sessions.rs          # SSH Shell 与辅助会话生命周期
│  ├─ ssh_transport.rs         # 认证、代理、跳板机与隧道传输
│  ├─ updates.rs               # 更新、远程资源和系统外链
│  ├─ shell_output.rs          # Shell 输出同步协议领域状态机
│  ├─ remote_access.rs         # SFTP、历史和运行指标基础设施适配器
│  ├─ config_sync.rs           # 本地配置与 WebDAV 同步用例
│  ├─ runtime_daemons.rs       # 后台关闭、保活与隧道健康监控
│  ├─ shell_runtime.rs         # 输出队列、Agent 可见进度与 cwd 协议辅助
│  ├─ ssh_transport/tunnels.rs # 隧道 SSH 连接池与监听器
│  └─ remote_access/runtime_metrics/resource_usage.rs
│                               # 系统、容器与 Kubernetes 资源明细
├─ models.rs                   # 领域模型兼容门面
├─ models/
│  ├─ settings.rs             # 设置、WebDAV 与 AI 配置
│  ├─ connections.rs          # 连接、会话、本地终端与历史
│  ├─ runtime.rs              # 文件与运行状态采集模型
│  └─ contracts.rs            # 启动、隧道、更新和持久化交换契约
├─ agent_bridge.rs             # Broker、Agent 会话与命令执行编排
└─ agent_bridge/
   ├─ files.rs                 # Agent 文件读写和递归传输子域
   ├─ requests.rs              # 审批请求生命周期状态机
   └─ http.rs                  # 本地 HTTP Broker 协议适配器
```

- `commands.rs` 只保留参数接收、状态查找、事务顺序和事件编排。
- `shell_output` 采用状态机模式：输入任意分片的 PTY 字节流，输出可见文本、cwd 更新和命令边界事件。
- `remote_access` 采用适配器模式：隐藏辅助 SSH 会话、SFTP 递归、Linux 指标命令与解析细节。
- `config_sync` 作为独立用例模块，恢复配置时仍复用统一的“停止运行时 → 备份 → 保存 → 重载”流程。
- Tauri 宏生成符号不能通过普通 `pub use` 转发；子模块命令必须在 `main.rs` 使用真实模块路径注册，前端命令名保持不变。

## 演进规则

1. 新功能先选择所属功能域，不把新的业务规则继续放进 `App.tsx`、`store.ts` 或 `commands.rs`。
2. 同一规则只能有一个来源。例如连接分组路径规范化由 `domain/connections` 提供，界面和 Store 共同复用。
3. 拆分时保持外部 API 不变，先迁移再优化算法；行为变更必须单独提交并增加对应验证。
4. 纯领域逻辑优先增加单元测试；涉及 Tauri、PTY 或 WebView 的代码至少执行 TypeScript 构建和 Rust 编译检查。
5. 避免跨功能域导入内部文件；确有共享价值时，将规则下沉到 `domain` 或 `shared`。
