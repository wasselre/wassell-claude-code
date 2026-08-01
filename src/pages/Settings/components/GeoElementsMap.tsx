import { useEffect, useMemo, useRef, useState } from 'react';
import { GoogleMap, useJsApiLoader } from '@react-google-maps/api';
import { MarkerClusterer, SuperClusterAlgorithm } from '@googlemaps/markerclusterer';
import { Loader2 } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { getMapsLoaderOptions, isMapsKeyConfigured } from '@/lib/mapsLoader';
import { DEFAULT_MAP_CENTER, GEO_MAP_STYLE, buildClusterIcon } from '@/lib/locationUtils';
import { adminGeoGeoJSON, type GeoListFilters, type GeoFeatureCollection, type GeoFeature } from '@/lib/geo/adminClient';
import { useGeoBoundaryLayer } from '@/components/map/useGeoBoundaryLayer';

const mapContainerStyle = { width: '100%', height: '68vh' };

// Earthy, cream-safe palette harmonized with the Wassel brand (copper / chocolate
// / terracotta / gold / olive / teal). Tuned to stay distinct on the cream
// WASSEL_MAP_STYLE basemap — no neon Tailwind hues. Hero categories anchor on
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
 * Dedicated map for the geo_elements dataset, on the branded WASSEL_MAP_STYLE
 * basemap so it matches every other map in the app. Lines (roads/metro) and
 * polygons (zones/malls/parks) render on the Google Maps Data layer; points
 * (stations/hospitals/landmarks) render as clustered, brand-colored markers.
 * Colored + toggleable by category, hover tooltips, fit-to-bounds on filter
 * change, and a persistent selected-feature highlight (driven by the drawer).
 * Read-only — geometry is never edited here.
 */
