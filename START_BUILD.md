## MyTerminal 启动与打包指南

本文档说明如何在 Windows 上启动开发环境、检查后端、以及打包桌面安装包。

### 1. 环境要求

建议环境：

- Node.js 20.19+ 或 22.12+
- npm 9+
- Rust stable（MSVC toolchain）
- Visual Studio Build Tools 2022（C++ 桌面生成工具）
- Windows 10/11 SDK
- Strawberry Perl（`ssh2` 的 vendored OpenSSL 在 Windows 下常需要）

推荐先执行环境自检：

```powershell
npm run check:env
```

如果下面命令都能通过，通常说明基础环境已经齐了：

```powershell
npm run check:web
npm run check:rust
```

### 2. 安装前端依赖

在项目根目录执行：

```powershell
npm install
```

### 3. 启动开发模式

#### 方式 A：直接启动 Tauri 桌面开发模式

这是最常用的方式：

```powershell
npm run tauri:dev
```

它会：

1. 启动 Vite 前端开发服务器；
2. 编译 Rust/Tauri 后端；
3. 弹出桌面应用窗口。

#### 方式 B：仅启动前端开发服务器

如果你只是调样式或纯前端结构：

```powershell
npm run dev
```

默认地址：

```text
http://localhost:1420
```

### 4. 检查命令

#### 4.1 前端构建检查

```powershell
npm run check:web
```

#### 4.2 Rust/Tauri 后端检查

```powershell
npm run check:rust
```

这个脚本会：

- 自动寻找 `cargo`
- 尝试注入 Strawberry Perl 到 PATH
- 执行 `cargo check --manifest-path "src-tauri/Cargo.toml"`

#### 4.3 Perl 检查

```powershell
npm run check:perl
```

#### 4.4 一次性检查前后端

```powershell
npm run check
```

### 5. 构建前端产物

```powershell
npm run build
```

输出目录：

```text
dist/
```

### 6. 打包桌面应用

执行：

```powershell
npm run package
```

或：

```powershell
npm run tauri:build
```

打包成功后，通常可在这里找到产物：

```text
src-tauri/target/release/bundle/
```

常见会包含：

- `.msi`
- `.exe`

具体取决于 Tauri 的 bundler 配置。

### 7. 当前实现说明

- 当前已支持 SSH 密码认证与私钥认证
- 当前已支持连接表单“测试连接”
- 当前尚未实现 `known_hosts` / 主机指纹信任流程
- Monaco 已改为懒加载，但构建时仍可能因 Monaco / xterm 产生较大 chunk 提示

### 8. 常见问题

#### 8.1 `link.exe not found`

说明没有安装或没有正确加载 MSVC 构建工具。

解决：

- 安装 Visual Studio Build Tools 2022；
- 勾选 C++ 相关工作负载；
- 重新打开终端后重试；
- 先执行 `npm run check:env` 看看 `link.exe` 是否已进入 PATH。

#### 8.2 OpenSSL / Perl 相关错误

当前项目使用：

```toml
ssh2 = { version = "0.9", features = ["vendored-openssl"] }
```

这在 Windows 下通常要求：

- Strawberry Perl
- MSVC 编译工具链

如果报错里出现 `openssl-sys`、`perl`、`nmake`，建议优先执行：

```powershell
npm run check:perl
npm run check:rust
```

#### 8.3 前端包体过大告警

`npm run build` 可能提示 chunk 较大，这通常来自：

- Monaco Editor
- xterm

这不是构建失败，只是体积提示。当前不影响使用。

### 9. 推荐的日常开发顺序

1. 改代码；
2. 执行：

```powershell
npm run check:web
```

3. 再执行：

```powershell
npm run check:rust
```

4. 最后运行：

```powershell
npm run tauri:dev
```

这样可以更快发现前端类型错误、后端编译错误和桌面运行问题。
