/**
 * Demand-vs-supply geography (Command Center) — a TRUE drill-down choropleth.
 *
 * Country → Region → City → District, each level drawn as FILLED admin polygons
 * (from public.geo_boundaries) coloured by demand-vs-supply. Click a region to
 * fly into its cities, a city into its districts, a district to zoom in and see
 * its projects. A breadcrumb walks back up. This replaces the centroid-pin map:
 * pins never lined up with a real area and could not be drilled.
 *
 * The metric is the ONE canonical active-client demand layer
 * (buildActiveClientDemand → Sales isActive). District demand joins the district
 * polygons EXACTLY via the district record id; city + region colours are the
 * additive rollup of their districts (rollupMetrics).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MapPin, ArrowRight, ChevronLeft } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { modelByName, asFiniteNumber } from '@/lib/projects/projectView';
import { getEntityFieldText, useRecordTranslationVersion } from '@/lib/recordTranslation/store';
import {
  buildActiveClientDemand, aggregateDemandByDistrict, buildDistrictSupply,
  computeOpportunityGaps, projectDistrictIds,
} from '@/lib/demand/demandAggregation';
import {
  fetchGeoTree, fetchGeoShapes, rollupMetrics, geometryBounds,
  type GeoNode, type GeoShape, type GeoTier, type DistrictMetric,
} from '@/lib/geo/choropleth';
import GeoChoroplethMap from './GeoChoroplethMap';

const num = (v: unknown) => asFiniteNumber(v);
const idArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' && v ? [v] : []);

const EMPTY_METRIC: DistrictMetric = { demand: 0, available: 0, severity: 0 };
const NO_DATA = '#E5E7EB';
const NO_DEMAND = '#9CA3AF';

/** Colour by the FRACTION of demand left unmet — scale-free, so it reads the
 *  same whether the polygon is one district or a whole region. */
function severityColor(m: DistrictMetric): string {
  if (m.demand === 0) return m.available > 0 ? NO_DEMAND : NO_DATA;
  const ratio = Math.max(0, Math.min(1, m.severity / m.demand));
  if (ratio <= 0) return '#10B981';
  if (ratio <= 0.2) return '#84CC16';
  if (ratio <= 0.5) return '#F59E0B';
  if (ratio <= 0.8) return '#EF4444';
  return '#B91C1C';
}

interface Crumb { ext: string; name: string }

