import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { pickVisibleLabels, geometryExtent, type LabelCandidate } from '@/lib/geo/labelDeclutter';
import {
  GeoJsonOverlay, createLabelMarker, getViewport, onViewportChange,
  type MlMap, type OverlayStyle,
} from '@/lib/map';
import type { Marker } from '@/lib/map/maplibre';

/**
 * Draws the administrative context every map was missing: a country / region / city /
 * district outline appropriate to the current zoom, plus main roads and landmark pins.
 *
 * Attach it to any MapLibre map and it manages itself — one debounced RPC per
 * viewport change, with the previous request abandoned when the user keeps panning.
 *
 * THINGS THAT LOOK LIKE STYLE BUT ARE NOT:
 *
 *  1. It refetches on `moveend` (onViewportChange), which MapLibre fires once after
 *     every pan / zoom / fit, programmatic or not. (The Google version had to listen
 *     to `bounds_changed` AND `idle`: idle is a render-completion event that fired
 *     ZERO times on the deployed app under an automated browser.)
 *  2. Its layers are its OWN GeoJsonOverlays, created when the map loads — before any
 *     caller overlay — so they sit underneath as context and never collide with
 *     another surface's features.
 *  3. The zoom sent to the server is the CLASSIC (Google-equivalent) scale via
 *     getViewport: the server decides which tier belongs at which zoom
 *     (`geo_map_tier_for_zoom`) and that table was tuned on Google zooms. Six map
 *     components each guessing would drift apart the first time anyone tuned one.
 */

/** Wassel palette (CLAUDE.md). Deliberately muted — this is context, never the subject. */
const COLORS = {
  country: '#4A2C2A',  // rich chocolate — the heaviest line on screen
  region: '#8E4E3A',   // deep terracotta
  city: '#B8734F',     // copper
  district: '#4A4E54', // charcoal, drawn thin and translucent
  road: '#8E4E3A',
  landmark: '#C09B5F', // subtle gold
};

/**
 * Stroke weight per tier: coarser tiers read as the frame, districts as fine mesh.
 *
 * Tuned UP from the first pass, which used 0.9 px at 45% with a 3% fill for districts.
 * That was invisible against the cream Wassel basemap — over a Riyadh viewport
 * returning 244 boundaries, the outlines could not be picked out from the basemap's
 * own landuse shading. Context should be quiet, but it has to be legible: the whole
 * point is to see which district a pin sits in.
 */
const TIER_STROKE: Record<string, { weight: number; opacity: number; fill: number }> = {
  country: { weight: 2.4, opacity: 0.85, fill: 0.05 },
  region: { weight: 1.8, opacity: 0.8, fill: 0.05 },
  city: { weight: 1.5, opacity: 0.75, fill: 0.06 },
  district: { weight: 1.2, opacity: 0.7, fill: 0.06 },
};

export interface GeoBoundaryLayerState {
  /** Tier currently drawn, so a caller can label it ("الأحياء" / "المدن"). */
  tier: string | null;
  /** True when the viewport held more boundaries than were drawn — surface "zoom in". */
  truncated: boolean;
  /** Never swallowed: a failing layer reports rather than silently drawing nothing. */
  error: string | null;
  loading: boolean;
}

interface Options {
  /** Off by default in callers that need a bare map (print, thumbnails). */
  enabled?: boolean;
  /**
   * Draw the administrative outline. Turned OFF by surfaces that already render
   * boundaries themselves — MarketMap's district choropleth is the whole point of that
   * screen, and drawing ours underneath would double every edge in a second style.
   */
  boundaries?: boolean;
  /** Draw main roads / metro lines (zoom ≥ 9 server-side). */
  roads?: boolean;
  /** Draw landmark pins (zoom ≥ 11 server-side). */
  landmarks?: boolean;
  /**
   * Draw the place NAME on each boundary, decluttered so names never stack.
   * On by default — a boundary you cannot name is decoration.
   */
  labels?: boolean;
  /** Language for the label — Arabic name when true, English otherwise. */
  isAr?: boolean;
  /** Fires when a boundary is clicked — lets a page drill into that district/city. */
  onSelect?: (props: Record<string, unknown>) => void;
}

