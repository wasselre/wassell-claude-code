import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';

/**
 * Draws the administrative context every map was missing: a country / region / city /
 * district outline appropriate to the current zoom, plus main roads and landmark pins.
 *
 * Attach it to any `google.maps.Map` and it manages itself — one RPC per viewport on
 * `idle`, debounced, with the previous request abandoned when the user keeps panning.
 *
 * TWO THINGS THAT LOOK LIKE STYLE BUT ARE NOT:
 *
 *  1. It creates its OWN `google.maps.Data` layers rather than using `map.data`.
 *     GeoElementsMap calls `map.data.addGeoJson` and DistrictMapPicker keeps its own
 *     casing/core layers there; sharing `map.data` would have this layer's features
 *     collide with, restyle, and clear theirs.
 *  2. The server decides which tier belongs at which zoom (`geo_map_tier_for_zoom`).
 *     Six map components each guessing would drift apart the first time anyone tuned
 *     one of them.
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

/** Stroke weight per tier: coarser tiers read as the frame, districts as fine mesh. */
const TIER_STROKE: Record<string, { weight: number; opacity: number; fill: number }> = {
  country: { weight: 2.2, opacity: 0.75, fill: 0.04 },
  region: { weight: 1.6, opacity: 0.65, fill: 0.04 },
  city: { weight: 1.3, opacity: 0.6, fill: 0.05 },
  district: { weight: 0.9, opacity: 0.45, fill: 0.03 },
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
  /** Fires when a boundary is clicked — lets a page drill into that district/city. */
  onSelect?: (props: Record<string, unknown>) => void;
}

export function useGeoBoundaryLayer(
  map: google.maps.Map | null,
  { enabled = true, boundaries = true, roads = true, landmarks = true, onSelect }: Options = {},
): GeoBoundaryLayerState {
  const [state, setState] = useState<GeoBoundaryLayerState>({
    tier: null, truncated: false, error: null, loading: false,
  });

  const layersRef = useRef<{ bounds: google.maps.Data; roads: google.maps.Data; marks: google.maps.Data } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic request id. A slow response for a viewport the user already left must not
  // repaint the map — panning fires `idle` far faster than the RPC returns.
  const reqRef = useRef(0);
  const onSelectRef = useRef(onSelect);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);

  // ── create / tear down the layers ─────────────────────────────────────────
  useEffect(() => {
    if (!map || !enabled || typeof google === 'undefined') return;

    const bounds = new google.maps.Data({ map });
    const roadLayer = new google.maps.Data({ map });
    const markLayer = new google.maps.Data({ map });

    const DEFAULT_STROKE = { weight: 0.9, opacity: 0.45, fill: 0.03 };
    bounds.setStyle((feature) => {
      const tier = String(feature.getProperty('tier') ?? 'district');
      const s = TIER_STROKE[tier] ?? DEFAULT_STROKE;
      const color = COLORS[tier as keyof typeof COLORS] ?? COLORS.district;
      return {
        strokeColor: color,
        strokeWeight: s.weight,
        strokeOpacity: s.opacity,
        fillColor: color,
        fillOpacity: s.fill,
        clickable: !!onSelectRef.current,
        zIndex: 1,
      };
    });
    roadLayer.setStyle({ strokeColor: COLORS.road, strokeWeight: 1.6, strokeOpacity: 0.5, clickable: false, zIndex: 2 });
    markLayer.setStyle({
      clickable: false,
      zIndex: 3,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 3.2,
        fillColor: COLORS.landmark,
        fillOpacity: 0.95,
        strokeColor: '#FFFFFF',
        strokeWeight: 1,
      },
    });

    if (onSelectRef.current) {
      bounds.addListener('click', (e: google.maps.Data.MouseEvent) => {
        const props: Record<string, unknown> = {};
        e.feature.forEachProperty((v, k) => { props[k] = v; });
        onSelectRef.current?.(props);
      });
    }

    layersRef.current = { bounds, roads: roadLayer, marks: markLayer };
    return () => {
      for (const l of [bounds, roadLayer, markLayer]) { l.setMap(null); }
      layersRef.current = null;
    };
  }, [map, enabled]);

  // ── fetch on idle ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!map || !enabled || typeof google === 'undefined') return;

    const replace = (layer: google.maps.Data, fc: unknown) => {
      layer.forEach((f) => layer.remove(f));
      if (fc && typeof fc === 'object') layer.addGeoJson(fc as object);
    };

    const load = async () => {
      const b = map.getBounds();
      const zoom = map.getZoom();
      if (!b || typeof zoom !== 'number') return;
      if (!supabase) {
        // Offline / unconfigured — say so once rather than leaving a blank map that
        // looks like "there is no geography here".
        setState((s) => (s.error ? s : { ...s, error: 'offline' }));
        return;
      }
      const sw = b.getSouthWest();
      const ne = b.getNorthEast();
      const id = ++reqRef.current;
      setState((s) => ({ ...s, loading: true }));

      const { data, error } = await supabase.rpc('geo_map_layers', {
        p_min_lng: sw.lng(), p_min_lat: sw.lat(),
        p_max_lng: ne.lng(), p_max_lat: ne.lat(),
        p_zoom: Math.round(zoom),
      });

      if (id !== reqRef.current) return; // a newer viewport already won
      if (error) {
        // Loud, per the repo's silent-failure rule. The map keeps whatever it drew last
        // rather than clearing, so a transient error doesn't blank the context.
        console.error('[geo-boundaries] geo_map_layers failed:', error.message);
        setState({ tier: null, truncated: false, error: error.message, loading: false });
        return;
      }
      const layers = layersRef.current;
      if (!layers) return;
      const res = (data ?? {}) as Record<string, unknown>;
      replace(layers.bounds, boundaries ? res.boundaries : null);
      replace(layers.roads, roads ? res.roads : null);
      replace(layers.marks, landmarks ? res.landmarks : null);
      setState({
        tier: (res.tier as string) ?? null,
        truncated: !!res.truncated,
        error: null,
        loading: false,
      });
    };

    const schedule = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      // `idle` still fires repeatedly during a flick-pan; 250 ms collapses a gesture
      // into one request.
      timerRef.current = setTimeout(() => { void load(); }, 250);
    };

    const listener = map.addListener('idle', schedule);
    schedule(); // draw immediately on mount rather than waiting for the first pan
    return () => {
      listener.remove();
      if (timerRef.current) clearTimeout(timerRef.current);
      // Abandon any in-flight response so it can't paint into an unmounted layer.
      reqRef.current++;
    };
  }, [map, enabled, boundaries, roads, landmarks]);

  return state;
}
