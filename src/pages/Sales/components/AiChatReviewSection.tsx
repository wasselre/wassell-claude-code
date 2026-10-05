import { useState } from 'react';
import { Bot, CheckCircle2, Loader2 } from 'lucide-react';
import type { AppRecord } from '@/types';
import type { AiChatReview } from '../lib/useAiChatReviews';
import AiChatReviewModal from './AiChatReviewModal';

/**
 * «مراجعة أداء المساعد في واتساب» — the agent's daily review of the AI's
 * WhatsApp work (operator, 2026-10-05). One row per client chat the AI replied
 * in since the last review; open it (AiChatReviewModal): read the whole chat,
 * note individual messages, accept or correct what the AI did, rate 1–5, done.
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
        <AiChatReviewModal
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
