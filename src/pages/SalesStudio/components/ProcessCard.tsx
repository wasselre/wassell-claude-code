import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Star, GitBranch, Users, FlaskConical, Copy, Archive, MoreVertical, ArrowRight, Pencil } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import type { SalesProcess } from '@/types';
import { useProcessRollup } from '../lib/useStudioData';
import { PROCESS_STATUS_LABELS, statusColor, formatMetric, pick } from '../lib/labels';

/** A single process tile in the library — name, status, funnel rates, actions. */
export default function ProcessCard({ process, onDuplicate }: { process: SalesProcess; onDuplicate: (p: SalesProcess) => void }) {
  const { language, salesProcessVersions, setDefaultSalesProcess, saveSalesProcess, addToast } = useAppStore();
  const isAr = language === 'ar';
  const navigate = useNavigate();
  const rollup = useProcessRollup(process);
  const [menuOpen, setMenuOpen] = useState(false);

  const activeVersion = useMemo(
    () => salesProcessVersions.find((v) => v.sales_process_id === process.id && v.status === 'active'),
    [salesProcessVersions, process.id],
  );
  const hasDraft = useMemo(
    () => salesProcessVersions.some((v) => v.sales_process_id === process.id && v.status === 'draft'),
    [salesProcessVersions, process.id],
  );

  const f = rollup.funnel;
  const name = isAr ? process.name_ar : process.name_en;
  const statusLbl = pick(PROCESS_STATUS_LABELS[process.status], isAr);

  const archive = () => {
    setMenuOpen(false);
    saveSalesProcess({ ...process, status: 'archived', is_default: false, updated_at: new Date().toISOString() });
    addToast(isAr ? 'تمت أرشفة المسار' : 'Process archived', 'info');
  };
  const makeDefault = () => {
    setMenuOpen(false);
    void setDefaultSalesProcess(process.id);
    addToast(isAr ? 'تم التعيين كافتراضي' : 'Set as default', 'success');
  };

  return (
    <div className="card relative flex flex-col gap-4 rounded-2xl p-5">
      {/* header */}
      <div className="flex items-start justify-between gap-2">
        <button type="button" onClick={() => navigate(`/sales/studio/processes/${process.id}`)} className="min-w-0 flex-1 text-start">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-lg font-bold text-chocolate">{name}</h3>
            {process.is_default && (
              <span className="badge inline-flex shrink-0 items-center gap-1" style={{ backgroundColor: '#C09B5F22', color: '#8E6A1F' }}>
                <Star size={12} /> {isAr ? 'افتراضي' : 'Default'}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <span className="badge" style={{ backgroundColor: `${statusColor(process.status)}1A`, color: statusColor(process.status) }}>{statusLbl}</span>
            <span className="inline-flex items-center gap-1 text-charcoal/55"><GitBranch size={12} /> {isAr ? 'الإصدار' : 'v'}{activeVersion?.version_number ?? '—'}</span>
            {hasDraft && <span className="badge" style={{ backgroundColor: '#C09B5F1A', color: '#8E6A1F' }}>{isAr ? 'مسودة جاهزة' : 'Draft ready'}</span>}
          </div>
        </button>
        <div className="relative shrink-0">
          <button type="button" onClick={() => setMenuOpen((o) => !o)} className="rounded-lg p-1.5 text-charcoal/50 hover:bg-cream" aria-label="actions">
            <MoreVertical size={16} />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute end-0 z-20 mt-1 w-48 overflow-hidden rounded-xl border border-sand/40 bg-white py-1 shadow-lg">
                <MenuItem icon={<ArrowRight size={14} />} label={isAr ? 'فتح الرحلة' : 'Open Journey'} onClick={() => navigate(`/sales/studio/processes/${process.id}`)} />
                <MenuItem icon={<Pencil size={14} />} label={isAr ? 'تحرير المسودة' : 'Edit Draft'} onClick={() => navigate(`/sales/studio/processes/${process.id}?draft=1`)} />
                <MenuItem icon={<Copy size={14} />} label={isAr ? 'نسخ' : 'Duplicate'} onClick={() => { setMenuOpen(false); onDuplicate(process); }} />
                {!process.is_default && <MenuItem icon={<Star size={14} />} label={isAr ? 'تعيين كافتراضي' : 'Set as Default'} onClick={makeDefault} />}
                {process.status !== 'archived' && <MenuItem icon={<Archive size={14} />} label={isAr ? 'أرشفة' : 'Archive'} onClick={archive} danger />}
              </div>
            </>
          )}
        </div>
      </div>

      {/* assignment + experiments */}
      <div className="flex items-center gap-4 text-sm">
        <span className="inline-flex items-center gap-1.5 text-charcoal/70"><Users size={15} className="text-copper" /><b dir="ltr">{rollup.assignedCount}</b> {isAr ? 'عميل' : 'clients'}</span>
        <span className="inline-flex items-center gap-1.5 text-charcoal/70"><FlaskConical size={15} className="text-copper" /><b dir="ltr">{rollup.activeExperiments}</b> {isAr ? 'تجارب' : 'experiments'}</span>
      </div>

      {/* funnel rates */}
      <div className="grid grid-cols-3 gap-2">
        <Rate label={isAr ? 'حجز موعد' : 'Booking'} value={formatMetric(f.appointment_booking_rate, isAr)} />
        <Rate label={isAr ? 'زيارة' : 'Visit'} value={formatMetric(f.visit_rate, isAr)} />
        <Rate label={isAr ? 'طلب عرض' : 'Offer'} value={formatMetric(f.offer_request_rate, isAr)} />
        <Rate label={isAr ? 'حجز' : 'Reservation'} value={formatMetric(f.reservation_rate, isAr)} />
        <Rate label={isAr ? 'إغلاق ناجح' : 'Closed won'} value={formatMetric(f.closed_won_rate, isAr)} good />
        <Rate label={isAr ? 'خسارة/غير مؤهل' : 'Lost/Unqual.'} value={`${formatMetric(f.lost_rate, isAr)}/${formatMetric(f.unqualified_rate, isAr)}`} bad />
      </div>

      {/* leaks + footer */}
      <div className="flex items-center justify-between border-t border-sand/40 pt-3 text-xs">
        <span className={`inline-flex items-center gap-1 ${(f.no_next_action_count.value ?? 0) > 0 ? 'text-terracotta' : 'text-[#10B981]'}`}>
          {isAr ? 'تسريبات بدون إجراء: ' : 'No-action leaks: '}<b dir="ltr">{f.no_next_action_count.value ?? 0}</b>
        </span>
        <span className="text-charcoal/40" dir="ltr">{new Date(process.updated_at).toLocaleDateString(isAr ? 'ar' : 'en')}</span>
      </div>
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={`flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-cream ${danger ? 'text-red-600' : 'text-charcoal'}`}>
      {icon} {label}
    </button>
  );
}

function Rate({ label, value, good, bad }: { label: string; value: string; good?: boolean; bad?: boolean }) {
  const color = good ? '#10B981' : bad ? '#8E4E3A' : '#4A2C2A';
  return (
    <div className="rounded-xl bg-cream/70 px-2.5 py-2">
      <div className="text-[10px] font-medium leading-tight text-charcoal/55">{label}</div>
      <div className="mt-0.5 text-base font-bold leading-none" style={{ color }} dir="ltr">{value}</div>
    </div>
  );
}
