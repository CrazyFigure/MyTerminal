/* 本模块从 Store 中按业务边界提取；领域规则不得依赖 Zustand，应用服务只暴露稳定操作。 */
import type { ConnectionDraft, ConnectionProfile, SshJumpHost, SshProxyConfig } from '../../types';
import { clampPort, isValidPort } from '../network/ports';

export const emptyConnectionDraft = (): ConnectionDraft => ({
  id: '',
  protocol: 'ssh',
  name: '',
  groupPath: '',
  host: '',
  port: 22,
  username: 'root',
  authMethod: 'password',
  password: '',
  privateKeyPath: '',
  privateKeyText: '',
  passphrase: '',
  jumpHosts: [],
  proxy: {
    enabled: false,
    type: 'socks5',
    host: '',
    port: 1080,
    username: '',
    password: '',
  },
  note: '',
});



// 跳板机草稿默认用独立 id 保持增删排序稳定；认证字段按主机独立保存，支持多级链路不同账号。
export const emptyJumpHostDraft = (): SshJumpHost => ({
  id: crypto.randomUUID(),
  name: '',
  host: '',
  port: 22,
  username: '',
  authMethod: 'password',
  password: '',
  privateKeyPath: '',
  privateKeyText: '',
  passphrase: '',
});



// 代理草稿允许临时关闭但保留输入值，默认 SOCKS5/1080 更贴近常见本地代理习惯。
export const emptyProxyDraft = (): SshProxyConfig => ({
  enabled: false,
  type: 'socks5',
  host: '',
  port: 1080,
  username: '',
  password: '',
});



// 分组路径统一使用相对路径形式，便于前端树渲染与后端设置持久化保持同一套判断规则。
export const normalizeConnectionGroupPath = (value?: string) =>
  (value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/+/g, '/');



export const trimToUndefined = (value?: string) => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};



export const keepTextIfPresent = (value?: string) => {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.trim() ? value : undefined;
};



export const normalizeAuthMethod = (authMethod?: string) => (authMethod === 'privateKey' ? 'privateKey' : 'password');



// 连接保存前统一清洗跳板机字段：空敏感字段不落到无意义字符串，端口不合法时回退 SSH 默认端口。
export const normalizeJumpHost = (jumpHost: SshJumpHost): SshJumpHost => {
  const authMethod = normalizeAuthMethod(jumpHost.authMethod);
  return {
    id: jumpHost.id || crypto.randomUUID(),
    name: trimToUndefined(jumpHost.name),
    host: jumpHost.host.trim(),
    port: clampPort(jumpHost.port),
    username: jumpHost.username.trim(),
    authMethod,
    password: authMethod === 'password' ? jumpHost.password ?? '' : undefined,
    privateKeyPath: authMethod === 'privateKey' ? trimToUndefined(jumpHost.privateKeyPath) : undefined,
    privateKeyText: authMethod === 'privateKey' ? keepTextIfPresent(jumpHost.privateKeyText) : undefined,
    passphrase: authMethod === 'privateKey' ? keepTextIfPresent(jumpHost.passphrase) : undefined,
  };
};



// 代理只作用于第一跳；关闭时仍保留配置，方便用户临时启停。
export const normalizeProxyConfig = (proxy?: SshProxyConfig): SshProxyConfig => ({
  enabled: Boolean(proxy?.enabled),
  type: proxy?.type === 'http' ? 'http' : 'socks5',
  host: proxy?.host?.trim() ?? '',
  port: clampPort(proxy?.port, 1080),
  username: trimToUndefined(proxy?.username),
  password: keepTextIfPresent(proxy?.password),
});



// 旧连接没有 protocol/jumpHosts/proxy 字段，加载到前端状态时补齐默认值，避免编辑旧连接时报 undefined。
export const normalizeLoadedConnection = (connection: ConnectionProfile): ConnectionProfile => ({
  ...connection,
  protocol: connection.protocol === 'rdp' ? 'rdp' : 'ssh',
  jumpHosts: Array.isArray(connection.jumpHosts) ? connection.jumpHosts : [],
  proxy: normalizeProxyConfig(connection.proxy),
});



