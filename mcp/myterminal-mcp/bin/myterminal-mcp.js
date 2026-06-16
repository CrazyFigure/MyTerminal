#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const launcherFile = realpathSync(fileURLToPath(import.meta.url));
const packageDir = dirname(dirname(launcherFile));
const repoRoot = resolve(packageDir, '..', '..');
const cargoManifest = resolve(repoRoot, 'src-tauri', 'Cargo.toml');
const executableName = process.platform === 'win32' ? 'myterminal-cli.exe' : 'myterminal-cli';

// MCP 客户端只看到 npx；启动器优先直连已构建 CLI，避免在 stdio 握手期间执行 cargo run 导致 Claude 一直等待。
const cliCandidates = [
  process.env.MYTERMINAL_CLI,
  resolve(repoRoot, 'src-tauri', 'target', 'release', executableName),
  resolve(repoRoot, 'src-tauri', 'target', 'debug', executableName),
].filter(Boolean);

const cliPath = cliCandidates.find((candidate) => existsSync(candidate));
const allowCargoFallback = process.env.MYTERMINAL_MCP_ALLOW_CARGO === '1' && existsSync(cargoManifest);
const command = cliPath ?? (allowCargoFallback ? 'cargo' : undefined);
const args = cliPath
  ? ['mcp', '--stdio']
  : ['run', '--manifest-path', cargoManifest, '--bin', 'myterminal-cli', '--', 'mcp', '--stdio'];

const traceLauncher = (event) => {
  if (!process.env.MYTERMINAL_MCP_TRACE) {
    return;
  }

  // trace 只记录启动状态和进程信息，不写 MCP 参数正文，避免泄露命令或连接敏感信息。
  appendFileSync(
    process.env.MYTERMINAL_MCP_TRACE,
    `${JSON.stringify({
      source: 'launcher',
      time: new Date().toISOString(),
      ...event,
    })}\n`,
  );
};

if (!command) {
  console.error(
    'myterminal-mcp could not find myterminal-cli. Build it with `cargo build --bin myterminal-cli`, or set MYTERMINAL_CLI to the executable path.',
  );
  process.exit(1);
}

traceLauncher({ event: 'start', command, hasCliPath: Boolean(cliPath) });

// MCP stdio 必须显式转发给 Rust server；Windows 下 inherit 经过 Claude -> npx -> npm shim 多层进程时可能拿不到真实管道。
const child = spawn(command, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

process.stdin.on('end', () => {
  child.stdin.end();
});

child.on('exit', (code, signal) => {
  traceLauncher({ event: 'exit', code, signal });
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on('error', (error) => {
  traceLauncher({ event: 'error', message: error.message });
  console.error(error.message);
  process.exit(1);
});

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
