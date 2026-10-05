import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, CheckCircle2, Loader2, MessageSquarePlus, Star, Trash2, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import Button from '@/components/ui/Button';
import MessageThread from '@/pages/Chats/components/MessageThread';
import type { ChatMessage } from '@/types';
import type { AiChatReview } from '../lib/useAiChatReviews';
import { useAiChatReviewDetail, type ReviewCardKey } from '../lib/useAiChatReviewDetail';
import type { ReviewMessage } from '../lib/reviewHighlight';
import AiReviewCards from './AiReviewCards';

/**
 * The AI chat review pop-up (operator, 2026-10-05):
 *   · the whole chat — click messages to select them, then write a note on
 *     exactly those messages; or write a general note with nothing selected.
 *     Any number of notes; a note's messages light up when you click it.
 *   · what the AI DID — places, other preferences, portal registration, visits
 *     — each accepted, or rejected with a correction and a reason.
 *   · the overall 1–5 rating that closes the review.
 */

const EMPTY_MSGS: ChatMessage[] = [];

export default function AiChatReviewModal({
  review, name, isAr, onClose, onSubmit,
}: {
  review: AiChatReview;
  name: string;
  isAr: boolean;
  onClose: () => void;
  onSubmit: (rating: number, note: string) => Promise<boolean>;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const addToast = useAppStore((s) => s.addToast);
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const chatMessages = useAppStore((s) => s.chatMessages[review.chat_wid] ?? EMPTY_MSGS);
  const { detail, loading, error, addNote, deleteNote, setCard } = useAiChatReviewDetail(review.id);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [highlight, setHighlight] = useState<{ key: string; ids: Set<string> } | null>(null);
  const [noteText, setNoteText] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [rating, setRating] = useState<number>(review.rating ?? 0);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const clientsModel = models.find((m) => m.name === 'clients');
  const client = review.client_id && clientsModel
    ? (records[clientsModel.id] ?? []).find((r) => r.id === review.client_id) : undefined;

  const messages: ReviewMessage[] = useMemo(() => chatMessages.map((m) => ({
    id: m.id, flow: m.flow, date: m.date, body: m.body, media_caption: m.media_caption, transcript: m.transcript,
  })), [chatMessages]);

  const noteCounts = useMemo(() => {
    const out = new Map<string, number>();
    for (const n of detail.notes) for (const id of n.message_ids) out.set(id, (out.get(id) ?? 0) + 1);
    return out;
  }, [detail.notes]);

  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const saveNote = async () => {
    if (!noteText.trim()) return;
    setSavingNote(true);
    try {
      await addNote([...selected], noteText.trim());
      setNoteText('');
      setSelected(new Set());
    } catch (e) {
      addToast(L(`تعذّر حفظ الملاحظة: ${(e as Error).message}`, `Could not save the note: ${(e as Error).message}`), 'error');
    } finally {
      setSavingNote(false);
    }
  };

  const removeNote = async (id: string) => {
    try {
      await deleteNote(id);
      if (highlight?.key === `note:${id}`) setHighlight(null);
    } catch (e) {
      addToast(L(`تعذّر الحذف: ${(e as Error).message}`, `Could not delete: ${(e as Error).message}`), 'error');
    }
  };

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const ok = await onSubmit(rating, '');
      if (!ok) setErr(L('لم يُحفظ — قد تكون المراجعة لشخص آخر.', 'Not saved — this review may belong to someone else.'));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const onCardHighlight = (card: ReviewCardKey | null, ids: Set<string>) => {
    if (!card) { setHighlight(null); return; }
    setHighlight({ key: `card:${card}`, ids });
    if (ids.size === 0) addToast(L('لم أجد في المحادثة رسالة مطابقة لهذه البطاقة.', 'No matching message found in the chat for this card.'), 'info');
  };

  const fmt = (iso: string) => new Date(iso).toLocaleString(isAr ? 'ar-SA-u-nu-latn' : 'en-GB', {
    timeZone: 'Asia/Riyadh', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      dir={isAr ? 'rtl' : 'ltr'}
      className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/40 p-2 sm:p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex h-[94vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-sand/40 px-4 py-3">
          <Bot size={18} className="text-copper" />
          <span className="flex-1 font-bold text-chocolate">{name}</span>
          <button type="button" onClick={onClose} aria-label={L('إغلاق', 'Close')}
            className="rounded-lg p-1.5 text-charcoal/50 hover:bg-cream hover:text-charcoal">
            <X size={16} />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_420px] lg:grid-rows-1">
          {/* The chat */}
          <div className="flex min-h-0 flex-col border-b border-sand/40 lg:border-b-0 lg:border-e">
            <div className="flex shrink-0 flex-wrap items-center gap-2 bg-cream/60 px-3 py-1.5 text-xs text-charcoal/70">
              {selected.size > 0 ? (
                <>
                  <span className="font-bold text-copper">{L(`${selected.size} رسالة محددة`, `${selected.size} selected`)}</span>
                  <button type="button" onClick={() => setSelected(new Set())} className="text-charcoal/60 underline">{L('إلغاء التحديد', 'Clear')}</button>
                </>
              ) : (
                <span>{L('اضغط على رسالة لتحديدها وكتابة ملاحظة عليها', 'Click a message to select it and write a note on it')}</span>
              )}
              {highlight && (
                <button type="button" onClick={() => setHighlight(null)} className="ms-auto rounded bg-gold/30 px-2 py-0.5 font-bold text-[#8a6a2f]">
                  {L('إخفاء التمييز', 'Clear highlight')}
                </button>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-hidden px-3 pt-2">
              <MessageThread
                chatWid={review.chat_wid}
                review={{ onToggle: toggle, selected, highlighted: highlight?.ids, noteCounts }}
              />
            </div>
          </div>

          {/* The review */}
          <div className="min-h-0 space-y-4 overflow-y-auto p-3">
            {/* Notes */}
            <section className="space-y-2">
              <h3 className="text-sm font-bold text-chocolate">{L('ملاحظات المراجعة', 'Review notes')}</h3>
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                rows={2}
                dir="auto"
                maxLength={2000}
                placeholder={selected.size > 0
                  ? L(`ملاحظة على ${selected.size} رسالة محددة…`, `A note on the ${selected.size} selected message(s)…`)
                  : L('ملاحظة عامة على المحادثة (أو حدّد رسائل أولاً)…', 'A general note on the chat (or select messages first)…')}
                className="form-input w-full resize-y text-sm"
              />
              <Button className="!px-3 !py-1.5 !text-xs !rounded-lg !gap-1" disabled={savingNote || !noteText.trim()} onClick={() => void saveNote()}>
                {savingNote ? <Loader2 size={12} className="animate-spin" /> : <MessageSquarePlus size={12} />}
                {selected.size > 0 ? L('أضف الملاحظة على الرسائل', 'Add note on the messages') : L('أضف ملاحظة عامة', 'Add general note')}
              </Button>
              {detail.notes.length > 0 && (
                <ul className="space-y-1.5">
                  {detail.notes.map((n) => {
                    const key = `note:${n.id}`;
                    const on = highlight?.key === key;
                    return (
                      <li key={n.id} className={`flex items-start gap-2 rounded-xl border p-2 text-xs ${on ? 'border-gold bg-gold/10' : 'border-sand bg-cream/40'}`}>
                        <button
                          type="button"
                          disabled={n.message_ids.length === 0}
                          onClick={() => setHighlight(on ? null : { key, ids: new Set(n.message_ids) })}
                          className="min-w-0 flex-1 text-start disabled:cursor-default"
                        >
                          <span className="mb-0.5 block text-[10.5px] font-bold text-copper">
                            {n.message_ids.length > 0 ? L(`على ${n.message_ids.length} رسالة`, `On ${n.message_ids.length} message(s)`) : L('ملاحظة عامة', 'General note')}
                            <span className="font-normal text-charcoal/45"> · {fmt(n.created_at)}</span>
                          </span>
                          <span className="whitespace-pre-wrap text-charcoal" dir="auto">{n.note}</span>
                        </button>
                        <button type="button" onClick={() => void removeNote(n.id)} aria-label={L('حذف', 'Delete')}
                          className="shrink-0 rounded p-1 text-charcoal/40 hover:bg-terracotta/10 hover:text-terracotta">
                          <Trash2 size={12} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* What the AI did */}
            <section className="space-y-2">
              <h3 className="text-sm font-bold text-chocolate">{L('ما قام به المساعد', 'What the AI did')}</h3>
              {error && <p className="rounded-xl bg-terracotta/10 p-2 text-xs text-terracotta">{L(`تعذّر التحميل: ${error}`, `Could not load: ${error}`)}</p>}
              {loading && detail.changes.length === 0 && detail.portals.length === 0 && detail.bookings.length === 0 ? (
                <p className="flex items-center gap-2 text-xs text-charcoal/60"><Loader2 size={12} className="animate-spin" /> {L('جارٍ التحميل…', 'Loading…')}</p>
              ) : (
                <AiReviewCards
                  detail={detail}
                  client={client}
                  messages={messages}
                  isAr={isAr}
                  activeCard={highlight?.key.startsWith('card:') ? (highlight.key.slice(5) as ReviewCardKey) : null}
                  onHighlight={onCardHighlight}
                  setCard={setCard}
                />
              )}
            </section>

            {/* Overall rating */}
            <section className="space-y-2 border-t border-sand/40 pt-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-bold text-chocolate">{L('التقييم العام للمساعد:', 'Overall rating:')}</span>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} type="button" onClick={() => setRating(n)} className="p-0.5" aria-label={`${n}/5`}>
                    <Star size={22} className={n <= rating ? 'fill-gold text-gold' : 'text-sand'} />
                  </button>
                ))}
              </div>
              {err && <p className="text-sm text-terracotta">{err}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={onClose} disabled={saving}>{L('إغلاق', 'Close')}</Button>
                <Button onClick={() => void save()} disabled={saving || rating === 0}>
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                  {L('إنهاء المراجعة', 'Finish review')}
                </Button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
