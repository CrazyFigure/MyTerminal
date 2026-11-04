/* 功能域展示规则：不持有 React 页面状态，只把输入转换成稳定的显示结果。 */
import {
  FileArchive, FileAudio, FileCode2, FileImage, FileSpreadsheet, FileSymlink,
  FileText, FileVideo, Folder, Settings2, SquareTerminal, type LucideIcon,
} from 'lucide-react';
import type { RemoteFileEntry } from '../../types';

// 文件管理列宽保持紧凑默认值，同时给名称列更多可扩展空间，方便长文件名场景手动拉宽。
export const explorerDefaultColumnWidths = [220, 70, 62, 160, 92, 118];


// 文件管理列表使用固定行高做虚拟滚动，目录文件很多时也只渲染视口附近的行。
export const explorerRowHeight = 27;


// 视口上下各多渲染少量缓冲行，避免快速滚动时出现空白闪烁。
export const explorerOverscanRows = 10;


export const explorerColumnLimits = [
  { min: 150, max: 680 },
  { min: 58, max: 140 },
  { min: 54, max: 130 },
  { min: 130, max: 260 },
  { min: 78, max: 180 },
  { min: 90, max: 220 },
];



export const parentPath = (path: string) => {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized || normalized === '/' || normalized === '~') {
    return '~';
  }

  const parts = normalized.split('/').filter(Boolean);
  parts.pop();
  return normalized.startsWith('/') ? `/${parts.join('/')}` || '/' : parts.join('/') || '~';
};



export const isEditableFile = (path: string) => {
  const normalized = path.toLowerCase();
  return [
    '.txt',
    '.md',
    '.json',
    '.yaml',
    '.yml',
    '.toml',
    '.ini',
    '.conf',
    '.xml',
    '.env',
    '.sh',
    '.bash',
    '.zsh',
    '.ps1',
    '.py',
    '.rs',
    '.js',
    '.ts',
    '.tsx',
    '.jsx',
    '.java',
    '.go',
    '.sql',
    '.log',
    '.csv',
  ].some((extension) => normalized.endsWith(extension));
};



export const formatBytes = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

// 实时速率格式化：转换为可读的 B/s、KB/s 或 MB/s，未开始或无效时不展示。
export const formatSpeed = (bytesPerSecond?: number) => {
  if (bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) {
    return undefined;
  }
  return `${formatBytes(bytesPerSecond)}/s`;
};




export const formatTimestamp = (value?: string) => {
  if (!value) {
    return '--';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  // 格式化为 yyyy-MM-dd HH:mm:ss 本地时间格式
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};



// 文件类型列优先表达用户真正关心的类别，普通文件再退回扩展名。
export const formatFileType = (file: RemoteFileEntry, directoryLabel: string, symlinkLabel: string, fileLabel: string) => {
  if (file.isSymlink) {
    return symlinkLabel;
  }
  if (file.isDir) {
    return directoryLabel;
  }

  const extension = file.name.split('.').pop();
  return extension && extension !== file.name ? extension : fileLabel;
};



// 属主列沿用 FinalShell 常见的 owner/group 组合展示，缺失时保持占位。
export const formatOwnerGroup = (file: RemoteFileEntry) => {
  if (file.owner && file.group) {
    return `${file.owner}/${file.group}`;
  }

  return file.owner ?? file.group ?? '--';
};



type FileIconAppearance = {
  icon: LucideIcon;
  tone: 'folder' | 'document' | 'code' | 'config' | 'sheet' | 'source' | 'archive' | 'image' | 'link';
};

// 图标与语义色统一分类，扩展名只用于展示，不改变文件能否编辑或打开的既有规则。
const fileIconGroups: Array<FileIconAppearance & { extensions: string[] }> = [
  { icon: FileText, tone: 'document', extensions: ['txt', 'md', 'markdown', 'log', 'doc', 'docx', 'odt', 'rtf', 'pdf'] },
  { icon: SquareTerminal, tone: 'code', extensions: ['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd'] },
  { icon: Settings2, tone: 'config', extensions: ['json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'conf', 'config', 'env', 'properties'] },
  { icon: FileSpreadsheet, tone: 'sheet', extensions: ['xls', 'xlsx', 'xlsm', 'ods', 'csv', 'tsv', 'bitable'] },
  {
    icon: FileCode2,
    tone: 'source',
    extensions: [
      'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'vue', 'svelte', 'html', 'htm', 'xml',
      'css', 'scss', 'less', 'py', 'rs', 'java', 'go', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'rb', 'sql',
    ],
  },
  { icon: FileArchive, tone: 'archive', extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'jar', 'war'] },
  { icon: FileImage, tone: 'image', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif', 'heic'] },
  { icon: FileAudio, tone: 'image', extensions: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'] },
  { icon: FileVideo, tone: 'image', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm'] },
];

// 表驱动映射在模块加载时建立，虚拟列表每行只做一次查询。
const extensionIconAppearances = new Map(fileIconGroups.flatMap(({ extensions, ...appearance }) => (
  extensions.map((extension) => [extension, appearance] as const)
)));
const configFileNames = new Set(['dockerfile', 'makefile', 'crontab', '.gitignore', '.gitattributes', '.editorconfig', '.dockerignore', '.npmrc', '.yarnrc']);
const shellFileNames = new Set(['.bashrc', '.bash_profile', '.bash_logout', '.zshrc', '.zprofile', '.profile']);
const defaultFileAppearance: FileIconAppearance = { icon: FileText, tone: 'document' };

// 符号链接优先保留链接语义；无扩展名配置和 shell 隐藏文件按完整名称识别。
export const fileLabelAppearance = (file: RemoteFileEntry): FileIconAppearance => {
  if (file.isSymlink) {
    return { icon: FileSymlink, tone: 'link' };
  }
  if (file.isDir) {
    return { icon: Folder, tone: 'folder' };
  }
  const name = file.name.toLowerCase();
  if (name === '.env' || name.startsWith('.env.') || name.startsWith('dockerfile.') || configFileNames.has(name)) {
    return { icon: Settings2, tone: 'config' };
  }
  if (shellFileNames.has(name)) {
    return { icon: SquareTerminal, tone: 'code' };
  }
  const extension = name.includes('.') ? name.split('.').pop() ?? '' : '';
  return extensionIconAppearances.get(extension) ?? defaultFileAppearance;
};
