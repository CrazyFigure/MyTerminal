import { useEffect } from "react";
import { createPortal } from "react-dom";
import { ClipboardList, FileText, ImageOff, X } from "lucide-react";

import { Tooltip } from "../../components/Tooltip";
import type { TranslationKey } from "../../i18n";
import type { AgentChatAttachment } from "../../types";
import { countTextChars, formatAttachmentSize } from "./attachments";

type Translate = (
  key: TranslationKey,
  replacements?: Record<string, string | number>,
) => string;

type ImageAttachment = Extract<AgentChatAttachment, { kind: "image" }>;

const imageSrc = (attachment: ImageAttachment) =>
  `data:${attachment.mediaType};base64,${attachment.data}`;

// 悬浮提示展示完整来源：有 Windows 路径时给路径，粘贴/拖入的文件只有文件名。
const describeAttachment = (attachment: AgentChatAttachment, t: Translate) => {
  // 粘贴的文本块没有来源路径，悬浮提示直接预览开头几行内容。
  if (attachment.kind === "text" && attachment.pasted) {
    const preview = attachment.content.slice(0, 240);
    return `${preview}${attachment.content.length > 240 ? "…" : ""}`;
  }
  const source = attachment.path || attachment.name;
  if (attachment.kind === "image") {
    return `${source}\n${attachment.width}×${attachment.height} · ${formatAttachmentSize(attachment.size)}`;
  }
  const size = formatAttachmentSize(attachment.size);
  return attachment.truncated
    ? `${source}\n${size} · ${t("agentAttachTruncated")}`
    : `${source}\n${size}`;
};

type ChipProps = {
  attachment: AgentChatAttachment;
  /** 当前模型不支持该附件（非多模态模型下的图片），以警示样式提醒用户移除。 */
  unsupported?: boolean;
  onPreview?: (attachment: ImageAttachment) => void;
  onRemove?: (id: string) => void;
  t: Translate;
};

// 附件卡片：图片显示缩略图、文本显示文件名与大小；输入框中可移除，消息里只读。
export function AgentAttachmentChip({
  attachment,
  unsupported = false,
  onPreview,
  onRemove,
  t,
}: ChipProps) {
  const tooltip = unsupported
    ? `${describeAttachment(attachment, t)}\n${t("agentAttachImageUnsupported")}`
    : describeAttachment(attachment, t);

  return (
    <div
      className={`agent-attachment is-${attachment.kind} ${unsupported ? "is-unsupported" : ""}`}
    >
      <Tooltip content={<span className="agent-attachment-tooltip">{tooltip}</span>} side="top">
        {attachment.kind === "image" ? (
          <button
            aria-label={attachment.name}
            className="agent-attachment-thumb"
            onClick={() => onPreview?.(attachment)}
            type="button"
          >
            {unsupported ? (
              <ImageOff size={16} />
            ) : (
              <img alt={attachment.name} draggable={false} src={imageSrc(attachment)} />
            )}
          </button>
        ) : (
          <div className="agent-attachment-file">
            {attachment.pasted ? <ClipboardList size={15} /> : <FileText size={15} />}
            <span className="agent-attachment-name">{attachment.name}</span>
            <small>
              {attachment.pasted
                ? t("agentPastedTextChars", { count: countTextChars(attachment.content) })
                : formatAttachmentSize(attachment.size)}
            </small>
          </div>
        )}
      </Tooltip>
      {onRemove ? (
        <button
          aria-label={t("agentAttachRemove")}
          className="agent-attachment-remove"
          onClick={() => onRemove(attachment.id)}
          type="button"
        >
          <X size={11} />
        </button>
      ) : null}
    </div>
  );
}

type MessageProps = {
  attachments: AgentChatAttachment[];
  onPreview: (attachment: ImageAttachment) => void;
  t: Translate;
};

// 已发送消息里的附件：图片按较大缩略图平铺，文本文件以卡片列出，点击图片可放大查看。
export function AgentMessageAttachments({ attachments, onPreview, t }: MessageProps) {
  const images = attachments.filter(
    (item): item is ImageAttachment => item.kind === "image",
  );
  const files = attachments.filter((item) => item.kind === "text");
  return (
    <div className="agent-message-attachments">
      {images.length ? (
        <div className="agent-message-images">
          {images.map((image) => (
            <Tooltip
              key={image.id}
              content={<span className="agent-attachment-tooltip">{describeAttachment(image, t)}</span>}
              side="top"
            >
              <button
                aria-label={image.name}
                className="agent-message-image"
                onClick={() => onPreview(image)}
                type="button"
              >
                <img alt={image.name} draggable={false} src={imageSrc(image)} />
              </button>
            </Tooltip>
          ))}
        </div>
      ) : null}
      {files.length ? (
        <div className="agent-message-files">
          {files.map((file) => (
            <AgentAttachmentChip key={file.id} attachment={file} t={t} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

type PreviewProps = {
  attachment: ImageAttachment;
  onClose: () => void;
  t: Translate;
};

// 图片放大预览：点击遮罩或按 Esc 关闭；挂到 .app-shell 以继承主题变量并盖住整个窗口。
export function AgentImagePreview({ attachment, onClose, t }: PreviewProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return createPortal(
    <div className="agent-image-preview" onClick={onClose} role="dialog">
      <figure onClick={(event) => event.stopPropagation()}>
        <img alt={attachment.name} src={imageSrc(attachment)} />
        <figcaption>
          <span>{attachment.path || attachment.name}</span>
          <small>
            {attachment.width}×{attachment.height} · {formatAttachmentSize(attachment.size)}
          </small>
        </figcaption>
      </figure>
      <button
        aria-label={t("agentAttachPreviewClose")}
        className="agent-image-preview-close"
        onClick={onClose}
        type="button"
      >
        <X size={18} />
      </button>
    </div>,
    document.querySelector(".app-shell") ?? document.body,
  );
}
