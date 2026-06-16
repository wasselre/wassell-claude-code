import { AlertTriangle } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { FollowUpTypeConfig } from '@/lib/salesProcess';

interface MissionHeaderProps {
  typeConfig: FollowUpTypeConfig | undefined;
  typeKeyRaw: string | null;
  client: Record<string, unknown> | null;
  draft: Record<string, unknown>;
  attemptNumber: number | null;
}

function fmt(iso: unknown, isAr: boolean): string | null {
  if (typeof iso !== 'string' || !iso.trim()) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(isAr ? 'ar-SA' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Top banner: the mission, the client, when it's due, and where they stand. */
export default function MissionHeader({ typeConfig, typeKeyRaw, client, draft, attemptNumber }: MissionHeaderProps) {
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
    <section className="card" style={{ borderInlineStart: '4px solid #B8734F' }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-[#4A2C2A]">{title}</h1>
          {objective && <p className="mt-1 text-sm text-[#4A4E54]">{isAr ? 'الهدف: ' : 'Goal: '}{objective}</p>}
          <p className="mt-2 text-lg font-semibold text-[#4A4E54]">{clientName}</p>
          {clientPhone && <p dir="ltr" className="text-sm text-[#8E4E3A]">{clientPhone}</p>}
        </div>
        <div className="flex flex-col items-end gap-2 text-sm">
          {due && (
            <div className={overdue ? 'flex items-center gap-1 font-semibold text-[#8E4E3A]' : 'text-[#4A4E54]'}>
              {overdue && <AlertTriangle size={15} />}
              <span>{isAr ? 'الاستحقاق: ' : 'Due: '}{due}</span>
            </div>
          )}
          {attemptNumber != null && (
            <span className="rounded-full bg-[#F5EDE0] px-2 py-0.5 text-[#4A4E54]">
              {isAr ? `المحاولة ${attemptNumber}` : `Attempt ${attemptNumber}`}
            </span>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {stage && <Chip label={isAr ? 'المرحلة' : 'Stage'} value={stage} color="#B8734F" />}
        {status && <Chip label={isAr ? 'الحالة' : 'Status'} value={status} color="#8E4E3A" />}
        {priority && <Chip label={isAr ? 'الأولوية' : 'Priority'} value={priority} color="#C09B5F" />}
      </div>
    </section>
  );
}

function Chip({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5" style={{ borderColor: color, color }}>
      <span className="opacity-70">{label}:</span>
      <span className="font-semibold">{value}</span>
    </span>
  );
}
