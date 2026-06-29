import { useEffect, useState } from 'react';
import { FileDown } from 'lucide-react';
import { fetchPricingReport, type PricingReportRow } from '@/lib/market/client';
import { propertyTypeLabel } from '@/lib/market/propertyType';
import { formatPpm2 } from '@/lib/market/format';
import { ConfidencePill, EmptyHint, CaveatStrip } from './shared';
import { generatePricingReportPdf } from '../reports/pricingReportPdf';

export default function PricingTab({ isAr }: { isAr: boolean }) {
  const [rows, setRows] = useState<PricingReportRow[]>([]);
  const [snap, setSnap] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  useEffect(() => { fetchPricingReport().then((r) => { setRows(r.rows); setSnap(r.snapshot_date); }).catch(() => {}).finally(() => setLoading(false)); }, []);

  const pos = (p: string) => {
    if (p === 'below') return <span className="font-bold text-emerald-700">{isAr ? 'أقل من السوق' : 'Below'}</span>;
    if (p === 'premium') return <span className="font-bold text-rose-600">{isAr ? 'أعلى' : 'Premium'}</span>;
    if (p === 'fair') return <span className="font-bold text-charcoal">{isAr ? 'مطابق' : 'Fair'}</span>;
    return <span className="text-charcoal/40">{isAr ? 'غير كافٍ' : 'Too thin'}</span>;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <CaveatStrip>
          {isAr ? 'يقارن وحدات مشاريعنا بوسيط الأسعار المعروضة (وليست صفقات فعلية) لنفس الحي والنوع.' : 'Compares our project units against the median asking price (not transactions) for the same district and type.'}
        </CaveatStrip>
        <button onClick={async () => { setExporting(true); try { await generatePricingReportPdf(rows, isAr, snap); } finally { setExporting(false); } }}
          disabled={exporting || rows.length === 0}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-copper px-4 py-2.5 text-sm font-bold text-white hover:bg-terracotta disabled:opacity-40">
          <FileDown size={15} />{isAr ? 'تصدير PDF' : 'Export PDF'}
        </button>
      </div>

      <div className="card overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-cream/60 text-[12px] text-charcoal/60"><tr>
              <th className="px-3 py-2 text-start font-semibold">{isAr ? 'الحي' : 'District'}</th>
              <th className="px-3 py-2 text-start font-semibold">{isAr ? 'النوع' : 'Type'}</th>
              <th className="px-3 py-2 text-end font-semibold">{isAr ? 'سعرنا /م²' : 'Our /m²'}</th>
              <th className="px-3 py-2 text-end font-semibold">{isAr ? 'السوق /م²' : 'Market /m²'}</th>
              <th className="px-3 py-2 text-end font-semibold">{isAr ? 'الموضع' : 'Position'}</th>
              <th className="px-3 py-2 text-end font-semibold">{isAr ? 'طلب' : 'Demand'}</th>
              <th className="px-3 py-2 text-start font-semibold">{isAr ? 'ثقة السوق' : 'Mkt conf.'}</th>
            </tr></thead>
            <tbody>
              {loading && <tr><td colSpan={7} className="py-10 text-center text-charcoal/40">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</td></tr>}
              {!loading && rows.length === 0 && <tr><td colSpan={7} className="p-4"><EmptyHint>{isAr ? 'لا توجد وحدات موثقة بحي محدد بعد.' : 'No verified units with a resolved district yet.'}</EmptyHint></td></tr>}
              {!loading && rows.map((r, i) => (
                <tr key={i} className="border-t border-sand/20">
                  <td className="px-3 py-2 font-semibold text-charcoal">{(isAr ? r.district_name : r.district_name_en) ?? r.district_name}</td>
                  <td className="px-3 py-2">{propertyTypeLabel(r.property_type, isAr)}</td>
                  <td className="px-3 py-2 text-end font-bold tabular-nums">{formatPpm2(r.our_ppm2, isAr)}</td>
                  <td className="px-3 py-2 text-end tabular-nums text-charcoal/70">{r.market_ppm2 ? formatPpm2(r.market_ppm2, isAr) : '—'}</td>
                  <td className="px-3 py-2 text-end">{r.gap_pct != null && <span className="me-1 tabular-nums text-charcoal/50">{r.gap_pct > 0 ? '+' : ''}{r.gap_pct}%</span>}{pos(r.position)}</td>
                  <td className="px-3 py-2 text-end tabular-nums">{r.client_demand || '—'}</td>
                  <td className="px-3 py-2">{r.market_confidence ? <ConfidencePill grade={r.market_confidence as 'high' | 'medium' | 'low'} isAr={isAr} /> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
