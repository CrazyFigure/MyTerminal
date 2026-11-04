// 预设图标回归：校验展示顺序、短命令边界、历史会话标签和自定义图标优先级。
// 用法：node scripts/verify-local-terminal-icons.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// 在专用临时目录打包现有公共入口，不启动真实终端或外部 CLI。
const workDir = mkdtempSync(join(tmpdir(), 'myterminal-icons-'));
const outputFile = join(workDir, 'localTerminal.mjs');
try {
  await build({
    entryPoints: ['src/app/localTerminal.ts'],
    bundle: true,
    format: 'esm',
    outfile: outputFile,
    logLevel: 'silent',
  });
  const {
    AI_COMMAND_ICONS,
    AVAILABLE_COMMAND_ICONS,
    formatLocalTerminalTabLabel,
    getLocalTerminalIcon,
    hasExclusiveLocalTerminalIcon,
    resolveIconDisplayUrl,
  } = await import(pathToFileURL(outputFile).href);

  assert.deepEqual(AI_COMMAND_ICONS.map((item) => item.name), [
    'Claude', 'Codex', 'OpenCode', 'pi', 'DeepSeek Harness', 'Grok',
    'Antigravity', 'Gemini', 'qwen', 'kimi', 'Cursor', 'Mistral',
    'Copilot', 'OpenAI', 'DeepSeek',
  ]);
  assert.equal(new Set(AVAILABLE_COMMAND_ICONS.map((item) => item.id)).size, AVAILABLE_COMMAND_ICONS.length);
  for (const item of AI_COMMAND_ICONS) {
    assert.ok(existsSync(join('public', item.path)), `${item.name} 图标必须存在`);
    assert.equal(resolveIconDisplayUrl(item.path), item.path);
  }

  // 覆盖命令别名、大小写、带空格的绝对路径、Windows 扩展名及包管理器/终端包装。
  const cases = [
    ['Antigravity', 'custom-launcher', '/icons/antigravity.svg'],
    ['Antigravity CLI', 'custom-launcher', '/icons/antigravity.svg'],
    ['自定义名称', 'agy', '/icons/antigravity.svg'],
    ['AGY', 'custom-launcher', '/icons/antigravity.svg'],
    ['自定义名称', '"C:\\Program Files\\agy\\agy.exe" --resume', '/icons/antigravity.svg'],
    ['自定义名称', "pwsh -Command 'agy.cmd --resume'", '/icons/antigravity.svg'],
    ['自定义名称', '/usr/local/bin/agy', '/icons/antigravity.svg'],
    ['DeepSeek Harness', 'custom-launcher', '/icons/deepseek-harness.svg'],
    ['DeepSeek-Harness', 'custom-launcher', '/icons/deepseek-harness.svg'],
    ['DeepSeek', 'dsh web', '/icons/deepseek-harness.svg'],
    ['DSH', 'custom-launcher', '/icons/deepseek-harness.svg'],
    ['自定义名称', '"C:\\Program Files\\dsh\\dsh.cmd" web', '/icons/deepseek-harness.svg'],
    ['自定义名称', "pwsh -Command 'dsh.ps1 web'", '/icons/deepseek-harness.svg'],
    ['自定义名称', 'npx @deepseek-ai/dsh web', '/icons/deepseek-harness.svg'],
    ['DeepSeek', 'deepseek', '/icons/deepseek.svg'],
    ['自定义名称', 'agyness', null],
    ['自定义名称', 'dshader', null],
    ['自定义名称', 'my-agy-tool', null],
    ['自定义名称', 'my-dsh-tool', null],
  ];
  for (const [name, command, expected] of cases) {
    assert.equal(getLocalTerminalIcon(name, command), expected, command);
  }

  // 历史配置仍可自动识别，用户指定或隐藏图标的选择始终优先。
  for (const command of ['agy', 'dsh web']) {
    assert.equal(hasExclusiveLocalTerminalIcon(command, command), true);
    assert.equal(getLocalTerminalIcon(command, command, '/custom.svg'), '/custom.svg');
    assert.equal(getLocalTerminalIcon(command, command, 'none'), undefined);
    assert.equal(getLocalTerminalIcon(command, command, ''), undefined);
    assert.equal(formatLocalTerminalTabLabel({
      title: `${command} · C:/work/project`,
      cwd: 'C:/work/project',
      localCommand: command,
    }), 'project');
  }

  // 单色 Harness 在 body 主题和应用容器主题下都反白，蓝色 DeepSeek 保持独立。
  const css = readFileSync('src/styles.css', 'utf8');
  assert.ok(css.includes('body.theme-dark img[src*="deepseek-harness.svg"]'));
  assert.ok(css.includes('.app-shell.theme-dark img[src*="deepseek-harness.svg"]'));
  const harnessSvg = readFileSync('public/icons/deepseek-harness.svg', 'utf8');
  assert.ok(harnessSvg.includes('fill="currentColor"'));
  assert.ok(readFileSync('public/icons/deepseek.svg', 'utf8').includes('fill="#4D6BFE"'));
  assert.ok(!readFileSync('public/icons/antigravity.svg', 'utf8').includes('fav-bg'));
  console.log('预设命令图标、排序与历史会话兼容校验通过。');
} finally {
  rmSync(outputFile, { force: true });
  rmdirSync(workDir);
}
