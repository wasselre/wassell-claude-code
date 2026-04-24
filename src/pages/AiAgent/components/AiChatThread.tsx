import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { Send, Loader2, Sparkles, Search, FileSearch, UserPlus } from 'lucide-react';
import type { AppRecord } from '@/types';
import { streamAgentTurn, type AgentApiMessage } from '@/lib/aiAgent/client';

interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface Props {
  recordId: string;
  modelId: string;
}

/**
 * Active chat thread: renders prior messages, lets the user send a new
 * message, streams the agent's reply into the transcript, and persists
 * the turn back to the ai_chats record on completion.
 */
export default function AiChatThread({ recordId, modelId }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const recordsByModel = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);

  const record = useMemo<AppRecord | undefined>(() => {
    return (recordsByModel[modelId] ?? []).find((r) => r.id === recordId);
  }, [recordsByModel, modelId, recordId]);

  const storedMessages = useMemo<StoredMessage[]>(() => {
    const raw = record?.data.messages;
    return Array.isArray(raw) ? (raw as StoredMessage[]) : [];
  }, [record]);

  const [input, setInput] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [storedMessages, streamingText, activeTool]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || sending || !record) return;

    setInput('');
    setError(null);
    setStreamingText('');
    setActiveTool(null);
    setSending(true);

    const now = new Date().toISOString();
    const userMessage: StoredMessage = { role: 'user', content: trimmed, timestamp: now };
    const withUser: StoredMessage[] = [...storedMessages, userMessage];

    // Persist the user message right away so it survives a page reload mid-stream.
    const firstUserMessage = storedMessages.length === 0;
    const titleFromFirst = firstUserMessage
      ? trimmed.slice(0, 60)
      : (record.data.title as string | undefined);
    saveRecord({
      ...record,
      data: {
        ...record.data,
        messages: withUser,
        message_count: withUser.length,
        last_message_at: now,
        ...(firstUserMessage ? { title: titleFromFirst } : {}),
      },
      updated_at: now,
    });

    const apiMessages: AgentApiMessage[] = withUser.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const controller = new AbortController();
    abortRef.current = controller;

    let assistantText = '';

    try {
      await streamAgentTurn(
        apiMessages,
        (event) => {
          if (event.type === 'text') {
            assistantText += event.delta;
            setStreamingText(assistantText);
          } else if (event.type === 'tool_use') {
            setActiveTool(event.name);
          } else if (event.type === 'tool_result') {
            setActiveTool(null);
          } else if (event.type === 'error') {
            setError(event.message);
          }
        },
        controller.signal,
      );

      if (assistantText.trim()) {
        const done = new Date().toISOString();
        const assistantMessage: StoredMessage = {
          role: 'assistant',
          content: assistantText,
          timestamp: done,
        };
        const finalMessages = [...withUser, assistantMessage];
        saveRecord({
          ...record,
          data: {
            ...record.data,
            messages: finalMessages,
            message_count: finalMessages.length,
            last_message_at: done,
            ...(firstUserMessage ? { title: titleFromFirst } : {}),
          },
          updated_at: done,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== 'The user aborted a request.') setError(msg);
    } finally {
      setStreamingText('');
      setActiveTool(null);
      setSending(false);
      abortRef.current = null;
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  if (!record) {
    return (
      <div className="flex-1 flex items-center justify-center text-text/60">
        {isAr ? 'المحادثة غير موجودة' : 'Conversation not found'}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="p-3 border-b border-sand/20 flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
          <Sparkles size={16} className="text-primary" />
        </div>
        <div className="min-w-0">
          <div className="font-medium text-sm truncate">
            {(record.data.title as string | undefined) ??
              (isAr ? 'محادثة' : 'Conversation')}
          </div>
          <div className="text-xs text-text/60">
            {isAr ? 'مساعد وصل العقارية' : 'Wassel AI Assistant'}
          </div>
        </div>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {storedMessages.length === 0 && !streamingText && (
          <WelcomeHint isAr={isAr} />
        )}
        {storedMessages.map((m, i) => (
          <Bubble key={i} role={m.role} content={m.content} />
        ))}
        {activeTool && <ToolBadge name={activeTool} isAr={isAr} />}
        {streamingText && <Bubble role="assistant" content={streamingText} typing />}
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm p-3">
            {error}
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-sand/20 p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending}
            rows={2}
            placeholder={isAr ? 'اكتب رسالتك...' : 'Type your message...'}
            className="flex-1 resize-none rounded-lg border border-sand/40 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none px-3 py-2 text-sm bg-white disabled:bg-background"
          />
          <button
            onClick={() => void handleSend()}
            disabled={sending || !input.trim()}
            className="p-3 rounded-lg bg-primary text-white hover:bg-secondary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            aria-label={isAr ? 'إرسال' : 'Send'}
          >
            {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
          </button>
        </div>
      </div>
    </div>
  );
}

function Bubble({
  role,
  content,
  typing,
}: {
  role: 'user' | 'assistant';
  content: string;
  typing?: boolean;
}) {
  const isUser = role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap ${
          isUser
            ? 'bg-primary text-white rounded-ee-sm'
            : 'bg-background text-text rounded-es-sm'
        }`}
      >
        {content}
        {typing && <span className="inline-block w-2 h-4 bg-current opacity-50 animate-pulse ms-1" />}
      </div>
    </div>
  );
}

function ToolBadge({ name, isAr }: { name: string; isAr: boolean }) {
  const Icon =
    name === 'search_projects' ? Search : name === 'get_project' ? FileSearch : UserPlus;
  const label =
    name === 'search_projects'
      ? isAr
        ? 'يبحث في المشاريع...'
        : 'Searching projects...'
      : name === 'get_project'
        ? isAr
          ? 'يجلب تفاصيل المشروع...'
          : 'Fetching project details...'
        : name === 'save_lead'
          ? isAr
            ? 'يحفظ بيانات العميل...'
            : 'Saving lead...'
          : name;
  return (
    <div className="flex items-center gap-2 text-xs text-text/60 italic ps-2">
      <Icon size={12} className="animate-pulse" />
      <span>{label}</span>
    </div>
  );
}

function WelcomeHint({ isAr }: { isAr: boolean }) {
  return (
    <div className="text-center p-6 text-sm text-text/60">
      <Sparkles size={24} className="mx-auto mb-2 text-primary" />
      <div>
        {isAr
          ? 'مثال: ما هي المشاريع المتاحة في شمال الرياض بميزانية مليون ريال؟'
          : 'Try: What projects do we have in north Riyadh under 1M SAR?'}
      </div>
    </div>
  );
}
