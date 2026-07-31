import { useEffect, useMemo, useRef } from 'react';
import { Paperclip, Check, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import {
  CALL_MATCH_WINDOW_MINUTES,
  listRecentCalls,
  minutesFromAnchor,
  resolveCallForFollowup,
} from '@/lib/salesProcess/callMatch';
import type { AppRecord } from '@/types';

interface EvidencePickerProps {
  clientId: string | null;
  phones: string[];
  /** Current completed_by_call_id value. */
  value: string | null;
  /**
   * When the rep worked this task (`actual_datetime`). Auto-attach only accepts
   * a call within CALL_MATCH_WINDOW_MINUTES of it; null falls back to now.
   */
  anchor: string | null;
  onAttach: (callRecordId: string | null) => void;
}

/**
 * Suggests recent OUTBOUND phone_calls for this client and lets the rep attach
 * one as the call that completed this follow-up. Reads the store's phone_calls
 * records (not call_logs) so the lookup id is a real phone_calls record id.
 *
 * Auto-attach is TIME-BOUNDED (see lib/salesProcess/callMatch). It previously
 * grabbed the client's most recent outbound call regardless of age, which is how
 * 27 production follow-ups ended up citing a call from days-to-months earlier as
 * their completing evidence. Manual attach is deliberately NOT bounded — the rep
 * may know something the timestamps don't.
 */
export default function EvidencePicker({ clientId, phones, value, anchor, onAttach }: EvidencePickerProps) {
  const { models, records, language } = useAppStore();
  const isAr = language === 'ar';

  const calls = useMemo<readonly AppRecord[]>(() => {
    const model = models.find((m) => m.name === 'phone_calls');
    return model ? records[model.id] ?? [] : [];
  }, [models, records]);

  const candidates = useMemo<AppRecord[]>(
    () => listRecentCalls({ calls, clientId, phones }),
    [calls, clientId, phones],
  );

  // The one call close enough in time to be THIS follow-up's call. Null when the
  // client's recent calls are all outside the window.
  const autoMatch = useMemo<AppRecord | null>(
    () => resolveCallForFollowup({ calls, clientId, phones, anchor }),
    [calls, clientId, phones, anchor],
  );

  // Auto-link that call so its recording attaches without a manual click. The ref
  // latches after the first attempt, so a pre-existing value is respected and a
  // user detach is NOT immediately re-attached — re-attaching (or picking a
  // different call) is then the rep's explicit call.
  const autoAttachedRef = useRef(false);
  useEffect(() => {
    if (autoAttachedRef.current) return;
    if (value) { autoAttachedRef.current = true; return; }
    if (autoMatch) {
      autoAttachedRef.current = true;
      onAttach(autoMatch.id);
    }
  }, [autoMatch, value, onAttach]);

  const fmt = (iso: unknown) => {
    if (typeof iso !== 'string') return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'short', timeStyle: 'short' });
  };

  if (value) {
    const attached = calls.find((r) => r.id === value) ?? null;
    const when = fmt(attached?.data.call_time);
    const wasAuto = autoMatch !== null && autoMatch.id === value;
    return (
      <div className="flex items-center justify-between rounded-xl border border-[#10B981] bg-[#10B981]/10 px-3 py-2.5 text-sm">
        <span className="inline-flex items-center gap-1 font-semibold text-[#10B981]">
          <Check size={15} />
          {wasAuto
            ? (isAr ? 'تم إرفاق المكالمة تلقائيًا' : 'Call linked automatically')
            : (isAr ? 'تم إرفاق المكالمة' : 'Call linked')}
          {when ? <span className="font-normal text-charcoal" dir="ltr">· {when}</span> : null}
        </span>
        <button type="button" onClick={() => onAttach(null)} className="inline-flex items-center gap-1 text-terracotta hover:underline">
          <X size={13} /> {isAr ? 'تغيير' : 'Change'}
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-sand bg-cream/40 p-3">
      <p className="mb-2 text-xs text-terracotta">{isAr ? 'إرفاق المكالمة (اختياري)' : 'Attach the call (optional)'}</p>
      {candidates.length === 0 ? (
        <p className="text-xs text-charcoal/60">{isAr ? 'لا توجد مكالمات صادرة حديثة' : 'No recent outbound calls'}</p>
      ) : (
        <>
          {/* Nothing auto-attached: say WHY, so an empty field doesn't read as a
              bug. These calls are outside the window — attaching one is a
              deliberate override, not the default. */}
          <p className="mb-2 text-xs text-charcoal/60">
            {isAr
              ? `لا توجد مكالمة خلال ${CALL_MATCH_WINDOW_MINUTES} دقيقة من وقت الإكمال. المكالمات التالية أقدم — أرفقها فقط إذا كانت هي الصحيحة.`
              : `No call within ${CALL_MATCH_WINDOW_MINUTES} minutes of the completion time. These are older — attach one only if it is the right call.`}
          </p>
          <ul className="space-y-1">
            {candidates.map((c) => {
              const gap = minutesFromAnchor(c, anchor);
              return (
                <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-charcoal">
                    {fmt(c.data.call_time)}
                    {c.data.duration_seconds ? ` · ${c.data.duration_seconds}${isAr ? 'ث' : 's'}` : ''}
                    {c.data.status ? ` · ${c.data.status}` : ''}
                    {gap !== null ? (
                      <span className="text-charcoal/50">
                        {isAr ? ` · فارق ${gap} دقيقة` : ` · ${gap} min apart`}
                      </span>
                    ) : null}
                  </span>
                  <button type="button" onClick={() => onAttach(c.id)} className="inline-flex items-center gap-1 font-semibold text-copper hover:underline">
                    <Paperclip size={13} /> {isAr ? 'إرفاق' : 'Attach'}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
