import { useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuid } from 'uuid';
import { useAppStore } from '@/stores/appStore';
import { Send, Loader2, Compass, Search, FileSearch, Trophy, Plus, GitCompareArrows, UserSearch, Megaphone, MessageCircle, CalendarPlus } from 'lucide-react';
import type { AppRecord } from '@/types';
import { streamMatchTurn, type MatchApiMessage } from '@/lib/matching/client';
import {
  normalizeRecommendation,
  serializeRecommendationForModel,
  type RecommendationPayload,
} from '@/lib/matching/recommendation';
import {
  normalizeComparison, normalizeNextAction, normalizeMessageDraft, normalizeTaskProposal,
  serializeCardForModel,
  type ComparisonPayload, type NextActionPayload, type MessageDraftPayload, type TaskProposalPayload,
} from '@/lib/matching/cards';
import ProjectMatchCard from './ProjectMatchCard';
import ComparisonCard from './ComparisonCard';
import NextActionCard from './NextActionCard';
import MessageCard from './MessageCard';
import TaskProposalCard, { type TaskProposalStatus } from './TaskProposalCard';

/** One structured card delivered by the assistant inside the chat. */
interface StoredCard {
  kind: 'recommendation' | 'comparison' | 'next_action' | 'message' | 'task_proposal';
  payload: unknown;
  /** Only for task_proposal: the confirmation state. */
  task_status?: TaskProposalStatus;
  created_record_id?: string;
}

interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  /** Structured cards on an assistant message (recommendation, comparison, …). */
  cards?: StoredCard[];
  /** Legacy single-recommendation field (older messages). Still rendered. */
  recommendation?: RecommendationPayload;
}

interface Props {
  recordId: string;
  modelId: string;
  onNewChat: () => void;
}

/**
 * Active Sales-Assistant thread. ONE chat that handles every capability —
 * project matching, comparison, next-best-action, message drafting, and
 * confirmation-gated task creation — each rendered as its own card type inside
 * this same conversation. Persists the turn back to the matching_chats record.
 */
