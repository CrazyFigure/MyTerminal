// 回归文件图标分类，覆盖隐藏配置、大小写、复合扩展名与符号链接优先级。
// 用法：node scripts/verify-file-icons.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// 复用现有轻量回归脚本的打包方式，验证结束后立即清理临时产物。
const workDir = mkdtempSync(join(tmpdir(), 'myterminal-file-icons-'));
const bundlePath = join(workDir, 'presentation.mjs');
let fileLabelAppearance;
let isEditableFile;
try {
  await build({
    entryPoints: ['src/features/files/presentation.tsx'],
    bundle: true,
    format: 'esm',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  ({ fileLabelAppearance, isEditableFile } = await import(pathToFileURL(bundlePath).href));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

const cases = [
  ['README.md', 'document', 'FileText'],
  ['notes.TXT', 'document', 'FileText'],
  ['LICENSE', 'document', 'FileText'],
  ['unknown.constructor', 'document', 'FileText'],
  ['deploy.sh', 'code', 'SquareTerminal'],
  ['.bashrc', 'code', 'SquareTerminal'],
  ['.profile', 'code', 'SquareTerminal'],
  ['.env', 'config', 'Settings2'],
  ['.env.production', 'config', 'Settings2'],
  ['.ENV.local', 'config', 'Settings2'],
  ['Dockerfile', 'config', 'Settings2'],
  ['Dockerfile.production', 'config', 'Settings2'],
  ['Makefile', 'config', 'Settings2'],
  ['.gitignore', 'config', 'Settings2'],
  ['settings.json', 'config', 'Settings2'],
  ['nginx.conf', 'config', 'Settings2'],
  ['report.XLSX', 'sheet', 'FileSpreadsheet'],
  ['records.bitable', 'sheet', 'FileSpreadsheet'],
  ['types.d.ts', 'source', 'FileCodeCorner'],
  ['settings.xml', 'source', 'FileCodeCorner'],
  ['archive.tar.gz', 'archive', 'FileArchive'],
  ['source.ZIP', 'archive', 'FileArchive'],
  ['banner.png', 'image', 'FileImage'],
  ['song.flac', 'image', 'FileHeadphone'],
  ['movie.mp4', 'image', 'FilePlay'],
];
for (const [name, tone, iconName] of cases) {
  const appearance = fileLabelAppearance({ name, path: `/tmp/${name}`, isDir: false, size: 0 });
  assert.equal(appearance.tone, tone, name);
  assert.equal(appearance.icon.displayName, iconName, name);
}

// 目录与链接不能被名称的扩展名重新解释，目录链接仍展示链接图标。
const directory = { name: 'folder.zip', path: '/folder.zip', isDir: true, size: 0 };
assert.equal(fileLabelAppearance(directory).tone, 'folder');
assert.equal(fileLabelAppearance(directory).icon.displayName, 'Folder');
assert.equal(fileLabelAppearance({ ...directory, isSymlink: true }).tone, 'link');
assert.equal(fileLabelAppearance({ ...directory, isDir: false, isSymlink: true }).icon.displayName, 'FileSymlink');

// 分类只影响展示，保留原有打开规则。
assert.equal(isEditableFile('/tmp/archive.zip'), false);
assert.equal(isEditableFile('/tmp/report.xlsx'), false);
assert.equal(isEditableFile('/tmp/notes.md'), true);
assert.equal(isEditableFile('/tmp/script.SH'), true);

console.log(`文件图标回归验证通过，覆盖 ${cases.length} 类名称及目录、链接和打开规则。`);
