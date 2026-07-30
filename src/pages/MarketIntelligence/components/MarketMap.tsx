/**
 * The Market Intelligence map — an ANALYTICAL surface, not a listing browser.
 *
 * Three layers, all fed by one round trip (wassell_market_map_districts):
 *   • choropleth — districts shaded by median ر.س/م² for the chosen segment
 *   • our inventory — districts where Wassel holds units, badged with the count
 *   • demand — districts where active clients are looking
 *
 * Individual listing pins are deliberately ABSENT: 39k markers answer "where are
 * ads" — a question the Market Listings map already answers — while this map
 * exists to answer "where is it expensive, where do we own, where is demand".
 *
 * Rendering is via google.maps.Data (one Feature per district), NOT one Polygon
 * per district: the same reason the finder's road highlight moved to a Data
 * layer — a few hundred district polygons as individual overlays is materially
 * slower to style and redraw.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useJsApiLoader } from '@react-google-maps/api';
import { getMapsLoaderOptions, isMapsKeyConfigured } from '@/lib/mapsLoader';
import { WASSEL_MAP_STYLE } from '@/lib/locationUtils';
import { useGeoBoundaryLayer } from '@/components/map/useGeoBoundaryLayer';
import type { MapDistrict } from '@/lib/market/client';

export type MapMetric = 'price_per_sqm' | 'our_units' | 'demand';

interface Props {
  districts: MapDistrict[];
  metric: MapMetric;
  isAr: boolean;
  /** Highlighted (currently selected) district ids — drawn with a copper edge. */
  selectedIds: string[];
  onDistrictClick: (d: MapDistrict) => void;
  /** GeoJSON geometries of the compiled area, drawn over the choropleth. */
  areaShapes?: Array<{ geojson: unknown; polarity: string }>;
  language: 'ar' | 'en';
}

const RIYADH = { lat: 24.7136, lng: 46.6753 };

/** Sequential copper ramp — light (cheap) to dark (expensive). Brand-derived,
 *  and monotonic in lightness so it still reads when printed in greyscale. */
const RAMP = ['#F5EDE0', '#E8D5BC', '#D4B896', '#C09B5F', '#B8734F', '#8E4E3A', '#4A2C2A'];
const NO_DATA = '#E5E7EB';
const COPPER = '#B8734F';

/** Value → ramp bucket by QUANTILE, not equal width. Riyadh price/m² is heavily
 *  right-skewed (a handful of districts sit far above the rest); equal-width bins
 *  put ~90% of districts in the first colour and the map says nothing. */
function quantileScale(values: number[]): (v: number | null | undefined) => string {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return () => NO_DATA;
  const cuts: number[] = RAMP.slice(1).map((_, i) => {
    const q = (i + 1) / RAMP.length;
    const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    return sorted[idx] as number;
  });
  return (v) => {
    if (v == null || !Number.isFinite(v)) return NO_DATA;
    for (let i = 0; i < cuts.length; i++) {
      if (v <= (cuts[i] as number)) return RAMP[i] as string;
    }
    return RAMP[RAMP.length - 1] as string;
  };
}

const metricValue = (d: MapDistrict, metric: MapMetric): number | null => {
  if (metric === 'price_per_sqm') return d.median_price_per_sqm;
  if (metric === 'our_units') return d.our_units || null;
  return d.demand_clients || null;
};

