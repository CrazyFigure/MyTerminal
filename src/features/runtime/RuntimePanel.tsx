import type { Dispatch, SetStateAction } from 'react';
import { RefreshCw, type LucideIcon } from 'lucide-react';

import type { TranslationKey } from '../../i18n';
import { clamp } from '../../shared/numbers';
import { Tooltip } from '../../components/Tooltip';
import type {
  RuntimeConnectionList,
  RuntimeOverview,
  RuntimeResourceMetric,
  RuntimeResourceSource,
  RuntimeResourceTarget,
  RuntimeResourceUsage,
  RuntimeStorageFiles,
} from '../../types';
import { metricTone } from './presentation';

export type RuntimeSummaryItem = {
  id: string;
  icon: LucideIcon;
  label: string;
  percent?: number;
  value: string;
};

type RuntimePanelProps = {
  activeRemoteConnectionId?: string;
  connectionsExpanded: boolean;
  cpuCoresExpanded: boolean;
  hasActiveRemoteSession: boolean;
  height: number;
  memoryResourcesExpanded: boolean;
  onRefresh: () => void;
  runtimeConnections?: RuntimeConnectionList;
  runtimeConnectionsError: string;
  runtimeConnectionsLoading: boolean;
  runtimeHostLabel: string;
  runtimeItems: RuntimeSummaryItem[];
  runtimeLoading: boolean;
  runtimeOverview?: RuntimeOverview;
  runtimeResourceError: string;
  runtimeResourceLoading: boolean;
  runtimeResourceMetric: RuntimeResourceMetric;
  runtimeResourceSource: RuntimeResourceSource;
  runtimeResourceSourceLabel: (source: RuntimeResourceSource) => string;
  runtimeResourceTarget: RuntimeResourceTarget;
  runtimeResourceUsage?: RuntimeResourceUsage;
  runtimeStorageFiles?: RuntimeStorageFiles;
  runtimeStorageFilesError: string;
  runtimeStorageFilesLoading: boolean;
  setConnectionsExpanded: Dispatch<SetStateAction<boolean>>;
  setCpuCoresExpanded: Dispatch<SetStateAction<boolean>>;
  setMemoryResourcesExpanded: Dispatch<SetStateAction<boolean>>;
  setRuntimeResourceMetric: Dispatch<SetStateAction<RuntimeResourceMetric>>;
  setRuntimeResourceTarget: Dispatch<SetStateAction<RuntimeResourceTarget>>;
  setStorageFilesExpanded: Dispatch<SetStateAction<boolean>>;
  storageFilesExpanded: boolean;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
};

