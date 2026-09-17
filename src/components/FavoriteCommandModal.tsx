import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { resolveUiFontFamily } from '../app/fonts';
import { translate, type TranslationKey } from '../i18n';
import { useAppStore } from '../store';
import { Tooltip } from './Tooltip';

// 收藏命令编辑/新建弹窗：支持在终端区域、内置编辑器或底部收藏列表中快捷唤起
export function FavoriteCommandModal() {
  const {
    closeFavoriteModal,
    favoriteModalState,
    saveFavoriteCommand,
    settings,
  } = useAppStore(
    useShallow((state) => ({
      closeFavoriteModal: state.closeFavoriteModal,
      favoriteModalState: state.favoriteModalState,
      saveFavoriteCommand: state.saveFavoriteCommand,
      settings: state.settings,
    })),
  );

  const t = (key: TranslationKey, replacements?: Record<string, string | number>) =>
    translate(settings.uiLanguage, key, replacements);

  // 严格跟随外观设置中设置的系统 UI 字体
  const uiFontFamily = resolveUiFontFamily(settings);

  const [command, setCommand] = useState('');
  const [remark, setRemark] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const commandTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const isOpen = Boolean(favoriteModalState?.isOpen);
  const isEdit = Boolean(favoriteModalState?.initialData?.id);

  // 弹窗唤起时预填初始数据（选中文本/已有命令和备注）并聚焦输入框
  useEffect(() => {
    if (!isOpen) {
      setErrorMessage(null);
      return;
    }
    const initial = favoriteModalState?.initialData;
    setCommand(initial?.command ?? '');
    setRemark(initial?.remark ?? '');
    setErrorMessage(null);

    // 延时一帧自动聚焦命令输入框，优化键盘操作体验
    const timer = window.setTimeout(() => {
      commandTextareaRef.current?.focus();
      if (initial?.command) {
        commandTextareaRef.current?.select();
      }
    }, 50);
    return () => window.clearTimeout(timer);
  }, [isOpen, favoriteModalState]);

  if (!isOpen) {
    return null;
  }

  // 提交保存收藏命令
  const handleSave = async () => {
    const trimmedCommand = command.trim();
    if (!trimmedCommand) {
      setErrorMessage(t('favoriteCommandRequired'));
      commandTextareaRef.current?.focus();
      return;
    }

    setErrorMessage(null);
    try {
      await saveFavoriteCommand({
        id: favoriteModalState?.initialData?.id,
        command: trimmedCommand,
        remark: remark.trim(),
      });
    } catch (err) {
      console.error('Failed to save favorite command:', err);
    }
  };

  // 键盘快捷键监听：Escape 退出，Ctrl+Enter / Cmd+Enter 保存
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeFavoriteModal();
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void handleSave();
    }
  };

  return (
    <div className="modal-backdrop favorite-modal-backdrop" onKeyDown={handleKeyDown}>
      <div
        className="modal card favorite-command-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ fontFamily: uiFontFamily }}
      >
        <div className="modal-header">
          <div>
            <h3>{isEdit ? t('favoriteEdit') : t('favoriteAdd')}</h3>
          </div>
          <Tooltip content={t('cancel')} delayDuration={100} side="top">
            <button className="icon-button" onClick={closeFavoriteModal} type="button">
              <X size={16} />
            </button>
          </Tooltip>
        </div>

        <div className="favorite-command-form stack">
          {/* 命令语句输入框 */}
          <div className="field-group">
            <label className="favorite-field-label" htmlFor="favorite-cmd-input">
              <span>{t('favoriteCommand')}</span>
            </label>
            <textarea
              id="favorite-cmd-input"
              ref={commandTextareaRef}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              className={`favorite-command-textarea ${errorMessage ? 'is-invalid' : ''}`}
              data-form-type="other"
              name="favorite_command_text"
              onChange={(e) => {
                setCommand(e.target.value);
                if (errorMessage && e.target.value.trim()) {
                  setErrorMessage(null);
                }
              }}
              placeholder={t('favoriteCommandPlaceholder')}
              rows={4}
              spellCheck={false}
              style={{ fontFamily: uiFontFamily }}
              value={command}
            />
            {errorMessage ? <span className="field-error-text">{errorMessage}</span> : null}
          </div>

          {/* 备注说明输入框 */}
          <div className="field-group">
            <label className="favorite-field-label" htmlFor="favorite-remark-input">
              <span>{t('favoriteRemark')}</span>
            </label>
            <input
              id="favorite-remark-input"
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              className="favorite-remark-input"
              data-form-type="other"
              name="favorite_remark_text"
              onChange={(e) => setRemark(e.target.value)}
              placeholder={t('favoriteRemarkPlaceholder')}
              spellCheck={false}
              style={{ fontFamily: uiFontFamily }}
              type="text"
              value={remark}
            />
          </div>
        </div>

        {/* 取消与保存按钮并排靠右放置，尺寸紧凑精巧 */}
        <div className="modal-actions favorite-modal-actions">
          <button className="secondary-button favorite-btn" onClick={closeFavoriteModal} type="button">
            {t('cancel')}
          </button>
          <button className="primary-button favorite-btn" onClick={() => void handleSave()} type="button">
            {t('save')}
          </button>
        </div>
      </div>
    </div>
  );
}
