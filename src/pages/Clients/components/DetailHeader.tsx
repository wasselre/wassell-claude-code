import { ArrowLeft, Clock, Activity, CalendarPlus, ListPlus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { ClientView } from '../lib/clientView';
import { isOverdue } from '../lib/clientView';
import { formatRelative } from '../lib/lifecycleDisplay';
import { HealthBadge, MetaChip, NextActionChip, Chip, VisitRatingStars, Dash } from './clientChips';
import ClientQuickActions from './ClientQuickActions';

interface DetailHeaderProps {
  view: ClientView;
  isAr: boolean;
  returnTo: string;
  onWhatsApp: () => void;
  onCreateFollowup: () => void;
  onCreateAppointment: () => void;
  now?: number;
}

/** Client 360 header — identity, badges, next-action summary, quick actions. */
export default function DetailHeader({ view, isAr, returnTo, onWhatsApp, onCreateFollowup, onCreateAppointment, now = Date.now() }: DetailHeaderProps) {
  const navigate = useNavigate();
  const overdue = isOverdue(view, now);
  const due = formatRelative(view.nextActionDueAt, isAr, now);
  const last = formatRelative(view.lastActivityAt, isAr, now);

  return (
    <div className="card p-5">
      <button
        type="button"
        onClick={() => navigate(returnTo)}
        className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-terracotta hover:underline"
      >
        <ArrowLeft size={15} className={isAr ? 'rotate-180' : ''} /> {isAr ? 'رجوع' : 'Back'}
      </button>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-extrabold text-chocolate">
              {view.name ?? (isAr ? 'عميل بدون اسم' : 'Unnamed client')}
            </h1>
            <HealthBadge value={view.lifecycleHealth} isAr={isAr} />
            <VisitRatingStars rating={view.latestVisitRating} />
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-charcoal/60">
            <span dir="ltr">{view.phone ?? '—'}</span>
            <span className="text-charcoal/30">•</span>
            <span>{view.ownerName ?? (isAr ? 'بدون مالك' : 'No owner')}</span>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <MetaChip label={view.stage} />
            {view.status && <Chip label={view.status} color="#8E4E3A" />}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-4 text-xs">
            <span className="inline-flex items-center gap-1.5">
              <Clock size={14} className={overdue ? 'text-[#B5462F]' : 'text-charcoal/40'} />
              <span className="text-charcoal/50">{isAr ? 'الإجراء التالي:' : 'Next action:'}</span>
              <NextActionChip value={view.nextActionType} isAr={isAr} />
              <span className={overdue ? 'font-bold text-[#B5462F]' : 'text-charcoal/70'}>{due ?? <Dash />}</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Activity size={14} className="text-charcoal/40" />
              <span className="text-charcoal/50">{isAr ? 'آخر نشاط:' : 'Last activity:'}</span>
              <span className="text-charcoal/70">{last ?? <Dash />}</span>
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <ClientQuickActions
            clientId={view.id}
            phone={view.phone}
            nextFollowupId={view.nextFollowupId}
            isAr={isAr}
            variant="header"
            onWhatsApp={onWhatsApp}
            returnTo={returnTo}
            hideOpenClient
          />
          <button
            type="button"
            onClick={onCreateFollowup}
            className="inline-flex items-center gap-1.5 rounded-lg bg-copper/10 px-3 py-2 text-sm font-bold text-copper transition hover:bg-copper/20"
          >
            <ListPlus size={16} /> {isAr ? 'متابعة' : 'Follow-up'}
          </button>
          <button
            type="button"
            onClick={onCreateAppointment}
            className="inline-flex items-center gap-1.5 rounded-lg bg-chocolate/10 px-3 py-2 text-sm font-bold text-chocolate transition hover:bg-chocolate/20"
          >
            <CalendarPlus size={16} /> {isAr ? 'موعد' : 'Appointment'}
          </button>
        </div>
      </div>
    </div>
  );
}
