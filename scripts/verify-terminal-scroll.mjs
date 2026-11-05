// 终端滚动回归：覆盖远控触摸、过大滚轮增量、TUI 事件分流与控制器销毁。
// 用法：node scripts/verify-terminal-scroll.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// 使用 Node 的事件目标模拟容器，不增加前端测试框架或启动远端连接。
class TestWheelEvent extends Event {
  static DOM_DELTA_PIXEL = 0;
  static DOM_DELTA_LINE = 1;
  static DOM_DELTA_PAGE = 2;

  constructor(type, options = {}) {
    super(type, options);
    const { bubbles, cancelable, ...wheelOptions } = options;
    Object.assign(this, {
      deltaX: 0, deltaY: 0, deltaMode: 0,
      shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
      ...wheelOptions,
    });
  }
}

const workDir = mkdtempSync(join(tmpdir(), 'myterminal-scroll-'));
const previousWindow = globalThis.window;
const previousWheelEvent = globalThis.WheelEvent;
try {
  await build({
    entryPoints: ['src/terminal/attachTerminalScrollController.ts'],
    bundle: true,
    format: 'esm',
    outfile: join(workDir, 'scroll.mjs'),
    logLevel: 'silent',
  });
  const { attachTerminalScrollController } = await import(pathToFileURL(join(workDir, 'scroll.mjs')).href);
  globalThis.window = new EventTarget();
  globalThis.WheelEvent = TestWheelEvent;

  const container = new EventTarget();
  const element = new EventTarget();
  element.querySelector = () => ({
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 400, height: 400 }),
  });
  const scrolledRows = [];
  const reportedWheels = [];
  element.addEventListener('wheel', (event) => reportedWheels.push(event));
  const terminal = {
    element,
    rows: 20,
    options: { fontSize: 14, lineHeight: 1.18 },
    modes: { mouseTrackingMode: 'none' },
    buffer: { active: { type: 'normal' } },
    scrollLines: (rows) => scrolledRows.push(rows),
  };
  let blocked = false;
  const dispose = attachTerminalScrollController({ container, terminal, isInputBlocked: () => blocked });
  const wheel = (options) => {
    const event = new TestWheelEvent('wheel', { cancelable: true, ...options });
    container.dispatchEvent(event);
    return event;
  };
  const touch = (type, y, count = 1, x = 100) => {
    const event = new Event(type, { cancelable: true });
    event.touches = Array.from({ length: count }, (_, index) => ({ clientX: x + index * 20, clientY: y }));
    container.dispatchEvent(event);
    return event;
  };

  // 保留普通滚轮、小幅触控板及横向/加速操作，仅限制异常大的增量。
  assert.equal(wheel({ deltaY: 120 }).defaultPrevented, false);
  assert.equal(wheel({ deltaY: 2 }).defaultPrevented, false);
  assert.equal(wheel({ deltaY: 500, deltaX: 600 }).defaultPrevented, false);
  for (const modifier of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey']) {
    assert.equal(wheel({ deltaY: 1200, [modifier]: true }).defaultPrevented, false);
  }
  assert.equal(wheel({ deltaY: -1200 }).defaultPrevented, true);
  assert.equal(wheel({ deltaY: 30, deltaMode: 1 }).defaultPrevented, true);
  assert.equal(wheel({ deltaY: 1, deltaMode: 2 }).defaultPrevented, true);
  assert.deepEqual(scrolledRows.splice(0), [-3, 3, 3]);

  // 手指向下移动查看更早内容，缓慢滑动累计不足一行的距离。
  touch('touchstart', 200);
  assert.equal(touch('touchmove', 205).defaultPrevented, false);
  assert.equal(touch('touchmove', 210).defaultPrevented, true);
  touch('touchmove', 220);
  touch('touchmove', 260);
  assert.deepEqual(scrolledRows.splice(0), [-1, -2]);
  touch('touchend', 0, 0);
  touch('touchmove', 300);
  assert.deepEqual(scrolledRows, []);

  // 双指同向移动、触点数量改变、取消及失焦都不能导致视口跳动或残留拖动。
  touch('touchstart', 200, 2);
  touch('touchmove', 240, 2);
  assert.deepEqual(scrolledRows.splice(0), [-2]);
  touch('touchmove', 300, 1);
  assert.deepEqual(scrolledRows, []);
  touch('touchmove', 320, 1);
  assert.deepEqual(scrolledRows.splice(0), [-1]);
  touch('touchcancel', 0, 0);
  touch('touchmove', 360);
  assert.deepEqual(scrolledRows, []);
  touch('touchstart', 200);
  window.dispatchEvent(new Event('blur'));
  touch('touchmove', 240);
  assert.deepEqual(scrolledRows, []);
  touch('touchstart', 200);
  assert.equal(touch('touchmove', 205, 1, 180).defaultPrevented, false);

  // 程序开启鼠标上报时，即使仍在主缓冲区，也必须由 xterm 生成协议。
  terminal.modes.mouseTrackingMode = 'vt200';
  assert.equal(wheel({ deltaY: 1200 }).defaultPrevented, false);
  touch('touchstart', 200);
  touch('touchmove', 240);
  assert.equal(reportedWheels.length, 2);
  assert.ok(reportedWheels.every((event) => event.deltaY === -1 && event.deltaMode === 1));
  assert.deepEqual(scrolledRows, []);
  reportedWheels.length = 0;
  terminal.modes.mouseTrackingMode = 'none';
  terminal.buffer.active.type = 'alternate';
  touch('touchstart', 200);
  touch('touchmove', 40);
  assert.equal(reportedWheels.length, 3);
  assert.ok(reportedWheels.every((event) => event.deltaY === 1));
  assert.deepEqual(scrolledRows, []);

  // 回放和隐藏标签期间不接收输入；解除阻断后必须重新开始手势。
  terminal.buffer.active.type = 'normal';
  blocked = true;
  touch('touchstart', 200);
  touch('touchmove', 240);
  assert.equal(wheel({ deltaY: 1200 }).defaultPrevented, false);
  blocked = false;
  touch('touchmove', 280);
  assert.deepEqual(scrolledRows, []);

  dispose();
  touch('touchstart', 200);
  touch('touchmove', 240);
  assert.equal(wheel({ deltaY: 1200 }).defaultPrevented, false);
  assert.deepEqual(scrolledRows, []);
  console.log('终端触摸与远控滚轮回归校验通过。');
} finally {
  globalThis.window = previousWindow;
  globalThis.WheelEvent = previousWheelEvent;
  rmSync(workDir, { recursive: true, force: true });
}