// 删除、重命名分组都需要同时处理子分组，路径前缀判断必须只命中完整层级。
export const isGroupOrChildPath = (value: string | undefined, groupPath: string) => {
  const normalized = normalizeConnectionGroupPath(value);
  return Boolean(groupPath) && (normalized === groupPath || normalized.startsWith(`${groupPath}/`));
};



// 显式分组和连接表单里的分组会在这里去重，但保留传入顺序以支持用户拖拽排序。
export const mergeConnectionGroups = (...groups: Array<Array<string | undefined>>) =>
  Array.from(
    new Set(
      groups
        .flat()
        .map((groupPath) => normalizeConnectionGroupPath(groupPath))
        .filter(Boolean),
    ),
  );



export const getConnectionDraftValidationKey = (draft: ConnectionDraft) => {
  if (!draft.name.trim()) {
    return 'validationNameRequired' as const;
  }
  if (!draft.host.trim()) {
    return 'validationHostRequired' as const;
  }
  if (!draft.username.trim()) {
    return 'validationUsernameRequired' as const;
  }
  if (!isValidPort(draft.port)) {
    return 'validationPortInvalid' as const;
  }

  if (draft.protocol === 'rdp') {
    if (!draft.password.trim()) {
      return 'validationPasswordRequired' as const;
    }
  } else if (draft.authMethod === 'privateKey') {
    if (!draft.privateKeyPath.trim() && !draft.privateKeyText.trim()) {
      return 'validationPrivateKeyRequired' as const;
    }
  } else if (!draft.password.trim()) {
    return 'validationPasswordRequired' as const;
  }

  for (const jumpHost of draft.protocol === 'ssh' ? draft.jumpHosts : []) {
    if (!jumpHost.host.trim()) {
      return 'validationJumpHostRequired' as const;
    }
    if (!jumpHost.username.trim()) {
      return 'validationJumpUsernameRequired' as const;
    }
    if (!isValidPort(jumpHost.port)) {
      return 'validationPortInvalid' as const;
    }
    if (jumpHost.authMethod === 'privateKey') {
      if (!jumpHost.privateKeyPath?.trim() && !jumpHost.privateKeyText?.trim()) {
        return 'validationJumpPrivateKeyRequired' as const;
      }
    } else if (!jumpHost.password?.trim()) {
      return 'validationJumpPasswordRequired' as const;
    }
  }

  if (draft.protocol === 'ssh' && draft.proxy.enabled) {
    if (!draft.proxy.host.trim()) {
      return 'validationProxyHostRequired' as const;
    }
    if (!isValidPort(draft.proxy.port)) {
      return 'validationPortInvalid' as const;
    }
  }

  return undefined;
};



export const buildConnectionProfile = (draft: ConnectionDraft): ConnectionProfile => {
  // RDP 固定使用 Windows 账号密码；隐藏的 SSH 高级配置不随 RDP 保存，避免协议切换后误用旧链路。
  const protocol = draft.protocol === 'rdp' ? 'rdp' : 'ssh';
  const authMethod = protocol === 'rdp' ? 'password' : draft.authMethod === 'privateKey' ? 'privateKey' : 'password';

  return {
    id: draft.id || crypto.randomUUID(),
    protocol,
    name: draft.name.trim(),
    groupPath: normalizeConnectionGroupPath(draft.groupPath) || undefined,
    host: draft.host.trim(),
    port: draft.port,
    username: draft.username.trim(),
    authMethod,
    password: authMethod === 'password' ? draft.password : undefined,
    privateKeyPath: authMethod === 'privateKey' ? draft.privateKeyPath : undefined,
    privateKeyText: authMethod === 'privateKey' ? draft.privateKeyText : undefined,
    passphrase: authMethod === 'privateKey' ? draft.passphrase : undefined,
    jumpHosts: protocol === 'ssh' ? draft.jumpHosts.map((jumpHost) => normalizeJumpHost(jumpHost)) : [],
    proxy: protocol === 'ssh' ? normalizeProxyConfig(draft.proxy) : emptyProxyDraft(),
    note: draft.note?.trim() || undefined,
  };
};
