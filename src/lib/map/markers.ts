import { Marker, Popup, type Map as MlMap } from '@/lib/map/maplibre';
import type { LatLng } from '@/lib/map/geo';

/**
 * DOM markers for MapLibre — the replacement for `google.maps.Marker`.
 *
 * Markers are real DOM elements positioned over the map, so:
 *  • text (place names, pill labels) is shaped by the browser — Arabic joins and
 *    runs right-to-left with no glyph/RTL plugin to load;
 *  • every marker sits above every GeoJsonOverlay layer, as on Google;
 *  • `zIndex` is plain CSS z-index on the element.
 *
 * A click on a marker never reaches `onEmptyMapClick` handlers (the dispatcher
 * recognises `.maplibregl-marker` targets), mirroring Google.
 */

/** An image marker icon — what `buildColoredPinIcon` / `buildPillIcon` / `buildClusterIcon` return. */
export interface MapIcon {
  url: string;
  width: number;
  height: number;
  /** Which point of the image sits on the coordinate. Pins/pills: bottom. Dots/clusters: center. */
  anchor: 'bottom' | 'center';
}

export interface IconMarkerOptions {
  position: LatLng;
  icon: MapIcon;
  /** Native hover tooltip. */
  title?: string;
  zIndex?: number;
  onClick?: (e: MouseEvent) => void;
  /** Pointer entered / left the marker (styled hover tooltips). */
  onHover?: (hovering: boolean) => void;
  /** false = pointer events pass straight through to the map. Default: true when onClick is set. */
  clickable?: boolean;
  draggable?: boolean;
}

/** Image marker on the map (already added). Call `.remove()` to take it off. */
export function createIconMarker(map: MlMap, o: IconMarkerOptions): Marker {
  const el = document.createElement('div');
  el.style.width = `${o.icon.width}px`;
  el.style.height = `${o.icon.height}px`;
  el.style.backgroundImage = `url("${o.icon.url}")`;
  el.style.backgroundSize = '100% 100%';
  if (o.zIndex != null) el.style.zIndex = String(o.zIndex);
  if (o.title) el.title = o.title;
  const clickable = o.clickable ?? !!o.onClick;
  el.style.pointerEvents = clickable || o.draggable || o.title || o.onHover ? 'auto' : 'none';
  el.style.cursor = clickable ? 'pointer' : '';
  if (o.onClick) {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      o.onClick!(e);
    });
  }
  if (o.onHover) {
    el.addEventListener('mouseenter', () => o.onHover!(true));
    el.addEventListener('mouseleave', () => o.onHover!(false));
  }
  return new Marker({ element: el, anchor: o.icon.anchor, draggable: !!o.draggable })
    .setLngLat([o.position.lng, o.position.lat])
    .addTo(map);
}

export interface LabelMarkerOptions {
  position: LatLng;
  text: string;
  color: string;
  /** CSS font-size. Default '11px'. */
  fontSize?: string;
  /** CSS font-weight. Default '700'. */
  fontWeight?: string;
  zIndex?: number;
}

/**
 * A text-only label centred on a point — the replacement for Google's
 * "invisible icon + `label`" marker trick used to name districts/areas.
 * Never interactive (pointer-events: none), white halo for legibility.
 */
export function createLabelMarker(map: MlMap, o: LabelMarkerOptions): Marker {
  const el = document.createElement('div');
  el.textContent = o.text;
  el.style.color = o.color;
  el.style.fontSize = o.fontSize ?? '11px';
  el.style.fontWeight = o.fontWeight ?? '700';
  el.style.fontFamily = 'Amiri, "Segoe UI", system-ui, sans-serif';
  el.style.whiteSpace = 'nowrap';
  el.style.pointerEvents = 'none';
  el.style.textShadow = '0 0 2px #fff, 0 0 2px #fff, 0 0 3px #fff';
  el.dir = 'auto';
  if (o.zIndex != null) el.style.zIndex = String(o.zIndex);
  return new Marker({ element: el, anchor: 'center' })
    .setLngLat([o.position.lng, o.position.lat])
    .addTo(map);
}

/**
 * A small hover tooltip (Google InfoWindow-with-text replacement). One instance
 * per map surface; `show` moves it, `hide` removes it.
 */
export class MapTooltip {
  private popup = new Popup({ closeButton: false, closeOnClick: false, offset: 8, className: 'wassel-map-tooltip' });
  constructor(private readonly map: MlMap) {}
  show(position: LatLng, content: string | HTMLElement): void {
    if (typeof content === 'string') this.popup.setText(content);
    else this.popup.setDOMContent(content);
    this.popup.setLngLat([position.lng, position.lat]);
    if (!this.popup.isOpen()) this.popup.addTo(this.map);
  }
  hide(): void {
    this.popup.remove();
  }
}
