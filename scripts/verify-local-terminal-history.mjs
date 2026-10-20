// 历史命令回退回归：校验可选列表顺序、失效引用和配置读写边界；不启动真实终端或外部命令。
// 用法：node scripts/verify-local-terminal-history.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// 仅将被测纯规则打包到本次专用临时目录，结束后清理，不新增前端测试框架。
const workDir = mkdtempSync(join(tmpdir(), 'myterminal-history-'));
try {
  await build({
    entryPoints: ['src/domain/settings/localTerminal.ts', 'src/backend/normalizers.ts'],
    bundle: true,
    format: 'esm',
    outdir: workDir,
    outbase: 'src',
    outExtension: { '.js': '.mjs' },
    logLevel: 'silent',
  });
  const { getLocalTerminalStartupOptions, resolveLocalTerminalStartupCommand } = await import(
    pathToFileURL(join(workDir, 'domain/settings/localTerminal.mjs')).href
  );
  const { normalizeLocalTerminalSettings } = await import(
    pathToFileURL(join(workDir, 'backend/normalizers.mjs')).href
  );

  // 默认终端故意指向第二项，历史失效时仍应遵循可选列表的第一项。
  const settings = {
    shellPath: '',
    defaultShellId: 'cmd',
    shells: [
      { id: 'hidden', name: 'Hidden', command: 'hidden.exe', enabled: false },
      { id: 'invalid', name: 'Invalid', command: ' ', enabled: true },
      { id: 'pwsh', name: 'PowerShell 7', command: 'pwsh.exe', enabled: true },
      { id: 'cmd', name: 'CMD', command: 'cmd.exe', enabled: true },
    ],
    commands: [
      { id: 'shell', name: '本地终端', command: '', builtIn: true },
      { id: 'codex', name: 'Codex', command: 'codex', builtIn: false },
      { id: 'pi', name: 'Pi', command: 'pi', builtIn: false },
    ],
    profiles: [{ id: 'history', title: 'pi · C:/work', cwd: 'C:/work', command: 'pi', lastUsedAt: '2026-10-20' }],
  };
  const available = getLocalTerminalStartupOptions(settings);
  assert.deepEqual(available.map((option) => option.value), ['shell:pwsh', 'shell:cmd', 'codex', 'pi']);
  assert.equal(resolveLocalTerminalStartupCommand('pi', available), 'pi');
  assert.equal(resolveLocalTerminalStartupCommand('shell:cmd', available), 'shell:cmd');

  const removed = { ...settings, commands: settings.commands.filter((command) => command.id !== 'pi') };
  const fallback = normalizeLocalTerminalSettings(removed);
  assert.equal(fallback.profiles[0].command, 'shell:pwsh');
  assert.equal(fallback.profiles[0].title, 'shell:pwsh · C:/work');
  assert.equal(fallback.profiles[0].id, 'history');
  assert.equal(fallback.profiles[0].lastUsedAt, '2026-10-20');
  assert.deepEqual(normalizeLocalTerminalSettings(fallback), fallback);

  // 系统终端全部关闭后选择首个预设；两组都为空时清空失效命令和标题中的旧工具名。
  const disabled = { ...removed, shells: removed.shells.map((shell) => ({ ...shell, enabled: false })) };
  assert.equal(normalizeLocalTerminalSettings(disabled).profiles[0].command, 'codex');
  const empty = normalizeLocalTerminalSettings({ ...disabled, commands: [] });
  assert.equal(empty.profiles[0].command, '');
  assert.equal(empty.profiles[0].title, 'C:/work');

  // 系统终端引用失效同样回退，有效历史的自定义标题和原选择应保留。
  assert.equal(resolveLocalTerminalStartupCommand('shell:removed', available), 'shell:pwsh');
  const valid = normalizeLocalTerminalSettings({
    ...settings,
    profiles: [{ ...settings.profiles[0], title: '自定义标题' }],
  });
  assert.equal(valid.profiles[0].command, 'pi');
  assert.equal(valid.profiles[0].title, '自定义标题');
  console.log('本地终端历史命令回退校验通过。');
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
