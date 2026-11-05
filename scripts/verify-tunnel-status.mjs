// 校验自动启动状态归并及手动停止后的迟到探测保护；不启动界面、SSH 或开发服务。
// 用法：node scripts/verify-tunnel-status.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const workDir = mkdtempSync(join(tmpdir(), 'myterminal-tunnel-status-'));
try {
  const bundlePath = join(workDir, 'tunnelActions.mjs');
  await build({
    entryPoints: ['src/application/store/tunnelActions.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    define: { 'import.meta.env.VITE_APP_VERSION': '"test"' },
    outfile: bundlePath,
    logLevel: 'silent',
  });
  const { createTunnelActions } = await import(pathToFileURL(bundlePath).href);
  const original = { id: 'configured', connectionId: 'connection', name: '隧道', status: 'stopped' };
  let state = { tunnels: [original] };
  const actions = createTunnelActions(
    (change) => { state = { ...state, ...(typeof change === 'function' ? change(state) : change) }; },
    () => state,
  );

  // 健康探测不能把用户手动停止的隧道重新显示为运行或异常。
  actions.applyTunnelStatusChange({ ...original, status: 'running' });
  assert.equal(state.tunnels[0].status, 'stopped');
  actions.applyTunnelStatusChange({ ...original, status: 'error' });
  assert.equal(state.tunnels[0].status, 'stopped');

  // SSH 自动启动必须能更新停止态；事件元数据与旧配置不应写入配置记录。
  actions.applyTunnelStatusChange({ ...original, name: '旧名称', status: 'running', automaticStart: true });
  assert.equal(state.tunnels[0].status, 'running');
  assert.equal(state.tunnels[0].name, '隧道');
  assert.equal(state.tunnels[0].automaticStart, undefined);
  const unchanged = state.tunnels;
  actions.applyTunnelStatusChange({ ...original, status: 'running', automaticStart: true });
  assert.equal(state.tunnels, unchanged);

  actions.applyTunnelStatusChange({ ...original, status: 'error' });
  assert.equal(state.tunnels[0].status, 'error');
  actions.applyTunnelStatusChange({ ...original, status: 'running' });
  assert.equal(state.tunnels[0].status, 'running');
  state.tunnels = [{ ...original }];
  actions.applyTunnelStatusChange({ ...original, status: 'error', automaticStart: true });
  assert.equal(state.tunnels[0].status, 'error');
  actions.applyTunnelStatusChange({ ...original, id: 'deleted', status: 'running', automaticStart: true });
  assert.equal(state.tunnels.length, 1);
  console.log('隧道状态回归验证通过：自动开启、启动失败、健康恢复、重复事件、迟到保护与删除边界。');
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
