/* 现代化级联树形分组选择器：纯净树形层级浏览、即时检索与无约束自定义多级目录输入 */
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  Folder,
  FolderMinus,
  FolderPlus,
  ChevronDown,
  X,
  Check,
} from 'lucide-react';
import { buildConnectionGroupTree, type ConnectionGroupNode } from '../app/connectionGroups';
import { normalizeConnectionGroupPath } from '../domain/connections/model';
import { Tooltip } from './Tooltip';
import type { TranslationKey } from '../i18n';
import type { ConnectionProfile } from '../types';

interface ConnectionGroupComboboxProps {
  value: string;
  onChange: (path: string) => void;
  groupOptions: string[];
  connections: ConnectionProfile[];
  placeholder?: string;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
}

interface GroupTreeNodeItemProps {
  node: ConnectionGroupNode;
  depth: number;
  currentNormalized: string;
  onSelect: (path: string) => void;
}

/**
 * 纯净优雅的树形节点单行组件：仅保留清晰缩进、文件夹图标、节点短名称与选中对勾
 */
function GroupTreeNodeItem({
  node,
  depth,
  currentNormalized,
  onSelect,
}: GroupTreeNodeItemProps) {
  const isSelected = currentNormalized === node.path;

  return (
    <div className="group-tree-branch">
      <div
        className={`group-tree-row ${isSelected ? 'is-selected' : ''}`}
        style={{ paddingLeft: `${10 + depth * 14}px` }}
        onClick={() => onSelect(node.path)}
      >
        <Folder size={14} className="group-tree-icon" />
        <span className="group-tree-name">{node.name}</span>
        {isSelected && <Check size={14} className="group-tree-check" />}
      </div>
      {node.children.length > 0 && (
        <div className="group-tree-children">
          {node.children.map((child) => (
            <GroupTreeNodeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              currentNormalized={currentNormalized}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ConnectionGroupCombobox({
  value,
  onChange,
  groupOptions,
  connections,
  placeholder,
  t,
}: ConnectionGroupComboboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const normalizedValue = useMemo(() => normalizeConnectionGroupPath(value), [value]);

  // 构建稳定整洁的层级树
  const groupTree = useMemo(
    () => buildConnectionGroupTree(groupOptions, connections),
    [groupOptions, connections],
  );

  // 判断当前输入是否为全新尚未持久化的自定义分组
  const isCustomNewPath = useMemo(() => {
    if (!normalizedValue) return false;
    return !groupOptions.some((opt) => opt.toLowerCase() === normalizedValue.toLowerCase());
  }, [normalizedValue, groupOptions]);

  // 分割多级路径面包屑
  const pathSegments = useMemo(() => {
    if (!normalizedValue) return [];
    return normalizedValue.split('/').filter(Boolean);
  }, [normalizedValue]);

  // 点击外部收起浮层
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = useCallback(
    (path: string) => {
      if (!path) {
        onChange('');
        setIsOpen(false);
        return;
      }
      // 选中已有分组时自动在末尾追加 /，方便用户直接在该分组下继续输入自定义子分组名称
      const nextPath = `${normalizeConnectionGroupPath(path)}/`;
      onChange(nextPath);
      setIsOpen(false);
      setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.setSelectionRange(nextPath.length, nextPath.length);
        }
      }, 50);
    },
    [onChange],
  );

  const handleClear = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onChange('');
      inputRef.current?.focus();
    },
    [onChange],
  );

  return (
    <div className="modern-group-combobox" ref={containerRef}>
      {/* 组合输入框触发器 */}
      <div className={`group-combobox-input-wrapper ${isOpen ? 'is-focused' : ''}`}>
        <Folder size={15} className="group-combobox-prefix-icon" />
        <input
          ref={inputRef}
          type="text"
          value={value}
          placeholder={placeholder}
          onFocus={() => setIsOpen(true)}
          onChange={(e) => {
            onChange(e.target.value);
            if (!isOpen) setIsOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              setIsOpen(false);
            } else if (e.key === 'Escape') {
              setIsOpen(false);
            }
          }}
          className="group-combobox-input"
        />
        <div className="group-combobox-suffix-actions">
          {value.trim() && (
            <Tooltip content={t('clearGroup')} side="top">
              <button
                type="button"
                className="icon-button tiny group-combobox-clear-btn"
                onClick={handleClear}
                aria-label={t('clearGroup')}
              >
                <X size={13} />
              </button>
            </Tooltip>
          )}
          <button
            type="button"
            className={`group-combobox-toggle-btn ${isOpen ? 'is-open' : ''}`}
            onClick={() => setIsOpen((prev) => !prev)}
            aria-label="Toggle group dropdown"
            tabIndex={-1}
          >
            <ChevronDown size={14} />
          </button>
        </div>
      </div>

      {/* 纯净树形下拉面板 */}
      {isOpen && (
        <div className="group-combobox-dropdown">
          {/* 快捷未分组选项 */}
          <div
            className={`group-tree-row group-tree-row-ungrouped ${!normalizedValue ? 'is-selected' : ''}`}
            onClick={() => handleSelect('')}
          >
            <FolderMinus size={14} className="group-tree-icon" />
            <span className="group-tree-name">{t('ungroupedConnections')}</span>
            {!normalizedValue && <Check size={14} className="group-tree-check" />}
          </div>

          {/* 自由自定义即时创建提示项 */}
          {isCustomNewPath && (
            <div
              className="group-combobox-custom-item"
              onClick={() => handleSelect(normalizedValue)}
            >
              <div className="group-custom-header">
                <FolderPlus size={14} className="group-custom-icon" />
                <span className="group-custom-title">{t('useAsNewGroup')}</span>
              </div>
              <div className="group-custom-path-preview">
                {pathSegments.map((segment, index) => (
                  <React.Fragment key={index}>
                    {index > 0 && <span className="group-preview-divider">/</span>}
                    <span className="group-preview-chip">{segment}</span>
                  </React.Fragment>
                ))}
              </div>
            </div>
          )}

          {/* 已有分组层级树：全量稳定展示，无副作用过滤 */}
          <div className="group-combobox-tree-list">
            {groupTree.map((rootNode) => (
              <GroupTreeNodeItem
                key={rootNode.path}
                node={rootNode}
                depth={0}
                currentNormalized={normalizedValue}
                onSelect={handleSelect}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
