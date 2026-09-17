/**
 * Demand-vs-supply district choropleth (Phase 4, layer B).
 *
 * Reuses the proven MarketMap rendering (google.maps.Data, one Feature per
 * district) but is fully decoupled from the archived market-listings engine:
 * geometry comes from the listing-independent `wassell_city_district_shapes`
 * RPC, and the shading METRIC is the shared canonical demand-vs-supply severity
 * (unmet active clients) — NOT any benchmark table. District polygons are the
 * only truthful geographic layer (region/city are navigation, handled by the
 * parent drill component).
 */
import { useEffect, useRef, useState } from 'react';
import { useJsApiLoader } from '@react-google-maps/api';
import { supabase } from '@/lib/supabase';
import { getMapsLoaderOptions, isMapsKeyConfigured } from '@/lib/mapsLoader';
import { GEO_MAP_STYLE } from '@/lib/locationUtils';
import { useGeoBoundaryLayer } from '@/components/map/useGeoBoundaryLayer';

interface DistrictShape { district_id: string; name: string; name_en?: string; geojson: unknown }

/** Per-district demand/supply the parent computed from the shared layer. */
export interface DistrictMetric { demand: number; available: number; severity: number }

/** The RPC keys geometry by a `district_id` CODE that does NOT match the
 *  districts record id (which is what location.district uses). So the demand
 *  metric is joined to the polygons by normalized district NAME within the
 *  selected city (names are distinct per city). */
export const normName = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

interface Props {
  cityId: string | null;
  /** metric keyed by BOTH normalized name_ar and name_en. */
  metricByName: Map<string, DistrictMetric>;
  selectedName: string | null;
  onDistrictClick: (normalizedName: string) => void;
  isAr: boolean;
  language: 'ar' | 'en';
  heightClass?: string;
}

const RIYADH = { lat: 24.7136, lng: 46.6753 };
// Green (demand covered) → amber → red (undersupplied), by unmet-client severity.
const RAMP = ['#10B981', '#84CC16', '#F59E0B', '#EF4444', '#B91C1C'];
const NO_DATA = '#E5E7EB';
const COPPER = '#B8734F';

function severityColor(m: DistrictMetric | undefined): string {
  if (!m || m.demand === 0) return NO_DATA;
  const s = m.severity;
  if (s <= 0) return RAMP[0]!;
  if (s <= 1) return RAMP[1]!;
  if (s <= 3) return RAMP[2]!;
  if (s <= 6) return RAMP[3]!;
  return RAMP[4]!;
}

