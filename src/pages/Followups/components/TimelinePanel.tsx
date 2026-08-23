import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import CallHistoryPanel from '@/pages/Records/components/CallHistoryPanel';
import { sortTimeline, pickEntryDate, getOutcome, getFollowUpTypeConfig, type TimelineEntry } from '@/lib/salesProcess';
import type { AppModel, AppRecord } from '@/types';

interface TimelinePanelProps {
  clientId: string | null;
  currentFollowupId: string | null;
  phones: string[];
  /** Show the call-history section at the bottom (default true). The guided-mission
   *  Context step splits follow-ups and calls into separate popups, so it passes false. */
  showCalls?: boolean;
  /** Optional heading override; omit for the default "Timeline". */
  heading?: string | null;
  /** When provided, clicking an entry calls this instead of navigating away
   *  (the Context popup uses it to open the record's details in a modal). */
  onSelectEntry?: (modelName: string, recordId: string) => void;
}

function recordsForClient(model: AppModel | undefined, records: Record<string, AppRecord[]>, clientId: string, linkSlug: string): AppRecord[] {
  if (!model) return [];
  return (records[model.id] ?? []).filter((r) => {
    const v = r.data[linkSlug];
    return v === clientId || (Array.isArray(v) && v.includes(clientId));
  });
}

/** Compact chronological client history: follow-ups, appointments, visits + live calls. */
export default function TimelinePanel({ clientId, currentFollowupId, phones, showCalls = true, heading, onSelectEntry }: TimelinePanelProps) {
  const { models, records, language, users } = useAppStore();
  const isAr = language === 'ar';
  const navigate = useNavigate();

  const entries = useMemo<TimelineEntry[]>(() => {
    if (!clientId) return [];
    const out: TimelineEntry[] = [];
    const fuModel = models.find((m) => m.name === 'followups');
    const apModel = models.find((m) => m.name === 'appointments');
    const vModel = models.find((m) => m.name === 'visits');

    // Value helpers for the inline summary rows. Language is baked in (isAr is a
    // dep), so switching language rebuilds — fine for a transient popup.
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
    const fmtDate = (v: unknown): string => {
      if (typeof v !== 'string' || !v.trim()) return '';
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'short', timeStyle: 'short' });
    };
    const userName = (id: unknown): string => {
      if (typeof id !== 'string' || !id) return '';
      const u = users.find((x) => x.id === id);
      return u ? ((isAr ? u.name_ar : u.name_en) || u.email || '') : '';
    };
    const rows = (defs: Array<[string, string, string]>) =>
      defs.filter(([, , val]) => val).map(([label_ar, label_en, value]) => ({ label_ar, label_en, value }));

    for (const r of recordsForClient(fuModel, records, clientId, 'client_id')) {
      if (r.id === currentFollowupId) continue;
      const type = Array.isArray(r.data.followup_type) ? r.data.followup_type[0] : r.data.followup_type;
      const typeCfg = getFollowUpTypeConfig(typeof type === 'string' ? type : null);
      const outcome = getOutcome(r.data.call_result as string);
      out.push({
        id: r.id, kind: 'followup', at: pickEntryDate(r.data, r.created_at) ?? r.created_at,
        title_ar: 'متابعة', title_en: 'Follow-up',
        subtitle_ar: outcome?.label_ar ?? (typeCfg?.label_ar ?? String(type ?? '')),
        subtitle_en: outcome?.label_en ?? (typeCfg?.label_en ?? String(type ?? '')),
        model_name: 'followups', record_id: r.id, tone: outcome?.tone,
        summary: rows([
          ['النوع', 'Type', typeCfg ? (isAr ? typeCfg.label_ar : typeCfg.label_en) : str(type)],
          ['النتيجة', 'Outcome', outcome ? (isAr ? outcome.label_ar : outcome.label_en) : ''],
          ['المندوب', 'Sales rep', userName(r.data.sales_rep)],
          ['ملاحظات', 'Notes', str(r.data.outcome_notes) || str(r.data.notes)],
          ['إعادة تواصل', 'Next contact', fmtDate(r.data.reschedule_contact_date)],
        ]),
      });
    }
    for (const r of recordsForClient(apModel, records, clientId, 'client_id')) {
      out.push({
        id: r.id, kind: 'appointment', at: pickEntryDate(r.data, r.created_at) ?? r.created_at,
        title_ar: 'موعد', title_en: 'Appointment',
        subtitle_ar: String(r.data.appointment_status ?? ''), subtitle_en: String(r.data.appointment_status ?? ''),
        model_name: 'appointments', record_id: r.id,
        summary: rows([
          ['الحالة', 'Status', str(r.data.appointment_status)],
          ['التاريخ', 'Date', fmtDate(r.data.appointment_date) || fmtDate(r.data.scheduled_datetime)],
          ['المندوب', 'Sales rep', userName(r.data.sales_rep)],
          ['ملاحظات', 'Notes', str(r.data.notes)],
        ]),
      });
    }
    for (const r of recordsForClient(vModel, records, clientId, 'client_id')) {
      const ratingRaw = r.data.visit_rating;
      const ratingNum = ratingRaw == null || ratingRaw === '' ? null : Number(ratingRaw);
      const hasRating = ratingNum != null && Number.isFinite(ratingNum);
      out.push({
        id: r.id, kind: 'visit', at: pickEntryDate(r.data, r.created_at) ?? r.created_at,
        title_ar: 'زيارة', title_en: 'Visit', model_name: 'visits', record_id: r.id,
        subtitle_ar: hasRating ? `تقييم الزيارة: ${ratingNum}/5` : undefined,
        subtitle_en: hasRating ? `Visit rating: ${ratingNum}/5` : undefined,
        tone: hasRating ? (ratingNum <= 2 ? 'negative' : ratingNum >= 4 ? 'positive' : 'neutral') : undefined,
        summary: rows([
          ['التقييم', 'Rating', hasRating ? `${ratingNum}/5` : ''],
          ['التاريخ', 'Date', fmtDate(r.data.visit_date)],
          ['ملاحظات', 'Notes', str(r.data.visit_notes) || str(r.data.notes)],
        ]),
      });
    }
    return sortTimeline(out, 'desc');
  }, [clientId, currentFollowupId, models, records, users, isAr]);

  const toneColor = (t?: string) => (t === 'positive' ? '#10B981' : t === 'negative' ? '#8E4E3A' : '#C09B5F');
  const fmt = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'short', timeStyle: 'short' });
  };

  return (
    <section className="card p-5">
      {heading !== null ? (
        <h2 className="mb-3 text-sm font-bold text-chocolate">{heading ?? (isAr ? 'السجل الزمني' : 'Timeline')}</h2>
      ) : null}
      {entries.length === 0 ? (
        <p className="text-sm text-terracotta">{isAr ? 'لا توجد أحداث سابقة' : 'No prior activity'}</p>
      ) : (
        <ol className="space-y-2">
          {entries.slice(0, 12).map((e) => (
            <TimelineRow
              key={`${e.kind}-${e.id}`}
              entry={e}
              isAr={isAr}
              toneColor={toneColor}
              fmt={fmt}
              onOpenFull={
                e.model_name && e.record_id
                  ? () => {
                      if (onSelectEntry) onSelectEntry(e.model_name!, e.record_id!);
                      else navigate(`/model/${e.model_name}/${e.record_id}`);
                    }
                  : undefined
              }
            />
          ))}
        </ol>
      )}
      {showCalls && phones.length > 0 && (
        <div className="mt-4 border-t border-sand/60 pt-4">
          <h3 className="mb-1 text-xs font-bold text-charcoal/70">{isAr ? 'المكالمات' : 'Calls'}</h3>
          <CallHistoryPanel phones={phones} chrome="naked" />
        </div>
      )}
    </section>
  );
}

