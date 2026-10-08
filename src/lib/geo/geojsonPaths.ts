import type { LatLng } from '@/lib/map/geo';

/**
 * GeoJSON → lat/lng path converters. Shared by every map surface that draws
 * server-compiled geometry (the district picker, the finder's client-area layer)
 * and needs the rings as point lists — for bounds, centroids, label placement,
 * hulls and the editable-polygon handles.
 *
 * Pure helpers: no React, no map library.
 */

export interface GeoJsonGeometry { type: string; coordinates: unknown }

/** One GeoJSON position [lng, lat] → a LatLng, or null when the pair isn't two
 *  finite numbers (a malformed row must never crash the map). */
const coordToLatLng = (c: unknown): LatLng | null =>
  Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])
    ? { lat: c[1] as number, lng: c[0] as number }
    : null;

/** One ring/line of positions → a path, dropping unparseable coords. */
const ringToPath = (ring: unknown): LatLng[] =>
  (Array.isArray(ring) ? ring : [])
    .map(coordToLatLng)
    .filter((p): p is LatLng => p !== null);

/** GeoJSON Polygon/MultiPolygon → paths (outer + hole rings, flattened). */
export function geojsonToPaths(g: GeoJsonGeometry): LatLng[][] {
  if (g.type === 'Polygon') return ((g.coordinates as unknown[]) ?? []).map(ringToPath);
  if (g.type === 'MultiPolygon') {
    return ((g.coordinates as unknown[]) ?? []).flatMap((poly) =>
      ((poly as unknown[]) ?? []).map(ringToPath),
    );
  }
  return [];
}

/** GeoJSON LineString/MultiLineString → line paths. */
export function geojsonToLinePaths(g: GeoJsonGeometry): LatLng[][] {
  if (g.type === 'LineString') return [ringToPath(g.coordinates)];
  if (g.type === 'MultiLineString') return ((g.coordinates as unknown[]) ?? []).map(ringToPath);
  return [];
}
