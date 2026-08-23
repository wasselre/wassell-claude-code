/**
 * Client-facing map layer catalogue + fetch for the on-map layer control.
 *
 * These are the OPTIONAL context layers a user can switch on over the property
 * pins (main streets, metro, malls, …). They are drawn from public.geo_elements
 * via the `geo_map_elements` RPC (viewport-scoped, capped, SECURITY DEFINER) —
 * NOT the admin `/api/geo-elements-admin` endpoint, which is admin-gated.
 *
 * The administrative boundary outline (districts/cities) is a SEPARATE, always-on
 * ambient layer (useGeoBoundaryLayer) and is intentionally not one of these.
 */
import { supabase } from '@/lib/supabase';

/** One toggle in the layer panel. `categories` are the geo_elements categories it
 *  switches on; several toggles (metro) map to more than one category. */
export interface MapLayerDef {
  id: string;
  label_ar: string;
  label_en: string;
  /** geo_elements categories this toggle turns on. */
  categories: string[];
  /** Swatch + draw colour (line stroke / point fill). */
  color: string;
  /** How the primary geometry renders — drives the legend glyph. */
  kind: 'line' | 'point' | 'mixed';
}

/** Grouped for the panel headings. Order = display order. */
export const MAP_LAYER_GROUPS: { label_ar: string; label_en: string; layers: MapLayerDef[] }[] = [
  {
    label_ar: 'الطرق', label_en: 'Roads',
    layers: [
      { id: 'streets', label_ar: 'الشوارع الرئيسية', label_en: 'Main streets', categories: ['roads_major'], color: '#8E4E3A', kind: 'line' },
      { id: 'ring', label_ar: 'الطرق الدائرية', label_en: 'Ring roads', categories: ['ring_roads'], color: '#4A2C2A', kind: 'line' },
      { id: 'metro', label_ar: 'المترو', label_en: 'Metro', categories: ['metro_lines', 'metro_stations'], color: '#6B4E8E', kind: 'mixed' },
    ],
  },
  {
    label_ar: 'الأماكن', label_en: 'Places',
    layers: [
      { id: 'malls', label_ar: 'المولات', label_en: 'Malls', categories: ['malls'], color: '#B8734F', kind: 'point' },
      { id: 'parks', label_ar: 'الحدائق', label_en: 'Parks', categories: ['parks'], color: '#5C7A3D', kind: 'point' },
      { id: 'hospitals', label_ar: 'المستشفيات', label_en: 'Hospitals', categories: ['hospitals'], color: '#A33B2A', kind: 'point' },
      { id: 'universities', label_ar: 'الجامعات', label_en: 'Universities', categories: ['universities'], color: '#3E6B6E', kind: 'point' },
      { id: 'landmarks', label_ar: 'المعالم', label_en: 'Landmarks', categories: ['landmarks'], color: '#C09B5F', kind: 'point' },
    ],
  },
];

export const ALL_MAP_LAYERS: MapLayerDef[] = MAP_LAYER_GROUPS.flatMap((g) => g.layers);

/** category → brand colour, for styling features the RPC returns. */
export const CATEGORY_COLOR: Record<string, string> = {
  roads_major: '#8E4E3A',
  ring_roads: '#4A2C2A',
  metro_lines: '#6B4E8E',
  metro_stations: '#8E72B0',
  malls: '#B8734F',
  parks: '#5C7A3D',
  hospitals: '#A33B2A',
  universities: '#3E6B6E',
  landmarks: '#C09B5F',
};

/** Turn a set of enabled layer ids into the flat geo_elements category list. */
export function categoriesForLayers(activeLayerIds: Iterable<string>): string[] {
  const byId = new Map(ALL_MAP_LAYERS.map((l) => [l.id, l]));
  const out = new Set<string>();
  for (const id of activeLayerIds) {
    for (const c of byId.get(id)?.categories ?? []) out.add(c);
  }
  return [...out];
}

export interface GeoElementFeature {
  type: 'Feature';
  id?: string;
  properties: { external_id: string; category: string; type: string | null; name_ar: string | null; name_en: string | null };
  geometry: { type: string; coordinates: unknown };
}
export interface GeoElementFC { type: 'FeatureCollection'; features: GeoElementFeature[] }
export interface MapElementLayers { lines: GeoElementFC; points: GeoElementFC }

/**
 * Fetch the requested categories for a viewport. Returns empty collections when
 * Supabase is unconfigured or no categories are requested — never throws for the
 * empty case; a real RPC error is thrown so the caller can surface it.
 */
export async function fetchMapElementLayers(
  bounds: { minLng: number; minLat: number; maxLng: number; maxLat: number },
  zoom: number,
  categories: string[],
): Promise<MapElementLayers> {
  const empty: GeoElementFC = { type: 'FeatureCollection', features: [] };
  if (!supabase || categories.length === 0) return { lines: empty, points: empty };

  const { data, error } = await supabase.rpc('geo_map_elements', {
    p_min_lng: bounds.minLng, p_min_lat: bounds.minLat,
    p_max_lng: bounds.maxLng, p_max_lat: bounds.maxLat,
    p_zoom: Math.round(zoom), p_categories: categories,
  });
  if (error) throw new Error(error.message);
  const res = (data ?? {}) as { lines?: GeoElementFC; points?: GeoElementFC };
  return { lines: res.lines ?? empty, points: res.points ?? empty };
}
