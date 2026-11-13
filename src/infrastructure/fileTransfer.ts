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
