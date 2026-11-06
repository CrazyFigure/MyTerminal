// 终端字符宽度表校验：xterm 与 TUI（Claude Code 的 string-width、Codex 的 unicode-width、新版 ConPTY）
// 对同一字符的列宽必须一致，否则光标列错位，局部重绘会残留上一帧字符。
// 这里直接驱动 TerminalWorkspace 实际加载的宽度提供者，逐字断言列宽，并输出吞吐供性能对照。
//
// 用法：node scripts/verify-terminal-unicode-width.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { UnicodeGraphemesAddon } = require('@xterm/addon-unicode-graphemes');

// 终端组件必须启用字形簇宽度表；被改回 Unicode 11 时 VS16 / ZWJ emoji 会重新错列。
const workspaceSource = readFileSync(new URL('../src/TerminalWorkspace.tsx', import.meta.url), 'utf8');
assert.match(workspaceSource, /new UnicodeGraphemesAddon\(\)/, 'TerminalWorkspace 未加载 UnicodeGraphemesAddon');
assert.match(workspaceSource, /activeVersion = '15-graphemes'/, 'TerminalWorkspace 未启用 15-graphemes 宽度表');

// 用最小桩对象激活插件，取出 xterm 运行时实际使用的同一个提供者实例。
const providers = {};
new UnicodeGraphemesAddon().activate({
  unicode: {
    register: (provider) => {
      providers[provider.version] = provider;
    },
    activeVersion: '6',
  },
});
const provider = providers['15-graphemes'];
assert.ok(provider, '未注册 15-graphemes 宽度提供者');

// 与 xterm InputHandler.print 相同的累计方式：可合并的字符只把字形簇宽度从旧值补到新值。
function cellWidth(text) {
  let preceding = 0;
  let width = 0;
  for (const char of text) {
    const current = provider.charProperties(char.codePointAt(0), preceding);
    const charWidth = (current >> 1) & 3;
    const shouldJoin = (current & 1) === 1;
    width += shouldJoin ? charWidth - ((preceding >> 1) & 3) : charWidth;
    preceding = current;
  }
  return width;
}

const expectedWidths = [
  // Claude Code 界面高频的 3 字节单宽字符：任何一个算成 2 列都会让整行错位。
  ['⏺', 1],
  ['⎿', 1],
  ['─', 1],
  ['│', 1],
  ['…', 1],
  ['→', 1],
  ['✻', 1],
  ['·', 1],
  // 中文与常规 emoji。
  ['中文', 4],
  ['🤖', 2],
  ['🇨🇳', 2],
  // Unicode 11 表会算错的字形簇：VS16 记 1 列、ZWJ 组合记 4 列。
  ['⚠️', 2],
  ['✔️', 2],
  ['👨‍💻', 2],
  ['👍🏽', 2],
  ['plain ascii', 11],
];
for (const [text, expected] of expectedWidths) {
  assert.equal(cellWidth(text), expected, `${JSON.stringify(text)} 列宽应为 ${expected}`);
}

// 吞吐只做记录与宽松下限：模拟 AI TUI 混合输出，确保宽度计算不会成为渲染瓶颈。
const sample = '⏺ 正在读取文件 src/TerminalWorkspace.tsx … ─────│ ⎿  Read 120 lines ✻ ⚠️ 🤖 const value = 1;\r\n';
const codePoints = Array.from(sample.repeat(20000), (char) => char.codePointAt(0));
let preceding = 0;
const startedAt = process.hrtime.bigint();
for (const codePoint of codePoints) {
  preceding = provider.charProperties(codePoint, preceding);
}
const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
const charsPerSecond = codePoints.length / (elapsedMs / 1000);
assert.ok(charsPerSecond > 5_000_000, `宽度计算吞吐过低：${Math.round(charsPerSecond)} 字符/秒`);

console.log(`终端宽度表校验通过：${expectedWidths.length} 组字符；吞吐约 ${(charsPerSecond / 1e6).toFixed(1)}M 字符/秒。`);
