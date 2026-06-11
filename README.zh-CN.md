# MyTerminal 中文说明

本文件是 `README.md` 的中文快速说明版，适合中文阅读场景。

当前版本：`v0.1.4`

完整启动与打包说明请查看：

```text
START_BUILD.md
```

## 当前核心能力

- SSH 连接管理
- SSH 密码认证与私钥认证
- 连接表单测试连接
- 密码 / 私钥口令明文查看
- 多终端会话标签页、右键菜单、拖拽排序与原位重连
- SFTP 文件管理
- 终端 `cd` 后自动联动文件管理路径
- 内置编辑器
- SSH 隧道
- WebDAV 手动同步
- 本地配置导出 / 导入覆盖
- 终端背景图片本地 / 网络设置、透明度与适配方式
- GitHub Release 更新检测、下载并启动安装
- 连接分组新增、编辑、删除、拖拽排序与连接复制
- 简体中文 / English 切换

## 最常用命令

```powershell
npm install
npm run check:env
npm run check
npm run tauri:dev
npm run package
```

如果你只想分别检查：

```powershell
npm run typecheck
npm run check:web
npm run check:perl
npm run check:rust
```

## 补充说明

- 当前已经支持 SSH 私钥认证
- 当前尚未实现 `known_hosts` / 主机指纹信任流程
- Monaco 已改为懒加载，但生产构建仍可能出现较大的 chunk 提示

更详细信息请优先阅读项目根目录的 `README.md` 与 `START_BUILD.md`。
