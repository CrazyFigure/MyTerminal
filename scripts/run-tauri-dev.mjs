// MyTerminal 开发命令入口：为 Tauri 与 Vite 分配同一个空闲端口，并保持开发版应用标识隔离。

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tauriCliPath = resolve(repoRoot, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const devConfigPath = resolve(repoRoot, 'src-tauri', 'tauri.dev.conf.json');
// 端口缓存属于本机构建状态，放在已被 Git 与 Vite 监听忽略的 target 目录。
const devPortCachePath = resolve(repoRoot, 'src-tauri', 'target', '.myterminal-dev-port');

// 按 Vite 的监听地址探测上次端口；传入 0 时让系统分配空闲端口，关闭监听后交给 Vite。
function allocateDevPort(preferredPort = 0) {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '0.0.0.0', port: preferredPort, exclusive: true }, () => {
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

// 缓存只接受完整的有效 TCP 端口；首次启动、清理 target 或缓存损坏时重新分配。
function readCachedDevPort() {
  try {
    const cachedValue = readFileSync(devPortCachePath, 'utf8').trim();
    const cachedPort = Number(cachedValue);
    if (/^\d+$/.test(cachedValue) && Number.isInteger(cachedPort) && cachedPort > 0 && cachedPort <= 65535) {
      return cachedPort;
    }
  } catch (error) {
    // 缓存不是启动前提；文件不存在可直接忽略，其余读取错误提示后继续启动。
    if (error.code !== 'ENOENT') {
      console.warn(`[run-tauri-dev] 无法读取开发端口缓存：${error.message}`);
    }
  }
  return undefined;
}

// 空闲时复用缓存，避免 devUrl 改变导致 TAURI_CONFIG 使 Rust 构建缓存失效。
async function selectDevPort() {
  const cachedPort = readCachedDevPort();
  if (cachedPort !== undefined) {
    try {
      return await allocateDevPort(cachedPort);
    } catch (error) {
      // 占用或系统保留的端口不可复用；其它网络错误直接上报，避免掩盖启动故障。
      if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') {
        throw error;
      }
      console.log(`[run-tauri-dev] 上次开发端口 ${cachedPort} 不可用，重新分配`);
    }
  }

  const allocatedPort = await allocateDevPort();
  try {
    // 只在端口重新分配后写入，正常复用时不改动缓存文件。
    mkdirSync(dirname(devPortCachePath), { recursive: true });
    writeFileSync(devPortCachePath, `${allocatedPort}\n`, 'utf8');
  } catch (error) {
    // 缓存写入失败不阻止本次启动，但下次启动可能需要再次分配端口。
    console.warn(`[run-tauri-dev] 无法保存开发端口缓存：${error.message}`);
  }
  return allocatedPort;
}

const devPort = await selectDevPort();
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

console.log(`[run-tauri-dev] MyTerminal 开发服务使用端口 ${devPort}（空闲时复用）`);

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