/** One timeline entry. Clicking it expands an inline read-only summary (outcome,
 *  notes, rep…) — like the call rows — instead of opening the full record form.
 *  The expanded panel keeps a subtle "open full record" link for when it's wanted. */
function TimelineRow({
  entry, isAr, toneColor, fmt, onOpenFull,
}: {
  entry: TimelineEntry;
  isAr: boolean;
  toneColor: (t?: string) => string;
  fmt: (iso: string) => string;
  onOpenFull?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = entry.summary ?? [];
  const canExpand = summary.length > 0;
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <li className="overflow-hidden rounded-xl border border-sand/40">
      <button
        type="button"
        onClick={() => (canExpand ? setExpanded((v) => !v) : onOpenFull?.())}
        className="flex w-full items-start gap-2.5 p-2.5 text-start transition hover:bg-cream"
      >
        <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: toneColor(entry.tone) }} />
        <span className="flex-1">
          <span className="text-sm font-semibold text-chocolate">{isAr ? entry.title_ar : entry.title_en}</span>
          {(isAr ? entry.subtitle_ar : entry.subtitle_en) && (
            <span className="text-sm text-terracotta"> — {isAr ? entry.subtitle_ar : entry.subtitle_en}</span>
          )}
          <span className="block text-xs text-charcoal/50">{fmt(entry.at)}</span>
        </span>
        {canExpand ? <Chevron size={16} className={`mt-0.5 shrink-0 text-charcoal/50 ${!expanded && isAr ? 'rotate-180' : ''}`} /> : null}
      </button>

      {expanded && canExpand ? (
        <div className="border-t border-sand/40 bg-cream/30 p-3">
          <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5">
            {summary.map((row) => (
              <div key={row.label_en} className="contents">
                <dt className="text-xs font-semibold text-charcoal/60">{isAr ? row.label_ar : row.label_en}</dt>
                <dd className="whitespace-pre-wrap text-sm text-charcoal/90">{row.value}</dd>
              </div>
            ))}
          </dl>
          {onOpenFull ? (
            <button
              type="button"
              onClick={onOpenFull}
              className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-copper hover:underline"
            >
              <ExternalLink size={12} /> {isAr ? 'فتح السجل الكامل' : 'Open full record'}
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
