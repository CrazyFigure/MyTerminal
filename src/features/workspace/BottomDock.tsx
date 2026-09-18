import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { Check, ChevronDown, ChevronUp, Copy, GripVertical, Pencil, Play, Plus, RefreshCw, Search, Square, TerminalSquare, Trash2, X } from 'lucide-react';

import { translateStatus, type TranslationKey } from '../../i18n';
import { Tooltip } from '../../components/Tooltip';
import { writeClipboardText } from '../../clipboard';
import { scoreCommandMatch } from '../../shared/fuzzy';
import {
  isPointInsideElement,
  resolveInsertPlacement,
  useFlipListAnimation,
  type InsertPlacement,
} from '../../app/connectionGroups';
import type { AppSettings, FavoriteCommand, HistoryEntry, TunnelRecord } from '../../types';
import {
  bottomTabs,
  buildActionButtonStyle,
  renderActionButtonLabel,
  type BottomPanelTab,
} from './actionButtons';

type Props = {
  actionsRef: RefObject<HTMLDivElement | null>;
  activeBottomTab: BottomPanelTab;
  activeCommand: string;
  activeConnectionId?: string;
  activeRemoteConnectionId?: string;
  collapsed: boolean;
  /** 命令草稿输入框采用与终端一致的中英文字体栈，防止中文退化为宋体 */
  commandFontFamily?: string;
  compactActions: boolean;
  connectionHistory: HistoryEntry[];
  connectionTunnels: TunnelRecord[];
  favoriteCommands: FavoriteCommand[];
  /**
   * 「命令」页签是否可操作：只看当前聚焦会话能否接收输入，本地终端与 SSH 一视同仁。
   * 不能复用 hasActiveRemoteSession —— 它专门用于远端文件/历史/隧道能力，本地终端恒为 false。
   */
  hasActiveTerminalSession: boolean;
  height: number;
  historyLoading: boolean;
  onChangeCommand: (command: string) => void;
  onChangeTab: (tab: BottomPanelTab) => void;
  onCloseTunnel: (tunnelId: string) => void | Promise<unknown>;
  onDeleteFavorite: (id: string) => void | Promise<unknown>;
  onDeleteTunnel: (tunnelId: string) => void | Promise<unknown>;
  onDuplicateTunnel: (tunnel: TunnelRecord) => void;
  onEditTunnel: (tunnel: TunnelRecord) => void;
  onOpenFavoriteModal: (initialData?: { id?: string; command?: string; remark?: string }) => void;
  onOpenTunnel: () => void | Promise<unknown>;
  onRefreshHistory: () => void | Promise<unknown>;
  onReorderFavorites: (sourceId: string, targetId: string, placement: InsertPlacement) => void | Promise<unknown>;
  onReorderFavoritesToEnd: (sourceId: string) => void | Promise<unknown>;
  onSelectFavorite: (command: string) => void;
  onSelectHistory: (command: string) => void;
  onSendCommand: () => void | Promise<unknown>;
  onStartAllTunnels: () => void | Promise<unknown>;
  onStartTunnel: (tunnelId: string) => void | Promise<unknown>;
  onStopAllTunnels: () => void | Promise<unknown>;
  onToggleCollapsed: () => void;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
  uiLanguage: AppSettings['uiLanguage'];
};

