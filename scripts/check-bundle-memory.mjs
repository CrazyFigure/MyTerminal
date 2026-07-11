import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根目录是所有构建产物的定位基准，脚本可从任意 npm 生命周期命令中稳定运行。
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(repoRoot, 'dist');
const distIndexPath = join(distDir, 'index.html');
const assetsDir = join(distDir, 'assets');

// Monaco 及其 worker 是首屏最大的一块内存/解析成本，必须只在打开编辑器时才动态加载。
// 首屏 HTML 预加载或入口 chunk 静态 import 一旦命中它们，就说明动态边界被打破。
const forbiddenPatterns = [/monaco/i, /editor\.worker/i, /ts\.worker/i];

function readText(filePath) {
  return readFileSync(filePath, 'utf8');
}

function hitsForbidden(name) {
  return forbiddenPatterns.some((pattern) => pattern.test(name));
}

// 从 index.html 中提取首屏直接引用的脚本（modulepreload 与入口 <script src>）。
function collectFirstScreenRefs(html) {
  const refs = [];
  const linkPattern = /<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"/gi;
  const scriptPattern = /<script\b[^>]*\bsrc="([^"]+)"/gi;

  for (const pattern of [linkPattern, scriptPattern]) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      refs.push(match[1]);
    }
  }

  return refs;
}

// 在入口 chunk 里提取“静态 import”引用的模块名。
// 静态形式：`import"./x.js"`（裸副作用导入）或 `... from"./x.js"`。
// 动态形式 `import("./x.js")` 因为 import 后紧跟 `(`，不会被这里匹配；
// rolldown 的 mapDeps 依赖数组是被 `[`/`,` 包裹的普通字符串，也不会被匹配。
function collectStaticImports(code) {
  const names = [];
  const pattern = /(?:\bfrom|\bimport)\s*["']([^"']+\.js)["']/g;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    names.push(match[1].split('/').pop());
  }
  return names;
}

function main() {
  let html;
  try {
    html = readText(distIndexPath);
  } catch {
    throw new Error(`未找到构建产物 ${distIndexPath}，请先执行 vite build。`);
  }

  const problems = [];

  // 校验点 1：首屏 HTML 直接引用的脚本文件名不得命中 Monaco/worker。
  const firstScreenRefs = collectFirstScreenRefs(html);
  for (const ref of firstScreenRefs) {
    if (hitsForbidden(ref)) {
      problems.push(`index.html 首屏预加载: ${ref}`);
    }
  }

  // 校验点 2：首屏入口 chunk 不得静态 import Monaco 主包/worker。
  const entryFileNames = firstScreenRefs
    .map((ref) => ref.split('/').pop())
    .filter((name) => name && name.endsWith('.js'));

  for (const entry of entryFileNames) {
    let code;
    try {
      code = readText(join(assetsDir, entry));
    } catch {
      continue; // 非 assets 目录脚本无法读取时跳过，只做尽力而为的检查。
    }
    for (const imported of collectStaticImports(code)) {
      if (hitsForbidden(imported)) {
        problems.push(`${entry} 静态 import: ${imported}`);
      }
    }
  }

  if (problems.length > 0) {
    console.error('检测到 Monaco/worker 回到首屏静态加载路径，动态懒加载边界被破坏：');
    for (const problem of [...new Set(problems)]) {
      console.error(`  - ${problem}`);
    }
    console.error('请检查 vite.config.ts 的 manualChunks，确保 Monaco 仅通过动态 import 加载。');
    process.exit(1);
  }

  // 顺带确认 Monaco chunk 确实以独立产物存在（只是不在首屏），避免懒加载彻底失效。
  const monacoAssets = readdirSync(assetsDir).filter((name) => /monaco|editor\.api/i.test(name));
  console.log(
    `Bundle 守卫通过：首屏无 Monaco 静态引用；Monaco 以 ${monacoAssets.length} 个动态 chunk 存在。`,
  );
}

main();