export default function DemandSupplyMap({ cityId, metricByName, selectedName, onDistrictClick, isAr, language, heightClass = 'h-[26rem]' }: Props) {
  const { isLoaded } = useJsApiLoader(getMapsLoaderOptions(language));
  const divRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const dataRef = useRef<google.maps.Data | null>(null);
  const [mapInstance, setMapInstance] = useState<google.maps.Map | null>(null);
  const [shapes, setShapes] = useState<DistrictShape[] | null>(null);
  const [hover, setHover] = useState<{ nm: string; label: string } | null>(null);
  useGeoBoundaryLayer(mapInstance, { boundaries: false });

  // Fetch the city's district polygons (listing-independent).
  useEffect(() => {
    if (!cityId || !supabase) { setShapes(cityId ? null : []); return; }
    let cancelled = false;
    setShapes(null);
    supabase.rpc('wassell_city_district_shapes', { p_city_id: cityId }).then(({ data, error }) => {
      if (cancelled) return;
      setShapes(error || !Array.isArray(data) ? [] : (data as DistrictShape[]));
    });
    return () => { cancelled = true; };
  }, [cityId]);

  const onClickRef = useRef(onDistrictClick);
  useEffect(() => { onClickRef.current = onDistrictClick; }, [onDistrictClick]);

  // Map init (once).
  useEffect(() => {
    if (!isLoaded || !divRef.current || mapRef.current) return;
    const map = new google.maps.Map(divRef.current, {
      center: RIYADH, zoom: 10, styles: GEO_MAP_STYLE,
      mapTypeControl: false, streetViewControl: false, fullscreenControl: false, clickableIcons: false,
    });
    mapRef.current = map;
    setMapInstance(map);
    const data = new google.maps.Data({ map });
    dataRef.current = data;
    data.addListener('click', (e: google.maps.Data.MouseEvent) => {
      const nm = e.feature.getProperty('nm') as string;
      if (nm) onClickRef.current(nm);
    });
    data.addListener('mouseover', (e: google.maps.Data.MouseEvent) => setHover({ nm: e.feature.getProperty('nm') as string, label: e.feature.getProperty('label') as string }));
    data.addListener('mouseout', () => setHover(null));
  }, [isLoaded]);

  // Load features + fit bounds when shapes change. Each feature carries the
  // normalized name (join key) + a display label.
  useEffect(() => {
    const data = dataRef.current, map = mapRef.current;
    if (!data || !map) return;
    data.forEach((f) => data.remove(f));
    const bounds = new google.maps.LatLngBounds();
    let any = false;
    for (const s of shapes ?? []) {
      if (!s.geojson) continue;
      const label = isAr ? s.name : (s.name_en || s.name);
      const nm = normName(s.name_en || s.name);
      try {
        data.addGeoJson({ type: 'Feature', geometry: s.geojson, properties: { nm, nmAr: normName(s.name), label } } as unknown as object);
        any = true;
      } catch { /* a malformed geometry must not take the map down */ }
    }
    if (any) {
      data.forEach((f) => f.getGeometry()?.forEachLatLng((ll) => bounds.extend(ll)));
      if (!bounds.isEmpty()) map.fitBounds(bounds);
    }
  }, [shapes, isAr]);

  const metricOf = (f: google.maps.Data.Feature): DistrictMetric | undefined =>
    metricByName.get(f.getProperty('nm') as string) ?? metricByName.get(f.getProperty('nmAr') as string);

  // Style by severity + selection.
  useEffect(() => {
    const data = dataRef.current;
    if (!data) return;
    data.setStyle((feature) => {
      const m = metricOf(feature);
      const isSel = (feature.getProperty('nm') as string) === selectedName;
      return {
        fillColor: severityColor(m),
        fillOpacity: m?.demand ? 0.7 : 0.25,
        strokeColor: isSel ? COPPER : '#FFFFFF',
        strokeWeight: isSel ? 3 : 0.8,
        strokeOpacity: isSel ? 1 : 0.6,
        zIndex: isSel ? 10 : 1,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metricByName, selectedName]);

  if (!isMapsKeyConfigured()) return <div className={`grid ${heightClass} place-items-center rounded-xl bg-cream text-sm text-charcoal/50`}>{isAr ? 'مفتاح خرائط Google غير مُعد' : 'Google Maps key not configured'}</div>;
  if (!isLoaded) return <div className={`grid ${heightClass} place-items-center rounded-xl bg-cream text-sm text-charcoal/40`}>{isAr ? 'جارٍ تحميل الخريطة…' : 'Loading map…'}</div>;
  if (!cityId) return <div className={`grid ${heightClass} place-items-center rounded-xl bg-cream text-sm text-charcoal/40`}>{isAr ? 'اختر مدينة لعرض الخريطة' : 'Select a city to view the map'}</div>;

  const hv = hover ? (metricByName.get(hover.nm) ?? undefined) : undefined;
  return (
    <div className={`relative ${heightClass} w-full overflow-hidden rounded-xl`}>
      <div ref={divRef} className="h-full w-full" />
      {shapes === null && <div className="absolute inset-0 grid place-items-center bg-cream/60 text-sm text-charcoal/40">{isAr ? 'جارٍ تحميل الأحياء…' : 'Loading districts…'}</div>}
      {/* Legend */}
      <div className="absolute bottom-3 start-3 rounded-lg bg-white/95 px-3 py-2 text-[11px] shadow-sm">
        <div className="mb-1 font-bold text-charcoal">{isAr ? 'فجوة الطلب مقابل المعروض' : 'Demand vs supply gap'}</div>
        <div className="flex items-center gap-1">
          <span className="text-charcoal/50">{isAr ? 'مغطّى' : 'Covered'}</span>
          {RAMP.map((c) => <span key={c} className="h-3 w-4 rounded-[2px]" style={{ background: c }} />)}
          <span className="text-charcoal/50">{isAr ? 'نقص' : 'Undersupplied'}</span>
        </div>
      </div>
      {/* Hover card */}
      {hover && (
        <div className="pointer-events-none absolute top-3 end-3 max-w-[220px] rounded-lg bg-white/97 px-3 py-2 text-[12px] shadow-md">
          <div className="font-bold text-charcoal">{hover.label || '—'}</div>
          {hv ? (
            <>
              <div className="mt-1 text-charcoal/70">{isAr ? `${hv.demand} طلب · ${hv.available} متاحة` : `${hv.demand} demand · ${hv.available} available`}</div>
              <div className="text-charcoal/50">{isAr ? `${hv.severity} بلا مخزون مناسب` : `${hv.severity} unmet`}</div>
            </>
          ) : <div className="mt-1 text-charcoal/40">{isAr ? 'لا طلب مسجّل' : 'No recorded demand'}</div>}
        </div>
      )}
    </div>
  );
}