export default function GeoElementsMap({ filters, isAr, selected, onSelect }: Props) {
  const language = useAppStore((s) => s.language);
  const addToast = useAppStore((s) => s.addToast);
  const { isLoaded, loadError } = useJsApiLoader(getMapsLoaderOptions(isAr ? 'ar' : 'en'));
  const keyMissing = !isMapsKeyConfigured();

  const [fc, setFc] = useState<GeoFeatureCollection | null>(null);
  const [loading, setLoading] = useState(false);
  const [map, setMap] = useState<google.maps.Map | null>(null);
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

  // Imperative map objects.
  const clustererRef = useRef<MarkerClusterer | null>(null);
  const markersRef = useRef<Map<string, google.maps.Marker>>(new Map());
  const infoRef = useRef<google.maps.InfoWindow | null>(null);

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

  // ── Hover tooltip (shared InfoWindow) ──────────────────────────────────────
  const showTip = (props: GeoFeature['properties'], pos: google.maps.LatLngLiteral) => {
    if (!map || !window.google) return;
    if (!infoRef.current) infoRef.current = new google.maps.InfoWindow({ disableAutoPan: true });
    const name = (isAr ? props.name_ar : props.name_en) || props.name_en || props.name_ar || props.external_id;
    const sub = [props.category, props.type].filter(Boolean).join(' · ');
    const conf = typeof props.confidence_score === 'number' ? props.confidence_score.toFixed(2) : '—';
    infoRef.current.setContent(
      `<div style="font-family:Amiri,'Segoe UI',system-ui,sans-serif;min-width:120px;max-width:240px;padding:2px 4px;color:#4A2C2A">
         <div style="font-weight:700;font-size:13px;line-height:1.3">${escapeHtml(String(name))}</div>
         <div style="font-size:11px;color:#8E4E3A;margin-top:2px">${escapeHtml(sub)}</div>
         <div style="font-size:10px;color:#4A4E54;opacity:.7;margin-top:1px">${escapeHtml(props.external_id)} · conf ${conf}</div>
       </div>`,
    );
    infoRef.current.setPosition(pos);
    infoRef.current.open({ map });
  };
  const hideTip = () => infoRef.current?.close();

  // ── Lines + polygons → Data layer ──────────────────────────────────────────
  // Load non-point features into the Data layer (clear previous first) + wire
  // click/hover. Features get their id from `external_id` so we can look them up
  // for the selected-highlight.
  useEffect(() => {
    if (!map || !isLoaded || !fc) return;
    map.data.forEach((f) => map.data.remove(f));
    const linePoly = {
      type: 'FeatureCollection' as const,
      features: fc.features.filter((f) => f.properties.geometry_type !== 'point'),
    };
    try {
      map.data.addGeoJson(linePoly, { idPropertyName: 'external_id' });
    } catch (e) {
      console.error('[geo-map] addGeoJson failed:', e);
    }
    const clickL = map.data.addListener('click', (e: google.maps.Data.MouseEvent) => {
      const id = e.feature.getProperty('external_id');
      if (typeof id === 'string') onSelectRef.current(id);
    });
    const overL = map.data.addListener('mouseover', (e: google.maps.Data.MouseEvent) => {
      const props = featurePropsFrom(e.feature);
      if (props && e.latLng) showTip(props, e.latLng.toJSON());
    });
    const outL = map.data.addListener('mouseout', hideTip);
    return () => {
      google.maps.event.removeListener(clickL);
      google.maps.event.removeListener(overL);
      google.maps.event.removeListener(outL);
    };
    // showTip/hideTip are stable enough (read refs); isAr re-runs to refresh tip language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, isLoaded, fc, isAr]);

  // ── Points → clustered native markers ───────────────────────────────────────
  // Rebuilt whenever the feature set OR the enabled-category set changes (so a
  // toggled-off category drops out of the clusters). Markers are SVG symbols —
  // cheap to recreate, no network.
  useEffect(() => {
    if (!map || !isLoaded || !fc || !window.google) return;
    clustererRef.current?.clearMarkers();
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = new Map();

    const points = fc.features.filter(
      (f) => f.properties.geometry_type === 'point'
        && f.properties.lat != null && f.properties.lng != null
        && enabled.has(f.properties.category ?? '∅'),
    );
    const markers: google.maps.Marker[] = [];
    for (const f of points) {
      const p = f.properties;
      const pos = { lat: p.lat as number, lng: p.lng as number };
      const marker = new google.maps.Marker({
        position: pos,
        icon: pointSymbol(catColor(p.category), isFaded(p.confidence_score), p.external_id === selectedRef.current),
        title: (isAr ? p.name_ar : p.name_en) || p.external_id,
        zIndex: p.external_id === selectedRef.current ? 9999 : undefined,
      });
      marker.addListener('click', () => onSelectRef.current(p.external_id));
      marker.addListener('mouseover', () => showTip(p, pos));
      marker.addListener('mouseout', hideTip);
      markers.push(marker);
      markersRef.current.set(p.external_id, marker);
    }
    if (markers.length > 0) {
      clustererRef.current = new MarkerClusterer({
        map,
        markers,
        algorithm: new SuperClusterAlgorithm({ radius: 70, maxZoom: 15 }),
        renderer: {
          render: ({ count, position }) =>
            new google.maps.Marker({
              position,
              icon: buildClusterIcon(count) as google.maps.Icon | undefined,
              zIndex: Number(google.maps.Marker.MAX_ZINDEX) + count,
            }),
        },
      });
    }
    return () => {
      clustererRef.current?.clearMarkers();
      clustererRef.current = null;
      markersRef.current.forEach((m) => m.setMap(null));
      markersRef.current = new Map();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, isLoaded, fc, enabled, isAr]);

  // ── Style the Data layer by category + geometry, honoring enabled + selected ─
  // Re-applied whenever enabled or selected changes (closures read the live refs).
  useEffect(() => {
    if (!map || !isLoaded) return;
    map.data.setStyle((feature) => {
      const cat = (feature.getProperty('category') as string) ?? '';
      const gt = (feature.getProperty('geometry_type') as string) ?? '';
      const id = (feature.getProperty('external_id') as string) ?? '';
      const conf = feature.getProperty('confidence_score') as number | null;
      if (!enabledRef.current.has(cat)) return { visible: false };
      const isSel = id === selectedRef.current;
      const color = isSel ? SELECT_OUTLINE : catColor(cat);
      const faded = isFaded(conf);
      if (gt === 'linestring') {
        return {
          visible: true, strokeColor: color,
          strokeWeight: isSel ? 6 : 3,
          strokeOpacity: faded ? 0.5 : 0.85,
          zIndex: isSel ? 1000 : 100, // lines above polygons
        };
      }
      // polygon
      return {
        visible: true, strokeColor: color,
        strokeWeight: isSel ? 3 : 1.5,
        strokeOpacity: faded ? 0.6 : 0.9,
        fillColor: catColor(cat),
        fillOpacity: faded ? 0.08 : (isSel ? 0.3 : 0.18),
        zIndex: isSel ? 1000 : 10, // polygons under lines
      };
    });
  }, [map, isLoaded, enabled, selected]);

  // ── Selected highlight for point markers + pan/zoom to selection ────────────
  useEffect(() => {
    if (!map || !isLoaded || !window.google) return;
    // Re-skin every marker so only the selected one is enlarged/outlined.
    const fcFeat = fc?.features ?? [];
    const propsById = new Map(fcFeat.map((f) => [f.properties.external_id, f.properties]));
    markersRef.current.forEach((marker, id) => {
      const p = propsById.get(id);
      const color = p ? catColor(p.category) : '#4A4E54';
      marker.setIcon(pointSymbol(color, isFaded(p?.confidence_score), id === selected) as google.maps.Symbol);
      marker.setZIndex(id === selected ? 9999 : undefined);
    });
    // Pan/zoom to the selected feature so it's visible (declusters a point).
    if (selected) {
      const p = propsById.get(selected);
      if (p && p.lat != null && p.lng != null) {
        map.panTo({ lat: p.lat, lng: p.lng });
        if ((map.getZoom() ?? 0) < 13) map.setZoom(13);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, map, isLoaded, fc]);

  // ── Fit bounds to the filtered set on every new fetch (not on legend toggles) ─
  useEffect(() => {
    if (!map || !isLoaded || !fc || fc.features.length === 0 || !window.google) return;
    const bounds = new google.maps.LatLngBounds();
    let n = 0;
    for (const f of fc.features) {
      const { lat, lng } = f.properties;
      if (lat != null && lng != null) { bounds.extend({ lat, lng }); n++; }
    }
    if (n === 0) return;
    if (n === 1) { map.setCenter(bounds.getCenter()); map.setZoom(14); return; }
    map.fitBounds(bounds, 48);
    // Clamp over-zoom on tight clusters once the fit settles.
    const l = google.maps.event.addListenerOnce(map, 'idle', () => {
      if ((map.getZoom() ?? 0) > 15) map.setZoom(15);
    });
    return () => google.maps.event.removeListener(l);
  }, [map, isLoaded, fc]);

  const toggleCat = (c: string) => setEnabled((prev) => {
    const next = new Set(prev);
    if (next.has(c)) next.delete(c); else next.add(c);
    return next;
  });
  const allOn = () => setEnabled(new Set(categoryCounts.map(([c]) => c)));
  const allOff = () => setEnabled(new Set());

  if (keyMissing) return <div className="card p-6 text-sm text-charcoal/50">{isAr ? 'مفتاح خرائط جوجل غير مهيأ.' : 'Google Maps key not configured.'}</div>;
  if (loadError) return <div className="card p-6 text-sm text-red-600">{String(loadError.message ?? loadError)}</div>;
  if (!isLoaded) return <div className="card flex items-center justify-center py-20 text-charcoal/40"><Loader2 className="animate-spin" /></div>;

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

      <GoogleMap
        mapContainerStyle={mapContainerStyle}
        center={DEFAULT_MAP_CENTER}
        zoom={10}
        options={{ styles: GEO_MAP_STYLE, mapTypeControl: false, streetViewControl: false, fullscreenControl: true, clickableIcons: false }}
        onLoad={(m) => setMap(m)}
        onUnmount={() => { setMap(null); infoRef.current = null; }}
      />
      <p className="px-3 py-1.5 text-[11px] text-charcoal/40 border-t border-sand/20">
        {isAr ? 'مرّر فوق عنصر لاسمه، واضغط لفتح تفاصيله. النقاط مجمّعة؛ الهندسة مبسّطة للعرض فقط.' : 'Hover a feature for its name, click to open details. Points are clustered; geometry is simplified for display.'} · {language}
      </p>
    </div>
  );
}

// A category-colored circle symbol for point markers. Selected = larger + chocolate
// outline; low-confidence = faded fill so it reads as approximate.
function pointSymbol(color: string, faded: boolean, isSel: boolean): google.maps.Symbol {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    scale: isSel ? 8 : 5.5,
    fillColor: color,
    fillOpacity: faded ? 0.5 : 0.95,
    strokeColor: isSel ? SELECT_OUTLINE : '#ffffff',
    strokeWeight: isSel ? 2.5 : 1,
  };
}

// Reconstruct the subset of properties the tooltip needs from a Data-layer feature.
function featurePropsFrom(feature: google.maps.Data.Feature): GeoFeature['properties'] | null {
  const id = feature.getProperty('external_id');
  if (typeof id !== 'string') return null;
  const g = (k: string) => feature.getProperty(k);
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
