import type { UpdateChannel } from '../../types';

// 仓库与发布页统一使用官方固定地址，更新失败弹窗和关于页共用来源定义。
export const updateRepositories: Record<UpdateChannel, string> = {
  github: 'https://github.com/CrazyFigure/MyTerminal',
  cnb: 'https://cnb.cool/crazy-figure/MyTerminal',
};

export const updateReleasePage = (channel: UpdateChannel): string =>
  `${updateRepositories[channel]}${channel === 'cnb' ? '/-/releases' : '/releases/latest'}`;
