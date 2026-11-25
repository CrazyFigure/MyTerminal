/* 本模块从 Store 中按业务边界提取；领域规则不得依赖 Zustand，应用服务只暴露稳定操作。 */


export const toBase64 = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};



// 本机路径取最后一段作为远端名称，兼容 Windows 反斜杠与 POSIX 斜杠。
export const localPathName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

// 上传冲突只需比较目标目录下的顶层项目：单文件即文件名，目录上传取相对路径的根目录名。
export const uploadTopLevelName = (file: File) => uploadRemoteName(file).split('/')[0] || file.name;

export const uploadRemoteName = (file: File) => {
  // 目录上传依赖浏览器提供的 webkitRelativePath 保留根目录和子目录；单文件上传没有该字段时退回文件名。
  const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  const normalized = relativePath
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
  return normalized || file.name;
};

type BrowserFileEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (file: File) => void, error?: (err: unknown) => void) => void;
  createReader?: () => {
    readEntries: (success: (entries: BrowserFileEntry[]) => void, error?: (err: unknown) => void) => void;
  };
};

// 给浏览器目录遍历读取出的 File 补齐相对路径，复用已有 uploadRemoteName 保留远端目录树。
const attachRelativePath = (file: File, relativePath: string): File => {
  const existing = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  if (existing === relativePath) {
    return file;
  }
  try {
    Object.defineProperty(file, 'webkitRelativePath', {
      configurable: true,
      value: relativePath,
    });
  } catch {
    // 某些宿主只读属性无法改写时保留原始 File，退回扁平文件名上传。
  }
  return file;
};

const readBrowserEntryFiles = async (entry: BrowserFileEntry, parentPrefix = ''): Promise<File[]> => {
  const currentPath = parentPrefix ? `${parentPrefix}/${entry.name}` : entry.name;
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((resolve, reject) => {
      entry.file!(resolve, reject);
    });
    return [attachRelativePath(file, currentPath)];
  }
  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    const children: BrowserFileEntry[] = [];
    // Chromium readEntries 每次最多返回一批（通常 100 条），必须读到空数组才算遍历完整目录。
    while (true) {
      const batch = await new Promise<BrowserFileEntry[]>((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
      if (!batch.length) {
        break;
      }
      children.push(...batch);
    }
    const nested: File[] = [];
    for (const child of children) {
      nested.push(...await readBrowserEntryFiles(child, currentPath));
    }
    return nested;
  }
  return [];
};

// Web 预览环境（非 Tauri）拖放上传：支持文件与目录树提取，同时兼容仅暴露 dataTransfer.files 的浏览器测试。
export const extractDroppedBrowserFiles = async (dataTransfer: DataTransfer): Promise<File[]> => {
  const items = Array.from(dataTransfer.items ?? []);
  const entries = items
    .map((item) => (
      item as DataTransferItem & { webkitGetAsEntry?: () => BrowserFileEntry | null }
    ).webkitGetAsEntry?.() as BrowserFileEntry | null ?? null)
    .filter((entry): entry is BrowserFileEntry => Boolean(entry));

  if (entries.length) {
    const collected: File[] = [];
    for (const entry of entries) {
      collected.push(...await readBrowserEntryFiles(entry));
    }
    if (collected.length) {
      return collected;
    }
  }

  return Array.from(dataTransfer.files ?? []).filter((file) => Boolean(file.name));
};
