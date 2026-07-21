import React, { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, Search } from 'lucide-react';
import clsx from 'clsx';

// 下拉框选项接口
export interface CustomSelectOption {
  value: string;
  label: string | React.ReactNode;
}

// 下拉框组件属性接口
export interface CustomSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: CustomSelectOption[];
  disabled?: boolean;
  className?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  "aria-label"?: string;
}

// 模糊匹配优先级依次为完全匹配、前缀、连续包含和字符子序列；分词后每一项都必须命中。
const scoreFuzzyText = (source: string, query: string) => {
  const normalizedSource = source.normalize('NFKC').toLocaleLowerCase();
  const terms = query
    .normalize('NFKC')
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) {
    return 0;
  }

  let totalScore = 0;
  for (const term of terms) {
    if (normalizedSource === term) {
      continue;
    }
    if (normalizedSource.startsWith(term)) {
      totalScore += 10 + normalizedSource.length - term.length;
      continue;
    }
    const containedAt = normalizedSource.indexOf(term);
    if (containedAt >= 0) {
      totalScore += 30 + containedAt;
      continue;
    }

    let sourceIndex = 0;
    let gapScore = 0;
    for (const character of term) {
      const matchedAt = normalizedSource.indexOf(character, sourceIndex);
      if (matchedAt < 0) {
        return undefined;
      }
      gapScore += matchedAt - sourceIndex;
      sourceIndex = matchedAt + 1;
    }
    totalScore += 100 + gapScore;
  }
  return totalScore;
};

