import { useEffect, useMemo, useRef, useState } from 'react';
import { MarkerClusterer, SuperClusterAlgorithm } from '@googlemaps/markerclusterer';
import { buildClusterIcon } from '@/lib/locationUtils';
import {
  fetchMapElementLayers, CATEGORY_COLOR, type GeoElementFeature,
} from '@/lib/geo/mapLayers';

/**
 * Draws the OPTIONAL context layers a user switches on from the map layer control
 * (main streets, metro, malls, parks, hospitals, universities, landmarks).
 *
 * Attach to any `google.maps.Map`; pass the flat list of geo_elements categories
 * that are currently switched on. It manages itself — one debounced RPC per
 * viewport change, the previous request abandoned when the user keeps panning —
 * the same machinery as useGeoBoundaryLayer (bounds_changed is the load-bearing
 * event; idle does not fire in every environment). When no categories are active
 * it clears everything and makes no request.
 *
 * Lines (roads / metro lines) render on their own google.maps.Data layer, coloured
 * per category. Points (malls / parks / … / metro stations) render as small
 * coloured dots, clustered so a dense viewport stays legible.
 */

export interface MapElementLayersState {
  loading: boolean;
  error: string | null;
  /** Counts actually drawn, for an optional "showing N" hint. */
  lines: number;
  points: number;
}

/** Small coloured dot marker icon, cached per colour. Deliberately smaller than a
 *  property pin so amenity context never competes with the records themselves. */
const dotCache = new Map<string, google.maps.Symbol>();
function dotIcon(color: string): google.maps.Symbol {
  let s = dotCache.get(color);
  if (!s) {
    s = {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 5,
      fillColor: color,
      fillOpacity: 0.95,
      strokeColor: '#FFFFFF',
      strokeWeight: 1.4,
    };
    dotCache.set(color, s);
  }
  return s;
}

