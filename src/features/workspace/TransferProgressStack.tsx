import { X } from 'lucide-react';

export type TransferProgressItem = {
  id: string;
  title: string;
  percent: number;
  status: 'running' | 'success' | 'error';
  message?: string;
};

type Props = {
  dismiss: (id: string) => void;
  items: TransferProgressItem[];
};

// 传输反馈层只展示任务阶段；上传、下载、编辑和错误处理仍由应用用例编排。
export function TransferProgressStack({ dismiss, items }: Props) {
  if (!items.length) {
    return null;
  }

  return (
    <div className="transfer-progress-stack">
      {items.map((item) => (
        <div key={item.id} className={`transfer-progress-card is-${item.status}`}>
          <div className="section-row compact">
            <strong>{item.title}</strong>
            <button className="icon-button transfer-progress-close" onClick={() => dismiss(item.id)} type="button">
              <X size={12} />
            </button>
          </div>
          <div className="transfer-progress-track">
            <span className="transfer-progress-fill" style={{ width: `${item.percent}%` }} />
          </div>
          <span>{item.message ?? `${item.percent.toFixed(0)}%`}</span>
        </div>
      ))}
    </div>
  );
}
