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
├─ application/            # 有状态用例服务，例如终端输入缓冲与串行写入
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
└─ store.ts                # Zustand 用例编排与公开状态 API
```

依赖方向约束：

```text
UI / Store → Features / Application → Domain / Shared
                                  ↘ Infrastructure gateway
```

- `domain` 不得导入 React、Zustand、Tauri 或 `backend`。
- `features` 通过各目录的 `index.ts` 向上层提供稳定入口；上层不应依赖功能域内部文件。
- `application` 可以持有队列、计时器和并发状态，但只暴露用例级操作。
- `store.ts` 负责组合状态与调用用例，不再实现连接清洗、端口校验等领域算法。
- `backend.ts` 是前端访问 Tauri 的统一网关，组件不直接散落 `invoke` 调用。

## Rust 后端分层

```text
src-tauri/src/
├─ commands.rs                 # Tauri 命令与跨模块用例编排
└─ commands/
   ├─ shell_output.rs          # Shell 输出同步协议领域状态机
   ├─ remote_access.rs         # SSH/SFTP、历史和运行指标基础设施适配器
   └─ config_sync.rs           # 本地配置与 WebDAV 同步用例
```

- `commands.rs` 只保留参数接收、状态查找、事务顺序和事件编排。
- `shell_output` 采用状态机模式：输入任意分片的 PTY 字节流，输出可见文本、cwd 更新和命令边界事件。
- `remote_access` 采用适配器模式：隐藏辅助 SSH 会话、SFTP 递归、Linux 指标命令与解析细节。
- `config_sync` 作为独立用例模块，恢复配置时仍复用统一的“停止运行时 → 备份 → 保存 → 重载”流程。

## 演进规则

1. 新功能先选择所属功能域，不把新的业务规则继续放进 `App.tsx`、`store.ts` 或 `commands.rs`。
2. 同一规则只能有一个来源。例如连接分组路径规范化由 `domain/connections` 提供，界面和 Store 共同复用。
3. 拆分时保持外部 API 不变，先迁移再优化算法；行为变更必须单独提交并增加对应验证。
4. 纯领域逻辑优先增加单元测试；涉及 Tauri、PTY 或 WebView 的代码至少执行 TypeScript 构建和 Rust 编译检查。
5. 避免跨功能域导入内部文件；确有共享价值时，将规则下沉到 `domain` 或 `shared`。