export function useGeoBoundaryLayer(
  map: MlMap | null,
  { enabled = true, boundaries = true, roads = true, landmarks = true, labels = true, isAr = true, onSelect }: Options = {},
): GeoBoundaryLayerState {
  const [state, setState] = useState<GeoBoundaryLayerState>({
    tier: null, truncated: false, error: null, loading: false,
  });

  const layersRef = useRef<{ bounds: GeoJsonOverlay; roads: GeoJsonOverlay; marks: GeoJsonOverlay } | null>(null);
  /** Name markers for the current viewport, rebuilt per fetch and cleared on unmount. */
  const labelMarkersRef = useRef<Marker[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic request id. A slow response for a viewport the user already left must not
  // repaint the map — panning fires `moveend` far faster than the RPC returns.
  const reqRef = useRef(0);
  // Last viewport actually requested, so a repeated move to the same view is a no-op
  // rather than a repeat download.
  const lastKeyRef = useRef<string | null>(null);
  const onSelectRef = useRef(onSelect);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);

  // ── create / tear down the layers ─────────────────────────────────────────
  useEffect(() => {
    if (!map || !enabled) return;

    const DEFAULT_STROKE = { weight: 0.9, opacity: 0.45, fill: 0.03 };
    const bounds = new GeoJsonOverlay(map, {
      style: (props): OverlayStyle => {
        const tier = String(props.tier ?? 'district');
        const s = TIER_STROKE[tier] ?? DEFAULT_STROKE;
        const color = COLORS[tier as keyof typeof COLORS] ?? COLORS.district;
        return {
          strokeColor: color,
          strokeWeight: s.weight,
          strokeOpacity: s.opacity,
          fillColor: color,
          fillOpacity: s.fill,
          clickable: !!onSelectRef.current,
        };
      },
    });
    const roadLayer = new GeoJsonOverlay(map, {
      style: { strokeColor: COLORS.road, strokeWeight: 1.6, strokeOpacity: 0.5 },
    });
    const markLayer = new GeoJsonOverlay(map, {
      style: {
        pointRadius: 3.2,
        pointColor: COLORS.landmark,
        pointOpacity: 0.95,
        pointStrokeColor: '#FFFFFF',
        pointStrokeWeight: 1,
      },
    });

    const offClick = bounds.on('click', (_hit, props) => {
      onSelectRef.current?.({ ...props });
    });

    layersRef.current = { bounds, roads: roadLayer, marks: markLayer };
    return () => {
      offClick();
      for (const l of [bounds, roadLayer, markLayer]) l.remove();
      for (const m of labelMarkersRef.current) m.remove();
      labelMarkersRef.current = [];
      layersRef.current = null;
    };
  }, [map, enabled]);

  // ── fetch on viewport change ──────────────────────────────────────────────
  useEffect(() => {
    if (!map || !enabled) return;

    const load = async () => {
      const vp = getViewport(map);
      const zoom = vp.zoom;
      if (!supabase) {
        // Offline / unconfigured — say so once rather than leaving a blank map that
        // looks like "there is no geography here".
        setState((s) => (s.error ? s : { ...s, error: 'offline' }));
        return;
      }

      // Skip an identical viewport (a fit that lands where the map already is) —
      // without this the same 200–400 kB response would be re-fetched for no change.
      // Rounded to ~10 m, which is finer than a pixel at max zoom.
      const key = [
        Math.round(zoom),
        vp.minLng.toFixed(4), vp.minLat.toFixed(4),
        vp.maxLng.toFixed(4), vp.maxLat.toFixed(4),
      ].join('|');
      if (key === lastKeyRef.current) return;
      lastKeyRef.current = key;

      const id = ++reqRef.current;
      setState((s) => ({ ...s, loading: true }));

      const { data, error } = await supabase.rpc('geo_map_layers', {
        p_min_lng: vp.minLng, p_min_lat: vp.minLat,
        p_max_lng: vp.maxLng, p_max_lat: vp.maxLat,
        p_zoom: Math.round(zoom),
      });

      if (id !== reqRef.current) return; // a newer viewport already won
      if (error) {
        // Loud, per the repo's silent-failure rule. The map keeps whatever it drew last
        // rather than clearing, so a transient error doesn't blank the context.
        console.error('[geo-boundaries] geo_map_layers failed:', error.message);
        // Clear the guard: a failed viewport must stay retryable, or one transient
        // error would freeze this view's layer for as long as the user stays put.
        lastKeyRef.current = null;
        setState({ tier: null, truncated: false, error: error.message, loading: false });
        return;
      }
      const layers = layersRef.current;
      if (!layers) return;
      const res = (data ?? {}) as Record<string, unknown>;

      // ── place names, decluttered ──────────────────────────────────────────
      //
      // An outline you cannot name is decoration. But naming EVERY outline is what
      // made Dubai unreadable, so the same `pickVisibleLabels` rule the district
      // picker uses decides which ones get drawn: big enough on screen to hold the
      // text, and not already covered by a bigger neighbour's name.
      //
      // Markers are rebuilt per fetch rather than pooled: a viewport change already
      // costs an RPC, the set is small by construction (the decluttering is what
      // makes it small), and pooling would mean tracking identity across tiers that
      // change completely when you cross a zoom band.
      for (const m of labelMarkersRef.current) m.remove();
      labelMarkersRef.current = [];
      if (labels && boundaries) {
        const fc = res.boundaries as { features?: Array<Record<string, unknown>> } | undefined;
        const cands: Array<LabelCandidate & { text: string }> = [];
        for (const f of fc?.features ?? []) {
          const props = (f.properties ?? {}) as Record<string, unknown>;
          const text = String((isAr ? props.name_ar : props.name_en) || props.name_ar || props.name_en || '').trim();
          if (!text) continue;
          const ext = geometryExtent(f.geometry);
          if (!ext) continue;
          cands.push({ id: String(f.id ?? cands.length), text, ...ext });
        }
        const keep = pickVisibleLabels(cands, { zoom: Math.round(zoom), centerLat: vp.center.lat });
        // DOM text labels — the same treatment the picker uses, so the two surfaces
        // render names identically.
        for (const c of cands) {
          if (!keep.has(c.id)) continue;
          labelMarkersRef.current.push(createLabelMarker(map, {
            position: { lat: c.lat, lng: c.lng },
            text: c.text,
            color: COLORS.district,
            zIndex: 4,
          }));
        }
      }

      const asFc = (v: unknown) => (v && typeof v === 'object' ? (v as { features?: unknown[] }) : null);
      layers.bounds.setData(boundaries ? asFc(res.boundaries) : null);
      layers.roads.setData(roads ? asFc(res.roads) : null);
      layers.marks.setData(landmarks ? asFc(res.landmarks) : null);
      setState({
        tier: (res.tier as string) ?? null,
        truncated: !!res.truncated,
        error: null,
        loading: false,
      });
    };

    const schedule = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      // Collapse a burst of moves (a fit + the user's first nudge) into one request.
      timerRef.current = setTimeout(() => { void load(); }, 300);
    };

    // A dep change (e.g. the language toggle) has to repaint the names now, not on
    // the next pan — the identical-viewport guard would otherwise swallow it.
    lastKeyRef.current = null;
    const off = onViewportChange(map, schedule);
    schedule(); // draw immediately on mount rather than waiting for the first pan
    return () => {
      off();
      if (timerRef.current) clearTimeout(timerRef.current);
      // Abandon any in-flight response so it can't paint into an unmounted layer.
      reqRef.current++;
    };
  }, [map, enabled, boundaries, roads, landmarks, labels, isAr]);

  return state;
}
