/* 本模块从 Store 中按业务边界提取；领域规则不得依赖 Zustand，应用服务只暴露稳定操作。 */
import type { TunnelDraft } from '../../types';
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



// 隧道草稿先校验本地必填项和端口范围，端口占用等运行态问题交给启动监听时返回明确错误。
export const getTunnelDraftValidationKey = (draft: TunnelDraft) => {
  if (!draft.name.trim()) {
    return 'validationNameRequired' as const;
  }
  if (!draft.bindAddress.trim()) {
    return 'validationBindAddressRequired' as const;
  }
  if (!isValidPort(draft.localPort) || !isValidPort(draft.remotePort)) {
    return 'validationPortInvalid' as const;
  }
  if (!draft.remoteHost.trim()) {
    return 'validationRemoteHostRequired' as const;
  }

  return undefined;
};
