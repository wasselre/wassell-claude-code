import { Marker, type Map as MlMap } from '@/lib/map/maplibre';
import { GeoJsonOverlay, polygonFeature, type OverlayStyle } from '@/lib/map/overlay';
import type { OverlayHit } from '@/lib/map/interactions';
import type { LatLng } from '@/lib/map/geo';

/**
 * A single-ring polygon with Google-style edit handles — the replacement for
 * `new google.maps.Polygon({ editable: true })`:
 *
 *  • a white VERTEX handle on every point — drag to move it (Google `set_at`);
 *  • a faint MIDPOINT handle on every edge — drag to insert a point there
 *    (Google `insert_at`);
 *  • right-click a vertex → `onVertexRightClick(index)`; the caller decides
 *    (usually `removeVertex(index)`, Google `remove_at`).
 *
 * `onEdit(path, kind)` fires once per finished gesture (drag end / removal), so
 * callers no longer need to debounce Google's per-frame `set_at` storm — though
 * debouncing is still harmless.
 *
 * The fill/outline is a GeoJsonOverlay, so shape clicks/hover go through the
 * shared dispatcher like every other overlay.
 */

export type EditKind = 'set' | 'insert' | 'remove';

export interface EditablePolygonOptions {
  /** Open ring (do NOT repeat the first point at the end). */
  path: LatLng[];
  style: OverlayStyle;
  editable?: boolean;
  onEdit?: (path: LatLng[], kind: EditKind) => void;
  onVertexRightClick?: (index: number) => void;
  /** Click / right-click / hover on the shape body (needs `style.clickable`). */
  onClick?: (hit: OverlayHit) => void;
  onRightClick?: (hit: OverlayHit) => void;
}

const VERTEX_SIZE = 12;
const MIDPOINT_SIZE = 10;

function handleEl(size: number, faint: boolean, color: string): HTMLDivElement {
  // MapLibre's Marker owns the ROOT element's `opacity` (it rewrites it for
  // occlusion), so the visual dot is an inner child — otherwise midpoint handles
  // would never look faint.
  const el = document.createElement('div');
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.cursor = 'pointer';
  el.style.zIndex = faint ? '50' : '60';
  el.dataset.mapHandle = faint ? 'midpoint' : 'vertex';
  const dot = document.createElement('div');
  dot.style.width = '100%';
  dot.style.height = '100%';
  dot.style.borderRadius = '50%';
  dot.style.background = '#FFFFFF';
  dot.style.border = `2px solid ${color}`;
  dot.style.boxSizing = 'border-box';
  dot.style.opacity = faint ? '0.6' : '1';
  el.appendChild(dot);
  return el;
}

export class EditablePolygon {
  private path: LatLng[];
  private style: OverlayStyle;
  private editable: boolean;
  private readonly overlay: GeoJsonOverlay;
  private vertices: Marker[] = [];
  private midpoints: Marker[] = [];
  private removed = false;

  constructor(private readonly map: MlMap, private readonly opts: EditablePolygonOptions) {
    this.path = opts.path.slice();
    this.style = opts.style;
    this.editable = !!opts.editable;
    this.overlay = new GeoJsonOverlay(map, { style: () => this.style });
    if (opts.onClick) this.overlay.on('click', (hit) => opts.onClick!(hit));
    if (opts.onRightClick) this.overlay.on('rightclick', (hit) => opts.onRightClick!(hit));
    this.redraw();
  }

  getPath(): LatLng[] {
    return this.path.slice();
  }

  setPath(path: LatLng[]): void {
    this.path = path.slice();
    this.redraw();
  }

  setStyle(style: OverlayStyle): void {
    this.style = style;
    this.overlay.restyle();
    this.rebuildHandles();
  }

  setEditable(editable: boolean): void {
    if (editable === this.editable) return;
    this.editable = editable;
    this.rebuildHandles();
  }

  /** Remove one vertex (Google `path.removeAt`). Fires onEdit('remove'). */
  removeVertex(index: number): void {
    if (index < 0 || index >= this.path.length) return;
    this.path.splice(index, 1);
    this.redraw();
    this.opts.onEdit?.(this.getPath(), 'remove');
  }

  get length(): number {
    return this.path.length;
  }

  /** The shape's overlay — e.g. to `moveToTop()` or hook extra events. */
  get shape(): GeoJsonOverlay {
    return this.overlay;
  }

  remove(): void {
    if (this.removed) return;
    this.removed = true;
    this.clearHandles();
    this.overlay.remove();
  }

  private redraw(): void {
    if (this.removed) return;
    this.overlay.setData(this.path.length >= 3 ? [polygonFeature([this.path])] : []);
    this.rebuildHandles();
  }

  private clearHandles(): void {
    for (const m of this.vertices) m.remove();
    for (const m of this.midpoints) m.remove();
    this.vertices = [];
    this.midpoints = [];
  }

  private rebuildHandles(): void {
    this.clearHandles();
    if (!this.editable || this.removed) return;
    const color = this.style.strokeColor ?? '#4A4E54';
    const n = this.path.length;

    this.path.forEach((p, i) => {
      const el = handleEl(VERTEX_SIZE, false, color);
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.opts.onVertexRightClick?.(i);
      });
      const m = new Marker({ element: el, draggable: true }).setLngLat([p.lng, p.lat]).addTo(this.map);
      m.on('drag', () => {
        const ll = m.getLngLat();
        this.path[i] = { lat: ll.lat, lng: ll.lng };
        this.overlay.setData([polygonFeature([this.path])]);
      });
      m.on('dragend', () => {
        this.rebuildHandles(); // midpoints move with their edges
        this.opts.onEdit?.(this.getPath(), 'set');
      });
      this.vertices.push(m);
    });

    for (let i = 0; i < n; i++) {
      const a = this.path[i]!;
      const b = this.path[(i + 1) % n]!;
      const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
      const el = handleEl(MIDPOINT_SIZE, true, color);
      const m = new Marker({ element: el, draggable: true }).setLngLat([mid.lng, mid.lat]).addTo(this.map);
      let inserted = false;
      m.on('dragstart', () => {
        this.path.splice(i + 1, 0, mid);
        inserted = true;
      });
      m.on('drag', () => {
        if (!inserted) return;
        const ll = m.getLngLat();
        this.path[i + 1] = { lat: ll.lat, lng: ll.lng };
        this.overlay.setData([polygonFeature([this.path])]);
      });
      m.on('dragend', () => {
        this.rebuildHandles();
        this.opts.onEdit?.(this.getPath(), 'insert');
      });
      this.midpoints.push(m);
    }
  }
}
