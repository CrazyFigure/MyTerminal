import { useCallback, useEffect, useRef } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

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

  useEffect(() => {
    // 快捷键命令只在 Monaco 挂载时注册一次，回调用 ref 保持为当前文件的最新保存逻辑。
    onSaveRef.current = onSave;
  }, [onSave]);

  const handleEditorMount = useCallback((editor: monaco.editor.IStandaloneCodeEditor) => {
    // Ctrl/Cmd+S 与编辑器右上角保存按钮共用同一保存入口，避免快捷键和按钮行为分叉。
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current?.();
    });
  }, []);

  return (
    <Editor
      height="100%"
      language={language}
      loading={null}
      onChange={onChange}
      onMount={handleEditorMount}
      options={{
        automaticLayout: true,
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
  );
}
