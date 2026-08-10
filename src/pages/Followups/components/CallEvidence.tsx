import { useEffect, useMemo, useRef } from 'react';
import { Check, Phone } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { CALL_MATCH_WINDOW_MINUTES, resolveCallForFollowup } from '@/lib/salesProcess/callMatch';
import type { AppRecord } from '@/types';

interface CallEvidenceProps {
  clientId: string | null;
  phones: string[];
  /** Current completed_by_call_id value. */
  value: string | null;
  /**
   * When the rep worked this task (`actual_datetime`). A call is accepted only
   * within CALL_MATCH_WINDOW_MINUTES of it; null falls back to now.
   */
  anchor: string | null;
  onAttach: (callRecordId: string | null) => void;
}

/**
 * Links the outbound phone_call that completed this follow-up — AUTOMATICALLY,
 * and only automatically. This is a status readout, not a control.
 *
 * WHY THERE IS NO MANUAL ATTACH (2026-08-10, at the user's instruction)
 *   A rep records the result of a call either while on it or moments after, so
 *   the only call that can be the right one is the one that just happened. The
 *   picker this component replaced listed the client's older calls for a manual
 *   attach — every entry it could ever offer was, by construction, a call from a
 *   different conversation. Repeatedly asking a rep to pick between wrong
 *   answers is how 27 production follow-ups ended up citing a call up to 87 days
 *   old as their completing evidence (see lib/salesProcess/callMatch).
 *
 * SO WHERE DOES THE LINK COME FROM?
 *   Two halves of the same 15-minute rule, and the rep touches neither:
 *     • Here — the call record already exists when the rep completes the task.
 *     • `tg_records_link_call_to_followup` — the recording lands AFTER the save
 *       (the common case: the call has not been written yet while the form is
 *       open). The trigger stamps both sides then.
 *   Nothing matching means no evidence is recorded, which is the honest answer;
 *   the attachment is a soft warning at completion, never a block.
 */
export default function CallEvidence({ clientId, phones, value, anchor, onAttach }: CallEvidenceProps) {
  const { models, records, language } = useAppStore();
  const isAr = language === 'ar';

  const calls = useMemo<readonly AppRecord[]>(() => {
    const model = models.find((m) => m.name === 'phone_calls');
    return model ? records[model.id] ?? [] : [];
  }, [models, records]);

  // The one call close enough in time to be THIS follow-up's call. Null when the
  // client's recent calls are all outside the window.
  const autoMatch = useMemo<AppRecord | null>(
    () => resolveCallForFollowup({ calls, clientId, phones, anchor }),
    [calls, clientId, phones, anchor],
  );

  // Link it as soon as one matches. The ref only guards against re-firing for a
  // match already handled; while nothing matches it stays false, so a call whose
  // record lands while the form is still open is picked up on the next store
  // update rather than being missed.
  const autoAttachedRef = useRef(false);
  useEffect(() => {
    if (autoAttachedRef.current) return;
    if (value) { autoAttachedRef.current = true; return; }
    if (autoMatch) {
      autoAttachedRef.current = true;
      onAttach(autoMatch.id);
    }
  }, [autoMatch, value, onAttach]);

  if (value) {
    const attached = calls.find((r) => r.id === value) ?? null;
    const raw = attached?.data.call_time;
    const d = typeof raw === 'string' ? new Date(raw) : null;
    const when = d && !Number.isNaN(d.getTime())
      ? d.toLocaleString(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'short', timeStyle: 'short' })
      : '';
    return (
      <div className="flex items-center gap-1.5 rounded-xl border border-[#10B981] bg-[#10B981]/10 px-3 py-2.5 text-sm font-semibold text-[#10B981]">
        <Check size={15} />
        {isAr ? 'تم إرفاق المكالمة تلقائيًا' : 'Call linked automatically'}
        {when ? <span className="font-normal text-charcoal" dir="ltr">· {when}</span> : null}
      </div>
    );
  }

  // Nothing linked yet: say what will happen, so an empty field doesn't read as
  // a bug — and so nobody goes looking for the attach button that used to be here.
  return (
    <p className="flex items-start gap-1.5 text-xs text-charcoal/60">
      <Phone size={13} className="mt-0.5 shrink-0" />
      {isAr
        ? `تُرفق المكالمة تلقائيًا — أي مكالمة صادرة لهذا العميل خلال ${CALL_MATCH_WINDOW_MINUTES} دقيقة من وقت الإكمال، حتى لو وصل تسجيلها بعد الحفظ.`
        : `The call is linked automatically — any outbound call to this client within ${CALL_MATCH_WINDOW_MINUTES} minutes of the completion time, even if its recording arrives after you save.`}
    </p>
  );
}
