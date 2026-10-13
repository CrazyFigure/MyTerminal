import { useEffect, useRef, type CSSProperties } from 'react';
import { Check, Info } from 'lucide-react';

export type FloatingToastTone = 'success' | 'error' | 'info';

type FloatingToastProps = {
  message: string;
  tone: FloatingToastTone;
  // 操作解释可以延长阅读时间，已有成功与错误提示仍默认一秒。
  durationMs?: number;
  onDismiss: () => void;
};

// 局部悬浮提示挂载在所属页面或弹窗内，按指定时长自动清理，不占用正文布局。
export function FloatingToast({ message, tone, durationMs = 1000, onDismiss }: FloatingToastProps) {
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    // 展示周期包含入场和退场动画；消息或时长变化时重新计时。
    const timer = window.setTimeout(() => onDismissRef.current(), durationMs);
    return () => window.clearTimeout(timer);
  }, [durationMs, message, tone]);

  return (
    <div className="floating-toast-layer" aria-live={tone === 'error' ? 'assertive' : 'polite'}>
      <div
        className={`floating-toast is-${tone}`}
        role={tone === 'error' ? 'alert' : 'status'}
        style={{ animationDuration: `${durationMs}ms` } as CSSProperties}
      >
        <span className="floating-toast-status-icon" aria-hidden="true">
          {tone === 'success' ? <Check size={11} strokeWidth={3} />
            : tone === 'info' ? <Info size={14} />
              : <span className="floating-toast-error-mark">!</span>}
        </span>
        <span>{message}</span>
      </div>
    </div>
  );
}
