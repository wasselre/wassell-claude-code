import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/stores/appStore';
import { DEFAULT_MAP_CENTER, buildClusterIcon } from '@/lib/locationUtils';
import {
  ClusteredMarkers, GeoJsonOverlay, MapTooltip, boundsOf, fitToBounds, getZoomLevel, toMapLibreZoom,
  type ClusterItem, type LatLng, type MapIcon, type MlMap, type OverlayProps, type OverlayStyle,
} from '@/lib/map';
import { FullscreenControl } from '@/lib/map/maplibre';
import MapCanvas from '@/components/map/MapCanvas';
import { adminGeoGeoJSON, type GeoListFilters, type GeoFeatureCollection, type GeoFeature } from '@/lib/geo/adminClient';
import { useGeoBoundaryLayer } from '@/components/map/useGeoBoundaryLayer';

const mapContainerStyle = { width: '100%', height: '68vh' };

// Earthy, cream-safe palette harmonized with the Wassel brand (copper / chocolate
// / terracotta / gold / olive / teal). Tuned to stay distinct on the cream
// Wassel-repainted Esri basemap — no neon Tailwind hues. Hero categories anchor on
// brand tokens; the rest are desaturated earth tones from the same family.
const CATEGORY_COLORS: Record<string, string> = {
  roads_major: '#8E4E3A',       // terracotta
  ring_roads: '#4A2C2A',        // chocolate
  metro_lines: '#6B4E8E',       // muted plum
  metro_stations: '#8E72B0',    // light plum (pairs with metro_lines)
  malls: '#B8734F',             // copper (brand primary)
  universities: '#3E6B6E',      // deep teal
  hospitals: '#A33B2A',         // brick
  airports_transport: '#2F5E73',// slate-blue
  parks: '#5C7A3D',             // olive
  landmarks: '#C09B5F',         // gold (brand accent)
  business_zones: '#9A7B2E',    // bronze-olive
  lifestyle: '#C2683A',         // burnt-copper
  zones: '#7A5C8E',             // soft plum (informal corridors)
  islands: '#2E7D6B',           // sea-green — UAE only, where the master-planned
                                // islands (Palm Jumeirah, Yas, Saadiyat, Al Reem,
                                // Al Maryah) are primary anchors, not scenery
};
const catColor = (c: string | null | undefined) => (c && CATEGORY_COLORS[c]) || '#4A4E54';
// Below this confidence an element is faded — captures the 9 informal zones
// (0.35) and any other low-trust anchor. Visual signal for the review workflow.
const LOW_CONF = 0.6;
const isFaded = (conf: number | null | undefined) => typeof conf === 'number' && conf < LOW_CONF;

const SELECT_OUTLINE = '#4A2C2A'; // chocolate — the selected/highlight accent

interface Props {
  filters: GeoListFilters;
  isAr: boolean;
  selected: string | null;
  onSelect: (externalId: string) => void;
}

/**
 * Dedicated map for the geo_elements dataset, on the branded Esri basemap (via
 * MapCanvas) so it matches every other map in the app. Lines (roads/metro) and
 * polygons (zones/malls/parks) render in one GeoJsonOverlay; points
 * (stations/hospitals/landmarks) render as clustered, brand-colored markers.
 * Colored + toggleable by category, hover tooltips, fit-to-bounds on filter
 * change, and a persistent selected-feature highlight (driven by the drawer).
 * Read-only — geometry is never edited here.
 */
