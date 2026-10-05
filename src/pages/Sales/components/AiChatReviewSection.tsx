import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Bot, CheckCircle2, Loader2, Star, X } from 'lucide-react';
import type { AppRecord } from '@/types';
import Button from '@/components/ui/Button';
import MessageThread from '@/pages/Chats/components/MessageThread';
import type { AiChatReview } from '../lib/useAiChatReviews';

/**
 * «مراجعة أداء المساعد في واتساب» — the agent's daily review of the AI's
 * WhatsApp work (operator, 2026-10-05). One row per client chat the AI replied
 * in since the last review; open it, read the whole chat, rate 1–5, note any
 * issue, done.
 */
export default function AiChatReviewSection({
  reviews, clientsById, isAr, loading, error, onSubmit,
}: {
  reviews: AiChatReview[];
  clientsById: Map<string, AppRecord>;
  isAr: boolean;
  loading: boolean;
  error: string | null;
  onSubmit: (id: string, rating: number, note: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState<AiChatReview | null>(null);
  const pending = reviews.filter((r) => r.status === 'pending');
  const done = reviews.filter((r) => r.status === 'done');

  const nameOf = (r: AiChatReview): string => {
    const c = r.client_id ? clientsById.get(r.client_id) : undefined;
    const n = c?.data.client_name;
    return typeof n === 'string' && n.trim() ? n : `+${r.chat_wid.split('@')[0]}`;
  };
  const when = (iso: string | null) => (iso
    ? new Date(iso).toLocaleString(isAr ? 'ar-SA' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' })
    : '');

  const row = (r: AiChatReview) => (
    <li key={r.id}>
      <button
        type="button"
        onClick={() => setOpen(r)}
        className="flex w-full items-center gap-3 rounded-xl border border-sand bg-white px-4 py-3 text-start hover:bg-cream"
      >
        <Bot size={18} className="shrink-0 text-copper" />
        <span className="min-w-0 flex-1">
          <span className="block font-bold text-chocolate">{nameOf(r)}</span>
          <span className="block text-xs text-charcoal/60">
            {isAr ? `${r.ai_messages} رسالة من المساعد · آخرها ${when(r.last_ai_at)}` : `${r.ai_messages} AI messages · last ${when(r.last_ai_at)}`}
          </span>
        </span>
        {r.status === 'done' ? (
          <span className="inline-flex items-center gap-1 text-xs font-bold text-[#0F7A55]">
            <CheckCircle2 size={14} /> {r.rating}/5
          </span>
        ) : (
          <span className="rounded-lg bg-copper px-3 py-1 text-xs font-bold text-white">{isAr ? 'مراجعة' : 'Review'}</span>
        )}
      </button>
    </li>
  );

  return (
    <section>
      <p className="mb-4 rounded-xl bg-cream px-4 py-2.5 text-xs text-charcoal/70">
        {isAr
          ? 'المحادثات التي رد فيها المساعد الذكي منذ آخر مراجعة. افتح كل محادثة، اقرأها كاملة، وقيّم أداء المساعد مع ملاحظة إن وُجدت مشكلة.'
          : 'Chats the AI agent replied in since the last review. Open each one, read it, and rate the agent — add a note if something was wrong.'}
      </p>
      {error && <p className="mb-3 rounded-xl bg-terracotta/10 px-4 py-2 text-sm text-terracotta">{error}</p>}
      {loading && reviews.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-charcoal/60"><Loader2 size={14} className="animate-spin" /> {isAr ? 'جارٍ التحميل…' : 'Loading…'}</p>
      ) : pending.length === 0 && done.length === 0 ? (
        <p className="rounded-2xl bg-cream p-5 text-center text-sm text-charcoal/60">
          {isAr ? 'لا توجد محادثات للمراجعة.' : 'No chats to review.'}
        </p>
      ) : (
        <>
          {pending.length > 0 && <ul className="space-y-2">{pending.map(row)}</ul>}
          {done.length > 0 && (
            <>
              <h3 className="mb-2 mt-6 text-sm font-bold text-charcoal/60">{isAr ? 'تمت مراجعتها' : 'Reviewed'}</h3>
              <ul className="space-y-2">{done.map(row)}</ul>
            </>
          )}
        </>
      )}
      {open && (
        <ReviewModal
          review={open}
          name={nameOf(open)}
          isAr={isAr}
          onClose={() => setOpen(null)}
          onSubmit={async (rating, note) => {
            const ok = await onSubmit(open.id, rating, note);
            if (ok) setOpen(null);
            return ok;
          }}
        />
      )}
    </section>
  );
}

function ReviewModal({
  review, name, isAr, onClose, onSubmit,
}: {
  review: AiChatReview;
  name: string;
  isAr: boolean;
  onClose: () => void;
  onSubmit: (rating: number, note: string) => Promise<boolean>;
}) {
  const [rating, setRating] = useState<number>(review.rating ?? 0);
  const [note, setNote] = useState<string>(review.note ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const ok = await onSubmit(rating, note);
      if (!ok) setErr(isAr ? 'لم يُحفظ — قد تكون المراجعة لشخص آخر.' : 'Not saved — this review may belong to someone else.');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      dir={isAr ? 'rtl' : 'ltr'}
      className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex h-[90vh] max-h-[900px] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-sand/40 px-4 py-3">
          <Bot size={18} className="text-copper" />
          <span className="flex-1 font-bold text-chocolate">{name}</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-charcoal/50 hover:bg-cream hover:text-charcoal"
            aria-label={isAr ? 'إغلاق' : 'Close'}
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden px-3 pt-3">
          <MessageThread chatWid={review.chat_wid} />
        </div>
        <div className="shrink-0 space-y-3 border-t border-sand/40 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-chocolate">{isAr ? 'تقييم أداء المساعد:' : 'Rate the AI agent:'}</span>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setRating(n)}
                className="p-0.5"
                aria-label={`${n}/5`}
              >
                <Star size={22} className={n <= rating ? 'fill-gold text-gold' : 'text-sand'} />
              </button>
            ))}
          </div>
          <textarea
            id="ai-review-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder={isAr ? 'ملاحظة (اختياري) — ما المشكلة إن وُجدت؟' : 'Note (optional) — what went wrong, if anything?'}
            className="w-full rounded-lg border border-sand px-3 py-2 text-sm focus:border-copper focus:outline-none"
          />
          {err && <p className="text-sm text-terracotta">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={saving}>{isAr ? 'إغلاق' : 'Close'}</Button>
            <Button onClick={() => void save()} disabled={saving || rating === 0}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {isAr ? 'حفظ المراجعة' : 'Save review'}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
