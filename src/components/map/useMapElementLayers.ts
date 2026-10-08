import { useEffect, useMemo, useRef, useState } from 'react';
import { buildClusterIcon, buildDotIcon } from '@/lib/locationUtils';
import {
  fetchMapElementLayers, CATEGORY_COLOR, type GeoElementFeature,
} from '@/lib/geo/mapLayers';
import {
  ClusteredMarkers, GeoJsonOverlay, getViewport, onViewportChange,
  type ClusterItem, type MlMap,
} from '@/lib/map';

/**
 * Draws the OPTIONAL context layers a user switches on from the map layer control
 * (main streets, metro, malls, parks, hospitals, universities, landmarks).
 *
 * Attach to any MapLibre map; pass the flat list of geo_elements categories that
 * are currently switched on. It manages itself — one debounced RPC per viewport
 * change (`moveend`), the previous request abandoned when the user keeps panning
 * — the same machinery as useGeoBoundaryLayer. When no categories are active it
 * clears everything and makes no request.
 *
 * Lines (roads / metro lines) render on their own GeoJsonOverlay, coloured per
 * category. Points (malls / parks / … / metro stations) render as small coloured
 * dots, clustered so a dense viewport stays legible.
 */

export interface MapElementLayersState {
  loading: boolean;
  error: string | null;
  /** Counts actually drawn, for an optional "showing N" hint. */
  lines: number;
  points: number;
}

/** Amenity clusters are purple so they never read as property-pin clusters. */
const CLUSTER_COLOR = '#8E72B0';

export function useMapElementLayers(
  map: MlMap | null,
  activeCategories: string[],
  isAr: boolean,
): MapElementLayersState {
  const [state, setState] = useState<MapElementLayersState>({ loading: false, error: null, lines: 0, points: 0 });

  const lineLayerRef = useRef<GeoJsonOverlay | null>(null);
  const clusterRef = useRef<ClusteredMarkers | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqRef = useRef(0);
  const lastKeyRef = useRef<string | null>(null);

  // Stable, order-independent key of the active category set so the effect below
  // re-subscribes only when the SET changes, not on every render.
  const catKey = useMemo(() => [...activeCategories].sort().join(','), [activeCategories]);

  // ── create / tear down the layers ──────────────────────────────────────────
  useEffect(() => {
    if (!map) return;
    const lines = new GeoJsonOverlay(map, {
      style: (p) => {
        const cat = String(p.category ?? '');
        // Ring roads read as the heaviest frame; metro a touch thinner than streets.
        const weight = cat === 'ring_roads' ? 3 : cat === 'metro_lines' ? 2 : 2.4;
        return { strokeColor: CATEGORY_COLOR[cat] ?? '#8E4E3A', strokeWeight: weight, strokeOpacity: 0.85 };
      },
    });
    // Points cluster up to classic z16 — denser than property pins, so they
    // stay grouped one level longer.
    const clusters = new ClusteredMarkers(map, {
      radius: 60,
      maxZoom: 16,
      clusterIcon: (n) => buildClusterIcon(n, CLUSTER_COLOR),
      clusterZIndex: 1, // below property pins and their clusters
    });
    lineLayerRef.current = lines;
    clusterRef.current = clusters;
    return () => {
      lines.remove();
      clusters.remove();
      lineLayerRef.current = null;
      clusterRef.current = null;
    };
  }, [map]);

  // ── fetch + draw on viewport / category change ─────────────────────────────
  useEffect(() => {
    if (!map) return;

    const clearAll = () => {
      lineLayerRef.current?.setData(null);
      clusterRef.current?.setItems([]);
    };

    const load = async () => {
      if (activeCategories.length === 0) {
        clearAll();
        lastKeyRef.current = null;
        setState({ loading: false, error: null, lines: 0, points: 0 });
        return;
      }

      const vp = getViewport(map);
      // Skip an identical (viewport + category-set) request — same rounding as the
      // boundary layer (~10 m, finer than a pixel at max zoom).
      const key = [
        catKey, Math.round(vp.zoom),
        vp.minLng.toFixed(4), vp.minLat.toFixed(4), vp.maxLng.toFixed(4), vp.maxLat.toFixed(4),
      ].join('|');
      if (key === lastKeyRef.current) return;
      lastKeyRef.current = key;

      const id = ++reqRef.current;
      setState((s) => ({ ...s, loading: true }));

      let res;
      try {
        res = await fetchMapElementLayers(
          { minLng: vp.minLng, minLat: vp.minLat, maxLng: vp.maxLng, maxLat: vp.maxLat },
          Math.round(vp.zoom), activeCategories,
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

      lineLayerRef.current?.setData(res.lines);

      // points → coloured dots, clustered
      const items: ClusterItem[] = [];
      for (const f of res.points.features as GeoElementFeature[]) {
        const coords = (f.geometry?.coordinates ?? null) as [number, number] | null;
        if (!coords || coords.length < 2) continue;
        const [lng, lat] = coords;
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const cat = f.properties.category;
        const title = (isAr ? f.properties.name_ar : f.properties.name_en) || f.properties.name_ar || f.properties.name_en || '';
        items.push({
          id: `${cat}:${items.length}:${lat.toFixed(6)},${lng.toFixed(6)}`,
          position: { lat, lng },
          icon: buildDotIcon(CATEGORY_COLOR[cat] ?? '#C09B5F', 5, '#FFFFFF', 1.4),
          title: title || undefined,
          zIndex: 1, // below property pins
        });
      }
      clusterRef.current?.setItems(items);

      setState({ loading: false, error: null, lines: res.lines.features.length, points: items.length });
    };

    const schedule = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => { void load(); }, 300);
    };

    // A category-set change must repaint now, not on the next pan.
    lastKeyRef.current = null;
    const off = onViewportChange(map, schedule);
    schedule();
    return () => {
      off();
      if (timerRef.current) clearTimeout(timerRef.current);
      reqRef.current++; // abandon any in-flight response
    };
  }, [map, catKey, isAr, activeCategories]);

  return state;
}
