import { useRef, type CSSProperties, type Dispatch, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject, type SetStateAction } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, CornerDownLeft, Download, FolderUp, RefreshCw, Upload } from 'lucide-react';

import type { TranslationKey } from '../../i18n';
import type { RemoteFileEntry } from '../../types';
import { Tooltip } from '../../components/Tooltip';
import { extractDroppedBrowserFiles } from '../../infrastructure/fileTransfer';
import {
  explorerModifiedAtColumnIndex,
  explorerRowHeight,
  fileLabelAppearance,
  formatBytes,
  formatFileType,
  formatOwnerGroup,
  formatTimestamp,
  parentPath,
  type ExplorerModifiedSort,
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
  beginRemoteRowDrag: (file: RemoteFileEntry, event: ReactPointerEvent<HTMLButtonElement>) => void;
  currentRemotePath: string;
  downloadButtonRef: RefObject<HTMLButtonElement | null>;
  downloadDropActive: boolean;
  downloadPaths: (paths: string[]) => void;
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
  modifiedSort: ExplorerModifiedSort;
  nativeUploadPathSelection: boolean;
  onToggleModifiedSort: () => void;
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
  setLocalFileDropActive: Dispatch<SetStateAction<boolean>>;
  setPathInput: Dispatch<SetStateAction<string>>;
  setSelectedFilePath: Dispatch<SetStateAction<string>>;
  setSelectedFilePaths: Dispatch<SetStateAction<string[]>>;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
  uploadFiles: (files: File[]) => void;
  uploadFolder: (files: File[]) => void;
  virtualEntries: Array<{ file: RemoteFileEntry; index: number }>;
};

const isExternalFileDrag = (event: ReactDragEvent<HTMLElement>) => (
  Array.from(event.dataTransfer?.types ?? []).includes('Files')
);

// 文件管理面板是受控视图：选择、传输与远端刷新仍由上层用例负责，组件只组织交互和虚拟列表。
export function FileExplorerPanel({
  beginColumnResize,
  beginRemoteRowDrag,
  currentRemotePath,
  downloadButtonRef,
  downloadDropActive,
  downloadPaths,
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
  modifiedSort,
  nativeUploadPathSelection,
  onToggleModifiedSort,
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
  setLocalFileDropActive,
  setPathInput,
  setSelectedFilePath,
  setSelectedFilePaths,
  t,
  uploadFiles,
  uploadFolder,
  virtualEntries,
}: FileExplorerPanelProps) {
  const browserDragDepthRef = useRef(0);
  const modifiedSortTooltip = modifiedSort === 'asc'
    ? t('explorerSortModifiedAscTooltip')
    : modifiedSort === 'desc'
      ? t('explorerSortModifiedDescTooltip')
      : t('explorerSortModifiedDefaultTooltip');
  const modifiedAriaSort = modifiedSort === 'asc'
    ? 'ascending'
    : modifiedSort === 'desc'
      ? 'descending'
      : 'none';

  // Web 预览模式没有 Tauri 原生窗口拖放事件，保留 HTML5 文件/目录拖入上传兜底。
  const browserDropHandlers = !nativeUploadPathSelection ? {
    onDragEnter: (event: ReactDragEvent<HTMLElement>) => {
      if (!hasActiveRemoteSession || !isExternalFileDrag(event)) {
        return;
      }
      event.preventDefault();
      browserDragDepthRef.current += 1;
      setLocalFileDropActive(true);
    },
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      if (!hasActiveRemoteSession || !isExternalFileDrag(event)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (event: ReactDragEvent<HTMLElement>) => {
      if (!hasActiveRemoteSession || !isExternalFileDrag(event)) {
        return;
      }
      browserDragDepthRef.current = Math.max(0, browserDragDepthRef.current - 1);
      if (!browserDragDepthRef.current) {
        setLocalFileDropActive(false);
      }
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      if (!hasActiveRemoteSession || !isExternalFileDrag(event)) {
        return;
      }
      event.preventDefault();
      browserDragDepthRef.current = 0;
      setLocalFileDropActive(false);
      void extractDroppedBrowserFiles(event.dataTransfer).then((droppedFiles) => {
        if (droppedFiles.length) {
          uploadFiles(droppedFiles);
        }
      });
    },
  } : {};

  return (
    <section
      ref={explorerPanelRef}
      className={`sidebar-panel explorer-panel ${localFileDropActive ? 'is-local-drop-active' : ''}`}
      {...browserDropHandlers}
    >
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
          {/* 上传整个文件夹：采用专属的带向上箭头文件夹图标 FolderUp，与单文件上传 Upload 和下载 Download 统一 */}
          <Tooltip content={t('uploadFolder')} side="bottom">
            {nativeUploadPathSelection ? (
              <button className="secondary-button slim" disabled={!hasActiveRemoteSession} onClick={selectUploadFolder} type="button">
                <FolderUp size={14} />
              </button>
            ) : (
              <label className="secondary-button slim file-upload-button">
                <FolderUp size={14} />
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
              ref={downloadButtonRef}
              className={`secondary-button slim explorer-download-button ${remoteDownloadDragPaths.length ? 'is-drop-target' : ''} ${downloadDropActive ? 'is-drop-hot' : ''}`}
              disabled={!hasActiveRemoteSession}
              onClick={() => downloadPaths(selectedFilePaths)}
              type="button"
            >
              <Download size={14} />
            </button>
          </Tooltip>
          <span className="explorer-toolbar-spacer" />
          {/* 返回上一级目录：采用标准向上导航箭头 ArrowUp，与底部工作台展开/收起的折叠尖角（ChevronUp/Down）解耦 */}
          <button className="secondary-button slim" disabled={!hasActiveRemoteSession} onClick={() => void refreshFiles(parentPath(currentRemotePath))} type="button">
            <ArrowUp size={14} /> {t('up')}
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
                {index === explorerModifiedAtColumnIndex ? (
                  <Tooltip content={modifiedSortTooltip} side="top">
                    <button
                      aria-label={modifiedSortTooltip}
                      aria-sort={modifiedAriaSort}
                      className={`explorer-column-sort-button ${modifiedSort !== 'default' ? 'is-active' : ''}`}
                      data-sort={modifiedSort}
                      onClick={onToggleModifiedSort}
                      type="button"
                    >
                      <span>{label}</span>
                      {modifiedSort === 'asc' ? (
                        <ArrowUp aria-hidden="true" className="explorer-column-sort-icon" size={12} />
                      ) : modifiedSort === 'desc' ? (
                        <ArrowDown aria-hidden="true" className="explorer-column-sort-icon" size={12} />
                      ) : (
                        <ArrowUpDown aria-hidden="true" className="explorer-column-sort-icon is-idle" size={12} />
                      )}
                    </button>
                  </Tooltip>
                ) : (
                  <span>{label}</span>
                )}
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
                const { icon: Icon, tone: iconTone } = fileLabelAppearance(file);
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
                      onClick={(event) => selectFile(file, event)}
                      onPointerDown={(event) => beginRemoteRowDrag(file, event)}
                      style={explorerGridStyle}
                      type="button"
                    >
                      <Tooltip content={file.name} side="bottom">
                        <span className="explorer-name"><Icon aria-hidden="true" className={`explorer-file-icon file-icon-${iconTone}`} size={16} /><strong>{file.name}</strong></span>
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
        {localFileDropActive ? (
          <div className="explorer-drop-overlay">
            <Upload size={18} />
            <span>{t('explorerDropUploadTitle', { path: currentRemotePath || '~' })}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
