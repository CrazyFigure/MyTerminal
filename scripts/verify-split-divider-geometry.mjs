// 分隔条 CSS 定位的算术校验：手柄必须正好压在网格轨道的交界线上，
// 三分格里的半长线段必须只覆盖该覆盖的那一半。CSS 里写的是 calc() 百分比，
// 这里用同样的公式复算出像素值，与轨道边界比对。纯算术，不需要浏览器。
import assert from 'node:assert/strict';

// 与 styles.css 中 .terminal-split-grid 的轨道定义一致：
//   grid-template-columns: minmax(0, calc(var(--split-column-ratio) * 100%)) minmax(0, 1fr)
// 即第一列宽 = ratio * 宽度，第二列吃掉剩余。
const trackBoundary = (ratio, size) => ratio * size;

// 与 .split-divider-column 一致：left = ratio*100%，再 translateX(-50%)，宽 11px。
const columnHandleRect = (ratio, width, handleWidth = 11) => {
  const center = ratio * width;
  return { left: center - handleWidth / 2, right: center + handleWidth / 2, center };
};

const rowHandleRect = (ratio, height, handleHeight = 11) => {
  const center = ratio * height;
  return { top: center - handleHeight / 2, bottom: center + handleHeight / 2, center };
};

const W = 1200;
const H = 800;

for (const ratio of [0.15, 0.3, 0.5, 0.62, 0.85]) {
  // 竖线手柄中心必须与列轨道交界重合，否则手柄和它要拖的那条线错位。
  const handle = columnHandleRect(ratio, W);
  assert.equal(handle.center, trackBoundary(ratio, W), `竖线错位 ratio=${ratio}`);
  // 热区应跨在交界两侧，各占一半。
  assert.ok(handle.left < trackBoundary(ratio, W) && handle.right > trackBoundary(ratio, W));

  const rowHandle = rowHandleRect(ratio, H);
  assert.equal(rowHandle.center, trackBoundary(ratio, H), `横线错位 ratio=${ratio}`);
}

// 三分格半长线段。CSS:
//   .split-divider-column[data-span='first']  { bottom: calc((1 - var(--split-row-ratio)) * 100%) }
//   .split-divider-column[data-span='second'] { top:    calc(var(--split-row-ratio) * 100%) }
// 手柄 top/bottom 默认为 0，因此 first 覆盖 [0, rowRatio*H]，second 覆盖 [rowRatio*H, H]。
const columnSpanExtent = (span, rowRatio, height) => {
  if (span === 'full') {
    return { top: 0, bottom: height };
  }
  if (span === 'first') {
    // bottom 距底部 (1-rowRatio)*H，即下边界落在 rowRatio*H。
    return { top: 0, bottom: height - (1 - rowRatio) * height };
  }
  return { top: rowRatio * height, bottom: height };
};

for (const rowRatio of [0.2, 0.5, 0.75]) {
  const boundary = trackBoundary(rowRatio, H);

  const first = columnSpanExtent('first', rowRatio, H);
  assert.equal(first.top, 0);
  // 半长线段必须**正好**停在横线处：短了露缝，长了会伸进下面那个整块格子里，
  // 用户就会在一整块终端中间看到一条拖不动的线。
  assert.ok(Math.abs(first.bottom - boundary) < 1e-9, `first 跨度错误 rowRatio=${rowRatio}`);

  const second = columnSpanExtent('second', rowRatio, H);
  assert.ok(Math.abs(second.top - boundary) < 1e-9, `second 跨度错误 rowRatio=${rowRatio}`);
  assert.equal(second.bottom, H);

  // 两段拼起来必须恰好铺满，且不重叠。
  assert.ok(Math.abs((first.bottom - first.top) + (second.bottom - second.top) - H) < 1e-9);

  const full = columnSpanExtent('full', rowRatio, H);
  assert.equal(full.bottom - full.top, H);
}

// 最小比例下手柄仍完整落在容器内（不会被 overflow:hidden 裁掉一半）。
for (const [ratio, size] of [[0.15, 1200], [0.35, 400], [0.45, 100]]) {
  const handle = columnHandleRect(ratio, size);
  assert.ok(handle.left >= 0, `手柄左侧溢出 ratio=${ratio} size=${size}`);
  assert.ok(handle.right <= size, `手柄右侧溢出 ratio=${ratio} size=${size}`);
}

console.log('分隔条定位算术校验通过');
