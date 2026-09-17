/**
 * Command Center — demand-vs-supply operating page.
 *
 * PHASE 2 SCOPE: only the truthful SUPPLY summary computed from the stored
 * project rollups (no fake data, no placeholder charts — governing rule #11).
 * The demand-vs-supply geography, opportunity gaps, inventory-ops summary, and
 * portfolio warnings are built in Phase 4 against the audited real client
 * fields + the repaired demand benchmark; until then they show honest
 * "coming" states rather than invented numbers.
 *
 * Every number here is a sum of stored rollup fields on real records, so it is
 * traceable to the underlying projects. "Available inventory value" is
 * deliberately OMITTED in this phase — it cannot be computed correctly from the
 * range-shaped rollups (a price RANGE is not a sum), and the spec forbids a
 * misleading total. It returns in Phase 4 from real per-unit available prices.
 */
import { useMemo } from 'react';
import { Building2, Star, CheckCircle2, Clock, BadgeCheck, Hammer } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { modelByName, asFiniteNumber } from '@/lib/projects/projectView';

function Kpi({ icon, label, value, tone, hint }: { icon: React.ReactNode; label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="card p-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: (tone ?? '#B8734F') + '1A', color: tone ?? '#B8734F' }}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xl font-bold text-charcoal leading-none">{value}</div>
        <div className="text-xs text-charcoal/50 mt-1 truncate">{label}</div>
        {hint && <div className="text-[10px] text-charcoal/35 mt-0.5 truncate">{hint}</div>}
      </div>
    </div>
  );
}

export default function CommandCenterSection({ isAr }: { isAr: boolean }) {
  const { models, records } = useAppStore();

  const supply = useMemo(() => {
    const allModel = modelByName(models, 'all_projects');
    const ourModel = modelByName(models, 'our_projects');
    const allRecords = allModel ? records[allModel.id] ?? [] : [];
    const ourRecords = ourModel ? records[ourModel.id] ?? [] : [];

    // Which all_projects masters are in our Portfolio (linked by an
    // our_projects record). Portfolio unit totals are summed from those
    // MASTERS' stored rollups — the same authoritative source the Portfolio
    // page reads (the slim our_projects summary doesn't carry the rollups).
    const portfolioMasterIds = new Set<string>();
    for (const r of ourRecords) {
      const raw = (r.data as Record<string, unknown> | undefined)?.project;
      const id = Array.isArray(raw) ? raw[0] : raw;
      if (typeof id === 'string') portfolioMasterIds.add(id);
    }

    let available = 0, reserved = 0, sold = 0, total = 0;
    for (const r of allRecords) {
      if (!portfolioMasterIds.has(r.id)) continue;
      const d = (r.data ?? {}) as Record<string, unknown>;
      available += asFiniteNumber(d.available_units) ?? 0;
      reserved += asFiniteNumber(d.reserved_units) ?? 0;
      sold += asFiniteNumber(d.sold_units) ?? 0;
      total += asFiniteNumber(d.unit_count) ?? 0;
    }
    // Under-construction = everything that isn't available/reserved/sold.
    const underConstruction = Math.max(0, total - available - reserved - sold);

    return {
      knownProjects: allRecords.length,
      portfolioProjects: ourRecords.length,
      linkedMasters: portfolioMasterIds.size,
      available,
      reserved,
      sold,
      underConstruction,
    };
  }, [models, records]);

  const n = (v: number) => v.toLocaleString(isAr ? 'ar-SA' : 'en-US');

  return (
    <div className="space-y-6">
      {/* Supply overview — real, traceable totals. */}
      <section>
        <h2 className="text-[0.6875rem] font-bold text-charcoal/30 uppercase tracking-widest mb-3">
          {isAr ? 'نظرة على المعروض' : 'Supply overview'}
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <Kpi icon={<Building2 size={18} />} label={isAr ? 'مشاريع معروفة (السجل)' : 'Known projects (registry)'} value={n(supply.knownProjects)} />
          <Kpi icon={<Star size={18} />} tone="#C09B5F" label={isAr ? 'مشاريع المحفظة' : 'Portfolio projects'} value={n(supply.portfolioProjects)} hint={isAr ? `${n(supply.linkedMasters)} مرتبطة بمشروع` : `${n(supply.linkedMasters)} linked`} />
          <Kpi icon={<CheckCircle2 size={18} />} tone="#10B981" label={isAr ? 'وحدات متاحة (المحفظة)' : 'Available units (portfolio)'} value={n(supply.available)} />
          <Kpi icon={<Clock size={18} />} tone="#3B82F6" label={isAr ? 'وحدات محجوزة' : 'Reserved units'} value={n(supply.reserved)} />
          <Kpi icon={<BadgeCheck size={18} />} tone="#8B5CF6" label={isAr ? 'وحدات مباعة' : 'Sold units'} value={n(supply.sold)} />
          <Kpi icon={<Hammer size={18} />} tone="#F59E0B" label={isAr ? 'تحت الإنشاء' : 'Under construction'} value={n(supply.underConstruction)} />
        </div>
        <p className="text-[11px] text-charcoal/40 mt-2">
          {isAr
            ? 'أرقام المخزون مجاميع من التجميعات المخزَّنة على المشاريع — قابلة للتتبّع لكل مشروع.'
            : 'Inventory numbers are sums of the stored per-project rollups — each traceable to its projects.'}
        </p>
      </section>

      {/* Phase-4 surfaces — honest placeholders, NOT fake charts. */}
      <section className="grid md:grid-cols-2 gap-3">
        {[
          { ar: 'الطلب مقابل المعروض جغرافياً', en: 'Demand vs supply (geography)' },
          { ar: 'فجوات فرص السوق', en: 'Market-opportunity gaps' },
          { ar: 'ملخص عمليات المخزون', en: 'Inventory operations summary' },
          { ar: 'تنبيهات المحفظة', en: 'Portfolio warnings' },
        ].map((c) => (
          <div key={c.en} className="card p-5 text-sm text-charcoal/45">
            <div className="font-bold text-charcoal/70 mb-1">{isAr ? c.ar : c.en}</div>
            {isAr
              ? 'يُبنى في مرحلة لاحقة من بيانات تفضيلات العملاء الحقيقية ومعيار الطلب بعد إصلاحه — لا تُعرض أرقام مُختلَقة قبل ذلك.'
              : 'Built in a later phase from the real customer-preference data + the repaired demand benchmark — no invented numbers shown before then.'}
          </div>
        ))}
      </section>
    </div>
  );
}
