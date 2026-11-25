/* 本地终端任务完成与待输入检测领域逻辑单元测试：使用 Node 内置 test runner 与断言。 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyLocalTerminalViewport,
  classifyTerminalTitleActivity,
  LocalTerminalNotificationStateMachine,
  scanLocalTerminalSignals,
} from './localTerminalNotifications';

test('scanLocalTerminalSignals: 识别独立响铃与显式 OSC 通知，并过滤 ConEmu 与序列内 BEL', () => {
  // OSC 0 标题以 BEL 结尾时不应额外产生独立 bell 信号；独立 \x07 与 APC 内部 \x07 应正确区分。
  const oscTitleAndBell = scanLocalTerminalSignals('\x1b]0;✳ Fix bug\x07\x1b_Gi=1\x07\x1b\\done\x07');
  assert.deepEqual(oscTitleAndBell.signals, [
    { type: 'title', title: '✳ Fix bug' },
    { type: 'bell' },
  ]);

  // ConEmu 进度条 (OSC 9;4) 应忽略，工作目录 (OSC 9;9) 只产生 shell_cwd，正文 OSC 9 才发通知。
  const osc9Scan = scanLocalTerminalSignals(
    '\x1b]9;4;1;60\x07\x1b]9;9;C:/WorkSpace\x07\x1b]9;Build succeeded\x07',
  );
  assert.deepEqual(osc9Scan.signals, [
    { type: 'shell_cwd' },
    { type: 'osc_notify', source: 'osc9', body: 'Build succeeded' },
  ]);

  // OSC 777;notify 与跨分片 OSC 133;C/D 解析。
  const firstChunk = scanLocalTerminalSignals('\x1b]777;notify;Codex;Turn complete\x1b\\\x1b]133;C\x07part\x1b]133;');
  assert.deepEqual(firstChunk.signals, [
    { type: 'osc_notify', source: 'osc777', title: 'Codex', body: 'Turn complete' },
    { type: 'osc133_start' },
  ]);
  const secondChunk = scanLocalTerminalSignals('D;0\x07', firstChunk.state);
  assert.deepEqual(secondChunk.signals, [{ type: 'osc133_end', exitCode: 0 }]);

  // Kitty OSC 99 分片 + UTF-8 Base64 解码。
  const encodedTitle = Buffer.from('Claude 通知', 'utf8').toString('base64');
  const encodedBody = Buffer.from('需要确认修改', 'utf8').toString('base64');
  const osc99First = scanLocalTerminalSignals(`\x1b]99;i=req1:p=title:e=1:d=0;${encodedTitle}\x1b\\`);
  assert.equal(osc99First.signals.length, 0);
  const osc99Second = scanLocalTerminalSignals(
    `\x1b]99;i=req1:p=body:e=1:d=1;${encodedBody}\x1b\\`,
    osc99First.state,
  );
  assert.deepEqual(osc99Second.signals, [
    { type: 'osc_notify', source: 'osc99', title: 'Claude 通知', body: '需要确认修改' },
  ]);
});

test('classifyTerminalTitleActivity: 区分运行中、待输入、完成与常见 Shell 标题', () => {
  assert.equal(classifyTerminalTitleActivity('⠋ Refactor store', '本地终端', 'claude'), 'working');
  assert.equal(classifyTerminalTitleActivity('✦ Thinking...', '本地终端', 'gemini'), 'working');
  assert.equal(classifyTerminalTitleActivity('✳ Refactor store', '本地终端', 'claude'), 'idle');
  assert.equal(classifyTerminalTitleActivity('◇ Ready', '本地终端', 'gemini'), 'idle');
  assert.equal(
    classifyTerminalTitleActivity('[ ! ] Action Required - Codex', '本地终端', 'codex'),
    'needs_input',
  );
  assert.equal(
    classifyTerminalTitleActivity('C:\\Windows\\System32\\cmd.exe', '本地终端', ''),
    'idle',
  );
  assert.equal(classifyTerminalTitleActivity('user@dev:~/repo', '本地终端', ''), 'idle');
});

test('classifyLocalTerminalViewport: 正确区分运行中、完成摘要、授权菜单、提问与冷启动欢迎页', () => {
  // 存在 esc to interrupt 时必须视为仍在运行，不能误报完成或提问。
  const workingScreen = classifyLocalTerminalViewport([
    '● Bash(npm run test)',
    '⠋ Running unit tests...',
    '  esc to interrupt · 12s',
  ]);
  assert.equal(workingScreen.isActivelyWorking, true);
  assert.equal(workingScreen.needsInputPrompt, false);

  // Claude 完成后即使保留 `✻ Brewed for 42s`，只要底部已回到带快捷键的输入栏即判定空闲。
  const completedClaudeScreen = classifyLocalTerminalViewport([
    '已完成重构并通过类型检查。',
    '✻ Brewed for 42s',
    '────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────',
    '  ? for shortcuts',
  ]);
  assert.equal(completedClaudeScreen.isActivelyWorking, false);
  assert.equal(completedClaudeScreen.needsInputPrompt, false);
  assert.equal(completedClaudeScreen.isAtIdlePrompt, true);

  // Claude / Codex 交互式选择菜单（带 Enter to select · Esc to cancel）提取标题作为摘要。
  const interactiveChoiceScreen = classifyLocalTerminalViewport([
    'Which authentication mode should we enable for this service?',
    '❯ 1. OAuth 2.0',
    '  2. API Key',
    '  Enter to select · Esc to cancel',
  ]);
  assert.equal(interactiveChoiceScreen.needsInputPrompt, true);
  assert.equal(
    interactiveChoiceScreen.summary,
    'Which authentication mode should we enable for this service?',
  );

  // 标准 CLI 行尾确认提示。
  const cliConfirmScreen = classifyLocalTerminalViewport([
    '3 files will be overwritten.',
    'Proceed with migration? [y/N]',
  ]);
  assert.equal(cliConfirmScreen.needsInputPrompt, true);

  // AI 在带框输入栏上方用自然语言向用户提问时应识别为 needs_input。
  const aiQuestionScreen = classifyLocalTerminalViewport([
    '我已经梳理出两套迁移方案，请告诉我你的偏好：',
    '请问你希望保留哪套配置方案？',
    '────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────',
    '  ? for shortcuts',
  ]);
  assert.equal(aiQuestionScreen.needsInputPrompt, true);
  assert.equal(aiQuestionScreen.summary, '请问你希望保留哪套配置方案？');

  // 普通陈述句、代码或 URL 查询串不能在空闲输入栏上方误报为提问。
  const nonQuestionScreen = classifyLocalTerminalViewport([
    '已更新 https://example.com/docs?tab=api 与 if (ready?) { run(); }。',
    '所有改动已保存到磁盘。',
    '────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────',
    '  ? for shortcuts',
  ]);
  assert.equal(nonQuestionScreen.needsInputPrompt, false);

  // 冷启动欢迎屏标志识别。
  const welcomeScreen = classifyLocalTerminalViewport([
    'Welcome to Claude Code v2.1',
    'Tips for getting started',
    '────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────',
    '  ? for shortcuts',
  ]);
  assert.equal(welcomeScreen.isFreshTuiWelcome, true);
  assert.equal(welcomeScreen.needsInputPrompt, false);
});

test('LocalTerminalNotificationStateMachine: 覆盖标题完成、长命令兜底、Ctrl+C 取消、响铃抑制与审批后续完成', () => {
  const idleClaudeLines = [
    '全部修改已完成。',
    '────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────',
    '  ? for shortcuts',
  ];

  // 1. 无参交互式 AI 预设打开欢迎屏结算不应误报。
  const welcomeTracker = new LocalTerminalNotificationStateMachine({
    sessionId: 'local-1',
    sessionTitle: 'Claude',
    localCommand: 'claude',
    createdAtMs: 0,
  });
  welcomeTracker.processOutputChunk('Welcome to Claude Code', 1000);
  const welcomeDecision = welcomeTracker.evaluateViewport(
    [
      'Welcome to Claude Code',
      'Tips for getting started',
      '────────────────────────────────────',
      '❯ ',
      '  ? for shortcuts',
    ],
    'settle',
    5000,
  );
  assert.equal(welcomeDecision, null);

  // 2. Claude 标题 working -> idle 且工作超过阈值时触发完成通知，同轮不重复通知。
  welcomeTracker.recordUserInput('fix bugs\r', 10_000);
  const workingScan = welcomeTracker.processOutputChunk('\x1b]0;⠋ Fix auth bug\x07', 10_200);
  assert.equal(workingScan.requestQuickCheck, false);
  const idleScan = welcomeTracker.processOutputChunk('\x1b]0;✳ Fix auth bug\x07', 12_000);
  assert.equal(idleScan.requestQuickCheck, true);

  const titleDone = welcomeTracker.evaluateViewport(idleClaudeLines, 'quick', 12_350);
  assert.deepEqual(titleDone, {
    kind: 'completed',
    body: 'Fix auth bug',
    source: 'title',
  });
  // 同轮后续 settle 不得再次触发完成通知。
  assert.equal(welcomeTracker.evaluateViewport(idleClaudeLines, 'settle', 13_950), null);

  // 3. Ctrl+C 取消长任务后回到 Shell 提示符，不得误报任务已完成。
  const shellTracker = new LocalTerminalNotificationStateMachine({
    sessionId: 'local-2',
    sessionTitle: '本地终端',
    localCommand: '',
    createdAtMs: 0,
  });
  shellTracker.recordUserInput('npm run build\r', 20_000);
  shellTracker.processOutputChunk('compiling...\n', 22_000);
  shellTracker.recordUserInput('\x03', 24_000);
  shellTracker.processOutputChunk('PS C:\\repo> ', 24_200);
  assert.equal(shellTracker.evaluateViewport(['PS C:\\repo> '], 'settle', 25_800), null);

  // 4. 敲键期间（1500ms 内）或刚启动时的 BEL 应抑制；工作期间主动发出的 BEL 应快速提醒。
  shellTracker.recordUserInput('a', 30_000);
  const typingBell = shellTracker.processOutputChunk('\x07', 30_400);
  assert.equal(typingBell.requestQuickCheck, false);

  shellTracker.recordUserInput('codex\r', 35_000);
  const validBell = shellTracker.processOutputChunk('\x07', 38_000);
  assert.equal(validBell.requestQuickCheck, true);
  const bellDecision = shellTracker.evaluateViewport(['PS C:\\repo> '], 'quick', 38_350);
  assert.equal(bellDecision?.kind, 'completed');
  assert.equal(bellDecision?.source, 'bell');

  // 5. 窗口 resize 重绘在冷却时间内不安排 settle 检测，避免换行重排误报。
  shellTracker.recordResize(45_000);
  const resizeChunk = shellTracker.processOutputChunk('redraw...', 45_500);
  assert.equal(resizeChunk.scheduleSettleCheck, false);

  // 6. 中途触发 needs_input 授权，去重后经用户输入批准并完成，最终仍能触发 completed。
  const approvalLines = [
    'Do you want to proceed with writing src/main.rs?',
    '  1. Yes, proceed',
    '  2. No, and tell Claude what to do',
  ];
  shellTracker.recordUserInput('claude "edit main.rs"\r', 50_000);
  shellTracker.processOutputChunk('\x1b]0;⠋ Edit main.rs\x07', 50_500);
  const firstAsk = shellTracker.evaluateViewport(approvalLines, 'settle', 52_500);
  assert.deepEqual(firstAsk, {
    kind: 'needs_input',
    body: 'Do you want to proceed with writing src/main.rs?',
    source: 'viewport',
  });
  // 同一提示重复 settle 应去重。
  assert.equal(shellTracker.evaluateViewport(approvalLines, 'settle', 54_500), null);

  // 用户按回车允许继续执行。
  shellTracker.recordUserInput('\r', 56_000);
  shellTracker.processOutputChunk('\x1b]0;⠋ Edit main.rs\x07', 56_200);
  shellTracker.processOutputChunk('\x1b]0;✳ Edit main.rs\x07', 58_000);
  const afterApprovalDone = shellTracker.evaluateViewport(idleClaudeLines, 'quick', 58_350);
  assert.deepEqual(afterApprovalDone, {
    kind: 'completed',
    body: 'Edit main.rs',
    source: 'title',
  });

  // 7. 普通 Shell 长命令无 OSC 信号时，耗时 >= 3000ms 且回到提示符后通过 settle 兜底完成提醒。
  const presetCommandTracker = new LocalTerminalNotificationStateMachine({
    sessionId: 'local-3',
    sessionTitle: 'Build',
    localCommand: 'npm run build',
    createdAtMs: 0,
  });
  presetCommandTracker.processOutputChunk('step 1\n', 1500);
  presetCommandTracker.processOutputChunk('step 2\nC:\\repo> ', 3600);
  const longCmdDone = presetCommandTracker.evaluateViewport(['C:\\repo> '], 'settle', 5200);
  assert.deepEqual(longCmdDone, {
    kind: 'completed',
    body: '',
    source: 'viewport',
  });

  // 8. 显式 OSC 9 / 777 携带授权关键词时即时升级为 needs_input。
  const oscAsk = presetCommandTracker.processOutputChunk('\x1b]9;Codex action required: run tests?\x07', 12_000);
  assert.deepEqual(oscAsk.immediateNotifications, [
    {
      kind: 'needs_input',
      title: undefined,
      body: 'Codex action required: run tests?',
      source: 'osc',
    },
  ]);
});
