import { useMemo } from 'react';
import { useAppStore } from '@/stores/appStore';
import type { AppRecord, AppModel, ModelField } from '@/types';

/**
 * "Payment Plans" tab. Two modes, chosen by the host record's model:
 *
 *  • all_projects → a PROJECT OVERVIEW: the distinct payment *structures*
 *    offered across the project's units (deduped on the %-split), each with
 *    the number of units offering it and the price RANGE (AED + SAR) rolled up
 *    from those units. Answers "what payment plans does this project offer, and
 *    what do they cost".
 *
 *  • units → a UNIT DETAIL: this unit's own plan cards grouped by structure,
 *    so the same structure sold at several prices (different offers) reads as
 *    one row with its price(s), not eleven flat rows.
 *
 * Prices live per-unit (the source of truth is the `payment_plans` table field
 * on each unit); the project view never stores them, it aggregates live from
 * the units already in the store — same pattern as UnitsTabPane.
 */

interface PlanRow {
  plan?: string;
  down?: number;
  before_handover?: number;
  on_handover?: number;
  after_handover?: number;
  price?: number;
  price_sar?: number;
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const structKey = (p: PlanRow) =>
  `${num(p.down)}/${num(p.before_handover)}/${num(p.on_handover)}/${num(p.after_handover)}`;

function structLabel(p: PlanRow, isAr: boolean): string {
  const parts: string[] = [];
  if (num(p.down) > 0) parts.push(`${num(p.down)}% ${isAr ? 'مقدم' : 'down'}`);
  if (num(p.before_handover) > 0)
    parts.push(`${num(p.before_handover)}% ${isAr ? 'أثناء الإنشاء' : 'during construction'}`);
  if (num(p.on_handover) > 0) parts.push(`${num(p.on_handover)}% ${isAr ? 'عند التسليم' : 'on handover'}`);
  if (num(p.after_handover) > 0)
    parts.push(`${num(p.after_handover)}% ${isAr ? 'بعد التسليم' : 'post-handover'}`);
  return parts.join(' / ') || (isAr ? '—' : '—');
}

const fmtMoney = (v: number, isAr: boolean, ccy: string) =>
  v > 0 ? `${v.toLocaleString(isAr ? 'ar-AE' : 'en-US')} ${ccy}` : '—';

function planRowsOf(rec: AppRecord | undefined): PlanRow[] {
  const raw = (rec?.data as Record<string, unknown> | undefined)?.payment_plans;
  return Array.isArray(raw) ? (raw as PlanRow[]) : [];
}

/**
 * Two entry shapes:
 *  • `{ projectId }` — force the PROJECT OVERVIEW for that project id (used by
 *    ProjectDetailPage, which passes the resolved master id `view.id` so it
 *    works for both all_projects and our_projects records).
 *  • `{ record, model }` — generic record form: project overview when the model
 *    is all_projects, otherwise the unit detail for that record.
 */
export default function PaymentPlansTabPane({
  record,
  model,
  projectId,
}: {
  record?: AppRecord;
  model?: AppModel;
  projectId?: string;
}) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  // Project-overview target id: explicit prop wins; else the record itself if
  // it's an all_projects master. Null => unit-detail mode.
  const projModeId = projectId ?? (model?.name === 'all_projects' ? record?.id ?? null : null);
  const isProject = projModeId != null;

  // For project mode: resolve the units belonging to this project (same lookup
  // scan as UnitsTabPane, so a Builder rename of `project_id` doesn't break it).
  const unitsForProject = useMemo<AppRecord[]>(() => {
    if (!projModeId) return [];
    const unitsModel = models.find((m) => m.name === 'units');
    const allProjectsModel = models.find((m) => m.name === 'all_projects');
    if (!unitsModel || !allProjectsModel) return [];
    const lookups: ModelField[] = unitsModel.schema.sections
      .flatMap((s) => s.fields)
      .filter((f) => f.type === 'lookup' && f.lookup_model_id === allProjectsModel.id);
    if (lookups.length === 0) return [];
    return (records[unitsModel.id] ?? []).filter((r) =>
      lookups.some((f) => {
        const v = (r.data as Record<string, unknown>)[f.name];
        return Array.isArray(v) ? v.includes(projModeId) : v === projModeId;
      }),
    );
  }, [projModeId, models, records]);

