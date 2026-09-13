import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  MessageCircle, RefreshCw, Search, ExternalLink, User, CheckCheck, Undo2, XCircle, Sparkles, Loader2, Clock,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import ChatThreadModal from '@/pages/Chats/components/ChatThreadModal';
import { saveDraftText } from '@/pages/Chats/lib/drafts';
import {
  useFollowupSuggestions, CATEGORY_ORDER,
  type FollowupSuggestion, type SuggestionCategory, type SuggestionStatus,
} from '@/lib/followupSuggestions/client';

/**
 * Follow-up Queue (متابعات مقترحة) — the review surface for Claude's
 * suggested WhatsApp follow-ups.
 *
 * One card per conversation: who, what we sent them, how long they've been
 * silent, a summary of the whole thread, WHY a message is suggested, and the
 * suggested text (editable). «افتح المحادثة» opens the real WhatsApp thread
 * in the existing ChatThreadModal with the suggested text pre-filled in the
 * composer (via the per-conversation draft store), so the rep reads the actual
 * chat and confirms the send through the normal chat path. The page watches
 * the conversation's messages while the popup is open and marks the
 * suggestion `sent` the moment an outbound message appears — nothing is sent
 * by this page itself.
 */

type StatusTab = SuggestionStatus | 'all';

const CATEGORY_META: Record<SuggestionCategory, { ar: string; en: string; badge: string; stripe: string }> = {
  reply:    { ar: 'العميل ينتظر رد', en: 'Client waiting for a reply', badge: 'bg-terracotta text-white', stripe: '#8E4E3A' },
  visited:  { ar: 'زار المشروع', en: 'Visited the project', badge: 'bg-copper text-white', stripe: '#B8734F' },
  promised: { ar: 'طلب شيئاً ولم يصله', en: 'Asked for something, never got it', badge: 'bg-gold text-white', stripe: '#C09B5F' },
  nudge:    { ar: 'أُرسل له مشروع وسكت', en: 'Got a project, went quiet', badge: 'bg-sand/70 text-charcoal', stripe: '#D4B896' },
  revive:   { ar: 'إحياء طلب قديم', en: 'Revive an old request', badge: 'bg-charcoal/10 text-charcoal', stripe: '#9CA3AF' },
};

const PRIORITY_META: Record<1 | 2 | 3, { ar: string; en: string; cls: string }> = {
  1: { ar: 'اليوم', en: 'Today', cls: 'bg-terracotta/10 text-terracotta' },
  2: { ar: 'هذا الأسبوع', en: 'This week', cls: 'bg-copper/10 text-copper' },
  3: { ar: 'عادي', en: 'Low', cls: 'bg-charcoal/5 text-charcoal/60' },
};

const DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

function fmtDate(iso: string | null, isAr: boolean): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(isAr ? 'ar-SA' : 'en-GB', { day: 'numeric', month: 'short' });
}

