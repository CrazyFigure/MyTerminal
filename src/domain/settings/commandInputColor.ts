/* 命令输入文字颜色的默认值、校验与深浅主题配对规则；纯函数，不依赖 xterm 与 React。 */

// A 方案配色：浅色底用深靛蓝，深色底用浅靛蓝，两者在各自默认底色上对比度约 7:1。
export const defaultTerminalCommandInputLightColor = '#3b44c4';

export const defaultTerminalCommandInputDarkColor = '#9aa8ff';

// 设置页提供的预设色，每项都给出深浅两种底色下的取值。
export const terminalCommandInputColorPresets = [
  { id: 'indigo', light: defaultTerminalCommandInputLightColor, dark: defaultTerminalCommandInputDarkColor },
  { id: 'teal', light: '#0f766e', dark: '#5eead4' },
  { id: 'rose', light: '#be185d', dark: '#f9a8d4' },
  { id: 'amber', light: '#b45309', dark: '#fcd34d' },
] as const;

const hexColorPattern = /^#[0-9a-f]{6}$/i;

// 只接受 #rrggbb，统一转小写；非法值回落到默认色。
export const normalizeTerminalCommandInputColor = (value: unknown) =>
  typeof value === 'string' && hexColorPattern.test(value.trim())
    ? value.trim().toLowerCase()
    : defaultTerminalCommandInputLightColor;

// 设置里存一个颜色值；若它是某个预设的浅色或深色取值，就按当前底色换成同一预设的配套色，
// 这样默认色与预设色在切换深浅主题后依然清晰。用户自定义的其它颜色原样使用。
export const resolveTerminalCommandInputDisplayColor = (configured: string, isDarkBackground: boolean) => {
  const color = normalizeTerminalCommandInputColor(configured);
  const preset = terminalCommandInputColorPresets.find(
    (item) => item.light === color || item.dark === color,
  );
  if (!preset) {
    return color;
  }
  return isDarkBackground ? preset.dark : preset.light;
};

// 判断设置值属于哪个预设（不区分深浅取值），设置页据此高亮当前选中的色块。
export const resolveTerminalCommandInputPresetId = (configured: string) => {
  const color = normalizeTerminalCommandInputColor(configured);
  return terminalCommandInputColorPresets.find(
    (item) => item.light === color || item.dark === color,
  )?.id;
};
