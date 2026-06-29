import { useEffect, useState } from 'react';
import { fetchDemandSupply } from '@/lib/market/client';
import type { DemandSupplyRow } from '@/lib/market/types';
import { propertyTypeLabel } from '@/lib/market/propertyType';
import { budgetBucketLabel } from '@/lib/market/format';
import { ConfidencePill, EmptyHint, CaveatStrip } from './shared';

export default function DemandSupplyTab({ isAr }: { isAr: boolean }) {
  const [rows, setRows] = useState<DemandSupplyRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchDemandSupply({}).then((r) => setRows(r.rows)).catch(() => setRows([])).finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-4">
      <CaveatStrip>
        {isAr
          ? 'الطلب = العملاء النشطون الذين سجّلوا تفضيلات (حي/مشروع/نوع/ميزانية). بيانات الطلب الحالية محدودة، لذا اعتبرها مؤشراً وليس حكماً نهائياً.'
          : 'Demand = active clients with recorded preferences (district/project/type/budget). Current demand data is thin — treat it as a signal, not a verdict.'}
      </CaveatStrip>
      <div className="card overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-cream/60 text-[12px] text-charcoal/60"><tr>
              <th className="px-3 py-2 text-start font-semibold">{isAr ? 'الحي' : 'District'}</th>
              <th className="px-3 py-2 text-start font-semibold">{isAr ? 'النوع' : 'Type'}</th>
              <th className="px-3 py-2 text-start font-semibold">{isAr ? 'الميزانية' : 'Budget'}</th>
              <th className="px-3 py-2 text-end font-semibold">{isAr ? 'عملاء' : 'Clients'}</th>
              <th className="px-3 py-2 text-end font-semibold">{isAr ? 'سوق' : 'Market'}</th>
              <th className="px-3 py-2 text-end font-semibold">{isAr ? 'لدينا' : 'Ours'}</th>
              <th className="px-3 py-2 text-end font-semibold">{isAr ? 'أولوية بيع' : 'Sell'}</th>
              <th className="px-3 py-2 text-end font-semibold">{isAr ? 'أولوية تطوير' : 'Acquire'}</th>
              <th className="px-3 py-2 text-start font-semibold">{isAr ? 'الثقة' : 'Conf.'}</th>
            </tr></thead>
            <tbody>
              {loading && <tr><td colSpan={9} className="py-10 text-center text-charcoal/40">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</td></tr>}
              {!loading && rows.length === 0 && <tr><td colSpan={9} className="p-4"><EmptyHint>{isAr ? 'لا يوجد طلب مسجّل بعد.' : 'No recorded demand yet.'}</EmptyHint></td></tr>}
              {!loading && rows.map((r, i) => (
                <tr key={i} className="border-t border-sand/20">
                  <td className="px-3 py-2 font-semibold text-charcoal">{(isAr ? r.district_name : r.district_name_en) ?? r.district_name ?? '—'}</td>
                  <td className="px-3 py-2">{r.property_type === 'all' ? (isAr ? 'الكل' : 'All') : propertyTypeLabel(r.property_type, isAr)}</td>
                  <td className="px-3 py-2 text-charcoal/70">{budgetBucketLabel(r.budget_bucket, isAr)}</td>
                  <td className="px-3 py-2 text-end font-bold tabular-nums text-charcoal">{r.active_client_count}</td>
                  <td className="px-3 py-2 text-end tabular-nums text-charcoal/70">{r.matching_market_listing_count}</td>
                  <td className="px-3 py-2 text-end tabular-nums">{r.matching_our_project_count > 0 ? <b className="text-emerald-700">{r.matching_our_project_count}</b> : <span className="text-charcoal/30">0</span>}</td>
                  <td className="px-3 py-2 text-end tabular-nums">{r.sales_priority_score > 0 ? <b className="text-emerald-700">{r.sales_priority_score}</b> : '—'}</td>
                  <td className="px-3 py-2 text-end tabular-nums">{r.acquisition_priority_score >= 2 ? <b className="text-amber-700">{r.acquisition_priority_score}</b> : r.acquisition_priority_score}</td>
                  <td className="px-3 py-2"><ConfidencePill grade={r.confidence_grade} isAr={isAr} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