// 底部工作台聚合命令草稿、隧道控制、远端历史与常用收藏四个视图；上层负责实际副作用与连接级页签记忆。
export function BottomDock({
  actionsRef,
  activeBottomTab,
  activeCommand,
  activeConnectionId,
  activeRemoteConnectionId,
  collapsed,
  commandFontFamily,
  compactActions,
  connectionHistory,
  connectionTunnels,
  favoriteCommands,
  hasActiveTerminalSession,
  height,
  historyLoading,
  onChangeCommand,
  onChangeTab,
  onCloseTunnel,
  onDeleteFavorite,
  onDeleteTunnel,
  onDuplicateTunnel,
  onEditTunnel,
  onOpenFavoriteModal,
  onOpenTunnel,
  onRefreshHistory,
  onReorderFavorites,
  onReorderFavoritesToEnd,
  onSelectFavorite,
  onSelectHistory,
  onSendCommand,
  onStartAllTunnels,
  onStartTunnel,
  onStopAllTunnels,
  onToggleCollapsed,
  t,
  uiLanguage,
}: Props) {
  // 历史命令模糊搜索关键词
  const [historySearchQuery, setHistorySearchQuery] = useState('');
  // 收藏命令搜索关键词
  const [favoriteSearchQuery, setFavoriteSearchQuery] = useState('');
  // 复制反馈状态（记录最近一次复制成功的条目 ID）
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 历史命令关键词过滤，匹配优先级：完全匹配 > 前缀匹配 > 后缀匹配 > 连续子串包含
  const filteredHistory = useMemo(() => {
    const query = historySearchQuery.trim();
    if (!query) {
      return connectionHistory;
    }
    return connectionHistory
      .map((item, index) => {
        const score = scoreCommandMatch(item.command, query);
        return score === undefined ? undefined : { item, score, index };
      })
      .filter((entry): entry is { item: HistoryEntry; score: number; index: number } => Boolean(entry))
      .sort((first, second) => first.score - second.score || first.index - second.index)
      .map((entry) => entry.item);
  }, [connectionHistory, historySearchQuery]);

  // 收藏命令模糊搜索过滤（匹配命令语句或自定义备注）
  const filteredFavorites = useMemo(() => {
    const query = favoriteSearchQuery.trim().toLowerCase();
    if (!query) {
      return favoriteCommands;
    }
    return favoriteCommands.filter((item) => {
      const matchCmd = item.command.toLowerCase().includes(query);
      const matchRemark = item.remark ? item.remark.toLowerCase().includes(query) : false;
      return matchCmd || matchRemark;
    });
  }, [favoriteCommands, favoriteSearchQuery]);

  // 复制命令文本到系统剪贴板
  const handleCopyCommand = async (id: string, commandText: string) => {
    try {
      await writeClipboardText(commandText);
      setCopiedId(id);
      setTimeout(() => {
        setCopiedId((curr) => (curr === id ? null : curr));
      }, 2000);
    } catch (err) {
      console.error('Failed to copy command:', err);
    }
  };

  // 收藏命令 Pointer 拖拽与落点状态
  const [favDragState, setFavDragState] = useState<{
    id: string;
    label: string;
    originX: number;
    originY: number;
    currentX: number;
    currentY: number;
  } | null>(null);
  const [favDropTarget, setFavDropTarget] = useState<
    | { type: 'favorite-insert'; favoriteId: string; placement: InsertPlacement }
    | { type: 'favorite-end' }
    | null
  >(null);
  const favDragStateRef = useRef(favDragState);
  const favDropTargetRef = useRef(favDropTarget);
  const favListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    favDragStateRef.current = favDragState;
  }, [favDragState]);

  useEffect(() => {
    favDropTargetRef.current = favDropTarget;
  }, [favDropTarget]);

  // 计算收藏命令拖拽落点
  const resolveFavDropTarget = (
    event: PointerEvent,
    currentDrag: { id: string },
  ): typeof favDropTarget => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const targetRow = target?.closest<HTMLElement>('[data-favorite-id]');
    if (targetRow) {
      const targetFavId = targetRow.dataset.favoriteId;
      if (targetFavId && targetFavId !== currentDrag.id) {
        return {
          type: 'favorite-insert',
          favoriteId: targetFavId,
          placement: resolveInsertPlacement(event, targetRow),
        };
      }
    }
    if (isPointInsideElement(event, favListRef.current)) {
      return { type: 'favorite-end' };
    }
    return null;
  };

  // 启动收藏命令 Pointer 拖拽
  const startFavDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    item: FavoriteCommand,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    setFavDragState({
      id: item.id,
      label: item.command,
      originX: event.clientX,
      originY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
    });
  };

  // 全局指针移动与松手监听，落位后触发持久化排序
  useEffect(() => {
    if (!favDragState) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      setFavDragState((current) => {
        if (!current) {
          return current;
        }
        const nextDropTarget = resolveFavDropTarget(event, current);
        setFavDropTarget((prev) => (
          JSON.stringify(prev) === JSON.stringify(nextDropTarget) ? prev : nextDropTarget
        ));
        return { ...current, currentX: event.clientX, currentY: event.clientY };
      });
    };

    const handlePointerUp = (event: PointerEvent) => {
      const currentDrag = favDragStateRef.current;
      if (!currentDrag) {
        setFavDragState(null);
        setFavDropTarget(null);
        return;
      }
      const finalDropTarget = favDropTargetRef.current ?? resolveFavDropTarget(event, currentDrag);
      setFavDragState(null);
      setFavDropTarget(null);

      if (finalDropTarget?.type === 'favorite-insert') {
        void onReorderFavorites(currentDrag.id, finalDropTarget.favoriteId, finalDropTarget.placement);
      } else if (finalDropTarget?.type === 'favorite-end') {
        void onReorderFavoritesToEnd(currentDrag.id);
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [Boolean(favDragState)]);

  // 收藏命令重排落位后平滑过渡动画
  useFlipListAnimation(favListRef, '[data-favorite-id]', [filteredFavorites.map((c) => c.id).join('|')]);

  return (
    <section className={`bottom-dock card ${collapsed ? 'is-collapsed' : ''}`} style={collapsed ? undefined : { height }}>
      <header ref={actionsRef} className="panel-tab-row">
        <div className="tab-list">
          {bottomTabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                className={`panel-tab ${activeBottomTab === tab.id ? 'is-active' : ''}`}
                onClick={() => onChangeTab(tab.id)}
                type="button"
              >
                <Icon size={16} />
                <span>{t(tab.labelKey)}</span>
              </button>
            );
          })}
        </div>
        {activeBottomTab === 'history' ? (
          <div className="history-search-container">
            <Search className="history-search-icon" size={14} />
            <input
              aria-label={t('historySearchPlaceholder')}
              className="history-search-input"
              onChange={(event) => setHistorySearchQuery(event.target.value)}
              onFocus={() => {
                // 折叠状态下点击/聚焦搜索框自动展开功能栏，便于即时浏览搜索结果
                if (collapsed) {
                  onToggleCollapsed();
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && historySearchQuery) {
                  event.stopPropagation();
                  setHistorySearchQuery('');
                }
              }}
              placeholder={t('historySearchPlaceholder')}
              spellCheck={false}
              type="text"
              value={historySearchQuery}
            />
            {historySearchQuery ? (
              <Tooltip content={t('clear')} side="top">
                <button
                  aria-label={t('clear')}
                  className="history-search-clear-button"
                  onClick={() => setHistorySearchQuery('')}
                  type="button"
                >
                  <X size={12} />
                </button>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
        {/* 收藏 Tab 搜索框 */}
        {activeBottomTab === 'favorites' ? (
          <div className="history-search-container">
            <Search className="history-search-icon" size={14} />
            <input
              aria-label={t('favoriteSearchPlaceholder')}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              className="history-search-input"
              onChange={(event) => setFavoriteSearchQuery(event.target.value)}
              onFocus={() => {
                if (collapsed) {
                  onToggleCollapsed();
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && favoriteSearchQuery) {
                  event.stopPropagation();
                  setFavoriteSearchQuery('');
                }
              }}
              placeholder={t('favoriteSearchPlaceholder')}
              spellCheck={false}
              type="text"
              value={favoriteSearchQuery}
            />
            {favoriteSearchQuery ? (
              <Tooltip content={t('clear')} delayDuration={100} side="top">
                <button
                  aria-label={t('clear')}
                  className="history-search-clear-button"
                  onClick={() => setFavoriteSearchQuery('')}
                  type="button"
                >
                  <X size={12} />
                </button>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
        <div className={`panel-tab-actions ${compactActions ? 'is-compact-actions' : ''}`}>
          <Tooltip content={collapsed ? t('expandBottomDock') : t('collapseBottomDock')} side="top">
            <button
              aria-label={collapsed ? t('expandBottomDock') : t('collapseBottomDock')}
              className="secondary-button"
              onClick={onToggleCollapsed}
              style={buildActionButtonStyle(collapsed ? t('expandBottomDock') : t('collapseBottomDock'), compactActions)}
              type="button"
            >
              {collapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              {renderActionButtonLabel(collapsed ? t('expandBottomDock') : t('collapseBottomDock'), compactActions)}
            </button>
          </Tooltip>
          {activeBottomTab === 'commands' ? (
            <button
              className="primary-button"
              disabled={!hasActiveTerminalSession || !activeCommand.trim()}
              onClick={() => void onSendCommand()}
              style={buildActionButtonStyle(t('sendToTerminal'), compactActions)}
              type="button"
            >
              <Play size={16} /> {renderActionButtonLabel(t('sendToTerminal'), compactActions)}
            </button>
          ) : null}
          {activeBottomTab === 'tunnels' ? (
            <>
              <button
                className="secondary-button"
                disabled={!connectionTunnels.some((item) => item.status !== 'running')}
                onClick={() => void onStartAllTunnels()}
                style={buildActionButtonStyle(t('tunnelStartAll'), compactActions)}
                type="button"
              >
                <Play size={16} /> {renderActionButtonLabel(t('tunnelStartAll'), compactActions)}
              </button>
              <button
                className="secondary-button"
                disabled={!connectionTunnels.some((item) => item.status === 'running')}
                onClick={() => void onStopAllTunnels()}
                style={buildActionButtonStyle(t('tunnelStopAll'), compactActions)}
                type="button"
              >
                <Square size={16} /> {renderActionButtonLabel(t('tunnelStopAll'), compactActions)}
              </button>
              <button
                className="primary-button"
                disabled={!activeConnectionId}
                onClick={() => void onOpenTunnel()}
                style={buildActionButtonStyle(t('newTunnel'), compactActions)}
                type="button"
              >
                <Plus size={16} /> {renderActionButtonLabel(t('newTunnel'), compactActions)}
              </button>
            </>
          ) : null}
          {activeBottomTab === 'history' ? (
            <button
              className="secondary-button"
              disabled={!activeRemoteConnectionId}
              onClick={() => void onRefreshHistory()}
              style={buildActionButtonStyle(t('refresh'), compactActions)}
              type="button"
            >
              <RefreshCw className={historyLoading ? 'is-spinning' : ''} size={16} />
              {renderActionButtonLabel(t('refresh'), compactActions)}
            </button>
          ) : null}
          {/* 收藏 Tab 新增按钮 */}
          {activeBottomTab === 'favorites' ? (
            <button
              className="primary-button"
              onClick={() => onOpenFavoriteModal()}
              style={buildActionButtonStyle(t('favoriteAdd'), compactActions)}
              type="button"
            >
              <Plus size={16} /> {renderActionButtonLabel(t('favoriteAdd'), compactActions)}
            </button>
          ) : null}
        </div>
      </header>

      <div className="panel-body dock-body">
        {activeBottomTab === 'commands' ? (
          <div className="stack command-panel fill-height">
            <textarea
              className="command-editor"
              disabled={!hasActiveTerminalSession}
              placeholder={t('commandTextareaPlaceholder')}
              rows={8}
              spellCheck={false}
              style={{ fontFamily: commandFontFamily }}
              value={activeCommand}
              onChange={(event) => onChangeCommand(event.target.value)}
            />
          </div>
        ) : null}

        {activeBottomTab === 'tunnels' ? (
          <div className="stack panel-stack">
            <div className="tunnel-grid">
              {connectionTunnels.length ? connectionTunnels.map((tunnel) => (
                <div key={tunnel.id} className="tunnel-card">
                  <div>
                    <strong>{tunnel.name}</strong>
                    <p>{tunnel.bindAddress}:{tunnel.localPort}{' -> '}{tunnel.remoteHost}:{tunnel.remotePort}</p>
                  </div>
                  <div className="section-row compact">
                    <span className={`status-badge status-${tunnel.status}`}>{translateStatus(uiLanguage, tunnel.status)}</span>
                    <button className="ghost-button slim" onClick={() => onEditTunnel(tunnel)} type="button">
                      <Pencil size={14} /> {t('edit')}
                    </button>
                    <button className="ghost-button slim" onClick={() => onDuplicateTunnel(tunnel)} type="button">
                      <Copy size={14} /> {t('copy')}
                    </button>
                    {tunnel.status === 'running' ? (
                      <button className="ghost-button slim" onClick={() => void onCloseTunnel(tunnel.id)} type="button">
                        <Square size={14} /> {t('stop')}
                      </button>
                    ) : (
                      <button className="ghost-button slim" onClick={() => void onStartTunnel(tunnel.id)} type="button">
                        <Play size={14} /> {t('start')}
                      </button>
                    )}
                    <button className="ghost-button slim danger-button" onClick={() => void onDeleteTunnel(tunnel.id)} type="button">
                      <Trash2 size={14} /> {t('delete')}
                    </button>
                  </div>
                </div>
              )) : <div className="empty-state">{t('noTunnels')}</div>}
            </div>
          </div>
        ) : null}

        {activeBottomTab === 'history' ? (
          <div className="stack panel-stack">
            <div className="history-list">
              {filteredHistory.length ? filteredHistory.map((item) => (
                <div key={item.id} className="history-row">
                  <div className="history-main">
                    <strong className="history-command-text" style={{ fontFamily: commandFontFamily }}>
                      {item.command}
                    </strong>
                    <span className="history-time-text">
                      {item.executedAt ? new Date(item.executedAt).toLocaleString() : '—'}
                    </span>
                  </div>
                  <div className="history-actions">
                    <Tooltip content={t('applyToCommand')} delayDuration={100} side="top">
                      <button
                        aria-label={t('applyToCommand')}
                        className="ghost-button action-icon-btn apply-btn"
                        disabled={!hasActiveTerminalSession}
                        onClick={() => onSelectHistory(item.command)}
                        type="button"
                      >
                        <TerminalSquare size={16} />
                      </button>
                    </Tooltip>
                    <Tooltip
                      content={copiedId === item.id ? t('historyCopied') : t('copy')}
                      delayDuration={100}
                      side="top"
                    >
                      <button
                        aria-label={t('copy')}
                        className={`ghost-button action-icon-btn history-copy-button ${copiedId === item.id ? 'is-copied' : ''}`}
                        onClick={() => void handleCopyCommand(item.id, item.command)}
                        type="button"
                      >
                        {copiedId === item.id ? <Check className="copy-check-icon" size={16} /> : <Copy size={16} />}
                      </button>
                    </Tooltip>
                  </div>
                </div>
              )) : historyLoading ? (
                <div className="panel-loading-overlay is-inline">
                  <RefreshCw className="is-spinning" size={18} />
                  <span>{t('panelRefreshing')}</span>
                </div>
              ) : (
                <div className="empty-state">
                  {historySearchQuery.trim() ? t('historySearchNoResults') : t('noHistory')}
                </div>
              )}
            </div>
          </div>
        ) : null}

        {/* 收藏命令列表视图：支持拖拽重排、备注显示、快捷应用、复制、编辑与删除 */}
        {activeBottomTab === 'favorites' ? (
          <div className="stack panel-stack">
            <div
              ref={favListRef}
              className={`favorites-list ${favDropTarget?.type === 'favorite-end' ? 'is-drop-end' : ''}`}
            >
              {filteredFavorites.length ? (
                filteredFavorites.map((item) => (
                  <div
                    key={item.id}
                    data-favorite-id={item.id}
                    className={`favorite-row ${favDragState?.id === item.id ? 'is-dragging' : ''} ${
                      favDropTarget?.type === 'favorite-insert' && favDropTarget.favoriteId === item.id
                        ? `is-drop-${favDropTarget.placement}`
                        : ''
                    }`}
                  >
                    {/* 拖动排序手柄 */}
                    <Tooltip content={t('favoriteDragHandleTooltip')} delayDuration={100} side="right">
                      <button
                        aria-label={t('favoriteDragHandleTooltip')}
                        className="drag-handle"
                        onPointerDown={(event) => startFavDrag(event, item)}
                        type="button"
                      >
                        <GripVertical size={16} />
                      </button>
                    </Tooltip>

                    {/* 收藏主体内容 */}
                    <div className="favorite-main">
                      <strong className="favorite-command-text" style={{ fontFamily: commandFontFamily }}>
                        {item.command}
                      </strong>
                      {item.remark ? <span className="favorite-remark-text">{item.remark}</span> : null}
                    </div>

                    {/* 操作按钮区：应用到命令、复制、编辑、删除 */}
                    <div className="favorite-actions">
                      <Tooltip content={t('applyToCommand')} delayDuration={100} side="top">
                        <button
                          aria-label={t('applyToCommand')}
                          className="ghost-button action-icon-btn apply-btn"
                          disabled={!hasActiveTerminalSession}
                          onClick={() => onSelectFavorite(item.command)}
                          type="button"
                        >
                          <TerminalSquare size={16} />
                        </button>
                      </Tooltip>
                      <Tooltip
                        content={copiedId === item.id ? t('favoriteCopied') : t('copy')}
                        delayDuration={100}
                        side="top"
                      >
                        <button
                          aria-label={t('copy')}
                          className={`ghost-button action-icon-btn favorite-copy-btn ${copiedId === item.id ? 'is-copied' : ''}`}
                          onClick={() => void handleCopyCommand(item.id, item.command)}
                          type="button"
                        >
                          {copiedId === item.id ? <Check className="copy-check-icon" size={16} /> : <Copy size={16} />}
                        </button>
                      </Tooltip>
                      <Tooltip content={t('edit')} delayDuration={100} side="top">
                        <button
                          aria-label={t('edit')}
                          className="ghost-button action-icon-btn"
                          onClick={() => onOpenFavoriteModal({ id: item.id, command: item.command, remark: item.remark })}
                          type="button"
                        >
                          <Pencil size={16} />
                        </button>
                      </Tooltip>
                      <Tooltip content={t('delete')} delayDuration={100} side="top">
                        <button
                          aria-label={t('delete')}
                          className="ghost-button action-icon-btn danger-button"
                          onClick={() => void onDeleteFavorite(item.id)}
                          type="button"
                        >
                          <Trash2 size={16} />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-state">
                  {favoriteSearchQuery.trim() ? t('historySearchNoResults') : t('noFavorites')}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
