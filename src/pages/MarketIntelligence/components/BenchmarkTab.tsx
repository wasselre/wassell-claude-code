import { useEffect, useState } from 'react';
import { fetchBenchmarks, fetchFilters, type BenchmarkFilters } from '@/lib/market/client';
import type { MarketBenchmark } from '@/lib/market/types';
import { propertyTypeLabel, CANON_PROPERTY_TYPES } from '@/lib/market/propertyType';
import { formatPpm2, formatSARCompact, bedroomsBucketLabel, BEDROOMS_BUCKETS } from '@/lib/market/format';
import { ConfidencePill, EmptyHint } from './shared';
import DistrictDrawer from './DistrictDrawer';

export default function BenchmarkTab({ isAr }: { isAr: boolean }) {
  const [cities, setCities] = useState<{ id: string; name: string }[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [filters, setFilters] = useState<BenchmarkFilters>({ source_type: 'asking', bedrooms_bucket: 'all', page: 1, page_size: 50 });
  const [rows, setRows] = useState<MarketBenchmark[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [openDistrict, setOpenDistrict] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => { fetchFilters().then((f) => { setCities(f.cities); setTypes(f.property_types); }).catch(() => {}); }, []);

  useEffect(() => {
    setLoading(true);
    fetchBenchmarks(filters).then((r) => { setRows(r.rows); setTotal(r.total); }).catch(() => setRows([])).finally(() => setLoading(false));
  }, [filters]);

  const set = (patch: Partial<BenchmarkFilters>) => setFilters((f) => ({ ...f, ...patch, page: patch.page ?? 1 }));
  const pageCount = Math.max(1, Math.ceil(total / (filters.page_size ?? 50)));
  const selClass = 'rounded-lg border border-sand/40 bg-white px-2.5 py-1.5 text-sm text-charcoal';

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center gap-2 p-3">
        <select className={selClass} value={filters.city_id ?? ''} onChange={(e) => set({ city_id: e.target.value || undefined })}>
          <option value="">{isAr ? 'كل المدن' : 'All cities'}</option>
          {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className={selClass} value={filters.property_type ?? ''} onChange={(e) => set({ property_type: e.target.value || undefined })}>
          <option value="">{isAr ? 'كل الأنواع' : 'All types'}</option>
          {(types.length ? types : CANON_PROPERTY_TYPES).map((p) => <option key={p} value={p}>{propertyTypeLabel(p, isAr)}</option>)}
        </select>
        <select className={selClass} value={filters.bedrooms_bucket ?? 'all'} onChange={(e) => set({ bedrooms_bucket: e.target.value })}>
          <option value="all">{bedroomsBucketLabel('all', isAr)}</option>
          {BEDROOMS_BUCKETS.map((b) => <option key={b} value={b}>{bedroomsBucketLabel(b, isAr)}</option>)}
        </select>
        <select className={selClass} value={filters.source_type ?? 'asking'} onChange={(e) => set({ source_type: e.target.value })}>
          <option value="asking">{isAr ? 'السوق المعروض' : 'Asking market'}</option>
          <option value="our_verified">{isAr ? 'مخزون وصل' : 'Wassel verified'}</option>
          <option value="transaction">{isAr ? 'صفقات فعلية' : 'Transactions'}</option>
        </select>
        <select className={selClass} value={filters.confidence_grade ?? ''} onChange={(e) => set({ confidence_grade: e.target.value || undefined })}>
          <option value="">{isAr ? 'كل مستويات الثقة' : 'All confidence'}</option>
          <option value="high">{isAr ? 'مرتفعة' : 'High'}</option>
          <option value="medium">{isAr ? 'متوسطة' : 'Medium'}</option>
          <option value="low">{isAr ? 'منخفضة' : 'Low'}</option>
        </select>
        <span className="ms-auto text-[12px] text-charcoal/50">{isAr ? `${total} شريحة` : `${total} segments`}</span>
      </div>

      <div className="card overflow-hidden p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-cream/60 text-[12px] text-charcoal/60">
              <tr>
                <Th>{isAr ? 'الحي' : 'District'}</Th>
                <Th>{isAr ? 'النوع' : 'Type'}</Th>
                <Th end>{isAr ? 'إعلانات' : 'Listings'}</Th>
                <Th end>{isAr ? 'وسيط ر.س/م²' : 'Median /m²'}</Th>
                <Th end>P25–P75 /m²</Th>
                <Th end>{isAr ? 'وسيط السعر' : 'Median price'}</Th>
                <Th end>{isAr ? 'تكرار' : 'Dup.'}</Th>
                <Th>{isAr ? 'الثقة' : 'Confidence'}</Th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={8} className="py-10 text-center text-charcoal/40">{isAr ? 'جارٍ التحميل…' : 'Loading…'}</td></tr>}
              {!loading && rows.length === 0 && <tr><td colSpan={8} className="p-4"><EmptyHint>{isAr ? 'لا توجد شرائح مطابقة.' : 'No matching segments.'}</EmptyHint></td></tr>}
              {!loading && rows.map((r, i) => (
                <tr key={i} className="cursor-pointer border-t border-sand/20 hover:bg-cream/40"
                    onClick={() => r.district_id && setOpenDistrict({ id: r.district_id, name: (isAr ? r.district_name : r.district_name_en) ?? r.district_name ?? '' })}>
                  <td className="px-3 py-2 font-semibold text-charcoal">{(isAr ? r.district_name : r.district_name_en) ?? r.district_name ?? '—'}<div className="text-[11px] font-normal text-charcoal/40">{r.city_name}</div></td>
                  <td className="px-3 py-2">{propertyTypeLabel(r.property_type, isAr)}</td>
                  <td className="px-3 py-2 text-end tabular-nums">{r.deduped_count}</td>
                  <td className="px-3 py-2 text-end font-bold tabular-nums text-charcoal">{formatPpm2(r.median_price_per_sqm, isAr)}</td>
                  <td className="px-3 py-2 text-end tabular-nums text-charcoal/70">{r.p25_price_per_sqm ? Math.round(r.p25_price_per_sqm).toLocaleString('en-US') : '—'}–{r.p75_price_per_sqm ? Math.round(r.p75_price_per_sqm).toLocaleString('en-US') : '—'}</td>
                  <td className="px-3 py-2 text-end tabular-nums text-charcoal/70">{formatSARCompact(r.median_price, isAr)}</td>
                  <td className="px-3 py-2 text-end tabular-nums text-charcoal/50">{Math.round((r.duplicate_ratio ?? 0) * 100)}%</td>
                  <td className="px-3 py-2"><ConfidencePill grade={r.confidence_grade} isAr={isAr} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pageCount > 1 && (
          <div className="flex items-center justify-between border-t border-sand/20 px-3 py-2 text-sm">
            <button className="text-charcoal/60 disabled:opacity-30" disabled={(filters.page ?? 1) <= 1} onClick={() => set({ page: (filters.page ?? 1) - 1 })}>{isAr ? 'السابق' : 'Prev'}</button>
            <span className="text-[12px] text-charcoal/50">{isAr ? `صفحة ${filters.page ?? 1} من ${pageCount}` : `Page ${filters.page ?? 1} of ${pageCount}`}</span>
            <button className="text-charcoal/60 disabled:opacity-30" disabled={(filters.page ?? 1) >= pageCount} onClick={() => set({ page: (filters.page ?? 1) + 1 })}>{isAr ? 'التالي' : 'Next'}</button>
          </div>
        )}
      </div>

      {openDistrict && <DistrictDrawer districtId={openDistrict.id} districtName={openDistrict.name} isAr={isAr} onClose={() => setOpenDistrict(null)} />}
    </div>
  );
}

function Th({ children, end }: { children: React.ReactNode; end?: boolean }) {
  return <th className={`px-3 py-2 font-semibold ${end ? 'text-end' : 'text-start'}`}>{children}</th>;
}
