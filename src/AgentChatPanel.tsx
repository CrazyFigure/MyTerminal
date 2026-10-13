import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from 'react';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import {
  History,
  Image as ImageIcon,
  Lock,
  Paperclip,
  Plus,
  SlidersHorizontal,
} from 'lucide-react';

import { CustomSelect } from './CustomSelect';
import { backend } from './backend';
import { readClipboardAttachment } from './clipboard';
import { Tooltip } from './components/Tooltip';
import { AgentImagePreview } from './features/agent/AgentChatAttachments';
import { AgentChatComposer } from './features/agent/AgentChatComposer';
import { AgentChatHistory } from './features/agent/AgentChatHistory';
import { AgentChatMessages } from './features/agent/AgentChatMessages';
import { AgentChatOptions } from './features/agent/AgentChatOptions';
import { FloatingToast } from './shared/ui/FloatingToast';
import {
  AgentAttachmentError,
  MAX_ATTACHMENTS,
  attachmentFromBlob,
  attachmentFromLocalFile,
  attachmentFromPastedText,
  buildAttachmentDialogFilters,
  isImageFileName,
} from './features/agent/attachments';
import {
  MAX_CONVERSATIONS,
  buildContinuedConversation,
  buildWireHistory,
  deriveTitle,
  hasOwnMessages,
  newId,
  resolveConversationBinding,
  withSyncedLegacy,
  type AgentChatEvent,
  type AgentConversation,
} from './features/agent/chatModel';
import { resolveAgentChatMessageParts } from './features/agent/chatPresentation';
import type { TranslationKey } from './i18n';
import type {
  AgentChatAttachment,
  AgentChatMessage,
  AgentChatPart,
  AgentChatToolCall,
  AgentBridgeRequest,
  AgentProvider,
  AgentRunOptions,
  StoredAgentConversation,
} from './types';

interface AgentChatPanelProps {
  providers: AgentProvider[];
  /** 内置 AI 对话产生的审批；通过 conversationId/toolCallId 精确挂回原工具调用。 */
  approvalRequests: AgentBridgeRequest[];
  onApproveRequest: (request: AgentBridgeRequest) => void;
  onRejectRequest: (request: AgentBridgeRequest) => void;
  /** AI 对话正文字体族；跟随外观设置中的 AI 对话字体，空配置时回落到终端字体。 */
  fontFamily: string;
  fontSize: number;
  /** AI 对话正文行高倍数；用户消息、代码块与输入框按固定系数从该基准派生。 */
  lineHeight: number;
  /** 代码块与工具输出单独使用的终端等宽字体栈，避免比例字体破坏代码对齐。 */
  codeFontFamily: string;
  /** 粘贴超过该字数时折叠为文本块附件，0 表示关闭。 */
  pasteBlockThreshold: number;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
}

// 落盘记录转成界面对话；接续来源等可选字段原样带回。
const fromStoredConversation = (item: StoredAgentConversation): AgentConversation => ({
  id: item.id,
  title: item.title,
  messages: item.messages ?? [],
  updatedAt: item.updatedAt,
  providerId: item.providerId,
  modelId: item.modelId,
  continuedFrom: item.continuedFrom,
});

type ImageAttachment = Extract<AgentChatAttachment, { kind: 'image' }>;

