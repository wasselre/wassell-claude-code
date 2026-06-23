import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, User, Phone, MessageCircle } from 'lucide-react';
import type { AppRecord } from '@/types';
import {
  useSv, optOf, fmtDateTime, clientNameOf, KpiCard, Pill, PageHeader,
  useEvidence, EvidenceModals,
} from './components/shared';

type Tab = 'pending' | 'today' | 'high' | 'correction' | 'disputed' | 'all';

export default function QueuePage() {
  const { isAr, m, rows, resolveUser, users } = useSv();
  const navigate = useNavigate();
  const ev = useEvidence();
  const [tab, setTab] = useState<Tab>('pending');
  const [rep, setRep] = useState('');

  const reviews = rows(m.reviews);
  const followupById = useMemo(() => {
    const map = new Map<string, AppRecord>();
    for (const f of rows(m.followups)) map.set(f.id, f);
    return map;
  }, [m.followups, rows]);
  const clientRows = rows(m.clients);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const isToday = (r: AppRecord) => {
    const d = new Date(r.created_at); d.setHours(0, 0, 0, 0);
    return d.getTime() === today.getTime();
  };

  const stat = useMemo(() => {
    let pending = 0, high = 0, correction = 0, disputed = 0;
    let scoreSum = 0, scoreN = 0;
    for (const r of reviews) {
      const d = r.data;
      if (d.review_status === 'pending_review') pending++;
      if ((d.review_priority === 'high' || d.review_priority === 'critical') && d.review_status === 'pending_review') high++;
      if (d.requires_correction === true && d.review_status !== 'closed') correction++;
      if (d.dispute_status === 'disputed') disputed++;
      if (isToday(r) && typeof d.overall_score === 'number') { scoreSum += d.overall_score; scoreN++; }
    }
    return { pending, high, correction, disputed, avg: scoreN ? Math.round(scoreSum / scoreN) : null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviews]);

  const filtered = useMemo(() => {
    const out = reviews.filter((r) => {
      const d = r.data;
      if (rep && d.sales_rep !== rep) return false;
      switch (tab) {
        case 'pending': return d.review_status === 'pending_review';
        case 'today': return isToday(r);
        case 'high': return (d.review_priority === 'high' || d.review_priority === 'critical') && d.review_status !== 'closed';
        case 'correction': return d.requires_correction === true && d.review_status !== 'closed';
        case 'disputed': return d.dispute_status === 'disputed';
        default: return true;
      }
    });
    return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviews, tab, rep]);

  const repUsers = useMemo(() => {
    const ids = new Set(reviews.map((r) => r.data.sales_rep).filter((x): x is string => typeof x === 'string'));
    return users.filter((u) => ids.has(u.id));
  }, [reviews, users]);

  const TABS: { key: Tab; label: string; count?: number }[] = [
    { key: 'pending', label: isAr ? 'بانتظار المراجعة' : 'Pending', count: stat.pending },
    { key: 'today', label: isAr ? 'اليوم' : 'Today' },
    { key: 'high', label: isAr ? 'أولوية مرتفعة' : 'High Priority', count: stat.high },
    { key: 'correction', label: isAr ? 'تتطلب تصحيح' : 'Requires Correction', count: stat.correction },
    { key: 'disputed', label: isAr ? 'معترض عليها' : 'Disputed', count: stat.disputed },
    { key: 'all', label: isAr ? 'الكل' : 'All' },
  ];

  return (
    <div className="mx-auto max-w-[1300px] p-4 sm:p-6">
      <PageHeader title={isAr ? 'قائمة تقييم المبيعات' : 'Sales Valuation Queue'}
        subtitle={isAr ? 'مساحة عمل المدير لمراجعة المتابعات' : 'Manager workbench for reviewing follow-ups'} />

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
        <KpiCard label={isAr ? 'بانتظار المراجعة' : 'Pending'} value={stat.pending} tone="#C09B5F" onClick={() => setTab('pending')} active={tab === 'pending'} />
        <KpiCard label={isAr ? 'أولوية مرتفعة' : 'High Priority'} value={stat.high} tone="#F59E0B" onClick={() => setTab('high')} active={tab === 'high'} />
        <KpiCard label={isAr ? 'تتطلب تصحيح' : 'Requires Correction'} value={stat.correction} tone="#8E4E3A" onClick={() => setTab('correction')} active={tab === 'correction'} />
        <KpiCard label={isAr ? 'اعتراضات مفتوحة' : 'Open Disputes'} value={stat.disputed} tone="#EF4444" onClick={() => setTab('disputed')} active={tab === 'disputed'} />
        <KpiCard label={isAr ? 'متوسط درجة اليوم' : 'Avg Score Today'} value={stat.avg ?? '—'} tone="#10B981" />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)}
            className={`rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${tab === t.key ? 'bg-copper text-white' : 'bg-white text-charcoal/70 border border-sand/40 hover:bg-cream'}`}>
            {t.label}{t.count != null && t.count > 0 ? ` (${t.count})` : ''}
          </button>
        ))}
        <select value={rep} onChange={(e) => setRep(e.target.value)}
          className="form-input text-xs py-1.5 ms-auto w-auto min-w-[160px]">
          <option value="">{isAr ? 'كل المندوبين' : 'All reps'}</option>
          {repUsers.map((u) => <option key={u.id} value={u.id}>{(isAr ? u.name_ar : u.name_en) || u.email}</option>)}
        </select>
      </div>

      {/* Table */}
      <div className="card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs font-semibold text-charcoal/55 border-b border-sand/40">
              <Th>{isAr ? 'العميل' : 'Client'}</Th>
              <Th>{isAr ? 'المندوب' : 'Rep'}</Th>
              <Th>{isAr ? 'نوع المتابعة' : 'Type'}</Th>
              <Th>{isAr ? 'النتيجة' : 'Result'}</Th>
              <Th>{isAr ? 'المجدول' : 'Scheduled'}</Th>
              <Th>{isAr ? 'التنفيذ الفعلي' : 'Completed'}</Th>
              <Th>{isAr ? 'الأولوية' : 'Priority'}</Th>
              <Th>{isAr ? 'الحالة' : 'Status'}</Th>
              <Th>{isAr ? 'إجراءات' : 'Actions'}</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={9} className="text-center text-charcoal/50 py-10">{isAr ? 'لا توجد تقييمات في هذا العرض' : 'No reviews in this view'}</td></tr>
            )}
            {filtered.map((r) => {
              const d = r.data;
              const fu = typeof d.follow_up === 'string' ? followupById.get(d.follow_up) : undefined;
              const clientId = typeof d.client === 'string' ? d.client : '';
              const phone = (d.client_phone_snapshot as string) || '';
              const prio = optOf(m.reviews, 'review_priority', d.review_priority, isAr);
              const status = optOf(m.reviews, 'review_status', d.review_status, isAr);
              return (
                <tr key={r.id} className="border-b border-sand/20 hover:bg-cream/50 cursor-pointer"
                  onClick={() => navigate(`/model/sales_valuation_reviews/${r.id}`)}>
                  <Td className="font-semibold text-charcoal">{clientNameOf(r, clientRows)}</Td>
                  <Td>{resolveUser(d.sales_rep)}</Td>
                  <Td>{optOf(m.reviews, 'followup_type', d.followup_type, isAr).label}</Td>
                  <Td>{optOf(m.reviews, 'follow_up_result', d.follow_up_result, isAr).label}</Td>
                  <Td className="whitespace-nowrap text-xs">{fmtDateTime(fu?.data.scheduled_datetime, isAr)}</Td>
                  <Td className="whitespace-nowrap text-xs">{fmtDateTime(fu?.data.actual_datetime, isAr)}</Td>
                  <Td><Pill label={prio.label} color={prio.color} /></Td>
                  <Td><Pill label={status.label} color={status.color} /></Td>
                  <Td onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-1">
                      <IconBtn title={isAr ? 'فتح التقييم' : 'Open'} onClick={() => navigate(`/model/sales_valuation_reviews/${r.id}`)}><Eye size={15} /></IconBtn>
                      <IconBtn title={isAr ? 'عرض العميل' : 'Client'} onClick={() => clientId && ev.openClient(clientId)}><User size={15} /></IconBtn>
                      <IconBtn title={isAr ? 'الاستماع للمكالمة' : 'Call'} onClick={() => ev.openCall(clientId, phone)}><Phone size={15} /></IconBtn>
                      <IconBtn title={isAr ? 'فتح واتساب' : 'WhatsApp'} onClick={() => clientId && ev.openWhatsApp(clientId)}><MessageCircle size={15} style={{ color: '#25D366' }} /></IconBtn>
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <EvidenceModals ev={ev.ev} onClose={ev.close} />
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-start font-semibold px-3 py-2.5">{children}</th>;
}
function Td({ children, className = '', onClick }: { children: React.ReactNode; className?: string; onClick?: (e: React.MouseEvent) => void }) {
  return <td className={`px-3 py-2.5 align-middle ${className}`} onClick={onClick}>{children}</td>;
}
function IconBtn({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button type="button" title={title} onClick={onClick}
      className="p-1.5 rounded-lg text-charcoal/60 hover:bg-copper/10 hover:text-copper transition-colors">
      {children}
    </button>
  );
}
