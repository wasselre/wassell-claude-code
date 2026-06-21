import { useState } from 'react';
import { ThumbsUp, ThumbsDown, Check } from 'lucide-react';
import { FEEDBACK_INTENTS, type MessageFeedbackData } from '@/lib/matching/telemetry';

/**
 * Lightweight per-answer feedback. 👍 saves immediately. 👎 reveals "what were
 * you trying to do?" (the intents) plus an optional one-line note, so we learn
 * which capability the rep wanted but didn't get. Stored inline on the message.
 */
export default function MessageFeedback({
  isAr,
  value,
  onSubmit,
}: {
  isAr: boolean;
  value?: MessageFeedbackData;
  onSubmit: (fb: MessageFeedbackData) => void;
}) {
  const L = (ar: string, en: string) => (isAr ? ar : en);
  const [expanded, setExpanded] = useState(false);
  const [comment, setComment] = useState('');

  // Already rated → compact acknowledgement.
  if (value) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-charcoal/40 ps-1 mt-0.5">
        {value.rating === 'up' ? <ThumbsUp size={11} className="text-green-600" /> : <ThumbsDown size={11} className="text-charcoal/40" />}
        <span>{L('شكراً على ملاحظتك', 'Thanks for the feedback')}</span>
      </div>
    );
  }

  function rate(rating: 'up' | 'down', intent?: string) {
    onSubmit({ rating, intent, comment: comment.trim() || undefined, at: new Date().toISOString() });
  }

  return (
    <div className="ps-1 mt-0.5">
      {!expanded ? (
        <div className="flex items-center gap-2 text-charcoal/35">
          <button type="button" onClick={() => rate('up')} title={L('مفيد', 'Helpful')} className="hover:text-green-600 transition-colors">
            <ThumbsUp size={13} />
          </button>
          <button type="button" onClick={() => setExpanded(true)} title={L('غير مفيد', 'Not helpful')} className="hover:text-red-500 transition-colors">
            <ThumbsDown size={13} />
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-sand/40 bg-cream/30 p-2 max-w-[80%] space-y-1.5">
          <div className="text-[11px] font-bold text-charcoal/60">{L('وش كنت تحاول تسوي؟', 'What were you trying to do?')}</div>
          <div className="flex flex-wrap gap-1">
            {FEEDBACK_INTENTS.map((it) => (
              <button
                key={it.value}
                type="button"
                onClick={() => rate('down', it.value)}
                className="px-2 py-0.5 rounded-full border border-sand/50 text-[11px] text-charcoal/70 hover:bg-copper/10 hover:border-copper/40 transition-colors"
              >
                {isAr ? it.ar : it.en}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={L('ملاحظة (اختياري)', 'Note (optional)')}
              className="flex-1 rounded-md border border-sand/40 outline-none focus:border-primary px-2 py-1 text-[11px] bg-white"
            />
            <button
              type="button"
              onClick={() => rate('down')}
              title={L('إرسال', 'Send')}
              className="p-1 rounded-md bg-copper text-white hover:bg-terracotta transition-colors"
            >
              <Check size={12} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
