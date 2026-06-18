# MyTerminal

[English](./README.md) | [简体中文](./README_CN.md)

![Release](https://img.shields.io/github/v/release/CrazyFigure/MyTerminal?include_prereleases&label=release)
![License](https://img.shields.io/github/license/CrazyFigure/MyTerminal)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111)
![Rust](https://img.shields.io/badge/Rust-stable-000?logo=rust&logoColor=white)

A modern desktop SSH terminal manager built with Rust, Tauri 2, and React.

MyTerminal brings terminal tabs, SSH profiles with jump hosts and proxies, SFTP file management, remote file editing, local port forwarding, and WebDAV backup into one clean desktop app. It is designed for developers and operators who want a lightweight, open, and hackable alternative to heavyweight remote terminal suites.

![MyTerminal preview](img.png)

## What's New in 0.2.0

- **Multi-hop SSH routing** - Configure ordered SSH jump hosts and first-hop SOCKS5 or HTTP CONNECT proxies for direct sessions, file operations, tunnels, and MCP Bridge sessions.
- **Stronger file transfers** - Drag local files or folders into the SFTP browser, upload folders recursively, download multiple selected remote files or folders, and use matching MCP/CLI upload and download tools.
- **Smarter AI approvals** - New pending AI execution requests automatically open the AI execution panel, show the SSH machine and command or target summary, and can raise desktop notifications that jump back to the approval list.
- **Bridge reliability fixes** - Restarting MCP Bridge settings preserves logical AI sessions, app shutdown cleans SSH sessions and CLI backends, and stale waiting requests are handled more predictably.

## Highlights

- **SSH profile manager** - Create, edit, group, duplicate, move, sort, and test SSH connections before opening a session, including jump-host and proxy routing.
- **Password and private-key auth** - Connect with passwords or private keys, including passphrase visibility toggles where needed.
- **Tabbed terminal workspace** - Open multiple PTY sessions, reorder tabs, reconnect in place, and use right-click actions for common session operations.
- **SFTP file browser** - Browse remote directories, drag-drop upload files or folders, batch download selected remote items, delete, rename, read, and write files through real SFTP operations.
- **Remote file editor** - Edit remote files with the built-in Monaco editor, with local cache fallback when saving or loading needs recovery.
- **Path-aware terminal + files** - When the shell changes directory, the file manager can follow the terminal's current remote path.
- **SSH tunnels** - Create, edit, start, and stop local port forwarding rules with custom bind addresses and targets.
- **Manual WebDAV sync** - Upload and download app settings and SSH profiles separately when you want to move between machines.
- **MCP Bridge for AI coding tools** - Let Claude Code, Codex, and other MCP clients list SSH profiles, open bridge sessions, run remote commands, upload/download remote files, and read/write remote files through a local GUI-approved broker.
- **AI approval notifications** - Pending AI execution requests can expand automatically, show compact execution summaries, and use desktop notifications to bring you back to the approval panel.
- **Local import/export** - Export JSON configuration packages and restore them later, with automatic local backups before import.
- **Desktop update flow** - Check GitHub Releases, download installers, and launch the installer from inside the app.
- **Personalized terminal UI** - Switch between Chinese and English, light and dark themes, terminal fonts, compact sidebar, and background images.

## Download

Windows installers are published on the [GitHub Releases](https://github.com/CrazyFigure/MyTerminal/releases) page when a version tag is released.

MyTerminal is still early-stage software. Please keep backups of important SSH profiles and avoid treating local exports as encrypted backups: exported JSON files contain sensitive values in plain text.

## Quick Start

### Requirements

- Node.js 20.19+ or 22.12+
- npm 9+
- Rust stable with the MSVC toolchain
- Visual Studio Build Tools 2022
- Windows 10/11 SDK
- Strawberry Perl on Windows when vendored OpenSSL is required

### Run From Source

```powershell
npm install
npm run check:env
npm run tauri:dev
```

### Build Installer

```powershell
npm run package
```

Build outputs are usually generated under:

```text
src-tauri/target/release/bundle/
```

For the full Windows setup and packaging notes, see [START_BUILD.md](./START_BUILD.md).

## MCP Bridge

MyTerminal can expose your saved SSH connections to Claude Code, Codex, and other MCP clients through a local `CLI + MCP + GUI Broker` bridge.

### How it works

- The bridge is disabled by default. Enable it in **Settings > MCP**.
- MyTerminal starts a local Broker bound to `127.0.0.1` and writes a discovery file with the current port and token.
- MCP clients start the local package with `npx`; the package launches `myterminal-cli mcp --stdio`.
- Read-only tools, such as listing connections and reading remote files, can run directly.
- Command execution, local uploads, remote downloads, and write operations are shown in the MyTerminal AI request panel for approval by default.
- New pending approval requests can automatically open the AI execution panel and send a desktop notification; clicking the notification focuses the approval list.
- Auto-execution can be enabled globally, or allowed for selected SSH connections from the MCP settings page.

### MCP client config

Copy the JSON from **Settings > MCP > Usage**. In development it looks like this:

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

### Available MCP tools

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

The connection list only returns non-secret metadata such as name, group path, host, port, username, tags, and notes. Passwords, private keys, and passphrases are never exposed through MCP.

## Useful Scripts

```powershell
npm run dev          # Start the Vite web dev server only
npm run typecheck    # Run frontend TypeScript checks
npm run check:web    # Build the frontend
npm run check:rust   # Check the Rust/Tauri backend
npm run check:perl   # Check the local Perl environment
npm run check:env    # Check Node, npm, cargo, Perl, and link.exe
npm run check        # Run frontend build and Rust backend checks
```

## Tech Stack

- **Desktop shell:** Tauri 2
- **Backend:** Rust, ssh2, reqwest, AES-GCM, local JSON persistence
- **Frontend:** React, TypeScript, Vite, Zustand
- **Terminal and editor:** xterm.js, Monaco Editor
- **Sync and files:** SFTP, WebDAV, local import/export

## Current Limitations

- `known_hosts` and host fingerprint trust flows are not implemented yet.
- Large SFTP transfers do not have progress bars or cancel controls yet.
- Tunnel management supports create, edit, start, and stop, but does not yet expose advanced runtime metrics such as active connection counts.
- Monaco is lazy-loaded, but production builds may still show large chunk warnings because xterm.js and Monaco are both substantial dependencies.

## Contributing

Issues, bug reports, and pull requests are welcome. A good contribution usually includes:

- A clear description of the problem or feature.
- Steps to reproduce when reporting a bug.
- Screenshots or logs for UI and connection issues.
- A focused change set that keeps unrelated refactors out of the same pull request.

Before opening a pull request, run the smallest useful checks for your change. For behavior that touches both frontend and backend, `npm run check` is the preferred baseline.

## Acknowledgements

- Community: [Linux.do](https://linux.do)
- Inspired by practical remote terminal workflows found in tools such as FinalShell.

## License

[MIT](./LICENSE) © 2026 CrazyFigure
