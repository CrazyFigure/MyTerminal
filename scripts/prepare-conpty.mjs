// 准备随安装包附带的新版 ConPTY（conpty.dll + OpenConsole.exe）。
//
// portable-pty 会优先加载程序目录下的 conpty.dll，找不到才退回系统 kernel32 内置的旧 ConPTY。
// 系统内置版本会先在 conhost 内部重绘一遍画面再把差异发给终端，TUI（Claude Code、Codex 等）
// 局部刷新时容易残留上一帧字符；新版 ConPTY（Windows Terminal 1.22+）改为直通 VT 输出并按字形簇计宽。
// 文件来自微软官方 NuGet 包，版本与哈希全部固定；已就绪时不联网，保证开发与检查命令无额外耗时。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 与 myterminal-cli sidecar 同放在已被 Git 忽略的 binaries 目录，由 tauri.conf.json 的 resources 打入安装包。
const outputDir = join(repoRoot, 'src-tauri', 'binaries', 'conpty');

const packageVersion = '1.24.261001001';
const packageUrl = `https://api.nuget.org/v3-flatcontainer/microsoft.windows.console.conpty/${packageVersion}/microsoft.windows.console.conpty.${packageVersion}.nupkg`;
const packageSha256 = '4d6aaddc1d2385c9f5897df28f33879f699f8f2783315d5204cf3d8c3616ac5f';

// 只取 x64 产物：应用目标固定为 x86_64-pc-windows-msvc。哈希逐个固定，防止包内容被替换。
const packageFiles = [
  {
    entry: 'runtimes/win-x64/native/conpty.dll',
    output: 'conpty.dll',
    sha256: '5afea6c9480e2c7dfd195376dd10996b0ae25cdc6f014e6247fd8aedc8c34852',
  },
  {
    entry: 'build/native/runtimes/x64/OpenConsole.exe',
    output: 'OpenConsole.exe',
    sha256: '6f8e68dec4e8e5e15a54ecc8afa127b0e62139edc004ffbb4892125ff01d5737',
  },
];

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

// 已存在且哈希一致即视为就绪；任何一个缺失或不一致都重新提取，避免半成品残留。
function isPrepared() {
  return packageFiles.every((file) => {
    const filePath = join(outputDir, file.output);
    return existsSync(filePath) && sha256(readFileSync(filePath)) === file.sha256;
  });
}

// 离线环境可通过 MYTERMINAL_CONPTY_NUPKG 指向本地已下载的 nupkg；否则从 NuGet 下载并重试。
async function loadPackage() {
  const localPackage = process.env.MYTERMINAL_CONPTY_NUPKG;
  if (localPackage) {
    return readFileSync(localPackage);
  }

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(packageUrl, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      console.warn(`[prepare-conpty] 第 ${attempt} 次下载失败：${error.message}`);
    }
  }
  throw lastError;
}

// 最小 ZIP 读取：nupkg 是标准 ZIP（无 ZIP64），按中央目录定位条目，仅支持存储与 deflate 两种压缩方式。
function extractZipEntry(zip, entryName) {
  const endSignature = 0x06054b50;
  let endOffset = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65_557); offset -= 1) {
    if (zip.readUInt32LE(offset) === endSignature) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) {
    throw new Error('nupkg 不是有效的 ZIP 文件');
  }

  const entryCount = zip.readUInt16LE(endOffset + 10);
  let cursor = zip.readUInt32LE(endOffset + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('ZIP 中央目录损坏');
    }
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localHeaderOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name !== entryName) {
      continue;
    }

    // 本地文件头的扩展字段长度可能与中央目录不同，数据起点必须按本地头重新计算。
    const localNameLength = zip.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = zip.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) {
      return Buffer.from(data);
    }
    if (method === 8) {
      return inflateRawSync(data);
    }
    throw new Error(`${entryName} 使用了不支持的压缩方式 ${method}`);
  }
  throw new Error(`nupkg 中缺少 ${entryName}`);
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('[prepare-conpty] 非 Windows 平台，跳过 ConPTY 准备。');
    return;
  }
  if (isPrepared()) {
    console.log(`[prepare-conpty] ConPTY ${packageVersion} 已就绪。`);
    return;
  }

  console.log(`[prepare-conpty] 准备 ConPTY ${packageVersion} ...`);
  const nupkg = await loadPackage();
  const actualPackageSha = sha256(nupkg);
  if (actualPackageSha !== packageSha256) {
    throw new Error(`nupkg 哈希不匹配：期望 ${packageSha256}，实际 ${actualPackageSha}`);
  }

  mkdirSync(outputDir, { recursive: true });
  for (const file of packageFiles) {
    const content = extractZipEntry(nupkg, file.entry);
    const actualSha = sha256(content);
    if (actualSha !== file.sha256) {
      throw new Error(`${file.entry} 哈希不匹配：期望 ${file.sha256}，实际 ${actualSha}`);
    }
    // 先写临时文件再改名，中断时不会留下哈希错误的半截文件。
    const targetPath = join(outputDir, file.output);
    const tempPath = `${targetPath}.tmp`;
    writeFileSync(tempPath, content);
    renameSync(tempPath, targetPath);
  }
  console.log(`[prepare-conpty] 已写入 ${outputDir}`);
}

main().catch((error) => {
  console.error(`[prepare-conpty] 失败：${error.message}`);
  console.error('[prepare-conpty] 可手动下载 nupkg 后设置 MYTERMINAL_CONPTY_NUPKG=<文件路径> 重试。');
  process.exit(1);
});
