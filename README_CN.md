# MyTerminal

[English](./README.md) | [简体中文](./README_CN.md)

![Release](https://img.shields.io/github/v/release/CrazyFigure/MyTerminal?include_prereleases&label=release)
![License](https://img.shields.io/github/license/CrazyFigure/MyTerminal)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111)
![Rust](https://img.shields.io/badge/Rust-stable-000?logo=rust&logoColor=white)

一个基于 Rust、Tauri 2 和 React 构建的现代桌面 SSH 终端管理工具。

MyTerminal 把终端标签页、支持跳板机与代理的 SSH 连接管理、SFTP 文件管理、远程文件编辑、本地端口转发和 WebDAV 备份放到一个清爽的桌面应用里。它面向开发者和运维场景，希望提供一个轻量、开放、可折腾的远程终端工具。

![MyTerminal 预览](img_cn.png)

## 0.2.0 更新

- **多级 SSH 链路** - 支持按顺序配置 SSH 跳板机，并可为第一跳配置 SOCKS5 或 HTTP CONNECT 代理，终端、文件操作、隧道和 MCP Bridge 会话统一复用这套连接能力。
- **更完整的文件传输** - 支持把本地文件或文件夹拖入 SFTP 文件浏览器上传，递归上传文件夹，批量下载远端选中的文件或文件夹，并补齐 MCP / CLI 的上传下载工具。
- **更清晰的 AI 审批** - 新的 AI 执行待确认请求会自动展开底部 AI 执行面板，展示 SSH 机器、命令或目标摘要，并可通过桌面通知跳转回审批列表。
- **Bridge 稳定性修复** - MCP Bridge 设置重启时保留 AI 逻辑会话，应用退出时清理 SSH 会话和 CLI 后端，减少旧进程残留和等待请求卡住。

## 功能亮点

- **SSH 连接管理** - 支持新建、编辑、分组、复制、移动、拖拽排序，并可在连接前测试配置，包含跳板机与代理链路设置。
- **密码与私钥认证** - 支持 SSH 密码认证、私钥认证，以及密码 / 私钥口令的明文查看开关。
- **多标签终端工作区** - 支持真实 SSH PTY 会话、多会话标签页、标签拖拽排序、原位重连和右键菜单操作。
- **SFTP 文件浏览器** - 支持远程目录浏览、文件或文件夹拖放上传、远端多选下载、删除、重命名、读取和写回。
- **远程文件编辑器** - 内置 Monaco 编辑器，支持远程保存，并在异常场景下提供本地缓存回退。
- **终端与文件路径联动** - 终端执行 `cd` 后，可自动同步文件管理器的远程路径。
- **SSH 隧道** - 支持本地端口转发记录的新建、编辑、开启和停止，并可配置 bind 地址与目标地址。
- **WebDAV 手动同步** - 应用设置与 SSH 连接可分开上传、下载，方便多设备迁移。
- **面向 AI 编程工具的 MCP Bridge** - 让 Claude Code、Codex 等 MCP 客户端通过本地 GUI Broker 读取 SSH 连接、打开桥接会话、执行远程命令，上传 / 下载远程文件，以及读写远程文件。
- **AI 审批通知** - 待确认的 AI 执行请求可自动展开、展示紧凑执行摘要，并通过桌面通知带你回到审批面板。
- **本地导入 / 导出** - 支持导出 JSON 配置包，也支持导入覆盖；导入前会自动备份当前本地数据。
- **桌面更新流程** - 可检测 GitHub Release、下载安装包，并从应用内启动安装。
- **可定制终端界面** - 支持简体中文 / English、深浅色、终端字体、紧凑侧边栏、终端背景图片等设置。

## 下载

当项目发布版本标签时，Windows 安装包会发布在 [GitHub Releases](https://github.com/CrazyFigure/MyTerminal/releases) 页面。

MyTerminal 目前仍处于早期阶段。请妥善备份重要 SSH 连接配置，也不要把本地导出的 JSON 当作加密备份使用：导出文件中会包含敏感值明文。

## 快速开始

### 环境要求

- Node.js 20.19+ 或 22.12+
- npm 9+
- Rust stable，使用 MSVC toolchain
- Visual Studio Build Tools 2022
- Windows 10/11 SDK
- Windows 下 vendored OpenSSL 需要时，建议安装 Strawberry Perl

### 从源码运行

```powershell
npm install
npm run check:env
npm run tauri:dev
```

### 构建安装包

```powershell
npm run package
```

构建产物通常位于：

```text
src-tauri/target/release/bundle/
```

完整 Windows 环境准备、启动和打包说明请查看 [START_BUILD.md](./START_BUILD.md)。

## MCP Bridge

MyTerminal 可以把已保存的 SSH 连接通过本地 `CLI + MCP + GUI Broker` 桥接给 Claude Code、Codex 和其他 MCP 客户端使用。

### 工作方式

- MCP Bridge 默认关闭，需要在 **设置 > MCP** 中手动开启。
- 开启后，MyTerminal 会在 `127.0.0.1` 启动本地 Broker，并写入包含端口与 token 的 discovery 文件。
- MCP 客户端通过 `npx` 启动本地 MCP 包，MCP 包再启动 `myterminal-cli mcp --stdio`。
- 连接列表、目录列表、文件读取等只读工具可直接执行。
- 远程命令、本地上传、远端下载和写操作默认会进入 MyTerminal 的 AI 请求面板，由用户手动批准。
- 新的待审批请求可自动展开 AI 执行面板并发送桌面通知；点击通知会聚焦审批列表。
- 如需自动执行，可在 MCP 设置页全局开启，或在关闭全局自动执行时按 SSH 连接配置白名单。

### MCP 客户端配置

可以直接复制 **设置 > MCP > 使用方式** 中的 JSON。开发态示例如下：

```json
{
  "mcpServers": {
    "myterminal": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "--yes",
        "C:/Software/WorkSpace/MyTerminal/mcp/myterminal-mcp"
      ]
    }
  }
}
```

### 可用 MCP 工具

- `myterminal_list_connections`
- `myterminal_open_session`
- `myterminal_close_session`
- `myterminal_run_command`
- `myterminal_file_list`
- `myterminal_file_read`
- `myterminal_file_write`
- `myterminal_file_upload`
- `myterminal_file_download`
- `myterminal_file_delete`
- `myterminal_file_rename`
- `myterminal_file_mkdir`

连接列表只返回名称、分组路径、主机、端口、用户名、标签和备注等脱敏元信息，不会通过 MCP 暴露密码、私钥或私钥口令。

## 常用脚本

```powershell
npm run dev          # 仅启动 Vite 前端开发服务器
npm run typecheck    # 执行前端 TypeScript 类型检查
npm run check:web    # 构建前端
npm run check:rust   # 检查 Rust/Tauri 后端
npm run check:perl   # 检查本机 Perl 环境
npm run check:env    # 检查 Node、npm、cargo、Perl、link.exe
npm run check        # 执行前端构建和 Rust 后端检查
```

## 技术栈

- **桌面外壳：** Tauri 2
- **后端：** Rust、ssh2、reqwest、AES-GCM、本地 JSON 持久化
- **前端：** React、TypeScript、Vite、Zustand
- **终端与编辑器：** xterm.js、Monaco Editor
- **同步与文件：** SFTP、WebDAV、本地导入 / 导出

## 当前限制

- 暂未实现 `known_hosts` / 主机指纹信任流程。
- SFTP 大文件传输暂未提供进度条与取消能力。
- 隧道管理已支持新增、编辑、开启和停止，但暂未展示实时连接数等高级运行指标。
- Monaco 已改为懒加载，但由于 xterm.js 和 Monaco 体积都比较大，生产构建仍可能出现较大的 chunk 提示。

## 参与贡献

欢迎提交 Issue、Bug 反馈和 Pull Request。一个比较理想的贡献通常包含：

- 清晰描述问题或功能目标。
- 反馈 Bug 时提供可复现步骤。
- UI、连接、文件传输相关问题尽量附带截图或日志。
- 变更尽量聚焦，避免把无关重构混在同一个 Pull Request 里。

提交 Pull Request 前，请根据变更范围运行必要检查。涉及前后端联动的变更，建议至少执行 `npm run check`。

## 致谢

- 社区：[Linux.do](https://linux.do)
- 项目体验参考了 FinalShell 等远程终端工具中的实用工作流。

## License

[MIT](./LICENSE) © 2026 CrazyFigure
