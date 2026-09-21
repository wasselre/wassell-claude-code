/**
 * Drill-down choropleth data client (Projects & Inventory geography).
 *
 * Two thin wrappers over the SECURITY DEFINER RPCs added in
 * 2026-09-21_geo_choropleth_drilldown.sql:
 *   • fetchGeoTree   — the lightweight hierarchy (no geometry), loaded once. Its
 *                      district rows give district-record-id → parent-city, and
 *                      its city rows give city → parent-region, so the caller can
 *                      roll district demand up to city + region.
 *   • fetchGeoShapes — the FILLED geometry for ONE tier slice (all regions, or a
 *                      region's cities, or a city's districts) so the map only
 *                      ever loads the level in view.
 *
 * The demand-vs-supply metric is NEVER fetched here — it stays in the one
 * canonical TypeScript demand layer. This module serves geometry + hierarchy.
 */
import { supabase } from '@/lib/supabase';

export type GeoTier = 'region' | 'city' | 'district';

/** One node of the hierarchy tree (no geometry). */
export interface GeoNode {
  tier: GeoTier;
  /** The CRM record id this boundary outlines (district tier = same id space as
   *  clients' location.district). Null only for the country tier (not returned). */
  record_id: string | null;
  /** This row's own key — what a child's parent_external_id points at. */
  external_id: string;
  /** The parent boundary's external_id (district → city → region). */
  parent_external_id: string | null;
  name_ar: string | null;
  name_en: string | null;
}

/** A tier node WITH its simplified polygon (Polygon | MultiPolygon GeoJSON). */
export interface GeoShape extends GeoNode {
  geojson: { type: string; coordinates: unknown } | null;
}

/** The full region + city + district hierarchy for a country, no geometry.
 *  Loaded once; turned into district→city→region parent maps client-side. */
export async function fetchGeoTree(country = 'SA'): Promise<GeoNode[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('wassell_geo_choropleth_tree', { p_country: country });
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data : []) as GeoNode[];
}

/**
 * The filled geometry for ONE tier slice:
 *   ('region', null)            → every region of the country
 *   ('city',   <region ext id>) → that region's cities
 *   ('district', <city ext id>) → that city's districts
 */
export async function fetchGeoShapes(
  tier: GeoTier,
  parentExternalId: string | null,
  country = 'SA',
): Promise<GeoShape[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('wassell_geo_choropleth_shapes', {
    p_tier: tier,
    p_parent_external_id: parentExternalId,
    p_country: country,
  });
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data : []) as GeoShape[];
}

/** The demand-vs-supply numbers attached to any tier feature. Additive up the
 *  tree: a city's is the sum of its districts', a region's the sum of its
 *  cities'. `severity` = active clients with no suitable available supply. */
export interface DistrictMetric {
  demand: number;
  available: number;
  severity: number;
}

const EMPTY_METRIC: DistrictMetric = { demand: 0, available: 0, severity: 0 };

const add = (a: DistrictMetric, b: DistrictMetric): DistrictMetric => ({
  demand: a.demand + b.demand,
  available: a.available + b.available,
  severity: a.severity + b.severity,
});

/**
 * Roll a per-DISTRICT-RECORD-ID metric map up the hierarchy tree into
 * per-external-id metric maps for each tier. Region + city polygons are keyed by
 * external_id; district polygons by record_id — so the returned maps let the map
 * colour any tier's features by the same demand-vs-supply severity.
 */
export function rollupMetrics(
  tree: GeoNode[],
  districtMetricByRecordId: Map<string, DistrictMetric>,
): { region: Map<string, DistrictMetric>; city: Map<string, DistrictMetric>; district: Map<string, DistrictMetric> } {
  const district = new Map<string, DistrictMetric>();
  const city = new Map<string, DistrictMetric>();
  const region = new Map<string, DistrictMetric>();

  // district record_id → parent city external_id ; city external_id → parent region external_id
  const districtParentCity = new Map<string, string>();
  const cityParentRegion = new Map<string, string>();
  for (const n of tree) {
    if (n.tier === 'district' && n.record_id && n.parent_external_id) districtParentCity.set(n.record_id, n.parent_external_id);
    else if (n.tier === 'city' && n.parent_external_id) cityParentRegion.set(n.external_id, n.parent_external_id);
  }

  // District → city
  for (const [recordId, m] of districtMetricByRecordId) {
    district.set(recordId, m);
    const cityExt = districtParentCity.get(recordId);
    if (cityExt) city.set(cityExt, add(city.get(cityExt) ?? EMPTY_METRIC, m));
  }
  // City → region
  for (const [cityExt, m] of city) {
    const regionExt = cityParentRegion.get(cityExt);
    if (regionExt) region.set(regionExt, add(region.get(regionExt) ?? EMPTY_METRIC, m));
  }
  return { region, city, district };
}

/** LatLngBounds-free extent accumulation over a GeoJSON geometry's coordinates.
 *  Returns null for empty/invalid input so callers can skip fitBounds cleanly. */
export function geometryBounds(
  geometry: { type: string; coordinates: unknown } | null | undefined,
): { south: number; west: number; north: number; east: number } | null {
  if (!geometry?.coordinates) return null;
  let south = 90, west = 180, north = -90, east = -180, seen = false;
  const walk = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
      const lng = c[0] as number, lat = c[1] as number;
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        seen = true;
        if (lat < south) south = lat; if (lat > north) north = lat;
        if (lng < west) west = lng; if (lng > east) east = lng;
      }
      return;
    }
    if (Array.isArray(c)) for (const x of c) walk(x);
  };
  walk(geometry.coordinates);
  return seen ? { south, west, north, east } : null;
}
