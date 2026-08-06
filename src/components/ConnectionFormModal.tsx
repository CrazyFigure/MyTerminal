/* 本模块由 App 入口按功能域拆出，保留原组件行为与状态订阅方式。 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Eye, EyeOff, Folder, Monitor, Plus, TerminalSquare, Trash2, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { translate, type TranslationKey } from '../i18n';
import { useAppStore } from '../store';
import type { ConnectionDraft, SshJumpHost } from '../types';
import { CustomSelect } from '../CustomSelect';
import { collectOrderedGroupPaths, normalizeConnectionGroupPath } from '../app/connectionGroups';
import { portTextInputProps } from '../app/formControls';

export type ConnectionFormTab = 'basic' | 'jumpHosts' | 'proxy';



export const getConnectionValidationKey = (draft: ConnectionDraft) => {
  if (!draft.name.trim()) {
    return 'validationNameRequired' as const;
  }
  if (!draft.host.trim()) {
    return 'validationHostRequired' as const;
  }
  if (!draft.username.trim()) {
    return 'validationUsernameRequired' as const;
  }
  if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) {
    return 'validationPortInvalid' as const;
  }

  if (draft.protocol === 'rdp') {
    if (!draft.password.trim()) {
      return 'validationPasswordRequired' as const;
    }
  } else if (draft.authMethod === 'privateKey') {
    if (!draft.privateKeyPath.trim() && !draft.privateKeyText.trim()) {
      return 'validationPrivateKeyRequired' as const;
    }
  } else if (!draft.password.trim()) {
    return 'validationPasswordRequired' as const;
  }

  for (const jumpHost of draft.protocol === 'ssh' ? draft.jumpHosts : []) {
    if (!jumpHost.host.trim()) {
      return 'validationJumpHostRequired' as const;
    }
    if (!jumpHost.username.trim()) {
      return 'validationJumpUsernameRequired' as const;
    }
    if (!Number.isInteger(jumpHost.port) || jumpHost.port < 1 || jumpHost.port > 65535) {
      return 'validationPortInvalid' as const;
    }
    if (jumpHost.authMethod === 'privateKey') {
      if (!jumpHost.privateKeyPath?.trim() && !jumpHost.privateKeyText?.trim()) {
        return 'validationJumpPrivateKeyRequired' as const;
      }
    } else if (!jumpHost.password?.trim()) {
      return 'validationJumpPasswordRequired' as const;
    }
  }

  if (draft.protocol === 'ssh' && draft.proxy.enabled) {
    if (!draft.proxy.host.trim()) {
      return 'validationProxyHostRequired' as const;
    }
    if (!Number.isInteger(draft.proxy.port) || draft.proxy.port < 1 || draft.proxy.port > 65535) {
      return 'validationPortInvalid' as const;
    }
  }

  return undefined;
};



// 跳板机默认按 SSH 常用端口和密码认证初始化；每一级都能再切换到私钥认证。
export const createEmptyJumpHost = (): SshJumpHost => ({
  id: crypto.randomUUID(),
  name: '',
  host: '',
  port: 22,
  username: '',
  authMethod: 'password',
  password: '',
  privateKeyPath: '',
  privateKeyText: '',
  passphrase: '',
});



export function ConnectionFormModal() {
  const [revealPassword, setRevealPassword] = useState(false);
  const [revealPassphrase, setRevealPassphrase] = useState(false);
  const [groupPickerOpen, setGroupPickerOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<ConnectionFormTab>('basic');
  const {
    showConnectionForm,
    connectionDraft,
    connectionTestResult,
    closeConnectionForm,
    updateConnectionDraft,
    saveConnectionDraft,
    testConnectionDraft,
    connections,
    loading,
    settings,
  } = useAppStore(
    useShallow((state) => ({
      showConnectionForm: state.showConnectionForm,
      connectionDraft: state.connectionDraft,
      connectionTestResult: state.connectionTestResult,
      closeConnectionForm: state.closeConnectionForm,
      updateConnectionDraft: state.updateConnectionDraft,
      saveConnectionDraft: state.saveConnectionDraft,
      testConnectionDraft: state.testConnectionDraft,
      connections: state.connections,
      loading: state.loading,
      settings: state.settings,
    })),
  );

  const t = (key: TranslationKey, replacements?: Record<string, string | number>) =>
    translate(settings.uiLanguage, key, replacements);
  const isRdpConnection = connectionDraft.protocol === 'rdp';
  const isPrivateKeyMode = !isRdpConnection && connectionDraft.authMethod === 'privateKey';
  const passwordToggleLabel = revealPassword ? t('hideSecret') : t('showSecret');
  const passphraseToggleLabel = revealPassphrase ? t('hideSecret') : t('showSecret');
  const validationKey = getConnectionValidationKey(connectionDraft);
  const canSubmit = !validationKey && !loading;
  const connectionTabs: Array<{ id: ConnectionFormTab; label: string }> = isRdpConnection
    ? [{ id: 'basic', label: t('connectionTabBasic') }]
    : [
        { id: 'basic', label: t('connectionTabBasic') },
        { id: 'jumpHosts', label: t('connectionTabJumpHosts') },
        { id: 'proxy', label: t('connectionTabProxy') },
      ];
  const selectProtocol = (protocol: ConnectionDraft['protocol']) => {
    if (protocol === connectionDraft.protocol) {
      return;
    }

    // 只替换另一协议的默认值；用户手工配置过的端口和账号必须原样保留，切换后可继续调整。
    updateConnectionDraft('protocol', protocol);
    if (protocol === 'rdp') {
      if (connectionDraft.port === 22) {
        updateConnectionDraft('port', 3389);
      }
      if (connectionDraft.username === 'root') {
        updateConnectionDraft('username', 'Administrator');
      }
      setActiveTab('basic');
      return;
    }
    if (connectionDraft.port === 3389) {
      updateConnectionDraft('port', 22);
    }
    if (connectionDraft.username === 'Administrator') {
      updateConnectionDraft('username', 'root');
    }
  };
  const updateJumpHost = (id: string, patch: Partial<SshJumpHost>) => {
    // 跳板机按数组顺序执行，更新时仅替换命中的一级，避免重排破坏用户配置的跳转链。
    updateConnectionDraft('jumpHosts', connectionDraft.jumpHosts.map((jumpHost) => (
      jumpHost.id === id ? { ...jumpHost, ...patch } : jumpHost
    )));
  };
  const moveJumpHost = (id: string, direction: -1 | 1) => {
    const currentIndex = connectionDraft.jumpHosts.findIndex((jumpHost) => jumpHost.id === id);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= connectionDraft.jumpHosts.length) {
      return;
    }
    const nextJumpHosts = [...connectionDraft.jumpHosts];
    const [item] = nextJumpHosts.splice(currentIndex, 1);
    nextJumpHosts.splice(nextIndex, 0, item);
    updateConnectionDraft('jumpHosts', nextJumpHosts);
  };
  const addJumpHost = () => {
    updateConnectionDraft('jumpHosts', [...connectionDraft.jumpHosts, createEmptyJumpHost()]);
  };
  const deleteJumpHost = (id: string) => {
    updateConnectionDraft('jumpHosts', connectionDraft.jumpHosts.filter((jumpHost) => jumpHost.id !== id));
  };
  const updateProxy = (patch: Partial<ConnectionDraft['proxy']>) => {
    // 代理开关和认证信息都保留在同一个对象里，关闭代理时不清空已填地址，便于临时切换。
    updateConnectionDraft('proxy', { ...connectionDraft.proxy, ...patch });
  };
  // 分组输入使用自定义下拉，避免浏览器 datalist 在输入前缀时把可选父分组直接过滤掉。
  const groupOptions = useMemo(() => collectOrderedGroupPaths(settings.connectionGroups, connections), [connections, settings.connectionGroups]);
  const sortedGroupOptions = useMemo(() => {
    const keyword = normalizeConnectionGroupPath(connectionDraft.groupPath).toLowerCase();
    if (!keyword) {
      return groupOptions;
    }

    // 输入内容只影响排序，不隐藏任何已有分组；用户输入 ology- 时仍能看到 ology 这类父级候选。
    return [...groupOptions].sort((left, right) => {
      const leftLower = left.toLowerCase();
      const rightLower = right.toLowerCase();
      const leftMatched = leftLower.includes(keyword) || keyword.includes(leftLower);
      const rightMatched = rightLower.includes(keyword) || keyword.includes(rightLower);
      if (leftMatched !== rightMatched) {
        return leftMatched ? -1 : 1;
      }
      return groupOptions.indexOf(left) - groupOptions.indexOf(right);
    });
  }, [connectionDraft.groupPath, groupOptions]);
  useEffect(() => {
    if (!showConnectionForm) {
      return;
    }

    // 每次打开新增/编辑弹窗都回到基础页，避免上一次停留在跳板机或代理页造成误以为基础信息丢失。
    setActiveTab('basic');
    setGroupPickerOpen(false);
    setRevealPassword(false);
    setRevealPassphrase(false);
  }, [showConnectionForm]);

  if (!showConnectionForm) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <div className="modal card connection-form-modal">
        <div className="modal-header">
          <div>
            <h3>{connectionDraft.id ? t('connectionModalEditTitle') : t('connectionModalNewTitle')}</h3>
          </div>
          <button className="icon-button" onClick={closeConnectionForm} type="button">
            <X size={18} />
          </button>
        </div>

        <div className="tab-list connection-form-tabs">
          {connectionTabs.map((tab) => (
            <button
              key={tab.id}
              className={`panel-tab ${activeTab === tab.id ? 'is-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              type="button"
            >
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        <div className="connection-form-panels">
          <div className={`connection-form-panel ${activeTab === 'basic' ? 'is-active' : ''}`}>
            <div className="form-grid">
              <div className="form-field span-2">
                <span>{t('fieldConnectionProtocol')}</span>
                <div className="connection-protocol-selector" role="group" aria-label={t('fieldConnectionProtocol')}>
                  <button
                    aria-pressed={!isRdpConnection}
                    className={`connection-protocol-option ${!isRdpConnection ? 'is-active' : ''}`}
                    onClick={() => selectProtocol('ssh')}
                    type="button"
                  >
                    <TerminalSquare size={17} />
                    <span>{t('connectionProtocolSsh')}</span>
                  </button>
                  <button
                    aria-pressed={isRdpConnection}
                    className={`connection-protocol-option ${isRdpConnection ? 'is-active' : ''}`}
                    onClick={() => selectProtocol('rdp')}
                    type="button"
                  >
                    <Monitor size={17} />
                    <span>{t('connectionProtocolRdp')}</span>
                  </button>
                </div>
              </div>
              <label>
                <span>{t('fieldName')}</span>
                <input value={connectionDraft.name} onChange={(event) => updateConnectionDraft('name', event.target.value)} />
              </label>
              <label>
                <span>{t('fieldGroupPath')}</span>
                <div className="group-combobox">
                  <input
                    aria-expanded={groupPickerOpen}
                    placeholder={t('groupPathPlaceholder')}
                    value={connectionDraft.groupPath}
                    onBlur={() => window.setTimeout(() => setGroupPickerOpen(false), 120)}
                    onChange={(event) => {
                      updateConnectionDraft('groupPath', event.target.value);
                      setGroupPickerOpen(true);
                    }}
                    onFocus={() => setGroupPickerOpen(true)}
                  />
                  {groupPickerOpen && sortedGroupOptions.length ? (
                    <div className="group-options-menu">
                      {sortedGroupOptions.map((groupPath) => (
                        <button
                          key={groupPath}
                          className="group-option-button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            updateConnectionDraft('groupPath', groupPath);
                            setGroupPickerOpen(false);
                          }}
                          type="button"
                        >
                          <Folder size={14} />
                          <span>{groupPath}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </label>
              <label>
                <span>{t('fieldHost')}</span>
                <input value={connectionDraft.host} onChange={(event) => updateConnectionDraft('host', event.target.value)} />
              </label>
              <label>
                <span>{t('fieldPort')}</span>
                <input {...portTextInputProps} value={connectionDraft.port} onChange={(event) => updateConnectionDraft('port', Number(event.target.value) || (isRdpConnection ? 3389 : 22))} />
              </label>
              <label>
                <span>{t('fieldUsername')}</span>
                <input value={connectionDraft.username} onChange={(event) => updateConnectionDraft('username', event.target.value)} />
              </label>
              {!isRdpConnection ? (
                <div className="form-field">
                  <span>{t('fieldAuthMethod')}</span>
                  <CustomSelect
                    aria-label={t('fieldAuthMethod')}
                    value={connectionDraft.authMethod}
                    onChange={(val) => updateConnectionDraft('authMethod', val === 'privateKey' ? 'privateKey' : 'password')}
                    options={[
                      { value: 'password', label: t('authMethodPassword') },
                      { value: 'privateKey', label: t('authMethodPrivateKey') },
                    ]}
                  />
                </div>
              ) : (
                <div className="connection-rdp-hint">
                  <Monitor size={16} />
                  <span>{t('connectionRdpHint')}</span>
                </div>
              )}
              {isPrivateKeyMode ? (
                <>
                  <label className="span-2">
                    <span>{t('fieldPrivateKeyPath')}</span>
                    <input
                      placeholder={t('privateKeyPathPlaceholder')}
                      value={connectionDraft.privateKeyPath}
                      onChange={(event) => updateConnectionDraft('privateKeyPath', event.target.value)}
                    />
                  </label>
                  <label className="span-2">
                    <span>{t('fieldPrivateKeyText')}</span>
                    <textarea
                      placeholder={t('privateKeyTextPlaceholder')}
                      rows={6}
                      value={connectionDraft.privateKeyText}
                      onChange={(event) => updateConnectionDraft('privateKeyText', event.target.value)}
                    />
                  </label>
                  <label className="span-2">
                    <span>{t('fieldPassphrase')}</span>
                    <div className="password-field">
                      <input
                        type={revealPassphrase ? 'text' : 'password'}
                        value={connectionDraft.passphrase}
                        onChange={(event) => updateConnectionDraft('passphrase', event.target.value)}
                      />
                      <button
                        aria-label={passphraseToggleLabel}
                        className="secondary-button slim password-toggle-button"
                        onClick={() => setRevealPassphrase((value) => !value)}
                        title={passphraseToggleLabel}
                        type="button"
                      >
                        {revealPassphrase ? <EyeOff size={16} /> : <Eye size={16} />}
                        <span>{passphraseToggleLabel}</span>
                      </button>
                    </div>
                  </label>
                  <p className="field-hint span-2">{t('privateKeyHint')}</p>
                </>
              ) : (
                <label className="span-2">
                  <span>{t('fieldPassword')}</span>
                  <div className="password-field">
                    <input
                      type={revealPassword ? 'text' : 'password'}
                      value={connectionDraft.password}
                      onChange={(event) => updateConnectionDraft('password', event.target.value)}
                    />
                    <button
                      aria-label={passwordToggleLabel}
                      className="secondary-button slim password-toggle-button"
                      onClick={() => setRevealPassword((value) => !value)}
                      title={passwordToggleLabel}
                      type="button"
                    >
                      {revealPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      <span>{passwordToggleLabel}</span>
                    </button>
                  </div>
                </label>
              )}
              <label className="span-2">
                <span>{t('fieldNote')}</span>
                <textarea value={connectionDraft.note ?? ''} onChange={(event) => updateConnectionDraft('note', event.target.value)} rows={2} />
              </label>
            </div>
          </div>

          <div className={`connection-form-panel ${activeTab === 'jumpHosts' ? 'is-active' : ''}`}>
            <div className="connection-jump-hosts-toolbar">
              <div>
                <h4>{t('connectionTabJumpHosts')}</h4>
                <p>{t('connectionTabJumpHostsDesc')}</p>
              </div>
              <button className="secondary-button slim" onClick={addJumpHost} type="button">
                <Plus size={14} /> {t('addJumpHost')}
              </button>
            </div>
            {connectionDraft.jumpHosts.length ? (
              <div className="connection-jump-host-list">
                {connectionDraft.jumpHosts.map((jumpHost, index) => {
                  const isPrivateKeyModeForJump = jumpHost.authMethod === 'privateKey';
                  return (
                    <section key={jumpHost.id} className="connection-jump-host-card">
                      <div className="connection-jump-host-card-header">
                        <strong>{t('jumpHostTitle', { index: index + 1 })}</strong>
                        <div className="connection-jump-host-card-actions">
                          <button className="ghost-button slim" disabled={index === 0} onClick={() => moveJumpHost(jumpHost.id, -1)} type="button">
                            <ChevronUp size={14} />
                          </button>
                          <button className="ghost-button slim" disabled={index === connectionDraft.jumpHosts.length - 1} onClick={() => moveJumpHost(jumpHost.id, 1)} type="button">
                            <ChevronDown size={14} />
                          </button>
                          <button className="ghost-button slim danger-button" onClick={() => deleteJumpHost(jumpHost.id)} type="button">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                      <div className="form-grid connection-jump-host-grid">
                        <label>
                          <span>{t('fieldName')}</span>
                          <input value={jumpHost.name ?? ''} onChange={(event) => updateJumpHost(jumpHost.id, { name: event.target.value })} />
                        </label>
                        <label>
                          <span>{t('fieldHost')}</span>
                          <input value={jumpHost.host} onChange={(event) => updateJumpHost(jumpHost.id, { host: event.target.value })} />
                        </label>
                        <label>
                          <span>{t('fieldPort')}</span>
                          <input
                            {...portTextInputProps}
                            value={jumpHost.port}
                            onChange={(event) => updateJumpHost(jumpHost.id, { port: Number(event.target.value) || 22 })}
                          />
                        </label>
                        <label>
                          <span>{t('fieldUsername')}</span>
                          <input value={jumpHost.username} onChange={(event) => updateJumpHost(jumpHost.id, { username: event.target.value })} />
                        </label>
                        <div className="form-field">
                          <span>{t('fieldAuthMethod')}</span>
                          <CustomSelect
                            aria-label={t('fieldAuthMethod')}
                            value={jumpHost.authMethod}
                            onChange={(val) => updateJumpHost(jumpHost.id, {
                              authMethod: val === 'privateKey' ? 'privateKey' : 'password',
                            })}
                            options={[
                              { value: 'password', label: t('authMethodPassword') },
                              { value: 'privateKey', label: t('authMethodPrivateKey') },
                            ]}
                          />
                        </div>
                        {isPrivateKeyModeForJump ? (
                          <>
                            <label className="span-2">
                              <span>{t('fieldPrivateKeyPath')}</span>
                              <input
                                placeholder={t('privateKeyPathPlaceholder')}
                                value={jumpHost.privateKeyPath ?? ''}
                                onChange={(event) => updateJumpHost(jumpHost.id, { privateKeyPath: event.target.value })}
                              />
                            </label>
                            <label className="span-2">
                              <span>{t('fieldPrivateKeyText')}</span>
                              <textarea
                                placeholder={t('privateKeyTextPlaceholder')}
                                rows={4}
                                value={jumpHost.privateKeyText ?? ''}
                                onChange={(event) => updateJumpHost(jumpHost.id, { privateKeyText: event.target.value })}
                              />
                            </label>
                            <label className="span-2">
                              <span>{t('fieldPassphrase')}</span>
                              <input
                                type="password"
                                value={jumpHost.passphrase ?? ''}
                                onChange={(event) => updateJumpHost(jumpHost.id, { passphrase: event.target.value })}
                              />
                            </label>
                          </>
                        ) : (
                          <label className="span-2">
                            <span>{t('fieldPassword')}</span>
                            <input
                              type="password"
                              value={jumpHost.password ?? ''}
                              onChange={(event) => updateJumpHost(jumpHost.id, { password: event.target.value })}
                            />
                          </label>
                        )}
                      </div>
                    </section>
                  );
                })}
              </div>
            ) : (
              <div className="empty-state">{t('connectionTabJumpHostsEmpty')}</div>
            )}
          </div>

          <div className={`connection-form-panel ${activeTab === 'proxy' ? 'is-active' : ''}`}>
            <div className="connection-proxy-toolbar">
              <div>
                <h4>{t('connectionTabProxy')}</h4>
                <p>{t('connectionTabProxyDesc')}</p>
              </div>
            </div>
            <div className="agent-toggle-field connection-proxy-toggle">
              <span>{t('enabled')}</span>
              <input
                aria-label={t('enabled')}
                checked={connectionDraft.proxy.enabled}
                type="checkbox"
                onChange={(event) => updateProxy({ enabled: event.target.checked })}
              />
              <strong>{connectionDraft.proxy.enabled ? t('enabled') : t('disabled')}</strong>
            </div>
            <div className="form-grid">
              <div className="form-field">
                <span>{t('fieldProxyType')}</span>
                <CustomSelect
                  aria-label={t('fieldProxyType')}
                  disabled={!connectionDraft.proxy.enabled}
                  value={connectionDraft.proxy.type}
                  onChange={(val) => updateProxy({ type: val === 'http' ? 'http' : 'socks5' })}
                  options={[
                    { value: 'socks5', label: t('proxyTypeSocks5') },
                    { value: 'http', label: t('proxyTypeHttp') },
                  ]}
                />
              </div>
              <label>
                <span>{t('fieldHost')}</span>
                <input
                  disabled={!connectionDraft.proxy.enabled}
                  value={connectionDraft.proxy.host}
                  onChange={(event) => updateProxy({ host: event.target.value })}
                />
              </label>
              <label>
                <span>{t('fieldPort')}</span>
                <input
                  disabled={!connectionDraft.proxy.enabled}
                  {...portTextInputProps}
                  value={connectionDraft.proxy.port}
                  onChange={(event) => updateProxy({ port: Number(event.target.value) || 1080 })}
                />
              </label>
              <label>
                <span>{t('fieldUsername')}</span>
                <input
                  disabled={!connectionDraft.proxy.enabled}
                  value={connectionDraft.proxy.username ?? ''}
                  onChange={(event) => updateProxy({ username: event.target.value })}
                />
              </label>
              <label className="span-2">
                <span>{t('fieldPassword')}</span>
                <input
                  disabled={!connectionDraft.proxy.enabled}
                  type="password"
                  value={connectionDraft.proxy.password ?? ''}
                  onChange={(event) => updateProxy({ password: event.target.value })}
                />
              </label>
            </div>
          </div>
        </div>

        <div className="connection-form-feedback">
          {/* 校验和测试结果固定在同一个反馈行里，避免提示数量变化时打乱弹窗网格高度。 */}
          {validationKey ? <p className="field-hint validation-hint">{t(validationKey)}</p> : null}
          {connectionTestResult ? (
            <p className={`field-hint connection-test-result ${connectionTestResult.kind === 'error' ? 'is-error' : 'is-success'}`}>
              {connectionTestResult.message}
            </p>
          ) : null}
        </div>

        <div className="modal-actions">
          <button className="secondary-button" onClick={closeConnectionForm} type="button">
            {t('cancel')}
          </button>
          <button className="secondary-button" disabled={loading} onClick={() => void testConnectionDraft()} type="button">
            {t(isRdpConnection ? 'testRdpConnection' : 'testConnection')}
          </button>
          <button className="primary-button" disabled={!canSubmit} onClick={() => void saveConnectionDraft()} type="button">
            {t('saveConnection')}
          </button>
        </div>
      </div>
    </div>
  );
}