export default function GeoElementsMap({ filters, isAr, selected, onSelect }: Props) {
  const language = useAppStore((s) => s.language);
  const addToast = useAppStore((s) => s.addToast);

  const [fc, setFc] = useState<GeoFeatureCollection | null>(null);
  const [loading, setLoading] = useState(false);
  const [map, setMap] = useState<MlMap | null>(null);
  // Boundaries ONLY here. This screen already renders every geo_element itself —
  // roads, metro lines and landmarks included — so letting the shared layer draw them
  // too would paint each one twice, in two different styles.
  useGeoBoundaryLayer(map, { roads: false, landmarks: false });
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const enabledRef = useRef(enabled);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  // Selected feature (from the drawer / a map click) — kept in a ref so the
  // imperative style/marker closures read the live value without re-subscribing.
  const selectedRef = useRef<string | null>(selected);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  const onSelectRef = useRef(onSelect);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);

  // Tooltip language follows the toggle without re-wiring the hover handlers.
  const isArRef = useRef(isAr);
  useEffect(() => { isArRef.current = isAr; }, [isAr]);

  // Imperative map objects (created once per map, in the effect below).
  const overlayRef = useRef<GeoJsonOverlay | null>(null);
  const tipRef = useRef<MapTooltip | null>(null);
  const clustererRef = useRef<ClusteredMarkers | null>(null);

  // Strip pagination — the map loads the whole filtered set (capped server-side).
  const mapFilters = useMemo<GeoListFilters>(() => {
    const { limit: _l, offset: _o, ...rest } = filters; void _l; void _o;
    return { ...rest, limit: 5000 };
  }, [filters]);

  // Fetch the FeatureCollection whenever filters change (debounced).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      adminGeoGeoJSON(mapFilters)
        .then((res) => {
          if (cancelled) return;
          setFc(res);
          const cats = new Set<string>();
          for (const f of res.features) if (f.properties.category) cats.add(f.properties.category);
          setEnabled(cats); // all categories on by default
        })
        .catch((e) => { if (!cancelled) addToast(e instanceof Error ? e.message : 'map load failed', 'error'); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [mapFilters, addToast]);

  // Category counts in the current set (legend).
  const categoryCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of fc?.features ?? []) {
      const c = f.properties.category ?? '∅';
      m.set(c, (m.get(c) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [fc]);

  // ── Map objects: line/polygon overlay, point clusterer, hover tooltip ───────
  // Created once per map. The overlay's style function reads the live
  // enabled/selected refs, so toggles and selection only need `restyle()`.
  useEffect(() => {
    if (!map) return;
    const tip = new MapTooltip(map);
    tipRef.current = tip;

    // Lines (roads/metro) and polygons (zones/malls/parks), styled by category +
    // geometry, honoring enabled + selected.
    const overlay = new GeoJsonOverlay(map, {
      style: (props): OverlayStyle => {
        const cat = (props.category as string | null | undefined) ?? '';
        const gt = (props.geometry_type as string | null | undefined) ?? '';
        const id = (props.external_id as string | null | undefined) ?? '';
        const conf = props.confidence_score as number | null | undefined;
        if (!enabledRef.current.has(cat)) return { visible: false };
        const isSel = id === selectedRef.current;
        const color = isSel ? SELECT_OUTLINE : catColor(cat);
        const faded = isFaded(conf);
        if (gt === 'linestring') {
          return {
            visible: true, clickable: true, strokeColor: color,
            strokeWeight: isSel ? 6 : 3,
            strokeOpacity: faded ? 0.5 : 0.85,
            zIndex: isSel ? 1000 : 100, // lines above polygons
          };
        }
        // polygon
        return {
          visible: true, clickable: true, strokeColor: color,
          strokeWeight: isSel ? 3 : 1.5,
          strokeOpacity: faded ? 0.6 : 0.9,
          fillColor: catColor(cat),
          fillOpacity: faded ? 0.08 : (isSel ? 0.3 : 0.18),
          zIndex: isSel ? 1000 : 10, // polygons under lines
        };
      },
    });
    overlayRef.current = overlay;
    const offClick = overlay.on('click', (_hit, props) => {
      const id = props.external_id;
      if (typeof id === 'string') onSelectRef.current(id);
    });
    const offOver = overlay.on('mouseover', (hit, props) => {
      const p = featurePropsFrom(props);
      if (p) tip.show({ lat: hit.lngLat.lat, lng: hit.lngLat.lng }, tipContent(p, isArRef.current));
    });
    const offOut = overlay.on('mouseout', () => tip.hide());

    // Same Supercluster settings the old MarkerClusterer used. Clusters sit above
    // every point marker, including the enlarged selected one (z 9999).
    const clusterer = new ClusteredMarkers(map, {
      radius: 70,
      maxZoom: 15,
      clusterIcon: (count) => buildClusterIcon(count),
      clusterZIndex: 10000,
    });
    clustererRef.current = clusterer;

    return () => {
      offClick(); offOver(); offOut();
      overlay.remove();
      overlayRef.current = null;
      clusterer.remove();
      clustererRef.current = null;
      tip.hide();
      tipRef.current = null;
    };
  }, [map]);

  // ── Lines + polygons → overlay data ────────────────────────────────────────
  // Replaced on every new fetch; points are drawn by the clusterer instead.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!map || !overlay) return;
    overlay.setData(fc ? fc.features.filter((f) => f.properties.geometry_type !== 'point') : null);
  }, [map, fc]);

  // Re-apply the overlay style whenever enabled or selected changes (the style
  // function reads the live refs).
  useEffect(() => {
    overlayRef.current?.restyle();
  }, [map, enabled, selected]);

  // ── Points → clustered markers ──────────────────────────────────────────────
  // Rebuilt whenever the feature set, the enabled-category set (so a toggled-off
  // category drops out of the clusters) or the selection changes (so only the
  // selected point is enlarged/outlined). Icons are inline SVG — cheap to
  // recreate, no network.
  useEffect(() => {
    const clusterer = clustererRef.current;
    if (!map || !clusterer) return;
    const points = (fc?.features ?? []).filter(
      (f) => f.properties.geometry_type === 'point'
        && f.properties.lat != null && f.properties.lng != null
        && enabled.has(f.properties.category ?? '∅'),
    );
    const items: ClusterItem[] = points.map((f) => {
      const p = f.properties;
      const isSel = p.external_id === selected;
      return {
        id: p.external_id,
        position: { lat: p.lat as number, lng: p.lng as number },
        icon: pointIcon(catColor(p.category), isFaded(p.confidence_score), isSel),
        // Same styled tooltip as lines/polygons, shown from the marker's hover.
        onHover: (on) => {
          const tip = tipRef.current;
          if (!tip) return;
          if (on) tip.show({ lat: p.lat as number, lng: p.lng as number }, tipContent(p, isAr));
          else tip.hide();
        },
        zIndex: isSel ? 9999 : undefined,
        onClick: () => onSelectRef.current(p.external_id),
      };
    });
    clusterer.setItems(items);
  }, [map, fc, enabled, selected, isAr]);

  // ── Pan/zoom to the selected point so it's visible (declusters it) ──────────
  useEffect(() => {
    if (!map || !selected) return;
    const p = fc?.features.find((f) => f.properties.external_id === selected)?.properties;
    if (p && p.lat != null && p.lng != null) {
      // One eased move (pan + zoom in to at least 13, classic scale) — a separate
      // setZoom would cancel the pan animation mid-flight.
      map.easeTo({
        center: [p.lng, p.lat],
        zoom: toMapLibreZoom(Math.max(getZoomLevel(map), 13)),
        duration: 400,
      });
    }
  }, [selected, map, fc]);

  // ── Fit bounds to the filtered set on every new fetch (not on legend toggles) ─
  useEffect(() => {
    if (!map || !fc || fc.features.length === 0) return;
    const pts: LatLng[] = [];
    for (const f of fc.features) {
      const { lat, lng } = f.properties;
      if (lat != null && lng != null) pts.push({ lat, lng });
    }
    const only = pts[0];
    if (!only) return;
    if (pts.length === 1) {
      map.jumpTo({ center: [only.lng, only.lat], zoom: toMapLibreZoom(14) });
      return;
    }
    // maxZoom (classic scale) clamps over-zoom on tight clusters.
    fitToBounds(map, boundsOf(pts), { padding: 48, maxZoom: 15 });
  }, [map, fc]);

  const toggleCat = (c: string) => setEnabled((prev) => {
    const next = new Set(prev);
    if (next.has(c)) next.delete(c); else next.add(c);
    return next;
  });
  const allOn = () => setEnabled(new Set(categoryCounts.map(([c]) => c)));
  const allOff = () => setEnabled(new Set());

  return (
    <div className="card overflow-hidden">
      {/* Legend / layer toggles */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-sand/30 p-2.5">
        <span className="text-xs font-bold text-charcoal/60 me-1">
          {loading ? (isAr ? 'جارٍ التحميل…' : 'Loading…') : `${fc?.count ?? 0} ${isAr ? 'عنصر على الخريطة' : 'on map'}`}
        </span>
        {categoryCounts.map(([c, n]) => {
          const on = enabled.has(c);
          const color = catColor(c);
          return (
            <button key={c} type="button" onClick={() => toggleCat(c)}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold transition ${on ? 'border-transparent text-white' : 'border-sand/50 text-charcoal/40 bg-white'}`}
              style={on ? { backgroundColor: color } : undefined}>
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: on ? '#fff' : color }} />
              {c} ({n})
            </button>
          );
        })}
        {categoryCounts.length > 1 && (
          <span className="ms-1 flex gap-1">
            <button type="button" onClick={allOn} className="text-[11px] font-semibold text-copper hover:underline">{isAr ? 'الكل' : 'all'}</button>
            <span className="text-charcoal/30">/</span>
            <button type="button" onClick={allOff} className="text-[11px] font-semibold text-copper hover:underline">{isAr ? 'لا شيء' : 'none'}</button>
          </span>
        )}
      </div>

      <MapCanvas
        isAr={isAr}
        className="isolate"
        style={mapContainerStyle}
        center={DEFAULT_MAP_CENTER}
        zoom={10}
        onLoad={(m) => {
          m.addControl(new FullscreenControl(), 'top-right');
          setMap(m);
        }}
        onUnmount={() => setMap(null)}
      />
      <p className="px-3 py-1.5 text-[11px] text-charcoal/40 border-t border-sand/20">
        {isAr ? 'مرّر فوق عنصر لاسمه، واضغط لفتح تفاصيله. النقاط مجمّعة؛ الهندسة مبسّطة للعرض فقط.' : 'Hover a feature for its name, click to open details. Points are clustered; geometry is simplified for display.'} · {language}
      </p>
    </div>
  );
}

// A category-colored circle icon for point markers. Selected = larger + chocolate
// outline; low-confidence = faded fill so it reads as approximate. (Same radius /
// stroke / opacity numbers as the old circle symbol; buildDotIcon has no
// fill-opacity, hence the local builder.)
function pointIcon(color: string, faded: boolean, isSel: boolean): MapIcon {
  const r = isSel ? 8 : 5.5;
  const sw = isSel ? 2.5 : 1;
  const stroke = isSel ? SELECT_OUTLINE : '#ffffff';
  const d = Math.ceil((r + sw) * 2);
  const c = d / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}" viewBox="0 0 ${d} ${d}"><circle cx="${c}" cy="${c}" r="${r}" fill="${color}" fill-opacity="${faded ? 0.5 : 0.95}" stroke="${stroke}" stroke-width="${sw}"/></svg>`;
  return { url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`, width: d, height: d, anchor: 'center' };
}

// The tooltip's three lines: name, "category · type", "external_id · conf N".
function tipLines(props: GeoFeature['properties'], isAr: boolean): [string, string, string] {
  const name = (isAr ? props.name_ar : props.name_en) || props.name_en || props.name_ar || props.external_id;
  const sub = [props.category, props.type].filter(Boolean).join(' · ');
  const conf = typeof props.confidence_score === 'number' ? props.confidence_score.toFixed(2) : '—';
  return [String(name), sub, `${props.external_id} · conf ${conf}`];
}

// Hover tooltip body for lines/polygons (shown in the shared MapTooltip).
function tipContent(props: GeoFeature['properties'], isAr: boolean): HTMLElement {
  const [name, sub, meta] = tipLines(props, isAr);
  const el = document.createElement('div');
  el.innerHTML =
    `<div style="font-family:Amiri,'Segoe UI',system-ui,sans-serif;min-width:120px;max-width:240px;padding:2px 4px;color:#4A2C2A">
       <div style="font-weight:700;font-size:13px;line-height:1.3">${escapeHtml(name)}</div>
       <div style="font-size:11px;color:#8E4E3A;margin-top:2px">${escapeHtml(sub)}</div>
       <div style="font-size:10px;color:#4A4E54;opacity:.7;margin-top:1px">${escapeHtml(meta)}</div>
     </div>`;
  return el;
}

// Reconstruct the subset of properties the tooltip needs from an overlay feature.
function featurePropsFrom(props: OverlayProps): GeoFeature['properties'] | null {
  const id = props.external_id;
  if (typeof id !== 'string') return null;
  const g = (k: string) => props[k];
  return {
    external_id: id,
    name_ar: (g('name_ar') as string | null) ?? null,
    name_en: (g('name_en') as string | null) ?? null,
    category: (g('category') as string | null) ?? null,
    type: (g('type') as string | null) ?? null,
    geometry_type: (g('geometry_type') as string | null) ?? null,
    review_status: (g('review_status') as string) ?? '',
    is_active: Boolean(g('is_active')),
    is_searchable: Boolean(g('is_searchable')),
    is_verified: Boolean(g('is_verified')),
    confidence_score: (g('confidence_score') as number | null) ?? null,
    lat: (g('lat') as number | null) ?? null,
    lng: (g('lng') as number | null) ?? null,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
