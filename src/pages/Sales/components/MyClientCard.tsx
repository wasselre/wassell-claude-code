import { Clock, Activity, CalendarCheck, MapPinned, FileText, BadgeDollarSign, Hash } from 'lucide-react';
import type { SalesClient } from '../lib/salesClients';
import { formatRelative, nextActionTypeLabel } from '@/pages/Clients/lib/lifecycleDisplay';
import { getFollowUpTypeConfig, getOutcome } from '@/lib/salesProcess';
import { HealthBadge, MetaChip, VisitRatingStars, Chip, Dash } from '@/pages/Clients/components/clientChips';
import ClientQuickActions from '@/pages/Clients/components/ClientQuickActions';

interface Props {
  sc: SalesClient;
  isAr: boolean;
  now: number;
  returnTo: string;
  onOpen: (clientId: string) => void;
  onWhatsApp: (clientId: string, phone: string | null) => void;
}

/** Left accent color encoding the most important state. */
function accent(sc: SalesClient): string | null {
  if (sc.followup.late) return '#B5462F'; // overdue follow-up — red
  if (sc.view.lifecycleHealth === 'closed') return '#C9BCA8'; // muted
  return null;
}

/** One related-records stat (icon + count + label), hidden when zero. */
function Stat({ icon, count, label }: { icon: React.ReactNode; count: number; label: string }) {
  if (count <= 0) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-cream px-1.5 py-0.5 text-[11px] font-bold text-charcoal/70" title={label}>
      {icon}
      {count}
    </span>
  );
}

/** Label for a follow-up type, localized. */
function followupTypeLabel(typeKey: string | null, isAr: boolean): string | null {
  if (!typeKey) return null;
  const cfg = getFollowUpTypeConfig(typeKey);
  return cfg ? (isAr ? cfg.label_ar : cfg.label_en) : typeKey;
}

/** Label for a recorded outcome (call_result value). */
function outcomeLabel(result: string | null, isAr: boolean): string | null {
  if (!result) return null;
  const o = getOutcome(result);
  return o ? (isAr ? o.label_ar : o.label_en) : result;
}

/**
 * A single client in the My Clients sales list — a dense "situational" card so
 * the rep grasps the client's state without opening ten records.
 */
export default function MyClientCard({ sc, isAr, now, returnTo, onOpen, onWhatsApp }: Props) {
  const { view: v } = sc;
  const a = accent(sc);
  const latestType = followupTypeLabel(sc.followup.latest?.typeKey ?? null, isAr);
  const latestResult = outcomeLabel(sc.followup.latest?.result ?? null, isAr);
  const nextType = followupTypeLabel(sc.followup.next?.typeKey ?? null, isAr) ?? nextActionTypeLabel(v.nextActionType, isAr);
  const nextDue = formatRelative(sc.followup.next?.scheduledISO ?? v.nextActionDueAt, isAr, now);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(v.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(v.id);
      }}
      className="card cursor-pointer p-4 transition hover:shadow-md"
      style={a ? { borderInlineStartWidth: 4, borderInlineStartColor: a } : undefined}
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        {/* Identity */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-bold text-chocolate">
              {v.name ?? (isAr ? 'عميل بدون اسم' : 'Unnamed client')}
            </span>
            <HealthBadge value={v.lifecycleHealth} isAr={isAr} />
            <VisitRatingStars rating={v.latestVisitRating} size={13} />
            {sc.code && (
              <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-charcoal/40" dir="ltr">
                <Hash size={11} />
                {sc.code}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-charcoal/60">
            <span dir="ltr">{v.phone ?? '—'}</span>
            <span className="text-charcoal/30">•</span>
            <span>{v.ownerName ?? (isAr ? 'بدون مسؤول' : 'No rep')}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <MetaChip label={v.stage} />
            {v.status && <Chip label={v.status} color="#8E4E3A" />}
          </div>
          {/* Related-records summary */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Stat icon={<CalendarCheck size={12} />} count={sc.related.appointments} label={isAr ? 'مواعيد' : 'Appointments'} />
            <Stat icon={<MapPinned size={12} />} count={sc.related.visits} label={isAr ? 'زيارات' : 'Visits'} />
            <Stat icon={<FileText size={12} />} count={sc.related.offers} label={isAr ? 'عروض أسعار' : 'Offers'} />
            <Stat icon={<BadgeDollarSign size={12} />} count={sc.related.reservations} label={isAr ? 'حجوزات' : 'Reservations'} />
          </div>
        </div>

        {/* Latest + next action */}
        <div className="flex flex-col gap-1.5 text-xs lg:w-64">
          <div className="flex items-start gap-1.5">
            <Activity size={13} className="mt-0.5 shrink-0 text-charcoal/40" />
            <span className="text-charcoal/70">
              <span className="text-charcoal/50">{isAr ? 'آخر إجراء: ' : 'Latest: '}</span>
              {latestType ? (
                <>
                  <span className="font-semibold text-charcoal">{latestType}</span>
                  {latestResult ? <span className="text-charcoal/60"> — {latestResult}</span> : null}
                </>
              ) : (
                <Dash />
              )}
            </span>
          </div>
          <div className="flex items-start gap-1.5">
            <Clock size={13} className={`mt-0.5 shrink-0 ${sc.followup.late ? 'text-[#B5462F]' : 'text-charcoal/40'}`} />
            <span className="text-charcoal/70">
              <span className="text-charcoal/50">{isAr ? 'التالي: ' : 'Next: '}</span>
              {nextType ? <span className="font-semibold text-charcoal">{nextType}</span> : null}
              {nextDue ? (
                <span className={sc.followup.late ? 'font-bold text-[#B5462F]' : 'text-charcoal/60'}> · {nextDue}</span>
              ) : null}
              {!nextType && !nextDue ? <Dash /> : null}
            </span>
          </div>
        </div>

        {/* Quick actions */}
        <div className="flex items-center justify-end lg:w-auto">
          <ClientQuickActions
            clientId={v.id}
            phone={v.phone}
            nextFollowupId={v.nextFollowupId}
            isAr={isAr}
            variant="row"
            returnTo={returnTo}
            onWhatsApp={() => onWhatsApp(v.id, v.phone)}
            hideOpenClient
          />
        </div>
      </div>
    </div>
  );
}
