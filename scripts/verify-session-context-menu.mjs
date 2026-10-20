// 回归复制标签和拖动排序后的左右关闭范围：以实际菜单回调验证会关闭哪些会话。
// 用法：node scripts/verify-session-context-menu.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// 复用仓库既有的 esbuild 校验方式，不引入测试框架；临时产物在加载后立即清理。
const workDir = mkdtempSync(join(tmpdir(), 'session-context-menu-'));
const bundlePath = join(workDir, 'SessionContextMenu.mjs');
let SessionContextMenu;
try {
  await build({
    entryPoints: ['src/features/sessions/SessionContextMenu.tsx'],
    bundle: true,
    format: 'esm',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  ({ SessionContextMenu } = await import(pathToFileURL(bundlePath).href));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

// 复制 tab1 后，全局列表与屏幕顺序不同；菜单必须跟随 tabSessionIds。
const sessions = ['tab1', 'tab3', 'tab2', 'other-pane'].map((id) => ({ id }));
const verifyMenu = (tabSessionIds, sessionId, expectedLeft, expectedRight) => {
  let closedIds;
  const menu = SessionContextMenu({
    closeSessionBatch: (ids) => { closedIds = ids; },
    copyConnection: () => {},
    duplicateSession: () => {},
    reconnectSession: () => {},
    session: sessions.find((item) => item.id === sessionId),
    sessions,
    tabSessionIds,
    t: (key) => key,
    target: { sessionId, x: 0, y: 0 },
  });
  // 读取实际按钮并触发其回调，断言与菜单文字绑定的关闭范围及禁用状态。
  const buttons = menu.props.children;
  const checkAction = (key, expectedIds, checkDisabled = false) => {
    const button = buttons.find((item) => item.props.children.includes(key));
    assert.ok(button, `missing action: ${key}`);
    if (checkDisabled) {
      assert.equal(button.props.disabled, expectedIds.length === 0, `${sessionId}: ${key} disabled`);
    }
    button.props.onClick();
    assert.deepEqual(closedIds, expectedIds, `${sessionId}: ${key}`);
  };
  checkAction('closeSessionsLeft', expectedLeft, true);
  checkAction('closeSessionsRight', expectedRight, true);
  // 左右范围修复不改变单标签、其他、全部关闭的既有行为。
  checkAction('closeSessionAction', [sessionId]);
  checkAction('closeOtherSessions', sessions.filter((item) => item.id !== sessionId).map((item) => item.id));
  checkAction('closeAllSessions', sessions.map((item) => item.id));
};

// 原始复现场景：tab3 显示在 tab2 右边，关闭 tab2 左侧只关闭 tab1。
verifyMenu(['tab1', 'tab2', 'tab3'], 'tab2', ['tab1'], ['tab3']);
// 拖动重排后仍按显示顺序判断，覆盖首尾标签、单标签及其他分屏隔离。
verifyMenu(['tab3', 'tab2', 'tab1'], 'tab2', ['tab3'], ['tab1']);
verifyMenu(['tab1', 'tab2', 'tab3'], 'tab1', [], ['tab2', 'tab3']);
verifyMenu(['tab1', 'tab2', 'tab3'], 'tab3', ['tab1', 'tab2'], []);
verifyMenu(['tab2'], 'tab2', [], []);
// 关闭或重连导致布局短暂残留引用时，不对缺失会话执行左右关闭。
verifyMenu(['closed', 'tab1', 'tab2', 'stale', 'tab3'], 'tab2', ['tab1'], ['tab3']);
verifyMenu(['tab1', 'tab3'], 'tab2', [], []);
verifyMenu([], 'tab2', [], []);

console.log('会话菜单回归验证通过：复制、排序、首尾边界、分屏隔离和关闭范围。');
