import { useNavigate } from 'react-router-dom';
import { Clock, Activity, MapPin } from 'lucide-react';
import type { ClientView } from '../lib/clientView';
import { isAtRisk, isClosedWon, isLostOrUnqualified, isOverdue, hasNoNextAction } from '../lib/clientView';
import { formatRelative, formatBudget } from '../lib/lifecycleDisplay';
import { useClientWhatsApp } from '../lib/useClientWhatsApp';
import { HealthBadge, MetaChip, NextActionChip, VisitRatingStars, Chip, Dash } from './clientChips';
import ClientQuickActions from './ClientQuickActions';

interface ClientsTableProps {
  views: ClientView[];
  isAr: boolean;
  returnTo: string;
  now?: number;
}

/** Left accent color encoding the most important visual state. */
function accentColor(v: ClientView, now: number): string | null {
  if (isOverdue(v, now)) return '#B5462F'; // strong red — overdue
  if (isClosedWon(v)) return '#3F7D54'; // success
  if (isLostOrUnqualified(v)) return '#C9BCA8'; // muted
  if (hasNoNextAction(v) || isAtRisk(v)) return '#C09B5F'; // warning gold
  return null;
}

function PreferenceSummary({ v, isAr }: { v: ClientView; isAr: boolean }) {
  const parts: string[] = [];
  if (v.preferredUnitType.length) parts.push(v.preferredUnitType.slice(0, 2).join('، '));
  const budget = formatBudget(v.budget, isAr);
  if (budget) parts.push(budget);
  if (v.preferredCity) parts.push(v.preferredCity);
  if (!parts.length && v.preferredProjects.length) {
    parts.push(`${v.preferredProjects.length} ${isAr ? 'مشروع مفضل' : 'preferred'}`);
  }
  if (!parts.length) return <Dash />;
  return (
    <span className="inline-flex items-center gap-1 text-charcoal/70">
      <MapPin size={12} className="text-charcoal/40" />
      {parts.join(' · ')}
    </span>
  );
}

export default function ClientsTable({ views, isAr, returnTo, now = Date.now() }: ClientsTableProps) {
  const navigate = useNavigate();
  const { openWhatsApp, whatsAppModals } = useClientWhatsApp();

  if (views.length === 0) {
    return (
      <div className="card p-10 text-center text-sm text-charcoal/50">
        {isAr ? 'لا يوجد عملاء مطابقون للمرشحات الحالية.' : 'No clients match the current filters.'}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {whatsAppModals}
      {views.map((v) => {
        const accent = accentColor(v, now);
        const overdue = isOverdue(v, now);
        const due = formatRelative(v.nextActionDueAt, isAr, now);
        const last = formatRelative(v.lastActivityAt, isAr, now);
        const muted = isLostOrUnqualified(v) || v.lifecycleHealth === 'closed';
        return (
          <div
            key={v.id}
            role="button"
            tabIndex={0}
            onClick={() => navigate(`/model/clients/${v.id}`)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') navigate(`/model/clients/${v.id}`);
            }}
            className={`card cursor-pointer p-4 transition hover:shadow-md ${muted ? 'opacity-75' : ''}`}
            style={accent ? { borderInlineStartWidth: 4, borderInlineStartColor: accent } : undefined}
          >
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
              {/* Identity */}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-bold text-chocolate">{v.name ?? (isAr ? 'عميل بدون اسم' : 'Unnamed client')}</span>
                  <HealthBadge value={v.lifecycleHealth} isAr={isAr} />
                  <VisitRatingStars rating={v.latestVisitRating} size={13} />
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-charcoal/60">
                  <span dir="ltr">{v.phone ?? '—'}</span>
                  <span className="text-charcoal/30">•</span>
                  <span>{v.ownerName ?? (isAr ? 'بدون مستشار' : 'No consultant')}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <MetaChip label={v.stage} />
                  {v.status && <Chip label={v.status} color="#8E4E3A" />}
                </div>
              </div>

              {/* Next action + activity */}
              <div className="flex flex-col gap-1.5 text-xs lg:w-56">
                <div className="flex items-center gap-1.5">
                  <Clock size={13} className={overdue ? 'text-[#B5462F]' : 'text-charcoal/40'} />
                  <NextActionChip value={v.nextActionType} isAr={isAr} />
                  <span className={overdue ? 'font-bold text-[#B5462F]' : 'text-charcoal/60'}>{due ?? <Dash />}</span>
                </div>
                <div className="flex items-center gap-1.5 text-charcoal/60">
                  <Activity size={13} className="text-charcoal/40" />
                  <span>{isAr ? 'آخر نشاط:' : 'Last:'}</span>
                  <span>{last ?? <Dash />}</span>
                </div>
                <div className="truncate"><PreferenceSummary v={v} isAr={isAr} /></div>
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
                  onWhatsApp={() => openWhatsApp(v.id, v.phone)}
                  hideOpenClient
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
