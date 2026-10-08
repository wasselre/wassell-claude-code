import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { DEFAULT_MAP_CENTER, buildPillIcon } from '@/lib/locationUtils';
import { geojsonToPaths, geojsonToLinePaths } from '@/lib/geo/geojsonPaths';
import MapCanvas from '@/components/map/MapCanvas';
import { useGeoBoundaryLayer } from '@/components/map/useGeoBoundaryLayer';
import {
  GeoJsonOverlay, geometryFeature, polygonFeature, lineFeature, createIconMarker,
  boundsOf, fitToBounds, type MlMap, type LatLng, type MapIcon, type OverlayFeature,
} from '@/lib/map';
import type { LocationItemDTO } from '../lib/shared';

/**
 * Read-only map of what the AI placed for one conversation: the proposal's
 * location items. Districts are drawn from the SAME boundary polygons the
 * Finder verifies against (`wassell_district_shapes_by_ids`); element rules
 * (zones, radii, road sides) go through the real compiler
 * (`wassell_preview_geo_items`). Include = copper, exclude = red. Nothing here
 * is editable and nothing is written.
 *
 * Each drawn shape carries its own name pill, so a grader can read which
 * district / zone every shape is. (The Esri basemap carries no place text of
 * its own — see src/lib/map/esriBasemap.ts.)
 */

const COPPER = '#B8734F';
const RED = '#B91C1C';
const CHOCOLATE = '#4A2C2A';

type Geometry = { type: string; coordinates: unknown };

interface DistrictShape { district_id: string; name: string; name_en?: string | null; city?: string; geojson: Geometry }
interface PreviewRow {
  item_id: string; kind: string; polarity: string; direction: string | null; validation_status: string;
  geojson?: Geometry | null; ref_geojson?: Geometry | null;
}

