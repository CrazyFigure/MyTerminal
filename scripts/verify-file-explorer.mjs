// 回归左下角文件树的“修改时间”三态排序、列头按钮交互与拖放上传/下载提取逻辑。
// 用法：node scripts/verify-file-explorer.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const workDir = mkdtempSync(join(tmpdir(), 'myterminal-file-explorer-'));
let presentation;
let fileTransfer;
let FileExplorerPanel;
let bundledReactModule;
try {
  await Promise.all([
    build({
      entryPoints: ['src/features/files/presentation.tsx'],
      bundle: true,
      format: 'esm',
      outfile: join(workDir, 'presentation.mjs'),
      logLevel: 'silent',
    }),
    build({
      entryPoints: ['src/infrastructure/fileTransfer.ts'],
      bundle: true,
      format: 'esm',
      outfile: join(workDir, 'fileTransfer.mjs'),
      logLevel: 'silent',
    }),
    build({
      // 将组件与其引用的 React 运行时打进同一束产物，保证测试时注入的是同一个 Hook 调度器实例。
      stdin: {
        contents: [
          "import * as ReactNs from 'react';",
          "export const reactModule = ReactNs.default ?? ReactNs;",
          "export { FileExplorerPanel } from './src/features/files/FileExplorerPanel';",
        ].join('\n'),
        resolveDir: process.cwd(),
        loader: 'ts',
      },
      bundle: true,
      platform: 'browser',
      format: 'esm',
      outfile: join(workDir, 'FileExplorerPanel.mjs'),
      logLevel: 'silent',
    }),
  ]);
  presentation = await import(pathToFileURL(join(workDir, 'presentation.mjs')).href);
  fileTransfer = await import(pathToFileURL(join(workDir, 'fileTransfer.mjs')).href);
  ({ FileExplorerPanel, reactModule: bundledReactModule } = await import(
    pathToFileURL(join(workDir, 'FileExplorerPanel.mjs')).href
  ));
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

const {
  explorerModifiedAtColumnIndex,
  nextExplorerModifiedSort,
  parseModifiedTimestamp,
  sortExplorerFiles,
} = presentation;
const {
  extractDroppedBrowserFiles,
  uploadRemoteName,
  uploadTopLevelName,
} = fileTransfer;

// 1. 验证三态排序状态机：第 1 次升序、第 2 次降序、第 3 次恢复默认。
assert.equal(nextExplorerModifiedSort('default'), 'asc');
assert.equal(nextExplorerModifiedSort('asc'), 'desc');
assert.equal(nextExplorerModifiedSort('desc'), 'default');

assert.equal(parseModifiedTimestamp(undefined), null);
assert.equal(parseModifiedTimestamp('   '), null);
assert.equal(parseModifiedTimestamp('invalid-date'), null);
assert.equal(parseModifiedTimestamp('2026-06-01T00:00:00Z'), Date.parse('2026-06-01T00:00:00Z'));

// 2. 验证修改时间排序结果：混合目录与文件、相同时间戳稳定性以及缺失/非法时间戳沉底。
const sampleFiles = [
  { name: 'dir-late', path: '/dir-late', isDir: true, size: 0, modifiedAt: '2026-06-05T12:00:00Z' },
  { name: 'dir-no-time', path: '/dir-no-time', isDir: true, size: 0 },
  { name: 'file-early.log', path: '/file-early.log', isDir: false, size: 12, modifiedAt: '2026-06-01T08:00:00Z' },
  { name: 'file-tie-a.txt', path: '/file-tie-a.txt', isDir: false, size: 10, modifiedAt: '2026-06-03T10:00:00Z' },
  { name: 'file-tie-b.txt', path: '/file-tie-b.txt', isDir: false, size: 20, modifiedAt: '2026-06-03T10:00:00Z' },
  { name: 'file-bad-time.txt', path: '/file-bad-time.txt', isDir: false, size: 5, modifiedAt: 'not-a-date' },
];

assert.equal(sortExplorerFiles(sampleFiles, 'default'), sampleFiles);
assert.deepEqual(
  sortExplorerFiles(sampleFiles, 'asc').map((item) => item.name),
  ['file-early.log', 'file-tie-a.txt', 'file-tie-b.txt', 'dir-late', 'dir-no-time', 'file-bad-time.txt'],
);
assert.deepEqual(
  sortExplorerFiles(sampleFiles, 'desc').map((item) => item.name),
  ['dir-late', 'file-tie-a.txt', 'file-tie-b.txt', 'file-early.log', 'dir-no-time', 'file-bad-time.txt'],
);

// 3. 验证 FileExplorerPanel 渲染出的列头按钮、Tooltip、无原生 title、虚拟行拖拽与拖放覆盖层。
const collectNodes = (node, predicate, out = []) => {
  if (!node || typeof node !== 'object') {
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      collectNodes(child, predicate, out);
    }
    return out;
  }
  if (predicate(node)) {
    out.push(node);
  }
  if (node.props?.children !== undefined) {
    collectNodes(node.props.children, predicate, out);
  }
  return out;
};