export function AgentChatPanel({
  providers,
  approvalRequests,
  onApproveRequest,
  onRejectRequest,
  fontFamily,
  fontSize,
  lineHeight,
  codeFontFamily,
  pasteBlockThreshold,
  t,
}: AgentChatPanelProps) {
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [input, setInput] = useState('');
  const [conversations, setConversations] = useState<AgentConversation[]>([]);
  const [activeId, setActiveId] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 非错误的提示（如自动压缩），与 error 分开展示，避免用红色吓到用户。
  const [notice, setNotice] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [runOptions, setRunOptions] = useState<AgentRunOptions>({
    effort: 'default',
  });
  // 输入区待发送的附件草稿；与输入文本一样，发送成功后清空。
  const [attachments, setAttachments] = useState<AgentChatAttachment[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState(0);
  const [previewImage, setPreviewImage] = useState<ImageAttachment | null>(null);
  const [dropActive, setDropActive] = useState(false);
  // 已占用的附件名额（已读完 + 读取中）：并发读取时需要同步判断是否超出上限，
  // 由添加、失败、移除、发送四处手动维护，不能用 effect 按 attachments.length 回写，否则会冲掉读取中的预占。
  const attachmentCountRef = useRef(0);
  // 拖拽进入子元素会触发成对的 enter/leave，用计数判断是否真正离开面板。
  const dragDepthRef = useRef(0);
  const activeIdRef = useRef('');
  // 对话列表的同步镜像：发送时要在状态提交前就读到最新历史，只靠 state 会拿到上一帧的值。
  const conversationsRef = useRef<AgentConversation[]>([]);
  // 本地存档必须串行写入；工具调用、结果和完成事件相邻到达时，并发写会让旧快照反覆盖新快照。
  const persistenceQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // 用户手动上翻查看历史时不再自动滚到底，避免流式输出把视图拽走。
  const stickToBottomRef = useRef(true);

  const activeConversation = useMemo(
    () => conversations.find((item) => item.id === activeId),
    [conversations, activeId],
  );
  // 已与模型对话过的会话锁定在原端点与模型上；未绑定时使用用户在下拉里的草稿选择。
  const binding = useMemo(
    () => resolveConversationBinding(activeConversation, providers),
    [activeConversation, providers],
  );
  const effectiveProviderId = binding.locked ? binding.providerId : providerId;
  const effectiveModelId = binding.locked ? binding.modelId : modelId;
  // 绑定的端点或模型已被删除：这条对话无法再继续，只能通过会话 ID 接续到新对话。
  const bindingUnavailable = binding.locked && (!binding.provider || !binding.model);
  const draftProvider = useMemo(
    () => providers.find((item) => item.id === providerId),
    [providers, providerId],
  );
  const activeProvider = useMemo(
    () => providers.find((item) => item.id === effectiveProviderId),
    [providers, effectiveProviderId],
  );
  const activeModel = activeProvider?.models.find((item) => item.id === effectiveModelId);
  const multimodal = Boolean(activeModel?.multimodal);
  const multimodalRef = useRef(multimodal);
  const messages = useMemo(() => activeConversation?.messages ?? [], [activeConversation]);

  useEffect(() => {
    multimodalRef.current = multimodal;
  }, [multimodal]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  // 状态每次提交后回写镜像，保证流式更新过的消息也能被下一轮发送读到。
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  // 端点列表变化后修正选择：首次加载自动选第一个可用端点，被删除时回退。
  useEffect(() => {
    if (!providers.length) {
      setProviderId('');
      setModelId('');
      return;
    }
    if (!providers.some((item) => item.id === providerId)) {
      const first = providers[0];
      setProviderId(first.id);
      setModelId(first.models[0]?.id ?? '');
    }
  }, [providers, providerId]);

  // 只修正草稿选择；已绑定对话的端点/模型由会话记录决定，不随下拉变化。
  useEffect(() => {
    if (!draftProvider) {
      return;
    }
    if (!draftProvider.models.some((item) => item.id === modelId)) {
      setModelId(draftProvider.models[0]?.id ?? '');
    }
  }, [draftProvider, modelId]);

  // 启动时从本地加载历史对话；无论有没有历史，默认都停在一条新会话上，
  // 历史对话留给历史列表按需打开。空的新会话不落盘、不进历史列表。
  // 对话是用户的工作记录，必须跨重启保留，不能只活在内存里。
  useEffect(() => {
    let cancelled = false;
    void backend
      .listAgentConversations()
      .then((stored) => {
        if (cancelled) {
          return;
        }
        if (stored.length) {
          const loaded: AgentConversation[] = stored.map(fromStoredConversation);
          conversationsRef.current = loaded;
          setConversations(loaded);
        }
        // 新打开软件时点开侧栏看到的是一条干净的新会话，而不是上次留下的对话。
        startNewConversation();
      })
      .catch(() => {
        // 读取失败（如非 Tauri 环境）时退化为纯内存对话，不阻塞使用。
        startNewConversation();
      });
    return () => {
      cancelled = true;
    };
    // 只在挂载时执行一次：startNewConversation 依赖 t，但语言切换不应重新加载历史。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 仅在用户本就贴着底部时才自动滚动，尊重用户正在回看的位置。
  useEffect(() => {
    const body = bodyRef.current;
    if (body && stickToBottomRef.current) {
      body.scrollTop = body.scrollHeight;
    }
  }, [messages]);

  /** 把一条对话写回本地。空对话不落盘，避免历史里堆满没说过话的占位；
   *  刚接续还没发过言的对话同理，否则历史里会多出一条与来源一模一样的副本。 */
  const persistConversation = useCallback((conversationId: string) => {
    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    if (!conversation || !hasOwnMessages(conversation)) {
      return;
    }
    // 每次排队时冻结当前不可变快照，确保稍后执行的任务不会意外读取到另一帧状态。
    const snapshot = {
      id: conversation.id,
      title: conversation.title,
      updatedAt: conversation.updatedAt,
      providerId: conversation.providerId ?? '',
      modelId: conversation.modelId ?? '',
      messages: conversation.messages,
      continuedFrom: conversation.continuedFrom,
    };
    persistenceQueueRef.current = persistenceQueueRef.current
      .catch(() => undefined)
      .then(() => backend.saveAgentConversation(snapshot));
    void persistenceQueueRef.current.catch(() => {
      // 落盘失败不影响当前会话继续用，下一次快照仍会接在队列后重试写入。
    });
  }, []);

  const patchConversation = useCallback((
    conversationId: string,
    updater: (messages: AgentChatMessage[]) => AgentChatMessage[],
  ) => {
    // 后端事件可能在用户查看另一条历史对话时到达，必须按事件自带 ID 更新原对话，
    // 不能再依赖当前页签或 activeId；同时先更新镜像，紧随其后的持久化才能拿到完整快照。
    const next = conversationsRef.current.map((item) =>
      item.id === conversationId
        ? { ...item, messages: updater(item.messages), updatedAt: Date.now() }
        : item,
    );
    conversationsRef.current = next;
    setConversations(next);
  }, []);

  const applyEvent = useCallback(
    (payload: AgentChatEvent) => {
      if (payload.type === 'textDelta' || payload.type === 'toolCall' || payload.type === 'toolResult') {
        patchConversation(payload.conversationId, (current) => {
          const next = [...current];
          // 同一轮里的文本增量与工具调用都并入最后一条助手消息。
          let index = -1;
          for (let i = next.length - 1; i >= 0; i -= 1) {
            if (next[i].role === 'assistant') {
              index = i;
              break;
            }
          }
          if (index < 0) {
            next.push({ id: newId(), role: 'assistant', content: '', toolCalls: [], parts: [] });
            index = next.length - 1;
          }

          switch (payload.type) {
            case 'textDelta': {
              // 文本增量并入最后一个文本片段；若上一片段是工具调用，则新开一段，
              // 这样「工具之后的总结」会排在工具卡片后面，而不是被拼到最前面。
              const parts = [...(next[index].parts ?? resolveAgentChatMessageParts(next[index]))];
              const lastPart = parts[parts.length - 1];
              if (lastPart && lastPart.type === 'text') {
                parts[parts.length - 1] = { type: 'text', text: lastPart.text + payload.text };
              } else {
                parts.push({ type: 'text', text: payload.text });
              }
              next[index] = withSyncedLegacy({ ...next[index], parts });
              break;
            }
            case 'toolCall': {
              const call: AgentChatToolCall = {
                id: payload.id,
                name: payload.name,
                arguments: payload.arguments,
              };
              const toolPart: AgentChatPart = { type: 'tool', call };
              const parts = [...(next[index].parts ?? resolveAgentChatMessageParts(next[index])), toolPart];
              next[index] = withSyncedLegacy({ ...next[index], parts });
              break;
            }
            case 'toolResult': {
              const parts = (next[index].parts ?? resolveAgentChatMessageParts(next[index])).map((part) =>
                part.type === 'tool' && part.call.id === payload.id
                  ? { type: 'tool' as const, call: { ...part.call, result: payload.content, isError: payload.isError } }
                  : part,
              );
              next[index] = withSyncedLegacy({ ...next[index], parts });
              break;
            }
            default:
              break;
          }
          return next;
        });
      }

      if (payload.type === 'toolCall' || payload.type === 'toolResult') {
        // 审批等待可能持续很久，工具调用一出现、工具结果一返回就立即落盘；
        // 即使应用随后退出，也不能把这两类关键工作记录回退到发送前。
        persistConversation(payload.conversationId);
      }

      if (payload.type === 'completed') {
        setRunning(false);
        // 一轮结束就落盘：此时消息与工具结果都已写入镜像，是最完整的快照。
        persistConversation(payload.conversationId);
      }
      if (payload.type === 'compacted') {
        // 压缩是"模型看到的历史被折叠"，界面消息不动，只提示一次让用户心里有数。
        setNotice(t('agentChatCompacted', { count: payload.droppedMessages }));
      }
      if (payload.type === 'failed') {
        setRunning(false);
        setError(payload.message);
        // 必须移除空的助手占位：否则它会一直渲染成"思考中"，
        // 用户看到红色报错的同时下面还转着圈，完全不知道到底结束没有。
        patchConversation(payload.conversationId, (current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (last && last.role === 'assistant' && !last.content && !last.toolCalls.length) {
            next.pop();
          }
          return next;
        });
        // 失败也要保存：用户的提问和已完成的工具调用都是有价值的记录。
        persistConversation(payload.conversationId);
      }
    },
    [patchConversation, persistConversation, t],
  );

  // 订阅后端流式事件；事件始终按 conversationId 回写原对话，切换历史也不会丢增量。
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    let isMounted = true;

    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<AgentChatEvent>('agent-chat-event', (event) => {
          const payload = event.payload;
          if (!payload) {
            return;
          }
          applyEvent(payload);
        }),
      )
      .then((unlisten) => {
        if (isMounted) {
          unlistenFn = unlisten;
        } else {
          unlisten();
        }
      })
      .catch(() => {
        // 非 Tauri 环境没有该事件；对话功能本身也不可用。
      });

    return () => {
      isMounted = false;
      unlistenFn?.();
    };
  }, [applyEvent]);

  const startNewConversation = useCallback(() => {
    // 当前会话还没说过话时直接复用：连续点“新建”不会堆出一串空的占位会话。
    // 刚接续、还没发过言的会话同样复用，但要清掉复制来的历史，回到真正的空白会话。
    const active = conversationsRef.current.find((item) => item.id === activeIdRef.current);
    if (active && !hasOwnMessages(active)) {
      if (active.continuedFrom) {
        conversationsRef.current = conversationsRef.current.map((item) =>
          item.id === active.id
            ? { id: item.id, title: t('agentChatUntitled'), messages: [], updatedAt: Date.now() }
            : item,
        );
        setConversations(conversationsRef.current);
      }
      setActiveId(active.id);
      activeIdRef.current = active.id;
      setError(null);
      setNotice(null);
      setHistoryOpen(false);
      return active.id;
    }
    const conversation: AgentConversation = {
      id: newId(),
      title: t('agentChatUntitled'),
      messages: [],
      updatedAt: Date.now(),
    };
    // 同步写 ref：紧接着调用 handleSend 时状态尚未提交，只有 ref 能立刻读到这条新对话。
    conversationsRef.current = [conversation, ...conversationsRef.current].slice(0, MAX_CONVERSATIONS);
    setConversations(conversationsRef.current);
    setActiveId(conversation.id);
    activeIdRef.current = conversation.id;
    setError(null);
    setHistoryOpen(false);
    return conversation.id;
  }, [t]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (
      (!text && !attachments.length)
      || running
      || pendingAttachments > 0
      || !activeProvider
      || !effectiveModelId
      || bindingUnavailable
    ) {
      return;
    }
    // 纯文本模型收到图片会直接报 400，发送前拦下并说明原因，而不是让用户去读接口报错。
    if (!multimodal && attachments.some((item) => item.kind === 'image')) {
      setError(t('agentAttachImageUnsupported'));
      return;
    }

    setError(null);
    setNotice(null);
    // 没有活动对话时先开一条，保证发送即有归属。
    const conversationId = activeIdRef.current || startNewConversation();
    const userMessage: AgentChatMessage = {
      id: newId(),
      role: 'user',
      content: text,
      toolCalls: [],
      ...(attachments.length ? { attachments } : {}),
    };

    // 历史必须在调用 setConversations 之前算好：
    // updater 是异步执行的（严格模式下还会跑两次），在里面给外部变量赋值拿不到可靠结果，
    // 新建对话尚未进入 state 时更是直接得到空数组，导致请求体缺少 input 而被服务端 400。
    const previous = conversationsRef.current.find((item) => item.id === conversationId);
    const history = [...(previous?.messages ?? []), userMessage];

    // 同步更新镜像后再 setState：紧接着的 persistConversation 要读到最新内容。
    conversationsRef.current = conversationsRef.current.map((item) =>
      item.id === conversationId
        ? {
            ...item,
            title: item.messages.length ? item.title : deriveTitle(history, t('agentChatUntitled')),
            messages: [...history, { id: newId(), role: 'assistant', content: '', toolCalls: [], parts: [] }],
            updatedAt: Date.now(),
            providerId: activeProvider.id,
            modelId: effectiveModelId,
          }
        : item,
    );
    setConversations(conversationsRef.current);

    setInput('');
    setAttachments([]);
    attachmentCountRef.current = 0;
    setRunning(true);
    stickToBottomRef.current = true;
    // 先把用户这句话落盘：即使随后请求失败或应用被关掉，提问本身也不会丢。
    persistConversation(conversationId);

    try {
      await backend.startAgentChat({
        conversationId,
        providerId: activeProvider.id,
        modelId: effectiveModelId,
        // 必须完整回传工具调用与结果：模型要看到自己上一轮做过什么才能接着往下推进，
        // 只传正文会让它每轮都"失忆"，反复重做同一步。
        history: buildWireHistory(history),
        options: runOptions,
      });
    } catch (sendError) {
      setRunning(false);
      setError(sendError instanceof Error ? sendError.message : String(sendError));
      // 后端拒绝（如绑定校验失败）时移除空的助手占位，避免界面一直显示“思考中”。
      patchConversation(conversationId, (current) => {
        const last = current[current.length - 1];
        return last && last.role === 'assistant' && !last.content && !last.toolCalls.length
          ? current.slice(0, -1)
          : current;
      });
    }
  }, [
    activeProvider,
    attachments,
    bindingUnavailable,
    effectiveModelId,
    input,
    multimodal,
    patchConversation,
    pendingAttachments,
    persistConversation,
    runOptions,
    running,
    startNewConversation,
    t,
  ]);

  // 统一的附件读取入口：先按剩余名额截断，再并发读取；单个失败只提示该文件，不影响其它文件。
  const addAttachments = useCallback(
    (tasks: { name: string; image: boolean; load: () => Promise<AgentChatAttachment> }[]) => {
      if (!tasks.length) {
        return;
      }
      // 非多模态模型连读都不读图片，直接说明原因，免得用户以为是文件本身有问题。
      const accepted = tasks.filter((task) => multimodalRef.current || !task.image);
      if (accepted.length < tasks.length) {
        setError(t('agentAttachImageUnsupported'));
      }
      const room = MAX_ATTACHMENTS - attachmentCountRef.current;
      const batch = accepted.slice(0, Math.max(0, room));
      if (accepted.length > batch.length) {
        setError(t('agentAttachLimit', { count: MAX_ATTACHMENTS }));
      }
      if (!batch.length) {
        return;
      }
      // 先占住名额：读取是异步的，连续两次粘贴不能各自以为还有空位而超出上限。
      attachmentCountRef.current += batch.length;
      setPendingAttachments((count) => count + batch.length);
      for (const task of batch) {
        void task
          .load()
          .then((attachment) => setAttachments((current) => [...current, attachment]))
          .catch((loadError: unknown) => {
            attachmentCountRef.current -= 1;
            if (loadError instanceof AgentAttachmentError) {
              setError(t(loadError.code, loadError.replacements));
            } else {
              const reason = loadError instanceof Error ? loadError.message : String(loadError);
              setError(t('agentAttachReadFailed', { name: task.name, reason }));
            }
          })
          .finally(() => setPendingAttachments((count) => count - 1));
      }
    },
    [t],
  );

  // 本地路径（文件对话框、资源管理器复制的文件）交给后端读取，保留 Windows 原始路径给模型引用。
  const addAttachmentPaths = useCallback(
    (paths: string[]) =>
      addAttachments(
        paths.map((path) => ({
          name: path.split(/[\\/]/).pop() || path,
          image: isImageFileName(path),
          load: () => backend.readAgentAttachment(path).then(attachmentFromLocalFile),
        })),
      ),
    [addAttachments],
  );

  // 浏览器侧文件（截图粘贴、拖入）拿不到本地路径，直接在前端读取。
  const addAttachmentFiles = useCallback(
    (files: File[]) =>
      addAttachments(
        files.map((file) => ({
          name: file.name || 'image.png',
          image: file.type.startsWith('image/') || isImageFileName(file.name),
          load: () => attachmentFromBlob(file),
        })),
      ),
    [addAttachments],
  );

  const pickAttachmentFiles = useCallback(() => {
    void openFileDialog({
      directory: false,
      multiple: true,
      title: t('agentAttachDialogTitle'),
      filters: buildAttachmentDialogFilters(multimodalRef.current, {
        supported: t('agentAttachFilterSupported'),
        images: t('agentAttachFilterImages'),
        text: t('agentAttachFilterText'),
        all: t('agentAttachFilterAll'),
      }),
    })
      .then((selected) => {
        const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
        addAttachmentPaths(paths);
      })
      .catch((dialogError: unknown) => {
        setError(dialogError instanceof Error ? dialogError.message : String(dialogError));
      });
  }, [addAttachmentPaths, t]);

  /**
   * 处理没有文本的粘贴：资源管理器复制的文件优先向后端要真实路径（WebView 里的 File 没有路径），
   * 纯截图直接用剪贴板里的图片数据；两者都拿不到时再看后端是否把位图落成了临时 PNG。
   */
  const handlePasteNonText = useCallback(
    (files: File[]) => {
      const onlyImages = files.length > 0 && files.every((file) => file.type.startsWith('image/'));
      if (onlyImages) {
        addAttachmentFiles(files);
        return;
      }
      void readClipboardAttachment().then((system) => {
        if (system?.kind === 'files' && system.paths.length) {
          addAttachmentPaths(system.paths);
        } else if (files.length) {
          addAttachmentFiles(files);
        } else if (system?.kind === 'image') {
          addAttachmentPaths([system.path]);
        }
      });
    },
    [addAttachmentFiles, addAttachmentPaths],
  );

  // 超长粘贴折叠成文本块：名称带行数便于区分多次粘贴，内容原样随消息发送给模型。
  const addPastedText = useCallback(
    (text: string) => {
      const lines = text.split(/\r\n|\r|\n/).length;
      const name = t('agentPastedTextName', { lines });
      addAttachments([{ name, image: false, load: async () => attachmentFromPastedText(text, name) }]);
    },
    [addAttachments, t],
  );

  const removeAttachment = useCallback((attachmentId: string) => {
    setAttachments((current) => current.filter((item) => item.id !== attachmentId));
    attachmentCountRef.current = Math.max(0, attachmentCountRef.current - 1);
  }, []);

  // 拖拽只响应外部文件，内部元素（如文本选区）拖动不显示投放遮罩。
  const isFileDrag = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  const dragHandlers = {
    onDragEnter: (event: DragEvent<HTMLDivElement>) => {
      if (!isFileDrag(event)) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current += 1;
      setDropActive(true);
    },
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (isFileDrag(event)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }
    },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      if (!isFileDrag(event)) {
        return;
      }
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (!dragDepthRef.current) {
        setDropActive(false);
      }
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      if (!isFileDrag(event)) {
        return;
      }
      event.preventDefault();
      dragDepthRef.current = 0;
      setDropActive(false);
      addAttachmentFiles(Array.from(event.dataTransfer.files));
    },
  };

  /**
   * 在新对话中接续（历史右键菜单）：把来源会话的完整历史复制进一条尚未绑定模型的会话，
   * 用户随后用当前选择的模型发言，即实现“换模型继续同一段对话”。
   * 当前会话还没发过言时直接复用，否则新开一条，绝不改写已绑定会话。
   */
  const continueConversation = useCallback(
    (sourceId: string) => {
      if (running) {
        setError(t('agentChatContinueBusy'));
        return;
      }
      // 历史列表只展示内存中有内容的会话，来源必然能在镜像里找到。
      const source = conversationsRef.current.find(
        (item) => item.id === sourceId && hasOwnMessages(item),
      );
      if (!source) {
        return;
      }

      const active = conversationsRef.current.find((item) => item.id === activeIdRef.current);
      const targetId = active && !hasOwnMessages(active) ? active.id : newId();
      const conversation = buildContinuedConversation(source, targetId);
      conversationsRef.current = [
        conversation,
        ...conversationsRef.current.filter((item) => item.id !== targetId),
      ].slice(0, MAX_CONVERSATIONS);
      setConversations(conversationsRef.current);
      setActiveId(targetId);
      activeIdRef.current = targetId;
      setHistoryOpen(false);
      setSettingsOpen(false);
      setError(null);
      setNotice(t('agentChatContinuedNotice', { title: source.title }));
      stickToBottomRef.current = true;
    },
    [running, t],
  );

  const handleCancel = useCallback(() => {
    if (activeIdRef.current) {
      void backend.cancelAgentChat(activeIdRef.current);
    }
  }, []);

  // 切换历史对话时恢复其端点和模型，并重置瞬时反馈；消息滚动在下一轮渲染后重新贴底。
  const selectHistoryConversation = (conversationId: string) => {
    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    if (!conversation) {
      return;
    }
    setActiveId(conversation.id);
    activeIdRef.current = conversation.id;
    if (conversation.providerId && providers.some((provider) => provider.id === conversation.providerId)) {
      setProviderId(conversation.providerId);
      if (conversation.modelId) {
        setModelId(conversation.modelId);
      }
    }
    setHistoryOpen(false);
    setError(null);
    setNotice(null);
    stickToBottomRef.current = true;
  };

  // 删除当前对话时回退到最近一条有内容的记录；没有历史则保留可继续输入的空会话入口。
  const deleteHistoryConversation = (conversationId: string) => {
    const next = conversationsRef.current.filter((entry) => entry.id !== conversationId);
    conversationsRef.current = next;
    setConversations(next);
    if (conversationId === activeIdRef.current) {
      const fallback = next.find((entry) => hasOwnMessages(entry))?.id ?? next[0]?.id ?? '';
      setActiveId(fallback);
      activeIdRef.current = fallback;
    }
    void backend.deleteAgentConversation(conversationId).catch(() => {
      // 本地删除失败不回滚界面；下次启动会重新读到，用户可再次删除。
    });
  };

  // 空的新会话只是输入入口：没说过话就不进历史列表，也不会在落盘时留下占位。
  const historyItems = conversations
    .filter((item) => hasOwnMessages(item))
    .map((item) => ({
      id: item.id,
      title: item.title,
      updatedAt: item.updatedAt,
      continued: Boolean(item.continuedFrom),
      modelId: item.modelId,
    }));

  if (!providers.length) {
    return <div className="empty-state">{t('agentChatNoProvider')}</div>;
  }

  return (
    <div
      className={`agent-chat-panel ${dropActive ? 'is-drop-active' : ''}`}
      // 字体经 CSS 变量下发：正文与输入框跟随 AI 对话字体设置，代码块与工具输出单独使用终端等宽字体栈。
      style={
        {
          '--agent-chat-font': fontFamily,
          '--agent-chat-font-size': `${fontSize}px`,
          // 行高必须是无单位数值，样式表才能用 calc 按系数派生出合法的行高倍数。
          '--agent-chat-line-height': `${lineHeight}`,
          '--agent-chat-code-font': codeFontFamily,
        } as CSSProperties
      }
      {...dragHandlers}
    >
      <div className="agent-chat-toolbar">
        {binding.locked ? (
          // 已对话过的会话把两个下拉收成一枚锁定标签：明确告诉用户这里不能换模型，以及该怎么换。
          <Tooltip
            content={
              <span className="agent-chat-binding-tooltip">
                {bindingUnavailable ? t('agentChatBindingMissing') : t('agentChatBindingLocked')}
              </span>
            }
            side="bottom"
          >
            <div
              aria-label={t('agentChatBindingLabel')}
              className={`agent-chat-binding ${bindingUnavailable ? 'is-missing' : ''}`}
              tabIndex={0}
            >
              <Lock size={12} />
              <span className="agent-chat-binding-provider">
                {binding.provider?.name || binding.providerId}
              </span>
              <span className="agent-chat-binding-model">
                {binding.modelId}
              </span>
              {binding.model?.multimodal ? (
                <ImageIcon aria-label={t('agentModelMultimodal')} className="agent-chat-model-flag" size={12} />
              ) : null}
            </div>
          </Tooltip>
        ) : (
          <>
            <CustomSelect
              aria-label={t('agentChatProvider')}
              className="agent-chat-select"
              disabled={running}
              onChange={(value) => setProviderId(value)}
              options={providers.map((item) => ({ value: item.id, label: item.name || item.id }))}
              value={providerId}
            />
            <CustomSelect
              aria-label={t('agentChatModel')}
              className="agent-chat-select"
              disabled={running}
              onChange={(value) => setModelId(value)}
              options={(draftProvider?.models ?? []).map((item) => ({
                value: item.id,
                // 多模态模型在名称后带图片标记，选择时就能看出能否发图。
                label: (
                  <span className="agent-chat-model-option">
                    <span>{item.id}</span>
                    {item.multimodal ? (
                      <ImageIcon aria-label={t('agentModelMultimodal')} className="agent-chat-model-flag" size={12} />
                    ) : null}
                  </span>
                ),
              }))}
              value={modelId}
            />
          </>
        )}
        <Tooltip content={t('agentChatOptions')} side="bottom">
          <button
            aria-label={t('agentChatOptions')}
            className={`icon-button ${settingsOpen ? 'is-active' : ''}`}
            onClick={() => {
              // 两个折叠面板互斥：同时展开会把消息区挤没，且用户很难分辨当前在看哪个。
              setSettingsOpen((current) => !current);
              setHistoryOpen(false);
            }}
            type="button"
          >
            <SlidersHorizontal size={14} />
          </button>
        </Tooltip>
        <Tooltip content={t('agentChatHistory')} side="bottom">
          <button
            aria-label={t('agentChatHistory')}
            className={`icon-button ${historyOpen ? 'is-active' : ''}`}
            onClick={() => {
              setHistoryOpen((current) => !current);
              setSettingsOpen(false);
            }}
            type="button"
          >
            <History size={14} />
          </button>
        </Tooltip>
        <Tooltip content={t('agentChatNew')} side="bottom">
          <button
            aria-label={t('agentChatNew')}
            className="icon-button"
            onClick={startNewConversation}
            type="button"
          >
            <Plus size={14} />
          </button>
        </Tooltip>
      </div>

      {error ? <FloatingToast message={error} onDismiss={() => setError(null)} tone="error" /> : null}

      {settingsOpen ? (
<AgentChatOptions
          onUpdate={setRunOptions}
          runOptions={runOptions}
          t={t}
        />
      ) : null}

      {historyOpen ? (
<AgentChatHistory
          activeId={activeId}
          items={historyItems}
          onContinue={continueConversation}
          onDelete={deleteHistoryConversation}
          onSelect={selectHistoryConversation}
          t={t}
        />
      ) : null}

      {bindingUnavailable ? (
        <div className="agent-chat-notice is-warning">{t('agentChatBindingMissingNotice')}</div>
      ) : activeProvider && !activeProvider.hasApiKey ? (
        <div className="sync-action-feedback is-error">{t('agentChatMissingKey')}</div>
      ) : null}
      {notice ? <div className="agent-chat-notice">{notice}</div> : null}

<AgentChatMessages
        activeConversationId={activeId}
        approvalRequests={approvalRequests}
        bodyRef={bodyRef}
        continuedFrom={activeConversation?.continuedFrom}
        messages={messages}
        onApproveRequest={onApproveRequest}
        onPreviewImage={setPreviewImage}
        onRejectRequest={onRejectRequest}
        onStickToBottomChange={(stuck) => {
          stickToBottomRef.current = stuck;
        }}
        t={t}
      />

      <AgentChatComposer
        attachments={attachments}
        input={input}
        multimodal={multimodal}
        onCancel={handleCancel}
        onInputChange={setInput}
        onPasteLongText={addPastedText}
        onPasteNonText={handlePasteNonText}
        pasteBlockThreshold={pasteBlockThreshold}
        onPickFiles={pickAttachmentFiles}
        onPreviewImage={setPreviewImage}
        onRemoveAttachment={removeAttachment}
        onSend={() => void handleSend()}
        pendingCount={pendingAttachments}
        running={running}
        sendBlocked={bindingUnavailable || !activeProvider || !effectiveModelId}
        t={t}
      />

      {/* 拖入文件时覆盖整个对话面板的投放提示，按当前模型能力说明可接受的文件类型。 */}
      {dropActive ? (
        <div className="agent-chat-drop-overlay">
          <Paperclip size={22} />
          <strong>{t('agentAttachDropTitle')}</strong>
          <small>{multimodal ? t('agentAttachDropHintMultimodal') : t('agentAttachDropHintText')}</small>
        </div>
      ) : null}

      {previewImage ? (
        <AgentImagePreview attachment={previewImage} onClose={() => setPreviewImage(null)} t={t} />
      ) : null}
    </div>
  );
}
