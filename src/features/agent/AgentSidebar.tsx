import { lazy, Suspense, type ReactNode, type RefObject } from 'react';
import { Bot, ShieldCheck, Trash2 } from 'lucide-react';

import { buildPreviewFontFamily } from '../../app/fonts';
import { buildAgentChatFontFamily } from '../../terminalFonts';
import type { TranslationKey } from '../../i18n';
import type { AgentBridgeRequest, AgentProvider, AppSettings } from '../../types';
import { sidePanelMinWidth } from '../workspace/layout';

const AgentChatPanel = lazy(() => import('../../AgentChatPanel').then((module) => ({ default: module.AgentChatPanel })));

type Props = {
  approvalRequests: AgentBridgeRequest[];
  bodyRef: RefObject<HTMLDivElement | null>;
  collapsed: boolean;
  mounted: boolean;
  onApproveRequest: (request: AgentBridgeRequest) => void;
  onClearRequests: () => void;
  onRejectRequest: (request: AgentBridgeRequest) => void;
  onTabChange: (tab: 'chat' | 'requests') => void;
  providers: AgentProvider[];
  requestPanel: ReactNode;
  settings: AppSettings;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
  tab: 'chat' | 'requests';
  width: number;
};

// AI 侧栏在首次展开后保持挂载，页签切换只隐藏 DOM，避免中断流式响应和审批上下文。
export function AgentSidebar({
  approvalRequests,
  bodyRef,
  collapsed,
  mounted,
  onApproveRequest,
  onClearRequests,
  onRejectRequest,
  onTabChange,
  providers,
  requestPanel,
  settings,
  t,
  tab,
  width,
}: Props) {
  if (collapsed && !mounted) {
    return null;
  }

  return (
    <aside className={`agent-sidebar card ${collapsed ? 'is-hidden' : ''}`} style={{ minWidth: sidePanelMinWidth, width }}>
      <header className="agent-sidebar-header panel-tab-row">
        <div className="tab-list">
          <button className={`panel-tab ${tab === 'chat' ? 'is-active' : ''}`} onClick={() => onTabChange('chat')} type="button">
            <Bot size={16} />
            <span>{t('panelAgentChat')}</span>
          </button>
          <button className={`panel-tab ${tab === 'requests' ? 'is-active' : ''}`} onClick={() => onTabChange('requests')} type="button">
            <ShieldCheck size={16} />
            <span>{t('panelAgentRequests')}</span>
          </button>
        </div>
        {tab === 'requests' ? (
          <button className="secondary-button slim" onClick={onClearRequests} type="button">
            <Trash2 size={14} /> {t('clearAgentBridgeRequests')}
          </button>
        ) : null}
      </header>
      <div ref={bodyRef} className="agent-sidebar-body">
        <div className={`agent-sidebar-tab-panel ${tab === 'chat' ? '' : 'is-hidden'}`}>
          <Suspense fallback={<div className="empty-state">{t('working')}</div>}>
            <AgentChatPanel
              approvalRequests={approvalRequests}
              codeFontFamily={buildPreviewFontFamily(settings)}
              fontFamily={buildAgentChatFontFamily(
                settings.agentChatLatinFontFamily || settings.shellLatinFontFamily || settings.shellFontFamily,
                settings.agentChatCjkFontFamily || settings.shellCjkFontFamily || settings.shellLatinFontFamily || settings.shellFontFamily,
              )}
              fontSize={settings.agentChatFontSize || settings.shellFontSize}
              lineHeight={settings.agentChatLineHeight ?? 1.6}
              onApproveRequest={onApproveRequest}
              onRejectRequest={onRejectRequest}
              providers={providers}
              t={t}
            />
          </Suspense>
        </div>
        <div className={`agent-sidebar-tab-panel ${tab === 'requests' ? '' : 'is-hidden'}`}>
          {requestPanel}
        </div>
      </div>
    </aside>
  );
}
