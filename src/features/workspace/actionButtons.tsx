/* 功能域展示规则：不持有 React 页面状态，只把输入转换成稳定的显示结果。 */
import type { CSSProperties } from 'react';
import { Cable, History, TerminalSquare } from 'lucide-react';
import type { TranslationKey } from '../../i18n';

export type BottomPanelTab = 'commands' | 'tunnels' | 'history';



export const bottomTabs: Array<{ id: BottomPanelTab; labelKey: TranslationKey; icon: typeof TerminalSquare }> = [
  { id: 'commands', labelKey: 'panelCommands', icon: TerminalSquare },
  { id: 'tunnels', labelKey: 'panelTunnels', icon: Cable },
  { id: 'history', labelKey: 'panelHistory', icon: History },
];



// 动作按钮紧凑态使用显式分行，中文优先保留业务词组，英文按单词长度均衡切分，避免 CSS 自动断成 3/1 之类的畸形结果。
export const splitActionButtonLabel = (label: string) => {
  const trimmed = label.trim();
  if (trimmed.length <= 1) {
    return [trimmed];
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > 1 && /^[\x00-\x7F]+$/.test(trimmed)) {
    if (words.length === 2) {
      return words;
    }

    let bestIndex = 1;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let index = 1; index < words.length; index += 1) {
      const left = words.slice(0, index).join(' ');
      const right = words.slice(index).join(' ');
      const delta = Math.abs(left.length - right.length);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIndex = index;
      }
    }
    return [words.slice(0, bestIndex).join(' '), words.slice(bestIndex).join(' ')];
  }

  const characters = Array.from(trimmed.replace(/\s+/g, ''));
  if (characters.length <= 1) {
    return [trimmed];
  }

  // “功能栏”是固定业务词组，紧凑态应保留为一行，避免出现“收起功 / 能栏”这种破坏语义的分割。
  const functionDockSuffix = '功能栏';
  if (trimmed.endsWith(functionDockSuffix) && characters.length > functionDockSuffix.length) {
    return [
      characters.slice(0, characters.length - functionDockSuffix.length).join(''),
      functionDockSuffix,
    ];
  }

  const firstLineLength = Math.ceil(characters.length / 2);
  return [characters.slice(0, firstLineLength).join(''), characters.slice(firstLineLength).join('')];
};



// 普通按钮保持自然横排；只有紧凑动作区才使用预切分行，图标和文字宽度互不挤压。
export const renderActionButtonLabel = (label: string, compact = false) => {
  if (!compact) {
    return <span className="button-label">{label}</span>;
  }

  return (
    <span className="button-label is-compact" aria-label={label}>
      {splitActionButtonLabel(label).map((line, index) => (
        <span key={`${line}-${index}`} className="button-label-line">
          {line}
        </span>
      ))}
    </span>
  );
};



// 底部动作区只在自然横排放不下时进入紧凑模式；估算值偏保守，避免空间充足时仍然强制换行。
export const estimateInlineButtonWidth = (label: string) => {
  const trimmed = label.trim();
  const asciiOnly = /^[\x00-\x7F]+$/.test(trimmed);
  const textWidth = asciiOnly ? trimmed.length * 8.5 : Array.from(trimmed).length * 15;
  return Math.max(64, Math.ceil(textWidth + 48));
};



// 紧凑态宽度按换行后最长一行计算，让“全部/开启”这类按钮真正变窄，而不是统一占用大宽度。
export const estimateCompactButtonWidth = (label: string) => {
  const lines = splitActionButtonLabel(label);
  const asciiOnly = /^[\x00-\x7F]+$/.test(label.trim());
  const longestLineWidth = lines.reduce((maxWidth, line) => {
    const lineWidth = asciiOnly ? line.length * 8.5 : Array.from(line).length * 15;
    return Math.max(maxWidth, lineWidth);
  }, 0);
  return Math.max(62, Math.ceil(longestLineWidth + 44));
};



// 紧凑态按钮宽度写入 CSS 变量，避免统一 flex 宽度把已经换行的短文案又撑宽。
export const buildActionButtonStyle = (label: string, compact: boolean): CSSProperties | undefined => {
  if (!compact) {
    return undefined;
  }
  return { '--compact-action-button-width': `${estimateCompactButtonWidth(label)}px` } as CSSProperties;
};
