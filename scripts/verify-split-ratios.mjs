// 分屏比例/分隔条推导的校验：分隔条数量与线段跨度必须与 2/3/4 分屏的几何一致，
// 且最小比例夹取在任何容器尺寸下都不能让两侧之和越界。项目没有前端测试框架，
// 因此按仓库既有做法用 esbuild 把被测模块打包后交给 node 直接跑断言。
//
// 用法：node scripts/verify-split-ratios.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// splitRatios.ts 是 TS 源码，node 不能直接 import；就地打包到临时目录，跑完即删，
// 这样脚本可以独立重跑，不依赖任何遗留的中间产物。
// 用 esbuild 的 Node API 而不是命令行：Windows 下 .bin 里只有 .cmd 包装脚本，
// 不经 shell 的 execFileSync 调它会以 EINVAL 失败。
const workDir = mkdtempSync(join(tmpdir(), 'split-ratios-'));
const bundlePath = join(workDir, 'splitRatios.mjs');
let splitRatios;
try {
  await build({
    entryPoints: ['src/features/terminal/splitRatios.ts'],
    bundle: true,
    format: 'esm',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  splitRatios = await import(pathToFileURL(bundlePath).href);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

const { clampSplitRatio, resolveMinPaneRatio, resolveSplitDividers } = splitRatios;

const TL = 0b0001;
const TR = 0b0010;
const BL = 0b0100;
const BR = 0b1000;
const TOP = TL | TR;
const BOTTOM = BL | BR;
const LEFT = TL | BL;
const RIGHT = TR | BR;
const FULL = TOP | BOTTOM;

const layout = (...masks) => ({
  panes: masks.map((mask, index) => ({ id: `p${index}`, mask, sessionIds: [`s${index}`] })),
});

const describe = (dividers) =>
  dividers.map((d) => (d.axis === 'both' ? 'center' : `${d.id}:${d.span}`)).sort().join(',');

// 单格：没有任何可拖之处。
assert.equal(describe(resolveSplitDividers(layout(FULL))), '');

// 左右二分：一条贯穿竖线。
assert.equal(describe(resolveSplitDividers(layout(LEFT, RIGHT))), 'column:full');

// 上下二分：一条贯穿横线。
assert.equal(describe(resolveSplitDividers(layout(TOP, BOTTOM))), 'row:full');

// 三分格「左上/右上/下半」：竖线只在上半行，横线贯穿。
assert.equal(
  describe(resolveSplitDividers(layout(TL, TR, BOTTOM))),
  'column:first,row:full',
);

// 三分格「上半/左下/右下」：竖线只在下半行。
assert.equal(
  describe(resolveSplitDividers(layout(TOP, BL, BR))),
  'column:second,row:full',
);

// 三分格「左半/右上/右下」：横线只在右半列。
assert.equal(
  describe(resolveSplitDividers(layout(LEFT, TR, BR))),
  'column:full,row:second',
);

// 三分格「左上/左下/右半」：横线只在左半列。
assert.equal(
  describe(resolveSplitDividers(layout(TL, BL, RIGHT))),
  'column:full,row:first',
);

// 四分格：两条贯穿线 + 中心手柄。
assert.equal(
  describe(resolveSplitDividers(layout(TL, TR, BL, BR))),
  'center,column:full,row:full',
);

// 四分格关掉一格后保留的空位仍是独立格子，几何不变，因此分隔条与四分格一致。
const withEmpty = {
  panes: [
    { id: 'a', mask: TL, sessionIds: ['s0'] },
    { id: 'b', mask: TR, sessionIds: [] },
    { id: 'c', mask: BL, sessionIds: ['s1'] },
    { id: 'd', mask: BR, sessionIds: ['s2'] },
  ],
};
assert.equal(describe(resolveSplitDividers(withEmpty)), 'center,column:full,row:full');

// 最小比例：任何容器尺寸下，夹取结果都必须给两侧各留下不少于最小值的空间。
for (const size of [0, 1, 80, 200, 400, 900, 1600, 3840, Number.NaN, Number.POSITIVE_INFINITY]) {
  const min = resolveMinPaneRatio(size);
  assert.ok(min > 0 && min <= 0.45, `最小比例越界: size=${size} min=${min}`);
  for (const raw of [-5, -0.2, 0, 0.01, 0.3, 0.5, 0.7, 0.999, 1, 4, Number.NaN]) {
    const clamped = clampSplitRatio(raw, size);
    assert.ok(
      clamped >= min - 1e-9 && clamped <= 1 - min + 1e-9,
      `夹取越界: size=${size} raw=${raw} -> ${clamped} (min=${min})`,
    );
    // 两侧都必须是正的可视宽度，绝不能出现一条缝。
    assert.ok(clamped > 0 && clamped < 1, `比例退化: size=${size} raw=${raw} -> ${clamped}`);
  }
}

// 窄容器下像素下限比比例下限更严格，必须生效（140px / 400px = 0.35）。
assert.ok(Math.abs(resolveMinPaneRatio(400) - 0.35) < 1e-9);
// 宽容器下回落到比例下限 0.15。
assert.equal(resolveMinPaneRatio(2000), 0.15);
// 极窄容器不能让下限越过 0.45，否则可调区间首尾颠倒。
assert.equal(resolveMinPaneRatio(100), 0.45);

console.log('分屏比例校验通过');
