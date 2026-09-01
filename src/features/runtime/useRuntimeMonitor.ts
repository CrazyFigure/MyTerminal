import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';

import { backend } from '../../backend';
import type {
  AppSettings,
  RuntimeConnectionList,
  RuntimeResourceMetric,
  RuntimeResourceTarget,
  RuntimeResourceUsage,
} from '../../types';
import { runtimeResourceDetailLimit } from './presentation';

type RuntimeMonitorOptions = {
  activeRemoteConnectionId?: string;
  connectionsExpanded: boolean;
  memoryResourcesExpanded: boolean;
  setConnectionsExpanded: Dispatch<SetStateAction<boolean>>;
  setCpuCoresExpanded: Dispatch<SetStateAction<boolean>>;
  setMemoryResourcesExpanded: Dispatch<SetStateAction<boolean>>;
  settings: AppSettings;
};

// 运行状态监视器只为进程/线程与连接列表启动按需自调度轮询；存储仅保留概览用量，不再执行高成本全盘扫描。
export function useRuntimeMonitor({
  activeRemoteConnectionId,
  connectionsExpanded,
  memoryResourcesExpanded,
  setConnectionsExpanded,
  setCpuCoresExpanded,
  setMemoryResourcesExpanded,
  settings,
}: RuntimeMonitorOptions) {
  const [runtimeResourceMetric, setRuntimeResourceMetric] = useState<RuntimeResourceMetric>('memory');
  const [runtimeResourceTarget, setRuntimeResourceTarget] = useState<RuntimeResourceTarget>('process');
  const [runtimeResourceUsage, setRuntimeResourceUsage] = useState<RuntimeResourceUsage | null>(null);
  const [runtimeResourceLoading, setRuntimeResourceLoading] = useState(false);
  const [runtimeResourceError, setRuntimeResourceError] = useState('');
  const [runtimeConnections, setRuntimeConnections] = useState<RuntimeConnectionList | null>(null);
  const [runtimeConnectionsLoading, setRuntimeConnectionsLoading] = useState(false);
  const [runtimeConnectionsError, setRuntimeConnectionsError] = useState('');

  const runtimeResourceRefreshSeqRef = useRef(0);
  const runtimeResourceEmptyStreakRef = useRef(0);
  const runtimeConnectionsRefreshSeqRef = useRef(0);

  // 切换主机、来源、排序指标或进程/线程口径时旧列表语义已失效，立即清空并重新建立空结果计数。
  useEffect(() => {
    runtimeResourceEmptyStreakRef.current = 0;
    setRuntimeResourceUsage(null);
    setRuntimeResourceError('');
  }, [activeRemoteConnectionId, runtimeResourceMetric, runtimeResourceTarget, settings.runtimeResourceSource]);

  // 1. 资源明细（进程/内存）自调度轮询
  useEffect(() => {
    if (!memoryResourcesExpanded || !activeRemoteConnectionId) {
      runtimeResourceRefreshSeqRef.current += 1;
      runtimeResourceEmptyStreakRef.current = 0;
      setRuntimeResourceLoading(false);
      setRuntimeResourceUsage(null);
      setRuntimeResourceError('');
      return undefined;
    }

    let active = true;
    let timer: number | null = null;

    const queryCycle = async () => {
      if (!active) return;
      const requestSeq = ++runtimeResourceRefreshSeqRef.current;
      setRuntimeResourceLoading(true);
      setRuntimeResourceError('');

      try {
        const usage = await backend.getRuntimeResourceUsage(activeRemoteConnectionId, {
          source: settings.runtimeResourceSource ?? 'system',
          metric: runtimeResourceMetric,
          target: runtimeResourceTarget,
          limit: runtimeResourceDetailLimit,
        });
        if (!active || requestSeq !== runtimeResourceRefreshSeqRef.current) return;
        if (usage.items.length > 0) {
          runtimeResourceEmptyStreakRef.current = 0;
          setRuntimeResourceUsage(usage);
        } else {
          // 单次空结果可能来自远端工具瞬时超时；已有列表先保留，连续两次确认为空后再展示空态。
          runtimeResourceEmptyStreakRef.current += 1;
          setRuntimeResourceUsage((current) => (
            !current || current.items.length === 0 || runtimeResourceEmptyStreakRef.current >= 2
              ? usage
              : current
          ));
        }
        setRuntimeResourceError(usage.error ?? '');
      } catch (error) {
        if (!active || requestSeq !== runtimeResourceRefreshSeqRef.current) return;
        setRuntimeResourceError(error instanceof Error ? error.message : String(error));
      } finally {
        if (active && requestSeq === runtimeResourceRefreshSeqRef.current) {
          setRuntimeResourceLoading(false);
          const delay = Math.max(1, settings.runtimeResourceRefreshIntervalSec ?? 3) * 1000;
          timer = window.setTimeout(queryCycle, delay);
        }
      }
    };

    void queryCycle();

    return () => {
      active = false;
      runtimeResourceRefreshSeqRef.current += 1;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [
    activeRemoteConnectionId,
    memoryResourcesExpanded,
    runtimeResourceMetric,
    runtimeResourceTarget,
    settings.runtimeResourceRefreshIntervalSec,
    settings.runtimeResourceSource,
  ]);

  // 2. 连接明细与进程明细共用“明细刷新频率”，避免为轻量展开项再增加一个设置。
  useEffect(() => {
    if (!connectionsExpanded || !activeRemoteConnectionId) {
      runtimeConnectionsRefreshSeqRef.current += 1;
      setRuntimeConnectionsLoading(false);
      setRuntimeConnections(null);
      setRuntimeConnectionsError('');
      return undefined;
    }

    let active = true;
    let timer: number | null = null;

    const queryCycle = async () => {
      if (!active) return;
      const requestSeq = ++runtimeConnectionsRefreshSeqRef.current;
      setRuntimeConnectionsLoading(true);
      setRuntimeConnectionsError('');

      try {
        const list = await backend.getRuntimeConnectionList(activeRemoteConnectionId);
        if (!active || requestSeq !== runtimeConnectionsRefreshSeqRef.current) return;
        // 传输错误返回的空列表不能覆盖上一份成功数据；真实无连接时 error 为空，仍会正常切换到空态。
        setRuntimeConnections((current) => (
          list.error && current?.items.length ? current : list
        ));
        setRuntimeConnectionsError(list.error ?? '');
      } catch (error) {
        if (!active || requestSeq !== runtimeConnectionsRefreshSeqRef.current) return;
        setRuntimeConnectionsError(error instanceof Error ? error.message : String(error));
      } finally {
        if (active && requestSeq === runtimeConnectionsRefreshSeqRef.current) {
          setRuntimeConnectionsLoading(false);
          const delay = Math.max(1, settings.runtimeResourceRefreshIntervalSec ?? 3) * 1000;
          timer = window.setTimeout(queryCycle, delay);
        }
      }
    };

    void queryCycle();

    return () => {
      active = false;
      runtimeConnectionsRefreshSeqRef.current += 1;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [activeRemoteConnectionId, connectionsExpanded, settings.runtimeResourceRefreshIntervalSec]);

  // 两类明细全部收起时立即释放 Rust 侧专用 SSH Session；切换连接或组件卸载也释放旧连接缓存。
  useEffect(() => {
    if (activeRemoteConnectionId && !memoryResourcesExpanded && !connectionsExpanded) {
      // 清理命令属于尽力而为：窗口退出或后端热重载时失败不能形成未处理的 Promise 拒绝。
      void backend.releaseRuntimeDetailSession(activeRemoteConnectionId).catch(() => undefined);
    }
  }, [activeRemoteConnectionId, connectionsExpanded, memoryResourcesExpanded]);

  useEffect(() => {
    if (!activeRemoteConnectionId) return undefined;
    const connectionId = activeRemoteConnectionId;
    return () => {
      void backend.releaseRuntimeDetailSession(connectionId).catch(() => undefined);
    };
  }, [activeRemoteConnectionId]);

  // 3. 活动远端连接变化时收起按需明细并清空缓存，避免短暂展示上一台主机的数据。
  useEffect(() => {
    setCpuCoresExpanded(false);
    setMemoryResourcesExpanded(false);
    setConnectionsExpanded(false);
    setRuntimeResourceUsage(null);
    setRuntimeResourceError('');
    setRuntimeConnections(null);
    setRuntimeConnectionsError('');
  }, [activeRemoteConnectionId, setConnectionsExpanded, setCpuCoresExpanded, setMemoryResourcesExpanded]);

  return {
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
  };
}
