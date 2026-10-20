import type {
  LocalTerminalCommand,
  LocalTerminalSettings,
  LocalTerminalShellConfig,
} from '../../types';

type LocalTerminalStartupOption =
  | { value: string; kind: 'shell'; shell: LocalTerminalShellConfig }
  | { value: string; kind: 'command'; command: LocalTerminalCommand };

// 启动项统一按列表顺序排列：已开启且命令有效的系统终端在前，非空预设命令在后。
export const getLocalTerminalStartupOptions = (
  settings: Pick<LocalTerminalSettings, 'shells' | 'commands'>,
): LocalTerminalStartupOption[] => [
  ...(settings.shells ?? [])
    .filter((shell) => shell.enabled !== false && shell.id.trim() && shell.command.trim())
    .map((shell) => ({ value: `shell:${shell.id}`, kind: 'shell' as const, shell })),
  ...settings.commands
    .filter((command) => command.id !== 'shell' && command.command.trim())
    .map((command) => ({ value: command.command, kind: 'command' as const, command })),
];

// 保留仍在可选列表中的命令；失效时选第一项，列表为空则清空旧命令并交给默认终端。
export const resolveLocalTerminalStartupCommand = (
  command: string,
  options: readonly { value: string }[],
): string => {
  const trimmed = command.trim();
  return options.some((option) => option.value === trimmed) ? trimmed : options[0]?.value ?? '';
};
