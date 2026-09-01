/* 本模块由 App 入口按功能域拆出，保留原组件行为与状态订阅方式。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { FolderOpen, GripVertical, Play, Plus, Save, Trash2, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { translate, type TranslationKey } from '../i18n';
import { useAppStore } from '../store';
import type { LocalTerminalCommand, LocalTerminalProfile, LocalTerminalSettings } from '../types';
import { CustomSelect } from '../CustomSelect';
import { Tooltip } from './Tooltip';
import {
  createLocalTerminalProfile,
  defaultLocalTerminalCwd,
  getLocalTerminalIcon,
  localTerminalShellCommand,
  normalizeLocalTerminalProfileTitle,
} from '../app/localTerminal';

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
  // 启动命令允许为空，空值表示直接打开本地 shell，而不是强制启动 CLI。
  const [command, setCommand] = useState(localTerminals.profiles[0]?.command ?? localTerminals.commands[0]?.command ?? '');
  const [newCommand, setNewCommand] = useState('');
  // 历史目录保留最近一次选择的命令，打开时允许单独切换，不把历史固定死成单一入口。
  const [profileCommands, setProfileCommands] = useState<Record<string, string>>({});

  // 尊重 draft.commands 的自定义拖拽排序，同时如果 commands 列表里没有本地终端则进行兜底补全。
  const commandOptions = useMemo(() => {
    const map = new Map<string, LocalTerminalCommand>();
    draft.commands.forEach((item) => {
      if (!map.has(item.id)) {
        map.set(item.id, item);
      }
    });
    if (!map.has(localTerminalShellCommand.id)) {
      map.set(localTerminalShellCommand.id, localTerminalShellCommand);
    }
    return Array.from(map.values());
  }, [draft.commands]);

  // 原生 HTML5 拖拽状态与处理逻辑
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  // 借助 useRef 同步保持 commands 的最新引用，规避拖拽释放事件里可能产生的闭包旧值问题
  const latestCommandsRef = useRef(draft.commands);
  useEffect(() => {
    latestCommandsRef.current = draft.commands;
  }, [draft.commands]);

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
  const t = (key: TranslationKey, replacements?: Record<string, string | number>) =>
    translate(settings.uiLanguage, key, replacements);
  const getLocalTerminalCommandName = (item: LocalTerminalCommand) => {
    // 内置 shell 命令的持久化名称可能来自旧配置，展示时跟随当前界面语言。
    return item.id === localTerminalShellCommand.id || !item.command.trim()
      ? t('localTerminalTitle')
      : item.name;
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    setDraft(localTerminals);
    setCwd(localTerminals.profiles[0]?.cwd ?? defaultLocalTerminalCwd);
    setCommand(localTerminals.profiles[0]?.command ?? localTerminals.commands[0]?.command ?? '');
    setProfileCommands(Object.fromEntries(localTerminals.profiles.map((profile) => [profile.id, profile.command ?? ''])));
    setNewCommand('');
  }, [open]);

  if (!open) {
    return null;
  }

  const persistDraft = async (nextDraft: LocalTerminalSettings) => {
    setDraft(nextDraft);
    await saveLocalTerminals(nextDraft);
  };

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

  const openCurrentTerminal = async () => {
    const normalizedCwd = cwd.trim();
    const normalizedCommand = command.trim();
    if (!normalizedCwd) {
      setStatusMessage(t('validationLocalTerminalCwdRequired'));
      return;
    }
    await persistDraft(draft);
    onClose();
    void openLocalTerminal(createLocalTerminalProfile(normalizedCwd, normalizedCommand));
  };

  const addCommand = async () => {
    const normalized = newCommand.trim();
    if (!normalized) {
      return;
    }
    if (draft.commands.some((item) => item.command === normalized)) {
      setCommand(normalized);
      setNewCommand('');
      return;
    }
    const nextDraft = {
      ...draft,
      commands: [
        ...draft.commands,
        {
          id: crypto.randomUUID(),
          name: normalized,
          command: normalized,
          builtIn: false,
        },
      ],
    };
    await persistDraft(nextDraft);
    setCommand(normalized);
    setNewCommand('');
  };

  const deleteCommand = async (commandId: string) => {
    const target = draft.commands.find((item) => item.id === commandId);
    // 仅锁定本地终端（shell），其余内置和自定义命令均允许被删除。
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

  const deleteProfile = async (profileId: string) => {
    await persistDraft({
      ...draft,
      profiles: draft.profiles.filter((profile) => profile.id !== profileId),
    });
  };

  const openProfile = (profile: LocalTerminalProfile, selectedCommand: string) => {
    const normalizedCommand = selectedCommand.trim();
    onClose();
    void openLocalTerminal({
      ...profile,
      command: normalizedCommand,
      title: normalizeLocalTerminalProfileTitle(profile.cwd, normalizedCommand),
    });
  };

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

        <div className="local-terminal-layout">
          <section className="local-terminal-panel local-terminal-command-panel">
            <div className="section-row compact">
              <strong>{t('localTerminalOpenDirectory')}</strong>
            </div>
            <div className="local-terminal-form-row">
              <input value={cwd} onChange={(event) => setCwd(event.target.value)} />
              <button className="secondary-button" onClick={() => void browseDirectory()} type="button">
                <FolderOpen size={15} /> {t('localTerminalBrowse')}
              </button>
            </div>

            <div className="section-row compact">
              <strong>{t('localTerminalStartupCommand')}</strong>
            </div>
            <div className="local-terminal-form-row">
              <CustomSelect
                value={command}
                onChange={setCommand}
                options={commandOptions.map((item) => {
                  const iconPath = getLocalTerminalIcon(item.name, item.command);
                  return {
                    value: item.command,
                    label: (
                      <div className="local-terminal-select-option">
                        {iconPath && <img src={iconPath} className="local-terminal-select-icon" alt="" />}
                        <span>{getLocalTerminalCommandName(item)}</span>
                      </div>
                    ),
                  };
                })}
              />
              <button className="primary-button" onClick={() => void openCurrentTerminal()} type="button">
                <Play size={15} /> {t('localTerminalOpenTerminal')}
              </button>
            </div>

            <div className="section-row compact">
              {/* 终端命令路径标题 */}
              <strong>{t('localTerminalShellPath')}</strong>
            </div>
            {/* 三列网格布局，包含：路径输入框、浏览按钮、保存按钮 */}
            <div className="local-terminal-form-row-three-cols">
              {/* 终端命令路径输入框 */}
              <input
                placeholder={t('localTerminalShellPathPlaceholder')}
                value={draft.shellPath}
                onChange={(event) => setDraft((current) => ({ ...current, shellPath: event.target.value }))}
              />
              {/* 浏览选择文件的按钮 */}
              <button className="secondary-button" onClick={() => void browseShellPath()} type="button">
                <FolderOpen size={15} /> {t('localTerminalBrowse')}
              </button>
              {/* 保存终端路径配置的按钮 */}
              <button
                className="secondary-button"
                onClick={() => void persistDraft(draft)}
                type="button"
              >
                <Save size={14} /> {t('localTerminalSave')}
              </button>
            </div>
          </section>

          <section className="local-terminal-panel">
            <div className="section-row compact">
              <strong>{t('localTerminalCommandManagement')}</strong>
            </div>
            <div className="local-terminal-form-row">
              <input
                placeholder={t('localTerminalNewCommandPlaceholder')}
                value={newCommand}
                onChange={(event) => setNewCommand(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void addCommand();
                  }
                }}
              />
              <button className="secondary-button" onClick={() => void addCommand()} type="button">
                <Plus size={15} /> {t('localTerminalAddCommand')}
              </button>
            </div>
            <div className="local-terminal-command-list">
              {draft.commands.map((item, index) => (
                <div
                  key={item.id}
                  className={`local-terminal-command-row ${draggedIndex === index ? 'is-dragging' : ''}`}
                  draggable={true}
                  onDragStart={(e) => handleDragStart(e, index)}
                  onDragOver={(e) => handleDragOver(e, index)}
                  onDragEnd={handleDragEnd}
                  onDrop={handleDragEnd}
                >
                  <div className="local-terminal-command-row-left">
                    <GripVertical className="local-terminal-drag-handle" size={14} />
                    {(() => {
                      const iconPath = getLocalTerminalIcon(item.name, item.command);
                      return iconPath ? (
                        <img src={iconPath} className="local-terminal-row-icon" alt="" />
                      ) : null;
                    })()}
                    <span>{getLocalTerminalCommandName(item)}</span>
                  </div>
                  <Tooltip content={item.id === 'shell' ? t('localTerminalBuiltInCommandLocked') : t('localTerminalDeleteCommand')} side="top">
                    <button
                      aria-label={item.id === 'shell' ? t('localTerminalBuiltInCommandLocked') : t('localTerminalDeleteCommand')}
                      className="icon-button"
                      disabled={item.id === 'shell'}
                      onClick={() => void deleteCommand(item.id)}
                      type="button"
                    >
                      <Trash2 size={14} />
                    </button>
                  </Tooltip>
                </div>
              ))}
            </div>
          </section>

          <section className="local-terminal-panel local-terminal-history-panel">
            <div className="section-row compact">
              {/* 历史目录列表标题，去掉了右上角历史记录数量统计 */}
              <strong>{t('localTerminalHistoryTitle')}</strong>
            </div>
            <div className="local-terminal-history-list">
              {draft.profiles.length ? draft.profiles.map((profile) => (
                <div key={profile.id} className="local-terminal-history-row">
                  <div className="local-terminal-history-main">
                    <strong>{profile.cwd}</strong>
                    <span>{profile.command || t('localTerminalTitle')}</span>
                  </div>
                  <CustomSelect
                    className="local-terminal-history-command"
                    value={profileCommands[profile.id] ?? profile.command ?? ''}
                    onChange={(val) => setProfileCommands((current) => ({ ...current, [profile.id]: val }))}
                    options={commandOptions.map((item) => {
                      const iconPath = getLocalTerminalIcon(item.name, item.command);
                      return {
                        value: item.command,
                        label: (
                          <div className="local-terminal-select-option">
                            {iconPath && <img src={iconPath} className="local-terminal-select-icon" alt="" />}
                            <span>{getLocalTerminalCommandName(item)}</span>
                          </div>
                        ),
                      };
                    })}
                  />
                  <button
                    className="secondary-button slim"
                    onClick={() => openProfile(profile, profileCommands[profile.id] ?? profile.command ?? '')}
                    type="button"
                  >
                    <Play size={14} /> {t('localTerminalOpen')}
                  </button>
                  <Tooltip content={t('localTerminalDeleteHistory')} side="top">
                    <button aria-label={t('localTerminalDeleteHistory')} className="icon-button" onClick={() => void deleteProfile(profile.id)} type="button">
                      <X size={14} />
                    </button>
                  </Tooltip>
                </div>
              )) : (
                <div className="empty-state">{t('localTerminalHistoryEmpty')}</div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
