import { useCallback, useEffect, useRef, useState } from 'react';

import { clamp } from '../../app/layout';
import type { TransferProgressItem } from './TransferProgressStack';

// 传输进度 Hook 统一任务创建、阶段更新、失败保留和成功自动消失，并在卸载时回收所有计时器。
export function useTransferProgress(
  successMessage: string,
  cancellingMessage: string,
  cancelledMessage: string,
) {
  const [items, setItems] = useState<TransferProgressItem[]>([]);
  const dismissTimersRef = useRef(new Set<number>());
  const cancelTasksRef = useRef(new Map<string, () => Promise<boolean>>());
  const cancellationRequestedRef = useRef(new Set<string>());

  const dismiss = useCallback((id: string) => {
    cancelTasksRef.current.delete(id);
    cancellationRequestedRef.current.delete(id);
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  // 后端字节事件只更新对应任务；准备阶段保留不确定进度，不能用阶段常量冒充百分比。
  const report = useCallback((id: string, percent: number, message?: string, indeterminate = false) => {
    setItems((current) => current.map((item) => (
      item.id === id && item.status === 'running'
        ? { ...item, percent: clamp(percent, 0, 100), message, indeterminate }
        : item
    )));
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

  const runTracked = useCallback(async (
    title: string,
    task: (id: string) => Promise<void>,
    cancelTask: (id: string) => Promise<boolean>,
  ) => {
    const id = crypto.randomUUID();
    cancelTasksRef.current.set(id, () => cancelTask(id));
    setItems((current) => [
      { id, title, percent: 0, status: 'running', indeterminate: true, cancellable: true },
      ...current.slice(0, 3),
    ]);
    try {
      await task(id);
      cancelTasksRef.current.delete(id);
      cancellationRequestedRef.current.delete(id);
      setItems((current) => current.map((item) => (
        item.id === id
          ? { ...item, percent: 100, status: 'success', message: successMessage, indeterminate: false, cancellable: false }
          : item
      )));
      const timer = window.setTimeout(() => {
        dismissTimersRef.current.delete(timer);
        dismiss(id);
      }, 3000);
      dismissTimersRef.current.add(timer);
    } catch (error) {
      const wasCancelled = cancellationRequestedRef.current.delete(id);
      cancelTasksRef.current.delete(id);
      setItems((current) => current.map((item) => (
        item.id === id
          ? {
              ...item,
              status: wasCancelled ? 'cancelled' : 'error',
              message: wasCancelled
                ? cancelledMessage
                : error instanceof Error ? error.message : String(error),
              indeterminate: false,
              cancellable: false,
            }
          : item
      )));
    }
  }, [cancelledMessage, dismiss, successMessage]);

  const cancel = useCallback((id: string) => {
    const cancelTask = cancelTasksRef.current.get(id);
    if (!cancelTask || cancellationRequestedRef.current.has(id)) {
      return;
    }
    cancellationRequestedRef.current.add(id);
    setItems((current) => current.map((item) => (
      item.id === id
        ? { ...item, status: 'cancelling', message: cancellingMessage, indeterminate: true }
        : item
    )));
    void cancelTask().then((accepted) => {
      if (!accepted) {
        cancellationRequestedRef.current.delete(id);
        setItems((current) => current.map((item) => (
          item.id === id && item.status === 'cancelling'
            ? { ...item, status: 'running', message: undefined, indeterminate: false }
            : item
        )));
      }
    }).catch((error) => {
      cancellationRequestedRef.current.delete(id);
      cancelTasksRef.current.delete(id);
      setItems((current) => current.map((item) => (
        item.id === id
          ? {
              ...item,
              status: 'error',
              message: error instanceof Error ? error.message : String(error),
              indeterminate: false,
              cancellable: false,
            }
          : item
      )));
    });
  }, [cancellingMessage]);

  useEffect(() => () => {
    for (const timer of dismissTimersRef.current) {
      window.clearTimeout(timer);
    }
    dismissTimersRef.current.clear();
    cancelTasksRef.current.clear();
    cancellationRequestedRef.current.clear();
  }, []);

  return { cancel, dismiss, items, report, run, runTracked };
}
