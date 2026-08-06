/* 本模块从 Store 中按业务边界提取；领域规则不得依赖 Zustand，应用服务只暴露稳定操作。 */


export const toBase64 = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};



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
