// 把 vendored OpenSSL 生成的调试符号文件摆到 MSVC 链接器会去找的位置。
//
// 背景：ssh2 启用 vendored-openssl 后，openssl-src 会从源码编译 OpenSSL，而 OpenSSL 的
// Windows 构建配置（Configurations/10-main.conf 中 VC-WIN64A 目标）无条件追加
// "/Zi /Fdossl_static.pdb"，因此 libcrypto/libssl 里的每个 .obj 都声明自己的调试信息来自
// ossl_static.pdb。dev 档位的最终链接会带 /DEBUG，link.exe 只在「目标文件所在目录」和
// 「链接 PDB 输出目录」两处查找该文件——两处都没有，就会对每个 .obj 报一条 LNK4099。
//
// 本脚本把 openssl-src 真正产出的 PDB 同步到 target/<profile>/deps/：既消除刷屏警告，
// 也顺带让 OpenSSL 内部恢复可用的调试符号。优先硬链接（同卷、零额外占用），失败再复制。

import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PDB_NAME = 'ossl_static.pdb';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = join(repoRoot, 'src-tauri', 'target');

// LNK4099 是 MSVC 链接器特有行为，其它平台不会触发，直接跳过以免做无用功。
if (process.platform !== 'win32') {
  console.log('[sync-ossl-pdb] 非 Windows 平台，无需同步 OpenSSL 调试符号。');
  process.exit(0);
}

// 收集某个 profile 下所有 openssl-sys 构建产物中的 PDB。
// 同一 profile 可能存在多个哈希目录（依赖特征或 openssl-src 版本变化时会新增），
// 需要全部收集后按修改时间取最新的一份，才能对上本次实际参与链接的静态库。
function collectCandidates(profileDir) {
  const buildDir = join(profileDir, 'build');
  if (!existsSync(buildDir)) {
    return [];
  }

  const candidates = [];
  for (const entry of readdirSync(buildDir)) {
    if (!entry.startsWith('openssl-sys-')) {
      continue;
    }
    const pdbPath = join(buildDir, entry, 'out', 'openssl-build', 'install', 'lib', PDB_NAME);
    if (existsSync(pdbPath)) {
      candidates.push({ path: pdbPath, stat: statSync(pdbPath) });
    }
  }
  return candidates;
}

// 同步单个 profile：必要时覆盖目标文件，并在没有任何 OpenSSL 产物时清理残留。
// 残留必须清掉：签名不匹配的 PDB 会让链接器改报 LNK4204，比 LNK4099 更吵。
function syncProfile(profileName, profileDir) {
  const destPath = join(profileDir, 'deps', PDB_NAME);
  const candidates = collectCandidates(profileDir);

  if (candidates.length === 0) {
    if (existsSync(destPath)) {
      rmSync(destPath, { force: true });
      return `${profileName}: 已移除过期副本（当前没有 OpenSSL 构建产物）`;
    }
    return null;
  }

  const source = candidates.reduce((newest, current) =>
    current.stat.mtimeMs > newest.stat.mtimeMs ? current : newest,
  );

  // 目标已是最新（硬链接共享 inode 时两者修改时间天然一致）则不做任何事。
  if (existsSync(destPath)) {
    const destStat = statSync(destPath);
    if (destStat.size === source.stat.size && destStat.mtimeMs === source.stat.mtimeMs) {
      return `${profileName}: 已是最新（${formatMb(destStat.size)}）`;
    }
  }

  mkdirSync(dirname(destPath), { recursive: true });
  rmSync(destPath, { force: true });

  // 硬链接优先：target 目录同卷，且源文件被重写时目标会自动跟随，无需再次同步。
  try {
    linkSync(source.path, destPath);
    return `${profileName}: 已同步 ${formatMb(source.stat.size)}（硬链接）`;
  } catch {
    copyFileSync(source.path, destPath);
    return `${profileName}: 已同步 ${formatMb(source.stat.size)}（复制）`;
  }
}

function formatMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function main() {
  if (!existsSync(targetDir)) {
    console.log('[sync-ossl-pdb] 尚未产生任何构建产物，跳过。');
    return;
  }

  // profile 目录名沿用 cargo 的约定（debug / release 以及自定义档位），只处理含 build 的目录。
  const profiles = readdirSync(targetDir).filter((entry) =>
    existsSync(join(targetDir, entry, 'build')),
  );

  const messages = [];
  for (const profile of profiles) {
    try {
      const message = syncProfile(profile, join(targetDir, profile));
      if (message) {
        messages.push(message);
      }
    } catch (error) {
      // 同步失败只会让警告继续出现，不应阻断开发流程，因此只提示不报错。
      messages.push(`${profile}: 同步失败（不影响构建）— ${error.message}`);
    }
  }

  if (messages.length === 0) {
    console.log('[sync-ossl-pdb] 未发现 OpenSSL 构建产物，首次编译仍会出现 LNK4099，编译完成后重跑一次即可。');
    return;
  }

  for (const message of messages) {
    console.log(`[sync-ossl-pdb] ${message}`);
  }
}

main();
