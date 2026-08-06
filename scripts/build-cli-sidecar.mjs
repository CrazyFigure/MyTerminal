import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根目录作为定位基准，脚本可从任意 npm 生命周期命令稳定运行。
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcTauriDir = join(repoRoot, 'src-tauri');
// Tauri externalBin 约定：sidecar 二进制放在此目录，文件名带 host target triple 后缀。
const binariesDir = join(srcTauriDir, 'binaries');

// CLI 构建指纹保存在 Cargo target 内，不污染源码和发布包；内容覆盖工具链、清单、锁文件与全部 Rust 源码。
const sidecarFingerprintPath = join(srcTauriDir, 'target', 'release', '.myterminal-cli-build.json');

// 递归收集 Rust 源码并稳定排序，确保相同输入在不同文件系统枚举顺序下仍产生相同指纹。
function collectRustSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        return collectRustSourceFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith('.rs') ? [entryPath] : [];
    })
    .sort((left, right) => left.localeCompare(right));
}

// Cargo 的 CLI 输入不包含 target/binaries 产物；显式列出后可避免 sidecar 自身时间戳反过来触发下一次重编译。
function getSidecarInputFiles() {
  return [
    join(srcTauriDir, 'Cargo.toml'),
    join(srcTauriDir, 'Cargo.lock'),
    join(srcTauriDir, 'build.rs'),
    ...collectRustSourceFiles(join(srcTauriDir, 'src')),
  ];
}

// 构建指纹同时纳入 rustc 版本，升级工具链后必须重新生成二进制，不能误复用旧编译产物。
function buildSidecarFingerprint(rustcVersion, inputFiles) {
  const hash = createHash('sha256');
  hash.update(rustcVersion);
  for (const inputFile of inputFiles) {
    hash.update(relative(srcTauriDir, inputFile));
    hash.update('\0');
    hash.update(readFileSync(inputFile));
    hash.update('\0');
  }
  return hash.digest('hex');
}

// 首次引入指纹缓存时允许接管已经由当前源码生成的新产物，避免无意义地再做一次完整 release 编译。
function isBuiltArtifactFresh(builtPath, inputFiles) {
  if (!existsSync(builtPath) || statSync(builtPath).size === 0) {
    return false;
  }
  const builtAt = statSync(builtPath).mtimeMs;
  return inputFiles.every((inputFile) => statSync(inputFile).mtimeMs <= builtAt);
}

function loadStoredFingerprint() {
  if (!existsSync(sidecarFingerprintPath)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(sidecarFingerprintPath, 'utf8')).fingerprint;
  } catch {
    // 指纹文件损坏时退回 Cargo 重建，不让缓存异常阻断开发启动。
    return undefined;
  }
}

// Windows 上即使内容相同，重复 copy 也会刷新 externalBin 时间戳并使 Tauri 主程序重新链接。
function copyFileIfChanged(sourcePath, targetPath) {
  const isSameFile = existsSync(targetPath)
    && statSync(sourcePath).size === statSync(targetPath).size
    && readFileSync(sourcePath).equals(readFileSync(targetPath));
  if (isSameFile) {
    return false;
  }
  copyFileSync(sourcePath, targetPath);
  return true;
}

// Windows 不允许覆盖正在运行的 exe。开发态 Codex MCP 可能仍占用 target/debug 下由 Tauri 复制的 sidecar，
// 因此只在显式 --stop-locked-dev-mcp 模式下，按绝对路径和 mcp --stdio 参数精确停止该旧进程。
function stopLockedDevMcpSidecar() {
  if (process.platform !== 'win32') {
    return;
  }

  const debugCliPath = join(srcTauriDir, 'target', 'debug', 'myterminal-cli.exe');
  if (!existsSync(debugCliPath)) {
    return;
  }

  const powerShellScript = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$targetPath = [System.IO.Path]::GetFullPath($env:MYTERMINAL_LOCKED_DEV_CLI)
$lockedProcesses = @(
  Get-CimInstance -ClassName Win32_Process -Filter "Name = 'myterminal-cli.exe'" |
    Where-Object {
      $_.ExecutablePath -and
      ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $targetPath) -and
      ($_.CommandLine -match '\\smcp\\s+--stdio(?:\\s|$)')
    }
)
foreach ($lockedProcess in $lockedProcesses) {
  Stop-Process -Id $lockedProcess.ProcessId -Force -ErrorAction Stop
  Wait-Process -Id $lockedProcess.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
}
if ($lockedProcesses.Count -gt 0) {
  $processIds = ($lockedProcesses | ForEach-Object { $_.ProcessId }) -join ', '
  Write-Output "Stopped locked dev MCP sidecar process(es): $processIds"
}
`;
  const output = execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', powerShellScript],
    {
      encoding: 'utf8',
      env: { ...process.env, MYTERMINAL_LOCKED_DEV_CLI: debugCliPath },
    },
  ).trim();
  if (output) {
    console.log(output);
  }
}

function main() {
  if (process.argv.includes('--stop-locked-dev-mcp')) {
    stopLockedDevMcpSidecar();
  }
  // 一次 rustc 查询同时提供工具链指纹与 host triple，避免为同一启动步骤重复创建子进程。
  const rustcVersion = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const tripleMatch = rustcVersion.match(/^host:\s*(.+)$/m);
  if (!tripleMatch) {
    throw new Error('无法从 rustc -vV 输出解析 host target triple。');
  }
  const triple = tripleMatch[1].trim();
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

  const builtPath = join(srcTauriDir, 'target', 'release', `myterminal-cli${exeSuffix}`);
  const inputFiles = getSidecarInputFiles();
  const fingerprint = buildSidecarFingerprint(rustcVersion, inputFiles);
  const storedFingerprint = loadStoredFingerprint();
  const hasReusableArtifact = existsSync(builtPath) && statSync(builtPath).size > 0;
  // 显式 --force、产物丢失或输入指纹变化都必须交回 Cargo；首次接管只复用时间上确认较新的已有产物。
  const canReuseArtifact = !process.argv.includes('--force')
    && hasReusableArtifact
    && (storedFingerprint === fingerprint
      || (storedFingerprint === undefined && isBuiltArtifactFresh(builtPath, inputFiles)));

  if (canReuseArtifact) {
    console.log(`myterminal-cli is up to date for ${triple}; skipping Cargo release build.`);
  } else {
    // 只有工具链或 Rust 输入真正变化时才做 release 编译；Cargo.toml default-run=myterminal，需显式指定 --bin。
    console.log(`Building myterminal-cli (release) for ${triple}...`);
    execFileSync(
      'cargo',
      ['build', '--release', '--bin', 'myterminal-cli', '--manifest-path', join(srcTauriDir, 'Cargo.toml')],
      { stdio: 'inherit' },
    );
  }

  if (!existsSync(builtPath)) {
    throw new Error(`CLI 构建产物不存在：${builtPath}`);
  }

  // 仅在内容变化时覆盖 externalBin，避免每次开发启动都让 Tauri 主程序误判为需要重新链接。
  const copied = copyFileIfChanged(builtPath, sidecarPath);
  mkdirSync(dirname(sidecarFingerprintPath), { recursive: true });
  writeFileSync(sidecarFingerprintPath, `${JSON.stringify({ fingerprint }, null, 2)}\n`, 'utf8');
  console.log(`${copied ? 'Sidecar updated' : 'Sidecar already current'}: ${sidecarPath}`);
}

main();
