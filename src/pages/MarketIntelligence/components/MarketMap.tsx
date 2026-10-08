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
 * Rendering is ONE GeoJsonOverlay (one feature per district) styled by a
 * function, NOT one shape object per district: a few hundred district polygons
 * as individual overlays is materially slower to style and redraw, while a
 * single overlay restyles in one data-driven paint pass.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import MapCanvas from '@/components/map/MapCanvas';
import { GeoJsonOverlay, geometryFeature, type MlMap, type OverlayFeature } from '@/lib/map';
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

/** A GeoJSON geometry the overlay can draw (type + coordinate array, or a collection). */
function isDrawableGeometry(g: unknown): g is { type: string; coordinates: unknown } {
  if (!g || typeof g !== 'object') return false;
  const o = g as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  if (typeof o.type !== 'string') return false;
  return Array.isArray(o.coordinates) || (o.type === 'GeometryCollection' && Array.isArray(o.geometries));
}

export default function MarketMap({
  districts, metric, isAr, selectedIds, onDistrictClick, areaShapes, language,
}: Props) {
  const dataRef = useRef<GeoJsonOverlay | null>(null);
  const areaDataRef = useRef<GeoJsonOverlay | null>(null);
  const [hover, setHover] = useState<MapDistrict | null>(null);
  // Set by MapCanvas once the basemap has loaded; drives every layer effect below.
  const [mapInstance, setMapInstance] = useState<MlMap | null>(null);

  const scale = useMemo(
    () => quantileScale(districts.map((d) => metricValue(d, metric) ?? NaN)),
    [districts, metric],
  );
  // Look-ups by id so the overlay callbacks stay O(1) per feature.
  const byId = useMemo(() => {
    const m = new Map<string, MapDistrict>();
    districts.forEach((d) => m.set(d.district_id, d));
    return m;
  }, [districts]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  // The overlay + its listeners are created ONCE per map, but the listeners must
  // read the CURRENT districts and callback. Closing over them directly meant the
  // click handler captured the empty lookup from first render (the fetch had not
  // resolved yet) and every district click silently did nothing.
  const byIdRef = useRef(byId);
  const onClickRef = useRef(onDistrictClick);
  useEffect(() => { byIdRef.current = byId; }, [byId]);
  useEffect(() => { onClickRef.current = onDistrictClick; }, [onDistrictClick]);

  // ── Choropleth overlay (once per map) ─────────────────────────────────────
  // Declared BEFORE useGeoBoundaryLayer so it is created first and therefore
  // stacks UNDER the hook's roads/landmarks (overlays stack in creation order).
  useEffect(() => {
    if (!mapInstance) return;
    const data = new GeoJsonOverlay(mapInstance);
    dataRef.current = data;
    data.on('click', (_hit, props) => {
      const d = byIdRef.current.get(String(props.district_id));
      if (d) onClickRef.current(d);
    });
    data.on('mouseover', (_hit, props) => {
      setHover(byIdRef.current.get(String(props.district_id)) ?? null);
    });
    data.on('mouseout', () => setHover(null));
    return () => {
      data.remove();
      dataRef.current = null;
      setHover(null);
    };
  }, [mapInstance]);

  // Boundaries OFF: the district choropleth IS this screen, and drawing our outlines
  // under it would double every edge. Roads and landmarks are the context it lacks.
  useGeoBoundaryLayer(mapInstance, { boundaries: false, isAr });

  // ── Compiled-area overlay (once per map) — created AFTER the hook's layers so
  // the area outline sits on top of everything. Display only (not clickable), so
  // a click inside the area still reaches the district underneath.
  useEffect(() => {
    if (!mapInstance) return;
    const layer = new GeoJsonOverlay(mapInstance, {
      style: (p) => {
        const excl = p.polarity === 'exclude';
        return {
          fillColor: excl ? '#B91C1C' : COPPER,
          fillOpacity: 0.12,
          strokeColor: excl ? '#B91C1C' : COPPER,
          strokeWeight: 2.5,
          strokeOpacity: 0.95,
          zIndex: 20,
        };
      },
    });
    areaDataRef.current = layer;
    return () => {
      layer.remove();
      areaDataRef.current = null;
    };
  }, [mapInstance]);

  // ── Choropleth features ───────────────────────────────────────────────────
  useEffect(() => {
    const data = dataRef.current;
    if (!data) return;
    const features: OverlayFeature[] = [];
    districts.forEach((d) => {
      if (!d.outline) return;
      features.push(geometryFeature(d.outline, { district_id: d.district_id }));
    });
    data.setData(features);
    // mapInstance: districts often resolve before the basemap finishes loading —
    // the first set must still be drawn once the overlay exists.
  }, [districts, mapInstance]);

  // ── Styling (re-runs on metric / selection change, not on data rebuild) ───
  useEffect(() => {
    const data = dataRef.current;
    if (!data) return;
    data.setStyle((props) => {
      const id = String(props.district_id);
      const d = byId.get(id);
      const isSel = selected.has(id);
      return {
        fillColor: d ? scale(metricValue(d, metric)) : NO_DATA,
        fillOpacity: d && metricValue(d, metric) != null ? 0.72 : 0.25,
        strokeColor: isSel ? COPPER : '#FFFFFF',
        strokeWeight: isSel ? 3 : 0.8,
        strokeOpacity: isSel ? 1 : 0.6,
        zIndex: isSel ? 10 : 1,
        clickable: true,
      };
    });
  }, [byId, metric, scale, selected, mapInstance]);

  // ── The compiled area outline on top ──────────────────────────────────────
  useEffect(() => {
    const layer = areaDataRef.current;
    if (!layer) return;
    const features: OverlayFeature[] = [];
    (areaShapes ?? []).forEach((s) => {
      if (!s.geojson) return;
      if (!isDrawableGeometry(s.geojson)) {
        // A malformed geometry must not take the whole map down — but it must
        // not vanish silently either, or the user sees a smaller area with no
        // explanation of why.
        console.error('[MarketMap] could not draw area shape', s.geojson);
        return;
      }
      features.push(geometryFeature(s.geojson, { polarity: s.polarity }));
    });
    layer.setData(features);
  }, [areaShapes, mapInstance]);

  return (
    <div className="relative h-full w-full overflow-hidden rounded-xl">
      <MapCanvas
        isAr={language === 'ar'}
        className="h-full w-full"
        center={RIYADH}
        zoom={10}
        onLoad={setMapInstance}
        onUnmount={() => setMapInstance(null)}
        // Top-start keeps the zoom buttons clear of the legend (bottom-start) and
        // the hover card (top-end) in both directions.
        navigationControl={isAr ? 'top-right' : 'top-left'}
      />

      {/* Legend — lifted above the basemap attribution (bottom-left). */}
      <div className="absolute bottom-9 start-3 rounded-lg bg-white/95 px-3 py-2 text-[11px] shadow-sm">
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
