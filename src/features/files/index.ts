// 文件管理功能域公共入口。
export {
  explorerColumnLimits,
  explorerDefaultColumnWidths,
  explorerOverscanRows,
  explorerRowHeight,
  fileLabelIcon,
  formatBytes,
  formatFileType,
  formatOwnerGroup,
  formatTimestamp,
  isEditableFile,
  parentPath,
} from './presentation';
export { FileExplorerPanel, type FileContextMenuTarget } from './FileExplorerPanel';
export { FileContextMenu, type RemoteFileClipboard } from './FileContextMenu';
