import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '@/stores/appStore';
import CallHistoryPanel from '@/pages/Records/components/CallHistoryPanel';
import { sortTimeline, pickEntryDate, getOutcome, type TimelineEntry } from '@/lib/salesProcess';
import type { AppModel, AppRecord } from '@/types';

interface TimelinePanelProps {
  clientId: string | null;
  currentFollowupId: string | null;
  phones: string[];
}

function recordsForClient(model: AppModel | undefined, records: Record<string, AppRecord[]>, clientId: string, linkSlug: string): AppRecord[] {
  if (!model) return [];
  return (records[model.id] ?? []).filter((r) => {
    const v = r.data[linkSlug];
    return v === clientId || (Array.isArray(v) && v.includes(clientId));
  });
}

/** Compact chronological client history: follow-ups, appointments, visits + live calls. */
export default function TimelinePanel({ clientId, currentFollowupId, phones }: TimelinePanelProps) {
  const { models, records, language } = useAppStore();
  const isAr = language === 'ar';
  const navigate = useNavigate();

  const entries = useMemo<TimelineEntry[]>(() => {
    if (!clientId) return [];
    const out: TimelineEntry[] = [];
    const fuModel = models.find((m) => m.name === 'followups');
    const apModel = models.find((m) => m.name === 'appointments');
    const vModel = models.find((m) => m.name === 'visits');

    for (const r of recordsForClient(fuModel, records, clientId, 'client_id')) {
      if (r.id === currentFollowupId) continue;
      const type = Array.isArray(r.data.followup_type) ? r.data.followup_type[0] : r.data.followup_type;
      const outcome = getOutcome(r.data.call_result as string);
      out.push({
        id: r.id, kind: 'followup', at: pickEntryDate(r.data, r.created_at) ?? r.created_at,
        title_ar: 'متابعة', title_en: 'Follow-up',
        subtitle_ar: outcome?.label_ar ?? String(type ?? ''), subtitle_en: outcome?.label_en ?? String(type ?? ''),
        model_name: 'followups', record_id: r.id, tone: outcome?.tone,
      });
    }
    for (const r of recordsForClient(apModel, records, clientId, 'client_id')) {
      out.push({
        id: r.id, kind: 'appointment', at: pickEntryDate(r.data, r.created_at) ?? r.created_at,
        title_ar: 'موعد', title_en: 'Appointment',
        subtitle_ar: String(r.data.appointment_status ?? ''), subtitle_en: String(r.data.appointment_status ?? ''),
        model_name: 'appointments', record_id: r.id,
      });
    }
    for (const r of recordsForClient(vModel, records, clientId, 'client_id')) {
      out.push({
        id: r.id, kind: 'visit', at: pickEntryDate(r.data, r.created_at) ?? r.created_at,
        title_ar: 'زيارة', title_en: 'Visit', model_name: 'visits', record_id: r.id,
      });
    }
    return sortTimeline(out, 'desc');
  }, [clientId, currentFollowupId, models, records]);

  const toneColor = (t?: string) => (t === 'positive' ? '#10B981' : t === 'negative' ? '#8E4E3A' : '#C09B5F');
  const fmt = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'short', timeStyle: 'short' });
  };

  return (
    <section className="card">
      <h2 className="mb-2 text-sm font-bold text-[#4A2C2A]">{isAr ? 'السجل الزمني' : 'Timeline'}</h2>
      {entries.length === 0 ? (
        <p className="text-sm text-[#8E4E3A]">{isAr ? 'لا توجد أحداث سابقة' : 'No prior activity'}</p>
      ) : (
        <ol className="space-y-2">
          {entries.slice(0, 12).map((e) => (
            <li key={`${e.kind}-${e.id}`}>
              <button
                type="button"
                onClick={() => e.model_name && e.record_id && navigate(`/model/${e.model_name}/${e.record_id}`)}
                className="flex w-full items-start gap-2 rounded-md p-1 text-start hover:bg-[#F5EDE0]"
              >
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: toneColor(e.tone) }} />
                <span className="flex-1">
                  <span className="text-sm font-medium text-[#4A4E54]">{isAr ? e.title_ar : e.title_en}</span>
                  {(isAr ? e.subtitle_ar : e.subtitle_en) && (
                    <span className="text-sm text-[#8E4E3A]"> — {isAr ? e.subtitle_ar : e.subtitle_en}</span>
                  )}
                  <span className="block text-xs text-[#8E4E3A]">{fmt(e.at)}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {phones.length > 0 && (
        <div className="mt-3 border-t border-[#D4B896] pt-3">
          <h3 className="mb-1 text-xs font-bold text-[#8E4E3A]">{isAr ? 'المكالمات' : 'Calls'}</h3>
          <CallHistoryPanel phones={phones} chrome="naked" />
        </div>
      )}
    </section>
  );
}