export default function MarketMap({
  districts, metric, isAr, selectedIds, onDistrictClick, areaShapes, language,
}: Props) {
  const { isLoaded } = useJsApiLoader(getMapsLoaderOptions(language));
  const divRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const dataRef = useRef<google.maps.Data | null>(null);
  const areaDataRef = useRef<google.maps.Data | null>(null);
  const [hover, setHover] = useState<MapDistrict | null>(null);
  // The hook needs a RENDER-visible map, but this component keeps its map in a ref
  // (the Data-layer callbacks are imperative). Mirror it into state purely to drive
  // the layer.
  const [mapInstance, setMapInstance] = useState<google.maps.Map | null>(null);
  // Boundaries OFF: the district choropleth IS this screen, and drawing our outlines
  // under it would double every edge. Roads and landmarks are the context it lacks.
  useGeoBoundaryLayer(mapInstance, { boundaries: false });

  const scale = useMemo(
    () => quantileScale(districts.map((d) => metricValue(d, metric) ?? NaN)),
    [districts, metric],
  );
  // Look-ups by id so the Data-layer callbacks stay O(1) per feature.
  const byId = useMemo(() => {
    const m = new Map<string, MapDistrict>();
    districts.forEach((d) => m.set(d.district_id, d));
    return m;
  }, [districts]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  // The map + its listeners are created ONCE, but the listeners must read the
  // CURRENT districts and callback. Closing over them directly meant the click
  // handler captured the empty lookup from first render (the fetch had not
  // resolved yet) and every district click silently did nothing — the effect
  // cannot re-attach, because it bails on mapRef.current being set.
  const byIdRef = useRef(byId);
  const onClickRef = useRef(onDistrictClick);
  useEffect(() => { byIdRef.current = byId; }, [byId]);
  useEffect(() => { onClickRef.current = onDistrictClick; }, [onDistrictClick]);

  // ── Map init (once) ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!isLoaded || !divRef.current || mapRef.current) return;
    const map = new google.maps.Map(divRef.current, {
      center: RIYADH,
      zoom: 10,
      styles: WASSEL_MAP_STYLE,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
      clickableIcons: false,
    });
    mapRef.current = map;
    setMapInstance(map);

    const data = new google.maps.Data({ map });
    dataRef.current = data;
    data.addListener('click', (e: google.maps.Data.MouseEvent) => {
      const id = e.feature.getProperty('district_id') as string;
      const d = byIdRef.current.get(id);
      if (d) onClickRef.current(d);
    });
    data.addListener('mouseover', (e: google.maps.Data.MouseEvent) => {
      const id = e.feature.getProperty('district_id') as string;
      setHover(byIdRef.current.get(id) ?? null);
    });
    data.addListener('mouseout', () => setHover(null));

    areaDataRef.current = new google.maps.Data({ map });
  }, [isLoaded]);

  // ── Choropleth features ───────────────────────────────────────────────────
  useEffect(() => {
    const data = dataRef.current;
    if (!data) return;
    data.forEach((f) => data.remove(f));
    districts.forEach((d) => {
      if (!d.outline) return;
      data.addGeoJson({
        type: 'Feature',
        geometry: d.outline,
        properties: { district_id: d.district_id },
      } as unknown as object);
    });
  }, [districts]);

  // ── Styling (re-runs on metric / selection change, not on data rebuild) ───
  useEffect(() => {
    const data = dataRef.current;
    if (!data) return;
    data.setStyle((feature) => {
      const id = feature.getProperty('district_id') as string;
      const d = byId.get(id);
      const isSel = selected.has(id);
      return {
        fillColor: d ? scale(metricValue(d, metric)) : NO_DATA,
        fillOpacity: d && metricValue(d, metric) != null ? 0.72 : 0.25,
        strokeColor: isSel ? COPPER : '#FFFFFF',
        strokeWeight: isSel ? 3 : 0.8,
        strokeOpacity: isSel ? 1 : 0.6,
        zIndex: isSel ? 10 : 1,
      };
    });
  }, [byId, metric, scale, selected]);

  // ── The compiled area outline on top ──────────────────────────────────────
  useEffect(() => {
    const layer = areaDataRef.current;
    if (!layer) return;
    layer.forEach((f) => layer.remove(f));
    (areaShapes ?? []).forEach((s) => {
      if (!s.geojson) return;
      try {
        layer.addGeoJson({ type: 'Feature', geometry: s.geojson, properties: { polarity: s.polarity } } as unknown as object);
      } catch (err) {
        // A malformed geometry must not take the whole map down — but it must
        // not vanish silently either, or the user sees a smaller area with no
        // explanation of why.
        console.error('[MarketMap] could not draw area shape', err);
      }
    });
    layer.setStyle((feature) => {
      const excl = feature.getProperty('polarity') === 'exclude';
      return {
        fillColor: excl ? '#B91C1C' : COPPER,
        fillOpacity: 0.12,
        strokeColor: excl ? '#B91C1C' : COPPER,
        strokeWeight: 2.5,
        strokeOpacity: 0.95,
        zIndex: 20,
      };
    });
  }, [areaShapes]);

  if (!isMapsKeyConfigured()) {
    return (
      <div className="grid h-full place-items-center rounded-xl bg-cream text-sm text-charcoal/50">
        {isAr ? 'مفتاح خرائط Google غير مُعد' : 'Google Maps key not configured'}
      </div>
    );
  }
  if (!isLoaded) {
    return (
      <div className="grid h-full place-items-center rounded-xl bg-cream text-sm text-charcoal/40">
        {isAr ? 'جارٍ تحميل الخريطة…' : 'Loading map…'}
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl">
      <div ref={divRef} className="h-full w-full" />

      {/* Legend */}
      <div className="absolute bottom-3 start-3 rounded-lg bg-white/95 px-3 py-2 text-[11px] shadow-sm">
        <div className="mb-1 font-bold text-charcoal">
          {metric === 'price_per_sqm' ? (isAr ? 'متوسط ر.س/م²' : 'Median SAR/m²')
            : metric === 'our_units' ? (isAr ? 'وحداتنا' : 'Our units')
            : (isAr ? 'طلب العملاء' : 'Client demand')}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-charcoal/50">{isAr ? 'أقل' : 'Low'}</span>
          {RAMP.map((c) => (
            <span key={c} className="h-3 w-4 rounded-[2px]" style={{ background: c }} />
          ))}
          <span className="text-charcoal/50">{isAr ? 'أعلى' : 'High'}</span>
        </div>
        <div className="mt-1 flex items-center gap-1 text-charcoal/45">
          <span className="h-3 w-4 rounded-[2px]" style={{ background: NO_DATA }} />
          {isAr ? 'لا توجد بيانات كافية' : 'Not enough data'}
        </div>
      </div>

      {/* Hover card */}
      {hover && (
        <div className="pointer-events-none absolute top-3 end-3 max-w-[240px] rounded-lg bg-white/97 px-3 py-2 text-[12px] shadow-md">
          <div className="font-bold text-charcoal">{isAr ? hover.district_name : (hover.district_name_en || hover.district_name)}</div>
          <div className="text-charcoal/55">{hover.city_name}</div>
          <div className="mt-1 space-y-0.5">
            <div>{isAr ? 'متوسط ر.س/م²' : 'Median SAR/m²'}: <b>{hover.median_price_per_sqm ? Math.round(hover.median_price_per_sqm).toLocaleString('en-US') : '—'}</b></div>
            <div>{isAr ? 'إعلانات' : 'Listings'}: {hover.listing_count.toLocaleString('en-US')}</div>
            <div>{isAr ? 'وحداتنا' : 'Our units'}: {hover.our_units.toLocaleString('en-US')}</div>
            <div>{isAr ? 'عملاء يبحثون هنا' : 'Clients looking here'}: {hover.demand_clients.toLocaleString('en-US')}</div>
          </div>
        </div>
      )}
    </div>
  );
}
