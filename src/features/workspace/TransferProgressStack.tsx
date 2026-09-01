import { X } from 'lucide-react';

import { Tooltip } from '../../components/Tooltip';

export type TransferProgressItem = {
  id: string;
  title: string;
  percent: number;
  status: 'running' | 'cancelling' | 'cancelled' | 'success' | 'error';
  message?: string;
  indeterminate?: boolean;
  cancellable?: boolean;
};

type Props = {
  cancel: (id: string) => void;
  cancelLabel: string;
  dismiss: (id: string) => void;
  items: TransferProgressItem[];
};

// 传输反馈层只展示任务阶段；上传、下载、编辑和错误处理仍由应用用例编排。
export function TransferProgressStack({ cancel, cancelLabel, dismiss, items }: Props) {
  if (!items.length) {
    return null;
  }

  return (
    <div className="transfer-progress-stack">
      {items.map((item) => (
        <div key={item.id} className={`transfer-progress-card is-${item.status}`}>
          <div className="section-row compact">
            <strong>{item.title}</strong>
            <Tooltip content={item.cancellable && item.status === 'running' ? cancelLabel : undefined} side="left">
              <button
                aria-label={item.cancellable && item.status === 'running' ? cancelLabel : undefined}
                className="icon-button transfer-progress-close"
                disabled={item.status === 'cancelling'}
                onClick={() => {
                  if (item.cancellable && item.status === 'running') {
                    cancel(item.id);
                  } else {
                    dismiss(item.id);
                  }
                }}
                type="button"
              >
                <X size={12} />
              </button>
            </Tooltip>
          </div>
          <div className={`transfer-progress-track ${item.indeterminate ? 'is-indeterminate' : ''}`}>
            <span className="transfer-progress-fill" style={{ width: `${item.percent}%` }} />
          </div>
          <span>{item.message ?? `${item.percent.toFixed(0)}%`}</span>
        </div>
      ))}
    </div>
  );
}
