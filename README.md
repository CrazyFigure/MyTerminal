# MyTerminal

基于 Rust + Tauri 2 + React 的现代化远程终端管理工具，目标是复刻并优化 FinalShell 的核心体验。

当前版本：`v0.1.4`

## 当前功能状态

目前已经实现：

- Tauri 2 + React + TypeScript + Vite 项目骨架
- 现代化 FinalShell 风格界面
- 默认简体中文界面，并支持切换英文
- 深浅色切换、单字体选择、终端背景图片、自定义终端外观、紧凑侧边栏
- xterm 终端界面，默认 JetBrains Mono、15px、浅色背景
- SSH 连接新增、编辑、删除
- SSH 密码认证与私钥认证
- 连接表单测试连接
- 密码 / 私钥口令明文查看开关
- 多会话标签页、右键菜单、关闭 / 重连 / 复制连接信息、标签拖拽排序
- 本地加密保存 SSH 密码、WebDAV 凭证、同步口令
- 基于 `ssh2` 的真实 SSH PTY 会话
- 终端当前目录自动同步文件管理路径
- 真实 SFTP 列表、上传、下载、删除、重命名、读取、写回
- 内置 Monaco 编辑器，支持远程保存与本地缓存回退
- 本地 SSH 隧道 / 本地端口转发，自定义 bind 地址与目标
- 从远端 Shell 历史文件读取命令历史
- WebDAV 手动同步（设置 / SSH 连接分开）
- 本地 JSON 配置导出 / 导入（覆盖）与导入前备份
- GitHub Release 更新检测、安装包下载与启动安装
- 连接分组新增、编辑、删除、拖拽排序，以及连接复制和跨分组移动

当前已知限制：

- 暂未实现 `known_hosts` / 主机指纹校验流
- SFTP 大文件传输暂未实现进度条与取消能力
- 隧道暂未提供编辑、重启、实时连接数等高级管理能力
- Monaco 已改为懒加载，但 xterm / Monaco 仍可能让生产构建出现较大 chunk 提示

## 技术栈

- 前端：React、TypeScript、Vite、Zustand、xterm、Monaco Editor
- 后端：Rust、Tauri 2、`ssh2`、`reqwest`、AES-GCM、本地 JSON 持久化

## 快速开始

### 环境建议

- Node.js 20.19+ 或 22.12+
- npm 9+
- Rust stable（MSVC toolchain）
- Visual Studio Build Tools 2022
- Windows 10/11 SDK
- Strawberry Perl（Windows 下 vendored OpenSSL 常需要）

### 常用命令

安装依赖：

```powershell
npm install
```

检查环境：

```powershell
npm run check:env
```

执行前后端检查：

```powershell
npm run check
```

启动桌面开发模式：

```powershell
npm run tauri:dev
```

仅启动前端开发服务器：

```powershell
npm run dev
```

打包桌面安装包：

```powershell
npm run package
```

打包成功后，通常可在下面目录找到产物：

```text
src-tauri/target/release/bundle/
```

更完整的 Windows 启动与打包说明，请查看项目根目录中的：

```text
START_BUILD.md
```

## 检查脚本

- `npm run typecheck`：仅做前端类型检查
- `npm run check:web`：构建前端
- `npm run check:perl`：检查 Perl / Strawberry Perl
- `npm run check:rust`：检查 Rust/Tauri 后端
- `npm run check:env`：检查 Node、npm、cargo、perl、link.exe

## 同步与备份说明

- WebDAV 同步是手动触发的，并分为两块：
  - 应用设置上传 / 下载
  - SSH 连接上传 / 下载
- 本地导出会在 `.myterminal-data/exports/` 下生成明文 JSON 配置包
- 本地导入会覆盖：
  - 设置
  - SSH 连接
  - 历史记录
  - 隧道配置
- 在本地导入前，会把当前本地数据备份到 `.myterminal-data/backups/`
- 导出的本地配置文件包含密码明文，仅用于迁移和恢复，请妥善保管

## 手工验证清单

- 打开应用，确认界面正常加载
- 确认默认终端样式：
  - 背景 `#f7f7f7`
  - 前景 `#111111`
  - 字体 `JetBrains Mono`
  - 字号 `15px`
- 在设置页测试语言切换、深浅色切换、字体下拉、终端背景图片、本地图片选择、透明度和适配方式
- 新建 SSH 连接并测试：
  - 密码模式
  - 私钥模式
  - 测试连接按钮
- 切换密码 / 私钥口令明文显示
- 打开多个终端标签页，切换、拖拽排序、右键关闭 / 重连时确认状态正确
- 在 xterm 中直接输入，确认远程 shell 能收到输入
- 在终端中执行 `cd /` 等目录切换，确认文件管理路径同步变化
- 执行持续输出命令（如 `ping`、`tail -f`），确认输出持续刷新
- 打开文件面板，测试目录浏览、上传、下载、重命名、删除确认、返回上级
- 打开远程文件到内置编辑器并保存回远端
- 配置 WebDAV，并测试上传 / 下载
- 使用本地导出与本地导入，确认导入会覆盖本地数据
- 创建并停止一个隧道记录
- 在设置页关于标签中检测更新，确认可识别 GitHub Release 安装包

## 后续建议增强

1. 增加 `known_hosts` / 指纹信任流程
2. 为 SFTP 上传 / 下载增加进度与取消
3. 增加隧道编辑、重启、复制端点等高级管理能力
4. 继续优化生产构建体积与加载速度
