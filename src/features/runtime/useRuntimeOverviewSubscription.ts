/* 运行概览事件订阅 Hook：负责与后端 Worker 建立独占推送流并响应页面可见性 */
import { useEffect, useRef, useState } from 'react';
import { backend } from '../../backend';
import type { RuntimeOverviewEvent, RuntimeOverviewSnapshot } from '../../types';

interface UseRuntimeOverviewSubscriptionOptions {
  connectionId?: string;
  enabled?: boolean;
}

interface UseRuntimeOverviewSubscriptionResult {
  snapshot: RuntimeOverviewSnapshot | null;
  error: string | null;
  isPaused: boolean;
  retryInMs: number;
  sequence: number;
  isRefreshing: boolean;
  refresh: () => Promise<void>;
  setPaused: (paused: boolean) => Promise<void>;
}

// 单调代次跨 StrictMode effect 重建递增；时间戳保证 Vite HMR 重载模块后仍大于旧订阅代次。
let lastRuntimeMonitorGeneration = 0;
const nextRuntimeMonitorGeneration = () => {
  lastRuntimeMonitorGeneration = Math.max(Date.now(), lastRuntimeMonitorGeneration + 1);
  return lastRuntimeMonitorGeneration;
};

export const useRuntimeOverviewSubscription = ({
  connectionId,
  enabled = true,
}: UseRuntimeOverviewSubscriptionOptions): UseRuntimeOverviewSubscriptionResult => {
  const [snapshot, setSnapshot] = useState<RuntimeOverviewSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [retryInMs, setRetryInMs] = useState<number>(0);
  const [sequence, setSequence] = useState<number>(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // 记录当前活跃的订阅 ID，避免旧 Worker 的滞后事件污染新连接
  const activeSubscriptionIdRef = useRef<string | null>(null);
  const activeConnectionIdRef = useRef<string | undefined>(connectionId);
  const lastSequenceRef = useRef(0);
  activeConnectionIdRef.current = connectionId;

  // 1. 订阅后端事件流与 Worker 启停生命周期
  useEffect(() => {
    if (!connectionId || !enabled) {
      setSnapshot(null);
      setError(null);
      setRetryInMs(0);
      setSequence(0);
      setIsRefreshing(false);
      activeSubscriptionIdRef.current = null;
      lastSequenceRef.current = 0;
      return;
    }

    // 订阅 ID 必须在 listener/start 之前由前端生成；所有控制命令都携带它，确保旧 effect 只能停止自己。
    const subscriptionId = crypto.randomUUID();
    const generation = nextRuntimeMonitorGeneration();
    activeSubscriptionIdRef.current = subscriptionId;
    lastSequenceRef.current = 0;
    setSnapshot(null);
    setError(null);
    setRetryInMs(0);
    setSequence(0);
    setIsRefreshing(true);

    let unlisten: (() => void) | null = null;
    let isMounted = true;

    const setup = async () => {
      try {
        // 必须先注册当前 Webview 的定向监听器，再启动可能立即发首帧的 Rust worker。
        const unlistenFn = await backend.listenRuntimeOverview(subscriptionId, connectionId, (event: RuntimeOverviewEvent) => {
          if (!isMounted) return;

          // 连接、订阅和序号必须同时匹配；错误事件也推进序号，避免乱序快照覆盖较新状态。
          if (
            event.connectionId !== activeConnectionIdRef.current ||
            event.subscriptionId !== activeSubscriptionIdRef.current ||
            event.sequence <= lastSequenceRef.current
          ) {
            return;
          }
          lastSequenceRef.current = event.sequence;

          if (event.kind === 'snapshot') {
            setSnapshot(event.snapshot);
            setError(null);
            setRetryInMs(0);
            setSequence(event.sequence);
            setIsRefreshing(false);
          } else if (event.kind === 'error') {
            setError(event.message);
            setRetryInMs(event.retryInMs);
            setSequence(event.sequence);
            setIsRefreshing(false);
          }
        });

        unlisten = unlistenFn;

        if (!isMounted) {
          unlistenFn();
          return;
        }

        // 概览固定每秒采样；start 返回前若 effect 已失效，只停止同一 subscriptionId，不影响替代者。
        await backend.startRuntimeOverviewMonitor(connectionId, subscriptionId, generation);
        if (!isMounted) {
          void backend.stopRuntimeOverviewMonitor(subscriptionId);
        } else if (document.hidden) {
          // start 发生在页面已隐藏的边界下时补发暂停，避免错过此前的 visibilitychange。
          setIsPaused(true);
          await backend.setRuntimeOverviewMonitorPaused(subscriptionId, true);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : String(err));
          setIsRefreshing(false);
        }
      }
    };

    void setup();

    return () => {
      isMounted = false;
      if (activeSubscriptionIdRef.current === subscriptionId) {
        activeSubscriptionIdRef.current = null;
      }
      if (unlisten) {
        unlisten();
      }
      void backend.stopRuntimeOverviewMonitor(subscriptionId);
    };
  }, [connectionId, enabled]);

  // 2. 页面可见性联动：窗口最小化或后台切 tab 时自动向后端 Worker 发送 Pause/Resume 控制
  useEffect(() => {
    if (!connectionId || !enabled) return;

    const handleVisibilityChange = () => {
      const isHidden = document.hidden;
      setIsPaused(isHidden);
      const subscriptionId = activeSubscriptionIdRef.current;
      if (subscriptionId) {
        void backend.setRuntimeOverviewMonitorPaused(subscriptionId, isHidden).catch((err) => {
          setError(err instanceof Error ? err.message : String(err));
        });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [connectionId, enabled]);

  // 手动刷新命令
  const refresh = async () => {
    if (!connectionId || !enabled) return;
    const subscriptionId = activeSubscriptionIdRef.current;
    if (!subscriptionId) return;
    setIsRefreshing(true);
    try {
      await backend.refreshRuntimeOverviewMonitor(subscriptionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIsRefreshing(false);
    }
  };

  // 手动控制暂停/恢复
  const setPaused = async (paused: boolean) => {
    if (!connectionId || !enabled) return;
    const subscriptionId = activeSubscriptionIdRef.current;
    if (!subscriptionId) return;
    setIsPaused(paused);
    try {
      await backend.setRuntimeOverviewMonitorPaused(subscriptionId, paused);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return {
    snapshot,
    error,
    isPaused,
    retryInMs,
    sequence,
    isRefreshing,
    refresh,
    setPaused,
  };
};
