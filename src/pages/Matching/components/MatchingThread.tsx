import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { Send, Loader2, Compass, Search, FileSearch, Trophy, Plus } from 'lucide-react';
import type { AppRecord } from '@/types';
import { streamMatchTurn, type MatchApiMessage } from '@/lib/matching/client';
import {
  normalizeRecommendation,
  serializeRecommendationForModel,
  type RecommendationPayload,
} from '@/lib/matching/recommendation';
import ProjectMatchCard from './ProjectMatchCard';

interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  /** Present on an assistant message that delivered a structured recommendation. */
  recommendation?: RecommendationPayload;
}

interface Props {
  recordId: string;
  modelId: string;
  onNewChat: () => void;
}

/**
 * Active matching-assistant thread: renders prior messages, lets the salesperson
 * send a new message (customer requirements), streams the agent's reply into the
 * transcript, renders the structured recommendation card, and persists the turn
 * back to the matching_chats record on completion. Same mechanics as the
 * copywriter thread — different endpoint + tool labels, and the structured
 * result is a project recommendation (display-only, no record creation).
 */
export default function MatchingThread({ recordId, modelId, onNewChat }: Props) {
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
  // Structured recommendation streamed in this turn (rendered live under the
  // typing bubble; persisted onto the assistant message when the stream ends).
  const [pendingRec, setPendingRec] = useState<RecommendationPayload | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [storedMessages, streamingText, activeTool, pendingRec]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || sending || !record) return;

    setInput('');
    setError(null);
    setStreamingText('');
    setPendingRec(null);
    setActiveTool(null);
    setSending(true);

    const now = new Date().toISOString();
    const userMessage: StoredMessage = { role: 'user', content: trimmed, timestamp: now };
    const withUser: StoredMessage[] = [...storedMessages, userMessage];

    // Persist the user message right away so it survives a reload mid-stream.
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

    // Re-attach any structured recommendation from earlier so the model stays
    // grounded when the salesperson asks a follow-up. The UI still shows the
    // clean card — this serialized text is for the model only.
    const apiMessages: MatchApiMessage[] = withUser.map((m) => {
      let content = m.content;
      if (m.role === 'assistant' && m.recommendation) {
        const serialized = serializeRecommendationForModel(m.recommendation);
        content = content.trim() ? `${content}\n\n${serialized}` : serialized;
      }
      return { role: m.role, content };
    });

    const controller = new AbortController();
    abortRef.current = controller;

    let assistantText = '';
    let capturedRec: RecommendationPayload | null = null;

    try {
      await streamMatchTurn(
        apiMessages,
        (event) => {
          if (event.type === 'text') {
            assistantText += event.delta;
            setStreamingText(assistantText);
          } else if (event.type === 'tool_use') {
            setActiveTool(event.name);
          } else if (event.type === 'tool_result') {
            setActiveTool(null);
          } else if (event.type === 'recommendation') {
            const rec = normalizeRecommendation(event.data);
            if (rec) {
              capturedRec = rec;
              setPendingRec(rec);
            }
          } else if (event.type === 'error') {
            setError(event.message);
          }
        },
        controller.signal,
      );

      if (assistantText.trim() || capturedRec) {
        const done = new Date().toISOString();
        const assistantMessage: StoredMessage = {
          role: 'assistant',
          content: assistantText,
          timestamp: done,
          ...(capturedRec ? { recommendation: capturedRec } : {}),
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
      setPendingRec(null);
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
      <div className="flex-1 flex items-center justify-center text-charcoal/60">
        {isAr ? 'المحادثة غير موجودة' : 'Conversation not found'}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="p-3 border-b border-sand/20 flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-copper/10 flex items-center justify-center shrink-0">
          <Compass size={16} className="text-copper" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm truncate">
            {(record.data.title as string | undefined) ?? (isAr ? 'محادثة' : 'Conversation')}
          </div>
          <div className="text-xs text-charcoal/60">
            {isAr ? 'مساعد المبيعات' : 'Sales Assistant'}
          </div>
        </div>
        <button
          onClick={onNewChat}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-copper text-white hover:bg-terracotta transition-colors text-xs font-medium shrink-0"
          title={isAr ? 'محادثة جديدة' : 'New chat'}
        >
          <Plus size={14} />
          <span className="hidden sm:inline">{isAr ? 'جديدة' : 'New'}</span>
        </button>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {storedMessages.length === 0 && !streamingText && <WelcomeHint isAr={isAr} />}
        {storedMessages.map((m, i) => (
          <div key={i} className="flex flex-col w-full gap-0">
            {(m.content.trim() || !m.recommendation) && <Bubble role={m.role} content={m.content} />}
            {m.recommendation && <ProjectMatchCard payload={m.recommendation} isAr={isAr} />}
          </div>
        ))}
        {activeTool && <ToolBadge name={activeTool} isAr={isAr} />}
        {streamingText && <Bubble role="assistant" content={streamingText} typing />}
        {pendingRec && <ProjectMatchCard payload={pendingRec} isAr={isAr} />}
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm p-3">{error}</div>
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
            placeholder={
              isAr
                ? 'اكتب طلب العميل: المدينة، الحي، نوع العقار، الميزانية، الغرف...'
                : "Type the customer's request: city, district, property type, budget, bedrooms..."
            }
            className="flex-1 resize-none rounded-lg border border-sand/40 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none px-3 py-2 text-sm bg-white disabled:bg-cream"
          />
          <button
            onClick={() => void handleSend()}
            disabled={sending || !input.trim()}
            className="p-3 rounded-lg bg-copper text-white hover:bg-terracotta disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            aria-label={isAr ? 'إرسال' : 'Send'}
          >
            {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
          </button>
        </div>
      </div>
    </div>
  );
}

function Bubble({ role, content, typing }: { role: 'user' | 'assistant'; content: string; typing?: boolean }) {
  const isUser = role === 'user';
  return (
    <div className={`flex flex-col w-full ${isUser ? 'items-end' : 'items-start'}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap shadow-sm ${
          isUser
            ? 'bg-copper text-white border border-primary'
            : 'bg-cream text-charcoal border border-sand/30'
        }`}
      >
        {content}
        {typing && <span className="inline-block w-2 h-4 bg-current opacity-50 animate-pulse ms-1" />}
      </div>
    </div>
  );
}

function ToolBadge({ name, isAr }: { name: string; isAr: boolean }) {
  const map: Record<string, { Icon: typeof Search; ar: string; en: string }> = {
    match_projects: { Icon: Search, ar: 'يطابق المشاريع...', en: 'Matching projects...' },
    get_project: { Icon: FileSearch, ar: 'يجلب تفاصيل المشروع...', en: 'Fetching project details...' },
    emit_recommendation: { Icon: Trophy, ar: 'يجهّز التوصية...', en: 'Preparing the recommendation...' },
  };
  const entry = map[name] ?? { Icon: Search, ar: name, en: name };
  const { Icon } = entry;
  return (
    <div className="flex items-center gap-2 text-xs text-charcoal/60 italic ps-2">
      <Icon size={12} className="animate-pulse" />
      <span>{isAr ? entry.ar : entry.en}</span>
    </div>
  );
}

function WelcomeHint({ isAr }: { isAr: boolean }) {
  return (
    <div className="text-center p-6 text-sm text-charcoal/60">
      <Compass size={24} className="mx-auto mb-2 text-copper" />
      <div>
        {isAr
          ? 'اكتب طلب العميل بلغتك، مثلاً: «العميل يبي شقة في حي النرجس بالرياض، ميزانية مليون ونص، ٣ غرف».'
          : "Type the customer's request in your own words, e.g. “Customer wants an apartment in حي النرجس, Riyadh — budget 1.5M, 3 bedrooms.”"}
      </div>
    </div>
  );
}
