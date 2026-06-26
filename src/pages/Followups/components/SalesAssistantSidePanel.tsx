import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Compass, Send, Loader2, Search, FileSearch, Trophy, GitCompareArrows,
  UserSearch, MessageCircle, Megaphone, Building2, Sparkles, ChevronRight, Info, ClipboardList,
} from 'lucide-react';
import type { AppModel, AppRecord } from '@/types';
import { streamMatchTurn, type MatchApiMessage } from '@/lib/matching/client';
import {
  normalizeRecommendation, serializeRecommendationForModel, type RecommendationPayload,
} from '@/lib/matching/recommendation';
import {
  normalizeComparison, normalizeNextAction, normalizeMessageDraft, serializeCardForModel,
  type ComparisonPayload, type NextActionPayload, type MessageDraftPayload,
} from '@/lib/matching/cards';
import ProjectMatchCard from '@/pages/Matching/components/ProjectMatchCard';
import ComparisonCard from '@/pages/Matching/components/ComparisonCard';
import NextActionCard from '@/pages/Matching/components/NextActionCard';
import MessageCard from '@/pages/Matching/components/MessageCard';
import { buildAssistantContext } from '@/lib/followups/assistantContext';
import { useAppStore } from '@/stores/appStore';

/** A structured card rendered inline in the panel transcript. */
type PanelCard =
  | { kind: 'recommendation'; payload: RecommendationPayload }
  | { kind: 'comparison'; payload: ComparisonPayload }
  | { kind: 'next_action'; payload: NextActionPayload }
  | { kind: 'message'; payload: MessageDraftPayload }
  | { kind: 'note'; text: string };

interface PanelMessage {
  role: 'user' | 'assistant';
  content: string;
  cards?: PanelCard[];
}

interface Props {
  isAr: boolean;
  clientsModel: AppModel | null;
  /** Saved client record (fallback for any preference the rep hasn't edited). */
  clientRec: AppRecord | null;
  /** Lifted, draft-first preference buffer shared with PreferenceSummary. */
  prefDraft: Record<string, unknown>;
  /** The follow-up's own draft (outcome_notes, etc.) for added context. */
  followupDraft: Record<string, unknown>;
  /** Name of the project the follow-up centers on, if any. */
  projectName?: string | null;
}

/**
 * The Wassel Sales Assistant (مساعد المبيعات) embedded as a contextual side panel
 * inside the Follow-up Workspace. NOT a separate assistant — it streams the SAME
 * `/api/match` brain and renders the SAME cards as the main Sales Assistant page;
 * the only difference is that it injects the current follow-up's DRAFT preferences
 * (unsaved edits included) as context, so "Suggested Projects" matches against
 * what the rep is looking at on the call — before they ever press Save.
 *
 * State is EPHEMERAL (per the MVP scope) — nothing is persisted; closing the
 * record discards the panel conversation.
 */
