import Supercluster from 'supercluster';
import type { Map as MlMap, Marker } from '@/lib/map/maplibre';
import { createIconMarker, type MapIcon } from '@/lib/map/markers';
import { getZoomLevel, toMapLibreZoom, type LatLng } from '@/lib/map/geo';

/**
 * Clustered DOM markers — the replacement for `@googlemaps/markerclusterer`
 * with its `SuperClusterAlgorithm` (same Supercluster engine, same radius /
 * maxZoom numbers on the CLASSIC zoom scale, so clustering looks the same).
 *
 *   const c = new ClusteredMarkers(map, { radius: 70, maxZoom: 15, clusterIcon: (n) => buildClusterIcon(n) });
 *   c.setItems(items);   // replaces everything
 *   c.remove();          // teardown
 *
 * `solo` items are never absorbed into a cluster. Clusters re-render once per
 * settled viewport (`moveend`); individual markers are reused across renders so
 * a pan doesn't recreate the DOM. Clicking a cluster zooms to where it splits.
 */

export interface ClusterItem {
  id: string;
  position: LatLng;
  icon: MapIcon;
  title?: string;
  zIndex?: number;
  /** Never cluster this item. */
  solo?: boolean;
  onClick?: () => void;
  /** Pointer entered / left this item's marker (styled hover tooltips). */
  onHover?: (hovering: boolean) => void;
}

export interface ClusteredMarkersOptions {
  /** Cluster radius in px (Supercluster `radius`). Default 70. */
  radius?: number;
  /** Highest CLASSIC zoom at which points still cluster. Default 15. */
  maxZoom?: number;
  clusterIcon: (count: number) => MapIcon;
  /** z-index for cluster markers (count is added). Default 1000. */
  clusterZIndex?: number;
}

type PointProps = { idx: number };

export class ClusteredMarkers {
  private items: ClusterItem[] = [];
  private index: Supercluster<PointProps> | null = null;
  /** Live markers keyed by `p:<itemId>` / `c:<clusterId>:<count>`. */
  private live = new Map<string, Marker>();
  private readonly onMove = () => this.render();
  private removed = false;

  constructor(private readonly map: MlMap, private readonly opts: ClusteredMarkersOptions) {
    map.on('moveend', this.onMove);
  }

  setItems(items: ClusterItem[]): void {
    if (this.removed) return;
    this.items = items;
    const clustered = items
      .map((it, idx) => ({ it, idx }))
      .filter(({ it }) => !it.solo);
    if (clustered.length) {
      this.index = new Supercluster<PointProps>({
        radius: this.opts.radius ?? 70,
        maxZoom: this.opts.maxZoom ?? 15,
      });
      this.index.load(clustered.map(({ it, idx }) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [it.position.lng, it.position.lat] },
        properties: { idx },
      })));
    } else {
      this.index = null;
    }
    // A new item set means new markers — drop the old ones so changed icons rebuild.
    this.clearMarkers();
    this.render();
  }

  remove(): void {
    if (this.removed) return;
    this.removed = true;
    this.map.off('moveend', this.onMove);
    this.clearMarkers();
  }

  private clearMarkers(): void {
    for (const m of this.live.values()) m.remove();
    this.live.clear();
  }

  private render(): void {
    if (this.removed) return;
    const next = new Map<string, Marker>();
    const keep = (key: string, make: () => Marker) => {
      const existing = this.live.get(key);
      next.set(key, existing ?? make());
    };

    // Solo items: always individual markers.
    this.items.forEach((it) => {
      if (!it.solo) return;
      keep(`p:${it.id}`, () => this.itemMarker(it));
    });

    if (this.index) {
      const b = this.map.getBounds();
      // Pad by half a viewport so markers exist just before they scroll in.
      const padLng = (b.getEast() - b.getWest()) * 0.5;
      const padLat = (b.getNorth() - b.getSouth()) * 0.5;
      const bbox: [number, number, number, number] = [
        Math.max(-180, b.getWest() - padLng), Math.max(-85, b.getSouth() - padLat),
        Math.min(180, b.getEast() + padLng), Math.min(85, b.getNorth() + padLat),
      ];
      const zoom = Math.floor(getZoomLevel(this.map));
      for (const f of this.index.getClusters(bbox, zoom)) {
        const [lng, lat] = f.geometry.coordinates as [number, number];
        const props = f.properties as Supercluster.ClusterProperties | PointProps;
        if ('cluster' in props && props.cluster) {
          const count = props.point_count;
          const clusterId = props.cluster_id;
          keep(`c:${clusterId}:${count}`, () => createIconMarker(this.map, {
            position: { lat, lng },
            icon: this.opts.clusterIcon(count),
            zIndex: (this.opts.clusterZIndex ?? 1000) + count,
            onClick: () => {
              if (!this.index) return;
              const z = this.index.getClusterExpansionZoom(clusterId);
              this.map.easeTo({ center: [lng, lat], zoom: toMapLibreZoom(z), duration: 400 });
            },
          }));
        } else {
          const it = this.items[(props as PointProps).idx];
          if (it) keep(`p:${it.id}`, () => this.itemMarker(it));
        }
      }
    }

    for (const [key, m] of this.live) if (!next.has(key)) m.remove();
    this.live = next;
  }

  private itemMarker(it: ClusterItem): Marker {
    return createIconMarker(this.map, {
      position: it.position,
      icon: it.icon,
      title: it.title,
      zIndex: it.zIndex,
      onClick: it.onClick,
      onHover: it.onHover,
    });
  }
}
