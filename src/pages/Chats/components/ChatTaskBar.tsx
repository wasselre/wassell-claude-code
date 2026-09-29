import { ClipboardCheck, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import { getFollowUpTypeConfig } from '@/lib/salesProcess';
import type { ChatOutcomeSuggestion } from '@/lib/chatSuggestions/client';
import { outcomeLabel, taskTypeLabel } from '../lib/useChatOutcomeSuggestion';

/**
 * ChatTaskBar — the client's open follow-up, shown where the rep actually works.
 *
 * WHY
 *   Measured 2026-09-27: 6 in 7 follow-ups closed without an outcome, because
 *   the outcome picker lived on a separate screen and reps work in the chat.
 *   This bar keeps the task in view under the chat header. Recording the
 *   outcome opens the normal completion modal — the follow-up is completed
 *   through the same path as everywhere else, so the outcome workflows fire
 *   exactly once.
 *
 * Since 2026-09-29 the AI's suggested outcome (chat_outcome_suggestions) lives
 * in the «النتائج» tab of the «اقتراحات الذكاء الاصطناعي» card; this bar only
 * shows a compact chip «✨ نتيجة مقترحة: …» that opens that tab. The
 * suggestion is loaded ONCE per chat (useChatOutcomeSuggestion in ChatDetail)
 * and passed in; `live` is already filtered to THIS task.
 */
export default function ChatTaskBar({
  task,
  live,
  onRecordOutcome,
  onShowSuggestion,
}: {
  task: AppRecord;
  /** The AI's suggestion for THIS task, or null. */
  live: ChatOutcomeSuggestion | null;
  /** Open the completion modal without a suggestion (no live one). */
  onRecordOutcome: (suggestion: ChatOutcomeSuggestion | null, preselect: boolean) => void;
  /** Bring the AI card's «النتائج» tab into view. */
  onShowSuggestion: () => void;
}) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const { t } = useTranslation();

  const d = task.data as Record<string, unknown>;
  const typeLabel = taskTypeLabel(task, isAr);

  const waState = typeof d.whatsapp_state === 'string' ? d.whatsapp_state : null;
  const stateLabel =
    waState === 'replied'
      ? t('chats.task.state_replied')
      : waState === 'message_sent_waiting_response'
        ? t('chats.task.state_waiting')
        : null;

  const due = typeof d.scheduled_datetime === 'string' ? new Date(d.scheduled_datetime) : null;
  const dueLabel = due && !Number.isNaN(due.getTime())
    ? due.toLocaleString(isAr ? 'ar-SA' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' })
    : null;

  const fromType = typeof d.handed_over_from_type === 'string' ? d.handed_over_from_type : null;
  const fromCfg = fromType ? getFollowUpTypeConfig(fromType) : undefined;
  const fromLabel = fromCfg ? (isAr ? fromCfg.label_ar : fromCfg.label_en) : null;

  return (
    <div className="shrink-0 border-b border-sand/30 bg-cream/40 px-3 py-2 md:px-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-chocolate">
          <ClipboardCheck size={14} className="text-copper" />
          {t('chats.task.current', { type: typeLabel })}
        </span>
        {stateLabel && (
          <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${waState === 'replied' ? 'bg-[#10B981]/15 text-[#0F7A55]' : 'bg-sand/50 text-charcoal/70'}`}>
            {stateLabel}
          </span>
        )}
        {dueLabel && (
          <span className="text-[11px] text-charcoal/60">
            {t('chats.task.due', { when: dueLabel })}
          </span>
        )}
        {fromLabel && (
          <span className="text-[11px] text-charcoal/60">
            {t('chats.task.picked_up_from', { type: fromLabel })}
          </span>
        )}
        {live ? (
          <button
            type="button"
            onClick={onShowSuggestion}
            className="ms-auto inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-copper/60 bg-white px-2.5 py-1 text-xs font-semibold text-copper hover:bg-copper/10"
            title={t('chats.task.suggested_open')}
          >
            <Sparkles size={12} className="shrink-0" />
            <span className="truncate">{t('chats.task.suggested_chip', { outcome: outcomeLabel(live, isAr) })}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onRecordOutcome(null, false)}
            className="ms-auto rounded-lg border border-copper/50 px-2.5 py-1 text-xs font-semibold text-copper hover:bg-copper/10"
          >
            {t('chats.task.record_outcome')}
          </button>
        )}
      </div>
    </div>
  );
}
