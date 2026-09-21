/**
 * Drill-down demand-vs-supply choropleth (Projects & Inventory, Command Center).
 *
 * FILLED admin polygons — one google.maps.Data feature per boundary (the same
 * perf posture as MarketMap: a few hundred polygons as one Data layer, never one
 * <Polygon> overlay each) — coloured by the caller's demand-vs-supply metric.
 * The component is deliberately dumb about the hierarchy: the section owns the
 * drill level and hands down the current tier's `shapes`, a `colorOf`, a
 * `metricOf`, and a `keyOf`. Clicking a feature calls `onFeatureClick(shape)` —
 * the section decides whether that means "drill into this region/city" or
 * "select this district". `fitToken` changing re-fits the viewport to the drawn
 * set; `focusBounds` zooms to a single selected feature.
 *
 * This replaces the earlier centroid-PIN map: the pins never lined up with any
 * real area and could not be drilled. The polygons join to demand EXACTLY via
 * the district record id (see 2026-09-21_geo_choropleth_drilldown.sql).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useJsApiLoader } from '@react-google-maps/api';
import { getMapsLoaderOptions, isMapsKeyConfigured } from '@/lib/mapsLoader';
import { GEO_MAP_STYLE } from '@/lib/locationUtils';
import { useGeoBoundaryLayer } from '@/components/map/useGeoBoundaryLayer';
import { geometryBounds, type GeoShape, type GeoTier, type DistrictMetric } from '@/lib/geo/choropleth';

const RIYADH = { lat: 24.7136, lng: 46.6753 };
const NO_DATA = '#E5E7EB';
const COPPER = '#B8734F';

interface Bounds { south: number; west: number; north: number; east: number }

interface Props {
  shapes: GeoShape[];
  level: GeoTier;
  /** Stable key per feature — external_id for region/city, record_id for district. */
  keyOf: (s: GeoShape) => string;
  colorOf: (s: GeoShape) => string;
  metricOf: (s: GeoShape) => DistrictMetric;
  labelOf: (s: GeoShape) => string;
  selectedKey: string | null;
  onFeatureClick: (s: GeoShape) => void;
  /** When set, zoom to this one feature (a selected district). */
  focusBounds?: Bounds | null;
  isAr: boolean;
  language: 'ar' | 'en';
  heightClass?: string;
}

