import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import type * as monaco from 'monaco-editor';
import { translate, type TranslationKey } from '../i18n';
import { useAppStore } from '../store';
import { Tooltip } from './Tooltip';

// 替换图标（两向替换/交换箭头）
function ReplaceIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width={size}
    >
      <path d="M14 4h6v6" />
      <path d="M4 20h6v-6" />
      <path d="M20 4l-7 7" />
      <path d="M4 20l7-7" />
    </svg>
  );
}

// 全部替换图标（四宫格/全部匹配）
function GridIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width={size}
    >
      <rect height="7" rx="1" width="7" x="3" y="3" />
      <rect height="7" rx="1" width="7" x="14" y="3" />
      <rect height="7" rx="1" width="7" x="14" y="14" />
      <rect height="7" rx="1" width="7" x="3" y="14" />
    </svg>
  );
}

export type EditorFindReplaceWidgetProps = {
  editor: monaco.editor.IStandaloneCodeEditor | null;
  // 每次 Ctrl+F/H/R 触发时递增；浮窗已打开时也能据此把焦点拉回输入框
  focusRequestId?: number;
  initialMode?: 'find' | 'replace';
  isOpen: boolean;
  onClose: () => void;
};

// 中文输入法组合输入期间的 Enter 只用于上屏，不能当作查找/替换指令
function isImeComposing(e: React.KeyboardEvent) {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

export function EditorFindReplaceWidget({
  editor,
  focusRequestId = 0,
  initialMode = 'find',
  isOpen,
  onClose,
}: EditorFindReplaceWidgetProps) {
  const uiLanguage = useAppStore((state) => state.settings.uiLanguage);
  const t = (key: TranslationKey, replacements?: Record<string, string | number>) =>
    translate(uiLanguage, key, replacements);

  const [searchQuery, setSearchQuery] = useState('');
  const [replaceQuery, setReplaceQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);

  const [matches, setMatches] = useState<monaco.editor.FindMatch[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(-1);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const decorationsCollectionRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);

  const matchCaseId = useId();
  const wholeWordId = useId();
  const isRegexId = useId();

  // 执行文档搜索并计算所有匹配区间
  const calculateMatches = useCallback(
    (query: string, caseSensitive: boolean, whole: boolean, regex: boolean) => {
      if (!editor) {
        return [];
      }
      const model = editor.getModel();
      if (!model || !query) {
        return [];
      }

      let finalQuery = query;
      let finalRegex = regex;
      let wordSeparators: string | null = null;

      if (whole && !regex) {
        wordSeparators = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/? \t\n\r';
      }

      try {
        if (regex) {
          if (whole) {
            finalQuery = `\\b(?:${query})\\b`;
          }
          // 校验正则表达式语法是否合法
          new RegExp(finalQuery, caseSensitive ? 'g' : 'gi');
        }

        const results = model.findMatches(
          finalQuery,
          false,
          finalRegex,
          caseSensitive,
          wordSeparators,
          false,
          3000,
        );
        return results;
      } catch {
        return [];
      }
    },
    [editor],
  );

  // 更新 Monaco 编辑器内的匹配装饰（包括全部匹配与当前聚焦项）
  const updateDecorations = useCallback(
    (foundMatches: monaco.editor.FindMatch[], activeIndex: number) => {
      if (!editor) {
        return;
      }

      // 如果尚未建立装饰集合，则初始化集合实例
      if (!decorationsCollectionRef.current) {
        decorationsCollectionRef.current = editor.createDecorationsCollection([]);
      }

      if (foundMatches.length === 0 || activeIndex < 0 || activeIndex >= foundMatches.length) {
        decorationsCollectionRef.current.clear();
        return;
      }

      const decorations: monaco.editor.IModelDeltaDecoration[] = foundMatches.map(
        (match, index) => {
          const isCurrent = index === activeIndex;
          return {
            range: match.range,
            options: {
              className: isCurrent ? 'monaco-find-match-current' : 'monaco-find-match-highlight',
              overviewRuler: {
                color: isCurrent ? 'rgba(234, 88, 12, 0.95)' : 'rgba(245, 158, 11, 0.65)',
                position: 7, // OverviewRulerLane.Full
              },
              minimap: {
                color: isCurrent ? 'rgba(234, 88, 12, 0.95)' : 'rgba(245, 158, 11, 0.65)',
                position: 1, // MinimapPosition.Inline
              },
            },
          };
        },
      );

      decorationsCollectionRef.current.set(decorations);
    },
    [editor],
  );

  // 跳转并聚焦到指定下标的匹配项
  const focusMatchAtIndex = useCallback(
    (index: number, foundMatches: monaco.editor.FindMatch[]) => {
      if (!editor || foundMatches.length === 0 || index < 0 || index >= foundMatches.length) {
        return;
      }
      const match = foundMatches[index];
      setCurrentMatchIndex(index);
      editor.setSelection(match.range);
      editor.revealRangeInCenterIfOutsideViewport(match.range);
      updateDecorations(foundMatches, index);
    },
    [editor, updateDecorations],
  );

  // 刷新当前搜索状态
  const refreshSearch = useCallback(
    (
      query: string,
      caseSensitive: boolean,
      whole: boolean,
      regex: boolean,
      preferredIndex?: number,
    ) => {
      const foundMatches = calculateMatches(query, caseSensitive, whole, regex);
      setMatches(foundMatches);

      if (foundMatches.length === 0) {
        setCurrentMatchIndex(-1);
        updateDecorations([], -1);
        return;
      }

      let targetIndex = 0;
      if (preferredIndex !== undefined && preferredIndex >= 0) {
        targetIndex = Math.min(preferredIndex, foundMatches.length - 1);
      } else if (editor) {
        // 根据光标所在位置，寻找光标处或光标之后的第一个匹配项
        const position = editor.getPosition();
        if (position) {
          const matchIndex = foundMatches.findIndex((item) => {
            return (
              item.range.startLineNumber > position.lineNumber ||
              (item.range.startLineNumber === position.lineNumber &&
                item.range.startColumn >= position.column)
            );
          });
          targetIndex = matchIndex >= 0 ? matchIndex : 0;
        }
      }

      focusMatchAtIndex(targetIndex, foundMatches);
    },
    [calculateMatches, editor, focusMatchAtIndex, updateDecorations],
  );

  // 响应搜索文本或选项变化
  useEffect(() => {
    if (!isOpen) {
      decorationsCollectionRef.current?.clear();
      return;
    }
    refreshSearch(searchQuery, matchCase, wholeWord, isRegex);
  }, [isOpen, searchQuery, matchCase, wholeWord, isRegex, refreshSearch]);

  // 当浮窗打开时，若选区非空则自动填充搜索词，并根据模式聚焦对应输入框
  useEffect(() => {
    if (!isOpen || !editor) {
      return;
    }

    const selection = editor.getSelection();
    if (selection && !selection.isEmpty() && selection.startLineNumber === selection.endLineNumber) {
      const selectedText = editor.getModel()?.getValueInRange(selection);
      if (selectedText) {
        setSearchQuery(selectedText);
      }
    }

    // 延迟聚焦确保 DOM 元素已挂载渲染；focusRequestId 变化代表浮窗已打开时再次按下快捷键
    const timer = setTimeout(() => {
      if (initialMode === 'replace' && replaceInputRef.current) {
        replaceInputRef.current.focus();
        replaceInputRef.current.select();
      } else if (searchInputRef.current) {
        searchInputRef.current.focus();
        searchInputRef.current.select();
      }
    }, 30);

    return () => clearTimeout(timer);
  }, [isOpen, editor, initialMode, focusRequestId]);

  // 用户在编辑区输入后只重算匹配与高亮，绝不移动光标或选区，否则光标会被拽回搜索结果处，下一次输入还会覆盖选中的匹配文本
  const syncMatchesAfterEdit = useCallback(() => {
    if (!editor) {
      return;
    }
    const foundMatches = calculateMatches(searchQuery, matchCase, wholeWord, isRegex);
    setMatches(foundMatches);
    if (foundMatches.length === 0) {
      setCurrentMatchIndex(-1);
      updateDecorations([], -1);
      return;
    }

    // 光标正落在某个匹配项内时将其视为当前项，否则沿用原下标（越界时收敛到末尾）
    const position = editor.getPosition();
    let activeIndex = position
      ? foundMatches.findIndex((item) => item.range.containsPosition(position))
      : -1;
    if (activeIndex < 0) {
      activeIndex = Math.min(Math.max(currentMatchIndex, 0), foundMatches.length - 1);
    }
    setCurrentMatchIndex(activeIndex);
    updateDecorations(foundMatches, activeIndex);
  }, [
    calculateMatches,
    currentMatchIndex,
    editor,
    isRegex,
    matchCase,
    searchQuery,
    updateDecorations,
    wholeWord,
  ]);

  // 监听编辑器内容变更，实时更新匹配高亮
  useEffect(() => {
    if (!editor || !isOpen) {
      return;
    }
    const disposable = editor.onDidChangeModelContent(() => {
      syncMatchesAfterEdit();
    });
    return () => disposable.dispose();
  }, [editor, isOpen, syncMatchesAfterEdit]);

  // 计算上一个/下一个的目标下标：选区仍停在当前匹配项上时按顺序步进，用户在编辑区移动过光标后从光标处查找
  const resolveStepIndex = (direction: 1 | -1) => {
    const currentMatch = matches[currentMatchIndex];
    const selection = editor?.getSelection();
    if (!selection || (currentMatch && selection.equalsRange(currentMatch.range))) {
      return (currentMatchIndex + direction + matches.length) % matches.length;
    }

    if (direction === 1) {
      const anchor = selection.getEndPosition();
      const nextIndex = matches.findIndex((item) =>
        anchor.isBeforeOrEqual(item.range.getStartPosition()),
      );
      return nextIndex >= 0 ? nextIndex : 0;
    }

    const anchor = selection.getStartPosition();
    for (let index = matches.length - 1; index >= 0; index -= 1) {
      if (matches[index].range.getEndPosition().isBeforeOrEqual(anchor)) {
        return index;
      }
    }
    return matches.length - 1;
  };

  // 关闭浮窗时清除所有高亮标记
  const handleClose = () => {
    decorationsCollectionRef.current?.clear();
    onClose();
  };

  // 跳转到上一个匹配项
  const handleFindPrevious = () => {
    if (matches.length === 0) {
      return;
    }
    focusMatchAtIndex(resolveStepIndex(-1), matches);
  };

  // 跳转到下一个匹配项
  const handleFindNext = () => {
    if (matches.length === 0) {
      return;
    }
    focusMatchAtIndex(resolveStepIndex(1), matches);
  };

  // 单个替换当前聚焦项
  const handleReplaceOne = () => {
    if (!editor || matches.length === 0 || currentMatchIndex < 0) {
      return;
    }
    const model = editor.getModel();
    if (!model) {
      return;
    }

    const currentMatch = matches[currentMatchIndex];
    let replacement = replaceQuery;

    if (isRegex) {
      const originalText = model.getValueInRange(currentMatch.range);
      try {
        let regexPattern = searchQuery;
        if (wholeWord) {
          regexPattern = `\\b(?:${searchQuery})\\b`;
        }
        const re = new RegExp(regexPattern, matchCase ? '' : 'i');
        replacement = originalText.replace(re, replaceQuery);
      } catch {
        replacement = replaceQuery;
      }
    }

    // 通过 Monaco API 执行替换，自动进入撤销历史栈
    editor.executeEdits('find-replace', [
      {
        range: currentMatch.range,
        text: replacement,
        forceMoveMarkers: true,
      },
    ]);

    // 重新检索并聚焦下一个位置
    refreshSearch(searchQuery, matchCase, wholeWord, isRegex, currentMatchIndex);
  };

  // 全部替换所有匹配项
  const handleReplaceAll = () => {
    if (!editor || matches.length === 0) {
      return;
    }
    const model = editor.getModel();
    if (!model) {
      return;
    }

    let regexPattern = searchQuery;
    if (wholeWord && isRegex) {
      regexPattern = `\\b(?:${searchQuery})\\b`;
    }

    const edits: monaco.editor.IIdentifiedSingleEditOperation[] = matches.map((match) => {
      let replacement = replaceQuery;
      if (isRegex) {
        const originalText = model.getValueInRange(match.range);
        try {
          const re = new RegExp(regexPattern, matchCase ? '' : 'i');
          replacement = originalText.replace(re, replaceQuery);
        } catch {
          replacement = replaceQuery;
        }
      }
      return {
        range: match.range,
        text: replacement,
        forceMoveMarkers: true,
      };
    });

    editor.executeEdits('find-replace', edits);
    refreshSearch(searchQuery, matchCase, wholeWord, isRegex, 0);
  };

  // 阻止 ESC 键关闭浮窗，满足无需 ESC 关闭浮窗的需求
  const handleKeyDownPreventEscape = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // 浮窗内再次按 Ctrl+F 聚焦搜索框，Ctrl+H / Ctrl+R 聚焦替换框，与编辑区内的快捷键保持一致
  const handleCardKeyDown = (e: React.KeyboardEvent) => {
    handleKeyDownPreventEscape(e);
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) {
      return;
    }
    const key = e.key.toLowerCase();
    let target: HTMLInputElement | null = null;
    if (key === 'f' || e.code === 'KeyF') {
      target = searchInputRef.current;
    } else if (key === 'h' || key === 'r' || e.code === 'KeyH' || e.code === 'KeyR') {
      target = replaceInputRef.current;
    }
    if (!target) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    target.focus();
    target.select();
  };

  // 搜索框按键监听：Enter 下一个、Shift+Enter 上一个
  const handleSearchInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    handleKeyDownPreventEscape(e);
    if (e.key === 'Enter' && !isImeComposing(e)) {
      e.preventDefault();
      if (e.shiftKey) {
        handleFindPrevious();
      } else {
        handleFindNext();
      }
    }
  };

  // 替换框按键监听：Enter 替换当前项
  const handleReplaceInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    handleKeyDownPreventEscape(e);
    if (e.key === 'Enter' && !isImeComposing(e)) {
      e.preventDefault();
      handleReplaceOne();
    }
  };

  if (!isOpen) {
    return null;
  }

  // 统计结果文本提示（如 1/5 或 无结果）
  const matchCountText =
    searchQuery.trim().length > 0
      ? matches.length > 0
        ? `${currentMatchIndex + 1}/${matches.length}`
        : t('editorNoResults')
      : null;

  return (
    <div
      className="editor-find-replace-card"
      onKeyDown={handleCardKeyDown}
      role="search"
    >
      {/* 搜索行 */}
      <div className="editor-find-row">
        <div className="editor-find-input-wrap">
          <Search className="editor-find-field-icon" size={14} />
          <input
            className="editor-find-input"
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchInputKeyDown}
            placeholder={t('editorFindPlaceholder')}
            ref={searchInputRef}
            spellCheck={false}
            type="text"
            value={searchQuery}
          />
          {matchCountText && (
            <span className={`editor-find-count-badge ${matches.length === 0 ? 'empty' : ''}`}>
              {matchCountText}
            </span>
          )}
        </div>

        <Tooltip content={t('editorPreviousMatch')} shortcut="Shift+Enter" side="top">
          <button
            aria-label={t('editorPreviousMatch')}
            className="editor-find-icon-btn"
            disabled={matches.length === 0}
            onClick={handleFindPrevious}
            type="button"
          >
            <ChevronUp size={16} />
          </button>
        </Tooltip>

        <Tooltip content={t('editorNextMatch')} shortcut="Enter" side="top">
          <button
            aria-label={t('editorNextMatch')}
            className="editor-find-icon-btn"
            disabled={matches.length === 0}
            onClick={handleFindNext}
            type="button"
          >
            <ChevronDown size={16} />
          </button>
        </Tooltip>

        <Tooltip content={t('close')} shortcut="Esc" side="top">
          <button
            aria-label={t('close')}
            className="editor-find-icon-btn close-btn"
            onClick={handleClose}
            type="button"
          >
            <X size={16} />
          </button>
        </Tooltip>
      </div>

      {/* 替换行 */}
      <div className="editor-find-row">
        <div className="editor-find-input-wrap">
          <div className="editor-find-field-icon">
            <ReplaceIcon size={13} />
          </div>
          <input
            className="editor-find-input"
            onChange={(e) => setReplaceQuery(e.target.value)}
            onKeyDown={handleReplaceInputKeyDown}
            placeholder={t('editorReplacePlaceholder')}
            ref={replaceInputRef}
            spellCheck={false}
            type="text"
            value={replaceQuery}
          />
        </div>

        <button
          className="editor-find-action-btn"
          disabled={matches.length === 0}
          onClick={handleReplaceOne}
          type="button"
        >
          <ReplaceIcon size={13} />
          <span>{t('editorReplace')}</span>
        </button>

        <button
          className="editor-find-action-btn"
          disabled={matches.length === 0}
          onClick={handleReplaceAll}
          type="button"
        >
          <GridIcon size={13} />
          <span>{t('editorReplaceAll')}</span>
        </button>
      </div>

      {/* 选项复选框行 */}
      <div className="editor-find-options-row">
        <label className="editor-find-option-label" htmlFor={matchCaseId}>
          <input
            checked={matchCase}
            className="editor-find-checkbox"
            id={matchCaseId}
            onChange={(e) => setMatchCase(e.target.checked)}
            type="checkbox"
          />
          <span>{t('editorMatchCase')}</span>
        </label>

        <label className="editor-find-option-label" htmlFor={wholeWordId}>
          <input
            checked={wholeWord}
            className="editor-find-checkbox"
            id={wholeWordId}
            onChange={(e) => setWholeWord(e.target.checked)}
            type="checkbox"
          />
          <span>{t('editorWholeWord')}</span>
        </label>

        <label className="editor-find-option-label" htmlFor={isRegexId}>
          <input
            checked={isRegex}
            className="editor-find-checkbox"
            id={isRegexId}
            onChange={(e) => setIsRegex(e.target.checked)}
            type="checkbox"
          />
          <span>{t('editorRegex')}</span>
        </label>
      </div>
    </div>
  );
}
