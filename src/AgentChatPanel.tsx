import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Bot,
  ChevronDown,
  ChevronRight,
  History,
  Plus,
  Send,
  SlidersHorizontal,
  Square,
  Terminal as TerminalIcon,
  Trash2,
  User,
} from 'lucide-react';

import { CustomSelect } from './CustomSelect';
import { MarkdownView } from './MarkdownView';
import { backend } from './backend';
import type { TranslationKey } from './i18n';
import type {
  AgentChatMessage,
  AgentChatPart,
  AgentChatToolCall,
  AgentEffort,
  AgentProvider,
  AgentRunOptions,
} from './types';

/** 后端 agent-chat-event 事件负载。 */
type AgentChatEvent =
  | { type: 'textDelta'; conversationId: string; text: string }
  | { type: 'toolCall'; conversationId: string; id: string; name: string; arguments: unknown }
  | { type: 'toolResult'; conversationId: string; id: string; name: string; content: string; isError: boolean }
  | { type: 'completed'; conversationId: string; stopReason: string }
  | { type: 'compacted'; conversationId: string; droppedMessages: number }
  | { type: 'failed'; conversationId: string; message: string };

/** 一段可切换的历史对话。 */
interface AgentConversation {
  id: string;
  /** 标题取首条用户消息，方便在历史列表里辨认。 */
  title: string;
  messages: AgentChatMessage[];
  updatedAt: number;
  /** 记住该对话用的端点与模型，重新打开时恢复选择。 */
  providerId?: string;
  modelId?: string;
}

interface AgentChatPanelProps {
  providers: AgentProvider[];
  /** 与终端一致的字体族；代码块和正文都用它，保证中英文对齐与用户偏好一致。 */
  fontFamily: string;
  fontSize: number;
  t: (key: TranslationKey, replacements?: Record<string, string | number>) => string;
}

const newId = () => crypto.randomUUID();
/** 历史对话只保留最近若干条，避免无限占用内存。 */
const MAX_CONVERSATIONS = 30;
/** 输入框自适应高度的上下限，兼顾单行简短指令与多行任务描述。 */
const COMPOSER_MIN_HEIGHT = 38;
const COMPOSER_MAX_HEIGHT = 180;

const previewText = (value: string, max = 4000) =>
  value.length > max ? `${value.slice(0, max)}…` : value;

/** 取出消息的有序展示片段；旧存档没有 parts 时按「正文在前、工具在后」兜底，保持向下兼容。 */
const messageParts = (message: AgentChatMessage): AgentChatPart[] => {
  if (message.parts && message.parts.length) {
    return message.parts;
  }
  const parts: AgentChatPart[] = [];
  if (message.content) {
    parts.push({ type: 'text', text: message.content });
  }
  for (const call of message.toolCalls) {
    parts.push({ type: 'tool', call });
  }
  return parts;
};

/** 由有序片段反推 content / toolCalls，使后端投影与持久化字段始终和 parts 同步。 */
const withSyncedLegacy = (message: AgentChatMessage): AgentChatMessage => {
  const parts = message.parts ?? [];
  let content = '';
  const toolCalls: AgentChatToolCall[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      content += part.text;
    } else {
      toolCalls.push(part.call);
    }
  }
  return { ...message, content, toolCalls };
};

/** 传给后端的一条消息；与 Rust 侧 ChatMessage 形状一致。 */
interface WireMessage {
  role: string;
  content: string;
  toolCalls: { id: string; name: string; arguments: unknown }[];
  toolResults: { toolCallId: string; name: string; content: string; isError: boolean }[];
}

/**
 * 把界面上的消息列表转成协议要求的形状。
 *
 * 界面为了展示方便，把工具调用和它的结果都挂在助手消息下；
 * 但三种协议都要求「助手回合发起调用 → 紧随其后的用户回合回传结果」，
 * 所以这里要把结果拆出来单独成一条用户消息，否则模型看不到工具到底返回了什么。
 */
