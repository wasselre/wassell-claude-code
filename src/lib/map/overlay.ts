import type {
  Map as MlMap, GeoJSONSource, ExpressionSpecification, LngLatBounds as LngLatBoundsT,
} from '@/lib/map/maplibre';
import { LngLatBounds } from '@/lib/map/maplibre';
import { interactionsFor, isMapRemoved, type InteractiveOverlay, type OverlayHit, type PointerEventType } from '@/lib/map/interactions';
import type { LatLng } from '@/lib/map/geo';

/**
 * GeoJsonOverlay — the MapLibre stand-in for `google.maps.Data`,
 * `google.maps.Polygon`, `google.maps.Polyline` and symbol-circle markers.
 *
 * One overlay = one GeoJSON source + a fill, a line and a circle layer. Every
 * feature is styled by a plain object (or a function of the feature's
 * properties), exactly like `Data.setStyle`:
 *
 *   const o = new GeoJsonOverlay(map, { style: (p) => ({ strokeColor: p.color, strokeWeight: 2 }) });
 *   o.setData(featureCollection);
 *   o.on('click', (hit, props) => …);
 *   …
 *   o.remove();
 *
 * Paint is data-driven from per-feature computed properties, so restyling a
 * selection is `o.restyle()` (re-runs the style function) — no layer churn.
 *
 * Z-ORDER: overlays stack in creation order (newest on top); inside one overlay
 * `zIndex` orders features. Call `moveToTop()` to lift an existing overlay.
 * DOM markers (pins, labels) always sit above every overlay — same as Google.
 *
 * POINTER EVENTS go through the shared dispatcher (interactions.ts): only the
 * topmost CLICKABLE feature receives an event, and a click that lands on one is
 * not delivered to `onEmptyMapClick` handlers. `clickable` defaults to false.
 */

export interface OverlayStyle {
  /** Polygon fill. `fillOpacity` 0 (default when no fillColor) = outline only. */
  fillColor?: string;
  fillOpacity?: number;
  /** Polygon outline AND line colour/width. `strokeWeight` 0 hides the stroke. */
  strokeColor?: string;
  strokeOpacity?: number;
  strokeWeight?: number;
  /** Points render as circles (Google's SymbolPath.CIRCLE). Radius in px. */
  pointRadius?: number;
  pointColor?: string;
  pointOpacity?: number;
  pointStrokeColor?: string;
  pointStrokeWeight?: number;
  /** false = feature not drawn at all. */
  visible?: boolean;
  /** Receives pointer events (click / hover / right-click). Default false. */
  clickable?: boolean;
  /** Stacking within this overlay (higher = on top). */
  zIndex?: number;
}

export type OverlayProps = Record<string, unknown>;
export type StyleFn = (props: OverlayProps, index: number) => OverlayStyle;

export interface OverlayFeature {
  type: 'Feature';
  geometry: { type: string; coordinates: unknown } | null;
  properties?: OverlayProps | null;
  id?: string | number;
}

export interface OverlayOptions {
  style?: OverlayStyle | StyleFn;
  /** Constant dash pattern for every line in this overlay (in line-width units). */
  dash?: number[];
  /** Line end cap. Default 'round'; use 'butt' for dash patterns with 0-length dashes
   *  (round caps draw those as dots). */
  lineCap?: 'round' | 'butt' | 'square';
  /** Insert the overlay's layers below this layer id (default: on top). */
  beforeId?: string;
}

export type OverlayHandler = (hit: OverlayHit, props: OverlayProps) => void;

let seq = 0;

const POLY: ExpressionSpecification = ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]];
const LINEISH: ExpressionSpecification = [
  'in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon', 'LineString', 'MultiLineString']],
];
const POINTS: ExpressionSpecification = ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]];

const EMPTY_FC = { type: 'FeatureCollection' as const, features: [] };

export class GeoJsonOverlay implements InteractiveOverlay {
  readonly sourceId: string;
  readonly layerIds: string[];
  private features: OverlayFeature[] = [];
  private computed: OverlayStyle[] = [];
  private style: OverlayStyle | StyleFn;
  private handlers = new Map<PointerEventType, Set<OverlayHandler>>();
  private removed = false;

