import type { TranslationKey } from "../../i18n";
import type {
  AgentChatAttachment,
  LocalAgentAttachmentFile,
} from "../../types";
import { newId } from "./chatModel";

// 单条消息最多附带的文件数；再多既难以在侧栏里辨认，也容易一次把上下文吃满。
export const MAX_ATTACHMENTS = 8;
// 文本附件正文的字符上限；后端只读开头 512KB，这里再按字符截一次，控制单个文件的 token 占用。
const MAX_TEXT_CHARS = 100_000;
// 图片长边上限：主流多模态模型超过该尺寸会在服务端再缩放，提前缩小可显著减少上传体积和 token。
const IMAGE_MAX_EDGE = 1568;
// 尺寸合规且不超过该体积的常见格式原样发送，避免无谓的重新编码损失画质。
const IMAGE_PASSTHROUGH_BYTES = 3.5 * 1024 * 1024;
const PASSTHROUGH_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
// 文件对话框里预置的常见文本格式；不在列表里的文件仍可通过“所有文件”选择，由后端按内容判定。
export const TEXT_EXTENSIONS = [
  "txt", "md", "markdown", "log", "out", "err", "json", "jsonl", "yaml", "yml",
  "toml", "ini", "conf", "cfg", "env", "properties", "xml", "csv", "tsv", "sql",
  "sh", "bash", "zsh", "ps1", "psm1", "bat", "cmd", "py", "js", "mjs", "cjs",
  "ts", "tsx", "jsx", "vue", "rs", "go", "java", "kt", "c", "h", "cpp", "hpp",
  "cs", "rb", "php", "lua", "html", "htm", "css", "scss", "less", "gradle",
  "service", "dockerfile", "tf", "hcl", "diff", "patch",
];

/** 附件处理失败；code 是界面文案键，由调用方翻译后提示。 */
export class AgentAttachmentError extends Error {
  constructor(
    public readonly code: TranslationKey,
    public readonly replacements: Record<string, string | number> = {},
  ) {
    super(code);
  }
}

export const isImageFileName = (name: string) =>
  IMAGE_EXTENSIONS.includes(name.split(".").pop()?.toLowerCase() ?? "");

// 文件对话框过滤器：多模态模型把图片放进“支持的文件”首选项，否则只列文本格式。
export const buildAttachmentDialogFilters = (
  multimodal: boolean,
  labels: { supported: string; images: string; text: string; all: string },
) => {
  const filters = [
    {
      name: labels.supported,
      extensions: multimodal
        ? [...IMAGE_EXTENSIONS, ...TEXT_EXTENSIONS]
        : TEXT_EXTENSIONS,
    },
  ];
  if (multimodal) {
    filters.push({ name: labels.images, extensions: IMAGE_EXTENSIONS });
  }
  filters.push({ name: labels.text, extensions: TEXT_EXTENSIONS });
  filters.push({ name: labels.all, extensions: ["*"] });
  return filters;
};

export const formatAttachmentSize = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const base64ToBytes = (base64: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const capText = (content: string, truncated: boolean) =>
  content.length > MAX_TEXT_CHARS
    ? { content: content.slice(0, MAX_TEXT_CHARS), truncated: true }
    : { content, truncated };

/**
 * 解码浏览器侧拿到的文本字节（拖入或粘贴的文件没有路径，只能在前端读取）。
 * 依次识别 UTF-16 BOM、严格 UTF-8，最后按 GB18030 兜底，覆盖 Windows 上常见的 GBK 日志与配置。
 */
const decodeTextBytes = (bytes: Uint8Array, name: string, truncated = false) => {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  // 开头一段出现 0 字节基本可以断定是二进制文件，直接拒绝而不是塞给模型一堆乱码。
  if (bytes.subarray(0, 8192).includes(0)) {
    throw new AgentAttachmentError("agentAttachBinary", { name });
  }
  try {
    // 截断读取时以流模式解码：末尾半个多字节字符会被缓存而不是报错，避免误判成 GBK。
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes,
      { stream: truncated },
    );
  } catch {
    return new TextDecoder("gb18030").decode(bytes);
  }
};

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image decode failed"));
    image.src = src;
  });

