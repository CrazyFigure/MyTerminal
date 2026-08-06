import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, Copy } from 'lucide-react';

import type { TranslationKey } from '../../i18n';
import { isEditableFile } from './presentation';
import type { FileContextMenuTarget } from './FileExplorerPanel';

export type RemoteFileClipboard = { connectionId: string; paths: string[] };

type Props = {
  activeConnectionId?: string;
  clipboard: RemoteFileClipboard | null;
  copyName: (text: string) => void;
  copySelection: (paths: string[]) => void;
  deletePaths: (paths: string[]) => void;
  downloadFile: (path: string) => void;
  downloadPaths: (paths: string[]) => void;
  onClose: () => void;
  openEditor: (path: string) => void;
  pasteClipboard: () => void;
  refreshFiles: (path?: string) => Promise<void>;
  renamePath: (path: string, nextName: string) => Promise<unknown>;
  selectedFilePathSet: Set<string>;
  selectedFilePaths: string[];
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
  target: FileContextMenuTarget;
};

// 文件右键菜单封装目标解析、视口回收和二级菜单翻转；上层只提供远端文件用例。
export function FileContextMenu({
  activeConnectionId,
  clipboard,
  copyName,
  copySelection,
  deletePaths,
  downloadFile,
  downloadPaths,
  onClose,
  openEditor,
  pasteClipboard,
  refreshFiles,
  renamePath,
  selectedFilePathSet,
  selectedFilePaths,
  t,
  target,
}: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [copyNameSubmenuFlipLeft, setCopyNameSubmenuFlipLeft] = useState(false);
  const menuPaths = selectedFilePathSet.has(target.file.path) ? selectedFilePaths : [target.file.path];
  const canPaste = Boolean(clipboard && clipboard.connectionId === activeConnectionId && clipboard.paths.length);

  // 菜单首次测量后在绘制前收回视口内，避免主菜单或二级菜单被窗口边缘裁切。
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) {
      return;
    }
    const margin = 8;
    const rect = menu.getBoundingClientRect();
    let left = target.x;
    let top = target.y;
    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    setCopyNameSubmenuFlipLeft(left + rect.width + 160 > window.innerWidth - margin);
  }, [target]);

  return (
    <div ref={menuRef} className="context-menu file-context-menu" style={{ left: target.x, top: target.y }} onClick={(event) => event.stopPropagation()}>
      {selectedFilePathSet.has(target.file.path) && selectedFilePaths.length > 1 ? (
        <>
          <button className="context-menu-item" onClick={() => {
            downloadPaths(selectedFilePaths);
            onClose();
          }} type="button">
            {t('fileMenuDownloadSelected')} ({selectedFilePaths.length})
          </button>
          <button className="context-menu-item danger" onClick={() => deletePaths(selectedFilePaths)} type="button">
            {t('fileMenuDeleteSelected')} ({selectedFilePaths.length})
          </button>
        </>
      ) : null}
      {target.file.isDir ? (
        <button className="context-menu-item" onClick={() => {
          void refreshFiles(target.file.path);
          onClose();
        }} type="button">{t('fileMenuOpen')}</button>
      ) : null}
      {!target.file.isDir && isEditableFile(target.file.path) ? (
        <button className="context-menu-item" onClick={() => {
          openEditor(target.file.path);
          onClose();
        }} type="button">{t('fileMenuEdit')}</button>
      ) : null}
      <button className="context-menu-item" onClick={() => {
        downloadFile(target.file.path);
        onClose();
      }} type="button">{t('fileMenuDownload')}</button>
      <div className="context-menu-item has-submenu" tabIndex={0}>
        <span className="context-menu-item-label"><Copy size={14} /> {t('fileMenuCopyName')}</span>
        <ChevronRight className="context-submenu-caret" size={12} />
        <div className={`context-menu file-context-menu context-submenu${copyNameSubmenuFlipLeft ? ' flip-left' : ''}`}>
          <button className="context-menu-item" onClick={() => copyName(target.file.name)} type="button">{t('fileMenuCopyFileName')}</button>
          <button className="context-menu-item" onClick={() => copyName(target.file.path)} type="button">{t('fileMenuCopyFullPath')}</button>
        </div>
      </div>
      <button className="context-menu-item" onClick={() => copySelection(menuPaths)} type="button">
        {t('fileMenuCopy')}{menuPaths.length > 1 ? ` (${menuPaths.length})` : ''}
      </button>
      <button className="context-menu-item" disabled={!canPaste} onClick={pasteClipboard} type="button">{t('fileMenuPaste')}</button>
      <button className="context-menu-item" onClick={() => {
        const nextName = window.prompt(t('rename'), target.file.name);
        if (nextName) {
          void renamePath(target.file.path, nextName);
        }
        onClose();
      }} type="button">{t('fileMenuRename')}</button>
      <button className="context-menu-item danger" onClick={() => deletePaths(menuPaths)} type="button">{t('fileMenuDelete')}</button>
    </div>
  );
}