  // ---- PROJECT OVERVIEW: group by structure across all units ----
  const projectPlans = useMemo(() => {
    const map = new Map<
      string,
      { sample: PlanRow; units: Set<string>; minAed: number; maxAed: number; minSar: number; maxSar: number }
    >();
    for (const u of unitsForProject) {
      for (const p of planRowsOf(u)) {
        const key = structKey(p);
        const price = num(p.price);
        const priceSar = num(p.price_sar);
        const g = map.get(key) ?? {
          sample: p,
          units: new Set<string>(),
          minAed: Infinity,
          maxAed: 0,
          minSar: Infinity,
          maxSar: 0,
        };
        g.units.add(u.id);
        if (price > 0) {
          g.minAed = Math.min(g.minAed, price);
          g.maxAed = Math.max(g.maxAed, price);
        }
        if (priceSar > 0) {
          g.minSar = Math.min(g.minSar, priceSar);
          g.maxSar = Math.max(g.maxSar, priceSar);
        }
        map.set(key, g);
      }
    }
    return [...map.values()]
      .map((g) => ({
        label: structLabel(g.sample, isAr),
        down: num(g.sample.down),
        during: num(g.sample.before_handover),
        onHandover: num(g.sample.on_handover),
        postHandover: num(g.sample.after_handover),
        unitCount: g.units.size,
        minAed: g.minAed === Infinity ? 0 : g.minAed,
        maxAed: g.maxAed,
        minSar: g.minSar === Infinity ? 0 : g.minSar,
        maxSar: g.maxSar,
      }))
      .sort((a, b) => a.down - b.down || a.during - b.during || a.onHandover - b.onHandover);
  }, [unitsForProject, isAr]);

  // ---- UNIT DETAIL: group this unit's cards by structure ----
  const unitPlans = useMemo(() => {
    const map = new Map<string, { sample: PlanRow; prices: { aed: number; sar: number }[] }>();
    for (const p of planRowsOf(record)) {
      const key = structKey(p);
      const g = map.get(key) ?? { sample: p, prices: [] };
      g.prices.push({ aed: num(p.price), sar: num(p.price_sar) });
      map.set(key, g);
    }
    return [...map.values()]
      .map((g) => {
        const aeds = g.prices.map((x) => x.aed).filter((x) => x > 0);
        const sars = g.prices.map((x) => x.sar).filter((x) => x > 0);
        return {
          label: structLabel(g.sample, isAr),
          down: num(g.sample.down),
          during: num(g.sample.before_handover),
          onHandover: num(g.sample.on_handover),
          postHandover: num(g.sample.after_handover),
          offers: g.prices.length,
          minAed: aeds.length ? Math.min(...aeds) : 0,
          maxAed: aeds.length ? Math.max(...aeds) : 0,
          minSar: sars.length ? Math.min(...sars) : 0,
          maxSar: sars.length ? Math.max(...sars) : 0,
        };
      })
      .sort((a, b) => a.down - b.down || a.during - b.during || a.onHandover - b.onHandover);
  }, [record, isAr]);

  const rows = isProject ? projectPlans : unitPlans;

  if (rows.length === 0) {
    return (
      <div className="card flex flex-col items-center justify-center py-12 text-charcoal/40">
        <p className="text-sm font-bold">
          {isAr ? 'لا توجد خطط سداد لهذا السجل بعد.' : 'No payment plans on this record yet.'}
        </p>
      </div>
    );
  }

  const entryDown = Math.min(...rows.map((r) => r.down));

