import type {
  CSSProperties,
  Dispatch,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
  SetStateAction,
} from 'react';
import { ChevronUp, CornerDownLeft, Download, FolderTree, RefreshCw, Upload } from 'lucide-react';

import type { TranslationKey } from '../../i18n';
import type { RemoteFileEntry } from '../../types';
import { Tooltip } from '../../components/Tooltip';
import {
  explorerRowHeight,
  fileLabelIcon,
  formatBytes,
  formatFileType,
  formatOwnerGroup,
  formatTimestamp,
  parentPath,
} from './presentation';

export type FileContextMenuTarget = (
  | { kind: 'entry'; file: RemoteFileEntry }
  | { kind: 'background'; directory: string }
) & {
  x: number;
  y: number;
};

type FileExplorerPanelProps = {
  beginColumnResize: (event: ReactPointerEvent<HTMLButtonElement>, index: number) => void;
  currentRemotePath: string;
  downloadPaths: (paths: string[]) => void;
  dropRemoteSelectionToDownload: (event: ReactDragEvent<HTMLButtonElement>) => void;
  explorerGridMinWidth: number;
  explorerGridStyle: CSSProperties;
  explorerListRef: RefObject<HTMLDivElement | null>;
  explorerPanelRef: RefObject<HTMLElement | null>;
  files: RemoteFileEntry[];
  filesLoading: boolean;
  handleKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  handleScroll: () => void;
  hasActiveRemoteSession: boolean;
  localFileDropActive: boolean;
  nativeUploadPathSelection: boolean;
  openEntry: (file: RemoteFileEntry) => void;
  pathInput: string;
  refreshFiles: (path?: string) => Promise<void>;
  remoteDownloadDragPaths: string[];
  selectFile: (file: RemoteFileEntry, event: ReactMouseEvent<HTMLButtonElement>) => void;
  selectUploadFiles: () => void;
  selectUploadFolder: () => void;
  selectedFilePathSet: Set<string>;
  selectedFilePaths: string[];
  setFileContextMenu: Dispatch<SetStateAction<FileContextMenuTarget | null>>;
  setPathInput: Dispatch<SetStateAction<string>>;
  setRemoteDownloadDragPaths: Dispatch<SetStateAction<string[]>>;
  setSelectedFilePath: Dispatch<SetStateAction<string>>;
  setSelectedFilePaths: Dispatch<SetStateAction<string[]>>;
  startRemoteDownloadDrag: (file: RemoteFileEntry, event: ReactDragEvent<HTMLElement>) => void;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
  uploadFiles: (files: File[]) => void;
  uploadFolder: (files: File[]) => void;
  virtualEntries: Array<{ file: RemoteFileEntry; index: number }>;
};