export default function MatchingThread({ recordId, modelId, onNewChat }: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const recordsByModel = useAppStore((s) => s.records);
  const saveRecord = useAppStore((s) => s.saveRecord);
  const models = useAppStore((s) => s.models);
  const currentUserId = useAppStore((s) => s.currentUserId);
  const addToast = useAppStore((s) => s.addToast);

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
  // Cards streamed in this turn (rendered live; persisted when the stream ends).
  const [pendingCards, setPendingCards] = useState<StoredCard[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [storedMessages, streamingText, activeTool, pendingCards]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || sending || !record) return;

    setInput('');
    setError(null);
    setStreamingText('');
    setPendingCards([]);
    setActiveTool(null);
    setSending(true);

    const now = new Date().toISOString();
    const userMessage: StoredMessage = { role: 'user', content: trimmed, timestamp: now };
    const withUser: StoredMessage[] = [...storedMessages, userMessage];

    const firstUserMessage = storedMessages.length === 0;
    const titleFromFirst = firstUserMessage ? trimmed.slice(0, 60) : (record.data.title as string | undefined);
    saveRecord({
      ...record,
      data: { ...record.data, messages: withUser, message_count: withUser.length, last_message_at: now, ...(firstUserMessage ? { title: titleFromFirst } : {}) },
      updated_at: now,
    });

    // Re-attach structured cards from earlier as compact text so the model stays
    // grounded across the conversation. The UI still shows the clean cards.
    const apiMessages: MatchApiMessage[] = withUser.map((m) => {
      let content = m.content;
      const extras: string[] = [];
      if (m.role === 'assistant' && m.recommendation) extras.push(serializeRecommendationForModel(m.recommendation));
      for (const c of m.cards ?? []) {
        if (c.kind === 'recommendation') extras.push(serializeRecommendationForModel(c.payload as RecommendationPayload));
        else extras.push(serializeCardForModel(c.kind, c.payload));
      }
      if (extras.length) content = content.trim() ? `${content}\n\n${extras.join('\n')}` : extras.join('\n');
      return { role: m.role, content };
    });

    const controller = new AbortController();
    abortRef.current = controller;

    let assistantText = '';
    const captured: StoredCard[] = [];
    const pushCard = (card: StoredCard | null) => {
      if (!card) return;
      captured.push(card);
      setPendingCards([...captured]);
    };

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
            const p = normalizeRecommendation(event.data);
            if (p) pushCard({ kind: 'recommendation', payload: p });
          } else if (event.type === 'comparison') {
            const p = normalizeComparison(event.data);
            if (p) pushCard({ kind: 'comparison', payload: p });
          } else if (event.type === 'next_action') {
            const p = normalizeNextAction(event.data);
            if (p) pushCard({ kind: 'next_action', payload: p });
          } else if (event.type === 'message_draft') {
            const p = normalizeMessageDraft(event.data);
            if (p) pushCard({ kind: 'message', payload: p });
          } else if (event.type === 'task_proposal') {
            const p = normalizeTaskProposal(event.data);
            if (p) pushCard({ kind: 'task_proposal', payload: p, task_status: 'proposed' });
          } else if (event.type === 'error') {
            setError(event.message);
          }
        },
        controller.signal,
      );

      if (assistantText.trim() || captured.length > 0) {
        const done = new Date().toISOString();
        const assistantMessage: StoredMessage = {
          role: 'assistant',
          content: assistantText,
          timestamp: done,
          ...(captured.length ? { cards: captured } : {}),
        };
        const finalMessages = [...withUser, assistantMessage];
        saveRecord({
          ...record,
          data: { ...record.data, messages: finalMessages, message_count: finalMessages.length, last_message_at: done, ...(firstUserMessage ? { title: titleFromFirst } : {}) },
          updated_at: done,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== 'The user aborted a request.') setError(msg);
    } finally {
      setStreamingText('');
      setPendingCards([]);
      setActiveTool(null);
      setSending(false);
      abortRef.current = null;
    }
  }

  /** Update a task_proposal card's confirmation status on its stored message. */
  function setCardStatus(msgIdx: number, cardIdx: number, status: TaskProposalStatus, createdId?: string) {
    if (!record) return;
    const msgs = storedMessages.map((m, mi) => {
      if (mi !== msgIdx || !m.cards) return m;
      const cards = m.cards.map((c, ci) => (ci === cardIdx ? { ...c, task_status: status, ...(createdId ? { created_record_id: createdId } : {}) } : c));
      return { ...m, cards };
    });
    saveRecord({ ...record, data: { ...record.data, messages: msgs }, updated_at: new Date().toISOString() });
  }

  /** Confirmation-gated write: create the follow-up record only on explicit confirm. */
  async function confirmTask(msgIdx: number, cardIdx: number, payload: TaskProposalPayload, dueAtIso: string) {
    // Never write a task that isn't tied to a real, server-validated client.
    if (payload.unresolved || !payload.client_id) {
      addToast(isAr ? 'العميل غير موجود في النظام — لا يمكن إنشاء المهمة' : 'Client not found — cannot create the task', 'error');
      return;
    }
    const followups = models.find((m) => m.name === 'followups');
    if (!followups) {
      addToast(isAr ? 'نموذج المتابعات غير متوفر' : 'Follow-ups model unavailable', 'error');
      return;
    }
    const now = new Date().toISOString();
    const rec: AppRecord = {
      id: uuid(),
      model_id: followups.id,
      data: {
        client_id: payload.client_id,
        // section_selector stores an array of selected section values.
        followup_type: [payload.followup_type],
        scheduled_datetime: dueAtIso,
        followup_status: 'open',
        sales_rep: currentUserId,
        outcome_notes: payload.notes || '',
      },
      created_at: now,
      updated_at: now,
    };
    const res = await saveRecord(rec);
    // Only claim success on a real save — 'queued' (RPC failed) / 'conflict' must
    // surface, never a silent "created" the DB doesn't have.
    if (res?.status === 'saved') {
      setCardStatus(msgIdx, cardIdx, 'created', rec.id);
      addToast(isAr ? 'تم إنشاء مهمة المتابعة' : 'Follow-up task created', 'success');
    } else {
      addToast(
        isAr ? 'تعذّر إنشاء المهمة — حاول مرة أخرى' : 'Could not create the task — please try again',
        'error',
      );
    }
  }

  function renderCard(card: StoredCard, msgIdx: number, cardIdx: number) {
    switch (card.kind) {
      case 'recommendation':
        return <ProjectMatchCard payload={card.payload as RecommendationPayload} isAr={isAr} />;
      case 'comparison':
        return <ComparisonCard payload={card.payload as ComparisonPayload} isAr={isAr} />;
      case 'next_action':
        return <NextActionCard payload={card.payload as NextActionPayload} isAr={isAr} />;
      case 'message':
        return <MessageCard payload={card.payload as MessageDraftPayload} isAr={isAr} />;
      case 'task_proposal':
        return (
          <TaskProposalCard
            payload={card.payload as TaskProposalPayload}
            isAr={isAr}
            status={card.task_status ?? 'proposed'}
            onConfirm={(dueIso) => void confirmTask(msgIdx, cardIdx, card.payload as TaskProposalPayload, dueIso)}
            onCancel={() => setCardStatus(msgIdx, cardIdx, 'cancelled')}
          />
        );
      default:
        return null;
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
          <div className="text-xs text-charcoal/60">{isAr ? 'مساعد المبيعات' : 'Sales Assistant'}</div>
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
        {storedMessages.map((m, i) => {
          const hasCards = (m.cards?.length ?? 0) > 0 || !!m.recommendation;
          return (
            <div key={i} className="flex flex-col w-full gap-0">
              {(m.content.trim() || !hasCards) && <Bubble role={m.role} content={m.content} />}
              {m.recommendation && <ProjectMatchCard payload={m.recommendation} isAr={isAr} />}
              {(m.cards ?? []).map((c, ci) => (
                <div key={ci}>{renderCard(c, i, ci)}</div>
              ))}
            </div>
          );
        })}
        {activeTool && <ToolBadge name={activeTool} isAr={isAr} />}
        {streamingText && <Bubble role="assistant" content={streamingText} typing />}
        {/* Live cards during streaming (task proposals wait until persisted so they're interactive). */}
        {pendingCards.filter((c) => c.kind !== 'task_proposal').map((c, i) => (
          <div key={`p-${i}`}>{renderCard(c, -1, -1)}</div>
        ))}
        {error && <div className="rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm p-3">{error}</div>}
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
                ? 'اكتب بلغتك: رشّح مشروع، قارن، وش أرسل للعميل، أو وش الخطوة التالية...'
                : 'Type naturally: match a project, compare, draft a message, or ask the next step…'
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
          isUser ? 'bg-copper text-white border border-primary' : 'bg-cream text-charcoal border border-sand/30'
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
    compare_projects: { Icon: GitCompareArrows, ar: 'يقارن المشاريع...', en: 'Comparing projects...' },
    get_customer_context: { Icon: UserSearch, ar: 'يطّلع على بيانات العميل...', en: 'Reading the lead…' },
    emit_recommendation: { Icon: Trophy, ar: 'يجهّز التوصية...', en: 'Preparing the recommendation…' },
    emit_comparison: { Icon: GitCompareArrows, ar: 'يجهّز المقارنة...', en: 'Preparing the comparison…' },
    emit_next_action: { Icon: Compass, ar: 'يجهّز الخطوة التالية...', en: 'Preparing the next action…' },
    emit_message: { Icon: MessageCircle, ar: 'يكتب الرسالة...', en: 'Drafting the message…' },
    propose_task: { Icon: CalendarPlus, ar: 'يجهّز مهمة متابعة...', en: 'Preparing a task…' },
  };
  const entry = map[name] ?? { Icon: Megaphone, ar: name, en: name };
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
      <div className="max-w-md mx-auto">
        {isAr
          ? 'اسألني بلغتك: «العميل يبي شقة في النرجس ميزانية مليون ونص» · «قارن دروازه ومينا 52» · «العميل زار وما حجز، وش أسوي؟» · «اكتب رسالة متابعة».'
          : 'Ask naturally: “customer wants an apartment in النرجس, 1.5M” · “compare دروازه and مينا 52” · “he visited but didn’t book, what now?” · “draft a follow-up message.”'}
      </div>
    </div>
  );
}
