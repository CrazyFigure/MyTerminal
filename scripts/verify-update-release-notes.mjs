// 验证发布脚本和历史 Release 的摘要解析，防止嵌套说明、代码示例或空分组被误计为改动。
// 用法：node scripts/verify-update-release-notes.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// 复用现有脚本的临时打包方式，不增加测试依赖，也不在仓库留下生成文件。
const workDir = mkdtempSync(join(tmpdir(), 'update-release-notes-'));
const bundlePath = join(workDir, 'releaseNotes.mjs');
let parseReleaseNotes;
try {
  await build({
    entryPoints: ['src/features/updates/releaseNotes.ts'],
    bundle: true,
    format: 'esm',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  ({ parseReleaseNotes } = await import(pathToFileURL(bundlePath).href));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

// 当前发布脚本使用中文冒号标题；占位文案仍需显示，但不能生成“新增 1”的误导摘要。
const generated = parseReleaseNotes('新增：\r\n- 本次暂无新增项。\r\n\r\n修复：\r\n- 修复连接\r\n  - 补充细节\r\n- 修复标签\r\n\r\n优化：\r\n- 优化滚动');
assert.deepEqual(generated.map(({ kind, count }) => [kind, count]), [
  ['added', 0], ['fixed', 2], ['improved', 1],
]);
assert.match(generated[0].source, /本次暂无新增项/);
assert.match(generated[1].source, /  - 补充细节/);

// 历史日志兼容 Markdown、加粗标题和有序列表，无分组正文原样保留。
const legacy = parseReleaseNotes('前言\n\n## Added\n1. 新建\n2. 导入\n\n**Fixed**\n- 修复\n\n### Performance\n- 提速');
assert.equal(legacy[0].title, null);
assert.equal(legacy[0].source, '前言');
assert.deepEqual(legacy.slice(1).map(({ kind, count }) => [kind, count]), [
  ['added', 2], ['fixed', 1], ['improved', 1],
]);

// 围栏内的伪标题和列表不参与分类；代码、链接和表格保留给通用 Markdown 渲染器。
const codeBody = '```md\n## 修复\n- 示例\n```\n\n- [真正的新增](https://example.com)\n\n| 列 | 值 |\n| --- | --- |\n| a | b |';
const code = parseReleaseNotes(`新增：\n${codeBody}`);
assert.equal(code.length, 1);
assert.equal(code[0].count, 1);
assert.equal(code[0].source, codeBody);
const tilde = parseReleaseNotes('修复：\n~~~~md\n### 新增\n~~~\n- 仍是代码\n~~~~\n- 真正的修复');
assert.equal(tilde.length, 1);
assert.equal(tilde[0].count, 1);

// 空日志和纯标题不生成虚假条目；无列表小节仍能展示和统计段落说明。
assert.deepEqual(parseReleaseNotes(' \n\t'), []);
assert.equal(parseReleaseNotes('新增：')[0].count, 0);
assert.equal(parseReleaseNotes('优化：\n减少连接等待时间。')[0].count, 1);

console.log('更新日志验证通过：发布脚本格式、历史标题、嵌套条目、代码围栏及空日志。');
