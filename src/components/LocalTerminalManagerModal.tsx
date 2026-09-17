/* 本模块由 App 入口按功能域拆出，保留原组件行为与状态订阅方式。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

  // 左右分栏容器与拖动宽度调整状态（默认左侧宽度由 CSS 比例控制，拖动后以像素固定）
  const twoColsRef = useRef<HTMLDivElement>(null);
  const [splitLeftWidth, setSplitLeftWidth] = useState<number | null>(null);

  // 左右分栏拖动改变宽度的处理事件
  const handleResizerPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const container = twoColsRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const currentLeft = splitLeftWidth ?? (rect.width * 0.54);
    const startX = event.clientX;
    const minLeft = 240;
    const maxLeft = Math.max(minLeft, rect.width - 240 - 8);

    beginResize(event, (moveEvent) => {
      const delta = moveEvent.clientX - startX;
      const nextWidth = clamp(currentLeft + delta, minLeft, maxLeft);
      setSplitLeftWidth(nextWidth);
    });
  }, [splitLeftWidth]);

  // 预设命令新增与编辑子弹窗状态
  const [editingCommand, setEditingCommand] = useState<EditingCommandState | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);

  // 原生 HTML5 拖拽状态与处理逻辑
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  // 借助 useRef 同步保持 commands 的最新引用，规避拖拽释放事件里可能产生的闭包旧值问题
  const latestCommandsRef = useRef(draft.commands);
  useEffect(() => {
    latestCommandsRef.current = draft.commands;
  }, [draft.commands]);

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
      .map((shell) => {
        const cleanedName = cleanShellName(shell.name);
        const rawIcon = getSystemShellIcon(shell);
        const iconPath = resolveIconDisplayUrl(rawIcon);
        return {
          value: `shell:${shell.id}`,
          group: t('localTerminalSystemShells'),
          label: (
            <div className="local-terminal-select-option">
              {iconPath && <img src={iconPath} className="local-terminal-select-icon" alt="" />}
              <span>{cleanedName}</span>
            </div>
          ),
        };
      }),
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

  useEffect(() => {
    if (!open) {
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

  if (!open) {
    return null;
  }

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
    const nextDraft = { ...draft, shells: nextShells };
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

  // 命令拖拽排序
  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === index) {
      return;
    }
    const nextCommands = [...draft.commands];
    const draggedItem = nextCommands[draggedIndex];
    nextCommands.splice(draggedIndex, 1);
    nextCommands.splice(index, 0, draggedItem);
    setDraft((current) => ({
      ...current,
      commands: nextCommands,
    }));
    setDraggedIndex(index);
  };

  const handleDragEnd = async () => {
    setDraggedIndex(null);
    const nextDraft = {
      ...draft,
      commands: latestCommandsRef.current,
    };
    await persistDraft(nextDraft);
  };

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
              style={splitLeftWidth ? { gridTemplateColumns: `${splitLeftWidth}px 8px 1fr` } : undefined}
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
                      const rawIcon = getSystemShellIcon(shell);
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

                <div className="local-terminal-v2-list">
                  {displayCommands.length > 0 ? (
                    displayCommands.map((item, index) => {
                      const rawIcon = getLocalTerminalIcon(item.name, item.command, item.icon);
                      const iconPath = resolveIconDisplayUrl(rawIcon);
                      return (
                        <div
                          key={item.id}
                          className={`local-terminal-command-row-v2 ${draggedIndex === index ? 'is-dragging' : ''}`}
                          draggable={true}
                          onDragStart={(e) => handleDragStart(e, index)}
                          onDragOver={(e) => handleDragOver(e, index)}
                          onDragEnd={handleDragEnd}
                          onDrop={handleDragEnd}
                        >
                          <div className="local-terminal-command-row-left">
                            <GripVertical className="local-terminal-drag-handle" size={13} />
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
                            <Tooltip
                              content={item.builtIn ? t('localTerminalBuiltInCommandLocked') : t('localTerminalDeleteCommand')}
                              delayDuration={100}
                              side="top"
                            >
                              <button
                                aria-label={item.builtIn ? t('localTerminalBuiltInCommandLocked') : t('localTerminalDeleteCommand')}
                                className="icon-button"
                                disabled={item.builtIn}
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

      </div>
    </div>
  );
}
