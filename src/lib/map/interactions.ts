import type { Map as MlMap, MapMouseEvent, MapGeoJSONFeature, LngLat, PointLike } from '@/lib/map/maplibre';

/**
 * Per-map pointer dispatch for GeoJSON overlays — reproduces the Google Maps
 * semantics the app was written against:
 *
 *  • Only the TOPMOST clickable shape under the pointer gets a click (Google
 *    delivered one event to one overlay; MapLibre's per-layer listeners would
 *    fire every overlapping layer).
 *  • A click on a clickable shape or on a marker is NOT an "empty map" click —
 *    `onEmptyClick` handlers (close the card / clear selection) only see clicks
 *    that hit nothing, same as Google's map-level `click`.
 *  • `mouseover` / `mouseout` fire per FEATURE (MapLibre's layer-level
 *    mouseenter/leave only fire when the pointer enters/leaves the whole layer),
 *    and the pointer cursor shows over clickable shapes.
 *
 * Overlays register their layer ids here; nothing else needs to.
 */

export interface OverlayHit {
  feature: MapGeoJSONFeature;
  /** Index of the feature within its overlay's current data. */
  index: number;
  lngLat: LngLat;
  originalEvent: MouseEvent;
}

/** What an overlay exposes to the dispatcher. */
export interface InteractiveOverlay {
  /** Whether the feature at `index` currently accepts pointer events. */
  isClickable(index: number): boolean;
  emit(type: PointerEventType, hit: OverlayHit): void;
}

export type PointerEventType = 'click' | 'dblclick' | 'rightclick' | 'mouseover' | 'mouseout';

type EmptyHandler = (e: MapMouseEvent) => void;

/** Lines are a few px wide — test a small box so they're hittable like Google's. */
const HIT_TOLERANCE_PX = 3;

class MapInteractions {
  private readonly layerOwner = new Map<string, InteractiveOverlay>();
  private readonly empty: Record<'click' | 'dblclick' | 'rightclick', Set<EmptyHandler>> = {
    click: new Set(), dblclick: new Set(), rightclick: new Set(),
  };
  private hovered: { overlay: InteractiveOverlay; index: number; hit: OverlayHit } | null = null;
  private baseCursor = '';
  removed = false;

  constructor(private readonly map: MlMap) {
    map.on('click', (e) => this.dispatch('click', e));
    map.on('dblclick', (e) => this.dispatch('dblclick', e));
    map.on('contextmenu', (e) => this.dispatch('rightclick', e));
    map.on('mousemove', (e) => this.hover(e));
    map.on('mouseout', () => this.clearHover());
    map.on('remove', () => { this.removed = true; });
  }

  register(layerIds: string[], overlay: InteractiveOverlay): void {
    for (const id of layerIds) this.layerOwner.set(id, overlay);
  }

  unregister(layerIds: string[]): void {
    for (const id of layerIds) this.layerOwner.delete(id);
    if (this.hovered && !this.isRegistered(this.hovered.overlay)) this.clearHover();
  }

  onEmpty(type: 'click' | 'dblclick' | 'rightclick', fn: EmptyHandler): () => void {
    this.empty[type].add(fn);
    return () => { this.empty[type].delete(fn); };
  }

  /** The cursor shown when NOT over a clickable shape (e.g. crosshair in draw mode). */
  setBaseCursor(cursor: string): void {
    this.baseCursor = cursor;
    if (!this.hovered) this.map.getCanvas().style.cursor = cursor;
  }

  private isRegistered(o: InteractiveOverlay): boolean {
    for (const v of this.layerOwner.values()) if (v === o) return true;
    return false;
  }

  /** Topmost clickable overlay feature under the event, or null. */
  private hitTest(e: MapMouseEvent): { overlay: InteractiveOverlay; hit: OverlayHit } | null {
    if (this.layerOwner.size === 0) return null;
    const layers = [...this.layerOwner.keys()].filter((id) => this.map.getLayer(id));
    if (layers.length === 0) return null;
    const { x, y } = e.point;
    const box: [PointLike, PointLike] = [
      [x - HIT_TOLERANCE_PX, y - HIT_TOLERANCE_PX],
      [x + HIT_TOLERANCE_PX, y + HIT_TOLERANCE_PX],
    ];
    // queryRenderedFeatures returns features top-most first across layers.
    for (const f of this.map.queryRenderedFeatures(box, { layers })) {
      const overlay = this.layerOwner.get(f.layer.id);
      const index = Number(f.properties?.__i);
      if (!overlay || !Number.isInteger(index) || !overlay.isClickable(index)) continue;
      return { overlay, hit: { feature: f, index, lngLat: e.lngLat, originalEvent: e.originalEvent } };
    }
    return null;
  }

  private dispatch(type: 'click' | 'dblclick' | 'rightclick', e: MapMouseEvent): void {
    // A click on a DOM marker (pin, card, vertex handle) bubbles to the map container
    // too. Markers sit above every shape, so it belongs to the marker alone — neither
    // the shape underneath nor the empty-map handlers may see it.
    if (isMarkerEvent(e.originalEvent)) return;
    const found = this.hitTest(e);
    if (found) {
      found.overlay.emit(type, found.hit);
      return;
    }
    for (const fn of this.empty[type]) fn(e);
  }

  private hover(e: MapMouseEvent): void {
    const found = isMarkerEvent(e.originalEvent) ? null : this.hitTest(e);
    const prev = this.hovered;
    if (found && prev && found.overlay === prev.overlay && found.hit.index === prev.index) return;
    if (prev) prev.overlay.emit('mouseout', prev.hit);
    this.hovered = found ? { overlay: found.overlay, index: found.hit.index, hit: found.hit } : null;
    if (found) found.overlay.emit('mouseover', found.hit);
    this.map.getCanvas().style.cursor = found ? 'pointer' : this.baseCursor;
  }

  private clearHover(): void {
    if (this.hovered) this.hovered.overlay.emit('mouseout', this.hovered.hit);
    this.hovered = null;
    if (!this.removed) this.map.getCanvas().style.cursor = this.baseCursor;
  }
}

function isMarkerEvent(ev: Event | undefined): boolean {
  const t = ev?.target;
  return t instanceof Element && !!t.closest('.maplibregl-marker, .maplibregl-popup');
}

const registry = new WeakMap<MlMap, MapInteractions>();

export function interactionsFor(map: MlMap): MapInteractions {
  let r = registry.get(map);
  if (!r) {
    r = new MapInteractions(map);
    registry.set(map, r);
  }
  return r;
}

/** True once `map.remove()` has run — teardown code must not touch a dead map. */
export function isMapRemoved(map: MlMap): boolean {
  return interactionsFor(map).removed;
}

/**
 * Google's map-level `click` / `dblclick` / `rightclick`: fires only when the
 * pointer hit no clickable overlay and no marker. Returns an unsubscribe.
 */
export function onEmptyMapClick(
  map: MlMap,
  fn: (e: MapMouseEvent) => void,
  type: 'click' | 'dblclick' | 'rightclick' = 'click',
): () => void {
  return interactionsFor(map).onEmpty(type, fn);
}

/** Set the map's resting cursor (e.g. 'crosshair' while drawing; '' to reset). */
export function setMapCursor(map: MlMap, cursor: string): void {
  interactionsFor(map).setBaseCursor(cursor);
}
