import { LngLatBounds, type Map as MlMap } from '@/lib/map/maplibre';

/**
 * Coordinate + zoom + bounds helpers for every MapLibre map in the app.
 *
 * ZOOM CONVENTION — READ BEFORE TOUCHING ANY ZOOM NUMBER
 *   MapLibre's zoom is one level LOWER than the classic 256-px web-map zoom that
 *   Google Maps (and this app, for years) used: MapLibre z10 shows the same
 *   ground as Google z11. Everything that was tuned against the classic scale —
 *   the server's `geo_map_tier_for_zoom` / `geo_map_layers(p_zoom)` /
 *   `geo_map_elements` zoom gates, `pickVisibleLabels` (256-px world maths),
 *   LABELS_MIN_ZOOM-style thresholds, fit max-zooms — keeps its numbers.
 *   So app code NEVER calls `map.getZoom()` / `map.setZoom()` directly: it goes
 *   through {@link getZoomLevel} / {@link setZoomLevel} / {@link fitToBounds},
 *   which speak the classic scale, and MapCanvas's `zoom` prop is classic too.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** MapLibre zoom = classic zoom − 1 (512-px vs 256-px world at z0). */
export const ZOOM_OFFSET = 1;

export const toMapLibreZoom = (classic: number) => classic - ZOOM_OFFSET;
export const toClassicZoom = (ml: number) => ml + ZOOM_OFFSET;

/** Current zoom on the CLASSIC (Google-equivalent) scale. */
export function getZoomLevel(map: MlMap): number {
  return toClassicZoom(map.getZoom());
}

/** Set zoom on the CLASSIC scale. */
export function setZoomLevel(map: MlMap, classic: number): void {
  map.setZoom(toMapLibreZoom(classic));
}

export const toLngLat = (p: LatLng): [number, number] => [p.lng, p.lat];

/** Bounds covering every point, or null when there are none. */
export function boundsOf(points: Iterable<LatLng>): LngLatBounds | null {
  let b: LngLatBounds | null = null;
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    if (!b) b = new LngLatBounds([p.lng, p.lat], [p.lng, p.lat]);
    else b.extend([p.lng, p.lat]);
  }
  return b;
}

/** Extend (or start) a bounds with one point. */
export function extendBounds(b: LngLatBounds | null, p: LatLng): LngLatBounds {
  if (!b) return new LngLatBounds([p.lng, p.lat], [p.lng, p.lat]);
  return b.extend([p.lng, p.lat]);
}

/** Union of two possibly-null bounds. */
export function unionBounds(a: LngLatBounds | null, b: LngLatBounds | null): LngLatBounds | null {
  if (!a) return b;
  if (!b) return a;
  return new LngLatBounds(a.getSouthWest(), a.getNorthEast()).extend(b);
}

/**
 * Frame the map on `bounds` (Google's `fitBounds(bounds, padding)`).
 * `maxZoom` is CLASSIC scale — a single point / tiny area never zooms past it.
 * `animate: false` jumps (used on first framing so the view doesn't fly in).
 */
export function fitToBounds(
  map: MlMap,
  bounds: LngLatBounds | null,
  opts: { padding?: number; maxZoom?: number; animate?: boolean } = {},
): void {
  if (!bounds) return;
  const { padding = 48, maxZoom = 18, animate = true } = opts;
  // A padding larger than the container makes fitBounds a no-op with a console
  // warning; clamp it so tiny maps (cards, modals mid-open) still frame.
  const c = map.getContainer();
  const maxPad = Math.max(0, Math.floor(Math.min(c.clientWidth, c.clientHeight) / 2) - 8);
  map.fitBounds(bounds, {
    padding: Math.min(padding, maxPad),
    maxZoom: toMapLibreZoom(maxZoom),
    animate,
    duration: animate ? 500 : 0,
  });
}

/** Pan to a point (Google `panTo`). */
export function panTo(map: MlMap, p: LatLng): void {
  map.easeTo({ center: toLngLat(p), duration: 400 });
}

/** The visible box, for viewport-scoped RPCs. Zoom is CLASSIC scale. */
export interface Viewport {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
  zoom: number;
  center: LatLng;
}
export function getViewport(map: MlMap): Viewport {
  const b = map.getBounds();
  const c = map.getCenter();
  return {
    minLng: b.getWest(),
    minLat: b.getSouth(),
    maxLng: b.getEast(),
    maxLat: b.getNorth(),
    zoom: getZoomLevel(map),
    center: { lat: c.lat, lng: c.lng },
  };
}

/**
 * Subscribe to "the viewport changed" — the MapLibre replacement for Google's
 * `bounds_changed` + `idle` pair. `moveend` fires once after every pan / zoom /
 * fit (programmatic or user), so callers still debounce but no longer need the
 * two-event dance the Google maps needed. Returns an unsubscribe.
 */
export function onViewportChange(map: MlMap, cb: () => void): () => void {
  map.on('moveend', cb);
  return () => { map.off('moveend', cb); };
}
