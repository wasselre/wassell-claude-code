import { useEffect, useMemo, useState } from 'react';
import { GoogleMap, MarkerF, Polygon, Polyline, useJsApiLoader } from '@react-google-maps/api';
import { Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { getMapsLoaderOptions, isMapsKeyConfigured } from '@/lib/mapsLoader';
import { DEFAULT_MAP_CENTER, WASSEL_MAP_STYLE, buildPillIcon } from '@/lib/locationUtils';
import { geojsonToPaths, geojsonToLinePaths } from '@/lib/geo/geojsonPaths';
import type { LocationItemDTO } from '../lib/shared';

/**
 * Read-only map of what the AI placed for one conversation: the proposal's
 * location items. Districts are drawn from the SAME boundary polygons the
 * Finder verifies against (`wassell_district_shapes_by_ids`); element rules
 * (zones, radii, road sides) go through the real compiler
 * (`wassell_preview_geo_items`). Include = copper, exclude = red. Nothing here
 * is editable and nothing is written.
 *
 * Basemap labels stay ON (WASSEL_MAP_STYLE, not the picker's label-suppressed
 * GEO_MAP_STYLE): a grader reads this like a normal map, with Google's district
 * and road names, and each drawn shape additionally carries its own name pill.
 */

const COPPER = '#B8734F';
const RED = '#B91C1C';
const CHOCOLATE = '#4A2C2A';

/** Wassel basemap + Google's own district (neighborhood) names forced ON — the
 *  grader must read district names like a normal map. Exported because the
 *  City Zones settings page (src/pages/Settings/GeoZonesPage.tsx) needs the
 *  exact same "labels stay on" basemap when an admin curates a zone by hand. */
export const GRADER_MAP_STYLE: google.maps.MapTypeStyle[] = [
  ...WASSEL_MAP_STYLE,
  { featureType: 'administrative.neighborhood', elementType: 'labels.text', stylers: [{ visibility: 'on' }] },
  { featureType: 'administrative.neighborhood', elementType: 'labels.text.fill', stylers: [{ color: '#4A2C2A' }] },
  { featureType: 'administrative.locality', elementType: 'labels.text', stylers: [{ visibility: 'on' }] },
];

interface DistrictShape { district_id: string; name: string; name_en?: string | null; city?: string; geojson: { type: string; coordinates: unknown } }
interface PreviewRow {
  item_id: string; kind: string; polarity: string; direction: string | null; validation_status: string;
  geojson?: { type: string; coordinates: unknown } | null; ref_geojson?: { type: string; coordinates: unknown } | null;
}

interface Props { items: LocationItemDTO[]; isAr: boolean; height?: number }

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export default function GeoPrefMap({ items, isAr, height = 320 }: Props) {
  const { isLoaded } = useJsApiLoader(getMapsLoaderOptions(isAr ? 'ar' : 'en'));
  const [shapes, setShapes] = useState<DistrictShape[]>([]);
  const [previews, setPreviews] = useState<PreviewRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [map, setMap] = useState<google.maps.Map | null>(null);

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

  const polygons = useMemo(() => {
    const out: Array<{ key: string; paths: google.maps.LatLngLiteral[][]; polarity: string; label: string }> = [];
    for (const s of shapes) {
      const pol = polarityOfDistrict.get(s.district_id) ?? 'include';
      out.push({ key: `d:${s.district_id}`, paths: geojsonToPaths(s.geojson), polarity: pol, label: isAr ? s.name : (s.name_en || s.name) });
    }
    for (const p of previews) {
      if (!p.geojson) continue;
      const pol = polarityOfItem.get(p.item_id) ?? p.polarity ?? 'include';
      const paths = geojsonToPaths(p.geojson);
      if (paths.length) out.push({ key: `e:${p.item_id}`, paths, polarity: pol, label: labelOfItem.get(p.item_id) ?? '' });
    }
    for (const d of drawnItems) {
      const ring = (d.coordinates ?? []).map(([lng, lat]) => ({ lat, lng }));
      if (ring.length >= 4) out.push({ key: `a:${d.id}`, paths: [ring], polarity: d.polarity, label: d.label ?? '' });
    }
    return out;
  }, [shapes, previews, drawnItems, polarityOfDistrict, polarityOfItem, labelOfItem, isAr]);

  // One name pill per drawn polygon, at the centre of its outer ring. Few shapes
  // per conversation, so no declutter pass is needed here.
  const labels = useMemo(() => {
    if (!isLoaded) return [] as Array<{ key: string; position: google.maps.LatLngLiteral; icon: google.maps.Icon | undefined }>;
    const out: Array<{ key: string; position: google.maps.LatLngLiteral; icon: google.maps.Icon | undefined }> = [];
    const seen = new Set<string>(); // the same district can appear twice (two mentions) — one pill
    for (const pg of polygons) {
      const ring = pg.paths[0];
      if (!pg.label || !ring || ring.length === 0) continue;
      const dedupe = `${pg.polarity}:${pg.label}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const b = new google.maps.LatLngBounds();
      for (const pt of ring) b.extend(pt);
      const c = b.getCenter();
      out.push({ key: `l:${pg.key}`, position: { lat: c.lat(), lng: c.lng() }, icon: buildPillIcon(pg.label, pg.polarity === 'exclude' ? RED : CHOCOLATE) as google.maps.Icon | undefined });
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
  }, [polygons, isLoaded]);

  const lines = useMemo(() => {
    const out: Array<{ key: string; path: google.maps.LatLngLiteral[] }> = [];
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
    if (!map || !isLoaded) return;
    const b = new google.maps.LatLngBounds();
    let any = false;
    const includes = polygons.filter((pg) => pg.polarity !== 'exclude');
    for (const pg of includes.length ? includes : polygons) for (const ring of pg.paths) for (const pt of ring) { b.extend(pt); any = true; }
    if (!any) for (const l of lines) for (const pt of l.path) { b.extend(pt); any = true; }
    if (any) map.fitBounds(b, 48);
  }, [map, isLoaded, polygons, lines]);

  if (!isMapsKeyConfigured()) {
    return <p className="rounded-xl border border-dashed border-sand/40 px-4 py-3 text-xs text-charcoal/50">{isAr ? 'مفتاح الخرائط غير مضبوط في هذه البيئة.' : 'Maps key is not configured in this environment.'}</p>;
  }
  const nothingToLoad = districtItems.length === 0 && elementItems.length === 0;
  if (items.length === 0) {
    return <p className="rounded-xl border border-dashed border-sand/40 bg-cream/10 px-4 py-3 text-center text-xs text-charcoal/50">{isAr ? 'لم يضع الذكاء الاصطناعي شيئًا على الخريطة لهذه المحادثة.' : 'The AI placed nothing on the map for this conversation.'}</p>;
  }

  return (
    <div className="relative overflow-hidden rounded-xl border border-sand/40" style={{ height }}>
      {isLoaded ? (
        <GoogleMap
          mapContainerStyle={{ width: '100%', height: '100%' }}
          center={DEFAULT_MAP_CENTER}
          zoom={11}
          onLoad={setMap}
          options={{ styles: GRADER_MAP_STYLE, disableDefaultUI: true, zoomControl: true, gestureHandling: 'greedy', clickableIcons: false }}
        >
          {polygons.map((pg) => (
            <Polygon
              key={pg.key}
              paths={pg.paths}
              options={{
                // Excludes are context: light, thin, and underneath the wanted shapes.
                fillColor: pg.polarity === 'exclude' ? RED : COPPER,
                fillOpacity: pg.polarity === 'exclude' ? 0.1 : 0.32,
                strokeColor: pg.polarity === 'exclude' ? RED : CHOCOLATE,
                strokeOpacity: pg.polarity === 'exclude' ? 0.5 : 0.95,
                strokeWeight: pg.polarity === 'exclude' ? 1 : 2,
                zIndex: pg.polarity === 'exclude' ? 1 : 5,
                clickable: false,
              }}
            />
          ))}
          {lines.map((l) => (
            <Polyline key={l.key} path={l.path} options={{ strokeColor: CHOCOLATE, strokeOpacity: 0.9, strokeWeight: 3, clickable: false }} />
          ))}
          {labels.map((l) => (
            <MarkerF key={l.key} position={l.position} icon={l.icon} clickable={false} zIndex={20} />
          ))}
        </GoogleMap>
      ) : (
        <div className="flex h-full items-center justify-center"><Loader2 className="animate-spin text-copper" size={22} /></div>
      )}
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