const renderPanel = (overrides = {}) => {
  // FileExplorerPanel 内部使用了 useRef，未挂载 React 调度器时提供最小兜底 ref。
  let sortClicks = 0;
  let pointerDragCalls = 0;
  const element = FileExplorerPanel({
    beginColumnResize: () => {},
    beginRemoteRowDrag: () => { pointerDragCalls += 1; },
    currentRemotePath: '/srv/app',
    downloadButtonRef: { current: null },
    downloadDropActive: false,
    downloadPaths: () => {},
    explorerGridMinWidth: 720,
    explorerGridStyle: {},
    explorerListRef: { current: null },
    explorerPanelRef: { current: null },
    files: sampleFiles,
    filesLoading: false,
    handleKeyDown: () => {},
    handleScroll: () => {},
    hasActiveRemoteSession: true,
    localFileDropActive: false,
    modifiedSort: 'default',
    nativeUploadPathSelection: false,
    onToggleModifiedSort: () => { sortClicks += 1; },
    openEntry: () => {},
    pathInput: '/srv/app',
    refreshFiles: async () => {},
    remoteDownloadDragPaths: [],
    selectFile: () => {},
    selectUploadFiles: () => {},
    selectUploadFolder: () => {},
    selectedFilePathSet: new Set(),
    selectedFilePaths: [],
    setFileContextMenu: () => {},
    setLocalFileDropActive: () => {},
    setPathInput: () => {},
    setSelectedFilePath: () => {},
    setSelectedFilePaths: () => {},
    t: (key, replacements) => (
      replacements ? `${key}:${JSON.stringify(replacements)}` : key
    ),
    uploadFiles: () => {},
    uploadFolder: () => {},
    virtualEntries: sampleFiles.map((file, index) => ({ file, index })),
    ...overrides,
  });
  return { element, getSortClicks: () => sortClicks, getPointerDragCalls: () => pointerDragCalls };
};