  constructor(private readonly map: MlMap, opts: OverlayOptions = {}) {
    const id = `ovl-${++seq}`;
    this.sourceId = id;
    this.style = opts.style ?? {};
    this.layerIds = [`${id}-fill`, `${id}-line`, `${id}-circle`];
    const [fillId, lineId, circleId] = this.layerIds as [string, string, string];

    map.addSource(id, { type: 'geojson', data: EMPTY_FC });
    map.addLayer({
      id: fillId, type: 'fill', source: id, filter: POLY,
      layout: { 'fill-sort-key': ['get', '__z'] },
      paint: { 'fill-color': ['get', '__fc'], 'fill-opacity': ['get', '__fo'] },
    }, opts.beforeId);
    map.addLayer({
      id: lineId, type: 'line', source: id, filter: LINEISH,
      layout: { 'line-join': 'round', 'line-cap': opts.lineCap ?? 'round', 'line-sort-key': ['get', '__z'] },
      paint: {
        'line-color': ['get', '__sc'],
        'line-opacity': ['get', '__so'],
        'line-width': ['get', '__sw'],
        ...(opts.dash ? { 'line-dasharray': opts.dash } : {}),
      },
    }, opts.beforeId);
    map.addLayer({
      id: circleId, type: 'circle', source: id, filter: POINTS,
      layout: { 'circle-sort-key': ['get', '__z'] },
      paint: {
        'circle-radius': ['get', '__pr'],
        'circle-color': ['get', '__pc'],
        'circle-opacity': ['get', '__po'],
        'circle-stroke-color': ['get', '__psc'],
        'circle-stroke-width': ['get', '__psw'],
      },
    }, opts.beforeId);

    interactionsFor(map).register(this.layerIds, this);
  }

  /** Replace every feature. Accepts a FeatureCollection, a feature list, or null (clear). */
  setData(data: { features?: unknown[] } | OverlayFeature[] | null | undefined): void {
    const list = Array.isArray(data) ? data : ((data?.features ?? []) as OverlayFeature[]);
    this.features = list.filter((f): f is OverlayFeature => !!f && typeof f === 'object' && !!(f as OverlayFeature).geometry);
    this.push();
  }

  /** Current features (as passed in, without computed style keys). */
  getFeatures(): OverlayFeature[] {
    return this.features;
  }

  /** Replace the style (object or function) and repaint. */
  setStyle(style: OverlayStyle | StyleFn): void {
    this.style = style;
    this.push();
  }

  /** Re-run the style function against the current features (after selection etc. changed). */
  restyle(): void {
    this.push();
  }

  /** Set any paint property on this overlay's line layer (e.g. animated `line-dasharray`). */
  setLinePaint(prop: 'line-dasharray' | 'line-opacity' | 'line-width' | 'line-color', value: unknown): void {
    if (this.removed || isMapRemoved(this.map)) return;
    // A map torn down underneath us (Map.remove() swaps in an EMPTY style) no longer
    // has our layer; painting it would throw "Style is not done loading" on every
    // tick of an animation. No layer → nothing to paint.
    if (!this.map.getLayer(this.layerIds[1]!)) return;
    // MapLibre's paint-value union is too large for TS to check against `unknown`;
    // the property names above are constrained instead.
    (this.map.setPaintProperty as (layer: string, name: string, v: unknown) => MlMap)
      .call(this.map, this.layerIds[1]!, prop, value);
  }

