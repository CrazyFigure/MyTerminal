/* 本模块由 App 入口按功能域拆出，保留原组件行为与状态订阅方式。 */
import { lazy, Suspense } from 'react';
import { Save } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { translate, type TranslationKey } from '../i18n';
import { useAppStore } from '../store';
import { buildPreviewFontFamily } from '../app/fonts';

export const MonacoEditor = lazy(() => import('../MonacoEditor'));



export function EditorModal({
  onSaveWithProgress,
}: {
  onSaveWithProgress?: (path: string, saveTask: () => Promise<void>) => void;
}) {
  const {
    closeEditorDocument,
    editorDocument,
    saveEditorDocument,
    setEditorContent,
    settings,
  } = useAppStore(
    useShallow((state) => ({
      closeEditorDocument: state.closeEditorDocument,
      editorDocument: state.editorDocument,
      saveEditorDocument: state.saveEditorDocument,
      setEditorContent: state.setEditorContent,
      settings: state.settings,
    })),
  );

  const t = (key: TranslationKey, replacements?: Record<string, string | number>) =>
    translate(settings.uiLanguage, key, replacements);
  const editorTheme = settings.themeMode === 'dark' ? 'vs-dark' : 'vs-light';

  if (!editorDocument) {
    return null;
  }

  const handleSaveEditorDocument = () => {
    if (onSaveWithProgress) {
      // 远程编辑保存同样是一次 SFTP 写入，复用全局传输提示，避免用户误以为按钮没有响应。
      onSaveWithProgress(editorDocument.path, saveEditorDocument);
      return;
    }
    void saveEditorDocument();
  };

  return (
    <div className="modal-backdrop">
      <div className="modal modal-editor card">
        <div className="modal-header">
          <div>
            <h3>{t('editorModalTitle')}</h3>
            <p>{editorDocument.path}</p>
          </div>
          <div className="section-row compact">
            <button className="secondary-button" onClick={closeEditorDocument} type="button">
              {t('close')}
            </button>
            <button className="primary-button" onClick={handleSaveEditorDocument} type="button">
              <Save size={16} />
              {editorDocument.dirty ? t('saveToRemote') : t('saved')}
            </button>
          </div>
        </div>

        <div className="editor-shell modal-editor-shell">
          <Suspense fallback={<div className="empty-state">{t('working')}</div>}>
            <MonacoEditor
              fontFamily={buildPreviewFontFamily(settings)}
              fontSize={settings.shellFontSize}
              language={editorDocument.language}
              onChange={(value) => setEditorContent(value ?? '')}
              onSave={handleSaveEditorDocument}
              theme={editorTheme}
              value={editorDocument.content}
            />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
