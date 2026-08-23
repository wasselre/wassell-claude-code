import { AlertTriangle, MapPin, CalendarPlus } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { FollowUpTypeConfig } from '@/lib/salesProcess';

interface MissionHeaderProps {
  typeConfig: FollowUpTypeConfig | undefined;
  typeKeyRaw: string | null;
  client: Record<string, unknown> | null;
  draft: Record<string, unknown>;
  attemptNumber: number | null;
  /** Record a client-reported visit (opens the minimal visit form). */
  onRecordVisit: () => void;
  /** Book a visit appointment (opens the appointment form). */
  onBookAppointment: () => void;
  readOnly?: boolean;
}

function fmt(iso: unknown, isAr: boolean): string | null {
  if (typeof iso !== 'string' || !iso.trim()) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Top banner: the mission, the client, when it's due, and where they stand. */
export default function MissionHeader({ typeConfig, typeKeyRaw, client, draft, attemptNumber, onRecordVisit, onBookAppointment, readOnly = false }: MissionHeaderProps) {
  const isAr = useAppStore((s) => s.language === 'ar');

  const title = typeConfig ? (isAr ? typeConfig.label_ar : typeConfig.label_en) : (typeKeyRaw ?? (isAr ? 'متابعة' : 'Follow-up'));
  const objective = typeConfig ? (isAr ? typeConfig.objective_ar : typeConfig.objective_en) : '';
  const clientName = (client?.client_name as string) ?? (draft.client_name as string) ?? (isAr ? 'عميل' : 'Client');
  const clientPhone = (client?.phone_number as string) ?? (draft.client_phone as string) ?? '';
  const stage = (client?.client_stage as string) ?? '';
  const status = (client?.client_status as string) ?? '';
  const priority = (draft.priority as string) ?? '';
  const due = fmt(draft.scheduled_datetime, isAr);
  const overdue =
    typeof draft.scheduled_datetime === 'string' &&
    draft.followup_status !== 'completed' &&
    new Date(draft.scheduled_datetime).getTime() < Date.now();

  return (
    <section className="card p-5" style={{ borderInlineStart: '5px solid #B8734F' }}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-copper">
            {title}
            {objective && <span className="font-normal text-charcoal/70"> · {isAr ? 'الهدف: ' : 'Goal: '}{objective}</span>}
          </p>
          <h1 className="mt-1.5 text-2xl font-bold text-chocolate">{clientName}</h1>
          {clientPhone && <p dir="ltr" className="mt-0.5 text-start text-sm text-charcoal/70">{clientPhone}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {stage && <Chip label={isAr ? 'المرحلة' : 'Stage'} value={stage} color="#B8734F" />}
            {status && <Chip label={isAr ? 'الحالة' : 'Status'} value={status} color="#8E4E3A" />}
            {priority && <Chip label={isAr ? 'الأولوية' : 'Priority'} value={priority} color="#C09B5F" />}
          </div>
          {/* Rep actions — available on every step (record a client-reported visit,
              or book a visit appointment). */}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onRecordVisit}
              disabled={readOnly}
              className="inline-flex items-center gap-1.5 rounded-lg border border-copper/40 bg-copper/5 px-3 py-1.5 text-sm font-semibold text-copper transition hover:bg-copper/10 disabled:opacity-40"
            >
              <MapPin size={15} /> {isAr ? 'تسجيل زيارة' : 'Record a visit'}
            </button>
            <button
              type="button"
              onClick={onBookAppointment}
              disabled={readOnly}
              className="inline-flex items-center gap-1.5 rounded-lg border border-copper/40 bg-copper/5 px-3 py-1.5 text-sm font-semibold text-copper transition hover:bg-copper/10 disabled:opacity-40"
            >
              <CalendarPlus size={15} /> {isAr ? 'حجز موعد' : 'Book an appointment'}
            </button>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2 text-sm">
          {due && (
            <div className="text-end">
              <span className="block text-xs text-charcoal/60">{isAr ? 'تاريخ الاستحقاق' : 'Due'}</span>
              <span className={overdue ? 'inline-flex items-center gap-1 font-bold text-terracotta' : 'font-semibold text-charcoal'}>
                {overdue && <AlertTriangle size={15} />}
                {due}
              </span>
            </div>
          )}
          {attemptNumber != null && (
            <span className="badge" style={{ backgroundColor: '#C09B5F1A', color: '#8E4E3A' }}>
              {isAr ? `المحاولة ${attemptNumber}` : `Attempt ${attemptNumber}`}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

function Chip({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <span className="badge gap-1" style={{ backgroundColor: `${color}1A`, color }}>
      <span className="font-normal opacity-70">{label}:</span>
      <span className="font-bold">{value}</span>
    </span>
  );
}
