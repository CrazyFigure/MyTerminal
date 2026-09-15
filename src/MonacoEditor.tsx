import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { readClipboardText, writeClipboardText } from './clipboard';
import { EditorFindReplaceWidget } from './components/EditorFindReplaceWidget';
import { translate } from './i18n';
import { useAppStore } from './store';

// 安装包环境会受 Tauri CSP 约束，不能依赖 @monaco-editor/loader 默认的 CDN 地址加载编辑器脚本。
loader.config({ monaco });

// Monaco 的语言服务必须通过本地 worker 启动；显式映射后，Vite 会把 worker 打进安装包资源。
globalThis.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'json') {
      return new jsonWorker();
    }

    if (label === 'css' || label === 'scss' || label === 'less') {
      return new cssWorker();
    }

    if (label === 'html' || label === 'handlebars' || label === 'razor') {
      return new htmlWorker();
    }

    if (label === 'typescript' || label === 'javascript') {
      return new tsWorker();
    }

    return new editorWorker();
  },
};

type MonacoEditorProps = {
  fontFamily: string;
  fontSize: number;
  language: string;
  onChange: (value: string | undefined) => void;
  onSave?: () => void;
  theme: 'vs-dark' | 'vs-light';
  value: string;
};

export default function MonacoEditor({
  fontFamily,
  fontSize,
  language,
  onChange,
  onSave,
  theme,
  value,
}: MonacoEditorProps) {
  const onSaveRef = useRef(onSave);
  const uiLanguage = useAppStore((state) => state.settings.uiLanguage);
  const [editorInstance, setEditorInstance] = useState<monaco.editor.IStandaloneCodeEditor | null>(
    null,
  );
  const [isFindWidgetOpen, setIsFindWidgetOpen] = useState(false);
  const [findWidgetMode, setFindWidgetMode] = useState<'find' | 'replace'>('find');
  const [contextMenuTarget, setContextMenuTarget] = useState<{
    selectedText: string;
    x: number;
    y: number;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // 快捷键命令只在 Monaco 挂载时注册一次，回调用 ref 保持为当前文件的最新保存逻辑。
    onSaveRef.current = onSave;
  }, [onSave]);

  // 菜单挂载后校准位置，防止贴近窗口右边缘或底边缘时被截断。
  useLayoutEffect(() => {
    const menu = contextMenuRef.current;
    if (!menu || !contextMenuTarget) {
      return;
    }
    const margin = 8;
    const rect = menu.getBoundingClientRect();
    let left = contextMenuTarget.x;
    let top = contextMenuTarget.y;
    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }, [contextMenuTarget]);

  // 点击外部或按下键盘按键时自动关闭右键菜单。
  useEffect(() => {
    const handleCloseMenu = () => {
      setContextMenuTarget(null);
    };

    window.addEventListener('click', handleCloseMenu);
    window.addEventListener('keydown', handleCloseMenu);
    return () => {
      window.removeEventListener('click', handleCloseMenu);
      window.removeEventListener('keydown', handleCloseMenu);
    };
  }, []);

  // 执行复制选中文本到剪贴板，并将焦点交回编辑器。
  const handleCopy = () => {
    const selectedText = contextMenuTarget?.selectedText;
    setContextMenuTarget(null);
    if (selectedText) {
      void writeClipboardText(selectedText).catch(() => undefined);
    }
    editorInstance?.focus();
  };

  // 执行从剪贴板粘贴到编辑器中，并记录撤销栈后重新聚焦。
  const handlePaste = async () => {
    setContextMenuTarget(null);
    if (!editorInstance) {
      return;
    }
    try {
      const text = await readClipboardText().catch(() => '');
      if (!text) {
        return;
      }
      const selections = editorInstance.getSelections();
      if (selections && selections.length > 0) {
        editorInstance.executeEdits(
          'editor-context-menu-paste',
          selections.map((range) => ({
            range,
            text,
            forceMoveMarkers: true,
          })),
        );
        editorInstance.pushUndoStop();
      }
    } finally {
      editorInstance.focus();
    }
  };

  const handleEditorMount = useCallback((editor: monaco.editor.IStandaloneCodeEditor) => {
    setEditorInstance(editor);

    // 监听 Monaco 右键事件，拦截默认菜单并弹出类似于终端样式的自定义右键菜单。
    editor.onContextMenu((e) => {
      e.event.preventDefault();
      e.event.stopPropagation();

      // 若点击位置不在当前选区内，将光标定位到点击位置。
      if (e.target.position) {
        const currentSelection = editor.getSelection();
        const isInsideSelection = currentSelection
          ? monaco.Selection.containsPosition(currentSelection, e.target.position)
          : false;
        if (!isInsideSelection) {
          editor.setPosition(e.target.position);
        }
      }

      // 获取当前选区选中的文本内容；若未选中任何文本则为空字符串。
      const model = editor.getModel();
      const selections = editor.getSelections();
      let selectedText = '';
      if (model && selections && selections.length > 0) {
        const hasSelection = selections.some((s) => !s.isEmpty());
        if (hasSelection) {
          selectedText = selections
            .map((s) => model.getValueInRange(s))
            .filter((s) => s.length > 0)
            .join('\n');
        }
      }

      setContextMenuTarget({
        selectedText,
        x: e.event.browserEvent.clientX,
        y: e.event.browserEvent.clientY,
      });
    });

    // 编辑器滚动时自动隐藏右键菜单。
    editor.onDidScrollChange(() => {
      setContextMenuTarget(null);
    });

    // 为终端用户补充 Ctrl/Cmd+Shift+C/V 别名，并转交 Monaco 原生命令，确保选区、多光标、撤销栈与常规复制粘贴完全一致。
    const clipboardShortcutModifier = monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift;
    editor.addCommand(clipboardShortcutModifier | monaco.KeyCode.KeyC, () => {
      editor.trigger('keyboard', 'editor.action.clipboardCopyAction', null);
    });
    editor.addCommand(clipboardShortcutModifier | monaco.KeyCode.KeyV, () => {
      editor.trigger('keyboard', 'editor.action.clipboardPasteAction', null);
    });
    // Ctrl/Cmd+S 与编辑器右上角保存按钮共用同一保存入口，避免快捷键和按钮行为分叉。
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current?.();
    });

    // 拦截 Ctrl/Cmd+F 打开自定义查找浮窗
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () => {
      setFindWidgetMode('find');
      setIsFindWidgetOpen(true);
    });

    // 拦截 Ctrl/Cmd+H 打开自定义查找替换浮窗
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyH, () => {
      setFindWidgetMode('replace');
      setIsFindWidgetOpen(true);
    });

    // Ctrl/Cmd+R 在内置编辑器中与 Ctrl/Cmd+H 一致，打开自定义查找替换框而不是刷新 WebView。
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyR, () => {
      setFindWidgetMode('replace');
      setIsFindWidgetOpen(true);
    });
  }, []);

  return (
    <div className="monaco-editor-container" onContextMenu={(event) => event.preventDefault()}>
      <Editor
        height="100%"
        language={language}
        loading={null}
        onChange={onChange}
        onMount={handleEditorMount}
        options={{
          automaticLayout: true,
          // 禁用 Monaco 内置的默认右键菜单，改用对齐终端风格的精简右键菜单。
          contextmenu: false,
          find: {
            addExtraSpaceOnTop: false,
            autoFindInSelection: 'never',
            seedSearchStringFromSelection: 'never',
          },
          fontFamily,
          fontSize,
          minimap: { enabled: false },
          // 远程配置文件编辑以可读和稳定为先，禁用底部额外空白避免内容区看起来像被遮挡。
          scrollBeyondLastLine: false,
          wordWrap: 'on',
        }}
        theme={theme}
        value={value}
      />
      <EditorFindReplaceWidget
        editor={editorInstance}
        initialMode={findWidgetMode}
        isOpen={isFindWidgetOpen}
        onClose={() => setIsFindWidgetOpen(false)}
      />
      {contextMenuTarget ? (
        <div
          ref={contextMenuRef}
          className="context-menu editor-context-menu"
          onClick={(event) => event.stopPropagation()}
          style={{ left: contextMenuTarget.x, top: contextMenuTarget.y }}
        >
          <button
            className="context-menu-item"
            disabled={!contextMenuTarget.selectedText}
            onClick={handleCopy}
            type="button"
          >
            {translate(uiLanguage, 'editorMenuCopy')}
          </button>
          <button
            className="context-menu-item"
            disabled={editorInstance?.getOption(monaco.editor.EditorOption.readOnly)}
            onClick={() => {
              void handlePaste();
            }}
            type="button"
          >
            {translate(uiLanguage, 'editorMenuPaste')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
