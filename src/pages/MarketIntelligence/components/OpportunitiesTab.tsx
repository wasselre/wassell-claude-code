import { useEffect, useState } from 'react';
import { TrendingUp, Search, Scale, AlertTriangle } from 'lucide-react';
import { fetchOpportunities, type OpportunityQueues } from '@/lib/market/client';
import type { DemandSupplyRow } from '@/lib/market/types';
import { propertyTypeLabel } from '@/lib/market/propertyType';
import { ConfidencePill, EmptyHint } from './shared';

export default function OpportunitiesTab({ isAr }: { isAr: boolean }) {
  const [data, setData] = useState<OpportunityQueues | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { fetchOpportunities().then(setData).catch(() => {}).finally(() => setLoading(false)); }, []);

  if (loading) return <div className="py-16 text-center text-charcoal/40">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>;
  if (!data) return <EmptyHint>{isAr ? 'تعذّر تحميل الفرص.' : 'Could not load opportunities.'}</EmptyHint>;

  const dsName = (r: DemandSupplyRow) => (isAr ? r.district_name : r.district_name_en) ?? r.district_name ?? '—';
  const tName = (t: string) => (t === 'all' ? (isAr ? 'الكل' : 'All') : propertyTypeLabel(t, isAr));

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Queue icon={<TrendingUp size={16} />} tone="good"
        title={isAr ? 'فرص بيع الآن' : 'Sales push'}
        hint={isAr ? 'طلب نشط ولدينا مخزون مطابق' : 'Active demand + we have matching inventory'}>
        {data.sales_push.length === 0 ? <Empty isAr={isAr} /> : data.sales_push.map((r, i) => (
          <Row key={i} left={`${dsName(r)} · ${tName(r.property_type)}`}
            right={isAr ? `${r.active_client_count} عميل · ${r.matching_our_project_count} مشروع` : `${r.active_client_count} clients · ${r.matching_our_project_count} projects`}
            badge={<ConfidencePill grade={r.confidence_grade} isAr={isAr} />} />
        ))}
      </Queue>

      <Queue icon={<Search size={16} />} tone="warn"
        title={isAr ? 'فرص تطوير / شراء' : 'Acquisition'}
        hint={isAr ? 'طلب بلا مخزون لدينا، والسوق يثبت وجود المعروض' : 'Demand, no Wassel supply, market proves supply exists'}>
        {data.acquisition.length === 0 ? <Empty isAr={isAr} /> : data.acquisition.map((r, i) => (
          <Row key={i} left={`${dsName(r)} · ${tName(r.property_type)}`}
            right={isAr ? `${r.active_client_count} عميل · ${r.matching_market_listing_count} بالسوق` : `${r.active_client_count} clients · ${r.matching_market_listing_count} in market`}
            badge={<ConfidencePill grade={r.confidence_grade} isAr={isAr} />} />
        ))}
      </Queue>

      <Queue icon={<Scale size={16} />} tone="neutral"
        title={isAr ? 'مراقبة التسعير' : 'Pricing watch'}
        hint={isAr ? 'مشاريعنا أعلى/أدنى من السوق بفارق ملحوظ' : 'Our projects notably above/below market'}>
        {data.pricing_watch.length === 0 ? <Empty isAr={isAr} /> : data.pricing_watch.map((r, i) => (
          <Row key={i} left={`${r.district_name} · ${tName(r.property_type)}`}
            right={<span className={r.gap_pct >= 0 ? 'text-rose-600' : 'text-emerald-700'}>{r.gap_pct > 0 ? '+' : ''}{r.gap_pct}% {isAr ? 'مقابل السوق' : 'vs market'}</span>}
            badge={<ConfidencePill grade={r.confidence_grade as 'high' | 'medium' | 'low'} isAr={isAr} />} />
        ))}
      </Queue>

      <Queue icon={<AlertTriangle size={16} />} tone="thin"
        title={isAr ? 'تحذيرات سوق رقيق' : 'Thin-market warnings'}
        hint={isAr ? 'يوجد طلب لكن بيانات المرجع ضعيفة' : 'Demand exists but benchmark confidence is weak'}>
        {data.thin_market.length === 0 ? <Empty isAr={isAr} /> : data.thin_market.map((r, i) => (
          <Row key={i} left={`${dsName(r)} · ${tName(r.property_type)}`}
            right={isAr ? `${r.active_client_count} عميل` : `${r.active_client_count} clients`}
            badge={<ConfidencePill grade={r.confidence_grade} isAr={isAr} />} />
        ))}
      </Queue>
    </div>
  );
}

function Queue({ icon, title, hint, tone, children }: { icon: React.ReactNode; title: string; hint: string; tone: 'good' | 'warn' | 'neutral' | 'thin'; children: React.ReactNode }) {
  const ring = tone === 'good' ? 'ring-emerald-200' : tone === 'warn' ? 'ring-amber-200' : tone === 'thin' ? 'ring-rose-200' : 'ring-sand/40';
  return (
    <div className={`card p-4 ring-1 ${ring}`}>
      <div className="mb-1 flex items-center gap-2 text-sm font-bold text-charcoal">{icon}{title}</div>
      <div className="mb-3 text-[12px] text-charcoal/50">{hint}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}
function Row({ left, right, badge }: { left: React.ReactNode; right: React.ReactNode; badge?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-sand/25 bg-white px-3 py-2 text-sm">
      <span className="truncate font-semibold text-charcoal">{left}</span>
      <span className="flex shrink-0 items-center gap-2 text-charcoal/70">{right}{badge}</span>
    </div>
  );
}
function Empty({ isAr }: { isAr: boolean }) {
  return <div className="rounded-lg border border-dashed border-sand/40 px-3 py-4 text-center text-[12px] text-charcoal/40">{isAr ? 'لا توجد عناصر' : 'Nothing here'}</div>;
}