  on(type: PointerEventType, fn: OverlayHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) { set = new Set(); this.handlers.set(type, set); }
    set.add(fn);
    return () => { set!.delete(fn); };
  }

  /** @internal — called by the dispatcher. */
  emit(type: PointerEventType, hit: OverlayHit): void {
    const set = this.handlers.get(type);
    if (!set || set.size === 0) return;
    const props = (this.features[hit.index]?.properties ?? {}) as OverlayProps;
    for (const fn of set) fn(hit, props);
  }

  /** @internal — called by the dispatcher. */
  isClickable(index: number): boolean {
    return !!this.computed[index]?.clickable;
  }

  /** Bounds of every drawn feature, or null. */
  getBounds(): LngLatBoundsT | null {
    let b: LngLatBoundsT | null = null;
    const visit = (c: unknown): void => {
      if (!Array.isArray(c)) return;
      if (typeof c[0] === 'number' && typeof c[1] === 'number') {
        const p: [number, number] = [c[0], c[1]];
        b = b ? b.extend(p) : new LngLatBounds(p, p);
        return;
      }
      for (const x of c) visit(x);
    };
    this.features.forEach((f, i) => {
      if (this.computed[i]?.visible === false) return;
      visit(f.geometry?.coordinates);
    });
    return b;
  }

  /** Lift this overlay above every other layer. */
  moveToTop(): void {
    if (this.removed || isMapRemoved(this.map)) return;
    for (const id of this.layerIds) if (this.map.getLayer(id)) this.map.moveLayer(id);
  }

  remove(): void {
    if (this.removed) return;
    this.removed = true;
    this.handlers.clear();
    if (isMapRemoved(this.map)) return;
    interactionsFor(this.map).unregister(this.layerIds);
    for (const id of this.layerIds) if (this.map.getLayer(id)) this.map.removeLayer(id);
    if (this.map.getSource(this.sourceId)) this.map.removeSource(this.sourceId);
  }

  private push(): void {
    if (this.removed || isMapRemoved(this.map)) return;
    const styleOf: StyleFn = typeof this.style === 'function'
      ? this.style
      : (() => this.style as OverlayStyle);
    this.computed = this.features.map((f, i) => styleOf((f.properties ?? {}) as OverlayProps, i));
    const out = [];
    for (let i = 0; i < this.features.length; i++) {
      const s = this.computed[i]!;
      if (s.visible === false) continue;
      const f = this.features[i]!;
      out.push({
        type: 'Feature' as const,
        id: i,
        geometry: f.geometry,
        properties: {
          __i: i,
          __z: s.zIndex ?? 0,
          __fc: s.fillColor ?? '#000000',
          __fo: s.fillColor ? (s.fillOpacity ?? 1) : 0,
          __sc: s.strokeColor ?? '#000000',
          __so: s.strokeOpacity ?? 1,
          __sw: s.strokeWeight ?? (s.strokeColor ? 1 : 0),
          __pr: s.pointRadius ?? 4,
          __pc: s.pointColor ?? s.fillColor ?? '#000000',
          __po: s.pointOpacity ?? 1,
          __psc: s.pointStrokeColor ?? '#FFFFFF',
          __psw: s.pointStrokeWeight ?? 0,
        },
      });
    }
    const src = this.map.getSource(this.sourceId) as GeoJSONSource | undefined;
    src?.setData({ type: 'FeatureCollection', features: out } as GeoJSON.FeatureCollection);
  }
}

// ── feature builders (lat/lng paths → GeoJSON) ────────────────────────────────

const ring = (path: LatLng[]): number[][] => {
  const r = path.map((p) => [p.lng, p.lat]);
  const first = r[0];
  const last = r[r.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) r.push([first[0]!, first[1]!]);
  return r;
};

/** One polygon from rings (outer first, then holes) given as lat/lng paths. */
export function polygonFeature(rings: LatLng[][], properties: OverlayProps = {}): OverlayFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: rings.filter((r) => r.length >= 3).map(ring) },
    properties,
  };
}

/** One polyline from a lat/lng path. */
export function lineFeature(path: LatLng[], properties: OverlayProps = {}): OverlayFeature {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: path.map((p) => [p.lng, p.lat]) },
    properties,
  };
}

/** One point. */
export function pointFeature(p: LatLng, properties: OverlayProps = {}): OverlayFeature {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties };
}

/** A GeoJSON geometry wrapped as a feature. */
export function geometryFeature(
  geometry: { type: string; coordinates: unknown } | null | undefined,
  properties: OverlayProps = {},
): OverlayFeature {
  return { type: 'Feature', geometry: geometry ?? null, properties };
}
