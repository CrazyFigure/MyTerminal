import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根目录是所有版本文件的定位基准，脚本可从任意 npm 生命周期命令中稳定运行。
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// package.json 是应用版本唯一需要人工修改的来源。
const packageJsonPath = join(repoRoot, 'package.json');
// Tauri 配置文件位于 src-tauri 下，version 字段使用相对路径指向根 package.json。
const tauriConfigPath = join(repoRoot, 'src-tauri', 'tauri.conf.json');
// Cargo.toml 仍需保存 crate 版本，供 env!("CARGO_PKG_VERSION") 和 Rust CLI 元数据使用。
const cargoTomlPath = join(repoRoot, 'src-tauri', 'Cargo.toml');
// Cargo.lock 固定本地 crate 版本，避免锁文件在发布构建时才被 Cargo 改动。
const cargoLockPath = join(repoRoot, 'src-tauri', 'Cargo.lock');
// package-lock.json 记录根包版本，保持 npm 元数据和 package.json 一致。
const packageLockPath = join(repoRoot, 'package-lock.json');
// MCP 适配包不单独发布，版本跟随主应用统一维护。
const mcpPackageJsonPath = join(repoRoot, 'mcp', 'myterminal-mcp', 'package.json');
// Tauri 2 支持 version 字段指向包含 version 字段的 package.json；路径相对 tauri.conf.json。
const tauriPackageVersionPath = '../package.json';
// 发布版本必须保持 SemVer 三段格式，避免 Tauri、npm 和更新检查逻辑产生不同解析结果。
const semverPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function readText(filePath) {
  return readFileSync(filePath, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function writeTextIfChanged(filePath, nextText) {
  const currentText = readText(filePath);

  // 文件内容未变化时不写入，避免无意义刷新时间戳和触发额外构建。
  if (currentText === nextText) {
    return false;
  }

  writeFileSync(filePath, nextText, 'utf8');
  return true;
}

function replaceOnce(filePath, pattern, replacement, description) {
  const currentText = readText(filePath);
  const nextText = currentText.replace(pattern, replacement);

  // 未匹配到目标结构说明文件格式变化，立即失败，避免静默留下不一致版本。
  if (nextText === currentText && !pattern.test(currentText)) {
    throw new Error(`Unable to update ${description} in ${filePath}`);
  }

  return writeTextIfChanged(filePath, nextText);
}

function syncCargoToml(appVersion) {
  // 只更新 [package] 区块里的版本，依赖版本不属于应用发布版本，不能被批量替换。
  return replaceOnce(
    cargoTomlPath,
    /(\[package\][\s\S]*?\nversion = ")[^"]+(")/,
    `$1${appVersion}$2`,
    'Cargo.toml package version',
  );
}

function syncCargoLock(appVersion) {
  // Cargo.lock 里只同步当前 crate 的 package 块，避免误改同名依赖或第三方依赖版本。
  return replaceOnce(
    cargoLockPath,
    /(\[\[package\]\]\r?\nname = "myterminal"\r?\nversion = ")[^"]+(")/,
    `$1${appVersion}$2`,
    'Cargo.lock myterminal version',
  );
}

function syncTauriConfig() {
  const tauriConfig = readJson(tauriConfigPath);
  const resolvedVersionPath = resolve(dirname(tauriConfigPath), tauriPackageVersionPath);

  // 先验证 Tauri 指向的 package.json 确实存在，再做最小文本替换。
  if (!existsSync(resolvedVersionPath)) {
    throw new Error(`Tauri version source does not exist: ${resolvedVersionPath}`);
  }

  // version 字段固定为 package.json 路径，发布版本只在根 package.json 中维护。
  if (tauriConfig.version === tauriPackageVersionPath) {
    return false;
  }

  return replaceOnce(
    tauriConfigPath,
    /("version":\s*")[^"]+(")/,
    `$1${tauriPackageVersionPath}$2`,
    'Tauri package.json version path',
  );
}

function syncPackageLock(appVersion) {
  const packageJson = readJson(packageJsonPath);
  const packageLock = readJson(packageLockPath);
  let nextText = readText(packageLockPath);

  // package-lock 根包必须对应当前应用包名，避免在错误仓库或嵌套包里同步版本。
  if (packageLock.name !== packageJson.name || packageLock.packages?.['']?.name !== packageJson.name) {
    throw new Error('package-lock.json root package does not match package.json.');
  }

  nextText = nextText.replace(
    /("name":\s*"myterminal",\r?\n\s*"version":\s*")[^"]+(")/,
    `$1${appVersion}$2`,
  );
  nextText = nextText.replace(
    /("packages":\s*\{\r?\n\s*"":\s*\{\r?\n\s*"name":\s*"myterminal",\r?\n\s*"version":\s*")[^"]+(")/,
    `$1${appVersion}$2`,
  );

  const nextPackageLock = JSON.parse(nextText);

  // 锁文件有两个根版本字段；任一字段未同步都说明 lockfile 结构变化，需要人工确认。
  if (nextPackageLock.version !== appVersion || nextPackageLock.packages?.['']?.version !== appVersion) {
    throw new Error('Unable to sync package-lock.json root package version.');
  }

  return writeTextIfChanged(packageLockPath, nextText);
}

function syncMcpPackageJson(appVersion) {
  const mcpPackageJson = readJson(mcpPackageJsonPath);

  // MCP 包随主程序一起发布；包名不匹配时说明路径或目录职责变化，需要人工确认。
  if (mcpPackageJson.name !== 'myterminal-mcp') {
    throw new Error('mcp/myterminal-mcp/package.json package name does not match myterminal-mcp.');
  }

  return replaceOnce(
    mcpPackageJsonPath,
    /("version":\s*")[^"]+(")/,
    `$1${appVersion}$2`,
    'myterminal-mcp package version',
  );
}

function main() {
  const packageJson = readJson(packageJsonPath);
  const appVersion = packageJson.version;

  // package.json 版本是所有发布元数据的唯一来源，格式不合法时立即阻断后续构建。
  if (typeof appVersion !== 'string' || !semverPattern.test(appVersion)) {
    throw new Error(`Invalid package.json version: ${String(appVersion)}`);
  }

  const changedFiles = [
    syncTauriConfig() && 'src-tauri/tauri.conf.json',
    syncCargoToml(appVersion) && 'src-tauri/Cargo.toml',
    syncCargoLock(appVersion) && 'src-tauri/Cargo.lock',
    syncPackageLock(appVersion) && 'package-lock.json',
    syncMcpPackageJson(appVersion) && 'mcp/myterminal-mcp/package.json',
  ].filter(Boolean);

  // npm 生命周期输出保持简短，只说明是否有文件被同步。
  if (changedFiles.length > 0) {
    console.log(`Synced version ${appVersion}: ${changedFiles.join(', ')}`);
  } else {
    console.log(`Version ${appVersion} is already synced.`);
  }
}

main();