// 文件管理面板是受控视图：选择、传输与远端刷新仍由上层用例负责，组件只组织交互和虚拟列表。
export function FileExplorerPanel({
  beginColumnResize,
  currentRemotePath,
  downloadPaths,
  dropRemoteSelectionToDownload,
  explorerGridMinWidth,
  explorerGridStyle,
  explorerListRef,
  explorerPanelRef,
  files,
  filesLoading,
  handleKeyDown,
  handleScroll,
  hasActiveRemoteSession,
  localFileDropActive,
  nativeUploadPathSelection,
  openEntry,
  pathInput,
  refreshFiles,
  remoteDownloadDragPaths,
  selectFile,
  selectUploadFiles,
  selectUploadFolder,
  selectedFilePathSet,
  selectedFilePaths,
  setFileContextMenu,
  setPathInput,
  setRemoteDownloadDragPaths,
  setSelectedFilePath,
  setSelectedFilePaths,
  startRemoteDownloadDrag,
  t,
  uploadFiles,
  uploadFolder,
  virtualEntries,
}: FileExplorerPanelProps) {
  return (
    <section ref={explorerPanelRef} className={`sidebar-panel explorer-panel ${localFileDropActive ? 'is-local-drop-active' : ''}`}>
      <div className="explorer-toolbar">
        <div className="explorer-toolbar-actions">
          <Tooltip content={t('upload')} side="bottom">
            {nativeUploadPathSelection ? (
              <button className="secondary-button slim" disabled={!hasActiveRemoteSession} onClick={selectUploadFiles} type="button">
                <Upload size={14} />
              </button>
            ) : (
              <label className="secondary-button slim file-upload-button">
                <Upload size={14} />
                <input
                  className="hidden-file-input"
                  disabled={!hasActiveRemoteSession}
                  multiple
                  type="file"
                  onChange={(event) => {
                    uploadFiles(Array.from(event.currentTarget.files ?? []));
                    event.currentTarget.value = '';
                  }}
                />
              </label>
            )}
          </Tooltip>
          <Tooltip content={t('uploadFolder')} side="bottom">
            {nativeUploadPathSelection ? (
              <button className="secondary-button slim" disabled={!hasActiveRemoteSession} onClick={selectUploadFolder} type="button">
                <FolderTree size={14} />
              </button>
            ) : (
              <label className="secondary-button slim file-upload-button">
                <FolderTree size={14} />
                <input
                  {...{ directory: '', webkitdirectory: '' }}
                  className="hidden-file-input"
                  disabled={!hasActiveRemoteSession}
                  multiple
                  type="file"
                  onChange={(event) => {
                    uploadFolder(Array.from(event.currentTarget.files ?? []));
                    event.currentTarget.value = '';
                  }}
                />
              </label>
            )}
          </Tooltip>
          <Tooltip content={remoteDownloadDragPaths.length ? t('dropToDownload') : t('download')} side="bottom">
            <button
              className={`secondary-button slim ${remoteDownloadDragPaths.length ? 'is-drop-target' : ''}`}
              disabled={!hasActiveRemoteSession}
              onClick={() => downloadPaths(selectedFilePaths)}
              onDragOver={(event) => {
                if (hasActiveRemoteSession) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'copy';
                }
              }}
              onDrop={dropRemoteSelectionToDownload}
              type="button"
            >
              <Download size={14} />
            </button>
          </Tooltip>
          <span className="explorer-toolbar-spacer" />
          <button className="secondary-button slim" disabled={!hasActiveRemoteSession} onClick={() => void refreshFiles(parentPath(currentRemotePath))} type="button">
            <ChevronUp size={14} /> {t('up')}
          </button>
          <Tooltip content={t('refresh')} side="bottom">
            <button className="secondary-button slim" disabled={!hasActiveRemoteSession} onClick={() => void refreshFiles()} type="button">
              <RefreshCw className={filesLoading ? 'is-spinning' : ''} size={14} />
            </button>
          </Tooltip>
        </div>
        <div className="address-bar">
          <input
            className="address-input"
            disabled={!hasActiveRemoteSession}
            placeholder={t('addressBarPlaceholder')}
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void refreshFiles(pathInput.trim() || '~');
              }
            }}
          />
          <Tooltip content={t('goToPath')} side="bottom">
            <button className="secondary-button slim address-go-button" disabled={!hasActiveRemoteSession} onClick={() => void refreshFiles(pathInput.trim() || '~')} type="button">
              <CornerDownLeft size={14} />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="explorer-shell explorer-shell-dense">
        <div
          ref={explorerListRef}
          className="explorer-list"
          onContextMenu={(event) => {
            const target = event.target;
            if (
              !hasActiveRemoteSession
              || !(target instanceof Element)
              || target.closest('.explorer-row, .explorer-list-header')
            ) {
              return;
            }
            event.preventDefault();
            setSelectedFilePath('');
            setSelectedFilePaths([]);
            setFileContextMenu({
              kind: 'background',
              directory: currentRemotePath,
              x: event.clientX,
              y: event.clientY,
            });
          }}
          onKeyDown={handleKeyDown}
          onScroll={handleScroll}
          tabIndex={hasActiveRemoteSession ? 0 : -1}
        >
          <div className="explorer-list-header" style={explorerGridStyle}>
            {[t('fieldName'), t('fieldSize'), t('fieldType'), t('fieldModifiedAt'), t('fieldPermission'), t('fieldOwnerGroup')].map((label, index, labels) => (
              <span key={`${label}-${index}`} className="explorer-column-header">
                <span>{label}</span>
                {index < labels.length - 1 ? (
                  <Tooltip content={`${label} 调整列宽`} side="top">
                    <button aria-label={`${label} 调整列宽`} className="explorer-column-resizer" onPointerDown={(event) => beginColumnResize(event, index)} type="button" />
                  </Tooltip>
                ) : null}
              </span>
            ))}
          </div>

          {files.length ? (
            <div className="explorer-virtual-body" style={{ height: files.length * explorerRowHeight, minWidth: explorerGridMinWidth }}>
              {virtualEntries.map(({ file, index }) => {
                const Icon = fileLabelIcon(file);
                const isSelected = selectedFilePathSet.has(file.path);
                const fileSizeLabel = file.isDir ? '' : formatBytes(file.size);
                const fileTypeLabel = formatFileType(file, t('directoryLabel'), t('symlinkLabel'), t('fileLabel'));
                const fileModifiedAtLabel = formatTimestamp(file.modifiedAt);
                const filePermissionLabel = file.permissions ?? '--';
                const fileOwnerGroupLabel = formatOwnerGroup(file);
                return (
                  <div
                    key={file.path}
                    className={`explorer-row is-virtual ${index % 2 === 0 ? '' : 'is-odd'} ${isSelected ? 'is-selected' : ''}`}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (!selectedFilePathSet.has(file.path)) {
                        setSelectedFilePath(file.path);
                        setSelectedFilePaths([file.path]);
                      }
                      setFileContextMenu({ kind: 'entry', file, x: event.clientX, y: event.clientY });
                    }}
                    onDoubleClick={() => openEntry(file)}
                    style={{ height: explorerRowHeight, transform: `translateY(${index * explorerRowHeight}px)` }}
                  >
                    <button
                      className="explorer-row-main"
                      disabled={!hasActiveRemoteSession}
                      draggable={hasActiveRemoteSession}
                      onClick={(event) => selectFile(file, event)}
                      onDragEnd={() => setRemoteDownloadDragPaths([])}
                      onDragStart={(event) => startRemoteDownloadDrag(file, event)}
                      style={explorerGridStyle}
                      type="button"
                    >
                      <Tooltip content={file.name} side="bottom">
                        <span className="explorer-name"><Icon size={16} /><strong>{file.name}</strong></span>
                      </Tooltip>
                      <Tooltip content={fileSizeLabel || undefined} side="bottom">
                        <span>{fileSizeLabel}</span>
                      </Tooltip>
                      <Tooltip content={fileTypeLabel} side="bottom">
                        <span>{fileTypeLabel}</span>
                      </Tooltip>
                      <Tooltip content={fileModifiedAtLabel} side="bottom">
                        <span>{fileModifiedAtLabel}</span>
                      </Tooltip>
                      <Tooltip content={filePermissionLabel} side="bottom">
                        <span>{filePermissionLabel}</span>
                      </Tooltip>
                      <Tooltip content={fileOwnerGroupLabel} side="bottom">
                        <span>{fileOwnerGroupLabel}</span>
                      </Tooltip>
                    </button>
                  </div>
                );
              })}
            </div>
          ) : filesLoading ? (
            <div className="panel-loading-overlay is-inline"><RefreshCw className="is-spinning" size={18} /><span>{t('panelRefreshing')}</span></div>
          ) : <div className="empty-state">{t('remoteFilesEmpty')}</div>}
        </div>
      </div>
    </section>
  );
}