// 直接执行函数组件时替换 React internals 上的 useRef（避免无 render 上下文报错）。
const dispatcherHost = bundledReactModule.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const prevH = dispatcherHost.H;
dispatcherHost.H = {
  useRef: (initialValue) => ({ current: initialValue }),
};
try {
  const defaultRender = renderPanel({ modifiedSort: 'default', localFileDropActive: true, remoteDownloadDragPaths: ['/dir-late'], downloadDropActive: true });
  const headerColumns = collectNodes(defaultRender.element, (n) => n.props?.className === 'explorer-column-header');
  assert.equal(headerColumns.length, 6);

  const modifiedColumn = headerColumns[explorerModifiedAtColumnIndex];
  const sortButtons = collectNodes(modifiedColumn, (n) => typeof n.props?.className === 'string' && n.props.className.includes('explorer-column-sort-button'));
  assert.equal(sortButtons.length, 1);
  assert.equal(sortButtons[0].props['aria-sort'], 'none');
  assert.equal(sortButtons[0].props['data-sort'], 'default');
  sortButtons[0].props.onClick();
  assert.equal(defaultRender.getSortClicks(), 1);

  const ascRender = renderPanel({ modifiedSort: 'asc' });
  const ascButton = collectNodes(ascRender.element, (n) => typeof n.props?.className === 'string' && n.props.className.includes('explorer-column-sort-button'))[0];
  assert.equal(ascButton.props['aria-sort'], 'ascending');
  assert.ok(ascButton.props.className.includes('is-active'));

  const descRender = renderPanel({ modifiedSort: 'desc' });
  const descButton = collectNodes(descRender.element, (n) => typeof n.props?.className === 'string' && n.props.className.includes('explorer-column-sort-button'))[0];
  assert.equal(descButton.props['aria-sort'], 'descending');

  // 确认没有使用原生 title 属性，符合自定义 Tooltip 规范。
  const nodesWithNativeTitle = collectNodes(defaultRender.element, (n) => n.props?.title !== undefined);
  assert.equal(nodesWithNativeTitle.length, 0);

  // 确认拖入提示层与下载按钮高亮状态存在。
  const dropOverlays = collectNodes(defaultRender.element, (n) => n.props?.className === 'explorer-drop-overlay');
  assert.equal(dropOverlays.length, 1);
  const downloadBtns = collectNodes(defaultRender.element, (n) => typeof n.props?.className === 'string' && n.props.className.includes('explorer-download-button'));
  assert.equal(downloadBtns.length, 1);
  assert.ok(downloadBtns[0].props.className.includes('is-drop-target'));
  assert.ok(downloadBtns[0].props.className.includes('is-drop-hot'));

  // 确认文件行触发统一指针拖拽入口（而非禁用 draggable）。
  const rowButtons = collectNodes(defaultRender.element, (n) => n.props?.className === 'explorer-row-main');
  assert.equal(rowButtons.length, sampleFiles.length);
  assert.equal(rowButtons[0].props.draggable, undefined);
  rowButtons[0].props.onPointerDown({ button: 0 });
  assert.equal(defaultRender.getPointerDragCalls(), 1);
} finally {
  dispatcherHost.H = prevH;
}

// 4. 验证浏览器兜底拖放提取器可完整遍历多层目录（含多次 readEntries 批次）并保留相对路径。
const makeFileEntry = (name, content = 'hello') => ({
  isFile: true,
  isDirectory: false,
  name,
  file: (ok) => ok(new File([content], name)),
});
const makeDirEntry = (name, childrenBatches) => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    let cursor = 0;
    return {
      readEntries: (ok) => {
        const batch = cursor < childrenBatches.length ? childrenBatches[cursor] : [];
        cursor += 1;
        ok(batch);
      },
    };
  },
});

const mockFolderDrop = {
  items: [
    {
      webkitGetAsEntry: () => makeDirEntry('project', [
        [makeFileEntry('README.md'), makeDirEntry('src', [[makeFileEntry('index.ts')]])],
        [makeFileEntry('package.json')],
      ]),
    },
    {
      webkitGetAsEntry: () => makeFileEntry('single.log'),
    },
  ],
  files: [],
};

const extracted = await extractDroppedBrowserFiles(mockFolderDrop);
assert.deepEqual(
  extracted.map((file) => uploadRemoteName(file)),
  ['project/README.md', 'project/src/index.ts', 'project/package.json', 'single.log'],
);
assert.deepEqual(
  extracted.map((file) => uploadTopLevelName(file)),
  ['project', 'project', 'project', 'single.log'],
);

console.log('文件树修改时间三态排序与拖放上传/下载逻辑验证通过。');
