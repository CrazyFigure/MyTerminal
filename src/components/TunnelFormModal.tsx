/* 本模块由 App 入口按功能域拆出，保留原组件行为与状态订阅方式。 */
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { translate, type TranslationKey } from '../i18n';
import { useAppStore } from '../store';
import { portTextInputProps } from '../app/formControls';
import { FloatingToast } from '../shared/ui/FloatingToast';
import { getTunnelDraftValidationKey } from '../domain/tunnels/model';

export function TunnelFormModal() {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const {
    closeTunnelForm,
    saveTunnelDraft,
    settings,
    showTunnelForm,
    tunnelDraft,
    tunnels,
    updateTunnelDraft,
  } = useAppStore(
    useShallow((state) => ({
      closeTunnelForm: state.closeTunnelForm,
      saveTunnelDraft: state.saveTunnelDraft,
      settings: state.settings,
      showTunnelForm: state.showTunnelForm,
      tunnelDraft: state.tunnelDraft,
      tunnels: state.tunnels,
      updateTunnelDraft: state.updateTunnelDraft,
    })),
  );

  const t = (key: TranslationKey, replacements?: Record<string, string | number>) =>
    translate(settings.uiLanguage, key, replacements);

  // 弹窗打开或草稿变化时，重置错误状态
  useEffect(() => {
    setErrorMessage(null);
  }, [showTunnelForm, tunnelDraft]);

  if (!showTunnelForm) {
    return null;
  }

  // 保存隧道草稿：先做本地前置校验并在弹窗内展示错误，校验通过后再提交落盘
  const handleSave = async () => {
    const validationKey = getTunnelDraftValidationKey(tunnelDraft, tunnels);
    if (validationKey) {
      setErrorMessage(t(validationKey));
      return;
    }

    setErrorMessage(null);
    try {
      await saveTunnelDraft();
    } catch (error) {
      setErrorMessage(
        t('statusTunnelSaveFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal card tunnel-form-modal">
        <div className="modal-header">
          <div>
            {/* 隧道新增和编辑共用表单，草稿 id 决定当前标题和保存分支。 */}
            <h3>{t(tunnelDraft.id ? 'tunnelModalEditTitle' : 'tunnelModalTitle')}</h3>
          </div>
          <button className="icon-button" onClick={closeTunnelForm} type="button">
            <X size={18} />
          </button>
        </div>

        {errorMessage ? (
          <FloatingToast
            message={errorMessage}
            onDismiss={() => setErrorMessage(null)}
            tone="error"
          />
        ) : null}

        <div className="form-grid">
          <label className="span-2">
            <span>{t('fieldName')}</span>
            <input value={tunnelDraft.name} onChange={(event) => updateTunnelDraft('name', event.target.value)} />
          </label>
          <label>
            <span>{t('fieldBindAddress')}</span>
            <input value={tunnelDraft.bindAddress} onChange={(event) => updateTunnelDraft('bindAddress', event.target.value)} />
          </label>
          <label>
            <span>{t('fieldLocalPort')}</span>
            <input
              {...portTextInputProps}
              value={tunnelDraft.localPort}
              onChange={(event) => {
                const digits = event.target.value.replace(/\D/g, '');
                updateTunnelDraft('localPort', digits === '' ? '' : Number(digits));
              }}
            />
          </label>
          <label>
            <span>{t('fieldRemoteHost')}</span>
            <input value={tunnelDraft.remoteHost} onChange={(event) => updateTunnelDraft('remoteHost', event.target.value)} />
          </label>
          <label>
            <span>{t('fieldRemotePort')}</span>
            <input
              {...portTextInputProps}
              value={tunnelDraft.remotePort}
              onChange={(event) => {
                const digits = event.target.value.replace(/\D/g, '');
                updateTunnelDraft('remotePort', digits === '' ? '' : Number(digits));
              }}
            />
          </label>
        </div>

        <div className="modal-actions">
          <button className="secondary-button" onClick={closeTunnelForm} type="button">
            {t('cancel')}
          </button>
          <button className="primary-button" onClick={() => void handleSave()} type="button">
            {t('saveTunnel')}
          </button>
        </div>
      </div>
    </div>
  );
}