export default function GeographySection({ isAr }: { isAr: boolean }) {
  const navigate = useNavigate();
  const { models, records, users, initialized } = useAppStore();
  const translationVersion = useRecordTranslationVersion();
  const allModel = modelByName(models, 'all_projects');
  const ourModel = modelByName(models, 'our_projects');
  const clientsModel = modelByName(models, 'clients');

  const [country, setCountry] = useState<'SA' | 'AE'>('SA');
  const [tree, setTree] = useState<GeoNode[]>([]);
  const [level, setLevel] = useState<GeoTier>('region');
  const [shapes, setShapes] = useState<GeoShape[]>([]);
  const [region, setRegion] = useState<Crumb | null>(null);
  const [city, setCity] = useState<Crumb | null>(null);
  const [selDistrict, setSelDistrict] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ south: number; west: number; north: number; east: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef(0);

  // ── Metric: the one canonical active-client demand layer, per district id ────
  const districtMetric = useMemo(() => {
    const allRecords = allModel ? records[allModel.id] ?? [] : [];
    const ourRecords = ourModel ? records[ourModel.id] ?? [] : [];
    const clientRecords = clientsModel ? records[clientsModel.id] ?? [] : [];
    const portfolioMasterIds = new Set<string>();
    for (const r of ourRecords) { const id = idArr((r.data as Record<string, unknown> | undefined)?.project)[0]; if (id) portfolioMasterIds.add(id); }

    const ctx = { models, records, users, language: (isAr ? 'ar' : 'en') as 'ar' | 'en', translate: getEntityFieldText };
    const demand = buildActiveClientDemand(clientRecords, ctx, allRecords);
    const demandByDistrict = aggregateDemandByDistrict(demand);
    const supply = buildDistrictSupply(allRecords, portfolioMasterIds);
    const gaps = new Map(computeOpportunityGaps(demand, allRecords, portfolioMasterIds).map((g) => [g.districtId, g.severity]));

    const map = new Map<string, DistrictMetric>();
    const ids = new Set<string>([...demandByDistrict.keys(), ...supply.keys()]);
    for (const id of ids) {
      map.set(id, {
        demand: demandByDistrict.get(id)?.count ?? 0,
        available: supply.get(id)?.availableUnits ?? 0,
        severity: gaps.get(id) ?? 0,
      });
    }
    return { map, allRecords };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allModel, ourModel, clientsModel, models, records, users, isAr, translationVersion]);

  // ── Roll district demand up to city + region via the hierarchy tree ─────────
  const rollup = useMemo(() => rollupMetrics(tree, districtMetric.map), [tree, districtMetric.map]);

  const metricForShape = (s: GeoShape): DistrictMetric => {
    if (level === 'district') return districtMetric.map.get(s.record_id ?? '') ?? EMPTY_METRIC;
    if (level === 'city') return rollup.city.get(s.external_id) ?? EMPTY_METRIC;
    return rollup.region.get(s.external_id) ?? EMPTY_METRIC;
  };
  const keyOf = (s: GeoShape): string => (level === 'district' ? (s.record_id ?? s.external_id) : s.external_id);
  const labelOf = (s: GeoShape): string => String((isAr ? s.name_ar : s.name_en) || s.name_ar || s.name_en || '—');

  // ── Load the hierarchy tree once per country ────────────────────────────────
  useEffect(() => {
    let alive = true;
    fetchGeoTree(country).then((t) => { if (alive) setTree(t); }).catch((e) => { if (alive) setError(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, [country]);

  // ── Load a tier slice (regions / a region's cities / a city's districts) ────
  const loadSlice = (tier: GeoTier, parentExt: string | null) => {
    const id = ++reqRef.current;
    setLoading(true); setError(null);
    fetchGeoShapes(tier, parentExt, country)
      .then((s) => { if (id !== reqRef.current) return; setShapes(s); setLevel(tier); setLoading(false); })
      .catch((e) => { if (id !== reqRef.current) return; setError(String(e?.message ?? e)); setLoading(false); });
  };

  // Initial regions + reset when the country changes.
  useEffect(() => {
    setRegion(null); setCity(null); setSelDistrict(null); setFocus(null);
    loadSlice('region', null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country]);

  const onFeatureClick = (s: GeoShape) => {
    if (level === 'region') {
      setRegion({ ext: s.external_id, name: labelOf(s) }); setCity(null); setSelDistrict(null); setFocus(null);
      loadSlice('city', s.external_id);
    } else if (level === 'city') {
      setCity({ ext: s.external_id, name: labelOf(s) }); setSelDistrict(null); setFocus(null);
      loadSlice('district', s.external_id);
    } else {
      setSelDistrict(s.record_id ?? null);
      setFocus(geometryBounds(s.geojson));
    }
  };

  // Breadcrumb navigation (walk back up).
  const goRegions = () => { setRegion(null); setCity(null); setSelDistrict(null); setFocus(null); loadSlice('region', null); };
  const goCities = () => { if (!region) return; setCity(null); setSelDistrict(null); setFocus(null); loadSlice('city', region.ext); };

  const selNode = selDistrict ? shapes.find((s) => s.record_id === selDistrict) ?? null : null;
  const districtProjects = useMemo(
    () => (selDistrict ? districtMetric.allRecords.filter((p) => projectDistrictIds(p).includes(selDistrict)) : []),
    [selDistrict, districtMetric.allRecords],
  );

  if (!initialized) return <div className="card p-8 text-center text-charcoal/40 text-sm">{isAr ? 'جارٍ تحميل بيانات الجغرافيا والطلب…' : 'Loading geography + demand data…'}</div>;

  const nFmt = (v: number) => v.toLocaleString(isAr ? 'ar-SA' : 'en-US');
  const crumbBtn = 'inline-flex items-center gap-1 text-charcoal/60 hover:text-copper transition-colors';
  const countryBtn = (c: 'SA' | 'AE', label: string) =>
    <button onClick={() => setCountry(c)} className={`px-2.5 py-1 rounded-md text-xs font-bold transition-colors ${country === c ? 'bg-copper text-white' : 'bg-cream text-charcoal/60 hover:text-charcoal'}`}>{label}</button>;

  return (
    <div className="space-y-3">
      {/* Breadcrumb + country switch */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button onClick={goRegions} className={level === 'region' ? 'font-bold text-charcoal' : crumbBtn}>{isAr ? (country === 'SA' ? 'المملكة' : 'الإمارات') : (country === 'SA' ? 'Saudi Arabia' : 'UAE')}</button>
        {region && <><ChevronLeft size={13} className="text-charcoal/30 rtl:rotate-180" /><button onClick={goCities} className={level === 'city' ? 'font-bold text-charcoal' : crumbBtn}>{region.name}</button></>}
        {city && <><ChevronLeft size={13} className="text-charcoal/30 rtl:rotate-180" /><span className="font-bold text-charcoal">{city.name}</span></>}
        {loading && <span className="text-xs text-charcoal/40">· {isAr ? 'جارٍ التحميل…' : 'loading…'}</span>}
        <span className="ms-auto inline-flex items-center gap-1">{countryBtn('SA', isAr ? 'السعودية' : 'SA')}{countryBtn('AE', isAr ? 'الإمارات' : 'AE')}</span>
      </div>

      {error && <div className="card p-3 text-xs text-red-700 bg-red-50 border-red-200">{isAr ? 'تعذّر تحميل الحدود الجغرافية: ' : 'Could not load geography: '}{error}</div>}

      {/* Map */}
      <GeoChoroplethMap
        shapes={shapes} level={level}
        keyOf={keyOf} colorOf={(s) => severityColor(metricForShape(s))} metricOf={metricForShape} labelOf={labelOf}
        selectedKey={level === 'district' ? selDistrict : null}
        onFeatureClick={onFeatureClick}
        focusBounds={focus}
        isAr={isAr} language={isAr ? 'ar' : 'en'}
      />

      {/* Selected district → its projects */}
      {selNode && (
        <div className="space-y-2">
          <div className="text-[0.6875rem] font-bold text-charcoal/40 uppercase tracking-widest">
            {labelOf(selNode)} — {isAr ? 'المشاريع' : 'Projects'} ({districtProjects.length})
            {(() => { const m = districtMetric.map.get(selDistrict ?? '') ?? EMPTY_METRIC; return <span className="text-charcoal/30"> · {isAr ? `${nFmt(m.demand)} طلب · ${nFmt(m.available)} متاحة` : `${nFmt(m.demand)} demand · ${nFmt(m.available)} available`}</span>; })()}
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
