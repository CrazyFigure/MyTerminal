import type { Dispatch, SetStateAction } from 'react';
import { ChevronDown, ChevronRight, Play, X } from 'lucide-react';

import type { TranslationKey } from '../../i18n';
import type { AgentBridgeRequest, ConnectionProfile } from '../../types';
import { getAgentRequestMachineLabel, getAgentRequestSummary } from './requestPresentation';

type AgentRequestPanelProps = {
  approveRequest: (request: AgentBridgeRequest) => void;
  commandEdits: Record<string, string>;
  connections: ConnectionProfile[];
  expandedRequestIds: Record<string, boolean>;
  rejectRequest: (request: AgentBridgeRequest) => void;
  requests: AgentBridgeRequest[];
  setCommandEdits: Dispatch<SetStateAction<Record<string, string>>>;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
  toggleExpanded: (request: AgentBridgeRequest) => void;
};

// Agent 请求卡片是统一的只读审计/审批视图，外部只注入审批用例和本地编辑草稿。
export function AgentRequestPanel({
  approveRequest,
  commandEdits,
  connections,
  expandedRequestIds,
  rejectRequest,
  requests,
  setCommandEdits,
  t,
  toggleExpanded,
}: AgentRequestPanelProps) {
  return (
    <div className="stack panel-stack agent-request-panel">
      {requests.length ? requests.map((request) => {
        const isExpanded = expandedRequestIds[request.id] ?? request.status === 'pending';
        const machineLabel = getAgentRequestMachineLabel(request, connections);
        const summaryLabel = getAgentRequestSummary(request);
        const executionResult = request.result as { executionMode?: string; fallbackReason?: string } | undefined;
        const executionModeLabel = executionResult?.executionMode
          ? executionResult.executionMode === 'terminal'
            ? t('agentRequestModeTerminal')
            : `${t('agentRequestModeHidden')}${executionResult.fallbackReason ? `（${executionResult.fallbackReason}）` : ''}`
          : '';

        return (
          <div key={request.id} className={`agent-request-card status-${request.status} ${isExpanded ? 'is-expanded' : 'is-collapsed'}`}>
            <button aria-expanded={isExpanded} className="agent-request-header" onClick={() => toggleExpanded(request)} type="button">
              {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              <span className="agent-request-title">
                <strong>{request.kind}</strong>
                <span>{request.title} · {new Date(request.createdAt).toLocaleString()}</span>
              </span>
              <span className={`status-badge status-${request.status}`}>{request.status}</span>
            </button>
            <div className="agent-request-summary">
              <span>{t('agentRequestMachine')}</span><strong>{machineLabel}</strong>
              <span>{request.kind === 'run_command' ? t('agentRequestCommand') : t('agentRequestTarget')}</span><strong>{summaryLabel}</strong>
              {executionModeLabel ? <><span>{t('agentRequestExecutionMode')}</span><strong>{executionModeLabel}</strong></> : null}
            </div>
            {isExpanded ? (
              <>
                {request.kind === 'run_command' ? (
                  <label>
                    <span>{t('agentRequestCommand')}</span>
                    <textarea
                      disabled={request.status !== 'pending' || Boolean(request.conversationId)}
                      rows={3}
                      spellCheck={false}
                      value={commandEdits[request.id] ?? request.command ?? ''}
                      onChange={(event) => setCommandEdits((current) => ({ ...current, [request.id]: event.target.value }))}
                    />
                  </label>
                ) : null}
                {request.path ? <p className="agent-request-path">{request.path}{request.newPath ? ` -> ${request.newPath}` : ''}</p> : null}
                {request.contentPreview ? <pre className="agent-request-output">{request.contentPreview}</pre> : null}
                {request.logs.length ? <div className="agent-request-logs">{request.logs.map((line, index) => <span key={`${request.id}-log-${index}`}>{line}</span>)}</div> : null}
                {request.error ? <div className="sync-action-feedback is-error">{request.error}</div> : null}
                {request.result ? <pre className="agent-request-output">{JSON.stringify(request.result, null, 2)}</pre> : null}
                {request.status === 'pending' && request.conversationId ? <div className="agent-request-record-hint">{t('agentRequestApproveInChat')}</div> : null}
                {request.status === 'pending' && !request.conversationId ? (
                  <div className="section-row compact">
                    <button className="primary-button" onClick={() => approveRequest(request)} type="button"><Play size={16} /> {t('approveAgentRequest')}</button>
                    <button className="secondary-button" onClick={() => rejectRequest(request)} type="button"><X size={16} /> {t('rejectAgentRequest')}</button>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        );
      }) : <div className="empty-state">{t('agentBridgeRequestsEmpty')}</div>}
    </div>
  );
}
