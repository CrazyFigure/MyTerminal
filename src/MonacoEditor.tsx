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
  theme: 'vs-dark' | 'vs-light';
  value: string;
};

export default function MonacoEditor({
  fontFamily,
  fontSize,
  language,
  onChange,
  theme,
  value,
}: MonacoEditorProps) {
  return (
    <Editor
      height="100%"
      language={language}
      loading={null}
      onChange={onChange}
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
