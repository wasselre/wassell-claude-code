import { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck, Loader2, Sparkles, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord } from '@/types';
import { getFollowUpTypeConfig, getOutcome } from '@/lib/salesProcess';
import { readFollowupType } from '@/pages/Followups/lib/followupContext';
import {
  fetchReadyChatSuggestion,
  resolveChatSuggestion,
  subscribeChatSuggestions,
  type ChatOutcomeSuggestion,
} from '@/lib/chatSuggestions/client';

/**
 * ChatTaskBar — the client's open follow-up, shown where the rep actually works.
 *
 * WHY
 *   Measured 2026-09-27: 6 in 7 follow-ups closed without an outcome, because
 *   the outcome picker lived on a separate screen and reps work in the chat.
 *   This bar keeps the task in view under the chat header and, when the AI has
 *   read the conversation (chat_outcome_suggestions), shows its proposed
 *   outcome for a one-tap confirm. Confirming opens the normal completion modal
 *   with the answer pre-selected — the follow-up is completed through the same
 *   path as everywhere else, so the outcome workflows fire exactly once.
 *
 * A suggestion is only shown while it targets THIS task: if the task was
 * completed or replaced since the AI read the chat, the proposal is stale.
 */
export default function ChatTaskBar({
  clientId,
  task,
  onRecordOutcome,
}: {
  clientId: string;
  task: AppRecord;
  /**
   * Open the completion modal. `suggestion` travels with it either way so the
   * rep's final choice is recorded against the proposal (the accuracy ledger);
   * `preselect` decides whether the AI's answer starts selected.
   */
  onRecordOutcome: (suggestion: ChatOutcomeSuggestion | null, preselect: boolean) => void;
}) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const [suggestion, setSuggestion] = useState<ChatOutcomeSuggestion | null>(null);
  const [dismissing, setDismissing] = useState(false);

  const reload = useCallback(() => {
    fetchReadyChatSuggestion(clientId)
      .then(setSuggestion)
      .catch((e: Error) => {
        addToast(isAr ? `تعذّر تحميل اقتراح النتيجة: ${e.message}` : `Could not load the outcome suggestion: ${e.message}`, 'error');
      });
  }, [clientId, addToast, isAr]);

  useEffect(() => {
    setSuggestion(null);
    reload();
    return subscribeChatSuggestions(clientId, reload);
  }, [clientId, reload]);

  const d = task.data as Record<string, unknown>;
  const typeKey = readFollowupType(d);
  const typeCfg = getFollowUpTypeConfig(typeKey);
  const typeLabel = typeCfg ? (isAr ? typeCfg.label_ar : typeCfg.label_en) : (typeKey ?? '');

  const waState = typeof d.whatsapp_state === 'string' ? d.whatsapp_state : null;
  const stateLabel =
    waState === 'replied'
      ? (isAr ? 'العميل ردّ' : 'Client replied')
      : waState === 'message_sent_waiting_response'
        ? (isAr ? 'بانتظار رد العميل' : 'Waiting for reply')
        : null;

  const due = typeof d.scheduled_datetime === 'string' ? new Date(d.scheduled_datetime) : null;
  const dueLabel = due && !Number.isNaN(due.getTime())
    ? due.toLocaleString(isAr ? 'ar-SA' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' })
    : null;

  const fromType = typeof d.handed_over_from_type === 'string' ? d.handed_over_from_type : null;
  const fromCfg = fromType ? getFollowUpTypeConfig(fromType) : undefined;
  const fromLabel = fromCfg ? (isAr ? fromCfg.label_ar : fromCfg.label_en) : null;

  const live = suggestion && suggestion.followup_id === task.id && suggestion.suggested_outcome ? suggestion : null;
  const outcome = live ? getOutcome(live.suggested_outcome) : undefined;
  const outcomeLabel = outcome ? (isAr ? outcome.label_ar : outcome.label_en) : live?.suggested_outcome ?? '';

  const dismiss = async () => {
    if (!live) return;
    setDismissing(true);
    try {
      await resolveChatSuggestion(live.id, 'dismissed');
      setSuggestion(null);
    } catch (e) {
      addToast(isAr ? `تعذّر حفظ الرفض: ${(e as Error).message}` : `Could not save: ${(e as Error).message}`, 'error');
    } finally {
      setDismissing(false);
    }
  };

  return (
    <div className="shrink-0 border-b border-sand/30 bg-cream/40 px-3 py-2 md:px-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-chocolate">
          <ClipboardCheck size={14} className="text-copper" />
          {isAr ? 'المهمة الحالية:' : 'Current task:'} {typeLabel}
        </span>
        {stateLabel && (
          <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${waState === 'replied' ? 'bg-[#10B981]/15 text-[#0F7A55]' : 'bg-sand/50 text-charcoal/70'}`}>
            {stateLabel}
          </span>
        )}
        {dueLabel && (
          <span className="text-[11px] text-charcoal/60">
            {isAr ? 'الموعد: ' : 'Due: '}{dueLabel}
          </span>
        )}
        {fromLabel && (
          <span className="text-[11px] text-charcoal/60">
            {isAr ? `استُلمت من: ${fromLabel}` : `Picked up from: ${fromLabel}`}
          </span>
        )}
        {!live && (
          <button
            type="button"
            onClick={() => onRecordOutcome(null, false)}
            className="ms-auto rounded-lg border border-copper/50 px-2.5 py-1 text-xs font-semibold text-copper hover:bg-copper/10"
          >
            {isAr ? 'تسجيل النتيجة' : 'Record outcome'}
          </button>
        )}
      </div>

      {live && (
        <div className="mt-2 rounded-xl border border-copper/40 bg-white p-2.5">
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-copper">
                <Sparkles size={14} />
                {isAr ? 'النتيجة المقترحة:' : 'Suggested outcome:'}
                <span className="text-chocolate">{outcomeLabel}</span>
                {typeof live.confidence === 'number' && (
                  <span className="text-xs font-normal text-charcoal/60">· {live.confidence}%</span>
                )}
              </p>
              {live.reasoning && <p className="mt-0.5 text-xs text-charcoal/80">{live.reasoning}</p>}
              {live.quoted_phrase && (
                <p className="mt-0.5 text-[11px] text-charcoal/60">«{live.quoted_phrase}»</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => onRecordOutcome(live, true)}
                className="rounded-lg bg-copper px-3 py-1.5 text-xs font-bold text-white hover:bg-terracotta"
              >
                {isAr ? 'تأكيد النتيجة' : 'Confirm outcome'}
              </button>
              <button
                type="button"
                onClick={() => onRecordOutcome(live, false)}
                className="rounded-lg border border-sand px-2.5 py-1.5 text-xs font-semibold text-charcoal/70 hover:bg-sand/30"
              >
                {isAr ? 'اختيار نتيجة أخرى' : 'Pick another'}
              </button>
              <button
                type="button"
                onClick={() => void dismiss()}
                disabled={dismissing}
                className="rounded-lg p-1.5 text-charcoal/50 hover:bg-sand/40 hover:text-charcoal disabled:opacity-40"
                title={isAr ? 'الاقتراح غير صحيح — إخفاؤه' : 'Suggestion is wrong — hide it'}
                aria-label={isAr ? 'إخفاء الاقتراح' : 'Hide suggestion'}
              >
                {dismissing ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
