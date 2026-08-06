# Repository Guidelines

## 项目结构与模块组织

MyTerminal 由 React 19/TypeScript 前端与 Tauri 2/Rust 桌面后端组成。**主要目录结构、分层职责及依赖方向以 [ARCHITECTURE.md](./ARCHITECTURE.md) 为准**，新增模块或调整边界前必须先阅读该文件。前端代码位于 `src/`：业务规则放入 `domain/`，有状态用例放入 `application/`，功能界面放入 `features/`，通用工具放入 `shared/`。Rust 命令、模型、状态和 `myterminal-cli` 位于 `src-tauri/src/`。静态资源放入 `public/` 或 `assets/`，维护脚本放入 `scripts/`，MCP 启动器位于 `mcp/myterminal-mcp/`。不要提交 `dist/`、`node_modules/` 或 `.myterminal-data/`。

## 构建、测试与开发命令

- `npm ci`：按锁文件安装依赖。
- `npm run check:env`：检查 Node、npm、Rust、Perl 和 Windows 链接器。
- `npm run dev`：仅启动 1420 端口的 Vite 前端。
- `npm run tauri:dev`：启动完整桌面开发环境。
- `npm run typecheck`：执行 TypeScript 类型检查。
- `npm run check:web`：构建前端并检查包体内存限制。
- `npm run check:rust`：同步版本并检查 Rust 后端。
- `cargo test --manifest-path src-tauri/Cargo.toml`：运行 Rust 单元测试。
- `npm run check`：执行标准前后端检查。

## 编码风格与命名约定

TypeScript/TSX 使用两空格缩进、单引号、分号和尾随逗号；Rust 遵循 `rustfmt`。React 组件和类型使用 `PascalCase`，函数与变量使用 `camelCase`，Hook 使用 `useXxx`，Rust 模块和命令使用 `snake_case`。不要把业务规则堆入视图组件。公共接口、关键分支、边界处理、远程调用和文件操作应添加简洁的中文前置注释，重点说明意图，并保留已有注释。

## 测试规范

Rust 测试与源码同文件放在 `#[cfg(test)]` 模块中，测试名使用有含义的 `snake_case`。纯领域逻辑、解析、规范化和边界条件应补充测试。当前没有前端测试框架或覆盖率阈值；UI 变更至少运行 `npm run typecheck` 和 `npm run check:web`，并手动验证对应 Tauri 流程、Hover/Active 状态及取消后的回退效果。

## 提交与 Pull Request 规范

提交沿用 Conventional Commits，例如 `feat(agent): ...`、`fix(update): ...`、`refactor(terminal): ...`。每次提交聚焦单一目的，并尽量填写 scope。Pull Request 应说明行为变化、关联 Issue、验证命令；可见 UI 变化需附截图或录屏，并注明配置、安装包或安全影响。禁止提交密钥和本地运行数据；未经明确许可，不得执行 `git commit` 或 `git push`。
