import { Clock, Activity, ListChecks, MapPin, CalendarCheck, Phone, Star, HeartPulse } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ClientView } from '../lib/clientView';
import { isOverdue } from '../lib/clientView';
import { formatRelative, lifecycleHealthDisplay } from '../lib/lifecycleDisplay';
import { Dash } from './clientChips';

function Tile({ icon, label, children, accent }: { icon: ReactNode; label: string; children: ReactNode; accent?: string }) {
  return (
    <div className="card p-3.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-charcoal/50">
        <span style={accent ? { color: accent } : undefined}>{icon}</span>
        {label}
      </div>
      <div className="mt-1.5 text-sm font-bold text-chocolate">{children}</div>
    </div>
  );
}

function countOrDash(n: number | null): ReactNode {
  return typeof n === 'number' ? n : <Dash />;
}

/** Eight at-a-glance tiles below the header. */
export default function DetailKpiRow({ view, isAr, now = Date.now() }: { view: ClientView; isAr: boolean; now?: number }) {
  const overdue = isOverdue(view, now);
  const due = formatRelative(view.nextActionDueAt, isAr, now);
  const last = formatRelative(view.lastActivityAt, isAr, now);
  const health = lifecycleHealthDisplay(view.lifecycleHealth);

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Tile icon={<Clock size={14} />} label={isAr ? 'موعد الإجراء' : 'Next action due'} accent={overdue ? '#B5462F' : undefined}>
        <span className={overdue ? 'text-[#B5462F]' : ''}>{due ?? <Dash />}</span>
      </Tile>
      <Tile icon={<Activity size={14} />} label={isAr ? 'آخر نشاط' : 'Last activity'}>
        {last ?? <Dash />}
      </Tile>
      <Tile icon={<ListChecks size={14} />} label={isAr ? 'المتابعات' : 'Follow-ups'}>
        {countOrDash(view.counts.followups)}
      </Tile>
      <Tile icon={<MapPin size={14} />} label={isAr ? 'الزيارات' : 'Visits'}>
        {countOrDash(view.counts.visits)}
      </Tile>
      <Tile icon={<CalendarCheck size={14} />} label={isAr ? 'المواعيد' : 'Appointments'}>
        {countOrDash(view.counts.appointments)}
      </Tile>
      <Tile icon={<Phone size={14} />} label={isAr ? 'المكالمات' : 'Calls'}>
        {countOrDash(view.counts.calls)}
      </Tile>
      <Tile icon={<Star size={14} />} label={isAr ? 'تقييم الزيارة' : 'Visit rating'}>
        {typeof view.latestVisitRating === 'number' && view.latestVisitRating > 0 ? `${view.latestVisitRating}/5` : <Dash />}
      </Tile>
      <Tile icon={<HeartPulse size={14} />} label={isAr ? 'صحة الدورة' : 'Lifecycle'} accent={health.color}>
        <span style={{ color: health.color }}>{isAr ? health.label_ar : health.label_en}</span>
      </Tile>
    </div>
  );
}
