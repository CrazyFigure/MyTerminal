import {
  useCallback,
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
  RuntimeStorageFiles,
} from '../../types';
import { runtimeResourceDetailLimit } from './presentation';

type RuntimeMonitorOptions = {
  activeRemoteConnectionId?: string;
  connectionsExpanded: boolean;
  memoryResourcesExpanded: boolean;
  refreshRuntimeOverview: () => Promise<void>;
  setConnectionsExpanded: Dispatch<SetStateAction<boolean>>;
  setCpuCoresExpanded: Dispatch<SetStateAction<boolean>>;
  setMemoryResourcesExpanded: Dispatch<SetStateAction<boolean>>;
  setStorageFilesExpanded: Dispatch<SetStateAction<boolean>>;
  settings: AppSettings;
  storageFilesExpanded: boolean;
};

// 运行状态监视器按展开态启动三个明细轮询，并用序号丢弃切换连接后的迟到响应。
export function useRuntimeMonitor({
  activeRemoteConnectionId,
  connectionsExpanded,
  memoryResourcesExpanded,
  refreshRuntimeOverview,
  setConnectionsExpanded,
  setCpuCoresExpanded,
  setMemoryResourcesExpanded,
  setStorageFilesExpanded,
  settings,
  storageFilesExpanded,
}: RuntimeMonitorOptions) {
  const [runtimeResourceMetric, setRuntimeResourceMetric] = useState<RuntimeResourceMetric>('memory');
  const [runtimeResourceTarget, setRuntimeResourceTarget] = useState<RuntimeResourceTarget>('process');
  const [runtimeResourceUsage, setRuntimeResourceUsage] = useState<RuntimeResourceUsage | null>(null);
  const [runtimeResourceLoading, setRuntimeResourceLoading] = useState(false);
  const [runtimeResourceError, setRuntimeResourceError] = useState('');
  const [runtimeStorageFiles, setRuntimeStorageFiles] = useState<RuntimeStorageFiles | null>(null);
  const [runtimeStorageFilesLoading, setRuntimeStorageFilesLoading] = useState(false);
  const [runtimeStorageFilesError, setRuntimeStorageFilesError] = useState('');
  const [runtimeConnections, setRuntimeConnections] = useState<RuntimeConnectionList | null>(null);
  const [runtimeConnectionsLoading, setRuntimeConnectionsLoading] = useState(false);
  const [runtimeConnectionsError, setRuntimeConnectionsError] = useState('');
  const runtimeRefreshInFlightRef = useRef(false);
  const runtimeRefreshPendingRef = useRef(false);
  const runtimeResourceRefreshSeqRef = useRef(0);
  const runtimeResourceRefreshInFlightRef = useRef(false);
  const runtimeStorageFilesRefreshSeqRef = useRef(0);
  const runtimeStorageFilesRefreshInFlightRef = useRef(false);
  const runtimeConnectionsRefreshSeqRef = useRef(0);
  const runtimeConnectionsRefreshInFlightRef = useRef(false);

  const refreshRuntimeOverviewOnce = useCallback(() => {
    // 正在刷新时不并发重入，只记下“还需再刷一次”的诉求；否则切换连接时新刷新会被丢弃，
    // 导致运行状态加载动画一直空转到下一次定时器才恢复。
    if (runtimeRefreshInFlightRef.current) {
      runtimeRefreshPendingRef.current = true;
      return;
    }
    const run = () => {
      runtimeRefreshInFlightRef.current = true;
      runtimeRefreshPendingRef.current = false;
      void refreshRuntimeOverview().finally(() => {
        runtimeRefreshInFlightRef.current = false;
        // 刷新期间若又发起过（如切换了连接），补跑一次以覆盖最新的活动连接，避免漏刷。
        if (runtimeRefreshPendingRef.current) {
          run();
        }
      });
    };
    run();
  }, [refreshRuntimeOverview]);

  const refreshRuntimeResourceUsageOnce = useCallback(() => {
    if (!activeRemoteConnectionId || !memoryResourcesExpanded || runtimeResourceRefreshInFlightRef.current) {
      return;
    }

    const requestSeq = ++runtimeResourceRefreshSeqRef.current;
    runtimeResourceRefreshInFlightRef.current = true;
    setRuntimeResourceLoading(true);
    setRuntimeResourceError('');
    void backend.fetchRuntimeResourceUsage(activeRemoteConnectionId, {
      source: settings.runtimeResourceSource ?? 'system',
      metric: runtimeResourceMetric,
      target: runtimeResourceTarget,
      limit: runtimeResourceDetailLimit,
    }).then((usage) => {
      if (requestSeq !== runtimeResourceRefreshSeqRef.current) {
        return;
      }
      setRuntimeResourceUsage(usage);
      setRuntimeResourceError(usage.error ?? '');
    }).catch((error) => {
      if (requestSeq !== runtimeResourceRefreshSeqRef.current) {
        return;
      }
      // 刷新失败时保留旧明细，避免网络抖动或远端命令慢导致展开区突然清空。
      setRuntimeResourceError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (requestSeq === runtimeResourceRefreshSeqRef.current) {
        runtimeResourceRefreshInFlightRef.current = false;
        setRuntimeResourceLoading(false);
      }
    });
  }, [activeRemoteConnectionId, memoryResourcesExpanded, runtimeResourceMetric, runtimeResourceTarget, settings.runtimeResourceSource]);

  useEffect(() => {
    if (!memoryResourcesExpanded || !activeRemoteConnectionId) {
      runtimeResourceRefreshSeqRef.current += 1;
      runtimeResourceRefreshInFlightRef.current = false;
      setRuntimeResourceLoading(false);
      return undefined;
    }

    // 内存明细展开、切换 CPU/内存、切换进程/线程或来源设置变化时都会立即刷新一次。
    // 后续按资源设置里的进程状态刷新频率轮询；收起时 cleanup 会关闭轮询。
    refreshRuntimeResourceUsageOnce();
    const timer = window.setInterval(
      refreshRuntimeResourceUsageOnce,
      Math.max(1, settings.runtimeResourceRefreshIntervalSec ?? 3) * 1000,
    );
    return () => {
      runtimeResourceRefreshSeqRef.current += 1;
      runtimeResourceRefreshInFlightRef.current = false;
      window.clearInterval(timer);
    };
  }, [activeRemoteConnectionId, memoryResourcesExpanded, refreshRuntimeResourceUsageOnce, settings.runtimeResourceRefreshIntervalSec]);

  // 存储最大文件扫描按展开态触发；未选连接或已收起时直接跳过，减少远端磁盘遍历。
  const refreshRuntimeStorageFilesOnce = useCallback(() => {
    if (!activeRemoteConnectionId || !storageFilesExpanded || runtimeStorageFilesRefreshInFlightRef.current) {
      return;
    }

    const requestSeq = ++runtimeStorageFilesRefreshSeqRef.current;
    runtimeStorageFilesRefreshInFlightRef.current = true;
    setRuntimeStorageFilesLoading(true);
    setRuntimeStorageFilesError('');
    void backend.fetchRuntimeStorageFiles(activeRemoteConnectionId).then((files) => {
      if (requestSeq !== runtimeStorageFilesRefreshSeqRef.current) {
        return;
      }
      setRuntimeStorageFiles(files);
      setRuntimeStorageFilesError(files.error ?? '');
    }).catch((error) => {
      if (requestSeq !== runtimeStorageFilesRefreshSeqRef.current) {
        return;
      }
      // 刷新失败时保留旧文件列表，避免一次扫描超时导致已展示的大文件数据消失。
      setRuntimeStorageFilesError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (requestSeq === runtimeStorageFilesRefreshSeqRef.current) {
        runtimeStorageFilesRefreshInFlightRef.current = false;
        setRuntimeStorageFilesLoading(false);
      }
    });
  }, [activeRemoteConnectionId, storageFilesExpanded]);

  useEffect(() => {
    if (!storageFilesExpanded || !activeRemoteConnectionId) {
      runtimeStorageFilesRefreshSeqRef.current += 1;
      runtimeStorageFilesRefreshInFlightRef.current = false;
      setRuntimeStorageFilesLoading(false);
      return undefined;
    }

    // 存储展开时立即扫描一次，后续按资源设置里的大文件状态刷新频率轮询；收起时 cleanup 会关闭轮询。
    refreshRuntimeStorageFilesOnce();
    const timer = window.setInterval(
      refreshRuntimeStorageFilesOnce,
      Math.max(5, settings.runtimeStorageRefreshIntervalSec ?? 5) * 1000,
    );
    return () => {
      runtimeStorageFilesRefreshSeqRef.current += 1;
      runtimeStorageFilesRefreshInFlightRef.current = false;
      window.clearInterval(timer);
    };
  }, [activeRemoteConnectionId, refreshRuntimeStorageFilesOnce, settings.runtimeStorageRefreshIntervalSec, storageFilesExpanded]);

  // 连接明细按展开态触发；读取 /proc 网络表开销小，但仍只在本行展开时才请求，收起即停止。
  const refreshRuntimeConnectionsOnce = useCallback(() => {
    if (!activeRemoteConnectionId || !connectionsExpanded || runtimeConnectionsRefreshInFlightRef.current) {
      return;
    }

    const requestSeq = ++runtimeConnectionsRefreshSeqRef.current;
    runtimeConnectionsRefreshInFlightRef.current = true;
    setRuntimeConnectionsLoading(true);
    setRuntimeConnectionsError('');
    void backend.fetchRuntimeConnectionList(activeRemoteConnectionId).then((list) => {
      if (requestSeq !== runtimeConnectionsRefreshSeqRef.current) {
        return;
      }
      setRuntimeConnections(list);
      setRuntimeConnectionsError(list.error ?? '');
    }).catch((error) => {
      if (requestSeq !== runtimeConnectionsRefreshSeqRef.current) {
        return;
      }
      // 刷新失败时保留旧明细，避免一次网络抖动清空已展示的连接列表。
      setRuntimeConnectionsError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (requestSeq === runtimeConnectionsRefreshSeqRef.current) {
        runtimeConnectionsRefreshInFlightRef.current = false;
        setRuntimeConnectionsLoading(false);
      }
    });
  }, [activeRemoteConnectionId, connectionsExpanded]);

  useEffect(() => {
    if (!connectionsExpanded || !activeRemoteConnectionId) {
      runtimeConnectionsRefreshSeqRef.current += 1;
      runtimeConnectionsRefreshInFlightRef.current = false;
      setRuntimeConnectionsLoading(false);
      return undefined;
    }

    // 展开时立即拉取一次，随后跟随运行状态主刷新频率轮询（最低 5 秒），与连接数主行保持同节奏。
    refreshRuntimeConnectionsOnce();
    const timer = window.setInterval(
      refreshRuntimeConnectionsOnce,
      Math.max(5, settings.runtimeRefreshIntervalSec) * 1000,
    );
    return () => {
      runtimeConnectionsRefreshSeqRef.current += 1;
      runtimeConnectionsRefreshInFlightRef.current = false;
      window.clearInterval(timer);
    };
  }, [activeRemoteConnectionId, connectionsExpanded, refreshRuntimeConnectionsOnce, settings.runtimeRefreshIntervalSec]);

  // 活动远端连接变化时（关闭 SSH tab、切到其它连接或断开），收起运行状态所有下拉并清空已暂存的明细。
  // 否则下拉会停留在上一个连接的内存/存储数据上：无连接时轮询已停止无法刷新，看起来像卡死；
  // 切到其它连接时又会短暂显示旧连接数据，语义错误。收起后用户重新展开即按新连接重新拉取。
  useEffect(() => {
    setCpuCoresExpanded(false);
    setMemoryResourcesExpanded(false);
    setStorageFilesExpanded(false);
    setConnectionsExpanded(false);
    setRuntimeResourceUsage(null);
    setRuntimeResourceError('');
    setRuntimeStorageFiles(null);
    setRuntimeStorageFilesError('');
    setRuntimeConnections(null);
    setRuntimeConnectionsError('');
  }, [activeRemoteConnectionId]);


  return {
    refreshRuntimeOverviewOnce,
    runtimeConnections,
    runtimeConnectionsError,
    runtimeConnectionsLoading,
    runtimeResourceError,
    runtimeResourceLoading,
    runtimeResourceMetric,
    runtimeResourceTarget,
    runtimeResourceUsage,
    runtimeStorageFiles,
    runtimeStorageFilesError,
    runtimeStorageFilesLoading,
    setRuntimeResourceMetric,
    setRuntimeResourceTarget,
  };
}
