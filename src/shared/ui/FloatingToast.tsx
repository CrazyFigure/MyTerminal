import { useEffect, useRef } from 'react';
import { Check } from 'lucide-react';

export type FloatingToastTone = 'success' | 'error';

type FloatingToastProps = {
  message: string;
  tone: FloatingToastTone;
  onDismiss: () => void;
};

// 局部悬浮提示始终挂载在所属页面或弹窗内，并在一秒后自动清理，避免反馈占用表单布局。
export function FloatingToast({ message, tone, onDismiss }: FloatingToastProps) {
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    // 一秒展示周期包含入场和退场动画；消息变化时重新计时，连续操作仍能看到最新结果。
    const timer = window.setTimeout(() => onDismissRef.current(), 1000);
    return () => window.clearTimeout(timer);
  }, [message, tone]);

  return (
    <div className="floating-toast-layer" aria-live={tone === 'error' ? 'assertive' : 'polite'}>
      <div className={`floating-toast is-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
        <span className="floating-toast-status-icon" aria-hidden="true">
          {tone === 'success' ? <Check size={11} strokeWidth={3} /> : <span className="floating-toast-error-mark">!</span>}
        </span>
        <span>{message}</span>
      </div>
    </div>
  );
}
