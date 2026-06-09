import Editor from '@monaco-editor/react';

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
