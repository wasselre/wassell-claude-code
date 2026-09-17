/**
 * Demand-vs-supply geography drill (Phase 4, layer B).
 *
 * Navigation hierarchy: Region → City → District → Project → Units. Region and
 * City are aggregate cards + navigation (built from the districts' denormalized
 * parents); the MAP shows the selected city's real district polygons shaded by
 * the shared canonical demand-vs-supply severity. District → its projects →
 * (project opens its detail, where Units live). Every aggregate is a sum of
 * real records; demand uses the one canonical active-client layer.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, MapPin, Building2, Users, ArrowRight } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { modelByName, asFiniteNumber } from '@/lib/projects/projectView';
import { getEntityFieldText, useRecordTranslationVersion } from '@/lib/recordTranslation/store';
import {
  buildActiveClientDemand, aggregateDemandByDistrict, buildDistrictSupply,
  computeOpportunityGaps, projectDistrictIds,
} from '@/lib/demand/demandAggregation';
import DemandSupplyMap, { normName, type DistrictMetric } from './DemandSupplyMap';

const num = (v: unknown) => asFiniteNumber(v) ?? 0;
const idArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' && v ? [v] : []);

interface DistrictNode { id: string; nameAr: string; nameEn: string; cityLookup: string; cityName: string; regionLookup: string; regionName: string }

export default function GeographySection({ isAr }: { isAr: boolean }) {
  const navigate = useNavigate();
  const { models, records, users, initialized } = useAppStore();
  const translationVersion = useRecordTranslationVersion();
  const allModel = modelByName(models, 'all_projects');
  const ourModel = modelByName(models, 'our_projects');
  const clientsModel = modelByName(models, 'clients');
  const districtsModel = modelByName(models, 'districts');

  const [selRegion, setSelRegion] = useState<string | null>(null);
  const [selCity, setSelCity] = useState<string | null>(null);
  const [selDistrict, setSelDistrict] = useState<string | null>(null);

  // District tree (record-id keyed) + per-district demand/supply metric.
  const model = useMemo(() => {
    const allRecords = allModel ? records[allModel.id] ?? [] : [];
    const ourRecords = ourModel ? records[ourModel.id] ?? [] : [];
    const clientRecords = clientsModel ? records[clientsModel.id] ?? [] : [];
    const districtRecords = districtsModel ? records[districtsModel.id] ?? [] : [];

    const portfolioMasterIds = new Set<string>();
    for (const r of ourRecords) { const id = idArr((r.data as Record<string, unknown> | undefined)?.project)[0]; if (id) portfolioMasterIds.add(id); }

    const ctx = { models, records, users, language: (isAr ? 'ar' : 'en') as 'ar' | 'en', translate: getEntityFieldText };
    const demand = buildActiveClientDemand(clientRecords, ctx, allRecords);
    const demandByDistrict = aggregateDemandByDistrict(demand);
    const supply = buildDistrictSupply(allRecords, portfolioMasterIds);
    const gaps = new Map(computeOpportunityGaps(demand, allRecords, portfolioMasterIds).map((g) => [g.districtId, g.severity]));

    const metric = new Map<string, DistrictMetric>();
    const nodes: DistrictNode[] = [];
    for (const r of districtRecords) {
      const d = (r.data ?? {}) as Record<string, unknown>;
      nodes.push({
        id: r.id,
        nameAr: String(d.name_ar ?? d.name_en ?? '—'), nameEn: String(d.name_en ?? d.name_ar ?? '—'),
        cityLookup: String(d.city_lookup ?? ''), cityName: String((isAr ? d.city_name_ar : d.city_name_en) ?? d.city_name_ar ?? d.city_name_en ?? ''),
        regionLookup: String(d.region_lookup ?? ''), regionName: String((isAr ? d.region_name_ar : d.region_name_en) ?? d.region_name_ar ?? d.region_name_en ?? ''),
      });
      const dd = demandByDistrict.get(r.id), s = supply.get(r.id);
      if (dd || s) metric.set(r.id, { demand: dd?.count ?? 0, available: s?.availableUnits ?? 0, severity: gaps.get(r.id) ?? 0 });
    }

    // Only surface districts that have demand or supply (the rest are noise).
    const relevant = nodes.filter((n) => metric.has(n.id));
    return { nodes, relevant, metric, demandByDistrict, supply, allRecords, districtRecords };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allModel, ourModel, clientsModel, districtsModel, models, records, users, isAr, translationVersion]);

  // Region / city aggregates from the relevant districts.
  const regions = useMemo(() => {
    const m = new Map<string, { id: string; name: string; demand: number; available: number; districts: number }>();
    for (const n of model.relevant) {
      const met = model.metric.get(n.id)!;
      const r = m.get(n.regionLookup) ?? { id: n.regionLookup, name: n.regionName, demand: 0, available: 0, districts: 0 };
      r.demand += met.demand; r.available += met.available; r.districts += 1; m.set(n.regionLookup, r);
    }
    return [...m.values()].sort((a, b) => b.demand - a.demand);
  }, [model]);

  const cities = useMemo(() => {
    const m = new Map<string, { id: string; name: string; demand: number; available: number; districts: number }>();
    for (const n of model.relevant) {
      if (selRegion && n.regionLookup !== selRegion) continue;
      const met = model.metric.get(n.id)!;
      const c = m.get(n.cityLookup) ?? { id: n.cityLookup, name: n.cityName, demand: 0, available: 0, districts: 0 };
      c.demand += met.demand; c.available += met.available; c.districts += 1; m.set(n.cityLookup, c);
    }
    return [...m.values()].sort((a, b) => b.demand - a.demand);
  }, [model, selRegion]);

  const cityDistricts = useMemo(() => model.relevant.filter((n) => n.cityLookup === selCity), [model, selCity]);
  const metricByName = useMemo(() => {
    const m = new Map<string, DistrictMetric>();
    for (const n of cityDistricts) { const met = model.metric.get(n.id)!; m.set(normName(n.nameAr), met); m.set(normName(n.nameEn), met); }
    return m;
  }, [cityDistricts, model]);

  const selDistrictNode = model.relevant.find((n) => n.id === selDistrict) ?? null;
  const districtProjects = useMemo(() => {
    if (!selDistrict) return [];
    return model.allRecords.filter((p) => projectDistrictIds(p).includes(selDistrict));
  }, [selDistrict, model]);

  if (!initialized) {
    return <div className="card p-8 text-center text-charcoal/40 text-sm">{isAr ? 'جارٍ تحميل بيانات الجغرافيا والطلب…' : 'Loading geography + demand data…'}</div>;
  }
  if (model.districtRecords.length === 0) {
    return <div className="card p-8 text-center text-charcoal/45 text-sm">{isAr ? 'لا تتوفر بيانات الأحياء.' : 'District data is not available.'}</div>;
  }

  const Crumb = ({ label, onClick, active }: { label: string; onClick?: () => void; active?: boolean }) => (
    <button onClick={onClick} disabled={!onClick} className={`inline-flex items-center gap-1 ${active ? 'text-copper font-bold' : 'text-charcoal/50 hover:text-charcoal'} disabled:hover:text-charcoal/50`}>
      {label}
    </button>
  );
  const Card = ({ name, demand, available, districts, onClick }: { name: string; demand: number; available: number; districts?: number; onClick: () => void }) => (
    <button onClick={onClick} className="card p-3 text-start hover:border-copper/30 transition-all">
      <div className="font-bold text-charcoal text-sm truncate">{name || (isAr ? 'غير محدد' : 'Unknown')}</div>
      <div className="text-[11px] text-charcoal/55 mt-1 flex flex-wrap gap-x-3">
        <span className="inline-flex items-center gap-1"><Users size={11} /> {demand.toLocaleString(isAr ? 'ar-SA' : 'en-US')} {isAr ? 'طلب' : 'demand'}</span>
        <span className="inline-flex items-center gap-1"><Building2 size={11} /> {available.toLocaleString(isAr ? 'ar-SA' : 'en-US')} {isAr ? 'متاحة' : 'available'}</span>
        {districts != null && <span className="text-charcoal/40">{districts} {isAr ? 'حي' : 'districts'}</span>}
      </div>
    </button>
  );

  return (
    <div className="space-y-3">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1 text-sm flex-wrap">
        <Crumb label={isAr ? 'كل المناطق' : 'All regions'} onClick={selRegion ? () => { setSelRegion(null); setSelCity(null); setSelDistrict(null); } : undefined} active={!selRegion} />
        {selRegion && <><ChevronRight size={13} className="text-charcoal/30 rtl:rotate-180" /><Crumb label={regions.find((r) => r.id === selRegion)?.name || '—'} onClick={selCity ? () => { setSelCity(null); setSelDistrict(null); } : undefined} active={!selCity} /></>}
        {selCity && <><ChevronRight size={13} className="text-charcoal/30 rtl:rotate-180" /><Crumb label={cities.find((c) => c.id === selCity)?.name || '—'} onClick={selDistrict ? () => setSelDistrict(null) : undefined} active={!selDistrict} /></>}
        {selDistrictNode && <><ChevronRight size={13} className="text-charcoal/30 rtl:rotate-180" /><Crumb label={isAr ? selDistrictNode.nameAr : selDistrictNode.nameEn} active /></>}
      </div>

      {/* Level content */}
      {!selRegion && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
          {regions.map((r) => <Card key={r.id} name={r.name} demand={r.demand} available={r.available} districts={r.districts} onClick={() => setSelRegion(r.id)} />)}
        </div>
      )}
      {selRegion && !selCity && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
          {cities.map((c) => <Card key={c.id} name={c.name} demand={c.demand} available={c.available} districts={c.districts} onClick={() => setSelCity(c.id)} />)}
        </div>
      )}
      {selCity && !selDistrict && (
        <div className="grid md:grid-cols-[2fr_1fr] gap-3">
          <DemandSupplyMap
            cityId={selCity} metricByName={metricByName} selectedName={null}
            onDistrictClick={(nm) => { const hit = cityDistricts.find((n) => normName(n.nameAr) === nm || normName(n.nameEn) === nm); if (hit) setSelDistrict(hit.id); }}
            isAr={isAr} language={isAr ? 'ar' : 'en'}
          />
          <div className="space-y-2 max-h-[26rem] overflow-y-auto">
            {cityDistricts.sort((a, b) => (model.metric.get(b.id)!.severity - model.metric.get(a.id)!.severity)).map((n) => {
              const met = model.metric.get(n.id)!;
              return <Card key={n.id} name={isAr ? n.nameAr : n.nameEn} demand={met.demand} available={met.available} onClick={() => setSelDistrict(n.id)} />;
            })}
          </div>
        </div>
      )}
      {selDistrict && (
        <div className="space-y-2">
          <div className="text-[0.6875rem] font-bold text-charcoal/40 uppercase tracking-widest">{isAr ? 'مشاريع في هذا الحي' : 'Projects in this district'} ({districtProjects.length})</div>
          {districtProjects.length === 0 ? (
            <div className="card p-6 text-center text-charcoal/45 text-sm">{isAr ? 'لا مشاريع معروفة في هذا الحي.' : 'No known projects in this district.'}</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              {districtProjects.map((p) => {
                const d = (p.data ?? {}) as Record<string, unknown>;
                return (
                  <button key={p.id} onClick={() => navigate(`/model/all_projects/${p.id}`)} className="card p-3 text-start hover:border-copper/30 transition-all">
                    <div className="font-bold text-charcoal text-sm truncate inline-flex items-center gap-1"><MapPin size={12} /> {String(d.project_name ?? `#${p.id.slice(0, 8)}`)}</div>
                    <div className="text-[11px] text-charcoal/55 mt-1">{isAr ? 'متاحة: ' : 'Available: '}{num(d.available_units).toLocaleString(isAr ? 'ar-SA' : 'en-US')} · {isAr ? 'الوحدات' : 'units'} {num(d.unit_count).toLocaleString(isAr ? 'ar-SA' : 'en-US')}</div>
                    <div className="text-[11px] text-copper mt-1 inline-flex items-center gap-1">{isAr ? 'فتح المشروع والوحدات' : 'Open project + units'} <ArrowRight size={11} className="rtl:rotate-180" /></div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