export default function FollowUpQueuePage() {
  const isAr = useAppStore((s) => s.language === 'ar');
  const currentUserId = useAppStore((s) => s.currentUserId);
  const addToast = useAppStore((s) => s.addToast);
  const chatMessages = useAppStore((s) => s.chatMessages);
  const subscribeToAllChats = useAppStore((s) => s.subscribeToAllChats);
  const unsubscribeFromAllChats = useAppStore((s) => s.unsubscribeFromAllChats);

  const { rows, loading, error, refresh, markSent, dismiss, restore, saveMessage, saveNote } = useFollowupSuggestions();

  const [tab, setTab] = useState<StatusTab>('pending');
  const [category, setCategory] = useState<SuggestionCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  // Local edits of the suggested text, keyed by suggestion id. Saved to the DB
  // on blur so an edit survives a reload and so "what we sent" is honest.
  const [edits, setEdits] = useState<Record<string, string>>({});
  // The suggestion whose chat popup is open, plus when it was opened — any
  // outbound message on that conversation dated after this = "sent".
  const [open, setOpen] = useState<{ suggestion: FollowupSuggestion; openedAt: number; sent: boolean } | null>(null);

  // Keep the chat realtime stream alive while this page is mounted, so the
  // popup thread updates live (same lifecycle ChatsSplitPage owns).
  useEffect(() => {
    subscribeToAllChats();
    return () => unsubscribeFromAllChats();
  }, [subscribeToAllChats, unsubscribeFromAllChats]);

  const now = Date.now();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (tab !== 'all' && r.status !== tab) return false;
      if (category !== 'all' && r.category !== category) return false;
      if (!q) return true;
      const hay = `${r.client_name ?? ''} ${r.phone ?? ''} ${r.project ?? ''} ${r.chat_summary}`.toLowerCase();
      return hay.includes(q);
    });
  }, [rows, tab, category, query]);

  const grouped = useMemo(() => {
    const map = new Map<SuggestionCategory, FollowupSuggestion[]>();
    for (const c of CATEGORY_ORDER) map.set(c, []);
    for (const r of filtered) map.get(r.category)?.push(r);
    return CATEGORY_ORDER.map((c) => ({ category: c, items: map.get(c) ?? [] })).filter((g) => g.items.length > 0);
  }, [filtered]);

  const counts = useMemo(() => {
    const c: Record<StatusTab, number> = { all: rows.length, pending: 0, sent: 0, dismissed: 0, snoozed: 0 };
    for (const r of rows) c[r.status] += 1;
    return c;
  }, [rows]);

  const categoryCounts = useMemo(() => {
    const c = new Map<SuggestionCategory, number>();
    for (const r of rows) if (tab === 'all' || r.status === tab) c.set(r.category, (c.get(r.category) ?? 0) + 1);
    return c;
  }, [rows, tab]);

  // ── Send detection ───────────────────────────────────────────────
  // While the popup is open, watch this conversation's messages. The store
  // pushes an optimistic outbound bubble the instant the rep hits send, so
  // the first `flow:'out'` message dated after we opened the popup is the
  // confirmation. Recorded once; the popup stays open so the rep can keep
  // chatting.
  const markSentRef = useRef(markSent);
  markSentRef.current = markSent;
  useEffect(() => {
    if (!open || open.sent || !open.suggestion.chat_wid) return;
    const msgs = chatMessages[open.suggestion.chat_wid] ?? [];
    const hit = msgs.find((m) => m.flow === 'out' && Date.parse(m.date) >= open.openedAt - 5_000);
    if (!hit) return;
    const s = open.suggestion;
    setOpen({ ...open, sent: true });
    void markSentRef.current(s.id, {
      finalMessage: hit.body ?? edits[s.id] ?? s.suggested_message,
      sentByUserId: currentUserId ?? null,
      sentMessageId: hit.id,
    });
    addToast(isAr ? `تم تسجيل الإرسال لـ ${s.client_name ?? ''}` : `Recorded as sent to ${s.client_name ?? ''}`, 'success');
  }, [chatMessages, open, edits, currentUserId, addToast, isAr]);

  const textOf = (r: FollowupSuggestion) => edits[r.id] ?? r.suggested_message;

  const openChat = (r: FollowupSuggestion) => {
    if (!r.chat_wid) {
      addToast(isAr ? 'هذه المحادثة بدون معرّف واتساب' : 'This conversation has no WhatsApp id', 'error');
      return;
    }
    // Pre-fill the composer: the Composer restores the per-conversation draft
    // synchronously on mount (see src/pages/Chats/lib/drafts.ts). Deliberate
    // overwrite — the rep just chose THIS suggestion for THIS chat.
    saveDraftText(r.chat_wid, textOf(r));
    setOpen({ suggestion: r, openedAt: Date.now(), sent: false });
  };

  const manualSent = async () => {
    if (!open) return;
    const s = open.suggestion;
    await markSent(s.id, { finalMessage: textOf(s), sentByUserId: currentUserId ?? null, sentMessageId: null });
    setOpen({ ...open, sent: true });
  };

  const doDismiss = async (r: FollowupSuggestion) => {
    const reason = window.prompt(isAr ? 'سبب التجاهل (اختياري):' : 'Reason for dismissing (optional):', '');
    if (reason === null) return;
    await dismiss(r.id, { reason: reason.trim() || null, byUserId: currentUserId ?? null });
  };

  const commitEdit = (r: FollowupSuggestion) => {
    const t = edits[r.id];
    if (t === undefined || t === r.suggested_message) return;
    void saveMessage(r.id, t);
  };

  const tabs: { id: StatusTab; ar: string; en: string }[] = [
    { id: 'pending', ar: 'بانتظار المراجعة', en: 'Pending' },
    { id: 'sent', ar: 'أُرسلت', en: 'Sent' },
    { id: 'dismissed', ar: 'مُتجاهلة', en: 'Dismissed' },
    { id: 'all', ar: 'الكل', en: 'All' },
  ];

  return (
    <div className="mx-auto max-w-5xl px-3 py-4 md:px-6 md:py-6">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-charcoal">
            <Sparkles size={22} className="text-copper" />
            {isAr ? 'متابعات مقترحة' : 'Follow-up Queue'}
          </h1>
          <p className="mt-1 text-sm text-charcoal/60">
            {isAr
              ? 'رسائل متابعة اقترحها كلود بعد قراءة محادثات العملاء. افتح المحادثة، اقرأها، عدّل الرسالة إذا لزم، ثم أرسل.'
              : 'Follow-ups Claude suggested after reading the client chats. Open the chat, read it, edit if needed, then send.'}
          </p>
        </div>
        <Button variant="secondary" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          {isAr ? 'تحديث' : 'Refresh'}
        </Button>
      </div>

      {error && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {isAr ? 'تعذر تحميل القائمة: ' : 'Could not load the queue: '}{error}
        </div>
      )}

      {/* Status tabs */}
      <div className="mb-3 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-full px-4 py-1.5 text-sm font-bold transition-colors ${
              tab === t.id ? 'bg-copper text-white' : 'bg-white text-charcoal/70 border border-sand/30 hover:bg-cream'
            }`}
          >
            {isAr ? t.ar : t.en}
            <span className={`ms-2 rounded-full px-1.5 text-xs ${tab === t.id ? 'bg-white/20' : 'bg-sand/40'}`}>{counts[t.id]}</span>
          </button>
        ))}
      </div>

      {/* Category chips + search */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setCategory('all')}
          className={`rounded-lg px-3 py-1 text-xs font-bold ${category === 'all' ? 'bg-charcoal text-white' : 'bg-white border border-sand/30 text-charcoal/70'}`}
        >
          {isAr ? 'كل الأنواع' : 'All types'}
        </button>
        {CATEGORY_ORDER.map((c) => {
          const n = categoryCounts.get(c) ?? 0;
          if (n === 0) return null;
          return (
            <button
              key={c}
              onClick={() => setCategory(category === c ? 'all' : c)}
              className={`rounded-lg px-3 py-1 text-xs font-bold ${category === c ? 'bg-charcoal text-white' : 'bg-white border border-sand/30 text-charcoal/70'}`}
            >
              {isAr ? CATEGORY_META[c].ar : CATEGORY_META[c].en} · {n}
            </button>
          );
        })}
        <div className="relative ms-auto min-w-[220px] flex-1 md:flex-none">
          <Search size={14} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-charcoal/40" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={isAr ? 'بحث بالاسم / الجوال / المشروع' : 'Search name / phone / project'}
            className="w-full rounded-xl border border-sand/30 bg-white py-1.5 pe-3 ps-9 text-sm focus:outline-none focus:ring-2 focus:ring-copper/30"
          />
        </div>
      </div>

      {loading && rows.length === 0 && (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-charcoal/50">
          <Loader2 size={16} className="animate-spin" /> {isAr ? 'جارٍ التحميل…' : 'Loading…'}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="rounded-2xl border border-dashed border-sand/40 bg-white py-16 text-center text-sm text-charcoal/50">
          {isAr ? 'لا توجد اقتراحات في هذا التصنيف.' : 'No suggestions in this view.'}
        </div>
      )}

      {grouped.map((g) => (
        <section key={g.category} className="mb-8">
          <h2 className="mb-3 flex items-center gap-2 text-base font-bold text-charcoal">
            <span className={`rounded-md px-2 py-0.5 text-xs ${CATEGORY_META[g.category].badge}`}>
              {isAr ? CATEGORY_META[g.category].ar : CATEGORY_META[g.category].en}
            </span>
            <span className="text-charcoal/50">{g.items.length}</span>
          </h2>
          <div className="space-y-3">
            {g.items.map((r) => {
              const silent = daysSince(r.last_client_message_at, now);
              const p = PRIORITY_META[r.priority];
              return (
                <article
                  key={r.id}
                  className="overflow-hidden rounded-2xl border border-sand/30 bg-white shadow-sm"
                  style={{ borderInlineStartWidth: 5, borderInlineStartColor: CATEGORY_META[r.category].stripe }}
                >
                  <div className="p-4">
                    {/* Row 1: who + meta */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-base font-bold text-charcoal">{r.client_name || r.phone || '—'}</span>
                      {r.phone && <span className="text-xs text-charcoal/50" dir="ltr">{r.phone}</span>}
                      {r.project && (
                        <span className="rounded-md bg-cream px-2 py-0.5 text-xs text-charcoal/80">{r.project}</span>
                      )}
                      <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${p.cls}`}>{isAr ? p.ar : p.en}</span>
                      {silent !== null && (
                        <span className="flex items-center gap-1 text-xs text-charcoal/60">
                          <Clock size={12} />
                          {isAr
                            ? `آخر رسالة من العميل قبل ${silent} يوم (${fmtDate(r.last_client_message_at, true)})`
                            : `Client last wrote ${silent}d ago (${fmtDate(r.last_client_message_at, false)})`}
                        </span>
                      )}
                      <span className="ms-auto flex items-center gap-2 text-xs">
                        <Link
                          to={`/model/chats/${r.chat_record_id}`}
                          target="_blank"
                          className="flex items-center gap-1 text-charcoal/50 hover:text-copper"
                          title={isAr ? 'فتح صفحة المحادثة' : 'Open chat page'}
                        >
                          <MessageCircle size={13} /> <ExternalLink size={11} />
                        </Link>
                        {r.client_record_id && (
                          <Link
                            to={`/model/clients/${r.client_record_id}`}
                            target="_blank"
                            className="flex items-center gap-1 text-charcoal/50 hover:text-copper"
                            title={isAr ? 'فتح سجل العميل' : 'Open client record'}
                          >
                            <User size={13} /> <ExternalLink size={11} />
                          </Link>
                        )}
                      </span>
                    </div>

                    {/* Summary + reason */}
                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                      <div className="rounded-xl bg-cream/60 p-3">
                        <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-charcoal/50">
                          {isAr ? 'ملخص المحادثة' : 'Chat summary'}
                        </div>
                        <p className="whitespace-pre-line text-sm leading-relaxed text-charcoal">{r.chat_summary}</p>
                      </div>
                      <div className="rounded-xl bg-cream/60 p-3">
                        <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-charcoal/50">
                          {isAr ? 'لماذا هذه الرسالة' : 'Why this message'}
                        </div>
                        <p className="whitespace-pre-line text-sm leading-relaxed text-charcoal">{r.reason}</p>
                      </div>
                    </div>

                    {/* Suggested message */}
                    <div className="mt-3">
                      <div className="mb-1 flex items-center justify-between text-[11px] font-bold uppercase tracking-wide text-charcoal/50">
                        <span>{isAr ? 'الرسالة المقترحة (قابلة للتعديل)' : 'Suggested message (editable)'}</span>
                        {r.status === 'sent' && r.final_message && r.final_message !== r.suggested_message && (
                          <span className="normal-case text-copper">{isAr ? 'أُرسلت بنص معدّل' : 'Sent with edits'}</span>
                        )}
                      </div>
                      {r.status === 'pending' ? (
                        <textarea
                          value={textOf(r)}
                          onChange={(e) => setEdits((prev) => ({ ...prev, [r.id]: e.target.value }))}
                          onBlur={() => commitEdit(r)}
                          rows={Math.min(8, Math.max(3, textOf(r).split('\n').length + 1))}
                          dir="auto"
                          className="w-full rounded-xl border border-sand/30 bg-white p-3 text-sm leading-relaxed text-charcoal focus:outline-none focus:ring-2 focus:ring-copper/30"
                        />
                      ) : (
                        <p dir="auto" className="whitespace-pre-line rounded-xl border border-sand/20 bg-cream/40 p-3 text-sm leading-relaxed text-charcoal">
                          {r.final_message ?? r.suggested_message}
                        </p>
                      )}
                    </div>

                    {/* Rep note */}
                    <input
                      defaultValue={r.rep_note ?? ''}
                      onBlur={(e) => { if ((e.target.value || '') !== (r.rep_note ?? '')) void saveNote(r.id, e.target.value); }}
                      placeholder={isAr ? 'ملاحظة داخلية (اختياري)' : 'Internal note (optional)'}
                      className="mt-2 w-full rounded-lg border border-transparent bg-transparent px-2 py-1 text-xs text-charcoal/70 hover:border-sand/30 focus:border-sand/40 focus:outline-none"
                    />

                    {/* Actions */}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {r.status === 'pending' && (
                        <>
                          <Button onClick={() => openChat(r)}>
                            <MessageCircle size={15} />
                            {isAr ? 'افتح المحادثة وأرسل' : 'Open chat & send'}
                          </Button>
                          <Button variant="ghost" onClick={() => void doDismiss(r)}>
                            <XCircle size={15} />
                            {isAr ? 'تجاهل' : 'Dismiss'}
                          </Button>
                        </>
                      )}
                      {r.status === 'sent' && (
                        <span className="flex items-center gap-1 text-xs font-bold text-[#0f7a52]">
                          <CheckCheck size={14} />
                          {isAr ? `أُرسلت ${fmtDate(r.sent_at, true)}` : `Sent ${fmtDate(r.sent_at, false)}`}
                        </span>
                      )}
                      {r.status === 'dismissed' && (
                        <span className="text-xs text-charcoal/60">
                          {isAr ? 'مُتجاهلة' : 'Dismissed'}{r.dismiss_reason ? ` — ${r.dismiss_reason}` : ''}
                        </span>
                      )}
                      {r.status !== 'pending' && (
                        <Button variant="ghost" onClick={() => void restore(r.id)}>
                          <Undo2 size={14} />
                          {isAr ? 'إرجاع للقائمة' : 'Back to pending'}
                        </Button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ))}

      {/* Chat popup + the review strip above it */}
      {open && (
        <>
          <ChatThreadModal recordId={open.suggestion.chat_record_id} onClose={() => setOpen(null)} />
          <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex justify-center px-3">
            <div className={`pointer-events-auto flex max-w-2xl flex-wrap items-center gap-3 rounded-xl px-4 py-2 text-sm shadow-lg ${
              open.sent ? 'bg-[#10B981] text-white' : 'bg-charcoal text-white'
            }`}>
              {open.sent ? (
                <>
                  <CheckCheck size={16} />
                  <span>{isAr ? 'تم تسجيل الإرسال. أغلق النافذة متى شئت.' : 'Recorded as sent. Close whenever you like.'}</span>
                </>
              ) : (
                <>
                  <Sparkles size={16} />
                  <span>
                    {isAr
                      ? 'الرسالة المقترحة جاهزة في صندوق الكتابة — اقرأ المحادثة، عدّلها إن لزم، ثم أرسل.'
                      : 'The suggested message is in the composer — read the chat, edit if needed, then send.'}
                  </span>
                  <button
                    onClick={() => void manualSent()}
                    className="rounded-lg bg-white/15 px-2 py-1 text-xs font-bold hover:bg-white/25"
                    title={isAr ? 'إذا أرسلت من مكان آخر' : 'If you sent it elsewhere'}
                  >
                    {isAr ? 'سجّلها كمرسلة' : 'Mark as sent'}
                  </button>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