// 运行状态面板只负责展示与展开交互；远端轮询节奏仍由 App 的用例编排控制。
export function RuntimePanel({
  activeRemoteConnectionId,
  connectionsExpanded,
  cpuCoresExpanded,
  hasActiveRemoteSession,
  height,
  memoryResourcesExpanded,
  onRefresh,
  runtimeConnections,
  runtimeConnectionsError,
  runtimeConnectionsLoading,
  runtimeHostLabel,
  runtimeItems,
  runtimeLoading,
  runtimeOverview,
  runtimeResourceError,
  runtimeResourceLoading,
  runtimeResourceMetric,
  runtimeResourceSource,
  runtimeResourceSourceLabel,
  runtimeResourceTarget,
  runtimeResourceUsage,
  runtimeStorageFiles,
  runtimeStorageFilesError,
  runtimeStorageFilesLoading,
  setConnectionsExpanded,
  setCpuCoresExpanded,
  setMemoryResourcesExpanded,
  setRuntimeResourceMetric,
  setRuntimeResourceTarget,
  setStorageFilesExpanded,
  storageFilesExpanded,
  t,
}: RuntimePanelProps) {
  return (
    <section className="sidebar-panel runtime-panel" style={{ height }}>
      <div className="section-row runtime-header">
        <h3>{runtimeHostLabel}</h3>
        <button className="icon-button" disabled={!hasActiveRemoteSession} onClick={onRefresh} type="button">
          <RefreshCw className={runtimeLoading ? 'is-spinning' : ''} size={16} />
        </button>
      </div>

      <div className={`runtime-list ${runtimeLoading && !runtimeOverview ? 'is-panel-loading' : ''}`}>
        {runtimeLoading && !runtimeOverview ? (
          <div className="panel-loading-overlay">
            <RefreshCw className="is-spinning" size={18} />
            <span>{t('panelRefreshing')}</span>
          </div>
        ) : null}
        {runtimeItems.map(({ id, icon: Icon, label, percent, value }) => {
          const isCpuMetric = id === 'cpu';
          const isMemoryMetric = id === 'memory';
          const isStorageMetric = id === 'storage';
          const isConnectionsMetric = id === 'connections';
          const cpuCoreCount = runtimeOverview?.cpuCores?.length ?? 0;
          const isCpuExpandable = isCpuMetric && cpuCoreCount > 0;
          const isMemoryExpandable = isMemoryMetric && Boolean(activeRemoteConnectionId);
          const isStorageExpandable = isStorageMetric && Boolean(activeRemoteConnectionId);
          const isConnectionsExpandable = isConnectionsMetric && Boolean(activeRemoteConnectionId);
          const isExpandableMetric = isCpuExpandable || isMemoryExpandable || isStorageExpandable || isConnectionsExpandable;
          const expanded = isCpuMetric
            ? cpuCoresExpanded
            : isMemoryMetric
              ? memoryResourcesExpanded
              : isStorageMetric
                ? storageFilesExpanded
                : isConnectionsMetric
                  ? connectionsExpanded
                  : undefined;
          const controlsId = isCpuExpandable
            ? 'runtime-cpu-core-list'
            : isMemoryExpandable
              ? 'runtime-memory-resource-list'
              : isStorageExpandable
                ? 'runtime-storage-file-list'
                : isConnectionsExpandable
                  ? 'runtime-connection-list'
                  : undefined;
          return (
            <div key={id} className="runtime-row-group">
              <button
                aria-controls={controlsId}
                aria-expanded={isExpandableMetric ? expanded : undefined}
                className={`runtime-row metric-tone-${metricTone(percent)} ${isExpandableMetric ? 'is-expandable-metric-row is-clickable' : ''}`}
                disabled={!isExpandableMetric}
                onClick={() => {
                  if (isCpuExpandable) setCpuCoresExpanded((current) => !current);
                  if (isMemoryExpandable) setMemoryResourcesExpanded((current) => !current);
                  if (isStorageExpandable) setStorageFilesExpanded((current) => !current);
                  if (isConnectionsExpandable) setConnectionsExpanded((current) => !current);
                }}
                type="button"
              >
                <div className="metric-label"><Icon size={14} /><span>{label}</span></div>
                <div className="metric-bar-cell">
                  {percent !== undefined ? (
                    <div className="metric-progress-track" aria-label={`${label} ${percent.toFixed(0)}%`}>
                      <span className="metric-progress-fill" style={{ width: `${percent}%` }} />
                    </div>
                  ) : null}
                  <span className="metric-value">{value}</span>
                </div>
              </button>

              {isCpuMetric && cpuCoresExpanded && cpuCoreCount > 0 ? (
                <div className="runtime-core-list" id="runtime-cpu-core-list">
                  {runtimeOverview?.cpuCores.map((core) => {
                    const percentValue = clamp(core.percent, 0, 100);
                    return (
                      <div key={core.name} className={`runtime-core-row metric-tone-${metricTone(percentValue)}`}>
                        <span>{core.name}</span>
                        <div className="metric-bar-cell">
                          <div className="metric-progress-track" aria-label={`${core.name} ${percentValue.toFixed(0)}%`}>
                            <span className="metric-progress-fill" style={{ width: `${percentValue}%` }} />
                          </div>
                          <span className="metric-value">{percentValue.toFixed(0)}%</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {isMemoryMetric && memoryResourcesExpanded ? (
                <div className="runtime-resource-panel" id="runtime-memory-resource-list">
                  <div className="runtime-resource-toolbar">
                    <div className="runtime-segmented-control" aria-label={t('runtimeResourceMetric')}>
                      <button className={runtimeResourceMetric === 'memory' ? 'is-active' : ''} onClick={() => setRuntimeResourceMetric('memory')} type="button">{t('runtimeResourceMetricMemory')}</button>
                      <button className={runtimeResourceMetric === 'cpu' ? 'is-active' : ''} onClick={() => setRuntimeResourceMetric('cpu')} type="button">{t('runtimeResourceMetricCpu')}</button>
                    </div>
                    <div className="runtime-segmented-control" aria-label={t('runtimeResourceTarget')}>
                      <button className={runtimeResourceTarget === 'process' ? 'is-active' : ''} onClick={() => setRuntimeResourceTarget('process')} type="button">{t('runtimeResourceTargetProcess')}</button>
                      <button className={runtimeResourceTarget === 'thread' ? 'is-active' : ''} onClick={() => setRuntimeResourceTarget('thread')} type="button">{t('runtimeResourceTargetThread')}</button>
                    </div>
                  </div>
                  <div className="runtime-resource-header">
                    <span>#</span>
                    <span>{runtimeResourceTarget === 'thread' ? t('runtimeResourceTargetThread') : t('runtimeResourceTargetProcess')} · {runtimeResourceSourceLabel((runtimeResourceUsage?.source ?? runtimeResourceSource) as RuntimeResourceSource)}</span>
                    <span>{t('metricCpu')}</span><span>{t('metricMemory')}</span>
                  </div>
                  {runtimeResourceUsage?.items.length ? (
                    <div className="runtime-resource-table">
                      {runtimeResourceUsage.items.map((item, index) => (
                        <Tooltip content={item.detail} key={`${item.id}-${index}`} side="bottom">
                          <div className="runtime-resource-row">
                            <span className="runtime-resource-rank">{item.rank}</span>
                            <span className="runtime-resource-name"><strong>{item.name || item.id}</strong><small>{item.context}</small></span>
                            <span>{item.cpu}</span><span>{item.memory}</span>
                          </div>
                        </Tooltip>
                      ))}
                    </div>
                  ) : <div className="runtime-resource-empty">{runtimeResourceLoading ? t('panelRefreshing') : runtimeResourceError || t('runtimeResourceEmpty')}</div>}
                </div>
              ) : null}

              {isStorageMetric && storageFilesExpanded ? (
                <div className="runtime-storage-panel" id="runtime-storage-file-list">
                  <div className="runtime-storage-header"><span>#</span><span>{t('runtimeStorageFileName')}</span><span>{t('runtimeStorageFileSize')}</span></div>
                  {runtimeStorageFiles?.items.length ? (
                    <div className="runtime-storage-table">
                      {runtimeStorageFiles.items.map((item) => (
                        <Tooltip content={`${item.name}\n${item.path}\n${item.size}`} key={`${item.path}-${item.rank}`} side="bottom">
                          <div className="runtime-storage-row">
                            <span className="runtime-storage-rank">{item.rank}</span>
                            <span className="runtime-storage-file"><strong>{item.name}</strong><small>{item.path}</small></span>
                            <span className="runtime-storage-size">{item.size}</span>
                          </div>
                        </Tooltip>
                      ))}
                    </div>
                  ) : <div className="runtime-resource-empty">{runtimeStorageFilesLoading ? t('panelRefreshing') : runtimeStorageFilesError || t('runtimeStorageFilesEmpty')}</div>}
                </div>
              ) : null}

              {isConnectionsMetric && connectionsExpanded ? (
                <div className="runtime-connection-panel" id="runtime-connection-list">
                  <div className="runtime-connection-note">{t('runtimeConnectionsPerspective', { host: runtimeHostLabel })}</div>
                  <div className="runtime-connection-header"><span>#</span><span>{t('runtimeConnectionLocal')}</span><span>{t('runtimeConnectionRemote')}</span></div>
                  {runtimeConnections?.items.length ? (
                    <div className="runtime-connection-table">
                      {runtimeConnections.items.map((item, index) => (
                        <Tooltip content={`${item.local} ↔ ${item.remote}`} key={`${item.local}-${item.remote}-${index}`} side="bottom">
                          <div className="runtime-connection-row">
                            <span className="runtime-connection-rank">{index + 1}</span>
                            <span className="runtime-connection-addr">{item.isSsh ? <em className="runtime-connection-ssh-tag">SSH</em> : null}{item.local}</span>
                            <span className="runtime-connection-addr">{item.remote}</span>
                          </div>
                        </Tooltip>
                      ))}
                      {runtimeConnections.total > runtimeConnections.items.length ? <div className="runtime-resource-empty">{t('runtimeConnectionsOmitted', { count: runtimeConnections.total - runtimeConnections.items.length })}</div> : null}
                    </div>
                  ) : <div className="runtime-resource-empty">{runtimeConnectionsLoading ? t('panelRefreshing') : runtimeConnectionsError || t('runtimeConnectionsEmpty')}</div>}
                </div>
              ) : null}
            </div>
          );
        })}
        <div className="runtime-extra"><span>{runtimeOverview?.os ?? '--'}</span></div>
      </div>
    </section>
  );
}