const buildWireHistory = (messages: AgentChatMessage[]): WireMessage[] => {
  const wire: WireMessage[] = [];
  for (const message of messages) {
    const hasContent = message.content.trim().length > 0;
    // 既无正文也无工具调用的空占位（上一轮失败留下的）必须丢弃，否则 API 会因空块报错。
    if (hasContent || message.toolCalls.length) {
      wire.push({
        role: message.role,
        content: message.content,
        toolCalls: message.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
        toolResults: [],
      });
    }

    const finished = message.toolCalls.filter((call) => call.result !== undefined);
    if (finished.length) {
      wire.push({
        role: 'user',
        content: '',
        toolCalls: [],
        toolResults: finished.map((call) => ({
          toolCallId: call.id,
          name: call.name,
          content: call.result ?? '',
          isError: Boolean(call.isError),
        })),
      });
    }
  }
  return wire;
};

/** 用首条用户消息生成标题；空对话给占位名。 */
const deriveTitle = (messages: AgentChatMessage[], fallback: string) => {
  const first = messages.find((item) => item.role === 'user' && item.content.trim());
  if (!first) {
    return fallback;
  }
  const line = first.content.trim().split('\n')[0];
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
};

export function AgentChatPanel({ providers, fontFamily, fontSize, t }: AgentChatPanelProps) {
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
    compactThreshold: 0.75,
    autoCompact: true,
  });
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const activeIdRef = useRef('');
  // 对话列表的同步镜像：发送时要在状态提交前就读到最新历史，只靠 state 会拿到上一帧的值。
  const conversationsRef = useRef<AgentConversation[]>([]);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // 用户手动上翻查看历史时不再自动滚到底，避免流式输出把视图拽走。
  const stickToBottomRef = useRef(true);

  const activeProvider = useMemo(
    () => providers.find((item) => item.id === providerId),
    [providers, providerId],
  );
  const messages = useMemo(
    () => conversations.find((item) => item.id === activeId)?.messages ?? [],
    [conversations, activeId],
  );

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

  useEffect(() => {
    if (!activeProvider) {
      return;
    }
    if (!activeProvider.models.some((item) => item.id === modelId)) {
      setModelId(activeProvider.models[0]?.id ?? '');
    }
  }, [activeProvider, modelId]);

  // 启动时从本地加载历史对话；没有历史才建一条空的。
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
          const loaded: AgentConversation[] = stored.map((item) => ({
            id: item.id,
            title: item.title,
            messages: item.messages ?? [],
            updatedAt: item.updatedAt,
            providerId: item.providerId,
            modelId: item.modelId,
          }));
          conversationsRef.current = loaded;
          setConversations(loaded);
          setActiveId(loaded[0].id);
          activeIdRef.current = loaded[0].id;
          return;
        }
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
    node.style.height = 'auto';
    node.style.height = `${Math.min(Math.max(node.scrollHeight, COMPOSER_MIN_HEIGHT), COMPOSER_MAX_HEIGHT)}px`;
    if (document.activeElement === node) {
      node.setSelectionRange(start, end);
    }
  }, [input]);

  /** 把一条对话写回本地。空对话不落盘，避免历史里堆满没说过话的占位。 */
  const persistConversation = useCallback((conversationId: string) => {
    const conversation = conversationsRef.current.find((item) => item.id === conversationId);
    if (!conversation || !conversation.messages.length) {
      return;
    }
    void backend
      .saveAgentConversation({
        id: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
        providerId: conversation.providerId ?? '',
        modelId: conversation.modelId ?? '',
        messages: conversation.messages,
      })
      .catch(() => {
        // 落盘失败不影响当前会话继续用，下一轮结束时会再试。
      });
  }, []);

  const patchActive = useCallback((updater: (messages: AgentChatMessage[]) => AgentChatMessage[]) => {
    setConversations((current) => {
      const next = current.map((item) =>
        item.id === activeIdRef.current
          ? { ...item, messages: updater(item.messages), updatedAt: Date.now() }
          : item,
      );
      // 立刻同步镜像：工具结果是流式写入的，下一轮发送必须能读到它们，
      // 否则模型看不到工具返回了什么，会重复调用同一个工具。
      conversationsRef.current = next;
      return next;
    });
  }, []);

  const applyEvent = useCallback(
    (payload: AgentChatEvent) => {
      patchActive((current) => {
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
            const parts = [...(next[index].parts ?? messageParts(next[index]))];
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
            const parts = [...(next[index].parts ?? messageParts(next[index])), toolPart];
            next[index] = withSyncedLegacy({ ...next[index], parts });
            break;
          }
          case 'toolResult': {
            const parts = (next[index].parts ?? messageParts(next[index])).map((part) =>
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
        patchActive((current) => {
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
    [patchActive, persistConversation, t],
  );

  // 订阅后端流式事件；只处理当前对话，避免旧对话的迟到事件污染界面。
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    let isMounted = true;

    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<AgentChatEvent>('agent-chat-event', (event) => {
          const payload = event.payload;
          if (!payload || payload.conversationId !== activeIdRef.current) {
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
    if (!text || running || !activeProvider || !modelId) {
      return;
    }

    setError(null);
    setNotice(null);
    // 没有活动对话时先开一条，保证发送即有归属。
    const conversationId = activeIdRef.current || startNewConversation();
    const userMessage: AgentChatMessage = { id: newId(), role: 'user', content: text, toolCalls: [] };

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
            modelId,
          }
        : item,
    );
    setConversations(conversationsRef.current);

    setInput('');
    setRunning(true);
    stickToBottomRef.current = true;
    // 先把用户这句话落盘：即使随后请求失败或应用被关掉，提问本身也不会丢。
    persistConversation(conversationId);

    try {
      await backend.startAgentChat({
        conversationId,
        providerId: activeProvider.id,
        modelId,
        // 必须完整回传工具调用与结果：模型要看到自己上一轮做过什么才能接着往下推进，
        // 只传正文会让它每轮都"失忆"，反复重做同一步。
        history: buildWireHistory(history),
        options: runOptions,
      });
    } catch (sendError) {
      setRunning(false);
      setError(sendError instanceof Error ? sendError.message : String(sendError));
    }
  }, [activeProvider, input, modelId, running, startNewConversation, t]);

  const handleCancel = useCallback(() => {
    if (activeIdRef.current) {
      void backend.cancelAgentChat(activeIdRef.current);
    }
  }, []);

  if (!providers.length) {
    return <div className="empty-state">{t('agentChatNoProvider')}</div>;
  }

  return (
    <div
      className="agent-chat-panel"
      // 字体经 CSS 变量下发：消息正文、代码块与输入框统一跟随用户在设置里选的终端字体。
      style={
        {
          '--agent-chat-font': fontFamily,
          '--agent-chat-font-size': `${fontSize}px`,
        } as CSSProperties
      }
    >
      <div className="agent-chat-toolbar">
        <CustomSelect
          aria-label={t('agentChatProvider')}
          className="agent-chat-select"
          onChange={(value) => setProviderId(value)}
          options={providers.map((item) => ({ value: item.id, label: item.name || item.id }))}
          value={providerId}
        />
        <CustomSelect
          aria-label={t('agentChatModel')}
          className="agent-chat-select"
          onChange={(value) => setModelId(value)}
          options={(activeProvider?.models ?? []).map((item) => ({
            value: item.id,
            label: item.name || item.id,
          }))}
          value={modelId}
        />
        <button
          className={`icon-button ${settingsOpen ? 'is-active' : ''}`}
          onClick={() => {
            // 两个折叠面板互斥：同时展开会把消息区挤没，且用户很难分辨当前在看哪个。
            setSettingsOpen((current) => !current);
            setHistoryOpen(false);
          }}
          title={t('agentChatOptions')}
          type="button"
        >
          <SlidersHorizontal size={14} />
        </button>
        <button
          className={`icon-button ${historyOpen ? 'is-active' : ''}`}
          onClick={() => {
            setHistoryOpen((current) => !current);
            setSettingsOpen(false);
          }}
          title={t('agentChatHistory')}
          type="button"
        >
          <History size={14} />
        </button>
        <button
          className="icon-button"
          onClick={startNewConversation}
          title={t('agentChatNew')}
          type="button"
        >
          <Plus size={14} />
        </button>
      </div>

      {settingsOpen ? (
        <div className="agent-chat-options">
          <label>
            <span>{t('agentChatEffort')}</span>
            <CustomSelect
              aria-label={t('agentChatEffort')}
              onChange={(value) =>
                setRunOptions((current) => ({ ...current, effort: value as AgentEffort }))
              }
              options={[
                { value: 'default', label: t('agentChatEffortDefault') },
                { value: 'low', label: 'low' },
                { value: 'medium', label: 'medium' },
                { value: 'high', label: 'high' },
                { value: 'xhigh', label: 'xhigh' },
                { value: 'max', label: 'max' },
              ]}
              value={runOptions.effort}
            />
          </label>
          <label className="agent-chat-option-inline">
            <input
              checked={runOptions.autoCompact}
              onChange={(event) =>
                setRunOptions((current) => ({ ...current, autoCompact: event.target.checked }))
              }
              type="checkbox"
            />
            <span title={t('agentChatAutoCompactDesc')}>{t('agentChatAutoCompact')}</span>
          </label>
          {runOptions.autoCompact ? (
            <label>
              <span>
                {t('agentChatCompactThreshold')}（{Math.round(runOptions.compactThreshold * 100)}%）
              </span>
              <input
                max={95}
                min={30}
                onChange={(event) =>
                  setRunOptions((current) => ({
                    ...current,
                    compactThreshold: Number(event.target.value) / 100,
                  }))
                }
                step={5}
                type="range"
                value={Math.round(runOptions.compactThreshold * 100)}
              />
            </label>
          ) : null}
          <p className="agent-chat-option-hint">
            {t('agentChatContextHint', {
              window: activeProvider?.models.find((item) => item.id === modelId)?.contextWindow ?? 0,
            })}
          </p>
        </div>
      ) : null}

      {historyOpen ? (
        <div className="agent-chat-history">
          {conversations.length ? (
            conversations.map((item) => (
              <div
                key={item.id}
                className={`agent-chat-history-item ${item.id === activeId ? 'is-active' : ''}`}
              >
                <button
                  onClick={() => {
                    setActiveId(item.id);
                    activeIdRef.current = item.id;
                    // 恢复该对话当时用的端点与模型，避免接着用别的模型继续聊。
                    if (item.providerId && providers.some((p) => p.id === item.providerId)) {
                      setProviderId(item.providerId);
                      if (item.modelId) {
                        setModelId(item.modelId);
                      }
                    }
                    setHistoryOpen(false);
                    setError(null);
                    setNotice(null);
                    stickToBottomRef.current = true;
                  }}
                  type="button"
                >
                  <span>{item.title}</span>
                  <small>{new Date(item.updatedAt).toLocaleString()}</small>
                </button>
                <button
                  className="icon-button"
                  onClick={() => {
                    const next = conversationsRef.current.filter((entry) => entry.id !== item.id);
                    conversationsRef.current = next;
                    setConversations(next);
                    // 删掉当前对话时自动切到最近一条，避免面板空白无从操作。
                    if (item.id === activeIdRef.current) {
                      const fallback = next[0]?.id ?? '';
                      setActiveId(fallback);
                      activeIdRef.current = fallback;
                    }
                    void backend.deleteAgentConversation(item.id).catch(() => {
                      // 本地删除失败不回滚界面；下次启动会重新读到，用户可再删一次。
                    });
                  }}
                  title={t('agentChatDelete')}
                  type="button"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          ) : (
            <div className="empty-state">{t('agentChatHistoryEmpty')}</div>
          )}
        </div>
      ) : null}

      {activeProvider && !activeProvider.hasApiKey ? (
        <div className="sync-action-feedback is-error">{t('agentChatMissingKey')}</div>
      ) : null}
      {notice ? <div className="agent-chat-notice">{notice}</div> : null}
      {error ? <div className="sync-action-feedback is-error">{error}</div> : null}

      <div
        className="agent-chat-body"
        onScroll={(event) => {
          const node = event.currentTarget;
          // 距底部 40px 内视为“贴底”，用户上翻后停止自动滚动。
          stickToBottomRef.current =
            node.scrollHeight - node.scrollTop - node.clientHeight < 40;
        }}
        ref={bodyRef}
      >
        {messages.length ? (
          messages.map((message) => (
            <div key={message.id} className={`agent-chat-message is-${message.role}`}>
              <div className="agent-chat-message-role">
                {message.role === 'user' ? <User size={13} /> : <Bot size={13} />}
              </div>
              <div className="agent-chat-message-body">
                {message.role === 'user' ? (
                  // 用户输入保持纯文本原样展示，不按 Markdown 解析。
                  message.content ? <p className="agent-chat-user-text">{message.content}</p> : null
                ) : (
                  <>
                    {/* 助手回复按到达顺序渲染：文本段与工具段交替，保证「先工具、后总结」与真实执行一致。 */}
                    {messageParts(message).map((part, partIndex) => {
                      if (part.type === 'text') {
                        return part.text ? <MarkdownView key={partIndex} source={part.text} /> : null;
                      }
                      const call = part.call;
                      const expanded = expandedTools[call.id] ?? false;
                      return (
                        <div key={partIndex} className={`agent-chat-tool ${call.isError ? 'is-error' : ''}`}>
                          <button
                            aria-expanded={expanded}
                            className="agent-chat-tool-header"
                            onClick={() =>
                              setExpandedTools((current) => ({ ...current, [call.id]: !expanded }))
                            }
                            type="button"
                          >
                            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            <TerminalIcon size={13} />
                            <strong>{call.name}</strong>
                            <span>
                              {call.result === undefined
                                ? t('agentChatToolRunning')
                                : call.isError
                                  ? t('agentChatToolFailed')
                                  : t('agentChatToolDone')}
                            </span>
                          </button>
                          {expanded ? (
                            <>
                              <pre className="agent-chat-tool-payload">
                                {previewText(JSON.stringify(call.arguments, null, 2))}
                              </pre>
                              {call.result !== undefined ? (
                                <pre className="agent-chat-tool-payload">{previewText(call.result)}</pre>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      );
                    })}
                    {!message.content && !message.toolCalls.length ? (
                      <p className="agent-chat-thinking">{t('agentChatThinking')}</p>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          ))
        ) : (
          <div className="empty-state">{t('agentChatEmpty')}</div>
        )}
      </div>

      <div className="agent-chat-composer">
        <textarea
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            // Enter 发送、Shift+Enter 换行，与常见聊天界面一致。
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
          placeholder={t('agentChatPlaceholder')}
          ref={composerRef}
          rows={1}
          spellCheck={false}
          value={input}
        />
        {running ? (
          <button
            className="icon-button agent-chat-send is-stop"
            onClick={handleCancel}
            title={t('agentChatStop')}
            type="button"
          >
            <Square size={14} />
          </button>
        ) : (
          <button
            className="icon-button agent-chat-send"
            disabled={!input.trim() || !modelId}
            onClick={() => void handleSend()}
            title={t('agentChatSend')}
            type="button"
          >
            <Send size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
