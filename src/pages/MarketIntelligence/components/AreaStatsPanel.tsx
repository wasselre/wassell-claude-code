/**
 * Statistics for ONE selected area, wherever that area came from — a district
 * clicked on the map, a freehand shape, a road band, or a client's saved
 * preferences. Rendered identically in the Market Intelligence map tab and on
 * the client record, because it is the same question with a different input.
 *
 * Honesty rules carried over from the rest of Market Intelligence:
 *   • asking prices, never "market value"
 *   • confidence grade + duplicate ratio always visible
 *   • the share of ads WITHOUT coordinates is stated, because those can never
 *     fall inside an area and their absence would otherwise read as a thin market
 *   • an unresolved geo rule is called out rather than quietly contributing nothing
 */
import { AlertTriangle, MapPin, Building2, Users, TrendingUp } from 'lucide-react';
import type { AreaStats, GeoCoverage } from '@/lib/market/client';
import { propertyTypeLabel } from '@/lib/market/propertyType';
import { ConfidencePill } from './shared';

interface Props {
  stats: AreaStats | null;
  coverage: GeoCoverage | null;
  loading: boolean;
  isAr: boolean;
  /** Optional client context — renders the budget-vs-market read. */
  budget?: { min: number | null; max: number | null } | null;
  emptyHint?: string;
}

const nf = (n: number | null | undefined, digits = 0): string =>
  n == null || !Number.isFinite(n) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });

const money = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
};

