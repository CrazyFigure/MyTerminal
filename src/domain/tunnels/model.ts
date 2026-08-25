/* 本模块从 Store 中按业务边界提取；领域规则不得依赖 Zustand，应用服务只暴露稳定操作。 */
import type { TunnelDraft, TunnelRecord } from '../../types';
import { isValidPort } from '../network/ports';

export const emptyTunnelDraft = (): TunnelDraft => ({
  id: '',
  connectionId: '',
  name: '',
  bindAddress: '127.0.0.1',
  localPort: 15432,
  remoteHost: '127.0.0.1',
  remotePort: 5432,
});



// 隧道草稿校验必填项、端口合法性以及本地端口防重冲突（排除自身编辑场景）。
export const getTunnelDraftValidationKey = (draft: TunnelDraft, existingTunnels: TunnelRecord[] = []) => {
  if (!draft.name.trim()) {
    return 'validationNameRequired' as const;
  }
  if (!draft.bindAddress.trim()) {
    return 'validationBindAddressRequired' as const;
  }
  if (typeof draft.localPort !== 'number' || !isValidPort(draft.localPort) || typeof draft.remotePort !== 'number' || !isValidPort(draft.remotePort)) {
    return 'validationPortInvalid' as const;
  }
  if (!draft.remoteHost.trim()) {
    return 'validationRemoteHostRequired' as const;
  }
  // 本地监听端口不能被其他已有隧道重复占用，避免启动时产生端口冲突
  const isPortConflict = existingTunnels.some(
    (item) => item.id !== draft.id && item.localPort === draft.localPort,
  );
  if (isPortConflict) {
    return 'validationTunnelLocalPortDuplicate' as const;
  }

  return undefined;
};
