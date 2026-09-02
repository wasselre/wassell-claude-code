/**
 * GeoJSON → google.maps path converters. Shared by every map surface that draws
 * server-compiled geometry (the district picker, the finder's client-area layer).
 *
 * Pure helpers: no React, no Maps API calls — the google.maps types are only the
 * return SHAPE, so these are safe to import before the Maps script has loaded.
 */

export interface GeoJsonGeometry { type: string; coordinates: unknown }

/** One GeoJSON position [lng, lat] → a LatLngLiteral, or null when the pair
 *  isn't two finite numbers (a malformed row must never crash the map). */
const coordToLatLng = (c: unknown): google.maps.LatLngLiteral | null =>
  Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])
    ? { lat: c[1] as number, lng: c[0] as number }
    : null;

/** One ring/line of positions → a path, dropping unparseable coords. */
const ringToPath = (ring: unknown): google.maps.LatLngLiteral[] =>
  (Array.isArray(ring) ? ring : [])
    .map(coordToLatLng)
    .filter((p): p is google.maps.LatLngLiteral => p !== null);

/** GeoJSON Polygon/MultiPolygon → google.maps paths (outer + hole rings, flattened). */
export function geojsonToPaths(g: GeoJsonGeometry): google.maps.LatLngLiteral[][] {
  if (g.type === 'Polygon') return ((g.coordinates as unknown[]) ?? []).map(ringToPath);
  if (g.type === 'MultiPolygon') {
    return ((g.coordinates as unknown[]) ?? []).flatMap((poly) =>
      ((poly as unknown[]) ?? []).map(ringToPath),
    );
  }
  return [];
}

/** GeoJSON LineString/MultiLineString → google.maps polyline paths. */
export function geojsonToLinePaths(g: GeoJsonGeometry): google.maps.LatLngLiteral[][] {
  if (g.type === 'LineString') return [ringToPath(g.coordinates)];
  if (g.type === 'MultiLineString') return ((g.coordinates as unknown[]) ?? []).map(ringToPath);
  return [];
}
