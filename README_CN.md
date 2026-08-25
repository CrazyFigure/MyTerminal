# MyTerminal

[English](./README.md) | [简体中文](./README_CN.md)

![Release](https://img.shields.io/github/v/release/CrazyFigure/MyTerminal?include_prereleases&label=release)
![License](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-orange)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111)
![Rust](https://img.shields.io/badge/Rust-stable-000?logo=rust&logoColor=white)

一个基于 Rust、Tauri 2 和 React 构建的现代桌面 SSH 终端管理工具。

MyTerminal 把终端标签页与拖拽分屏、支持跳板机与代理的 SSH 连接管理、Windows 远程桌面、SFTP 文件管理、远程文件编辑、本地端口转发、内置 AI 助手和 WebDAV 备份放到一个清爽的桌面应用里。它面向开发者和运维场景，希望提供一个轻量、开放、可折腾的远程终端工具。

![MyTerminal 预览](img_cn.png)

## 功能清单

### SSH 连接与链路

- **SSH 连接管理** - 支持新建、编辑、分组、复制、移动、拖拽排序，并可在连接前测试配置。
- **Windows 远程桌面（RDP）** - 连接列表可保存 RDP 连接，打开时调用系统自带的远程桌面客户端；密码通过 Windows 凭据 API 以会话级凭据写入，不经过命令行明文传递。仅 Windows 可用，且不支持跳板机与代理。
- **连接类型区分** - 连接列表和编辑表单用统一图标区分 SSH 终端与 Windows 远程桌面，两类连接共用同一套分组树和排序。
- **密码与私钥认证** - 支持 SSH 密码、私钥文件、粘贴私钥内容认证，以及密码 / 私钥口令的明文查看开关。
- **跳板机链路** - 支持按顺序配置多级 SSH 跳板机，终端、文件操作、隧道和 MCP Bridge 会话统一复用这套链路模型。
- **首跳代理** - 支持通过 SOCKS5 或 HTTP CONNECT 代理连接第一跳 SSH，并可配置代理认证。
- **连接清理** - 关闭标签、删除连接或退出应用时，会清理相关终端会话、辅助 SSH 会话、隧道和 CLI Bridge 进程。

### 终端工作区

- **多标签 SSH 终端** - 支持真实 SSH PTY 会话、多会话标签页、标签拖拽排序、原位重连、关闭会话，并根据 SSH 连接显示标签标题。
- **拖拽分屏** - 把标签从标签栏拖入终端区即可分屏，终端区会浮出四角与四边共 8 个吸附点并实时预览目标区域，落点分别对应新开分屏、移到此格和改变此格范围。基于 2×2 网格，最多 4 格，可组成整屏、左右两分、上下两分、三分和四分布局。
- **每格独立标签栏** - 每个分屏格有自己的标签栏，一格可以挂多个标签并单独排序；SSH 与本地终端可混合分屏，聚焦的格子带描边高亮，侧栏的文件、运行状态和命令面板跟随当前聚焦标签。分屏布局只存在于运行期，重启后从单格开始。
- **非阻塞连接启动** - 打开 SSH 标签后立即进入 connecting 状态，SSH 握手与认证在后台线程完成，避免界面等待网络。
- **交互输入处理** - 普通字符使用极短合并窗口降低 WebView 到 Rust 的 IPC 压力，Enter、Tab、控制序列和编辑键立即发送到远端 PTY。
- **右键工作流** - 支持右键菜单复制 / 粘贴，也可配置右键直接粘贴；菜单操作结束后会把焦点交回终端。
- **行号与时间戳栏** - 终端左侧独立栏可显示逻辑行号和每行到达时刻的时间戳，在该栏上右键即可分别开关，切换后立即持久化。
- **选中匹配高亮** - 选中终端文本后，滚动缓冲区内完全一致的内容会自动高亮，可在外观设置中关闭。
- **提示符语义高亮** - 提示符中的用户、主机、路径和符号按语义分色渲染，深浅色主题各有一套配色。
- **光标恢复** - 远端程序隐藏光标后如果异常返回 shell，提示符边界会兜底恢复光标，避免后续输入看不到插入点。
- **本地光标兜底** - 切换会话或重放缓存输出时，前端会恢复 xterm 光标显示，且不会把控制符发送回 SSH。
- **自绘滚动条** - 终端右侧滚动条在指针靠近时显现并支持拖拽；标签过多时标签栏也会出现可点击跳转、可拖拽的横向滚动条。
- **自适应尺寸** - 基于 xterm.js 渲染，窗口缩放和分屏布局变化时自动重算行列数并同步远端 PTY。
- **会话焦点管理** - 切换会话、重连或 SSH 后台启动完成后，会在目标终端可输入时恢复输入焦点。
- **SSH 长行展示模式** - SSH 会话可选择自动换行，或使用横向滚动把长输出保留在同一行并跟随光标；本地终端与 TUI 始终自动换行。
- **终端路径联动** - 注入远端 cwd 同步钩子后，终端执行 `cd`、`pushd`、`popd` 可联动文件管理器路径。
- **直接输入路径刷新** - 手输或粘贴 `cd` 命令后会提前刷新文件面板，后端 cwd 标记返回后再做最终校正。
- **子 Shell 路径同步** - Bash 子 Shell 会继承 cwd 同步钩子，非交互脚本不会输出 MyTerminal 的同步标记。
- **远端历史读取** - 可读取远端 shell 历史文件用于命令历史能力，同时隐藏 MyTerminal 内部注入命令。
- **系统剪贴板桥接** - 应用内任意位置的复制 / 剪切都会同步写入 Windows 系统剪贴板，终端右键粘贴也走原生通道，避免 WebView 弹出剪贴板权限请求。

### 本地终端与 AI CLI

- **本地终端标签页** - 可在 SSH 标签旁打开本地原生 PTY 会话，底层使用 ConPTY / portable-pty，而不是模拟输出。
- **AI CLI 启动器** - 可在指定工作目录启动 Claude Code、Codex、opencode 或自定义本地命令。
- **纯 Shell 模式** - 选择内置“本地终端”命令时，会直接打开配置的本机 Shell，不强制启动 AI CLI。
- **本地专属配置** - 本地 Shell 路径、命令预设和历史目录写入 `local-terminals.json`，不会进入 WebDAV 同步包。
- **历史目录** - 可按最近目录重新打开本地终端，并在每次启动前为该目录选择命令，历史记录以目录为主。
- **紧凑本地标签** - 本地终端顶部标签只显示最后一级目录名，例如 `codex · MyTerminal` 或 `MyTerminal`，完整路径仍保留在历史和会话详情中。

### SFTP 文件与编辑

- **远程文件浏览器** - 支持远程目录浏览、文件属性查看、新建目录、删除、重命名、刷新和路径导航，底层使用真实 SFTP 操作。
- **拖放上传** - 支持把本地文件或文件夹拖入 SFTP 文件浏览器上传，并可递归上传文件夹。
- **批量传输** - 支持远端多选文件 / 文件夹下载、本地多路径上传，同名本地下载会自动生成唯一目标路径，避免覆盖。
- **文件连接复用** - 文件浏览、传输、远程编辑、运行状态和历史读取会复用辅助 SSH / SFTP 会话，避免每次操作都重新握手。
- **失效会话恢复** - 辅助 SSH 缓存被远端空闲回收时会丢弃旧连接并自动重试一次。
- **远端身份缓存** - 远端 uid / gid 对应的用户名和组名会在辅助会话内缓存，目录刷新时不重复读取 `/etc/passwd` 和 `/etc/group`。
- **远程文件编辑器** - 内置 Monaco 编辑器，支持读取远端文件、触发编辑器保存动作，并通过 SFTP 写回保存。
- **编辑器恢复缓存** - 远程文件加载或保存异常时，本地文档缓存可作为恢复兜底。
- **MCP / CLI 文件工具** - AI 客户端可通过审批后的 Bridge 操作列目录、读写文件、上传、下载、删除、重命名和创建目录。

### 运行状态与隧道

- **运行状态概览** - 可读取当前 SSH 连接的远端 CPU、内存、根分区存储、连接数、运行时长和操作系统信息，各行按占用率分级着色。
- **每核心 CPU 明细** - 展开 CPU 行可查看每个核心的独立占用率。
- **资源占用 Top 列表** - 展开内存行可查看占用最高的条目，支持按内存 / CPU 排序，以及按进程 / 线程统计。
- **多种资源来源** - 资源占用统计来源可在设置中切换为系统进程、Docker、Podman 或 Kubernetes；Kubernetes 来源读取全命名空间的 Pod 级 CPU 与内存。
- **最大文件排查** - 展开存储行可查看远端占用空间最大的若干文件及完整路径，扫描带超时限制。
- **连接明细展开** - 连接数行可展开查看远端 ESTABLISHED 连接的本地 / 对端地址与端口，SSH 管理连接自动置顶并标记。
- **本地端口转发** - 支持本地端口转发记录的新建、编辑、开启和停止，并可配置 bind 地址与目标地址。
- **隧道生命周期管理** - 运行中的隧道和终端会话分开记录，可独立停止和清理。

### 内置 AI 助手

- **AI 对话面板** - 右侧可折叠侧栏内置 AI 对话，支持流式输出、随时停止、新建对话，以及本地保存和恢复历史对话。
- **多端点多模型** - 可配置多个 AI 端点，每个端点下配置多个模型，并分别设置上下文窗口和输出上限；API Key 加密落盘。
- **三种接口协议** - 支持 Anthropic Messages、OpenAI Chat Completions 和 OpenAI Responses 协议，设置页会实时预览实际请求地址，并针对常见错误码给出排查建议。
- **思考强度与自动压缩** - 每轮对话可选择思考强度，并可开启上下文自动压缩：估算 token 超过设定比例时自动折叠较早消息并提示。
- **AI 直接操作远端** - AI 可调用列连接、执行命令和一整套远端文件工具，与外部 MCP 客户端共用同一套审批策略。
- **命令在真实终端执行** - AI 的远程命令默认打进用户可见的终端标签，命令行以 `[AI]` 前缀高亮显示；Shell 不支持命令边界协议、前台是全屏 TUI 或终端被占用时，自动回退后台执行并如实返回回退原因。
- **内联审批** - 内置 AI 产生的审批卡片直接挂在对应工具调用下方，侧栏收起时会自动展开并切到对话页。

### MCP Bridge 与 AI 审批

- **面向 AI 编程工具的 MCP Bridge** - 让 Claude Code、Codex 等 MCP 客户端通过本地 `CLI + MCP + GUI Broker` 使用已保存 SSH 连接。
- **连接发现** - MCP 客户端可读取 SSH 连接的脱敏元信息，包括名称、分组路径、主机、端口、用户名和备注。
- **桥接会话** - MCP 客户端可通过连接 ID 或唯一连接名称打开和关闭逻辑 SSH Bridge 会话，并基于会话执行远程命令或文件操作。
- **GUI 审批执行** - 远程命令、上传、下载、写入、删除、重命名和创建目录请求默认进入 MyTerminal 审批面板。
- **右侧 AI 执行栏** - 待审批和已完成的 AI 请求会显示在可调整宽度的右侧栏，命令、文件和历史面板可继续使用。
- **会话命令串行** - 同一个 AI Bridge 会话内的命令会按顺序执行，不同会话仍可并发执行。
- **独立执行设置页** - 自动执行、在终端中执行、默认超时和最大输出字节集中在「执行」设置页，内置 AI 助手与外部 MCP 共用同一份规则。
- **自动执行控制** - 可全局开启 Bridge 自动执行，也可在关闭全局自动执行时按 SSH 连接配置白名单。
- **AI 审批通知** - 待确认请求可自动展开 AI 执行面板，展示 SSH 机器、命令或目标摘要，并在系统支持时通过桌面通知按钮快速审批。
- **Agent 使用引导** - MCP 客户端会收到工具说明，明确 list/open/use/close 流程、sessionId 规则和文件写入建议。
- **Bridge 稳定性** - MCP Bridge 设置重启时保留 AI 逻辑会话，等待请求处理更可预期，应用退出时会清理 Bridge 资源。

### 同步、备份与更新

- **WebDAV 手动同步** - 应用设置与 SSH 连接可分开上传、下载，方便多设备迁移。
- **本地导入 / 导出** - 支持导出 JSON 配置包，也支持导入覆盖；导入前会自动备份当前本地数据。
- **桌面更新流程** - 可检测 GitHub Release、识别安装包、下载安装包，并从应用内启动安装。
- **代理感知更新检查** - 更新请求会遵循系统代理设置，并使用保守的连接、读取和总时长超时。
- **安装包缓存校验** - 安装包下载会先写入临时文件，按 Release 资产大小校验完整性，只有完整缓存才会被复用。

### 桌面体验

- **双语界面** - 支持简体中文 / English 切换。
- **自定义标题栏** - 无边框窗口配自绘标题栏，集成侧栏开关、新建连接、连接管理、本地终端、检查更新、主题切换、设置和窗口控制按钮；应用内弹窗均可拖动。
- **外观设置** - 终端与 AI 对话区可分别设置西文字体、中文字体、字号和行高；JetBrains Mono 与 Maple Mono 作为可选应用字体包按需下载一次，后续更新复用且不会安装到 Windows。字号与行高支持一键恢复默认；终端背景图可设置不透明度和 cover / contain / stretch / tile / center 填充方式；另有右键行为、长行展示模式、选中匹配高亮和硬件加速开关。
- **统一浮动提示** - 保存设置、测试连接、复制配置等操作结果通过统一的浮动提示反馈，短暂显示后自动消失，不再挤占表单布局。
- **渐进式启动** - 终端内核与 AI 对话面板按需加载，标题栏和侧栏先行可用；AI 侧栏首次展开前不加载，展开后收起也不会中断进行中的流式响应。
- **系统托盘** - 支持桌面托盘图标，方便从系统外壳快速访问。
- **本地优先存储** - 设置和 SSH 连接保存在本地，应用内部处理敏感字段；只有显式导出 JSON 时才会生成明文配置包。

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

- MCP Bridge 初始默认关闭，需要在 **设置 > MCP** 中手动开启；开启状态与自动执行策略会持久化，并在 MyTerminal 重启后按原配置恢复。
- 开启后，MyTerminal 会在 `127.0.0.1` 启动本地 Broker，并写入包含端口与 token 的 discovery 文件。
- 安装版与本地开发版使用不同的单实例标识和数据目录，可以在同一台机器上同时运行；两个 Broker 都开启时不会抢占端口。
- 设置页生成的 MCP 配置默认使用 `latest` 选择策略：每次工具调用都连接后启动且健康的 Broker；该实例退出或崩溃后会自动回退到仍存活的旧实例。删除 `MYTERMINAL_BRIDGE_SELECTION` 可继续固定使用 `MYTERMINAL_DATA_DIR` 对应的 Broker。
- 安装版优先由 MCP 客户端直接启动随 MyTerminal 分发的 `myterminal-cli`；开发态找不到 CLI 时才通过项目内 `npx` launcher 启动。
- Agent 应先列出连接；简单任务可把返回的连接 ID（或唯一连接名称）直接作为远程工具的 `sessionId`，Bridge 会自动建立逻辑会话。如需独立会话，也可显式打开并复用返回的 `sessionId`，任务结束后关闭。
- 连接列表、目录列表、文件读取等只读工具可直接执行。
- 同一 Bridge 会话内的命令会串行执行，避免远端状态顺序错乱；不同会话可以并发。
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
      ],
      "env": {
        "MYTERMINAL_DATA_DIR": "C:/Software/WorkSpace/MyTerminal/.myterminal-data",
        "MYTERMINAL_BRIDGE_SELECTION": "latest"
      }
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

连接列表只返回名称、分组路径、主机、端口、用户名和备注等脱敏元信息，不会通过 MCP 暴露密码、私钥或私钥口令。

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
- **终端与编辑器：** xterm.js、portable-pty、Monaco Editor
- **AI 集成：** Anthropic Messages、OpenAI Chat Completions / Responses、MCP
- **同步与文件：** SFTP、WebDAV、本地导入 / 导出

## 致谢

- 感谢 [Linux.do](https://linux.do) 社区对项目的推广与反馈。

## Star 走势

[![Star 走势图](./assets/star-history.svg)](https://github.com/CrazyFigure/MyTerminal/stargazers)

## 许可证

[MIT License + Commons Clause License Condition v1.0](./LICENSE) © 2026
CrazyFigure。允许企业免费用于内部生产；未经版权所有者事先书面授权，不得销售
MyTerminal 本身，也不得提供其价值全部或主要来源于 MyTerminal 功能的收费产品或服务。
这是源码可用许可证，不是 OSI 认可的开源许可证。
