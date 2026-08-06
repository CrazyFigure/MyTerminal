import type { RefObject } from 'react';
import { ChevronDown, ChevronUp, Pencil, Play, Plus, RefreshCw, Square } from 'lucide-react';

import { translateStatus, type TranslationKey } from '../../i18n';
import type { AppSettings, HistoryEntry, TunnelRecord } from '../../types';
import {
  bottomTabs,
  buildActionButtonStyle,
  renderActionButtonLabel,
  type BottomPanelTab,
} from './actionButtons';

type Props = {
  actionsRef: RefObject<HTMLDivElement | null>;
  activeBottomTab: BottomPanelTab;
  activeCommand: string;
  activeConnectionId?: string;
  activeRemoteConnectionId?: string;
  activeSessionId?: string;
  collapsed: boolean;
  compactActions: boolean;
  connectionHistory: HistoryEntry[];
  connectionTunnels: TunnelRecord[];
  hasActiveRemoteSession: boolean;
  height: number;
  historyLoading: boolean;
  onChangeCommand: (command: string) => void;
  onChangeTab: (tab: BottomPanelTab) => void;
  onCloseTunnel: (tunnelId: string) => void | Promise<unknown>;
  onEditTunnel: (tunnel: TunnelRecord) => void;
  onOpenTunnel: () => void | Promise<unknown>;
  onRefreshHistory: () => void | Promise<unknown>;
  onSelectHistory: (command: string) => void;
  onSendCommand: () => void | Promise<unknown>;
  onStartAllTunnels: () => void | Promise<unknown>;
  onStartTunnel: (tunnelId: string) => void | Promise<unknown>;
  onStopAllTunnels: () => void | Promise<unknown>;
  onToggleCollapsed: () => void;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
  uiLanguage: AppSettings['uiLanguage'];
};

