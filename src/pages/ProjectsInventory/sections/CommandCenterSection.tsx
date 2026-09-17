/**
 * Command Center — demand-vs-supply operating page (Phase 4).
 *
 * Every number is a sum of real records, traceable to the projects / clients
 * behind it. Demand uses the SHARED demand layer (the canonical isActive
 * resolver — one source of truth with the Customer Demand tab). Supply uses the
 * available-only rollups. No fake data, no placeholder charts, no
 * market_demand_supply_benchmarks (governing rules #11–#13, decision #5).
 *
 * The full authorized client / project / unit / district sets are explicitly
 * ensured-loaded before aggregating — never a paginated slice.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Building2, Star, CheckCircle2, Clock, BadgeCheck, Hammer, Users, AlertTriangle,
  ChevronDown, ChevronRight, Compass, RefreshCw,
} from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { modelByName, asFiniteNumber } from '@/lib/projects/projectView';
import { getEntityFieldText, useRecordTranslationVersion } from '@/lib/recordTranslation/store';
import {
  buildActiveClientDemand, computeOpportunityGaps, projectDistrictIds, type OpportunityGap,
} from '@/lib/demand/demandAggregation';
import GeographySection from './GeographySection';

const num = (v: unknown) => asFiniteNumber(v) ?? 0;
const idArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' && v ? [v] : []);

function priceBand(p: number, isAr: boolean): string {
  if (p < 500_000) return isAr ? 'أقل من ٥٠٠ ألف' : '< 500k';
  if (p < 1_000_000) return isAr ? '٥٠٠ ألف – مليون' : '500k–1M';
  if (p < 2_000_000) return isAr ? '١ – ٢ مليون' : '1–2M';
  if (p < 3_000_000) return isAr ? '٢ – ٣ مليون' : '2–3M';
  if (p < 5_000_000) return isAr ? '٣ – ٥ مليون' : '3–5M';
  return isAr ? '٥ مليون+' : '5M+';
}
function bedBand(b: number, isAr: boolean): string {
  if (b <= 0) return isAr ? 'استوديو' : 'Studio';
  if (b >= 5) return isAr ? '٥+ غرف' : '5+';
  return isAr ? `${b} غرف` : `${b}`;
}

function Kpi({ icon, label, value, tone, hint }: { icon: React.ReactNode; label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="card p-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: (tone ?? '#B8734F') + '1A', color: tone ?? '#B8734F' }}>{icon}</div>
      <div className="min-w-0">
        <div className="text-xl font-bold text-charcoal leading-none">{value}</div>
        <div className="text-xs text-charcoal/50 mt-1 truncate">{label}</div>
        {hint && <div className="text-[10px] text-charcoal/35 mt-0.5 truncate">{hint}</div>}
      </div>
    </div>
  );
}

/** A labelled breakdown as a bar list — real counts only. */
function Breakdown({ title, rows, isAr }: { title: string; rows: { key: string; label: string; value: number }[]; isAr: boolean }) {
  const shown = rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 12);
  const max = shown.reduce((m, r) => Math.max(m, r.value), 0) || 1;
  return (
    <div className="card p-4">
      <div className="text-[0.6875rem] font-bold text-charcoal/40 uppercase tracking-widest mb-2">{title}</div>
      {shown.length === 0 ? (
        <div className="text-xs text-charcoal/40">{isAr ? 'لا بيانات' : 'No data'}</div>
      ) : (
        <div className="space-y-1.5">
          {shown.map((r) => (
            <div key={r.key} className="flex items-center gap-2 text-sm">
              <div className="w-28 shrink-0 truncate text-charcoal/70" title={r.label}>{r.label}</div>
              <div className="flex-1 h-2 rounded-full bg-cream overflow-hidden"><div className="h-full rounded-full bg-copper/60" style={{ width: `${(r.value / max) * 100}%` }} /></div>
              <div className="w-12 shrink-0 text-end tabular-nums text-charcoal font-medium">{r.value.toLocaleString(isAr ? 'ar-SA' : 'en-US')}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CommandCenterSection({ isAr }: { isAr: boolean }) {
  const navigate = useNavigate();
  const { models, records, users, initialized } = useAppStore();
  const translationVersion = useRecordTranslationVersion();

  const allModel = modelByName(models, 'all_projects');
  const ourModel = modelByName(models, 'our_projects');
  const unitsModel = modelByName(models, 'units');
  const clientsModel = modelByName(models, 'clients');
  const districtsModel = modelByName(models, 'districts');
  const unitUpdatesModel = modelByName(models, 'unit_updates');

  // Every model here loads its FULL set into the store at boot (units in the
  // second wave), so once the store is initialized `records[modelId]` is the
  // complete authorized set — not a page. Gate on `initialized`, not on the
  // summary-load flag (which only applies to market_listings).
  const clientsLoaded = initialized;

  // District id → { name, city, region } from the districts records.
  const districtInfo = useMemo(() => {
    const map = new Map<string, { name: string; city: string; region: string }>();
    if (districtsModel) for (const r of records[districtsModel.id] ?? []) {
      const d = (r.data ?? {}) as Record<string, unknown>;
      map.set(r.id, {
        name: String((isAr ? d.name_ar : d.name_en) ?? d.name_ar ?? d.name_en ?? '—'),
        city: String((isAr ? d.city_name_ar : d.city_name_en) ?? d.city_name_ar ?? d.city_name_en ?? ''),
        region: String((isAr ? d.region_name_ar : d.region_name_en) ?? d.region_name_ar ?? d.region_name_en ?? ''),
      });
    }
    return map;
  }, [districtsModel, records, isAr]);

  const data = useMemo(() => {
    const allRecords = allModel ? records[allModel.id] ?? [] : [];
    const ourRecords = ourModel ? records[ourModel.id] ?? [] : [];
    const unitRecords = unitsModel ? records[unitsModel.id] ?? [] : [];
    const clientRecords = clientsModel ? records[clientsModel.id] ?? [] : [];

    const portfolioMasterIds = new Set<string>();
    for (const r of ourRecords) { const id = idArr((r.data as Record<string, unknown> | undefined)?.project)[0]; if (id) portfolioMasterIds.add(id); }
    const portfolioProjects = allRecords.filter((p) => portfolioMasterIds.has(p.id));

    // Supply totals (portfolio masters' available-only rollups).
    let available = 0, reserved = 0, sold = 0, total = 0;
    for (const p of portfolioProjects) { const d = p.data as Record<string, unknown>; available += num(d.available_units); reserved += num(d.reserved_units); sold += num(d.sold_units); total += num(d.unit_count); }
    const underConstruction = Math.max(0, total - available - reserved - sold);

    // Breakdowns by CITY / DISTRICT / OFF-PLAN from project rollups.
    const byCity = new Map<string, number>(), byDistrict = new Map<string, number>(), byOffPlan = new Map<string, number>();
    for (const p of portfolioProjects) {
      const d = p.data as Record<string, unknown>;
      const av = num(d.available_units);
      const dids = projectDistrictIds(p);
      const info = dids.map((id) => districtInfo.get(id)).find(Boolean);
      const city = info?.city || (isAr ? 'غير محدد' : 'Unknown'); byCity.set(city, (byCity.get(city) ?? 0) + av);
      const dName = info?.name || (isAr ? 'غير محدد' : 'Unknown'); byDistrict.set(dName, (byDistrict.get(dName) ?? 0) + av);
      const ready = d.construction_status === 'ready' || d.project_status === 'available';
      const k = ready ? (isAr ? 'جاهز' : 'Ready') : (isAr ? 'على الخارطة' : 'Off-plan'); byOffPlan.set(k, (byOffPlan.get(k) ?? 0) + av);
    }

    // Breakdowns by TYPE / BEDROOM / PRICE from portfolio AVAILABLE units.
    const byType = new Map<string, number>(), byBed = new Map<string, number>(), byPrice = new Map<string, number>();
    for (const u of unitRecords) {
      const d = (u.data ?? {}) as Record<string, unknown>;
      if (d.unit_status !== 'available') continue;
      const pid = idArr(d.project_id)[0];
      if (!pid || !portfolioMasterIds.has(pid)) continue;
      const t = (d.unit_type as string) || (isAr ? 'غير محدد' : 'Unknown'); byType.set(t, (byType.get(t) ?? 0) + 1);
      const b = bedBand(num(d.bedrooms), isAr); byBed.set(b, (byBed.get(b) ?? 0) + 1);
      const pr = num(d.total_price); if (pr > 0) { const band = priceBand(pr, isAr); byPrice.set(band, (byPrice.get(band) ?? 0) + 1); }
    }

    // Demand + opportunity gaps (shared canonical layer).
    const ctx = { models, records, users, language: (isAr ? 'ar' : 'en') as 'ar' | 'en', translate: getEntityFieldText };
    const demand = buildActiveClientDemand(clientRecords, ctx, allRecords);
    const gaps = computeOpportunityGaps(demand, allRecords, portfolioMasterIds).filter((g) => g.demandCount > 0).slice(0, 15);

    // Portfolio warnings — actionable only.
    const warnings: { id: string; name: string; issue: string }[] = [];
    for (const p of portfolioProjects) {
      const d = p.data as Record<string, unknown>;
      const name = String(d.project_name ?? `#${p.id.slice(0, 8)}`);
      const avail = num(d.available_units);
      const priority = d.sales_priority === 'high';
      if (priority && avail === 0) warnings.push({ id: p.id, name, issue: isAr ? 'أولوية عالية بدون وحدات متاحة' : 'High priority, no available units' });
      else if (avail === 0) warnings.push({ id: p.id, name, issue: isAr ? 'لا وحدات متاحة' : 'No available units' });
      if (d.is_public === true && !(d.main_image || (Array.isArray(d.project_images) && d.project_images.length))) warnings.push({ id: p.id, name, issue: isAr ? 'منشور بدون صورة' : 'Public but no image' });
    }

    // Inventory-operations summary — real unit_updates facts only.
    const today = new Date().toISOString().slice(0, 10);
    const uuRecords = unitUpdatesModel ? records[unitUpdatesModel.id] ?? [] : [];
    const configured = new Set<string>();
    let dueToday = 0, overdue = 0, activeConfigs = 0;
    for (const r of uuRecords) {
      const d = (r.data ?? {}) as Record<string, unknown>;
      const pid = idArr(d.project)[0]; if (pid) configured.add(pid);
      if (d.is_active === true) activeConfigs += 1;
      const nd = typeof d.next_due === 'string' ? d.next_due.slice(0, 10) : '';
      if (nd) { if (nd === today) dueToday += 1; else if (nd < today) overdue += 1; }
    }
    const portfolioNoConfig = portfolioProjects.filter((p) => !configured.has(p.id)).length;

    const rowsFrom = (m: Map<string, number>) => [...m.entries()].map(([label, value]) => ({ key: label, label, value }));
    return {
      knownProjects: allRecords.length, portfolioProjects: portfolioProjects.length, linkedMasters: portfolioMasterIds.size,
      available, reserved, sold, underConstruction,
      byCity: rowsFrom(byCity), byDistrict: rowsFrom(byDistrict), byOffPlan: rowsFrom(byOffPlan),
      byType: rowsFrom(byType), byBed: rowsFrom(byBed), byPrice: rowsFrom(byPrice),
      demandCount: demand.length, gaps, warnings: warnings.slice(0, 12),
      invOps: { dueToday, overdue, activeConfigs, portfolioNoConfig },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allModel, ourModel, unitsModel, clientsModel, unitUpdatesModel, models, records, users, isAr, districtInfo, translationVersion]);

  const n = (v: number) => v.toLocaleString(isAr ? 'ar-SA' : 'en-US');

  return (
    <div className="space-y-6">
      {/* Supply overview */}
      <section>
        <h2 className="text-[0.6875rem] font-bold text-charcoal/30 uppercase tracking-widest mb-3">{isAr ? 'نظرة على المعروض' : 'Supply overview'}</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <Kpi icon={<Building2 size={18} />} label={isAr ? 'مشاريع معروفة (السجل)' : 'Known projects (registry)'} value={n(data.knownProjects)} />
          <Kpi icon={<Star size={18} />} tone="#C09B5F" label={isAr ? 'مشاريع المحفظة' : 'Portfolio projects'} value={n(data.portfolioProjects)} hint={isAr ? `${n(data.linkedMasters)} مرتبطة` : `${n(data.linkedMasters)} linked`} />
          <Kpi icon={<CheckCircle2 size={18} />} tone="#10B981" label={isAr ? 'وحدات متاحة' : 'Available units'} value={n(data.available)} />
          <Kpi icon={<Users size={18} />} tone="#B8734F" label={isAr ? 'عملاء نشطون (طلب)' : 'Active clients (demand)'} value={clientsLoaded ? n(data.demandCount) : '…'} />
          <Kpi icon={<Clock size={18} />} tone="#3B82F6" label={isAr ? 'محجوزة' : 'Reserved'} value={n(data.reserved)} />
          <Kpi icon={<BadgeCheck size={18} />} tone="#8B5CF6" label={isAr ? 'مباعة' : 'Sold'} value={n(data.sold)} />
          <Kpi icon={<Hammer size={18} />} tone="#F59E0B" label={isAr ? 'تحت الإنشاء' : 'Under construction'} value={n(data.underConstruction)} />
        </div>
      </section>

      {/* Available inventory breakdowns */}
      <section>
        <h2 className="text-[0.6875rem] font-bold text-charcoal/30 uppercase tracking-widest mb-3">{isAr ? 'المعروض المتاح حسب' : 'Available inventory by'}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          <Breakdown title={isAr ? 'المدينة' : 'City'} rows={data.byCity} isAr={isAr} />
          <Breakdown title={isAr ? 'الحي' : 'District'} rows={data.byDistrict} isAr={isAr} />
          <Breakdown title={isAr ? 'الحالة' : 'Off-plan / Ready'} rows={data.byOffPlan} isAr={isAr} />
          <Breakdown title={isAr ? 'نوع الوحدة' : 'Unit type'} rows={data.byType} isAr={isAr} />
          <Breakdown title={isAr ? 'غرف النوم' : 'Bedrooms'} rows={data.byBed} isAr={isAr} />
          <Breakdown title={isAr ? 'شريحة السعر' : 'Price band'} rows={data.byPrice} isAr={isAr} />
        </div>
      </section>

      {/* Demand vs supply — geography drill */}
      <section>
        <h2 className="text-[0.6875rem] font-bold text-charcoal/30 uppercase tracking-widest mb-3">{isAr ? 'الطلب مقابل المعروض — جغرافياً' : 'Demand vs supply — geography'}</h2>
        <GeographySection isAr={isAr} />
      </section>

      {/* Opportunity gaps */}
      <section>
        <h2 className="text-[0.6875rem] font-bold text-charcoal/30 uppercase tracking-widest mb-3">{isAr ? 'فجوات فرص السوق' : 'Market-opportunity gaps'}</h2>
        {!clientsLoaded ? (
          <div className="card p-6 text-center text-charcoal/40 text-sm">{isAr ? 'جارٍ تحميل بيانات العملاء…' : 'Loading client data…'}</div>
        ) : data.gaps.length === 0 ? (
          <div className="card p-6 text-center text-charcoal/45 text-sm">{isAr ? 'لا توجد فجوات — الطلب النشط مغطّى بالمعروض المتاح.' : 'No gaps — active demand is covered by available supply.'}</div>
        ) : (
          <div className="space-y-2">
            {data.gaps.map((g) => <GapRow key={g.districtId} gap={g} name={districtInfo.get(g.districtId)?.name ?? g.districtId} city={districtInfo.get(g.districtId)?.city ?? ''} isAr={isAr} navigate={navigate} />)}
          </div>
        )}
      </section>

      {/* Inventory operations summary (real unit_updates facts) */}
      <section>
        <h2 className="text-[0.6875rem] font-bold text-charcoal/30 uppercase tracking-widest mb-3">{isAr ? 'ملخص عمليات المخزون' : 'Inventory operations'}</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi icon={<RefreshCw size={18} />} tone="#B8734F" label={isAr ? 'إعدادات نشطة' : 'Active update configs'} value={n(data.invOps.activeConfigs)} />
          <Kpi icon={<Clock size={18} />} tone="#F59E0B" label={isAr ? 'مستحقة اليوم' : 'Due today'} value={n(data.invOps.dueToday)} />
          <Kpi icon={<AlertTriangle size={18} />} tone="#EF4444" label={isAr ? 'متأخرة' : 'Overdue'} value={n(data.invOps.overdue)} />
          <Kpi icon={<Building2 size={18} />} tone="#9CA3AF" label={isAr ? 'محفظة بلا إعداد تحديث' : 'Portfolio w/o config'} value={n(data.invOps.portfolioNoConfig)} />
        </div>
        <button onClick={() => navigate('/projects-inventory/updates')} className="text-xs text-copper hover:underline inline-flex items-center gap-1 mt-2">
          <RefreshCw size={13} /> {isAr ? 'فتح عمليات التحديث' : 'Open Update Operations'}
        </button>
      </section>

      {/* Portfolio warnings */}
      {data.warnings.length > 0 && (
        <section>
          <h2 className="text-[0.6875rem] font-bold text-charcoal/30 uppercase tracking-widest mb-3">{isAr ? 'تنبيهات المحفظة' : 'Portfolio warnings'}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {data.warnings.map((w, i) => (
              <button key={`${w.id}-${i}`} onClick={() => navigate(`/model/all_projects/${w.id}`)} className="card p-3 flex items-center gap-2 text-start hover:border-copper/30">
                <AlertTriangle size={15} className="text-amber-500 shrink-0" />
                <span className="text-sm text-charcoal flex-1 truncate">{w.name}</span>
                <span className="text-[11px] text-charcoal/50 shrink-0">{w.issue}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** One opportunity-gap row — expands to the real clients behind the number. */
function GapRow({ gap, name, city, isAr, navigate }: { gap: OpportunityGap; name: string; city: string; isAr: boolean; navigate: (to: string) => void }) {
  const [open, setOpen] = useState(false);
  const { records, models } = useAppStore();
  const clientsModel = modelByName(models, 'clients');
  const nameOf = (id: string) => {
    const rec = clientsModel ? (records[clientsModel.id] ?? []).find((r) => r.id === id) : null;
    return (rec?.data as Record<string, unknown> | undefined)?.client_name as string | undefined ?? `#${id.slice(0, 8)}`;
  };
  return (
    <div className="card">
      <button onClick={() => setOpen((o) => !o)} className="w-full p-3 flex items-center gap-3 text-start">
        {open ? <ChevronDown size={15} className="text-charcoal/40 shrink-0" /> : <ChevronRight size={15} className="text-charcoal/40 shrink-0 rtl:rotate-180" />}
        <div className="flex-1 min-w-0">
          <div className="font-bold text-charcoal text-sm truncate">{name}{city && <span className="text-charcoal/40 font-normal"> · {city}</span>}</div>
          <div className="text-[11px] text-charcoal/50">
            {isAr ? `${gap.demandCount} طلب · ${gap.availableUnits} متاحة · ${gap.severity} بلا مخزون مناسب` : `${gap.demandCount} demand · ${gap.availableUnits} available · ${gap.severity} unmet`}
          </div>
        </div>
        <span className="text-xs px-2 py-0.5 rounded-full font-bold shrink-0" style={{ backgroundColor: gap.severity > 0 ? '#EF444416' : '#10B98116', color: gap.severity > 0 ? '#EF4444' : '#10B981' }}>{gap.severity}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 border-t border-sand/30 pt-2">
          <div className="flex flex-wrap gap-1.5 mb-2">
            {gap.demandClientIds.slice(0, 40).map((id) => (
              <button key={id} onClick={() => navigate(`/model/clients/${id}`)} className="text-[11px] px-1.5 py-0.5 rounded bg-cream border border-sand/50 text-charcoal/70 hover:text-copper hover:border-copper/40">
                {nameOf(id)}
              </button>
            ))}
          </div>
          <button onClick={() => navigate('/projects-inventory/registry')} className="text-xs text-copper hover:underline inline-flex items-center gap-1">
            <Compass size={13} /> {isAr ? 'ابحث في سجل السوق' : 'Search the Market Registry'}
          </button>
        </div>
      )}
    </div>
  );
}
