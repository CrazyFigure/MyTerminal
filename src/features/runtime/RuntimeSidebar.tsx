/* 运行监控隔离侧边栏：封装订阅与明细自调度轮询，隔离 1 秒更新频率，避免引起全局重新渲染 */
import React, { useState, useMemo, useCallback } from 'react';
import { Cpu, HardDrive, MemoryStick, Network, Globe, Clock } from 'lucide-react';

import type { TranslationKey } from '../../i18n';
import type { AppSettings, RuntimeResourceSource } from '../../types';
import {
  formatMetricConnections,
  formatMetricPercent,
  formatMetricUptime,
  formatMetricUsedTotal,
} from './presentation';
import { RuntimePanel, type RuntimeSummaryItem } from './RuntimePanel';
import { useRuntimeMonitor } from './useRuntimeMonitor';
import { useRuntimeOverviewSubscription } from './useRuntimeOverviewSubscription';

interface RuntimeSidebarProps {
  activeRemoteConnectionId?: string;
  activeRemoteConnectionHost?: string;
  hasActiveRemoteSession: boolean;
  height: number;
  settings: AppSettings;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
}

export const RuntimeSidebar = React.memo(function RuntimeSidebar({
  activeRemoteConnectionId,
  activeRemoteConnectionHost,
  hasActiveRemoteSession,
  height,
  settings,
  t,
}: RuntimeSidebarProps) {
  // 1. 本地折叠展开状态，完全收敛在侧边栏内部，不污染全局 Store
  const [cpuCoresExpanded, setCpuCoresExpanded] = useState(false);
  const [memoryResourcesExpanded, setMemoryResourcesExpanded] = useState(false);
  const [connectionsExpanded, setConnectionsExpanded] = useState(false);

  // 2. 运行概览独占事件流订阅
  const {
    snapshot,
    error: subscriptionError,
    isRefreshing,
    refresh,
  } = useRuntimeOverviewSubscription({
    connectionId: activeRemoteConnectionId,
    enabled: hasActiveRemoteSession,
  });

  // 3. 明细自调度轮询
  const {
    runtimeConnections,
    runtimeConnectionsError,
    runtimeConnectionsLoading,
    runtimeResourceError,
    runtimeResourceLoading,
    runtimeResourceMetric,
    runtimeResourceTarget,
    runtimeResourceUsage,
    setRuntimeResourceMetric,
    setRuntimeResourceTarget,
  } = useRuntimeMonitor({
    activeRemoteConnectionId,
    connectionsExpanded,
    memoryResourcesExpanded,
    setConnectionsExpanded,
    setCpuCoresExpanded,
    setMemoryResourcesExpanded,
    settings,
  });

  // 4. 组装概览展示项
  const runtimeItems = useMemo<RuntimeSummaryItem[]>(() => {
    return [
      {
        id: 'cpu',
        icon: Cpu,
        label: t('metricCpu'),
        percent: snapshot?.cpu.percent ?? undefined,
        value: formatMetricPercent(snapshot?.cpu.percent),
      },
      {
        id: 'memory',
        icon: MemoryStick,
        label: t('metricMemory'),
        percent: snapshot?.memory.percent ?? undefined,
        value: formatMetricUsedTotal(snapshot?.memory.usedKib, snapshot?.memory.totalKib),
      },
      {
        id: 'storage',
        icon: HardDrive,
        label: t('metricStorage'),
        percent: snapshot?.storage.percent ?? undefined,
        value: formatMetricUsedTotal(snapshot?.storage.usedKib, snapshot?.storage.totalKib),
      },
      {
        id: 'connections',
        icon: Network,
        label: t('metricConnections'),
        value: formatMetricConnections(snapshot?.connections),
      },
      {
        id: 'network',
        icon: Globe,
        label: t('metricNetwork'),
        value: snapshot?.primaryAddress || snapshot?.host || activeRemoteConnectionHost || '---',
      },
      {
        id: 'uptime',
        icon: Clock,
        label: t('metricUptime'),
        value: formatMetricUptime(snapshot?.uptimeSeconds),
      },
    ];
  }, [activeRemoteConnectionHost, snapshot, t]);

  // 来源标签转换
  const runtimeResourceSourceLabel = useCallback((source: RuntimeResourceSource): string => {
    switch (source) {
      case 'docker':
        return t('runtimeResourceSourceDocker');
      case 'podman':
        return t('runtimeResourceSourcePodman');
      case 'kubernetes':
        return t('runtimeResourceSourceKubernetes');
      case 'system':
      default:
        return t('runtimeResourceSourceSystem');
    }
  }, [t]);

  const runtimeHostLabel = hasActiveRemoteSession
    ? snapshot?.host || activeRemoteConnectionHost || '--'
    : '--';

  return (
    <RuntimePanel
      activeRemoteConnectionId={activeRemoteConnectionId}
      connectionsExpanded={connectionsExpanded}
      cpuCoresExpanded={cpuCoresExpanded}
      hasActiveRemoteSession={hasActiveRemoteSession}
      height={height}
      memoryResourcesExpanded={memoryResourcesExpanded}
      onRefresh={refresh}
      runtimeConnections={runtimeConnections}
      runtimeConnectionsError={runtimeConnectionsError}
      runtimeConnectionsLoading={runtimeConnectionsLoading}
      runtimeHostLabel={runtimeHostLabel}
      runtimeItems={runtimeItems}
      runtimeError={subscriptionError ?? ''}
      runtimeLoading={isRefreshing}
      runtimeResourceError={runtimeResourceError}
      runtimeResourceLoading={runtimeResourceLoading}
      runtimeResourceMetric={runtimeResourceMetric}
      runtimeResourceSource={settings.runtimeResourceSource ?? 'system'}
      runtimeResourceSourceLabel={runtimeResourceSourceLabel}
      runtimeResourceTarget={runtimeResourceTarget}
      runtimeResourceUsage={runtimeResourceUsage ?? undefined}
      setConnectionsExpanded={setConnectionsExpanded}
      setCpuCoresExpanded={setCpuCoresExpanded}
      setMemoryResourcesExpanded={setMemoryResourcesExpanded}
      setRuntimeResourceMetric={setRuntimeResourceMetric}
      setRuntimeResourceTarget={setRuntimeResourceTarget}
      snapshot={snapshot}
      t={t}
    />
  );
});