export const CustomSelect: React.FC<CustomSelectProps> = ({
  value,
  onChange,
  options,
  disabled = false,
  className,
  searchable = false,
  searchPlaceholder = 'Search',
  emptyText = 'No matching options',
  "aria-label": ariaLabel,
}) => {
  // 控制下拉菜单的开启/关闭状态
  const [isOpen, setIsOpen] = useState(false);
  // 触发器容器引用，用于获取坐标
  const triggerRef = useRef<HTMLDivElement>(null);
  // 弹出的 Portal 菜单引用，用于点击外部时判定
  const portalRef = useRef<HTMLDivElement>(null);
  // 可搜索下拉打开后自动聚焦输入框，让用户无需再次点击即可直接输入。
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  // 下拉菜单渲染的位置坐标与对齐方向
  const [coords, setCoords] = useState({ top: 0, left: 0, width: 0, placement: 'bottom' as 'top' | 'bottom' });
  // 查找挂载容器，优先挂载到 .app-shell 内部以完美继承 CSS 变量及主题
  const [mountNode, setMountNode] = useState<Element | null>(null);

  useEffect(() => {
    // 页面加载完成后寻找 .app-shell，若未找到则回退至 body
    const el = document.querySelector('.app-shell') || document.body;
    setMountNode(el);
  }, []);

  const filteredOptions = useMemo(() => {
    if (!searchable || !searchQuery.trim()) {
      return options;
    }
    return options
      .map((option, index) => {
        const label = typeof option.label === 'string' ? option.label : '';
        // 标签和值分别评分，禁止相同文本拼接后让子序列跨越边界产生伪匹配。
        const scores = [label, option.value]
          .map((candidate) => scoreFuzzyText(candidate, searchQuery))
          .filter((score): score is number => score !== undefined);
        const score = scores.length ? Math.min(...scores) : undefined;
        return score === undefined ? undefined : { option, score, index };
      })
      .filter((item): item is { option: CustomSelectOption; score: number; index: number } => Boolean(item))
      .sort((first, second) => first.score - second.score || first.index - second.index)
      .map((item) => item.option);
  }, [options, searchQuery, searchable]);

  useEffect(() => {
    if (!isOpen || !searchable) {
      return;
    }
    // Portal 在本轮提交后才挂载，下一帧再聚焦可避免输入框引用仍为空。
    const frame = window.requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen, searchable]);

  // 动态更新下拉菜单的显示位置，防止超出屏幕或被容器截断
  const updatePosition = () => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    // 搜索框占固定高度，选项区仍限制在总高度 280px 内。
    const searchHeight = searchable ? 48 : 0;
    const dropdownHeight = Math.min(filteredOptions.length * 36 + 12 + searchHeight, 280);
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;

    let placement: 'top' | 'bottom' = 'bottom';
    let top = rect.bottom;

    // 当下方空间不足且上方空间更大时，向上弹出
    if (spaceBelow < dropdownHeight && spaceAbove > spaceBelow) {
      placement = 'top';
      top = rect.top - dropdownHeight + 1;
    } else {
      top = rect.bottom - 1;
    }

    // 计算相对于挂载目标容器的偏移量，防止因为容器非 body 导致的绝对定位偏移
    const shellEl = document.querySelector('.app-shell');
    const shellRect = shellEl ? shellEl.getBoundingClientRect() : { top: 0, left: 0 };

    setCoords({
      top: top - shellRect.top,
      left: rect.left - shellRect.left,
      width: rect.width,
      placement,
    });
  };

  // 监听窗口大小改变和页面滚动以实时同步位置
  useEffect(() => {
    if (isOpen) {
      updatePosition();
      window.addEventListener('resize', updatePosition);
      // 捕获阶段监听滚动，确保在包含块发生滚动时也能重新计算
      window.addEventListener('scroll', updatePosition, true);
    }
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [filteredOptions.length, isOpen, searchable]);

  // 监听全局鼠标按下事件，实现点击外部自动关闭下拉菜单
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        triggerRef.current && !triggerRef.current.contains(event.target as Node) &&
        portalRef.current && !portalRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setSearchQuery('');
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // 查找到当前选中的选项，若无则默认选中第一项
  const selectedOption = options.find((opt) => opt.value === value) || options[0];

  // 切换下拉菜单打开状态
  const handleToggle = () => {
    if (disabled) return;
    if (isOpen) {
      setIsOpen(false);
      setSearchQuery('');
      return;
    }
    setSearchQuery('');
    setIsOpen(true);
  };

  // 点击选择某个选项
  const handleSelect = (val: string) => {
    onChange(val);
    setIsOpen(false);
    setSearchQuery('');
  };

  return (
    <div
      ref={triggerRef}
      className={clsx('custom-select-trigger', className, {
        'is-active': isOpen,
        'is-disabled': disabled,
      })}
      onClick={handleToggle}
      aria-label={ariaLabel}
    >
      {/* 当前选中的文字/标签 */}
      <span className="custom-select-value">
        {selectedOption ? selectedOption.label : value}
      </span>
      {/* 展开/收起的动画箭头 */}
      <ChevronDown
        size={16}
        className={clsx('custom-select-arrow', { 'is-open': isOpen })}
      />

      {/* 使用 React Portal 将下拉列表挂载到 .app-shell 内，从而能够正确继承 CSS 变量及主题 */}
      {isOpen && mountNode &&
        createPortal(
          <div
            ref={portalRef}
            className={clsx('custom-select-portal-options', {
              'is-searchable': searchable,
              'placement-top': coords.placement === 'top',
              'placement-bottom': coords.placement === 'bottom',
            })}
            // Portal 的 React 事件会冒泡回触发器；在此截断，避免点击搜索框时把下拉直接关闭。
            onClick={(event) => event.stopPropagation()}
            style={{
              position: 'absolute',
              top: coords.top,
              left: coords.left,
              width: coords.width,
              zIndex: 99999,
            }}
          >
            {searchable ? (
              <div className="custom-select-search">
                <Search aria-hidden="true" size={14} />
                <input
                  ref={searchInputRef}
                  aria-label={searchPlaceholder}
                  autoComplete="off"
                  className="custom-select-search-input"
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.stopPropagation();
                      setIsOpen(false);
                      setSearchQuery('');
                    }
                  }}
                  placeholder={searchPlaceholder}
                  spellCheck={false}
                  type="search"
                  value={searchQuery}
                />
              </div>
            ) : null}
            <div className="custom-select-scroll-container">
              {filteredOptions.map((opt) => {
                const isSelected = opt.value === value;
                return (
                  <div
                    key={opt.value}
                    className={clsx('custom-select-item', { 'is-selected': isSelected })}
                    onClick={() => handleSelect(opt.value)}
                  >
                    {/* 勾选图标放置在最左侧，并留出固定占位宽度以保持文字对齐 */}
                    <div className="custom-select-item-check-wrapper">
                      {isSelected && <Check size={14} className="custom-select-item-check" />}
                    </div>
                    <span className="custom-select-item-label">{opt.label}</span>
                  </div>
                );
              })}
              {filteredOptions.length === 0 ? (
                <div className="custom-select-empty">{emptyText}</div>
              ) : null}
            </div>
          </div>,
          mountNode
        )}
    </div>
  );
};