interface Props { items: LocationItemDTO[]; isAr: boolean; height?: number }

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export default function GeoPrefMap({ items, isAr, height = 320 }: Props) {
  const [shapes, setShapes] = useState<DistrictShape[]>([]);
  const [previews, setPreviews] = useState<PreviewRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [map, setMap] = useState<MlMap | null>(null);
  // Place context under the shapes: district outlines + OUR district names, and main
  // roads. On Google this map deliberately kept the basemap's district/road names;
  // the Esri basemap carries no text, so the shared boundary layer supplies the
  // names instead. Called before the shape overlay's effect so it sits underneath.
  useGeoBoundaryLayer(map, { roads: true, landmarks: false, isAr });

  const districtItems = useMemo(() => items.filter((i) => i.kind === 'district' && i.district_id && isUuid(i.district_id)), [items]);
  const elementItems = useMemo(() => items.filter((i) => i.kind === 'element_rule'), [items]);
  // Custom shapes (a district clipped to a road side) carry their own ring — drawn directly.
  const drawnItems = useMemo(() => items.filter((i) => i.kind === 'drawn_area' && Array.isArray(i.coordinates) && i.coordinates.length >= 4), [items]);
  const polarityOfDistrict = useMemo(() => new Map(districtItems.map((i) => [i.district_id!, i.polarity])), [districtItems]);
  const polarityOfItem = useMemo(() => new Map(items.map((i) => [i.id, i.polarity])), [items]);
  const labelOfItem = useMemo(() => new Map(items.map((i) => [i.id, (i.district_label || i.element_label || i.label || '').trim()])), [items]);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    setError(null);
    setLoading(true);
    const ids = districtItems.map((i) => i.district_id!);
    const a = ids.length
      ? supabase.rpc('wassell_district_shapes_by_ids', { p_ids: ids }).then(({ data, error: e }) => {
          if (e) throw new Error(e.message);
          return Array.isArray(data) ? (data as DistrictShape[]) : [];
        })
      : Promise.resolve([] as DistrictShape[]);
    const b = elementItems.length
      ? supabase.rpc('wassell_preview_geo_items', { p_items: elementItems }).then(({ data, error: e }) => {
          if (e) throw new Error(e.message);
          return Array.isArray(data) ? (data as PreviewRow[]) : [];
        })
      : Promise.resolve([] as PreviewRow[]);
    Promise.all([a, b])
      .then(([s, p]) => { if (!cancelled) { setShapes(s); setPreviews(p); } })
      .catch((e: unknown) => {
        // Surface, never hide: a grader that silently shows an empty map would be graded "wrong" for the wrong reason.
        console.error('[GeoPrefMap] shape load failed:', e);
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [districtItems, elementItems]);

  // `paths` drive the pill placement + the fit; `geometry` (when the shape came
  // from the server as GeoJSON) is drawn as-is, so MultiPolygons and holes
  // render exactly as the server compiled them.
  const polygons = useMemo(() => {
    const out: Array<{ key: string; paths: LatLng[][]; geometry: Geometry | null; polarity: string; label: string }> = [];
    for (const s of shapes) {
      const pol = polarityOfDistrict.get(s.district_id) ?? 'include';
      out.push({ key: `d:${s.district_id}`, paths: geojsonToPaths(s.geojson), geometry: s.geojson, polarity: pol, label: isAr ? s.name : (s.name_en || s.name) });
    }
    for (const p of previews) {
      if (!p.geojson) continue;
      const pol = polarityOfItem.get(p.item_id) ?? p.polarity ?? 'include';
      const paths = geojsonToPaths(p.geojson);
      if (paths.length) out.push({ key: `e:${p.item_id}`, paths, geometry: p.geojson, polarity: pol, label: labelOfItem.get(p.item_id) ?? '' });
    }
    for (const d of drawnItems) {
      const ring = (d.coordinates ?? []).map(([lng, lat]) => ({ lat, lng }));
      if (ring.length >= 4) out.push({ key: `a:${d.id}`, paths: [ring], geometry: null, polarity: d.polarity, label: d.label ?? '' });
    }
    return out;
  }, [shapes, previews, drawnItems, polarityOfDistrict, polarityOfItem, labelOfItem, isAr]);

  // One name pill per drawn polygon, at the centre of its outer ring. Few shapes
  // per conversation, so no declutter pass is needed here.
  const labels = useMemo(() => {
    const out: Array<{ key: string; position: LatLng; icon: MapIcon }> = [];
    const seen = new Set<string>(); // the same district can appear twice (two mentions) — one pill
    for (const pg of polygons) {
      const ring = pg.paths[0];
      if (!pg.label || !ring || ring.length === 0) continue;
      const dedupe = `${pg.polarity}:${pg.label}`;
      if (seen.has(dedupe)) continue;
      const b = boundsOf(ring);
      if (!b) continue;
      seen.add(dedupe);
      const c = b.getCenter();
      out.push({ key: `l:${pg.key}`, position: { lat: c.lat, lng: c.lng }, icon: buildPillIcon(pg.label, pg.polarity === 'exclude' ? RED : CHOCOLATE) });
    }
    // Nudge colliding pills apart (two districts split by the same road sit
    // ~1 km from each other): any pill within ~0.012° lat / 0.02° lng of an
    // earlier one is pushed south by one pill-height step per collision.
    for (let i = 1; i < out.length; i += 1) {
      let bumps = 0;
      for (let j = 0; j < i; j += 1) {
        const a = out[i]!.position, b = out[j]!.position;
        if (Math.abs(a.lat - b.lat) < 0.012 && Math.abs(a.lng - b.lng) < 0.02) bumps += 1;
      }
      if (bumps) out[i]!.position = { lat: out[i]!.position.lat - 0.0065 * bumps, lng: out[i]!.position.lng };
    }
    return out;
  }, [polygons]);

  const lines = useMemo(() => {
    const out: Array<{ key: string; path: LatLng[] }> = [];
    for (const p of previews) {
      if (!p.ref_geojson) continue;
      for (const [i, path] of geojsonToLinePaths(p.ref_geojson).entries()) out.push({ key: `l:${p.item_id}:${i}`, path });
    }
    return out;
  }, [previews]);

  // Fit the map to what the customer WANTS (include shapes). An exclude band
  // rides a road that can run far outside the city (King Fahd Road's line is
  // ~40 km), and fitting to it zoomed the map out to the whole region with
  // every pill piled on one spot (live, 2026-09-15). Excludes stay drawn but
  // never drive the zoom; they only do when nothing is included.
  useEffect(() => {
    if (!map) return;
    const pts: LatLng[] = [];
    const includes = polygons.filter((pg) => pg.polarity !== 'exclude');
    for (const pg of includes.length ? includes : polygons) for (const ring of pg.paths) pts.push(...ring);
    if (pts.length === 0) for (const l of lines) pts.push(...l.path);
    const b = boundsOf(pts);
    if (b) fitToBounds(map, b, { padding: 48 });
  }, [map, polygons, lines]);

  // Shapes + road reference lines in ONE display-only overlay (nothing is
  // clickable). Excludes are context: light, thin, and underneath the wanted shapes.
  useEffect(() => {
    if (!map) return;
    const overlay = new GeoJsonOverlay(map, {
      style: (p) => {
        if (p.kind === 'ref') return { strokeColor: CHOCOLATE, strokeOpacity: 0.9, strokeWeight: 3, zIndex: 0 };
        const excl = p.exclude === true;
        return {
          fillColor: excl ? RED : COPPER,
          fillOpacity: excl ? 0.1 : 0.32,
          strokeColor: excl ? RED : CHOCOLATE,
          strokeOpacity: excl ? 0.5 : 0.95,
          strokeWeight: excl ? 1 : 2,
          zIndex: excl ? 1 : 5,
        };
      },
    });
    const features: OverlayFeature[] = [];
    for (const pg of polygons) {
      const props = { kind: 'area', exclude: pg.polarity === 'exclude' };
      features.push(pg.geometry ? geometryFeature(pg.geometry, props) : polygonFeature(pg.paths, props));
    }
    for (const l of lines) if (l.path.length >= 2) features.push(lineFeature(l.path, { kind: 'ref' }));
    overlay.setData(features);
    return () => overlay.remove();
  }, [map, polygons, lines]);

  // Name pills — DOM markers, always above the shapes, never interactive.
  useEffect(() => {
    if (!map) return;
    const markers = labels.map((l) => createIconMarker(map, { position: l.position, icon: l.icon, clickable: false, zIndex: 20 }));
    return () => markers.forEach((m) => m.remove());
  }, [map, labels]);

  const nothingToLoad = districtItems.length === 0 && elementItems.length === 0;
  if (items.length === 0) {
    return <p className="rounded-xl border border-dashed border-sand/40 bg-cream/10 px-4 py-3 text-center text-xs text-charcoal/50">{isAr ? 'لم يضع الذكاء الاصطناعي شيئًا على الخريطة لهذه المحادثة.' : 'The AI placed nothing on the map for this conversation.'}</p>;
  }

  return (
    <div className="relative overflow-hidden rounded-xl border border-sand/40" style={{ height }}>
      <MapCanvas
        isAr={isAr}
        className="h-full w-full"
        center={DEFAULT_MAP_CENTER}
        zoom={11}
        onLoad={setMap}
        onUnmount={() => setMap(null)}
      />
      {loading && <div className="absolute end-2 top-2 rounded-full bg-white/90 px-2 py-1 text-[11px] text-charcoal/60"><Loader2 className="inline animate-spin" size={12} /> {isAr ? 'تحميل الحدود…' : 'loading shapes…'}</div>}
      {error && <div className="absolute inset-x-2 bottom-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{isAr ? `تعذّر تحميل الخريطة: ${error}` : `Map load failed: ${error}`}</div>}
      {!loading && !error && !nothingToLoad && polygons.length === 0 && lines.length === 0 && (
        <div className="absolute inset-x-2 bottom-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{isAr ? 'لا توجد حدود مرسومة لهذه العناصر (لم يُحدَّد حي حقيقي).' : 'No boundaries drawn for these items (no real district was selected).'}</div>
      )}
      <div className="absolute start-2 top-2 flex gap-2 rounded-full bg-white/90 px-2 py-1 text-[11px] text-charcoal/70">
        <span><span className="inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: COPPER }} /> {isAr ? 'يريد' : 'wants'}</span>
        <span><span className="inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: RED }} /> {isAr ? 'لا يريد' : 'excludes'}</span>
      </div>
    </div>
  );
}
