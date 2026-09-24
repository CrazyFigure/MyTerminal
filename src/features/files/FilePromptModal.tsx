import { useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { TranslationKey } from '../../i18n';
import { Tooltip } from '../../components/Tooltip';

// 文件操作弹窗目标：支持新建目录、新建文件和重命名三种模式
export type FilePromptTarget =
  | { mode: 'newDirectory'; remoteDir: string }
  | { mode: 'newFile'; remoteDir: string }
  | { mode: 'rename'; path: string; currentName: string };

type FilePromptModalProps = {
  createEntry: (remoteDir: string, name: string, isDirectory: boolean) => Promise<void>;
  onClose: () => void;
  renamePath: (path: string, nextName: string) => Promise<unknown>;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
  target: FilePromptTarget | null;
};

// 文件管理命名输入模态框：居中展现、精简标题、并提供即时交互反馈与快捷键支持
export function FilePromptModal({
  createEntry,
  onClose,
  renamePath,
  t,
  target,
}: FilePromptModalProps) {
  const [name, setName] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 弹窗打开或模式切换时在 DOM 绘制前同步初始化输入框内容并直接聚焦
  useLayoutEffect(() => {
    if (!target) {
      return;
    }
    const initialName = target.mode === 'rename' ? target.currentName : '';
    setName(initialName);
    setErrorMessage(null);

    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    if (target.mode === 'rename') {
      const lastDotIndex = initialName.lastIndexOf('.');
      // 若存在扩展名且不是以点开头的隐藏文件，则只选中主体文件名部分
      if (lastDotIndex > 0) {
        input.setSelectionRange(0, lastDotIndex);
      } else {
        input.select();
      }
    } else {
      input.select();
    }
  }, [target]);

  if (!target) {
    return null;
  }

  // 提交新建或重命名操作：立即关闭弹窗，由后台异步执行并统一由状态栏提示，消除网络等待卡顿
  const handleSubmit = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setErrorMessage(t('nameRequired'));
      inputRef.current?.focus();
      return;
    }

    // 立即关闭弹窗恢复界面交互
    onClose();

    // 重命名且名称未变更时无需发起远程调用
    if (target.mode === 'rename' && trimmedName === target.currentName) {
      return;
    }

    // 异步执行远程操作，Store 内部已封装全局状态栏通知与失败拦截
    if (target.mode === 'newDirectory') {
      void createEntry(target.remoteDir, trimmedName, true).catch(() => undefined);
    } else if (target.mode === 'newFile') {
      void createEntry(target.remoteDir, trimmedName, false).catch(() => undefined);
    } else if (target.mode === 'rename') {
      void renamePath(target.path, trimmedName).catch(() => undefined);
    }
  };

  // 键盘快捷键监听：Enter 提交，Escape 取消退出
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      handleSubmit();
    }
  };

  // 根据当前模式确定标题文本
  const titleText =
    target.mode === 'newDirectory'
      ? t('fileMenuNewDirectory')
      : target.mode === 'newFile'
      ? t('fileMenuNewFile')
      : t('fileMenuRename');

  // 根据当前模式确定占位提示文案
  const placeholderText =
    target.mode === 'newDirectory'
      ? t('newDirectoryPlaceholder')
      : target.mode === 'newFile'
      ? t('newFilePlaceholder')
      : t('renamePlaceholder');

  return (
    <div
      className="modal-backdrop"
      onKeyDown={handleKeyDown}
    >
      <div
        aria-modal="true"
        className="modal card file-prompt-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <div className="modal-header">
          <div>
            <h3>{titleText}</h3>
          </div>
          {/* 右上角关闭按钮，采用延迟 100ms 的自定义 Tooltip 替代原生 title */}
          <Tooltip content={t('close')} delayDuration={100} side="top">
            <button
              className="icon-button"
              onClick={onClose}
              type="button"
            >
              <X size={18} />
            </button>
          </Tooltip>
        </div>

        <div className="file-prompt-input-wrapper">
          <input
            ref={inputRef}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className={`file-prompt-input ${errorMessage ? 'is-invalid' : ''}`}
            onChange={(e) => {
              setName(e.target.value);
              if (errorMessage && e.target.value.trim()) {
                setErrorMessage(null);
              }
            }}
            placeholder={placeholderText}
            spellCheck={false}
            type="text"
            value={name}
          />
          {errorMessage ? (
            <span className="file-prompt-error-text" role="alert">
              {errorMessage}
            </span>
          ) : null}
        </div>

        {/* 底部操作区：取消和确定按钮并排靠右放置 */}
        <div className="modal-actions file-prompt-actions">
          <button
            className="secondary-button file-prompt-btn"
            onClick={onClose}
            type="button"
          >
            {t('cancel')}
          </button>
          <button
            className="primary-button file-prompt-btn"
            onClick={handleSubmit}
            type="button"
          >
            {t('confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
