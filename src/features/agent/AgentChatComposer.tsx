import { useEffect, useRef } from "react";
import { Paperclip, Send, Square } from "lucide-react";

import { Tooltip } from "../../components/Tooltip";
import type { TranslationKey } from "../../i18n";
import type { AgentChatAttachment } from "../../types";
import { AgentAttachmentChip } from "./AgentChatAttachments";
import { MAX_ATTACHMENTS, countTextChars } from "./attachments";

/** 输入框自适应高度的上下限，兼顾单行简短指令与多行任务描述。 */
const COMPOSER_MIN_HEIGHT = 38;
const COMPOSER_MAX_HEIGHT = 180;

type Props = {
  attachments: AgentChatAttachment[];
  input: string;
  /** 当前模型是否接受图片；决定添加按钮的提示文案与图片附件的警示样式。 */
  multimodal: boolean;
  /** 正在读取中的附件数，用占位卡片表达进度并暂缓发送。 */
  pendingCount: number;
  running: boolean;
  /** 对话绑定的模型已不可用等情况下禁止发送，但仍允许编辑草稿。 */
  sendBlocked: boolean;
  onCancel: () => void;
  onInputChange: (value: string) => void;
  /** 粘贴内容没有文本时交给上层：可能是截图、资源管理器复制的文件。 */
  onPasteNonText: (files: File[]) => void;
  /** 超过阈值的长文本粘贴，交给上层折叠成文本块附件。 */
  onPasteLongText: (text: string) => void;
  /** 粘贴折叠阈值（字），0 表示关闭。 */
  pasteBlockThreshold: number;
  onPickFiles: () => void;
  onPreviewImage: (attachment: Extract<AgentChatAttachment, { kind: "image" }>) => void;
  onRemoveAttachment: (id: string) => void;
  onSend: () => void;
  t: (
    key: TranslationKey,
    replacements?: Record<string, string | number>,
  ) => string;
};

// 输入区只负责草稿编辑、附件托盘与按键手势；附件读取和发送事务由对话编排层处理。
export function AgentChatComposer({
  attachments,
  input,
  multimodal,
  pendingCount,
  running,
  sendBlocked,
  onCancel,
  onInputChange,
  onPasteNonText,
  onPasteLongText,
  onPickFiles,
  onPreviewImage,
  onRemoveAttachment,
  onSend,
  pasteBlockThreshold,
  t,
}: Props) {
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const hasUnsupportedImage =
    !multimodal && attachments.some((item) => item.kind === "image");
  const canSend =
    (input.trim().length > 0 || attachments.length > 0) &&
    pendingCount === 0 &&
    !sendBlocked &&
    !hasUnsupportedImage;
  const attachLimitReached = attachments.length + pendingCount >= MAX_ATTACHMENTS;

  // 输入框随内容增高，超过上限后内部滚动，不再挤占消息区。
  useEffect(() => {
    const node = composerRef.current;
    if (!node) {
      return;
    }
    // 先记下当前光标/选区：把 height 置 auto 再回填会触发重排，
    // WebView2 下这一下偶发把光标甩到鼠标悬停的位置，写完再还原即可避免打字时乱跳。
    const start = node.selectionStart;
    const end = node.selectionEnd;
    node.style.height = "auto";
    node.style.height = `${Math.min(Math.max(node.scrollHeight, COMPOSER_MIN_HEIGHT), COMPOSER_MAX_HEIGHT)}px`;
    if (document.activeElement === node) {
      node.setSelectionRange(start, end);
    }
  }, [input]);

  const sendTooltip = hasUnsupportedImage
    ? t("agentAttachImageUnsupported")
    : t("agentChatSend");

  return (
    <div className="agent-chat-composer">
      {attachments.length || pendingCount ? (
        <div className="agent-chat-attachment-tray">
          {attachments.map((attachment) => (
            <AgentAttachmentChip
              key={attachment.id}
              attachment={attachment}
              onPreview={onPreviewImage}
              onRemove={onRemoveAttachment}
              t={t}
              unsupported={!multimodal && attachment.kind === "image"}
            />
          ))}
          {Array.from({ length: pendingCount }, (_, index) => (
            <div
              key={`pending-${index}`}
              aria-label={t("agentAttachReading")}
              className="agent-attachment is-pending"
            />
          ))}
        </div>
      ) : null}
      <div className="agent-chat-composer-row">
        <Tooltip
          content={
            attachLimitReached
              ? t("agentAttachLimit", { count: MAX_ATTACHMENTS })
              : multimodal
                ? t("agentAttachAddMultimodal")
                : t("agentAttachAddText")
          }
          side="top"
        >
          <button
            aria-label={t("agentAttachAdd")}
            className="icon-button agent-chat-attach"
            disabled={attachLimitReached}
            onClick={onPickFiles}
            type="button"
          >
            <Paperclip size={15} />
          </button>
        </Tooltip>
        <textarea
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter 发送、Shift+Enter 换行，与常见聊天界面一致；输入法组合中的回车不触发发送。
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (canSend && !running) {
                onSend();
              }
            }
          }}
          onPaste={(event) => {
            const data = event.clipboardData;
            // 有文本时：超过阈值的长文本折叠成文本块，其余走浏览器默认粘贴；
            // 只有截图、文件这类非文本内容才转成附件。
            const text = data.getData("text/plain");
            if (text) {
              if (pasteBlockThreshold > 0 && countTextChars(text) > pasteBlockThreshold) {
                event.preventDefault();
                onPasteLongText(text);
              }
              return;
            }
            event.preventDefault();
            onPasteNonText(Array.from(data.files));
          }}
          placeholder={
            multimodal
              ? t("agentChatPlaceholderMultimodal")
              : t("agentChatPlaceholder")
          }
          ref={composerRef}
          rows={1}
          spellCheck={false}
          value={input}
        />
        {running ? (
          <Tooltip content={t("agentChatStop")} side="top">
            <button
              aria-label={t("agentChatStop")}
              className="icon-button agent-chat-send is-stop"
              onClick={onCancel}
              type="button"
            >
              <Square size={14} />
            </button>
          </Tooltip>
        ) : (
          <Tooltip content={sendTooltip} side="top">
            <button
              aria-label={t("agentChatSend")}
              className="icon-button agent-chat-send"
              disabled={!canSend}
              onClick={onSend}
              type="button"
            >
              <Send size={14} />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
