import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { Send, Loader2, Search, FileSearch, Trophy, GitCompareArrows, UserSearch, MessageCircle, Megaphone, Compass } from 'lucide-react';
import { streamMatchTurn, type MatchApiMessage } from '@/lib/matching/client';
import { normalizeRecommendation, serializeRecommendationForModel, type RecommendationPayload } from '@/lib/matching/recommendation';
import {
  normalizeComparison, normalizeNextAction, normalizeMessageDraft, serializeCardForModel,
  type ComparisonPayload, type NextActionPayload, type MessageDraftPayload,
} from '@/lib/matching/cards';
import ProjectMatchCard from '@/pages/Matching/components/ProjectMatchCard';
import ComparisonCard from '@/pages/Matching/components/ComparisonCard';
import NextActionCard from '@/pages/Matching/components/NextActionCard';
import MessageCard from '@/pages/Matching/components/MessageCard';

/**
 * The Sales Assistant chat — the streaming `/api/match` brain + its structured
 * cards — extracted as a REUSABLE pane so the Suggested Projects modal can host a
 * conversation grounded in the same draft-first context, and surface per-card
 * actions (explain / compare / pitch / WhatsApp) by calling `ask()` imperatively.
 *
 * It NEVER matches or scores — the deterministic grouped results come from
 * /api/suggest-projects; this pane is the "AI explains" half.
 */

type PanelCard =
  | { kind: 'recommendation'; payload: RecommendationPayload }
  | { kind: 'comparison'; payload: ComparisonPayload }
  | { kind: 'next_action'; payload: NextActionPayload }
  | { kind: 'message'; payload: MessageDraftPayload }
  | { kind: 'note'; text: string };

interface PaneMessage {
  role: 'user' | 'assistant';
  content: string;
  cards?: PanelCard[];
}

export interface AssistantChatHandle {
  /** Send a message to the assistant (used by card action buttons). */
  ask: (text: string) => void;
}

interface Props {
  isAr: boolean;
  /** Returns the draft-first context preface — called at SEND time so the freshest
   *  unsaved follow-up preferences are always used. */
  getPreface: () => string;
  emptyHint?: string;
}

