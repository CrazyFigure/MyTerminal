/* 本模块由 App 入口按功能域拆出，保留原组件行为与状态订阅方式。 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Copy, Folder, FolderTree, GripVertical, Monitor, Pencil, Play, Plus, Save, TerminalSquare, Trash2, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { translate, type TranslationKey } from '../i18n';
import { useAppStore } from '../store';
import { beginResize, clamp } from '../app/layout';
import {
  buildConnectionGroupTree,
  collectOrderedGroupPaths,
  connectionManagerResizerWidth,
  connectionManagerSidebarDefaultWidth,
  connectionManagerSidebarMaxWidth,
  connectionManagerSidebarMinWidth,
  connectionManagerTableMinWidth,
  connectionTableActionMinWidth,
  connectionTableColumnLimits,
  connectionTableDefaultColumnWidths,
  isConnectionGroupOrChildPath,
  isConnectionInExactGroupPath,
  isPointInsideElement,
  moveGroupBlockToEnd,
  moveGroupBlockToInsert,
  moveItemToEnd,
  moveItemToInsert,
  normalizeConnectionGroupPath,
  resolveInsertPlacement,
  sortConnectionsByOrder,
  ungroupedGroupPath,
  useFlipListAnimation,
  type ConnectionGroupNode,
  type ConnectionManagerDragState,
  type ConnectionManagerDropTarget,
  type InsertPlacement,
} from '../app/connectionGroups';

export function ConnectionGroupTree({
  nodes,
  selectedPath,
  onSelect,
  onEdit,
  onDelete,
  dragState,
  dropTarget,
  onStartGroupDrag,
  editLabel,
  deleteLabel,
}: {
  nodes: ConnectionGroupNode[];
  selectedPath: string;
  onSelect: (path: string) => void;
  onEdit: (path: string) => void;
  onDelete: (path: string) => void;
  dragState: ConnectionManagerDragState;
  dropTarget: ConnectionManagerDropTarget;
  onStartGroupDrag: (event: ReactPointerEvent<HTMLButtonElement>, path: string, label: string) => void;
  editLabel: string;
  deleteLabel: string;
}) {
  return (
    <div className="connection-group-children">
      {nodes.map((node) => (
        <div key={node.path} className="connection-group-node">
          <div
            data-group-path={node.path}
            className={`connection-group-row ${selectedPath === node.path ? 'is-selected' : ''} ${dragState?.type === 'group' && dragState.path === node.path ? 'is-dragging' : ''} ${dropTarget?.type === 'connection-group' && dropTarget.groupPath === node.path ? 'is-drop-target' : ''} ${dropTarget?.type === 'group-insert' && dropTarget.groupPath === node.path ? `is-drop-${dropTarget.placement}` : ''}`}
          >
            <button
              aria-label={`拖动分组 ${node.path}`}
              className="drag-handle"
              onPointerDown={(event) => onStartGroupDrag(event, node.path, node.name)}
              title={`拖动分组 ${node.path}`}
              type="button"
            >
              <GripVertical size={14} />
            </button>
            <button
              className="connection-group-button"
              onClick={() => onSelect(node.path)}
              title={node.path}
              type="button"
            >
              <Folder size={14} />
              <span>{node.name}</span>
            </button>
            <div className="connection-group-actions">
              <button
                aria-label={`${editLabel}: ${node.path}`}
                className="icon-button tiny"
                onClick={() => onEdit(node.path)}
                title={editLabel}
                type="button"
              >
                <Pencil size={13} />
              </button>
              <button
                aria-label={`${deleteLabel}: ${node.path}`}
                className="icon-button tiny danger-button"
                onClick={() => onDelete(node.path)}
                title={deleteLabel}
                type="button"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
          {node.children.length ? (
            <ConnectionGroupTree
              nodes={node.children}
              selectedPath={selectedPath}
              onDelete={onDelete}
              onEdit={onEdit}
              onSelect={onSelect}
              dragState={dragState}
              dropTarget={dropTarget}
              onStartGroupDrag={onStartGroupDrag}
              deleteLabel={deleteLabel}
              editLabel={editLabel}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}



export function ConnectionManagerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [selectedGroupPath, setSelectedGroupPath] = useState(ungroupedGroupPath);
  const [groupEditorMode, setGroupEditorMode] = useState<'create' | 'edit' | null>(null);
  const [editingGroupPath, setEditingGroupPath] = useState('');
  const [groupDraft, setGroupDraft] = useState('');
  // 连接管理拖拽状态只保存在弹窗内，用于区分连接移动、连接排序和分组排序三种放置目标。
  const [dragState, setDragState] = useState<ConnectionManagerDragState>(null);
  const [dropTarget, setDropTarget] = useState<ConnectionManagerDropTarget>(null);
  const [connectionTableColumnWidths, setConnectionTableColumnWidths] = useState(connectionTableDefaultColumnWidths);
  const [groupSidebarWidth, setGroupSidebarWidth] = useState(connectionManagerSidebarDefaultWidth);
  const dragStateRef = useRef<ConnectionManagerDragState>(null);
  const dropTargetRef = useRef<ConnectionManagerDropTarget>(null);
  const managerWasOpenRef = useRef(false);
  const connectionManagerLayoutRef = useRef<HTMLDivElement | null>(null);
  const groupSidebarRef = useRef<HTMLElement | null>(null);
  const connectionTableBodyRef = useRef<HTMLDivElement | null>(null);
  const {
    connections,
    createConnectionGroup,
    deleteConnection,
    deleteConnectionGroup,
    duplicateConnection,
    moveConnectionToGroup,
    openConnectionForm,
    openSession,
    renameConnectionGroup,
    reorderConnectionGroups,
    reorderConnections,
    settings,
  } = useAppStore(
    useShallow((state) => ({
      connections: state.connections,
      createConnectionGroup: state.createConnectionGroup,
      deleteConnection: state.deleteConnection,
      deleteConnectionGroup: state.deleteConnectionGroup,
      duplicateConnection: state.duplicateConnection,
      moveConnectionToGroup: state.moveConnectionToGroup,
      openConnectionForm: state.openConnectionForm,
      openSession: state.openSession,
      renameConnectionGroup: state.renameConnectionGroup,
      reorderConnectionGroups: state.reorderConnectionGroups,
      reorderConnections: state.reorderConnections,
      settings: state.settings,
    })),
  );
  const t = (key: TranslationKey, replacements?: Record<string, string | number>) =>
    translate(settings.uiLanguage, key, replacements);
  const orderedConnections = useMemo(() => sortConnectionsByOrder(connections, settings.connectionOrder), [connections, settings.connectionOrder]);
  const orderedGroupPaths = useMemo(() => collectOrderedGroupPaths(settings.connectionGroups, connections), [connections, settings.connectionGroups]);
  const groups = useMemo(() => buildConnectionGroupTree(settings.connectionGroups, orderedConnections), [orderedConnections, settings.connectionGroups]);
  const firstSelectableGroupPath = orderedGroupPaths[0] ?? ungroupedGroupPath;
  const visibleConnections = useMemo(() => {
    if (selectedGroupPath === ungroupedGroupPath) {
      return orderedConnections.filter((connection) => !normalizeConnectionGroupPath(connection.groupPath));
    }

    return orderedConnections.filter((connection) => isConnectionInExactGroupPath(connection.groupPath, selectedGroupPath));
  }, [orderedConnections, selectedGroupPath]);
  const connectionTableGridTemplate = useMemo(
    () => `${connectionTableColumnWidths.map((width) => `${width}px`).join(' ')} minmax(${connectionTableActionMinWidth}px, 1fr)`,
    [connectionTableColumnWidths],
  );
  const connectionTableGridMinWidth = useMemo(
    () => connectionTableColumnWidths.reduce((total, width) => total + width, 0) + connectionTableActionMinWidth + 48,
    [connectionTableColumnWidths],
  );
  const connectionTableGridStyle = useMemo<CSSProperties>(
    () => ({ gridTemplateColumns: connectionTableGridTemplate, minWidth: connectionTableGridMinWidth }),
    [connectionTableGridMinWidth, connectionTableGridTemplate],
  );
  const beginConnectionTableColumnResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>, columnIndex: number) => {
    const startWidth = connectionTableColumnWidths[columnIndex] ?? connectionTableDefaultColumnWidths[columnIndex] ?? 120;
    const limits = connectionTableColumnLimits[columnIndex] ?? { min: 80, max: 360 };

    // 连接列表列宽只服务当前管理弹窗的阅读和对比，不写入配置，避免临时操作污染持久设置。
    beginResize(event, (moveEvent, startX) => {
      const nextWidth = clamp(startWidth + moveEvent.clientX - startX, limits.min, limits.max);
      setConnectionTableColumnWidths((current) => current.map((width, index) => (index === columnIndex ? nextWidth : width)));
    });
  }, [connectionTableColumnWidths]);
  const beginConnectionManagerSidebarResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const startWidth = groupSidebarWidth;
    const layoutWidth = connectionManagerLayoutRef.current?.getBoundingClientRect().width ?? 0;
    const dynamicMaxWidth = layoutWidth > 0
      ? layoutWidth - connectionManagerTableMinWidth - connectionManagerResizerWidth
      : connectionManagerSidebarMaxWidth;
    const maxWidth = Math.max(
      connectionManagerSidebarMinWidth,
      Math.min(connectionManagerSidebarMaxWidth, dynamicMaxWidth),
    );

    // 拖动时同步更新 CSS 变量，左右面板即时预览；松手后保留本次弹窗中的宽度。
    beginResize(event, (moveEvent, startX) => {
      setGroupSidebarWidth(clamp(
        startWidth + moveEvent.clientX - startX,
        connectionManagerSidebarMinWidth,
        maxWidth,
      ));
    });
  }, [groupSidebarWidth]);
  const handleConnectionManagerSidebarResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const resizeStep = event.shiftKey ? 40 : 10;
    const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (!direction) {
      return;
    }

    event.preventDefault();
    setGroupSidebarWidth((current) => clamp(
      current + direction * resizeStep,
      connectionManagerSidebarMinWidth,
      connectionManagerSidebarMaxWidth,
    ));
  }, []);
  useFlipListAnimation(groupSidebarRef, '[data-group-path]', [orderedGroupPaths.join('|')]);
  useFlipListAnimation(connectionTableBodyRef, '[data-connection-id]', [visibleConnections.map((connection) => connection.id).join('|')]);
  const canSaveGroup = Boolean(normalizeConnectionGroupPath(groupDraft));
  const startCreateGroup = () => {
    setGroupEditorMode('create');
    setEditingGroupPath('');
    setGroupDraft(selectedGroupPath && selectedGroupPath !== ungroupedGroupPath ? `${selectedGroupPath}/` : '');
  };
  const startEditGroup = (path: string) => {
    setGroupEditorMode('edit');
    setEditingGroupPath(path);
    setGroupDraft(path);
  };
  const cancelGroupEditor = () => {
    setGroupEditorMode(null);
    setEditingGroupPath('');
    setGroupDraft('');
  };
  const saveGroup = async () => {
    // 分组保存前先规范路径，避免用户输入反斜杠或多余斜杠导致重复分组。
    const normalized = normalizeConnectionGroupPath(groupDraft);
    const savedPath = groupEditorMode === 'edit'
      ? await renameConnectionGroup(editingGroupPath, normalized)
      : await createConnectionGroup(normalized);
    if (!savedPath) {
      return;
    }

    setSelectedGroupPath(savedPath);
    cancelGroupEditor();
  };
  const requestDeleteGroup = (path: string) => {
    // 删除确认需要明确告诉用户连接数量，因为确认后会级联删除连接而不是移动到未分组。
    const connectionCount = connections.filter((connection) => isConnectionGroupOrChildPath(connection.groupPath, path)).length;
    if (!window.confirm(t('deleteGroupConfirm', { path, count: connectionCount }))) {
      return;
    }

    void deleteConnectionGroup(path).then(() => {
      if (selectedGroupPath === path || selectedGroupPath.startsWith(`${path}/`)) {
        setSelectedGroupPath(ungroupedGroupPath);
      }
      if (editingGroupPath === path || editingGroupPath.startsWith(`${path}/`)) {
        cancelGroupEditor();
      }
    });
  };
  const handleDropConnectionToGroup = (connectionId: string, groupPath: string) => {
    setDragState(null);
    setDropTarget(null);
    void moveConnectionToGroup(connectionId, groupPath === ungroupedGroupPath ? undefined : groupPath);
  };
  const handleDuplicateConnection = (connectionId: string) => {
    // 复制连接遵循当前左侧选中的目录；固定的未分组入口等价于清空 groupPath。
    const targetGroupPath = selectedGroupPath === ungroupedGroupPath ? undefined : selectedGroupPath;
    void duplicateConnection(connectionId, targetGroupPath);
  };
  const handleReorderGroup = (sourcePath: string, targetPath: string, placement: InsertPlacement) => {
    setDragState(null);
    setDropTarget(null);
    void reorderConnectionGroups(moveGroupBlockToInsert(orderedGroupPaths, sourcePath, targetPath, placement));
  };
  const handleReorderGroupToEnd = (sourcePath: string) => {
    setDragState(null);
    setDropTarget(null);
    void reorderConnectionGroups(moveGroupBlockToEnd(orderedGroupPaths, sourcePath));
  };
  const handleReorderConnection = (sourceId: string, targetId: string, placement: InsertPlacement) => {
    setDragState(null);
    setDropTarget(null);
    const currentIds = orderedConnections.map((connection) => connection.id);
    void reorderConnections(moveItemToInsert(currentIds, sourceId, targetId, placement));
  };
  const handleReorderConnectionToEnd = (sourceId: string) => {
    setDragState(null);
    setDropTarget(null);
    const currentIds = orderedConnections.map((connection) => connection.id);
    void reorderConnections(moveItemToEnd(currentIds, sourceId));
  };
  const resolveConnectionManagerDropTarget = (event: PointerEvent, currentDrag: NonNullable<ConnectionManagerDragState>): ConnectionManagerDropTarget => {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const targetConnection = target?.closest<HTMLElement>('[data-connection-id]');
    const targetGroup = target?.closest<HTMLElement>('[data-group-path]');
    const targetUngrouped = target?.closest<HTMLElement>('[data-ungrouped-drop-target]');

    // 拖动连接时，连接行表示排序插入点；左侧分组行表示移动到该分组，未分组固定入口表示清空分组。
    if (currentDrag.type === 'connection') {
      const targetConnectionId = targetConnection?.dataset.connectionId;
      if (targetConnectionId === currentDrag.id) {
        return null;
      }
      if (targetConnectionId) {
        return {
          type: 'connection-insert',
          connectionId: targetConnectionId,
          placement: resolveInsertPlacement(event, targetConnection),
        };
      }

      const targetGroupPath = targetGroup?.dataset.groupPath;
      if (targetGroupPath) {
        return { type: 'connection-group', groupPath: targetGroupPath };
      }
      if (targetUngrouped) {
        return { type: 'connection-ungrouped' };
      }
      if (isPointInsideElement(event, connectionTableBodyRef.current)) {
        return { type: 'connection-end' };
      }
      return null;
    }

    const targetGroupPath = targetGroup?.dataset.groupPath;
    if (targetGroupPath && (targetGroupPath === currentDrag.path || isConnectionGroupOrChildPath(targetGroupPath, currentDrag.path))) {
      return null;
    }
    if (targetGroupPath) {
      return {
        type: 'group-insert',
        groupPath: targetGroupPath,
        placement: resolveInsertPlacement(event, targetGroup),
      };
    }
    if (isPointInsideElement(event, groupSidebarRef.current)) {
      return { type: 'group-end' };
    }
    return null;
  };
  const startConnectionManagerDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    item:
      | { type: 'connection'; id: string; label: string }
      | { type: 'group'; path: string; label: string },
  ) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    // 连接管理使用 pointer 拖拽，不依赖 WebView 原生 drag/drop，避免 Windows Tauri 文件拖放拦截列表排序。
    const basePosition = {
      originX: event.clientX,
      originY: event.clientY,
      currentX: event.clientX,
      currentY: event.clientY,
    };
    if (item.type === 'connection') {
      setDragState({ ...basePosition, type: 'connection', id: item.id, label: item.label });
      return;
    }
    setDragState({ ...basePosition, type: 'group', path: item.path, label: item.label });
  };

  useEffect(() => {
    dragStateRef.current = dragState;
  }, [dragState]);

  useEffect(() => {
    dropTargetRef.current = dropTarget;
  }, [dropTarget]);

  useEffect(() => {
    if (!open) {
      managerWasOpenRef.current = false;
      setDragState(null);
      setDropTarget(null);
      return;
    }
    if (managerWasOpenRef.current) {
      return;
    }

    // 连接管理每次打开时默认落到第一个真实分组；没有分组时才选固定底部的未分组。
    setSelectedGroupPath(firstSelectableGroupPath);
    managerWasOpenRef.current = true;
  }, [firstSelectableGroupPath, open]);

  useEffect(() => {
    if (!dragState) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      setDragState((current) => {
        if (!current) {
          return current;
        }

        const nextDropTarget = resolveConnectionManagerDropTarget(event, current);
        setDropTarget((previous) => (
          JSON.stringify(previous) === JSON.stringify(nextDropTarget) ? previous : nextDropTarget
        ));
        return { ...current, currentX: event.clientX, currentY: event.clientY };
      });
    };

    const handlePointerUp = (event: PointerEvent) => {
      const currentDrag = dragStateRef.current;
      if (!currentDrag) {
        setDragState(null);
        setDropTarget(null);
        return;
      }

      const finalDropTarget = dropTargetRef.current ?? resolveConnectionManagerDropTarget(event, currentDrag);
      setDragState(null);
      setDropTarget(null);

      // 落点按最具体的连接行优先，其次分组行，最后是固定的未分组入口。
      if (currentDrag.type === 'connection') {
        if (finalDropTarget?.type === 'connection-insert') {
          handleReorderConnection(currentDrag.id, finalDropTarget.connectionId, finalDropTarget.placement);
          return;
        }
        if (finalDropTarget?.type === 'connection-end') {
          handleReorderConnectionToEnd(currentDrag.id);
          return;
        }
        if (finalDropTarget?.type === 'connection-group') {
          handleDropConnectionToGroup(currentDrag.id, finalDropTarget.groupPath);
          return;
        }
        if (finalDropTarget?.type === 'connection-ungrouped') {
          handleDropConnectionToGroup(currentDrag.id, ungroupedGroupPath);
          return;
        }
      }

      if (currentDrag.type === 'group') {
        if (finalDropTarget?.type === 'group-insert') {
          handleReorderGroup(currentDrag.path, finalDropTarget.groupPath, finalDropTarget.placement);
          return;
        }
        if (finalDropTarget?.type === 'group-end') {
          handleReorderGroupToEnd(currentDrag.path);
          return;
        }
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [Boolean(dragState)]);

  if (!open) {
    return null;
  }

  return (
    <div className="modal-backdrop">
      <div className="modal card modal-wide">
        <div className="modal-header">
          <div>
            <h3>{t('connectionManagerTitle')}</h3>
          </div>
          <div className="section-row compact">
            <button
              className="primary-button"
              onClick={() => openConnectionForm(undefined, selectedGroupPath === ungroupedGroupPath ? undefined : selectedGroupPath)}
              type="button"
            >
              <Plus size={16} /> {t('newConnection')}
            </button>
            <button className="icon-button" onClick={onClose} type="button">
              <X size={18} />
            </button>
          </div>
        </div>

        <div
          className="connection-manager-layout"
          ref={connectionManagerLayoutRef}
          style={{ '--connection-group-sidebar-width': `${groupSidebarWidth}px` } as CSSProperties}
        >
          <aside
            className={`connection-groups-sidebar ${dropTarget?.type === 'group-end' ? 'is-drop-end' : ''}`}
            ref={groupSidebarRef}
          >
            <div className="section-row compact">
              <strong>{t('connectionGroupsTitle')}</strong>
              <button className="secondary-button slim" onClick={startCreateGroup} type="button">
                <Plus size={14} /> {t('newGroup')}
              </button>
            </div>

            {groupEditorMode ? (
              <div className="connection-group-editor">
                <span>{groupEditorMode === 'edit' ? t('editGroup') : t('newGroup')}</span>
                <input
                  autoFocus
                  placeholder={t('groupNamePlaceholder')}
                  value={groupDraft}
                  onChange={(event) => setGroupDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void saveGroup();
                    }
                    if (event.key === 'Escape') {
                      cancelGroupEditor();
                    }
                  }}
                />
                <div className="connection-group-editor-actions">
                  <button className="secondary-button slim" onClick={cancelGroupEditor} type="button">
                    {t('cancelGroupEdit')}
                  </button>
                  <button className="primary-button slim" disabled={!canSaveGroup} onClick={() => void saveGroup()} type="button">
                    <Save size={14} /> {t('saveGroup')}
                  </button>
                </div>
              </div>
            ) : null}

            <ConnectionGroupTree
              nodes={groups}
              selectedPath={selectedGroupPath}
              onDelete={requestDeleteGroup}
              onEdit={startEditGroup}
              onSelect={setSelectedGroupPath}
              dragState={dragState}
              dropTarget={dropTarget}
              onStartGroupDrag={(event, path, label) => startConnectionManagerDrag(event, { type: 'group', path, label })}
              deleteLabel={t('deleteGroup')}
              editLabel={t('editGroup')}
            />
            <div
              data-ungrouped-drop-target="true"
              className={`connection-group-row connection-group-row-ungrouped ${selectedGroupPath === ungroupedGroupPath ? 'is-selected' : ''} ${dropTarget?.type === 'connection-ungrouped' ? 'is-drop-target' : ''} ${dropTarget?.type === 'group-end' ? 'is-drop-before' : ''}`}
            >
              <span className="drag-handle drag-handle-placeholder" aria-hidden="true" />
              <button
                className="connection-group-button"
                onClick={() => setSelectedGroupPath(ungroupedGroupPath)}
                type="button"
              >
                <FolderTree size={14} />
                <span>{t('ungroupedConnections')}</span>
              </button>
            </div>
          </aside>

          <button
            aria-label={t('resizeConnectionPanels')}
            aria-orientation="vertical"
            aria-valuemax={connectionManagerSidebarMaxWidth}
            aria-valuemin={connectionManagerSidebarMinWidth}
            aria-valuenow={Math.round(groupSidebarWidth)}
            className="connection-manager-resizer"
            onKeyDown={handleConnectionManagerSidebarResizeKeyDown}
            onPointerDown={beginConnectionManagerSidebarResize}
            role="separator"
            title={t('resizeConnectionPanels')}
            type="button"
          />

          <section className="connection-table-shell">
            <div className="section-row compact">
              {/* 连接列表标题，去掉了右上角的连接数量统计 */}
              <strong>{t('connectionItemsTitle')}</strong>
            </div>

            <div className="connection-table-scroll">
              <div className="connection-table-header" style={connectionTableGridStyle}>
                <span className="connection-column-header" />
                {[t('fieldName'), t('fieldHost'), t('fieldPort'), t('fieldUsername')].map((label, index) => (
                  <span key={label} className="connection-column-header">
                    <span>{label}</span>
                    <button
                      aria-label={`调整${label}列宽`}
                      className="connection-column-resizer"
                      onPointerDown={(event) => beginConnectionTableColumnResize(event, index + 1)}
                      title={`调整${label}列宽`}
                      type="button"
                    />
                  </span>
                ))}
                <span className="connection-column-header" />
              </div>

              <div
                className={`connection-table-body ${dropTarget?.type === 'connection-end' ? 'is-drop-end' : ''}`}
                ref={connectionTableBodyRef}
              >
                {visibleConnections.length ? (
                  visibleConnections.map((connection) => (
                    <div
                      key={connection.id}
                      data-connection-id={connection.id}
                      className={`connection-table-row ${dragState?.type === 'connection' && dragState.id === connection.id ? 'is-dragging' : ''} ${dropTarget?.type === 'connection-insert' && dropTarget.connectionId === connection.id ? `is-drop-${dropTarget.placement}` : ''}`}
                      style={connectionTableGridStyle}
                    >
                      <button
                        aria-label={`拖动连接 ${connection.name}`}
                        className="drag-handle"
                        onPointerDown={(event) => startConnectionManagerDrag(event, { type: 'connection', id: connection.id, label: connection.name })}
                        title={`拖动连接 ${connection.name}`}
                        type="button"
                      >
                        <GripVertical size={14} />
                      </button>
                      <div className="connection-name-cell" title={connection.name}>
                        {connection.protocol === 'rdp' ? (
                          <span
                            aria-label={t('connectionProtocolRdp')}
                            className="connection-type-icon"
                            role="img"
                            title={t('connectionProtocolRdp')}
                          >
                            <Monitor size={13} />
                          </span>
                        ) : (
                          <span
                            aria-label={t('connectionProtocolSsh')}
                            className="connection-type-icon"
                            role="img"
                            title={t('connectionProtocolSsh')}
                          >
                            <TerminalSquare size={13} />
                          </span>
                        )}
                        <span>{connection.name}</span>
                      </div>
                      <span title={connection.host}>{connection.host}</span>
                      <span title={String(connection.port)}>{connection.port}</span>
                      <span title={connection.username}>{connection.username}</span>
                      {/* 连接列表操作按钮保留文字，同时补充图标帮助用户更快识别常用动作。 */}
                      <div className="connection-table-actions">
                        <button className="ghost-button slim" onClick={() => {
                          // 管理弹窗先关闭，再启动会话；避免连接建立时的状态刷新和弹窗布局同时竞争渲染。
                          onClose();
                          void openSession(connection.id);
                        }} type="button">
                          <Play size={13} /> {t('connect')}
                        </button>
                        <button className="ghost-button slim" onClick={() => openConnectionForm(connection)} type="button">
                          <Pencil size={13} /> {t('edit')}
                        </button>
                        <button className="ghost-button slim" onClick={() => handleDuplicateConnection(connection.id)} type="button">
                          <Copy size={13} /> {t('copy')}
                        </button>
                        <button className="ghost-button slim danger-button" onClick={() => void deleteConnection(connection.id)} type="button">
                          {t('delete')}
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="empty-state">
                    {selectedGroupPath ? t('noConnectionsInGroup') : t('connectionManagerEmpty')}
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
        {dragState ? (
          <div
            className="drag-preview"
            style={{ left: dragState.currentX + 10, top: dragState.currentY + 10 }}
          >
            <GripVertical size={13} />
            <span>{dragState.label}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
