import { useMemo } from 'react';
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

  const fmt = (iso: unknown) => {
    if (typeof iso !== 'string') return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'short', timeStyle: 'short' });
  };

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border border-[#10B981] bg-[#10B981]/10 px-3 py-2 text-sm">
        <span className="inline-flex items-center gap-1 text-[#10B981]"><Check size={15} /> {isAr ? 'تم إرفاق مكالمة' : 'Call attached'}</span>
        <button type="button" onClick={() => onAttach(null)} className="inline-flex items-center gap-1 text-[#8E4E3A] hover:underline">
          <X size={13} /> {isAr ? 'إلغاء الإرفاق' : 'Detach'}
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[#D4B896] p-2">
      <p className="mb-1 text-xs text-[#8E4E3A]">{isAr ? 'إرفاق المكالمة (اختياري)' : 'Attach the call (optional)'}</p>
      {candidates.length === 0 ? (
        <p className="text-xs text-[#8E4E3A]">{isAr ? 'لا توجد مكالمات صادرة حديثة' : 'No recent outbound calls'}</p>
      ) : (
        <ul className="space-y-1">
          {candidates.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="text-[#4A4E54]">
                {fmt(c.data.call_time)}
                {c.data.duration_seconds ? ` · ${c.data.duration_seconds}${isAr ? 'ث' : 's'}` : ''}
                {c.data.status ? ` · ${c.data.status}` : ''}
              </span>
              <button type="button" onClick={() => onAttach(c.id)} className="inline-flex items-center gap-1 text-[#B8734F] hover:underline">
                <Paperclip size={13} /> {isAr ? 'إرفاق' : 'Attach'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
