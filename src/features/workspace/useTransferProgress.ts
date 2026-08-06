import { useCallback, useEffect, useRef, useState } from 'react';

import { clamp } from '../../app/layout';
import type { TransferProgressItem } from './TransferProgressStack';

// 传输进度 Hook 统一任务创建、阶段更新、失败保留和成功自动消失，并在卸载时回收所有计时器。
export function useTransferProgress(successMessage: string) {
  const [items, setItems] = useState<TransferProgressItem[]>([]);
  const dismissTimersRef = useRef(new Set<number>());

  const dismiss = useCallback((id: string) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const run = useCallback(async (
    title: string,
    task: (setPercent: (percent: number) => void) => Promise<void>,
  ) => {
    const id = crypto.randomUUID();
    const setPercent = (percent: number) => {
      setItems((current) => current.map((item) => (
        item.id === id ? { ...item, percent: clamp(percent, 0, 100) } : item
      )));
    };

    setItems((current) => [
      { id, title, percent: 8, status: 'running' },
      ...current.slice(0, 3),
    ]);
    try {
      // 只在业务关键阶段更新百分比，避免高频 setState 与终端输入争抢渲染资源。
      await task(setPercent);
      setItems((current) => current.map((item) => (
        item.id === id
          ? { ...item, percent: 100, status: 'success', message: successMessage }
          : item
      )));
      const timer = window.setTimeout(() => {
        dismissTimersRef.current.delete(timer);
        dismiss(id);
      }, 3000);
      dismissTimersRef.current.add(timer);
    } catch (error) {
      setItems((current) => current.map((item) => (
        item.id === id
          ? {
              ...item,
              percent: 100,
              status: 'error',
              message: error instanceof Error ? error.message : String(error),
            }
          : item
      )));
    }
  }, [dismiss, successMessage]);

  useEffect(() => () => {
    for (const timer of dismissTimersRef.current) {
      window.clearTimeout(timer);
    }
    dismissTimersRef.current.clear();
  }, []);

  return { dismiss, items, run };
}