export default function AreaStatsPanel({ stats, coverage, loading, isAr, budget, emptyHint }: Props) {
  if (loading) {
    return <div className="card p-6 text-center text-sm text-charcoal/40">{isAr ? 'جارٍ الحساب…' : 'Calculating…'}</div>;
  }
  if (!stats) {
    return (
      <div className="card p-6 text-center text-sm text-charcoal/45">
        {emptyHint ?? (isAr ? 'اختر منطقة على الخريطة أو أضف نطاقاً لعرض الأرقام.' : 'Pick an area on the map, or add a rule, to see the numbers.')}
      </div>
    );
  }

  const failedRules = (stats.geo_items ?? []).filter((g) => g.validation_status !== 'ok');
  const ppm2 = stats.price_per_sqm ?? {};
  const price = stats.price ?? {};
  const our = stats.our_inventory ?? {};

  // Our price against the market in the SAME area — the comparison that decides
  // whether we are pricing above or below where we sell.
  const ourPpm2 = our.median_price_per_sqm ?? null;
  const mktPpm2 = ppm2.median ?? null;
  const gapPct = ourPpm2 && mktPpm2 ? Math.round(((ourPpm2 - mktPpm2) / mktPpm2) * 100) : null;

  // Budget position — same three-way read the client market snapshot PDF uses.
  const bMax = budget?.max ?? null;
  const budgetPos = bMax && price.p25 != null && price.p75 != null
    ? (bMax < price.p25 ? 'below' : bMax > price.p75 ? 'above' : 'within')
    : null;

  return (
    <div className="space-y-3">
      {/* Headline */}
      <div className="card p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-sm font-bold text-charcoal">
            {isAr ? 'السوق المعروض في هذه المنطقة' : 'Current asking market in this area'}
          </div>
          <ConfidencePill grade={stats.confidence_grade} isAr={isAr} />
        </div>

        {stats.deduped_count === 0 ? (
          <div className="py-4 text-center text-sm text-charcoal/45">
            {isAr ? 'لا توجد إعلانات مطابقة داخل هذه المنطقة.' : 'No matching listings inside this area.'}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label={isAr ? 'متوسط ر.س/م²' : 'Median SAR/m²'} value={nf(ppm2.median)} strong />
              <Stat label={isAr ? 'النطاق السائد /م²' : 'Prevailing range /m²'} value={`${nf(ppm2.p25)}–${nf(ppm2.p75)}`} />
              <Stat label={isAr ? 'متوسط السعر' : 'Median price'} value={money(price.median)} />
              <Stat label={isAr ? 'متوسط المساحة' : 'Median area'} value={`${nf(stats.median_area)} ${isAr ? 'م²' : 'm²'}`} />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-charcoal/50">
              <span>{isAr ? 'إعلانات' : 'Listings'}: <b className="text-charcoal/70">{nf(stats.deduped_count)}</b> {isAr ? `(من ${nf(stats.raw_count)} قبل حذف التكرار)` : `(from ${nf(stats.raw_count)} before dedup)`}</span>
              <span>{isAr ? 'تكرار' : 'Duplicates'}: {Math.round((stats.duplicate_ratio ?? 0) * 100)}%</span>
              {stats.districts?.length > 0 && (
                <span>{isAr ? 'أحياء' : 'Districts'}: {stats.districts.length}</span>
              )}
            </div>
          </>
        )}
      </div>

      {/* Caveats — never collapsed away */}
      {(failedRules.length > 0 || (coverage && coverage.without_coordinates > 0)) && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3 text-[12px] text-amber-900">
          <div className="mb-1 flex items-center gap-1.5 font-bold">
            <AlertTriangle size={13} /> {isAr ? 'ما الذي لا تشمله هذه الأرقام' : 'What these numbers exclude'}
          </div>
          <ul className="list-inside list-disc space-y-0.5">
            {coverage && coverage.without_coordinates > 0 && (
              <li>
                {isAr
                  ? `${nf(coverage.without_coordinates)} إعلاناً (${coverage.pct_without_coordinates}%) بلا إحداثيات — لا يمكن أن تظهر داخل أي منطقة مرسومة.`
                  : `${nf(coverage.without_coordinates)} ads (${coverage.pct_without_coordinates}%) have no coordinates — they cannot appear inside any drawn area.`}
              </li>
            )}
            {failedRules.length > 0 && (
              <li>
                {isAr
                  ? `${failedRules.length} من قواعد الموقع لم يتم حلها ولم تُحتسب.`
                  : `${failedRules.length} location rule(s) could not be resolved and contributed nothing.`}
              </li>
            )}
          </ul>
        </div>
      )}

      {/* Budget position */}
      {budgetPos && (
        <div className="card p-4">
          <div className="mb-1 text-sm font-bold text-charcoal">{isAr ? 'ميزانية العميل مقابل السوق' : 'Client budget vs this market'}</div>
          <div className="text-[13px] text-charcoal/70">
            {isAr ? 'الميزانية' : 'Budget'}: <b>{money(bMax)} {isAr ? 'ر.س' : 'SAR'}</b> ·{' '}
            {isAr ? 'النطاق السائد' : 'Prevailing range'}: {money(price.p25)}–{money(price.p75)}
          </div>
          <div className={`mt-1.5 text-[13px] font-bold ${
            budgetPos === 'within' ? 'text-emerald-700' : budgetPos === 'below' ? 'text-amber-700' : 'text-rose-700'}`}>
            {budgetPos === 'within' ? (isAr ? '✓ ضمن النطاق السائد' : '✓ Within the prevailing range')
              : budgetPos === 'below' ? (isAr ? '↓ أقل من معظم المعروض هنا' : '↓ Below most of what is on offer here')
              : (isAr ? '↑ أعلى من معظم المعروض هنا' : '↑ Above most of what is on offer here')}
          </div>
        </div>
      )}

      {/* Our position */}
      <div className="card p-4">
        <div className="mb-2 flex items-center gap-1.5 text-sm font-bold text-charcoal">
          <Building2 size={14} className="text-copper" /> {isAr ? 'مخزوننا داخل المنطقة' : 'Our inventory inside this area'}
        </div>
        {(our.unit_count ?? 0) === 0 ? (
          <div className="text-[13px] text-charcoal/45">
            {isAr ? 'لا توجد لدينا وحدات داخل هذه المنطقة.' : 'We hold no units inside this area.'}
            {(stats.demand?.active_clients ?? 0) > 0 && (
              <span className="ms-1 font-semibold text-amber-700">
                {isAr ? `— مع وجود ${nf(stats.demand?.active_clients)} عميلاً يبحثون هنا.` : `— while ${nf(stats.demand?.active_clients)} client(s) are looking here.`}
              </span>
            )}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label={isAr ? 'مشاريع' : 'Projects'} value={nf(our.project_count)} />
              <Stat label={isAr ? 'وحدات' : 'Units'} value={nf(our.unit_count)} />
              <Stat label={isAr ? 'متاحة' : 'Available'} value={nf(our.available_units)} />
              <Stat label={isAr ? 'سعرنا /م²' : 'Our SAR/m²'} value={nf(ourPpm2)} strong />
            </div>
            {gapPct != null && (
              <div className={`mt-2.5 flex items-center gap-1.5 text-[13px] font-bold ${
                gapPct > 10 ? 'text-rose-700' : gapPct < -10 ? 'text-emerald-700' : 'text-charcoal/70'}`}>
                <TrendingUp size={13} />
                {gapPct > 0
                  ? (isAr ? `أعلى من السوق بـ ${gapPct}%` : `${gapPct}% above the asking market`)
                  : (isAr ? `أقل من السوق بـ ${Math.abs(gapPct)}%` : `${Math.abs(gapPct)}% below the asking market`)}
              </div>
            )}
          </>
        )}
      </div>

      {/* By type */}
      {stats.by_type?.length > 0 && (
        <div className="card p-4">
          <div className="mb-2 text-sm font-bold text-charcoal">{isAr ? 'حسب نوع العقار' : 'By property type'}</div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-charcoal/50">
                  <th className="py-1 text-start font-semibold">{isAr ? 'النوع' : 'Type'}</th>
                  <th className="py-1 text-end font-semibold">{isAr ? 'إعلانات' : 'Ads'}</th>
                  <th className="py-1 text-end font-semibold">{isAr ? 'متوسط /م²' : 'Median /m²'}</th>
                  <th className="py-1 text-end font-semibold">{isAr ? 'النطاق السائد' : 'Range'}</th>
                  <th className="py-1 text-end font-semibold">{isAr ? 'متوسط السعر' : 'Median price'}</th>
                </tr>
              </thead>
              <tbody>
                {stats.by_type.map((t) => (
                  <tr key={t.property_type} className="border-t border-sand/25">
                    <td className="py-1.5 font-semibold text-charcoal">{propertyTypeLabel(t.property_type, isAr)}</td>
                    <td className="py-1.5 text-end text-charcoal/60">{nf(t.count)}</td>
                    <td className="py-1.5 text-end font-bold text-charcoal">{nf(t.median_price_per_sqm)}</td>
                    <td className="py-1.5 text-end text-charcoal/60">{nf(t.p25_price_per_sqm)}–{nf(t.p75_price_per_sqm)}</td>
                    <td className="py-1.5 text-end text-charcoal/60">{money(t.median_price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Districts touched */}
      {stats.districts?.length > 0 && (
        <div className="card p-4">
          <div className="mb-0.5 flex items-center gap-1.5 text-sm font-bold text-charcoal">
            <MapPin size={14} className="text-copper" />
            {isAr ? 'الأحياء التي تغطيها المنطقة' : 'Districts this area covers'}
          </div>
          {/* The bare number read as noise — say what it counts. */}
          <div className="mb-2 text-[11px] text-charcoal/45">
            {isAr
              ? 'الرقم بجانب كل حي هو عدد الإعلانات التي يساهم بها في هذه المنطقة.'
              : 'The number beside each district is how many listings it contributes to this area.'}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {stats.districts.slice(0, 24).map((d) => (
              <span key={d.district_id} className="rounded-full bg-cream px-2.5 py-1 text-[11px] text-charcoal/75">
                {isAr ? d.district_name : (d.district_name_en || d.district_name)}
                <span className="mx-1 text-charcoal/30">·</span>
                <b>{nf(d.count)}</b>
                <span className="ms-0.5 text-charcoal/45">{isAr ? 'إعلان' : 'ads'}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Demand */}
      <div className="card flex items-center gap-2 p-4 text-[13px] text-charcoal/70">
        <Users size={14} className="text-copper" />
        {isAr
          ? `${nf(stats.demand?.active_clients ?? 0)} عميلاً حددوا أحياءً داخل هذه المنطقة ضمن تفضيلاتهم.`
          : `${nf(stats.demand?.active_clients ?? 0)} client(s) list districts inside this area in their preferences.`}
        <span className="text-[11px] text-charcoal/40">
          {isAr ? '(حسب تفضيلات الأحياء فقط)' : '(district preferences only)'}
        </span>
      </div>
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <div className={`${strong ? 'text-xl' : 'text-lg'} font-bold text-charcoal`}>{value}</div>
      <div className="text-[11px] text-charcoal/55">{label}</div>
    </div>
  );
}
