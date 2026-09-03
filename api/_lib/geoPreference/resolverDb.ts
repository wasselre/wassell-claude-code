/**
 * Supabase-backed implementation of the resolver's `ResolverDb` port.
 *
 * This is the ONLY file in the geoPreference resolver that touches Postgres. It
 * reuses the EXISTING geo stack — the same `unified_records` reads and the same
 * `wassell_city_zone_districts` / `districts_for_points` RPCs the Project Finder
 * and the retell agent already call — so there is one source of truth for how a
 * name/point becomes an id. `resolver.ts` stays pure and unit-testable; this
 * adapter is exercised against the live DB.
 *
 * Candidate GENERATION here is deliberately loose (ILIKE substrings + a 60-row
 * cap, exactly like `resolveRequestedDistrict`): the resolver's SELECTION gate is
 * what enforces exact-match-or-confirm, so over-generating candidates is safe and
 * correct (it is how الجبيلة surfaces الجبيل as a *near miss* rather than a silent
 * pick).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_GEO_COUNTRY } from '../matchAgent.js';
import type {
  ResolverDb, DistrictCandidate, CityCandidate, RegionCandidate, ElementCandidate,
  ZoneDistrict, PointDistrict,
} from './resolver.js';

const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asNum = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
};
const asAliases = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [];

async function modelId(supabase: SupabaseClient, name: string): Promise<string | null> {
  const { data } = await supabase.from('models').select('id').eq('name', name).maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/** ILIKE both name columns for a token; returns raw {id,data} rows (capped). */
async function ilikeModel(
  supabase: SupabaseClient, mId: string, token: string, limit = 60,
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const pat = `%${token.replace(/[%_]/g, '')}%`;
  const { data, error } = await supabase
    .from('unified_records')
    .select('id, data')
    .eq('model_id', mId)
    .or(`data->>name_ar.ilike.${pat},data->>name_en.ilike.${pat}`)
    .limit(limit);
  if (error || !data) return [];
  return data as Array<{ id: string; data: Record<string, unknown> }>;
}

export function createSupabaseResolverDb(supabase: SupabaseClient): ResolverDb {
  return {
    async findDistricts(token: string): Promise<DistrictCandidate[]> {
      const mId = await modelId(supabase, 'districts');
      if (!mId) return [];
      const t = token.replace(/^\s*حي\s+/, '').trim();
      const rows = await ilikeModel(supabase, mId, t);
      return rows.map((r) => ({
        id: r.id,
        name_ar: asStr(r.data.name_ar),
        name_en: asStr(r.data.name_en),
        aliases: asAliases(r.data.aliases),
        city_id: asStr(r.data.city_lookup) || null,
        city_name_ar: asStr(r.data.city_name_ar),
        city_name_en: asStr(r.data.city_name_en),
        region_name_ar: asStr(r.data.region_name_ar),
        region_name_en: asStr(r.data.region_name_en),
        country_code: asStr(r.data.country_code) || DEFAULT_GEO_COUNTRY,
        centroid_lat: asNum(r.data.centroid_lat),
        centroid_lng: asNum(r.data.centroid_lng),
      }));
    },

    async findCities(token: string): Promise<CityCandidate[]> {
      const mId = await modelId(supabase, 'cities');
      if (!mId) return [];
      const rows = await ilikeModel(supabase, mId, token.trim(), 30);
      return rows.map((r) => ({
        id: r.id,
        name_ar: asStr(r.data.name_ar),
        name_en: asStr(r.data.name_en),
        aliases: asAliases(r.data.aliases),
        region_name_ar: asStr(r.data.region_name_ar),
        region_name_en: asStr(r.data.region_name_en),
        country_code: asStr(r.data.country_code) || DEFAULT_GEO_COUNTRY,
        centroid_lat: asNum(r.data.centroid_lat),
        centroid_lng: asNum(r.data.centroid_lng),
      }));
    },

    async findRegions(token: string): Promise<RegionCandidate[]> {
      const mId = await modelId(supabase, 'regions');
      if (!mId) return [];
      const rows = await ilikeModel(supabase, mId, token.trim(), 30);
      return rows.map((r) => ({
        id: r.id,
        name_ar: asStr(r.data.name_ar),
        name_en: asStr(r.data.name_en),
        aliases: asAliases(r.data.aliases),
        country_code: asStr(r.data.country_code) || DEFAULT_GEO_COUNTRY,
      }));
    },

    async findElements(token, opts): Promise<ElementCandidate[]> {
      // wassell_search_geo_elements handles name/alias/category/type/city ranking.
      const { data, error } = await supabase.rpc('wassell_search_geo_elements', {
        p_q: token, p_category: null, p_type: null,
        p_city: opts.city ?? null, p_limit: 30, p_include_unapproved: false,
      });
      if (error || !Array.isArray(data)) return [];
      return (data as Array<Record<string, unknown>>).map((r) => ({
        external_id: asStr(r.external_id),
        name_ar: asStr(r.name_ar),
        name_en: asStr(r.name_en),
        aliases: [],
        geom_kind: (asStr(r.geom_kind) as ElementCandidate['geom_kind']) || null,
        category: asStr(r.category) || null,
        type: asStr(r.type) || null,
        city: asStr(r.city) || null,
        // wassell_search_geo_elements doesn't project country_code; scope by the
        // requested country downstream via city, and default to the request country.
        country_code: opts.preferCountry,
        lat: asNum(r.latitude),
        lng: asNum(r.longitude),
        confidence_score: asNum(r.confidence_score),
        review_status: asStr(r.review_status) || 'approved',
        is_active: true, // the RPC already filters is_active
      }));
    },

    async zoneDistricts(city: string, zone: string): Promise<ZoneDistrict[]> {
      const { data, error } = await supabase.rpc('wassell_city_zone_districts', { p_city: city, p_zone: zone });
      if (error || !Array.isArray(data)) return [];
      return (data as Array<{ district_id: string; district_name: string }>)
        .map((r) => ({ district_id: asStr(r.district_id), district_name: asStr(r.district_name) }))
        .filter((r) => r.district_id);
    },

    async districtForPoint(lat: number, lng: number): Promise<PointDistrict | null> {
      const { data, error } = await supabase.rpc('districts_for_points', {
        p_points: [{ id: 'anchor', lat, lng }],
      });
      if (error || !Array.isArray(data) || !data.length) return null;
      const hit = data[0] as Record<string, unknown>;
      return {
        district_record_id: asStr(hit.district_record_id) || null,
        city_id: asStr(hit.city_id) || null,
        region_id: asStr(hit.region_id) || null,
      };
    },
  };
}
