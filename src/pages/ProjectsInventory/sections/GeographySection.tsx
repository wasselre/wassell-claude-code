/**
 * Demand-vs-supply geography (Phase 4, layer B).
 *
 * The MAP is the default view: every relevant district (has demand or supply)
 * is a pin, keyed by its record id, coloured by the shared canonical
 * demand-vs-supply severity. Region / City are FILTERS (not a card drill) that
 * narrow which districts show and refit the map. Selecting a district reveals
 * its projects → open project + units. Every aggregate is a sum of real
 * records; demand uses the one canonical active-client layer.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, ArrowRight } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { modelByName, asFiniteNumber } from '@/lib/projects/projectView';
import { getEntityFieldText, useRecordTranslationVersion } from '@/lib/recordTranslation/store';
import {
  buildActiveClientDemand, aggregateDemandByDistrict, buildDistrictSupply,
  computeOpportunityGaps, projectDistrictIds,
} from '@/lib/demand/demandAggregation';
import DemandSupplyMap, { type DistrictMetric, type DistrictPin } from './DemandSupplyMap';

const num = (v: unknown) => asFiniteNumber(v);
const idArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' && v ? [v] : []);

interface DistrictNode { id: string; name: string; cityLookup: string; cityName: string; regionLookup: string; regionName: string; lat: number | null; lng: number | null; metric: DistrictMetric }

export default function GeographySection({ isAr }: { isAr: boolean }) {
  const navigate = useNavigate();
  const { models, records, users, initialized } = useAppStore();
  const translationVersion = useRecordTranslationVersion();
  const allModel = modelByName(models, 'all_projects');
  const ourModel = modelByName(models, 'our_projects');
  const clientsModel = modelByName(models, 'clients');
  const districtsModel = modelByName(models, 'districts');

  const [selRegion, setSelRegion] = useState('');
  const [selCity, setSelCity] = useState('');
  const [selDistrict, setSelDistrict] = useState<string | null>(null);

  const data = useMemo(() => {
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

    const nodes: DistrictNode[] = [];
    for (const r of districtRecords) {
      const dd = demandByDistrict.get(r.id), s = supply.get(r.id);
      if (!dd && !s) continue; // relevant only
      const d = (r.data ?? {}) as Record<string, unknown>;
      nodes.push({
        id: r.id,
        name: String((isAr ? d.name_ar : d.name_en) ?? d.name_ar ?? d.name_en ?? '—'),
        cityLookup: String(d.city_lookup ?? ''), cityName: String((isAr ? d.city_name_ar : d.city_name_en) ?? d.city_name_ar ?? d.city_name_en ?? (isAr ? 'غير محدد' : 'Unknown')),
        regionLookup: String(d.region_lookup ?? ''), regionName: String((isAr ? d.region_name_ar : d.region_name_en) ?? d.region_name_ar ?? d.region_name_en ?? (isAr ? 'غير محدد' : 'Unknown')),
        lat: num(d.center_lat) ?? num(d.centroid_lat), lng: num(d.center_lng) ?? num(d.centroid_lng),
        metric: { demand: dd?.count ?? 0, available: s?.availableUnits ?? 0, severity: gaps.get(r.id) ?? 0 },
      });
    }
    return { nodes, allRecords, districtCount: districtRecords.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allModel, ourModel, clientsModel, districtsModel, models, records, users, isAr, translationVersion]);

  // Region / city filter option lists.
  const regionOpts = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of data.nodes) if (n.regionLookup) m.set(n.regionLookup, n.regionName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);
  const cityOpts = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of data.nodes) if (n.cityLookup && (!selRegion || n.regionLookup === selRegion)) m.set(n.cityLookup, n.cityName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data, selRegion]);

  const filtered = useMemo(
    () => data.nodes.filter((n) => (!selRegion || n.regionLookup === selRegion) && (!selCity || n.cityLookup === selCity)),
    [data, selRegion, selCity],
  );
  const pins: DistrictPin[] = useMemo(
    () => filtered.filter((n) => n.lat != null && n.lng != null).map((n) => ({ id: n.id, label: n.name, lat: n.lat!, lng: n.lng!, metric: n.metric })),
    [filtered],
  );

  const selNode = selDistrict ? data.nodes.find((n) => n.id === selDistrict) ?? null : null;
  const districtProjects = useMemo(() => {
    if (!selDistrict) return [];
    return data.allRecords.filter((p) => projectDistrictIds(p).includes(selDistrict));
  }, [selDistrict, data]);

  if (!initialized) return <div className="card p-8 text-center text-charcoal/40 text-sm">{isAr ? 'جارٍ تحميل بيانات الجغرافيا والطلب…' : 'Loading geography + demand data…'}</div>;
  if (data.districtCount === 0) return <div className="card p-8 text-center text-charcoal/45 text-sm">{isAr ? 'لا تتوفر بيانات الأحياء.' : 'District data is not available.'}</div>;

  const nFmt = (v: number) => v.toLocaleString(isAr ? 'ar-SA' : 'en-US');
  const sel = 'form-input text-sm py-1.5';

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <select className={sel} value={selRegion} onChange={(e) => { setSelRegion(e.target.value); setSelCity(''); setSelDistrict(null); }}>
          <option value="">{isAr ? 'كل المناطق' : 'All regions'}</option>
          {regionOpts.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select className={sel} value={selCity} onChange={(e) => { setSelCity(e.target.value); setSelDistrict(null); }}>
          <option value="">{isAr ? 'كل المدن' : 'All cities'}</option>
          {cityOpts.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <span className="text-xs text-charcoal/45">{isAr ? `${nFmt(filtered.length)} حي بطلب أو معروض` : `${nFmt(filtered.length)} districts with demand/supply`}</span>
      </div>

      {/* Map (default view) */}
      <DemandSupplyMap pins={pins} selectedId={selDistrict} onDistrictClick={setSelDistrict} isAr={isAr} language={isAr ? 'ar' : 'en'} />

      {/* Selected district → its projects */}
      {selNode && (
        <div className="space-y-2">
          <div className="text-[0.6875rem] font-bold text-charcoal/40 uppercase tracking-widest">
            {selNode.name}{selNode.cityName && <span className="text-charcoal/30"> · {selNode.cityName}</span>} — {isAr ? 'المشاريع' : 'Projects'} ({districtProjects.length}) · {isAr ? `${nFmt(selNode.metric.demand)} طلب · ${nFmt(selNode.metric.available)} متاحة` : `${nFmt(selNode.metric.demand)} demand · ${nFmt(selNode.metric.available)} available`}
          </div>
          {districtProjects.length === 0 ? (
            <div className="card p-6 text-center text-charcoal/45 text-sm">{isAr ? 'لا مشاريع معروفة في هذا الحي.' : 'No known projects in this district.'}</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
              {districtProjects.map((p) => {
                const d = (p.data ?? {}) as Record<string, unknown>;
                return (
                  <button key={p.id} onClick={() => navigate(`/model/all_projects/${p.id}`)} className="card p-3 text-start hover:border-copper/30 transition-all">
                    <div className="font-bold text-charcoal text-sm truncate inline-flex items-center gap-1"><MapPin size={12} /> {String(d.project_name ?? `#${p.id.slice(0, 8)}`)}</div>
                    <div className="text-[11px] text-charcoal/55 mt-1">{isAr ? 'متاحة: ' : 'Available: '}{nFmt(num(d.available_units) ?? 0)} · {isAr ? 'الوحدات' : 'units'} {nFmt(num(d.unit_count) ?? 0)}</div>
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
