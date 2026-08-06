/* 本模块由 App 入口按功能域拆出，保留原组件行为与状态订阅方式。 */
import { X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { translate, type TranslationKey } from '../i18n';
import { useAppStore } from '../store';
import { portTextInputProps } from '../app/formControls';

export function TunnelFormModal() {
  const {
    closeTunnelForm,
    saveTunnelDraft,
    settings,
    showTunnelForm,
    tunnelDraft,
    updateTunnelDraft,
  } = useAppStore(
    useShallow((state) => ({
      closeTunnelForm: state.closeTunnelForm,
      saveTunnelDraft: state.saveTunnelDraft,
      settings: state.settings,
      showTunnelForm: state.showTunnelForm,
      tunnelDraft: state.tunnelDraft,
      updateTunnelDraft: state.updateTunnelDraft,
    })),
  );

  const t = (key: TranslationKey, replacements?: Record<string, string | number>) =>
    translate(settings.uiLanguage, key, replacements);

  if (!showTunnelForm) {
    return null;
  }

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
              onChange={(event) => updateTunnelDraft('localPort', Number(event.target.value) || 15432)}
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
              onChange={(event) => updateTunnelDraft('remotePort', Number(event.target.value) || 5432)}
            />
          </label>
        </div>

        <div className="modal-actions">
          <button className="secondary-button" onClick={closeTunnelForm} type="button">
            {t('cancel')}
          </button>
          <button className="primary-button" onClick={() => void saveTunnelDraft()} type="button">
            {t('saveTunnel')}
          </button>
        </div>
      </div>
    </div>
  );
}