const AssistantChatPane = forwardRef<AssistantChatHandle, Props>(function AssistantChatPane(
  { isAr, getPreface, emptyHint },
  ref,
) {
  const L = (ar: string, en: string) => (isAr ? ar : en);

  const [messages, setMessages] = useState<PaneMessage[]>([]);
  const [input, setInput] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingCards, setPendingCards] = useState<PanelCard[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Mirror messages so ask()/send() never read a stale closure.
  const messagesRef = useRef<PaneMessage[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streamingText, activeTool, pendingCards]);
  useEffect(() => () => abortRef.current?.abort(), []);

  async function send(rawText: string) {
    const trimmed = rawText.trim();
    if (!trimmed || sending) return;
    setInput('');
    setError(null);
    setStreamingText('');
    setPendingCards([]);
    setActiveTool(null);
    setSending(true);

    const userMessage: PaneMessage = { role: 'user', content: trimmed };
    const history = [...messagesRef.current, userMessage];
    setMessages(history);

    const preface = getPreface();
    const apiMessages: MatchApiMessage[] = history.map((m, i) => {
      if (i === history.length - 1 && m.role === 'user') {
        return { role: 'user', content: `${preface}\n\n${m.content}` };
      }
      if (m.role === 'assistant' && m.cards?.length) {
        const extras = m.cards.map((c) =>
          c.kind === 'recommendation'
            ? serializeRecommendationForModel(c.payload)
            : c.kind === 'note'
              ? ''
              : serializeCardForModel(c.kind, c.payload),
        ).filter(Boolean);
        const content = extras.length
          ? (m.content.trim() ? `${m.content}\n\n${extras.join('\n')}` : extras.join('\n'))
          : m.content;
        return { role: m.role, content };
      }
      return { role: m.role, content: m.content };
    });

    const controller = new AbortController();
    abortRef.current = controller;
    let assistantText = '';
    const captured: PanelCard[] = [];
    const pushCard = (card: PanelCard | null) => {
      if (!card) return;
      captured.push(card);
      setPendingCards([...captured]);
    };

    try {
      await streamMatchTurn(apiMessages, (event) => {
        if (event.type === 'text') { assistantText += event.delta; setStreamingText(assistantText); }
        else if (event.type === 'tool_use') setActiveTool(event.name);
        else if (event.type === 'tool_result') setActiveTool(null);
        else if (event.type === 'recommendation') { const p = normalizeRecommendation(event.data); if (p) pushCard({ kind: 'recommendation', payload: p }); }
        else if (event.type === 'comparison') { const p = normalizeComparison(event.data); if (p) pushCard({ kind: 'comparison', payload: p }); }
        else if (event.type === 'next_action') { const p = normalizeNextAction(event.data); if (p) pushCard({ kind: 'next_action', payload: p }); }
        else if (event.type === 'message_draft') { const p = normalizeMessageDraft(event.data); if (p) pushCard({ kind: 'message', payload: p }); }
        else if (event.type === 'task_proposal') {
          pushCard({ kind: 'note', text: L('لإنشاء مهمة متابعة وتأكيدها، استخدم صفحة «مساعد المبيعات» الرئيسية.', 'To create and confirm a follow-up task, use the main “Sales Assistant” page.') });
        }
        else if (event.type === 'error') setError(event.message);
      }, controller.signal);

      if (assistantText.trim() || captured.length > 0) {
        setMessages([...history, { role: 'assistant', content: assistantText, ...(captured.length ? { cards: captured } : {}) }]);
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

  // Keep a stable handle that always calls the latest send.
  const sendRef = useRef(send);
  sendRef.current = send;
  useImperativeHandle(ref, () => ({ ask: (text: string) => void sendRef.current(text) }), []);

  function renderCard(card: PanelCard, key: string | number) {
    switch (card.kind) {
      case 'recommendation': return <ProjectMatchCard key={key} payload={card.payload} isAr={isAr} />;
      case 'comparison': return <ComparisonCard key={key} payload={card.payload} isAr={isAr} />;
      case 'next_action': return <NextActionCard key={key} payload={card.payload} isAr={isAr} />;
      case 'message': return <MessageCard key={key} payload={card.payload} isAr={isAr} />;
      case 'note': return (
        <div key={key} className="mt-2 rounded-xl border border-sand/50 bg-cream/40 p-3 text-xs text-charcoal/80">{card.text}</div>
      );
      default: return null;
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && !streamingText && (
          <div className="px-2 py-8 text-center text-xs text-charcoal/55">
            <Compass size={22} className="mx-auto mb-2 text-copper" />
            <p>{emptyHint ?? L('اسأل عن أي مشروع: «لماذا هذا المشروع؟»، «قارن بينها»، «اكتب عرضاً».', 'Ask about any project: “why this one?”, “compare them”, “write a pitch”.')}</p>
          </div>
        )}
        {messages.map((m, i) => {
          const hasCards = (m.cards?.length ?? 0) > 0;
          return (
            <div key={i} className="flex w-full flex-col gap-0">
              {(m.content.trim() || !hasCards) && <Bubble role={m.role} content={m.content} />}
              {(m.cards ?? []).map((c, ci) => renderCard(c, `${i}-${ci}`))}
            </div>
          );
        })}
        {activeTool && <ToolBadge name={activeTool} isAr={isAr} />}
        {streamingText && <Bubble role="assistant" content={streamingText} typing />}
        {pendingCards.map((c, i) => renderCard(c, `p-${i}`))}
        {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</div>}
      </div>

      <div className="border-t border-sand/30 p-2.5">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }}
            disabled={sending}
            rows={2}
            placeholder={L('اكتب سؤالك للمساعد…', 'Ask the assistant…')}
            className="form-input flex-1 resize-none text-sm disabled:bg-cream"
          />
          <button
            type="button"
            onClick={() => void send(input)}
            disabled={sending || !input.trim()}
            className="rounded-lg bg-copper p-2.5 text-white transition hover:bg-terracotta disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={L('إرسال', 'Send')}
          >
            {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
});

export default AssistantChatPane;

function Bubble({ role, content, typing }: { role: 'user' | 'assistant'; content: string; typing?: boolean }) {
  const isUser = role === 'user';
  return (
    <div className={`flex w-full flex-col ${isUser ? 'items-end' : 'items-start'}`}>
      <div dir="auto" className={`max-w-[88%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm shadow-sm ${isUser ? 'border border-copper bg-copper text-white' : 'border border-sand/30 bg-cream text-charcoal'}`}>
        {content}
        {typing && <span className="ms-1 inline-block h-4 w-2 animate-pulse bg-current opacity-50" />}
      </div>
    </div>
  );
}

function ToolBadge({ name, isAr }: { name: string; isAr: boolean }) {
  const map: Record<string, { Icon: typeof Search; ar: string; en: string }> = {
    match_projects: { Icon: Search, ar: 'يطابق المشاريع...', en: 'Matching projects…' },
    search_projects: { Icon: Search, ar: 'يبحث عن المشروع...', en: 'Finding the project…' },
    get_project: { Icon: FileSearch, ar: 'يجلب تفاصيل المشروع...', en: 'Fetching project details…' },
    compare_projects: { Icon: GitCompareArrows, ar: 'يقارن المشاريع...', en: 'Comparing projects…' },
    get_customer_context: { Icon: UserSearch, ar: 'يطّلع على بيانات العميل...', en: 'Reading the lead…' },
    emit_recommendation: { Icon: Trophy, ar: 'يجهّز التوصية...', en: 'Preparing the recommendation…' },
    emit_comparison: { Icon: GitCompareArrows, ar: 'يجهّز المقارنة...', en: 'Preparing the comparison…' },
    emit_message: { Icon: MessageCircle, ar: 'يكتب الرسالة...', en: 'Drafting the message…' },
  };
  const entry = map[name] ?? { Icon: Megaphone, ar: name, en: name };
  const { Icon } = entry;
  return (
    <div className="flex items-center gap-2 ps-2 text-xs italic text-charcoal/60">
      <Icon size={12} className="animate-pulse" />
      <span>{isAr ? entry.ar : entry.en}</span>
    </div>
  );
}
