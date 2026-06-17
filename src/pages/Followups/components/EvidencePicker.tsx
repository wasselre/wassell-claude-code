import { useEffect, useMemo, useRef } from 'react';
import { Paperclip, Check, X } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { normalizePhone } from '@/lib/phone';
import type { AppRecord } from '@/types';

interface EvidencePickerProps {
  clientId: string | null;
  phones: string[];
  /** Current completed_by_call_id value. */
  value: string | null;
  onAttach: (callRecordId: string | null) => void;
}

/**
 * Suggests recent OUTBOUND phone_calls for this client and lets the rep attach
 * one as the call that completed this follow-up. Reads the store's phone_calls
 * records (not call_logs) so the lookup id is a real phone_calls record id.
 */
export default function EvidencePicker({ clientId, phones, value, onAttach }: EvidencePickerProps) {
  const { models, records, language } = useAppStore();
  const isAr = language === 'ar';

  const candidates = useMemo<AppRecord[]>(() => {
    const model = models.find((m) => m.name === 'phone_calls');
    if (!model) return [];
    const normPhones = new Set(phones.map((p) => normalizePhone(p)).filter(Boolean) as string[]);
    return (records[model.id] ?? [])
      .filter((r) => {
        if (r.data.direction !== 'outbound') return false;
        if (clientId && r.data.client_link === clientId) return true;
        const cp = normalizePhone(r.data.customer_phone as string);
        return cp ? normPhones.has(cp) : false;
      })
      .sort((a, b) => String(b.data.call_time ?? '').localeCompare(String(a.data.call_time ?? '')))
      .slice(0, 5);
  }, [models, records, clientId, phones]);

  // Auto-link the most recent matching call so its recording attaches without a
  // manual click. The ref latches after the first attempt, so a pre-existing
  // value is respected and a user detach is NOT immediately re-attached —
  // re-attaching (or picking a different call) is then the rep's explicit call.
  const autoAttachedRef = useRef(false);
  useEffect(() => {
    if (autoAttachedRef.current) return;
    if (value) { autoAttachedRef.current = true; return; }
    const first = candidates[0];
    if (first) {
      autoAttachedRef.current = true;
      onAttach(first.id);
    }
  }, [candidates, value, onAttach]);

  const fmt = (iso: unknown) => {
    if (typeof iso !== 'string') return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'short', timeStyle: 'short' });
  };

  if (value) {
    const attached = (() => {
      const model = models.find((m) => m.name === 'phone_calls');
      return model ? (records[model.id] ?? []).find((r) => r.id === value) ?? null : null;
    })();
    const when = fmt(attached?.data.call_time);
    return (
      <div className="flex items-center justify-between rounded-xl border border-[#10B981] bg-[#10B981]/10 px-3 py-2.5 text-sm">
        <span className="inline-flex items-center gap-1 font-semibold text-[#10B981]">
          <Check size={15} /> {isAr ? 'تم إرفاق المكالمة تلقائيًا' : 'Call linked automatically'}
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
        <ul className="space-y-1">
          {candidates.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-charcoal">
                {fmt(c.data.call_time)}
                {c.data.duration_seconds ? ` · ${c.data.duration_seconds}${isAr ? 'ث' : 's'}` : ''}
                {c.data.status ? ` · ${c.data.status}` : ''}
              </span>
              <button type="button" onClick={() => onAttach(c.id)} className="inline-flex items-center gap-1 font-semibold text-copper hover:underline">
                <Paperclip size={13} /> {isAr ? 'إرفاق' : 'Attach'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
