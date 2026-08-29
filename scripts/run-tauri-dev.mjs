// MyTerminal 开发命令入口：为 Tauri 与 Vite 分配同一个空闲端口，并保持开发版应用标识隔离。

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tauriCliPath = resolve(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const devConfigPath = resolve(repoRoot, 'src-tauri', 'tauri.dev.conf.json');

// 让操作系统从当前可用端口中分配，避免提前维护项目间的固定端口清单。
function allocateDevPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('系统未返回可用的 TCP 端口'));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

const devPort = await allocateDevPort();
const runtimeConfig = JSON.stringify({
  build: { devUrl: `http://127.0.0.1:${devPort}` },
});
// 用户追加的参数放在动态配置之后，仍可按 Tauri 的顺序合并规则显式覆盖默认值。
const cliArgs = [
  'dev',
  '--config',
  devConfigPath,
  '--config',
  runtimeConfig,
  ...process.argv.slice(2),
];
const childEnvironment = {
  ...process.env,
  MYTERMINAL_DEV_PORT: String(devPort),
};

console.log(`[run-tauri-dev] MyTerminal 开发服务使用动态端口 ${devPort}`);

// 直接调用项目锁定版本的 CLI，避免依赖全局 tauri 或 Windows shell 的参数转义行为。
const result = spawnSync(process.execPath, [tauriCliPath, ...cliArgs], {
  cwd: repoRoot,
  env: childEnvironment,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[run-tauri-dev] 无法启动 Tauri CLI：${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
