import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根目录作为定位基准，脚本可从任意 npm 生命周期命令稳定运行。
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcTauriDir = join(repoRoot, 'src-tauri');
// Tauri externalBin 约定：sidecar 二进制放在此目录，文件名带 host target triple 后缀。
const binariesDir = join(srcTauriDir, 'binaries');

// 通过 rustc -vV 动态探测 host target triple，绝不写死平台，保证跨机器/跨平台构建正确。
function detectHostTriple() {
  const output = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const match = output.match(/^host:\s*(.+)$/m);
  if (!match) {
    throw new Error('无法从 rustc -vV 输出解析 host target triple。');
  }
  return match[1].trim();
}

function main() {
  const triple = detectHostTriple();
  const isWindows = process.platform === 'win32';
  const exeSuffix = isWindows ? '.exe' : '';

  // Tauri externalBin 在编译期 build script 里就校验 sidecar 文件必须存在，
  // 而生成 sidecar 又依赖 cargo build（会触发同一 build script），形成循环依赖。
  // 先写占位文件让 build script 通过，构建成功后再用真实二进制覆盖，打破死锁。
  mkdirSync(binariesDir, { recursive: true });
  const sidecarPath = join(binariesDir, `myterminal-cli-${triple}${exeSuffix}`);
  if (!existsSync(sidecarPath)) {
    writeFileSync(sidecarPath, '');
  }

  // 先以 release 模式单独构建 CLI 二进制；Cargo.toml default-run=myterminal，需显式指定 --bin。
  console.log(`Building myterminal-cli (release) for ${triple}...`);
  execFileSync(
    'cargo',
    ['build', '--release', '--bin', 'myterminal-cli', '--manifest-path', join(srcTauriDir, 'Cargo.toml')],
    { stdio: 'inherit' },
  );

  const builtPath = join(srcTauriDir, 'target', 'release', `myterminal-cli${exeSuffix}`);
  if (!existsSync(builtPath)) {
    throw new Error(`CLI 构建产物不存在：${builtPath}`);
  }

  // 用真实构建产物覆盖占位文件，Tauri 打包时按 <name>-<triple><ext> 查找 sidecar。
  copyFileSync(builtPath, sidecarPath);
  console.log(`Sidecar ready: ${sidecarPath}`);
}

main();