  const priceCell = (min: number, max: number, ccy: string) => {
    if (min <= 0 && max <= 0) return '—';
    if (min === max) return fmtMoney(min, isAr, ccy);
    return `${fmtMoney(min, isAr, ccy)} — ${fmtMoney(max, isAr, ccy)}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-bold text-chocolate mb-1">
            {isAr ? 'خطط السداد' : 'Payment Plans'}
          </h2>
          <p className="text-xs text-charcoal/50">
            {isProject
              ? isAr
                ? `${rows.length} خطة متاحة · أقل دفعة مقدمة ${entryDown}% · محسوبة من ${unitsForProject.length} وحدة`
                : `${rows.length} plans available · entry down payment ${entryDown}% · rolled up from ${unitsForProject.length} units`
              : isAr
                ? `${rows.length} خطة لهذه الوحدة · أقل دفعة مقدمة ${entryDown}%`
                : `${rows.length} plans on this unit · entry down payment ${entryDown}%`}
          </p>
        </div>
        <span className="text-[11px] text-charcoal/40">
          {isAr ? 'الأسعار بالدرهم الإماراتي والريال السعودي' : 'Prices in AED & SAR'}
        </span>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-cream/50 border-b border-sand/40">
            <tr className="text-charcoal/60">
              <th className="text-start px-4 py-2.5 text-xs font-bold uppercase tracking-wider">
                {isAr ? 'الخطة' : 'Plan'}
              </th>
              <th className="text-center px-2 py-2.5 text-xs font-bold">{isAr ? 'مقدم' : 'Down'}</th>
              <th className="text-center px-2 py-2.5 text-xs font-bold">
                {isAr ? 'أثناء الإنشاء' : 'Constr.'}
              </th>
              <th className="text-center px-2 py-2.5 text-xs font-bold">
                {isAr ? 'عند التسليم' : 'Handover'}
              </th>
              <th className="text-center px-2 py-2.5 text-xs font-bold">
                {isProject ? (isAr ? 'وحدات' : 'Units') : (isAr ? 'عروض' : 'Offers')}
              </th>
              <th className="text-end px-4 py-2.5 text-xs font-bold">{isAr ? 'السعر (د.إ)' : 'Price (AED)'}</th>
              <th className="text-end px-4 py-2.5 text-xs font-bold">{isAr ? 'السعر (ر.س)' : 'Price (SAR)'}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const isCash = r.down === 100 && r.during === 0 && r.onHandover === 0;
              return (
                <tr key={i} className="border-b border-sand/25 last:border-0 hover:bg-cream/20">
                  <td className="px-4 py-2.5 font-medium text-charcoal">
                    {isCash ? (isAr ? 'دفعة كاملة (كاش)' : 'Full payment (cash)') : r.label}
                  </td>
                  <td className="text-center px-2 py-2.5 tabular-nums">{r.down ? `${r.down}%` : '—'}</td>
                  <td className="text-center px-2 py-2.5 tabular-nums text-charcoal/70">
                    {r.during ? `${r.during}%` : '—'}
                  </td>
                  <td className="text-center px-2 py-2.5 tabular-nums text-charcoal/70">
                    {r.onHandover ? `${r.onHandover}%` : '—'}
                    {r.postHandover ? ` (+${r.postHandover}% ${isAr ? 'بعد' : 'post'})` : ''}
                  </td>
                  <td className="text-center px-2 py-2.5 tabular-nums text-charcoal/60">
                    {'unitCount' in r ? r.unitCount : r.offers}
                  </td>
                  <td className="text-end px-4 py-2.5 tabular-nums text-charcoal whitespace-nowrap">
                    {priceCell(r.minAed, r.maxAed, isAr ? 'د.إ' : 'AED')}
                  </td>
                  <td className="text-end px-4 py-2.5 tabular-nums text-charcoal/70 whitespace-nowrap">
                    {priceCell(r.minSar, r.maxSar, isAr ? 'ر.س' : 'SAR')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-charcoal/40 leading-relaxed">
        {isProject
          ? isAr
            ? 'كل صف هو هيكل سداد متاح في المشروع (نسبة المقدم/الإنشاء/التسليم). السعر نطاق محسوب من كل الوحدات المتاحة — يختلف السعر حسب الوحدة.'
            : 'Each row is a payment structure offered in this project (down / construction / handover %). The price is a range rolled up across all available units — price varies by unit.'
          : isAr
            ? 'كل صف هيكل سداد لهذه الوحدة. قد يُعرض الهيكل نفسه بعدة أسعار (عروض مختلفة) — يظهر كنطاق سعري.'
            : 'Each row is a payment structure for this unit. The same structure can be offered at several prices (different offers) — shown as a price range.'}
      </p>
    </div>
  );
}