// 底部工作台聚合命令草稿、隧道控制和远端历史三个视图；上层负责实际副作用与连接级页签记忆。
export function BottomDock({
  actionsRef,
  activeBottomTab,
  activeCommand,
  activeConnectionId,
  activeRemoteConnectionId,
  activeSessionId,
  collapsed,
  compactActions,
  connectionHistory,
  connectionTunnels,
  hasActiveRemoteSession,
  height,
  historyLoading,
  onChangeCommand,
  onChangeTab,
  onCloseTunnel,
  onEditTunnel,
  onOpenTunnel,
  onRefreshHistory,
  onSelectHistory,
  onSendCommand,
  onStartAllTunnels,
  onStartTunnel,
  onStopAllTunnels,
  onToggleCollapsed,
  t,
  uiLanguage,
}: Props) {
  return (
    <section className={`bottom-dock card ${collapsed ? 'is-collapsed' : ''}`} style={collapsed ? undefined : { height }}>
      <header className="panel-tab-row">
        <div className="tab-list">
          {bottomTabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                className={`panel-tab ${activeBottomTab === tab.id ? 'is-active' : ''}`}
                onClick={() => onChangeTab(tab.id)}
                type="button"
              >
                <Icon size={16} />
                <span>{t(tab.labelKey)}</span>
              </button>
            );
          })}
        </div>
        <div ref={actionsRef} className={`panel-tab-actions ${compactActions ? 'is-compact-actions' : ''}`}>
          <button
            className="secondary-button slim"
            onClick={onToggleCollapsed}
            style={buildActionButtonStyle(collapsed ? t('expandBottomDock') : t('collapseBottomDock'), compactActions)}
            title={collapsed ? t('expandBottomDock') : t('collapseBottomDock')}
            type="button"
          >
            {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {renderActionButtonLabel(collapsed ? t('expandBottomDock') : t('collapseBottomDock'), compactActions)}
          </button>
          {activeBottomTab === 'commands' ? (
            <button
              className="primary-button"
              disabled={!hasActiveRemoteSession || !activeCommand.trim()}
              onClick={() => void onSendCommand()}
              style={buildActionButtonStyle(t('sendToTerminal'), compactActions)}
              type="button"
            >
              <Play size={16} /> {renderActionButtonLabel(t('sendToTerminal'), compactActions)}
            </button>
          ) : null}
          {activeBottomTab === 'tunnels' ? (
            <>
              <button
                className="secondary-button"
                disabled={!connectionTunnels.some((item) => item.status !== 'running')}
                onClick={() => void onStartAllTunnels()}
                style={buildActionButtonStyle(t('tunnelStartAll'), compactActions)}
                type="button"
              >
                <Play size={16} /> {renderActionButtonLabel(t('tunnelStartAll'), compactActions)}
              </button>
              <button
                className="secondary-button"
                disabled={!connectionTunnels.some((item) => item.status === 'running')}
                onClick={() => void onStopAllTunnels()}
                style={buildActionButtonStyle(t('tunnelStopAll'), compactActions)}
                type="button"
              >
                <Square size={16} /> {renderActionButtonLabel(t('tunnelStopAll'), compactActions)}
              </button>
              <button
                className="primary-button"
                disabled={!activeConnectionId}
                onClick={() => void onOpenTunnel()}
                style={buildActionButtonStyle(t('newTunnel'), compactActions)}
                type="button"
              >
                <Plus size={16} /> {renderActionButtonLabel(t('newTunnel'), compactActions)}
              </button>
            </>
          ) : null}
          {activeBottomTab === 'history' ? (
            <button
              className="secondary-button slim"
              disabled={!activeRemoteConnectionId}
              onClick={() => void onRefreshHistory()}
              style={buildActionButtonStyle(t('refresh'), compactActions)}
              type="button"
            >
              <RefreshCw className={historyLoading ? 'is-spinning' : ''} size={14} />
              {renderActionButtonLabel(t('refresh'), compactActions)}
            </button>
          ) : null}
        </div>
      </header>

      <div className="panel-body dock-body">
        {activeBottomTab === 'commands' ? (
          <div className="stack command-panel fill-height">
            <textarea
              className="command-editor"
              disabled={!hasActiveRemoteSession}
              placeholder={t('commandTextareaPlaceholder')}
              rows={8}
              spellCheck={false}
              value={activeCommand}
              onChange={(event) => onChangeCommand(event.target.value)}
            />
          </div>
        ) : null}

        {activeBottomTab === 'tunnels' ? (
          <div className="stack panel-stack">
            <div className="tunnel-grid">
              {connectionTunnels.length ? connectionTunnels.map((tunnel) => (
                <div key={tunnel.id} className="tunnel-card">
                  <div>
                    <strong>{tunnel.name}</strong>
                    <p>{tunnel.bindAddress}:{tunnel.localPort}{' -> '}{tunnel.remoteHost}:{tunnel.remotePort}</p>
                  </div>
                  <div className="section-row compact">
                    <span className={`status-badge status-${tunnel.status}`}>{translateStatus(uiLanguage, tunnel.status)}</span>
                    <button className="ghost-button slim" onClick={() => onEditTunnel(tunnel)} type="button">
                      <Pencil size={14} /> {t('edit')}
                    </button>
                    {tunnel.status === 'running' ? (
                      <button className="ghost-button slim" onClick={() => void onCloseTunnel(tunnel.id)} type="button">
                        <Square size={14} /> {t('stop')}
                      </button>
                    ) : (
                      <button className="ghost-button slim" onClick={() => void onStartTunnel(tunnel.id)} type="button">
                        <Play size={14} /> {t('start')}
                      </button>
                    )}
                  </div>
                </div>
              )) : <div className="empty-state">{t('noTunnels')}</div>}
            </div>
          </div>
        ) : null}

        {activeBottomTab === 'history' ? (
          <div className="stack panel-stack">
            <div className="history-list">
              {connectionHistory.length ? connectionHistory.map((item) => (
                <button
                  key={item.id}
                  className="history-row"
                  disabled={!activeSessionId}
                  onClick={() => onSelectHistory(item.command)}
                  type="button"
                >
                  <strong>{item.command}</strong>
                  <span>{item.executedAt ? new Date(item.executedAt).toLocaleString() : '—'}</span>
                </button>
              )) : historyLoading ? (
                <div className="panel-loading-overlay is-inline">
                  <RefreshCw className="is-spinning" size={18} />
                  <span>{t('panelRefreshing')}</span>
                </div>
              ) : <div className="empty-state">{t('noHistory')}</div>}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
