import { backend } from '../../backend';
import type { StoreGet, StoreSet, StoreState } from './contracts';
import { statusText } from './status';

type TunnelActionKeys =
  | 'openTunnel'
  | 'duplicateTunnel'
  | 'editTunnel'
  | 'startTunnel'
  | 'startAllTunnels'
  | 'stopAllTunnels'
  | 'closeTunnel'
  | 'deleteTunnel'
  | 'applyTunnelStatusChange';

export type TunnelActions = Pick<StoreState, TunnelActionKeys>;

// 隧道 action factory 是应用服务切片：限制批量操作的连接边界，并把后端状态统一归并回 Store。
export const createTunnelActions = (set: StoreSet, get: StoreGet): TunnelActions => ({
  openTunnel: async () => {
    const { activeConnectionId, connections } = get();
    if (!activeConnectionId) {
      return;
    }

    const connection = connections.find((item) => item.id === activeConnectionId);
    if (!connection) {
      return;
    }

    set({
      showTunnelForm: true,
      tunnelDraft: {
        id: '',
        connectionId: activeConnectionId,
        name: `${connection.name} DB tunnel`,
        bindAddress: '127.0.0.1',
        localPort: 15432,
        remoteHost: '127.0.0.1',
        remotePort: 5432,
      },
      activePanel: 'tunnels',
    });
  },

  // 复制已有隧道配置并打开新建弹窗，将名称与端口置空，仅保留监听与远端主机（id 置空以走新建分支）。
  duplicateTunnel: (tunnel) => {
    set({
      showTunnelForm: true,
      tunnelDraft: {
        id: '',
        connectionId: tunnel.connectionId,
        name: '',
        bindAddress: tunnel.bindAddress,
        localPort: '',
        remoteHost: tunnel.remoteHost,
        remotePort: '',
      },
      activePanel: 'tunnels',
    });
  },

  editTunnel: (tunnel) => {
    set({
      showTunnelForm: true,
      // 编辑时保留原始连接归属，活动连接切换后也不能把配置误保存到另一主机。
      tunnelDraft: {
        id: tunnel.id,
        connectionId: tunnel.connectionId,
        name: tunnel.name,
        bindAddress: tunnel.bindAddress,
        localPort: tunnel.localPort,
        remoteHost: tunnel.remoteHost,
        remotePort: tunnel.remotePort,
      },
      activePanel: 'tunnels',
    });
  },

  startTunnel: async (tunnelId) => {
    try {
      const tunnel = await backend.startTunnel(tunnelId);
      set((state) => ({
        tunnels: state.tunnels.map((item) => (item.id === tunnel.id ? tunnel : item)),
        statusMessage: statusText(state.settings, 'statusTunnelStarted'),
      }));
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusTunnelStartFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
    }
  },

  startAllTunnels: async () => {
    const { activeConnectionId } = get();
    if (!activeConnectionId) {
      return;
    }
    // 批量开启只作用于当前连接，与底部面板当前可见范围保持一致。
    const stoppedTunnels = get().tunnels.filter(
      (item) => item.connectionId === activeConnectionId && item.status !== 'running',
    );
    if (!stoppedTunnels.length) {
      return;
    }

    try {
      const restarted = await Promise.all(stoppedTunnels.map((item) => backend.startTunnel(item.id)));
      set((state) => ({
        tunnels: state.tunnels.map((item) => restarted.find((next) => next.id === item.id) ?? item),
        statusMessage: statusText(state.settings, 'statusAllTunnelsStarted'),
      }));
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusTunnelStartFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
    }
  },

  stopAllTunnels: async () => {
    const { activeConnectionId } = get();
    if (!activeConnectionId) {
      return;
    }
    const runningTunnels = get().tunnels.filter(
      (item) => item.connectionId === activeConnectionId && item.status === 'running',
    );
    if (!runningTunnels.length) {
      return;
    }

    await Promise.all(runningTunnels.map((item) => backend.closeTunnel(item.id)));
    set((state) => ({
      tunnels: state.tunnels.map((item) => (
        runningTunnels.some((running) => running.id === item.id)
          ? { ...item, status: 'stopped' }
          : item
      )),
      statusMessage: statusText(state.settings, 'statusAllTunnelsStopped'),
    }));
  },

  closeTunnel: async (tunnelId) => {
    await backend.closeTunnel(tunnelId);
    set((state) => ({
      tunnels: state.tunnels.map((item) => (
        item.id === tunnelId ? { ...item, status: 'stopped' } : item
      )),
      statusMessage: statusText(state.settings, 'statusTunnelStopped'),
    }));
  },

  // 删除隧道记录；若正在运行后端会自动停止监听并释放通道。
  deleteTunnel: async (tunnelId) => {
    try {
      await backend.deleteTunnel(tunnelId);
      set((state) => ({
        tunnels: state.tunnels.filter((item) => item.id !== tunnelId),
        statusMessage: statusText(state.settings, 'statusTunnelDeleted'),
      }));
    } catch (error) {
      set((state) => ({
        statusMessage: statusText(state.settings, 'statusTunnelDeleteFailed', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      }));
    }
  },

  applyTunnelStatusChange: (tunnel) => {
    set((state) => {
      const existing = state.tunnels.find((item) => item.id === tunnel.id);
      // 用户已手动停止时不接受后台迟到探测覆盖；状态相同则避免无意义重渲染。
      if (!existing || existing.status === tunnel.status || existing.status === 'stopped') {
        return {};
      }
      return {
        tunnels: state.tunnels.map((item) => (
          item.id === tunnel.id ? { ...item, status: tunnel.status } : item
        )),
      };
    });
  },
});
