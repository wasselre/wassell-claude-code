/**
 * Market Intelligence → Map.
 *
 * Answers "what are the numbers HERE", where HERE is any area the user can
 * express — click districts on the map, search a city/district by name, or build
 * a rule with the same vocabulary the client-preference field uses (a band north
 * of a road, a radius around a landmark, a freehand polygon, minus exclusions).
 *
 * The area is a LocationItem[] — literally the same type stored on a client — so
 * "show me this client's market" is the same call with their saved items, and the
 * numbers are guaranteed to describe the same ground the Project Finder searches.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Map as MapIcon, Search, X, User, RotateCcw, FileDown } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { supabase } from '@/lib/supabase';
import Button from '@/components/ui/Button';
import LocationItemsEditor from '@/components/LocationItemsEditor';
import {
  type LocationItem, newDistrictItem, describeLocationItem,
} from '@/lib/geo/locationItems';
import {
  fetchAreaStats, fetchMapDistricts, fetchGeoCoverage, fetchClientArea, fetchFilters,
  type AreaStats, type MapDistrict, type GeoCoverage,
} from '@/lib/market/client';
import { CANON_PROPERTY_TYPES, propertyTypeLabel } from '@/lib/market/propertyType';
import MarketMap, { type MapMetric } from './MarketMap';
import AreaStatsPanel from './AreaStatsPanel';
import { downloadAreaStudyPdf } from '../reports/areaStudyPdf';
import type { AppModel, ModelField } from '@/types';

const CLIENTS_MODEL = 'clients';
const BEDROOM_BUCKETS = ['all', '1-2', '3', '4', '5+'];

const flatFields = (m: AppModel | undefined): ModelField[] =>
  (m?.schema?.sections ?? []).flatMap((s) => s.fields ?? []);

export default function MapTab({ isAr }: { isAr: boolean }) {
  const { models, records, language } = useAppStore();

  // The clients model's `location` field drives the district picker inside
  // LocationItemsEditor (it carries the country→region→city→district levels).
  const clientsModel = models.find((m) => m.name === CLIENTS_MODEL);
  const locationField = useMemo(
    () => flatFields(clientsModel).find((f) => f.type === 'location'),
    [clientsModel],
  );

  const [cities, setCities] = useState<{ id: string; name: string }[]>([]);
  const [cityId, setCityId] = useState<string>('');
  const [propertyType, setPropertyType] = useState<string>('شقة');
  const [bedrooms, setBedrooms] = useState<string>('all');
  const [metric, setMetric] = useState<MapMetric>('price_per_sqm');

  const [items, setItems] = useState<LocationItem[]>([]);
  const [areaShapes, setAreaShapes] = useState<Array<{ geojson: unknown; polarity: string }>>([]);
  const [districts, setDistricts] = useState<MapDistrict[]>([]);
  const [stats, setStats] = useState<AreaStats | null>(null);
  const [coverage, setCoverage] = useState<GeoCoverage | null>(null);
  const [loadingMap, setLoadingMap] = useState(true);
  const [loadingStats, setLoadingStats] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  // Client mode — view the market exactly as one client defined it.
  const [clientId, setClientId] = useState<string>('');
  const [clientMeta, setClientMeta] = useState<{ name: string | null; budget_min: number | null; budget_max: number | null } | null>(null);

  const clientRows = useMemo(() => {
    const id = clientsModel?.id;
    if (!id) return [] as Array<{ id: string; name: string }>;
    return (records[id] ?? [])
      .filter((r) => Array.isArray(r.data.location_items) && (r.data.location_items as unknown[]).length > 0)
      .map((r) => ({ id: r.id, name: String(r.data.client_name ?? r.id) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  }, [clientsModel, records]);

  // ── initial: cities + coverage ────────────────────────────────────────────
  useEffect(() => {
    fetchFilters()
      .then((f) => {
        setCities(f.cities ?? []);
        const first = f.cities?.[0];
        if (!cityId && first) setCityId(first.id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    fetchGeoCoverage().then(setCoverage).catch(() => {
      // Coverage is a caveat, not a blocker — but never swallow it silently.
      console.error('[MapTab] geo coverage unavailable; area caveats will be incomplete');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── choropleth ────────────────────────────────────────────────────────────
  useEffect(() => {
    setLoadingMap(true);
    fetchMapDistricts({ property_type: propertyType, bedrooms_bucket: bedrooms, city_id: cityId || undefined })
      .then((r) => setDistricts(r.districts ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingMap(false));
  }, [propertyType, bedrooms, cityId]);

  // ── area statistics whenever the area changes ─────────────────────────────
  useEffect(() => {
    if (!items.length) { setStats(null); setAreaShapes([]); return; }
    let cancelled = false;
    setLoadingStats(true);
    fetchAreaStats(items, { property_type: propertyType, bedrooms_bucket: bedrooms })
      .then((s) => { if (!cancelled) setStats(s); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoadingStats(false); });
    return () => { cancelled = true; };
  }, [items, propertyType, bedrooms]);

  // ── compiled outline for the map overlay ──────────────────────────────────
  // Same RPC the client-preference picker uses, so what is shaded here is what
  // the matcher actually resolved — not a client-side approximation of it.
  useEffect(() => {
    const nonDistrict = items.filter((i) => i.kind !== 'district');
    if (!supabase || !nonDistrict.length) { setAreaShapes([]); return; }
    let cancelled = false;
    supabase.rpc('wassell_preview_geo_items', { p_items: nonDistrict })
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) { console.error('[MapTab] area preview failed', err); return; }
        const rows = (data ?? []) as Array<{ geojson: unknown; polarity: string }>;
        setAreaShapes(rows.filter((r) => r.geojson).map((r) => ({ geojson: r.geojson, polarity: r.polarity })));
      });
    return () => { cancelled = true; };
  }, [items]);

  const selectedDistrictIds = useMemo(
    () => items.filter((i) => i.kind === 'district' && i.polarity === 'include').map((i) => (i as { district_id: string }).district_id),
    [items],
  );

  const toggleDistrict = useCallback((d: MapDistrict) => {
    setClientId(''); setClientMeta(null);
    setItems((prev) => {
      const existing = prev.find((i) => i.kind === 'district' && (i as { district_id: string }).district_id === d.district_id);
      if (existing) return prev.filter((i) => i !== existing);
      return [...prev, newDistrictItem(d.district_id, d.district_name ?? d.district_id, 'include')];
    });
  }, []);

  const onPickClient = async (id: string) => {
    setClientId(id);
    if (!id) { setClientMeta(null); setItems([]); return; }
    setLoadingStats(true);
    try {
      const r = await fetchClientArea(id, { bedrooms_bucket: bedrooms });
      setClientMeta({ name: r.client_name, budget_min: r.budget_min, budget_max: r.budget_max });
      setItems((r.location_items ?? []) as LocationItem[]);
      if (r.preferred_unit_type) setPropertyType(r.preferred_unit_type);
      setStats(r.stats);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingStats(false);
    }
  };

  // Name search over the districts already on the map (they carry the metric).
  const matches = useMemo(() => {
    const q = query.trim();
    if (!q) return [];
    return districts
      .filter((d) => (d.district_name ?? '').includes(q) || (d.district_name_en ?? '').toLowerCase().includes(q.toLowerCase()))
      .slice(0, 8);
  }, [query, districts]);

  const areaLabel = items.length
    ? items.map((i) => describeLocationItem(i, isAr)).join(isAr ? ' + ' : ' + ')
    : '';

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="card flex flex-wrap items-center gap-2 p-3">
        <select value={cityId} onChange={(e) => setCityId(e.target.value)}
          className="rounded-lg border border-sand/50 bg-white px-2.5 py-1.5 text-sm">
          {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        <select value={propertyType} onChange={(e) => setPropertyType(e.target.value)}
          className="rounded-lg border border-sand/50 bg-white px-2.5 py-1.5 text-sm">
          {CANON_PROPERTY_TYPES.map((t) => (
            <option key={t} value={t}>{propertyTypeLabel(t, isAr)}</option>
          ))}
        </select>

        <select value={bedrooms} onChange={(e) => setBedrooms(e.target.value)}
          className="rounded-lg border border-sand/50 bg-white px-2.5 py-1.5 text-sm">
          {BEDROOM_BUCKETS.map((b) => (
            <option key={b} value={b}>{b === 'all' ? (isAr ? 'كل الغرف' : 'All bedrooms') : `${b} ${isAr ? 'غرف' : 'bd'}`}</option>
          ))}
        </select>

        {/* Metric = which layer colours the map */}
        <div className="flex overflow-hidden rounded-lg border border-sand/50">
          {([
            ['price_per_sqm', isAr ? 'السعر/م²' : 'Price/m²'],
            ['our_units', isAr ? 'وحداتنا' : 'Our units'],
            ['demand', isAr ? 'الطلب' : 'Demand'],
          ] as [MapMetric, string][]).map(([m, label]) => (
            <button key={m} onClick={() => setMetric(m)}
              className={`px-2.5 py-1.5 text-[12px] font-semibold transition-colors ${
                metric === m ? 'bg-copper text-white' : 'bg-white text-charcoal/60 hover:bg-cream'}`}>
              {label}
            </button>
          ))}
        </div>

        {/* Search by district name */}
        <div className="relative min-w-[180px] flex-1">
          <Search size={14} className="absolute top-1/2 -translate-y-1/2 text-charcoal/35 start-2.5" />
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={isAr ? 'ابحث عن حي…' : 'Search a district…'}
            className="w-full rounded-lg border border-sand/50 bg-white py-1.5 text-sm ps-8 pe-2.5" />
          {matches.length > 0 && (
            <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-sand/40 bg-white shadow-lg">
              {matches.map((d) => (
                <button key={d.district_id}
                  onClick={() => { toggleDistrict(d); setQuery(''); }}
                  className="flex w-full items-center justify-between px-3 py-2 text-start text-[13px] hover:bg-cream">
                  <span>{isAr ? d.district_name : (d.district_name_en || d.district_name)}</span>
                  <span className="text-[11px] text-charcoal/45">
                    {d.median_price_per_sqm ? `${Math.round(d.median_price_per_sqm).toLocaleString('en-US')} ر.س/م²` : '—'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Client mode */}
        <div className="flex items-center gap-1.5">
          <User size={14} className="text-charcoal/40" />
          <select value={clientId} onChange={(e) => void onPickClient(e.target.value)}
            className="max-w-[190px] rounded-lg border border-sand/50 bg-white px-2.5 py-1.5 text-sm">
            <option value="">{isAr ? 'سوق عميل…' : "A client's market…"}</option>
            {clientRows.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        {/* Map */}
        <div className="card relative overflow-hidden p-0" style={{ minHeight: 520 }}>
          <div className="absolute inset-0">
            <MarketMap
              districts={districts}
              metric={metric}
              isAr={isAr}
              selectedIds={selectedDistrictIds}
              onDistrictClick={toggleDistrict}
              areaShapes={areaShapes}
              language={language === 'ar' ? 'ar' : 'en'}
            />
          </div>
          {loadingMap && (
            <div className="absolute top-3 start-3 rounded-lg bg-white/90 px-2.5 py-1 text-[11px] text-charcoal/55 shadow-sm">
              {isAr ? 'جارٍ تحميل الأحياء…' : 'Loading districts…'}
            </div>
          )}
        </div>

        {/* Area + stats */}
        <div className="space-y-3">
          <div className="card p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-sm font-bold text-charcoal">
                <MapIcon size={15} className="text-copper" />
                {clientMeta
                  ? (isAr ? `منطقة العميل: ${clientMeta.name ?? ''}` : `Client area: ${clientMeta.name ?? ''}`)
                  : (isAr ? 'المنطقة المحددة' : 'Selected area')}
              </div>
              {items.length > 0 && (
                <button onClick={() => { setItems([]); setClientId(''); setClientMeta(null); }}
                  className="flex items-center gap-1 text-[11px] text-charcoal/45 hover:text-charcoal">
                  <RotateCcw size={11} /> {isAr ? 'مسح' : 'Clear'}
                </button>
              )}
            </div>

            {items.length === 0 ? (
              <p className="mb-2 text-[12px] text-charcoal/50">
                {isAr
                  ? 'اضغط على حي في الخريطة، أو أضف نطاقاً (شمال طريق، حول معلم، أو ارسم منطقة).'
                  : 'Click a district on the map, or add a rule (north of a road, around a landmark, or draw an area).'}
              </p>
            ) : (
              <div className="mb-2 text-[12px] leading-relaxed text-charcoal/70">{areaLabel}</div>
            )}

            <LocationItemsEditor
              items={items}
              onChange={(next) => { setClientId(''); setClientMeta(null); setItems(next); }}
              locationField={locationField}
              locationValue={{ city: cityId }}
              isAr={isAr}
              embedded
            />
          </div>

          {items.length > 0 && stats && (
            <Button variant="secondary" onClick={() => downloadAreaStudyPdf({
              stats, coverage, areaLabel, isAr,
              clientName: clientMeta?.name ?? null,
              budget: clientMeta ? { min: clientMeta.budget_min, max: clientMeta.budget_max } : null,
              propertyType, bedrooms,
            })}>
              <FileDown size={15} /> {isAr ? 'تصدير دراسة المنطقة (PDF)' : 'Export area study (PDF)'}
            </Button>
          )}

          <AreaStatsPanel
            stats={stats}
            coverage={coverage}
            loading={loadingStats}
            isAr={isAr}
            budget={clientMeta ? { min: clientMeta.budget_min, max: clientMeta.budget_max } : null}
          />
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-[12px] text-rose-800">
          <X size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
