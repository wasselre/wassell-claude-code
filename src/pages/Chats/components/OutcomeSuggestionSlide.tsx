import { useLayoutEffect, useRef, useState } from 'react';
import { Check, Loader2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Button from '@/components/ui/Button';
import type { AppRecord } from '@/types';
import type { ChatOutcomeSuggestion } from '@/lib/chatSuggestions/client';
import { pct } from '@/pages/Marketing/lib/format';
import { SlideBody } from './SlideParts';
import { outcomeLabel, taskTypeLabel } from '../lib/useChatOutcomeSuggestion';

/**
 * The «النتائج» tab of the «اقتراحات الذكاء الاصطناعي» card: the AI's proposed
 * outcome for the client's current follow-up, in the same frame as the
 * preference slides.
 *
 * Same semantics as the task bar's old suggestion box: «تأكيد النتيجة» opens the
 * completion modal with the AI's answer pre-selected, «اختيار نتيجة أخرى» opens
 * it without — both carry the suggestion so the rep's final choice is recorded
 * against it (the accuracy ledger) — and «تجاهل» resolves it 'dismissed'.
 */

const BTN = '!px-3 !py-1 !text-[11px] !rounded-full !gap-1';

export default function OutcomeSuggestionSlide({ live, task, dismissing, onDismiss, onRecordOutcome, isAr }: {
  live: ChatOutcomeSuggestion | null;
  task: AppRecord | null;
  dismissing: boolean;
  onDismiss: () => void;
  onRecordOutcome: (suggestion: ChatOutcomeSuggestion | null, preselect: boolean) => void;
  isAr: boolean;
}) {
  const { t } = useTranslation();
  const [showReason, setShowReason] = useState(false);
  const [reasonClipped, setReasonClipped] = useState(false);
  const reasonEl = useRef<HTMLParagraphElement>(null);
  const reasonText = live?.reasoning ?? null;

  // «المزيد» only when the one-line reasoning is actually cut off.
  useLayoutEffect(() => {
    const el = reasonEl.current;
    if (!el || showReason) return;
    const measure = () => setReasonClipped(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [reasonText, showReason]);

  if (!live) {
    return (
      <div className="flex min-h-[48px] flex-col items-center justify-center gap-1.5 py-2 text-center">
        <p className="text-[11px] text-charcoal/55">{t('chats.ai.outcome_none')}</p>
        {task && (
          <button
            type="button"
            onClick={() => onRecordOutcome(null, false)}
            className="rounded-lg border border-copper/50 px-2.5 py-1 text-xs font-semibold text-copper hover:bg-copper/10"
          >
            {t('chats.task.record_outcome')}
          </button>
        )}
      </div>
    );
  }

  const label = outcomeLabel(live, isAr);
  const reason = live.reasoning?.trim() || null;
  const quote = live.quoted_phrase?.trim() || null;

  return (
    <SlideBody
      footer={(
        <div className="flex flex-wrap items-center gap-1.5">
          <Button className={BTN} onClick={() => onRecordOutcome(live, true)}>
            <Check size={12} />
            {t('chats.ai.outcome_confirm')}
          </Button>
          <Button variant="secondary" className={BTN} onClick={() => onRecordOutcome(live, false)}>
            {t('chats.ai.outcome_pick_another')}
          </Button>
          <Button
            variant="ghost"
            className={BTN}
            onClick={onDismiss}
            disabled={dismissing}
            title={t('chats.ai.outcome_dismiss_hint')}
          >
            {dismissing && <Loader2 size={12} className="animate-spin" />}
            {t('chats.prefs.dismiss')}
          </Button>
        </div>
      )}
    >
      <div className="rounded-lg border border-copper bg-copper/5 px-2 py-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <Sparkles size={12} className="shrink-0 text-copper" />
          <span className="text-[11px] font-semibold text-copper">{t('chats.ai.outcome_heading')}</span>
          <span className="min-w-0 truncate text-[12px] font-bold text-chocolate" title={label} dir="auto">{label}</span>
          {typeof live.confidence === 'number' && (
            <span
              className="shrink-0 rounded-full bg-cream px-1.5 py-px text-[9.5px] font-bold leading-4 text-charcoal/60"
              title={t('chats.ai.outcome_confidence')}
            >
              {pct(live.confidence, isAr)}
            </span>
          )}
        </div>
        {task && (
          <p className="truncate text-[10.5px] leading-tight text-charcoal/50">
            {t('chats.ai.outcome_for_task', { type: taskTypeLabel(task, isAr) })}
          </p>
        )}
        {reason && (
          <div className="mt-0.5 flex items-start gap-1">
            <p
              ref={reasonEl}
              className={`min-w-0 flex-1 text-[11px] leading-snug text-charcoal/80 ${showReason ? 'whitespace-pre-line' : 'truncate'}`}
              title={showReason ? undefined : reason}
              dir="auto"
            >
              {reason}
            </p>
            {(reasonClipped || showReason) && (
              <button
                type="button"
                onClick={() => setShowReason((v) => !v)}
                className="shrink-0 text-[10.5px] font-semibold text-copper hover:underline"
                aria-expanded={showReason}
              >
                {showReason ? t('chats.ai.less') : t('chats.ai.more')}
              </button>
            )}
          </div>
        )}
        {quote && (
          <p className="truncate text-[11px] leading-tight text-charcoal/55" title={quote} dir="auto">«{quote}»</p>
        )}
      </div>
    </SlideBody>
  );
}