export default function GeoChoroplethMap({
  shapes, level, keyOf, colorOf, metricOf, labelOf, selectedKey, onFeatureClick,
  focusBounds, isAr, language, heightClass = 'h-[32rem]',
}: Props) {
  const { isLoaded } = useJsApiLoader(getMapsLoaderOptions(language));
  const divRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const dataRef = useRef<google.maps.Data | null>(null);
  const [mapInstance, setMapInstance] = useState<google.maps.Map | null>(null);
  const [hover, setHover] = useState<GeoShape | null>(null);
  // Boundaries OFF — our choropleth IS the boundary layer; roads/landmarks give context.
  useGeoBoundaryLayer(mapInstance, { boundaries: false, landmarks: level === 'district' });

  // Look-ups kept in refs so the once-created click/hover listeners read current data.
  const byKey = useMemo(() => {
    const m = new Map<string, GeoShape>();
    for (const s of shapes) m.set(keyOf(s), s);
    return m;
  }, [shapes, keyOf]);
  const byKeyRef = useRef(byKey);
  const colorRef = useRef(colorOf);
  const clickRef = useRef(onFeatureClick);
  useEffect(() => { byKeyRef.current = byKey; }, [byKey]);
  useEffect(() => { colorRef.current = colorOf; }, [colorOf]);
  useEffect(() => { clickRef.current = onFeatureClick; }, [onFeatureClick]);
  const selectedRef = useRef(selectedKey);
  useEffect(() => { selectedRef.current = selectedKey; }, [selectedKey]);

  // ── Map init (once) ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isLoaded || !divRef.current || mapRef.current) return;
    const map = new google.maps.Map(divRef.current, {
      center: RIYADH, zoom: 6, styles: GEO_MAP_STYLE,
      mapTypeControl: false, streetViewControl: false, fullscreenControl: false, clickableIcons: false,
    });
    mapRef.current = map;
    setMapInstance(map);

    const data = new google.maps.Data({ map });
    dataRef.current = data;
    data.addListener('click', (e: google.maps.Data.MouseEvent) => {
      const k = e.feature.getProperty('k') as string;
      const s = byKeyRef.current.get(k);
      if (s) clickRef.current(s);
    });
    data.addListener('mouseover', (e: google.maps.Data.MouseEvent) => {
      const k = e.feature.getProperty('k') as string;
      setHover(byKeyRef.current.get(k) ?? null);
    });
    data.addListener('mouseout', () => setHover(null));
  }, [isLoaded]);

  // ── (Re)draw features + fit to the drawn set ────────────────────────────────
  useEffect(() => {
    const data = dataRef.current, map = mapRef.current;
    if (!data || !map) return;
    data.forEach((f) => data.remove(f));
    const agg: Bounds = { south: 90, west: 180, north: -90, east: -180 };
    let any = false;
    for (const s of shapes) {
      if (!s.geojson) continue;
      data.addGeoJson({ type: 'Feature', geometry: s.geojson, properties: { k: keyOf(s) } } as unknown as object);
      const b = geometryBounds(s.geojson);
      if (b) {
        any = true;
        agg.south = Math.min(agg.south, b.south); agg.west = Math.min(agg.west, b.west);
        agg.north = Math.max(agg.north, b.north); agg.east = Math.max(agg.east, b.east);
      }
    }
    if (any) {
      const gb = new google.maps.LatLngBounds({ lat: agg.south, lng: agg.west }, { lat: agg.north, lng: agg.east });
      map.fitBounds(gb, 24);
    }
    // Redraw + refit whenever the drawn SET changes (a drill loads new shapes),
    // AND once the map itself becomes ready — shapes often resolve before the Maps
    // library finishes loading, and without mapInstance in the deps that first set
    // would be dropped (the effect bails on !map and never re-runs).
    // Selecting a district does NOT change `shapes`, so it won't refit here — the
    // focusBounds effect handles zooming to the one selected district.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, mapInstance]);

  // ── Style (re-runs on colour / selection change, not on redraw) ─────────────
  useEffect(() => {
    const data = dataRef.current;
    if (!data) return;
    data.setStyle((feature) => {
      const k = feature.getProperty('k') as string;
      const s = byKey.get(k);
      const isSel = k === selectedKey;
      return {
        fillColor: s ? colorOf(s) : NO_DATA,
        fillOpacity: 0.72,
        strokeColor: isSel ? COPPER : '#FFFFFF',
        strokeWeight: isSel ? 3 : 0.8,
        strokeOpacity: isSel ? 1 : 0.65,
        zIndex: isSel ? 10 : 1,
      };
    });
  }, [byKey, colorOf, selectedKey]);

  // ── Zoom to a selected district ─────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focusBounds) return;
    map.fitBounds(
      new google.maps.LatLngBounds(
        { lat: focusBounds.south, lng: focusBounds.west },
        { lat: focusBounds.north, lng: focusBounds.east },
      ),
      48,
    );
  }, [focusBounds]);

  if (!isMapsKeyConfigured()) return <div className={`grid ${heightClass} place-items-center rounded-xl bg-cream text-sm text-charcoal/50`}>{isAr ? 'مفتاح خرائط Google غير مُعد' : 'Google Maps key not configured'}</div>;
  if (!isLoaded) return <div className={`grid ${heightClass} place-items-center rounded-xl bg-cream text-sm text-charcoal/40`}>{isAr ? 'جارٍ تحميل الخريطة…' : 'Loading map…'}</div>;

  const hoverMetric = hover ? metricOf(hover) : null;
  const drillHint = level === 'district' ? (isAr ? 'انقر للتكبير والتفاصيل' : 'Click to zoom + details')
    : level === 'region' ? (isAr ? 'انقر لفتح مدن المنطقة' : 'Click to open the region’s cities')
    : (isAr ? 'انقر لفتح أحياء المدينة' : 'Click to open the city’s districts');

  return (
    <div className={`relative ${heightClass} w-full overflow-hidden rounded-xl`}>
      <div ref={divRef} className="h-full w-full" />
      {shapes.length === 0 && <div className="absolute inset-0 grid place-items-center bg-cream/60 text-sm text-charcoal/40">{isAr ? 'لا توجد مناطق لعرضها' : 'No areas to display'}</div>}

      {/* Legend */}
      <div className="absolute bottom-3 start-3 rounded-lg bg-white/95 px-3 py-2 text-[11px] shadow-sm">
        <div className="mb-1 font-bold text-charcoal">{isAr ? 'فجوة الطلب مقابل المعروض' : 'Demand vs supply'}</div>
        <div className="flex items-center gap-1">
          <span className="text-charcoal/50">{isAr ? 'مغطّى' : 'Covered'}</span>
          {['#10B981', '#84CC16', '#F59E0B', '#EF4444', '#B91C1C'].map((c) => <span key={c} className="h-3 w-4 rounded-[2px]" style={{ background: c }} />)}
          <span className="text-charcoal/50">{isAr ? 'نقص' : 'Undersupplied'}</span>
        </div>
        <div className="mt-1 flex items-center gap-1 text-charcoal/45"><span className="h-3 w-4 rounded-[2px]" style={{ background: '#9CA3AF' }} /> {isAr ? 'معروض بلا طلب' : 'Supply, no demand'}</div>
        <div className="flex items-center gap-1 text-charcoal/45"><span className="h-3 w-4 rounded-[2px]" style={{ background: NO_DATA }} /> {isAr ? 'لا طلب ولا معروض' : 'No demand or supply'}</div>
      </div>

      {/* Hover card */}
      {hover && hoverMetric && (
        <div className="pointer-events-none absolute top-3 end-3 max-w-[240px] rounded-lg bg-white/97 px-3 py-2 text-[12px] shadow-md">
          <div className="font-bold text-charcoal">{labelOf(hover)}</div>
          <div className="mt-1 text-charcoal/70">{isAr ? `${hoverMetric.demand} طلب · ${hoverMetric.available} متاحة` : `${hoverMetric.demand} demand · ${hoverMetric.available} available`}</div>
          {hoverMetric.severity > 0 && <div className="text-charcoal/50">{isAr ? `${hoverMetric.severity} بلا مخزون مناسب` : `${hoverMetric.severity} unmet`}</div>}
          <div className="mt-1 text-copper">{drillHint}</div>
        </div>
      )}
    </div>
  );
}
