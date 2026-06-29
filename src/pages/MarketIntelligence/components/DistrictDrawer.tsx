import { useEffect, useState } from 'react';
import { X, FileDown, ExternalLink } from 'lucide-react';
import { fetchDistrict } from '@/lib/market/client';
import type { MarketBenchmark, DemandSupplyRow, BestValueListing } from '@/lib/market/types';
import { propertyTypeLabel } from '@/lib/market/propertyType';
import { formatPpm2, formatSARCompact } from '@/lib/market/format';
import { ConfidencePill, SourcePill, EmptyHint } from './shared';
import { generateMarketSnapshotPdf } from '../reports/marketSnapshotPdf';

export default function DistrictDrawer({ districtId, districtName, isAr, onClose }: { districtId: string; districtName: string; isAr: boolean; onClose: () => void }) {
  const [bench, setBench] = useState<MarketBenchmark[]>([]);
  const [demand, setDemand] = useState<DemandSupplyRow[]>([]);
  const [bestValue, setBestValue] = useState<BestValueListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetchDistrict(districtId).then((r) => { setBench(r.benchmarks); setDemand(r.demand_supply); setBestValue(r.best_value); })
      .catch(() => {}).finally(() => setLoading(false));
  }, [districtId]);

  const asking = bench.filter((b) => b.source_type === 'asking' && b.bedrooms_bucket === 'all');
  const ours = bench.filter((b) => b.source_type === 'our_verified');

  const onExport = async () => {
    setExporting(true);
    try {
      await generateMarketSnapshotPdf({
        isAr,
        heading: isAr ? `تقرير سوق — ${districtName}` : `Market snapshot — ${districtName}`,
        subheading: asking[0] ? (isAr ? `لقطة: ${asking[0].snapshot_date}` : `Snapshot: ${asking[0].snapshot_date}`) : undefined,
        benchmarks: asking,
        bestValue,
      });
    } finally { setExporting(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex" onClick={onClose}>
      <div className="flex-1 bg-black/30" />
      <div className="h-full w-full max-w-2xl overflow-y-auto bg-cream shadow-2xl" dir={isAr ? 'rtl' : 'ltr'} onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-sand/40 bg-chocolate px-5 py-4 text-white">
          <div>
            <div className="text-lg font-bold">{districtName}</div>
            <div className="text-[12px] opacity-80">{asking[0]?.city_name ?? ''}</div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onExport} disabled={exporting || !asking.length} className="inline-flex items-center gap-1.5 rounded-lg bg-copper px-3 py-1.5 text-sm font-bold text-white hover:bg-terracotta disabled:opacity-40">
              <FileDown size={15} />{isAr ? 'تقرير PDF' : 'PDF'}
            </button>
            <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-white/10"><X size={18} /></button>
          </div>
        </div>

        <div className="space-y-5 p-5">
          {loading && <div className="py-16 text-center text-charcoal/40">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</div>}

          {!loading && (
            <>
              <div>
                <div className="mb-2 text-sm font-bold text-charcoal">{isAr ? 'السوق المعروض حسب النوع' : 'Asking market by type'}</div>
                <div className="overflow-hidden rounded-xl border border-sand/30 bg-white">
                  <table className="w-full text-sm">
                    <thead className="bg-cream/60 text-[12px] text-charcoal/60"><tr>
                      <th className="px-3 py-2 text-start font-semibold">{isAr ? 'النوع' : 'Type'}</th>
                      <th className="px-3 py-2 text-end font-semibold">{isAr ? 'إعلانات' : 'Listings'}</th>
                      <th className="px-3 py-2 text-end font-semibold">{isAr ? 'وسيط /م²' : 'Median /m²'}</th>
                      <th className="px-3 py-2 text-end font-semibold">{isAr ? 'وسيط السعر' : 'Median price'}</th>
                      <th className="px-3 py-2 text-start font-semibold">{isAr ? 'الثقة' : 'Conf.'}</th>
                    </tr></thead>
                    <tbody>
                      {asking.length === 0 && <tr><td colSpan={5} className="p-3"><EmptyHint>{isAr ? 'لا توجد بيانات' : 'No data'}</EmptyHint></td></tr>}
                      {asking.map((b, i) => (
                        <tr key={i} className="border-t border-sand/20">
                          <td className="px-3 py-2 font-semibold text-charcoal">{propertyTypeLabel(b.property_type, isAr)}</td>
                          <td className="px-3 py-2 text-end tabular-nums">{b.deduped_count}</td>
                          <td className="px-3 py-2 text-end font-bold tabular-nums">{formatPpm2(b.median_price_per_sqm, isAr)}</td>
                          <td className="px-3 py-2 text-end tabular-nums text-charcoal/70">{formatSARCompact(b.median_price, isAr)}</td>
                          <td className="px-3 py-2"><ConfidencePill grade={b.confidence_grade} isAr={isAr} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {ours.length > 0 && (
                <div>
                  <div className="mb-2 flex items-center gap-2 text-sm font-bold text-charcoal"><SourcePill source="our_verified" isAr={isAr} />{isAr ? 'مخزوننا في هذا الحي' : 'Our inventory here'}</div>
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-3 text-sm">
                    {ours.map((o, i) => (
                      <div key={i} className="flex items-center justify-between py-0.5">
                        <span>{propertyTypeLabel(o.property_type, isAr)} · {o.deduped_count} {isAr ? 'وحدة' : 'units'}</span>
                        <span className="font-bold tabular-nums">{formatPpm2(o.median_price_per_sqm, isAr)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <div className="mb-2 text-sm font-bold text-charcoal">{isAr ? 'الطلب لدينا في هذا الحي' : 'Our demand here'}</div>
                {demand.length === 0 ? <EmptyHint>{isAr ? 'لا يوجد طلب عملاء مسجّل لهذا الحي.' : 'No recorded client demand for this district.'}</EmptyHint> : (
                  <div className="flex flex-wrap gap-2">
                    {demand.filter((d) => d.active_client_count > 0).slice(0, 12).map((d, i) => (
                      <span key={i} className="rounded-full border border-sand/40 bg-white px-2.5 py-1 text-[12px] text-charcoal">
                        {propertyTypeLabel(d.property_type, isAr)} · <b>{d.active_client_count}</b> {isAr ? 'عميل' : 'clients'}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div className="mb-2 flex items-center gap-2 text-sm font-bold text-charcoal">{isAr ? 'قوائم ذات قيمة جيدة' : 'Best-value listings'}
                  <span className="text-[11px] font-normal text-rose-600">{isAr ? '— تحتاج تحقق' : '— verify before offering'}</span></div>
                {bestValue.length === 0 ? <EmptyHint>{isAr ? 'لا توجد قوائم بأقل من المئين 25 على مرجع موثوق.' : 'No listings below P25 on a confident benchmark.'}</EmptyHint> : (
                  <div className="space-y-1.5">
                    {bestValue.slice(0, 10).map((l) => (
                      <div key={l.id} className="flex items-center justify-between rounded-lg border border-sand/30 bg-white px-3 py-2 text-sm">
                        <span className="truncate pe-2">{l.title || (isAr ? 'إعلان' : 'Listing')}</span>
                        <span className="flex shrink-0 items-center gap-3">
                          <span className="font-bold tabular-nums">{formatPpm2(l.price_per_sqm, isAr)}</span>
                          {l.vs_median_pct != null && <span className="text-emerald-700 tabular-nums">{l.vs_median_pct}%</span>}
                          {l.source_url && <a href={l.source_url} target="_blank" rel="noreferrer" className="text-copper" onClick={(e) => e.stopPropagation()}><ExternalLink size={14} /></a>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