/**
 * 统一图片尺寸与格式：长边超过上限或体积过大时用 canvas 缩放，
 * 优先保留 PNG（截图文字更清晰），仍过大或源格式不被模型接受（如 BMP）时转为 JPEG。
 */
const normalizeImage = async (
  name: string,
  mediaType: string,
  base64: string,
  size: number,
) => {
  let image: HTMLImageElement;
  try {
    image = await loadImage(`data:${mediaType};base64,${base64}`);
  } catch {
    throw new AgentAttachmentError("agentAttachImageDecodeFailed", { name });
  }
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(width, height, 1));
  if (
    scale === 1 &&
    size <= IMAGE_PASSTHROUGH_BYTES &&
    PASSTHROUGH_IMAGE_TYPES.has(mediaType)
  ) {
    return { mediaType, data: base64, width, height };
  }

  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new AgentAttachmentError("agentAttachImageDecodeFailed", { name });
  }
  context.drawImage(image, 0, 0, targetWidth, targetHeight);
  let dataUrl = canvas.toDataURL("image/png");
  // base64 长度约为原始字节的 4/3，按此估算 PNG 是否仍然过大。
  if (mediaType !== "image/png" || (dataUrl.length * 3) / 4 > IMAGE_PASSTHROUGH_BYTES) {
    // JPEG 不支持透明：先在底层铺白，避免透明区域变成黑色。
    context.globalCompositeOperation = "destination-over";
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, targetWidth, targetHeight);
    dataUrl = canvas.toDataURL("image/jpeg", 0.86);
  }
  const [header, data] = dataUrl.split(",", 2);
  return {
    mediaType: header.slice(5, header.indexOf(";")),
    data,
    width: targetWidth,
    height: targetHeight,
  };
};

const readBlobAsBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });

/** 按 Unicode 字符计数（中文、emoji 都算一个字），与设置页“字数”阈值口径一致。 */
export const countTextChars = (text: string) => Array.from(text).length;

/** 把超长粘贴折叠成文本块附件；字节数用于上下文估算，展示时改用字数。 */
export const attachmentFromPastedText = (
  text: string,
  name: string,
): AgentChatAttachment => ({
  kind: "text",
  id: newId(),
  name,
  size: new TextEncoder().encode(text).length,
  pasted: true,
  ...capText(text, false),
});

/** 把后端读到的本地文件转成对话附件。 */
export const attachmentFromLocalFile = async (
  file: LocalAgentAttachmentFile,
): Promise<AgentChatAttachment> => {
  if (file.kind === "image") {
    const image = await normalizeImage(
      file.name,
      file.mediaType,
      file.data ?? "",
      file.size,
    );
    return {
      kind: "image",
      id: newId(),
      name: file.name,
      path: file.path,
      size: file.size,
      ...image,
    };
  }
  const raw =
    file.text ?? decodeTextBytes(base64ToBytes(file.data ?? ""), file.name);
  return {
    kind: "text",
    id: newId(),
    name: file.name,
    path: file.path,
    size: file.size,
    ...capText(raw, file.truncated),
  };
};

/** 把粘贴或拖入的浏览器 File 转成对话附件；这类文件拿不到本地路径，只保留文件名。 */
export const attachmentFromBlob = async (
  file: File,
): Promise<AgentChatAttachment> => {
  const name = file.name || "image.png";
  if (file.type.startsWith("image/") || isImageFileName(name)) {
    const base64 = await readBlobAsBase64(file);
    const image = await normalizeImage(
      name,
      file.type || "image/png",
      base64,
      file.size,
    );
    return { kind: "image", id: newId(), name, size: file.size, ...image };
  }
  // 与后端保持同一读取上限，避免把超大日志整份读进内存。
  const limit = 512 * 1024;
  const bytes = new Uint8Array(await file.slice(0, limit).arrayBuffer());
  return {
    kind: "text",
    id: newId(),
    name,
    size: file.size,
    ...capText(
      decodeTextBytes(bytes, name, file.size > limit),
      file.size > limit,
    ),
  };
};
