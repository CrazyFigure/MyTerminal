/* 本模块由 App 入口按功能域拆出，保留原组件行为与状态订阅方式。 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import {
  Ban,
  FolderOpen,
  GripVertical,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Terminal,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { translate, type TranslationKey } from '../i18n';
import { useAppStore } from '../store';
import { backend } from '../backend';
import type {
  LocalTerminalCommand,
  LocalTerminalProfile,
  LocalTerminalSettings,
  LocalTerminalShellConfig,
} from '../types';
import { CustomSelect, type CustomSelectOption } from '../CustomSelect';
import { Tooltip } from './Tooltip';
import { beginResize, clamp } from '../app/layout';
import {
  isPointInsideElement,
  moveItemToEnd,
  moveItemToInsert,
  resolveInsertPlacement,
  useFlipListAnimation,
  type InsertPlacement,
} from '../app/connectionGroups';
import {
  AVAILABLE_COMMAND_ICONS,
  AI_COMMAND_ICONS,
  SHELL_COMMAND_ICONS,
  cleanShellName,
  createLocalTerminalProfile,
  defaultLocalTerminalCwd,
  getLocalTerminalIcon,
  getSystemShellIcon,
  normalizeLocalTerminalProfileTitle,
  resolveIconDisplayUrl,
} from '../app/localTerminal';

interface EditingCommandState {
  isOpen: boolean;
  isEdit: boolean;
  id: string;
  name: string;
  command: string;
  icon?: string;
}

// 左右分栏之间的拖拽分隔条宽度，必须与 .local-terminal-v2-resizer 的 CSS 宽度保持一致
const RESIZER_WIDTH = 14;

// 系统终端下拉选项标签：统一图标与名称排版，供启动项与默认终端下拉复用，图标缺失时退回终端字形。
const renderShellOptionLabel = (shell: LocalTerminalShellConfig) => {
  const cleanedName = cleanShellName(shell.name);
  const iconPath = resolveIconDisplayUrl(getSystemShellIcon({ ...shell, name: cleanedName }));
  return (
    <div className="local-terminal-select-option">
      {iconPath ? (
        <img src={iconPath} className="local-terminal-select-icon" alt="" />
      ) : (
        <Terminal size={13} className="local-terminal-select-fallback-icon" />
      )}
      <span>{cleanedName}</span>
    </div>
  );
};

export function LocalTerminalManagerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const {
    localTerminals,
    openLocalTerminal,
    saveLocalTerminals,
    settings,
    setStatusMessage,
  } = useAppStore(
    useShallow((state) => ({
      localTerminals: state.localTerminals,
      openLocalTerminal: state.openLocalTerminal,
      saveLocalTerminals: state.saveLocalTerminals,
      settings: state.settings,
      setStatusMessage: state.setStatusMessage,
    })),
  );

  const [draft, setDraft] = useState<LocalTerminalSettings>(localTerminals);
  // 当前启动目录默认落到工作区，避免用户第一次打开时面对空白路径。
  const [cwd, setCwd] = useState(localTerminals.profiles[0]?.cwd ?? defaultLocalTerminalCwd);
  // 启动项允许为空值，空值表示直接打开默认 shell。
  const [command, setCommand] = useState(localTerminals.profiles[0]?.command ?? localTerminals.commands[0]?.command ?? '');
  // 历史目录保留最近一次选择的命令，打开时允许单独切换，不把历史固定死成单一入口。
  const [profileCommands, setProfileCommands] = useState<Record<string, string>>({});

  // 系统 Shell 检测中状态与反馈
  const [detectingShells, setDetectingShells] = useState(false);
  const [scanNotice, setScanNotice] = useState<string | null>(null);

  // 左右分栏容器与拖动宽度调整状态（两栏默认等宽，拖动后以像素固定）
  const twoColsRef = useRef<HTMLDivElement>(null);
  const [splitLeftWidth, setSplitLeftWidth] = useState<number | null>(null);

  // 左右分栏拖动改变宽度的处理事件
  const handleResizerPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const container = twoColsRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    // 初始宽度必须等于 CSS 的等宽布局实际值（扣除中间分隔条），否则首次拖动会跳变
    const currentLeft = splitLeftWidth ?? (rect.width - RESIZER_WIDTH) / 2;
    const startX = event.clientX;
    const minLeft = 240;
    const maxLeft = Math.max(minLeft, rect.width - 240 - RESIZER_WIDTH);

    beginResize(event, (moveEvent) => {
      const delta = moveEvent.clientX - startX;
      const nextWidth = clamp(currentLeft + delta, minLeft, maxLeft);
      setSplitLeftWidth(nextWidth);
    });
  }, [splitLeftWidth]);

  // 预设命令新增与编辑子弹窗状态
  const [editingCommand, setEditingCommand] = useState<EditingCommandState | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);

  // 预设命令 Pointer 拖拽与落点状态（对齐连接管理交互，避免 Windows WebView 原生拖拽异常）
  const [commandDragState, setCommandDragState] = useState<{
    id: string;
    label: string;
    originX: number;
    originY: number;
    currentX: number;
    currentY: number;
  } | null>(null);
  const [commandDropTarget, setCommandDropTarget] = useState<
    | { type: 'command-insert'; commandId: string; placement: InsertPlacement }
    | { type: 'command-end' }
    | null
  >(null);
  const commandDragStateRef = useRef(commandDragState);
  const commandDropTargetRef = useRef(commandDropTarget);
  const commandListRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    commandDragStateRef.current = commandDragState;
  }, [commandDragState]);

  useEffect(() => {
    commandDropTargetRef.current = commandDropTarget;
  }, [commandDropTarget]);

  const t = (key: TranslationKey, replacements?: Record<string, string | number>) =>
    translate(settings.uiLanguage, key, replacements);

  const persistDraft = async (nextDraft: LocalTerminalSettings) => {
    setDraft(nextDraft);
    await saveLocalTerminals(nextDraft);
  };

  // 聚合生成启动项下拉选项（区分系统终端与预设命令两组，不再保留冗余的「本地终端」项）
  const startupOptions: CustomSelectOption[] = useMemo(() => [
    // 1. 已开启的系统终端
    ...(draft.shells ?? [])
      .filter((s) => s.enabled !== false)
      .map((shell) => ({
        value: `shell:${shell.id}`,
        group: t('localTerminalSystemShells'),
        label: renderShellOptionLabel(shell),
      })),
    // 2. 预设命令（排除内置空的 shell）
    ...draft.commands
      .filter((item) => item.id !== 'shell' && Boolean(item.command.trim()))
      .map((item) => {
        const rawIcon = getLocalTerminalIcon(item.name, item.command, item.icon);
        const iconPath = resolveIconDisplayUrl(rawIcon);
        return {
          value: item.command,
          group: t('localTerminalPresetCommands'),
          label: (
            <div className="local-terminal-select-option">
              {iconPath && <img src={iconPath} className="local-terminal-select-icon" alt="" />}
              <span>{item.name}</span>
            </div>
          ),
        };
      }),
  ], [draft.shells, draft.commands, settings.uiLanguage]);

  // 默认终端下拉选项：仅列出左侧开关已打开的系统终端，首项“自动选择”用于恢复按开启顺序自动回落
  const defaultShellOptions: CustomSelectOption[] = useMemo(() => [
    {
      value: '',
      label: (
        <div className="local-terminal-select-option">
          <Sparkles size={13} className="local-terminal-select-fallback-icon" />
          <span>{t('localTerminalDefaultShellAuto')}</span>
        </div>
      ),
    },
    ...(draft.shells ?? [])
      .filter((shell) => shell.enabled !== false)
      .map((shell) => ({
        value: shell.id,
        label: renderShellOptionLabel(shell),
      })),
  ], [draft.shells, settings.uiLanguage]);

  // 切换预设命令默认使用的系统终端；选择“自动选择”即清空显式指定，交由后端按开启顺序回落
  const handleDefaultShellChange = async (shellId: string) => {
    await persistDraft({ ...draft, defaultShellId: shellId });
  };

  useEffect(() => {
    if (!open) {
      setCommandDragState(null);
      setCommandDropTarget(null);
      return;
    }
    setDraft(localTerminals);
    setCwd(localTerminals.profiles[0]?.cwd ?? defaultLocalTerminalCwd);
    const initialCmd = localTerminals.profiles[0]?.command ?? localTerminals.commands[0]?.command ?? '';
    setCommand(initialCmd || (startupOptions[0]?.value ?? ''));
    setProfileCommands(Object.fromEntries(localTerminals.profiles.map((profile) => [profile.id, profile.command || (startupOptions[0]?.value ?? '')])));
    setEditingCommand(null);
    setCommandError(null);
    setScanNotice(null);
    setCommandDragState(null);
    setCommandDropTarget(null);
  }, [open]);

  // 当启动选项列表更新且当前选中的 command 为空或不在选项内时，自动校准为第一个可用项
  useEffect(() => {
    if (startupOptions.length > 0 && (!command || !startupOptions.some((opt) => opt.value === command))) {
      setCommand(startupOptions[0].value);
    }
  }, [startupOptions, command]);

  // 目录与 Shell 路径浏览
  const browseDirectory = async () => {
    const selected = await openFileDialog({
      directory: true,
      multiple: false,
      defaultPath: cwd,
    }).catch(() => null);
    if (typeof selected === 'string') {
      setCwd(selected);
    }
  };

  const browseShellPath = async () => {
    const selected = await openFileDialog({
      directory: false,
      multiple: false,
      defaultPath: draft.shellPath || undefined,
    }).catch(() => null);
    if (typeof selected === 'string') {
      setDraft((current) => ({ ...current, shellPath: selected }));
    }
  };

  // 检测系统终端
  const handleDetectShells = async () => {
    if (detectingShells) {
      return;
    }
    setDetectingShells(true);
    setScanNotice(null);
    try {
      const detected = await backend.detectSystemShells();
      const existingMap = new Map((draft.shells ?? []).map((s) => [s.id, s]));
      const merged: LocalTerminalShellConfig[] = detected.map((item) => {
        const existing = existingMap.get(item.id);
        const cleanedName = cleanShellName(item.name);
        return existing
          ? { ...item, name: cleanedName, enabled: existing.enabled }
          : { ...item, name: cleanedName };
      });
      const nextDraft = { ...draft, shells: merged };
      await persistDraft(nextDraft);
      setScanNotice(t('localTerminalDetectedShellsCount', { count: merged.length }));
      setTimeout(() => setScanNotice(null), 3500);
    } catch (err) {
      console.error('Failed to detect system shells:', err);
    } finally {
      setDetectingShells(false);
    }
  };

  // 切换系统 Shell 是否在启动下拉中展示
  const toggleShellEnabled = async (shellId: string) => {
    const nextShells = (draft.shells ?? []).map((s) =>
      s.id === shellId ? { ...s, enabled: !s.enabled } : s
    );
    // 关闭的系统终端不能再作为默认终端：一旦关掉当前选中项就同步清空，避免下拉展示与启动行为不一致
    const disabledSelectedDefault =
      nextShells.find((s) => s.id === shellId)?.enabled === false && draft.defaultShellId === shellId;
    const nextDraft = {
      ...draft,
      shells: nextShells,
      defaultShellId: disabledSelectedDefault ? '' : draft.defaultShellId,
    };
    await persistDraft(nextDraft);
  };

  // 打开终端
  const openCurrentTerminal = async () => {
    const normalizedCwd = cwd.trim();
    const effectiveCommand = (command.trim() || startupOptions[0]?.value || '').trim();
    if (!normalizedCwd) {
      setStatusMessage(t('validationLocalTerminalCwdRequired'));
      return;
    }
    await persistDraft(draft);
    onClose();
    void openLocalTerminal(createLocalTerminalProfile(normalizedCwd, effectiveCommand));
  };

  // 打开历史记录终端
  const openProfile = (profile: LocalTerminalProfile, selectedCommand: string) => {
    const effectiveCommand = (selectedCommand.trim() || startupOptions[0]?.value || '').trim();
    onClose();
    void openLocalTerminal({
      ...profile,
      command: effectiveCommand,
      title: normalizeLocalTerminalProfileTitle(profile.cwd, effectiveCommand),
    });
  };

  // 历史项删除
  const deleteProfile = async (profileId: string) => {
    await persistDraft({
      ...draft,
      profiles: draft.profiles.filter((profile) => profile.id !== profileId),
    });
  };

  // 计算预设命令拖拽落点（优先判断目标项的前后半区，或判定是否落在列表底部空白）
  const resolveCommandDropTarget = (
    event: PointerEvent,
    currentDrag: { id: string },
  ): typeof commandDropTarget => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const targetRow = target?.closest<HTMLElement>('[data-command-id]');
    if (targetRow) {
      const targetCommandId = targetRow.dataset.commandId;
      if (targetCommandId && targetCommandId !== currentDrag.id) {
        return {
          type: 'command-insert',
          commandId: targetCommandId,
          placement: resolveInsertPlacement(event, targetRow),
        };
      }
    }
    if (isPointInsideElement(event, commandListRef.current)) {
      return { type: 'command-end' };
    }
    return null;
  };

  // 启动预设命令 Pointer 拖拽，通过 setPointerCapture 确保指针追踪不丢失
  const startCommandDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    item: { id: string; name: string },
  ) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    setCommandDragState({
      id: item.id,
      label: item.name,
      originX: event.clientX,
      originY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
    });
  };

  // 处理预设命令插入排序（保持内置 shell 占位项不变，准确计算自定义命令顺序）
  const handleReorderCommands = (sourceId: string, targetId: string, placement: InsertPlacement) => {
    setCommandDragState(null);
    setCommandDropTarget(null);
    const customCommands = draft.commands.filter((c) => c.id !== 'shell');
    const shellCommands = draft.commands.filter((c) => c.id === 'shell');
    const currentIds = customCommands.map((c) => c.id);
    const nextIds = moveItemToInsert(currentIds, sourceId, targetId, placement);
    const commandMap = new Map(customCommands.map((c) => [c.id, c]));
    const reorderedCustom = nextIds.map((id) => commandMap.get(id)!).filter(Boolean);
    const nextCommands = [...shellCommands, ...reorderedCustom];
    void persistDraft({ ...draft, commands: nextCommands });
  };

  // 处理预设命令移动到列表末尾
  const handleReorderCommandsToEnd = (sourceId: string) => {
    setCommandDragState(null);
    setCommandDropTarget(null);
    const customCommands = draft.commands.filter((c) => c.id !== 'shell');
    const shellCommands = draft.commands.filter((c) => c.id === 'shell');
    const currentIds = customCommands.map((c) => c.id);
    const nextIds = moveItemToEnd(currentIds, sourceId);
    const commandMap = new Map(customCommands.map((c) => [c.id, c]));
    const reorderedCustom = nextIds.map((id) => commandMap.get(id)!).filter(Boolean);
    const nextCommands = [...shellCommands, ...reorderedCustom];
    void persistDraft({ ...draft, commands: nextCommands });
  };

  // 监听全局指针移动与释放事件
  useEffect(() => {
    if (!commandDragState) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      setCommandDragState((current) => {
        if (!current) {
          return current;
        }
        const nextDropTarget = resolveCommandDropTarget(event, current);
        setCommandDropTarget((prev) => (
          JSON.stringify(prev) === JSON.stringify(nextDropTarget) ? prev : nextDropTarget
        ));
        return { ...current, currentX: event.clientX, currentY: event.clientY };
      });
    };

    const handlePointerUp = (event: PointerEvent) => {
      const currentDrag = commandDragStateRef.current;
      if (!currentDrag) {
        setCommandDragState(null);
        setCommandDropTarget(null);
        return;
      }
      const finalDropTarget = commandDropTargetRef.current ?? resolveCommandDropTarget(event, currentDrag);
      setCommandDragState(null);
      setCommandDropTarget(null);

      if (finalDropTarget?.type === 'command-insert') {
        handleReorderCommands(currentDrag.id, finalDropTarget.commandId, finalDropTarget.placement);
      } else if (finalDropTarget?.type === 'command-end') {
        handleReorderCommandsToEnd(currentDrag.id);
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [Boolean(commandDragState)]);

  // 选择本地自定义图标文件
  const browseCustomIconFile = async () => {
    const selected = await openFileDialog({
      directory: false,
      multiple: false,
      filters: [
        {
          name: 'Image',
          extensions: ['svg', 'png', 'jpg', 'jpeg', 'webp'],
        },
      ],
    }).catch(() => null);
    if (typeof selected === 'string') {
      setEditingCommand((current) => (current ? { ...current, icon: selected } : null));
    }
  };

  // 打开新增命令弹窗
  const openNewCommandModal = () => {
    setEditingCommand({
      isOpen: true,
      isEdit: false,
      id: crypto.randomUUID(),
      name: '',
      command: '',
      icon: 'none',
    });
    setCommandError(null);
  };

  // 打开编辑命令弹窗
  const openEditCommandModal = (item: LocalTerminalCommand) => {
    setEditingCommand({
      isOpen: true,
      isEdit: true,
      id: item.id,
      name: item.name,
      command: item.command,
      icon: item.icon !== undefined ? item.icon : getLocalTerminalIcon(item.name, item.command) || 'none',
    });
    setCommandError(null);
  };

  // 保存新增/编辑的预设命令
  const handleSaveCommandModal = async () => {
    if (!editingCommand) {
      return;
    }
    const name = editingCommand.name.trim();
    const cmd = editingCommand.command.trim();
    if (!name) {
      setCommandError(t('localTerminalNameRequired'));
      return;
    }
    if (!cmd) {
      setCommandError(t('localTerminalCommandRequired'));
      return;
    }

    // 名称排重（排除自身）
    const isDuplicate = draft.commands.some(
      (item) => item.id !== editingCommand.id && item.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (isDuplicate) {
      setCommandError(t('localTerminalNameDuplicate'));
      return;
    }

    const finalIcon = editingCommand.icon?.trim() === 'none' ? 'none' : (editingCommand.icon?.trim() || undefined);

    let nextCommands: LocalTerminalCommand[];
    if (editingCommand.isEdit) {
      nextCommands = draft.commands.map((item) =>
        item.id === editingCommand.id
          ? {
              ...item,
              name,
              command: cmd,
              icon: finalIcon,
            }
          : item
      );
    } else {
      nextCommands = [
        ...draft.commands,
        {
          id: editingCommand.id,
          name,
          command: cmd,
          icon: finalIcon,
          builtIn: false,
        },
      ];
    }

    const nextDraft = { ...draft, commands: nextCommands };
    await persistDraft(nextDraft);
    setEditingCommand(null);
    setCommandError(null);
  };

  // 删除预设命令
  const deleteCommand = async (commandId: string) => {
    const target = draft.commands.find((item) => item.id === commandId);
    if (!target || target.id === 'shell') {
      return;
    }
    const nextCommands = draft.commands.filter((item) => item.id !== commandId);
    const nextDraft = { ...draft, commands: nextCommands };
    await persistDraft(nextDraft);
    if (command === target.command) {
      setCommand(nextCommands[0]?.command ?? '');
    }
  };

  // 预设命令显示列表（排除内置空 shell）
  const displayCommands = draft.commands.filter((c) => c.id !== 'shell');
  // 预设命令重排落位后平滑过渡动画
  useFlipListAnimation(commandListRef, '[data-command-id]', [displayCommands.map((c) => c.id).join('|')]);

  // 仅在弹窗开启时渲染 DOM，所有 Hook 均已在上方执行完毕，保证渲染顺序稳定
  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <div className="modal card modal-wide local-terminal-modal">
        <div className="modal-header">
          <div>
            <h3>{t('localTerminalTitle')}</h3>
          </div>
          <button className="icon-button" onClick={onClose} type="button">
            <X size={18} />
          </button>
        </div>

        <div className="local-terminal-v2-layout">
          
          {/* ================= 第一横块：环境与命令整合（移除冗余大标题，子标题提正） ================= */}
          <section className="local-terminal-v2-block">
            <div
              ref={twoColsRef}
              className="local-terminal-v2-two-cols"
              style={splitLeftWidth ? { gridTemplateColumns: `${splitLeftWidth}px ${RESIZER_WIDTH}px 1fr` } : undefined}
            >
              {/* 左列：系统终端 Shell 列表 */}
              <div className="local-terminal-v2-subcard">
                <div className="local-terminal-v2-subcard-header">
                  <div className="local-terminal-v2-subcard-title">
                    <strong>{t('localTerminalSystemShells')}</strong>
                    {scanNotice && <span className="local-terminal-scan-notice">{scanNotice}</span>}
                  </div>
                  <Tooltip content={t('localTerminalDetectShells')} delayDuration={100} side="top">
                    <button
                      className="secondary-button slim local-terminal-subcard-btn"
                      disabled={detectingShells}
                      onClick={() => void handleDetectShells()}
                      type="button"
                    >
                      <RefreshCw className={detectingShells ? 'spin' : ''} size={12} />
                      <span>{detectingShells ? t('localTerminalDetecting') : t('localTerminalDetectShells')}</span>
                    </button>
                  </Tooltip>
                </div>

                <div className="local-terminal-v2-list">
                  {draft.shells && draft.shells.length > 0 ? (
                    draft.shells.map((shell) => {
                      const cleanedName = cleanShellName(shell.name);
                      const rawIcon = getSystemShellIcon({ ...shell, name: cleanedName });
                      const iconPath = resolveIconDisplayUrl(rawIcon);
                      return (
                        <div key={shell.id} className="local-terminal-shell-item">
                          <div className="local-terminal-shell-item-info">
                            {iconPath ? (
                              <img src={iconPath} className="local-terminal-shell-icon" alt="" />
                            ) : (
                              <Terminal size={15} className="local-terminal-shell-icon" />
                            )}
                            <div className="local-terminal-shell-meta">
                              <span className="local-terminal-shell-name">{cleanedName}</span>
                              <Tooltip content={shell.command} delayDuration={100} side="top">
                                <span className="local-terminal-shell-path">
                                  {shell.command}
                                </span>
                              </Tooltip>
                            </div>
                          </div>
                          <Tooltip content={t('localTerminalShowInDropdown')} delayDuration={100} side="top">
                            <label className="local-terminal-switch">
                              <input
                                checked={shell.enabled !== false}
                                onChange={() => void toggleShellEnabled(shell.id)}
                                type="checkbox"
                              />
                              <span className="local-terminal-slider" />
                            </label>
                          </Tooltip>
                        </div>
                      );
                    })
                  ) : (
                    <div className="empty-state local-terminal-empty-hint">
                      点击卡片右上角「{t('localTerminalDetectShells')}」即可自动获取系统终端
                    </div>
                  )}
                </div>

                {/* 自定义 Shell 路径后备行 */}
                <div className="local-terminal-v2-custom-shell-row">
                  <input
                    placeholder={t('localTerminalShellPathPlaceholder')}
                    value={draft.shellPath}
                    onChange={(e) => setDraft((current) => ({ ...current, shellPath: e.target.value }))}
                  />
                  <Tooltip content={t('localTerminalBrowse')} delayDuration={100} side="top">
                    <button className="secondary-button slim local-terminal-icon-action-btn" onClick={() => void browseShellPath()} type="button">
                      <FolderOpen size={13} />
                    </button>
                  </Tooltip>
                  <Tooltip content={t('localTerminalSave')} delayDuration={100} side="top">
                    <button className="secondary-button slim local-terminal-icon-action-btn" onClick={() => void persistDraft(draft)} type="button">
                      <Save size={13} />
                    </button>
                  </Tooltip>
                </div>
              </div>

              {/* 中间：可拖拽调整左右栏宽度的分隔条 */}
              <div
                className="local-terminal-v2-resizer"
                onPointerDown={handleResizerPointerDown}
                role="separator"
                aria-orientation="vertical"
                aria-label="拖拽调整左右栏宽度"
              />

              {/* 右列：预设命令列表 */}
              <div className="local-terminal-v2-subcard">
                <div className="local-terminal-v2-subcard-header">
                  <div className="local-terminal-v2-subcard-title">
                    <strong>{t('localTerminalPresetCommands')}</strong>
                  </div>
                  <div className="local-terminal-v2-subcard-actions">
                    {/* 默认终端选择：决定预设命令与直接打开的本地终端使用哪个系统终端 */}
                    <Tooltip content={t('localTerminalDefaultShellHint')} delayDuration={100} side="top">
                      <div className="local-terminal-default-shell">
                        <CustomSelect
                          aria-label={t('localTerminalDefaultShell')}
                          className="local-terminal-default-shell-select"
                          emptyText={t('localTerminalDefaultShellEmpty')}
                          onChange={(value) => void handleDefaultShellChange(value)}
                          options={defaultShellOptions}
                          value={draft.defaultShellId ?? ''}
                        />
                      </div>
                    </Tooltip>
                    <Tooltip content={t('localTerminalAddCommand')} delayDuration={100} side="top">
                      <button
                        className="primary-button slim local-terminal-subcard-btn"
                        onClick={openNewCommandModal}
                        type="button"
                      >
                        <Plus size={12} />
                        <span>{t('localTerminalAddCommand')}</span>
                      </button>
                    </Tooltip>
                  </div>
                </div>

                {/* 预设命令列表：分配独立类名以撑满右侧卡片垂直高度，与左侧自定义终端输入栏底边对齐 */}
                <div
                  ref={commandListRef}
                  className={`local-terminal-v2-list local-terminal-v2-command-list ${commandDropTarget?.type === 'command-end' ? 'is-drop-end' : ''}`}
                >
                  {displayCommands.length > 0 ? (
                    displayCommands.map((item) => {
                      const rawIcon = getLocalTerminalIcon(item.name, item.command, item.icon);
                      const iconPath = resolveIconDisplayUrl(rawIcon);
                      return (
                        <div
                          key={item.id}
                          data-command-id={item.id}
                          className={`local-terminal-command-row-v2 ${commandDragState?.id === item.id ? 'is-dragging' : ''} ${commandDropTarget?.type === 'command-insert' && commandDropTarget.commandId === item.id ? `is-drop-${commandDropTarget.placement}` : ''}`}
                        >
                          <div className="local-terminal-command-row-left">
                            <Tooltip content={`拖动预设命令 ${item.name}`} delayDuration={100} side="right">
                              <button
                                aria-label={`拖动预设命令 ${item.name}`}
                                className="drag-handle"
                                onPointerDown={(event) => startCommandDrag(event, item)}
                                type="button"
                              >
                                <GripVertical size={13} />
                              </button>
                            </Tooltip>
                            {iconPath ? (
                              <img src={iconPath} className="local-terminal-row-icon" alt="" />
                            ) : null}
                            <span className="local-terminal-cmd-name">{item.name}</span>
                            <Tooltip content={item.command} delayDuration={100} side="top">
                              <span className="local-terminal-cmd-instruction">
                                {item.command}
                              </span>
                            </Tooltip>
                          </div>

                          <div className="local-terminal-cmd-actions">
                            <Tooltip content={t('localTerminalEditCommand')} delayDuration={100} side="top">
                              <button
                                aria-label={t('localTerminalEditCommand')}
                                className="icon-button"
                                onClick={() => openEditCommandModal(item)}
                                type="button"
                              >
                                <Pencil size={13} />
                              </button>
                            </Tooltip>
                            {/* 预设命令均允许删除，不再受内置锁定限制 */}
                            <Tooltip
                              content={t('localTerminalDeleteCommand')}
                              delayDuration={100}
                              side="top"
                            >
                              <button
                                aria-label={t('localTerminalDeleteCommand')}
                                className="icon-button"
                                onClick={() => void deleteCommand(item.id)}
                                type="button"
                              >
                                <Trash2 size={13} />
                              </button>
                            </Tooltip>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="empty-state local-terminal-empty-hint">
                      暂无预设命令，点击卡片右上角「{t('localTerminalAddCommand')}」添加
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* ================= 第二横块：打开终端（省去冗余标签，空间全给路径） ================= */}
          <section className="local-terminal-v2-block local-terminal-v2-open-block">
            <div className="local-terminal-v2-open-row">
              {/* 目录输入与浏览 */}
              <div className="local-terminal-v2-input-group">
                <input
                  className="local-terminal-dir-input"
                  placeholder={t('localTerminalDirectoryPlaceholder')}
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                />
                <Tooltip content={t('localTerminalBrowse')} delayDuration={100} side="top">
                  <button
                    className="secondary-button local-terminal-browse-btn"
                    onClick={() => void browseDirectory()}
                    type="button"
                  >
                    <FolderOpen size={14} />
                    <span>{t('localTerminalBrowse')}</span>
                  </button>
                </Tooltip>
              </div>

              {/* 启动项下拉 */}
              <div className="local-terminal-v2-select-group">
                <CustomSelect
                  className="local-terminal-startup-select"
                  value={command}
                  onChange={setCommand}
                  options={startupOptions}
                />
              </div>

              {/* 打开终端主按钮 */}
              <button
                className="primary-button local-terminal-open-btn"
                onClick={() => void openCurrentTerminal()}
                type="button"
              >
                <Play size={14} />
                <span>{t('localTerminalOpenTerminal')}</span>
              </button>
            </div>
          </section>

          {/* ================= 第三横块：历史目录（单行高密度，展示更多内容） ================= */}
          <section className="local-terminal-v2-block local-terminal-v2-history-block">
            <div className="local-terminal-v2-block-header">
              <div className="local-terminal-v2-block-title">
                <strong>{t('localTerminalHistoryTitle')}</strong>
              </div>
            </div>

            <div className="local-terminal-v2-history-list">
              {draft.profiles.length > 0 ? (
                draft.profiles.map((profile) => (
                  <div key={profile.id} className="local-terminal-v2-history-row">
                    <Tooltip content={profile.cwd} delayDuration={100} side="top">
                      <div className="local-terminal-v2-history-path">
                        <FolderOpen size={14} className="local-terminal-history-folder-icon" />
                        <span>{profile.cwd}</span>
                      </div>
                    </Tooltip>

                    <div className="local-terminal-v2-history-controls">
                      <CustomSelect
                        className="local-terminal-v2-history-select"
                        value={profileCommands[profile.id] ?? profile.command ?? (startupOptions[0]?.value ?? '')}
                        onChange={(val) => setProfileCommands((current) => ({ ...current, [profile.id]: val }))}
                        options={startupOptions}
                      />
                      <button
                        className="secondary-button slim local-terminal-history-open-btn"
                        onClick={() => openProfile(profile, profileCommands[profile.id] ?? profile.command ?? '')}
                        type="button"
                      >
                        <Play size={12} />
                        <span>{t('localTerminalOpen')}</span>
                      </button>
                      <Tooltip content={t('localTerminalDeleteHistory')} delayDuration={100} side="top">
                        <button
                          aria-label={t('localTerminalDeleteHistory')}
                          className="icon-button local-terminal-history-del-btn"
                          onClick={() => void deleteProfile(profile.id)}
                          type="button"
                        >
                          <X size={14} />
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-state">{t('localTerminalHistoryEmpty')}</div>
              )}
            </div>
          </section>

        </div>

        {/* ================= 预设命令新增与编辑子弹窗 ================= */}
        {editingCommand && (
          <div className="modal-backdrop sub-modal-backdrop">
            <div className="modal card local-terminal-cmd-submodal">
              <div className="modal-header">
                <div>
                  <h3>{editingCommand.isEdit ? t('localTerminalEditCommand') : t('localTerminalConfigureCommand')}</h3>
                </div>
                <button
                  className="icon-button"
                  onClick={() => setEditingCommand(null)}
                  type="button"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="local-terminal-cmd-form">
                {/* 1. 图标选择与自定义 */}
                <div className="local-terminal-form-field">
                  <label className="local-terminal-form-label">{t('localTerminalSelectIcon')}</label>
                  <div className="local-terminal-icon-grid">
                    {/* AI 助手预设图标 */}
                    <div className="local-terminal-icon-group-label">
                      <span>AI 编程助手</span>
                    </div>
                    {AI_COMMAND_ICONS.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={`local-terminal-icon-card ${editingCommand.icon === item.path ? 'is-selected' : ''}`}
                        onClick={() => setEditingCommand({ ...editingCommand, icon: item.path })}
                      >
                        <div className="local-terminal-icon-img-wrap">
                          <img src={item.path} alt={item.name} />
                        </div>
                        <span className="local-terminal-icon-name">{item.name}</span>
                      </button>
                    ))}

                    {/* 系统终端 Shell 预设图标 */}
                    <div className="local-terminal-icon-group-label">
                      <span>系统终端 Shell</span>
                    </div>
                    {SHELL_COMMAND_ICONS.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className={`local-terminal-icon-card ${editingCommand.icon === item.path ? 'is-selected' : ''}`}
                        onClick={() => setEditingCommand({ ...editingCommand, icon: item.path })}
                      >
                        <div className="local-terminal-icon-img-wrap">
                          <img src={item.path} alt={item.name} />
                        </div>
                        <span className="local-terminal-icon-name">{item.name}</span>
                      </button>
                    ))}

                    {/* 其它选项 */}
                    <div className="local-terminal-icon-group-label">
                      <span>其它与自定义</span>
                    </div>
                    {/* 无图标 */}
                    <button
                      type="button"
                      className={`local-terminal-icon-card ${!editingCommand.icon || editingCommand.icon === 'none' ? 'is-selected' : ''}`}
                      onClick={() => setEditingCommand({ ...editingCommand, icon: 'none' })}
                    >
                      <div className="local-terminal-icon-img-wrap">
                        <Ban size={17} className="local-terminal-icon-none" />
                      </div>
                      <span className="local-terminal-icon-name">{t('localTerminalNoIcon')}</span>
                    </button>

                    {/* 自定义图标卡片 */}
                    {(() => {
                      const isCustom = Boolean(
                        editingCommand.icon &&
                        editingCommand.icon !== 'none' &&
                        !AVAILABLE_COMMAND_ICONS.some((item) => item.path === editingCommand.icon)
                      );
                      const displayCustomUrl = isCustom ? resolveIconDisplayUrl(editingCommand.icon) : null;
                      return (
                        <button
                          type="button"
                          className={`local-terminal-icon-card ${isCustom ? 'is-selected' : ''}`}
                          onClick={() => void browseCustomIconFile()}
                        >
                          <div className="local-terminal-icon-img-wrap">
                            {displayCustomUrl ? (
                              <img src={displayCustomUrl} alt="" />
                            ) : (
                              <Upload size={17} />
                            )}
                          </div>
                          <span className="local-terminal-icon-name">{t('localTerminalCustomIcon')}</span>
                        </button>
                      );
                    })()}
                  </div>

                  {/* 自定义图标路径输入与上传按钮 */}
                  <div className="local-terminal-custom-icon-section">
                    <div className="local-terminal-custom-icon-row">
                      <input
                        className="local-terminal-form-input local-terminal-custom-icon-input"
                        placeholder={t('localTerminalIconUrlPlaceholder')}
                        value={
                          editingCommand.icon &&
                          editingCommand.icon !== 'none' &&
                          !AVAILABLE_COMMAND_ICONS.some((item) => item.path === editingCommand.icon)
                            ? editingCommand.icon
                            : ''
                        }
                        onChange={(e) => setEditingCommand({ ...editingCommand, icon: e.target.value })}
                      />
                      <button
                        className="secondary-button slim local-terminal-upload-btn"
                        onClick={() => void browseCustomIconFile()}
                        type="button"
                      >
                        <Upload size={13} />
                        <span>{t('localTerminalUploadIcon')}</span>
                      </button>
                    </div>
                    <div className="local-terminal-custom-hint">
                      {t('localTerminalIconHint')}
                    </div>
                  </div>
                </div>

                {/* 2. 命令显示名称 */}
                <div className="local-terminal-form-field">
                  <label className="local-terminal-form-label">{t('localTerminalCommandName')}</label>
                  <input
                    className="local-terminal-form-input"
                    placeholder={t('localTerminalCommandNamePlaceholder')}
                    value={editingCommand.name}
                    onChange={(e) => setEditingCommand({ ...editingCommand, name: e.target.value })}
                  />
                </div>

                {/* 3. 完整指令及参数 */}
                <div className="local-terminal-form-field">
                  <label className="local-terminal-form-label">{t('localTerminalCommandInstruction')}</label>
                  <input
                    className="local-terminal-form-input"
                    placeholder={t('localTerminalCommandInstructionPlaceholder')}
                    value={editingCommand.command}
                    onChange={(e) => setEditingCommand({ ...editingCommand, command: e.target.value })}
                  />
                </div>

                {commandError && (
                  <div className="form-error-text">{commandError}</div>
                )}

                <div className="modal-actions local-terminal-submodal-actions">
                  <button
                    className="secondary-button local-terminal-btn-normal"
                    onClick={() => setEditingCommand(null)}
                    type="button"
                  >
                    取消
                  </button>
                  <button
                    className="primary-button local-terminal-btn-normal"
                    onClick={() => void handleSaveCommandModal()}
                    type="button"
                  >
                    {t('localTerminalSave')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 预设命令拖拽悬浮预览 */}
        {commandDragState ? (
          <div
            className="drag-preview"
            style={{ left: commandDragState.currentX + 10, top: commandDragState.currentY + 10 }}
          >
            <GripVertical size={13} />
            <span>{commandDragState.label}</span>
          </div>
        ) : null}

      </div>
    </div>
  );
}