export default function SalesAssistantSidePanel({
  isAr, clientsModel, clientRec, prefDraft, followupDraft, projectName,
}: Props) {
  const L = (ar: string, en: string) => (isAr ? ar : en);

  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [input, setInput] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingCards, setPendingCards] = useState<PanelCard[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Resolve the draft-first preferences for both the "used preferences" summary
  // and the assistant context. Recomputed on every render so the freshest
  // unsaved edits are always reflected the moment a quick action fires.
  // id → display name for districts + cities, so the client's preferred_districts /
  // preferred_cities lookup ids resolve to readable names for the assistant context.
  const records = useAppStore((s) => s.records);
  const models = useAppStore((s) => s.models);
  const geoNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const name of ['districts', 'cities']) {
      const m = models.find((mm) => mm.name === name);
      if (!m) continue;
      for (const r of records[m.id] ?? []) {
        const dn = (r.data?.display_name ?? r.data?.name_ar) as unknown;
        if (typeof dn === 'string' && dn) map[r.id] = dn;
      }
    }
    return map;
  }, [records, models]);

  const ctx = useMemo(
    () => buildAssistantContext({
      clientsModel,
      prefDraft,
      savedClientData: clientRec?.data ?? null,
      followupDraft,
      projectName,
      geoNames,
      isAr,
    }),
    [clientsModel, prefDraft, clientRec, followupDraft, projectName, geoNames, isAr],
  );

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

    const userMessage: PanelMessage = { role: 'user', content: trimmed };
    const history = [...messages, userMessage];
    setMessages(history);

    // Build the wire history: prior assistant messages re-attach a compact
    // serialization of their cards (so the model stays grounded across turns),
    // and the LATEST user message gets the current draft-context preface
    // prepended — recomputed now, so it carries the freshest unsaved edits.
    const apiMessages: MatchApiMessage[] = history.map((m, i) => {
      if (i === history.length - 1 && m.role === 'user') {
        return { role: 'user', content: `${ctx.preface}\n\n${m.content}` };
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
            // Task CREATION isn't part of this panel's Phase-1 scope — surface a
            // gentle pointer to the main assistant instead of a write surface.
            pushCard({
              kind: 'note',
              text: L(
                'لإنشاء مهمة متابعة وتأكيدها، استخدم صفحة «مساعد المبيعات» الرئيسية.',
                'To create and confirm a follow-up task, use the main “Sales Assistant” page.',
              ),
            });
          } else if (event.type === 'error') {
            setError(event.message);
          }
        },
        controller.signal,
      );

      if (assistantText.trim() || captured.length > 0) {
        const assistantMessage: PanelMessage = {
          role: 'assistant',
          content: assistantText,
          ...(captured.length ? { cards: captured } : {}),
        };
        setMessages([...history, assistantMessage]);
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

  function onSuggestProjects() {
    void send(L(
      'رشّح أنسب المشاريع لهذا العميل بناءً على تفضيلاته الحالية في نموذج المتابعة.',
      'Suggest the best-fit projects for this customer based on their current preferences in the follow-up form.',
    ));
  }

  function onProjectInfo() {
    // Prefill + focus so the rep types the project name, then sends.
    setInput(L('معلومات مشروع: ', 'Project info: '));
    setTimeout(() => {
      const el = inputRef.current;
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    }, 0);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  function renderCard(card: PanelCard, key: string | number) {
    switch (card.kind) {
      case 'recommendation':
        return <ProjectMatchCard key={key} payload={card.payload} isAr={isAr} />;
      case 'comparison':
        return <ComparisonCard key={key} payload={card.payload} isAr={isAr} />;
      case 'next_action':
        return <NextActionCard key={key} payload={card.payload} isAr={isAr} />;
      case 'message':
        return <MessageCard key={key} payload={card.payload} isAr={isAr} />;
      case 'note':
        return (
          <div key={key} className="mt-2 flex items-start gap-2 rounded-xl border border-sand/50 bg-cream/40 p-3 text-xs text-charcoal/80">
            <ClipboardList size={14} className="mt-0.5 shrink-0 text-copper" />
            <span>{card.text}</span>
          </div>
        );
      default:
        return null;
    }
  }

  if (collapsed) {
    return (
      <div className="w-full xl:w-12 xl:shrink-0 xl:sticky xl:top-4">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="flex w-full items-center justify-center gap-2 rounded-2xl border border-copper/30 bg-copper/10 px-3 py-2 text-sm font-bold text-copper transition hover:bg-copper/20 xl:h-full xl:flex-col xl:py-4"
          title={L('فتح مساعد المبيعات', 'Open the Sales Assistant')}
        >
          <Compass size={18} />
          <span className="xl:[writing-mode:vertical-rl] xl:rotate-180">{L('مساعد المبيعات', 'Sales Assistant')}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="w-full xl:w-[400px] xl:shrink-0 xl:sticky xl:top-4">
      <div className="flex h-[600px] flex-col overflow-hidden rounded-2xl border border-copper/30 bg-white shadow-sm xl:h-[calc(100vh-6rem)]">
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-sand/30 bg-copper/10 px-3 py-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-copper/15">
            <Compass size={16} className="text-copper" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-bold text-chocolate">{L('مساعد المبيعات', 'Sales Assistant')}</div>
            <div className="truncate text-[11px] text-charcoal/60">{L('يعتمد على بيانات المتابعة الحالية', 'Uses the current follow-up data')}</div>
          </div>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="shrink-0 rounded-lg p-1.5 text-charcoal/50 transition hover:bg-white/60 hover:text-charcoal"
            title={L('طيّ اللوحة', 'Collapse panel')}
            aria-label={L('طيّ اللوحة', 'Collapse panel')}
          >
            <ChevronRight size={16} className={isAr ? 'rotate-180' : ''} />
          </button>
        </div>

        {/* Draft-values note */}
        <div className="flex items-start gap-1.5 border-b border-sand/20 bg-cream/40 px-3 py-2 text-[11px] text-charcoal/70">
          <Info size={13} className="mt-0.5 shrink-0 text-copper" />
          <span>{L('يستخدم المساعد القيم الحالية في النموذج، حتى قبل الحفظ.', 'The assistant uses the current form values, even before saving.')}</span>
        </div>

        {/* Used-preferences summary */}
        {ctx.used.length > 0 && (
          <div className="border-b border-sand/20 px-3 py-2">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-charcoal/45">
              {L('التفضيلات الحالية', 'Current preferences')}
            </div>
            <div className="flex flex-wrap gap-1">
              {ctx.used.map((p) => (
                <span key={p.slug} className="inline-flex max-w-full items-center gap-1 rounded-full border border-sand/50 bg-cream/50 px-2 py-0.5 text-[11px] text-charcoal/80">
                  <span className="text-charcoal/50">{isAr ? p.label_ar : p.label_en}:</span>
                  <span className="truncate font-semibold">{p.value}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Quick actions */}
        <div className="flex flex-wrap gap-2 border-b border-sand/20 px-3 py-2.5">
          <button
            type="button"
            onClick={onSuggestProjects}
            disabled={sending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-copper px-3 py-1.5 text-xs font-bold text-white transition hover:bg-terracotta disabled:opacity-50"
          >
            <Sparkles size={13} /> {L('المشاريع المقترحة', 'Suggested Projects')}
          </button>
          <button
            type="button"
            onClick={onProjectInfo}
            disabled={sending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-copper/40 bg-white px-3 py-1.5 text-xs font-bold text-copper transition hover:bg-copper/10 disabled:opacity-50"
          >
            <Building2 size={13} /> {L('معلومات مشروع', 'Project Info')}
          </button>
        </div>

        {/* Transcript */}
        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-3">
          {messages.length === 0 && !streamingText && (
            <div className="px-2 py-6 text-center text-xs text-charcoal/55">
              <Compass size={22} className="mx-auto mb-2 text-copper" />
              <p>{L(
                'اضغط «المشاريع المقترحة» لترشيح أنسب المشاريع لهذا العميل، أو «معلومات مشروع» للسؤال عن مشروع بالاسم. تقدر تكتب سؤالك مباشرة.',
                'Tap “Suggested Projects” to match this customer, or “Project Info” to ask about a project by name. You can also just type your question.',
              )}</p>
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
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</div>
          )}
        </div>

        {/* Input */}
        <div className="border-t border-sand/30 p-2.5">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
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
    </div>
  );
}

function Bubble({ role, content, typing }: { role: 'user' | 'assistant'; content: string; typing?: boolean }) {
  const isUser = role === 'user';
  return (
    <div className={`flex w-full flex-col ${isUser ? 'items-end' : 'items-start'}`}>
      <div
        dir="auto"
        className={`max-w-[88%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm shadow-sm ${
          isUser ? 'border border-copper bg-copper text-white' : 'border border-sand/30 bg-cream text-charcoal'
        }`}
      >
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