export function useMapElementLayers(
  map: google.maps.Map | null,
  activeCategories: string[],
  isAr: boolean,
): MapElementLayersState {
  const [state, setState] = useState<MapElementLayersState>({ loading: false, error: null, lines: 0, points: 0 });

  const lineLayerRef = useRef<google.maps.Data | null>(null);
  const markersRef = useRef<google.maps.Marker[]>([]);
  const clustererRef = useRef<MarkerClusterer | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqRef = useRef(0);
  const lastKeyRef = useRef<string | null>(null);

  // Stable, order-independent key of the active category set so the effect below
  // re-subscribes only when the SET changes, not on every render.
  const catKey = useMemo(() => [...activeCategories].sort().join(','), [activeCategories]);

  // ── create / tear down the line layer ──────────────────────────────────────
  useEffect(() => {
    if (!map || typeof google === 'undefined') return;
    const lines = new google.maps.Data({ map });
    lines.setStyle((feature) => {
      const cat = String(feature.getProperty('category') ?? '');
      const color = CATEGORY_COLOR[cat] ?? '#8E4E3A';
      // Ring roads read as the heaviest frame; metro a touch thinner than streets.
      const weight = cat === 'ring_roads' ? 3 : cat === 'metro_lines' ? 2 : 2.4;
      return { strokeColor: color, strokeWeight: weight, strokeOpacity: 0.85, clickable: false, zIndex: 2 };
    });
    lineLayerRef.current = lines;
    return () => {
      lines.setMap(null);
      lineLayerRef.current = null;
    };
  }, [map]);

  // ── fetch + draw on viewport / category change ─────────────────────────────
  useEffect(() => {
    if (!map || typeof google === 'undefined') return;

    const clearAll = () => {
      const l = lineLayerRef.current;
      if (l) l.forEach((f) => l.remove(f));
      if (clustererRef.current) { clustererRef.current.clearMarkers(); clustererRef.current.setMap(null); clustererRef.current = null; }
      for (const m of markersRef.current) m.setMap(null);
      markersRef.current = [];
    };

    const load = async () => {
      const b = map.getBounds();
      const zoom = map.getZoom();
      if (!b || typeof zoom !== 'number') return;

      if (activeCategories.length === 0) {
        clearAll();
        lastKeyRef.current = null;
        setState({ loading: false, error: null, lines: 0, points: 0 });
        return;
      }

      const sw = b.getSouthWest();
      const ne = b.getNorthEast();
      // Skip an identical (viewport + category-set) request — same rounding as the
      // boundary layer (~10 m, finer than a pixel at max zoom).
      const key = [
        catKey, Math.round(zoom),
        sw.lng().toFixed(4), sw.lat().toFixed(4), ne.lng().toFixed(4), ne.lat().toFixed(4),
      ].join('|');
      if (key === lastKeyRef.current) return;
      lastKeyRef.current = key;

      const id = ++reqRef.current;
      setState((s) => ({ ...s, loading: true }));

      let res;
      try {
        res = await fetchMapElementLayers(
          { minLng: sw.lng(), minLat: sw.lat(), maxLng: ne.lng(), maxLat: ne.lat() },
          Math.round(zoom), activeCategories,
        );
      } catch (e) {
        if (id !== reqRef.current) return;
        // Loud, per the repo's silent-failure rule; keep whatever was drawn last.
        console.error('[map-layers] geo_map_elements failed:', e instanceof Error ? e.message : e);
        lastKeyRef.current = null; // a failed viewport stays retryable
        setState({ loading: false, error: e instanceof Error ? e.message : String(e), lines: 0, points: 0 });
        return;
      }
      if (id !== reqRef.current) return; // a newer viewport already won

      // lines
      const lineLayer = lineLayerRef.current;
      if (lineLayer) {
        lineLayer.forEach((f) => lineLayer.remove(f));
        if (res.lines.features.length) lineLayer.addGeoJson(res.lines);
      }

      // points → coloured dots, clustered
      for (const m of markersRef.current) m.setMap(null);
      markersRef.current = [];
      if (clustererRef.current) { clustererRef.current.clearMarkers(); clustererRef.current.setMap(null); clustererRef.current = null; }

      const feats = res.points.features as GeoElementFeature[];
      const markers: google.maps.Marker[] = [];
      for (const f of feats) {
        const coords = (f.geometry?.coordinates ?? null) as [number, number] | null;
        if (!coords || coords.length < 2) continue;
        const [lng, lat] = coords;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const cat = f.properties.category;
        const title = (isAr ? f.properties.name_ar : f.properties.name_en) || f.properties.name_ar || f.properties.name_en || '';
        markers.push(new google.maps.Marker({
          position: { lat, lng },
          icon: dotIcon(CATEGORY_COLOR[cat] ?? '#C09B5F'),
          title: title || undefined,
          zIndex: 1, // below property pins
          optimized: true,
        }));
      }
      markersRef.current = markers;
      if (markers.length) {
        clustererRef.current = new MarkerClusterer({
          map,
          markers,
          algorithm: new SuperClusterAlgorithm({ radius: 60, maxZoom: 16 }),
          renderer: { render: ({ count, position }) => new google.maps.Marker({
            position, icon: buildClusterIcon(count, '#8E72B0') as google.maps.Icon, zIndex: 1,
          }) },
        });
      }

      setState({ loading: false, error: null, lines: res.lines.features.length, points: markers.length });
    };

    const schedule = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => { void load(); }, 300);
    };

    // A category-set change must repaint now, not on the next pan.
    lastKeyRef.current = null;
    const listeners = [
      map.addListener('bounds_changed', schedule),
      map.addListener('idle', schedule),
    ];
    schedule();
    return () => {
      for (const l of listeners) l.remove();
      if (timerRef.current) clearTimeout(timerRef.current);
      reqRef.current++; // abandon any in-flight response
    };
  }, [map, catKey, isAr, activeCategories]);

  // Full teardown on unmount.
  useEffect(() => () => {
    if (clustererRef.current) { clustererRef.current.clearMarkers(); clustererRef.current.setMap(null); }
    for (const m of markersRef.current) m.setMap(null);
    markersRef.current = [];
  }, []);

  return state;
}
