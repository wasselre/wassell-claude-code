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

/**
 * Lexical variants of a customer token so its spelling reaches the ILIKE
 * candidate stage: ة/ه, ى/ي, أإآ/ا swaps and with/without the leading «ال».
 * ILIKE is byte-wise — «المحمديه» never matched «حي المحمدية» — while only the
 * resolver's SELECTION gate folds, so a variant miss here was a silent
 * needs_confirm. Over-generating is safe: selection still requires an exact
 * (article-insensitive) key.
 */
export function lexicalVariants(token: string): string[] {
  const base = token.trim().replace(/\s+/g, ' ');
  if (!base) return [];
  const out = new Set<string>([base]);
  const folds: Array<(s: string) => string> = [
    (s) => s.replace(/ة/g, 'ه'), (s) => s.replace(/ه(?=\s|$)/g, 'ة'),
    (s) => s.replace(/ى/g, 'ي'), (s) => s.replace(/ي(?=\s|$)/g, 'ى'),
    (s) => s.replace(/[أإآ]/g, 'ا'),
  ];
  for (const f of folds) for (const s of Array.from(out)) out.add(f(s));
  for (const s of Array.from(out)) {
    if (/^ال\S/.test(s)) out.add(s.replace(/^ال/, ''));
    else if (/^[\u0600-\u06FF]/.test(s)) out.add(`ال${s}`);
  }
  return Array.from(out).filter(Boolean).slice(0, 16);
}

/** ILIKE both name columns for a token (and its lexical variants); raw {id,data} rows (capped). */
async function ilikeModel(
  supabase: SupabaseClient, mId: string, token: string, limit = 60,
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const variants = lexicalVariants(token).map((v) => v.replace(/[%_,()]/g, '')).filter(Boolean);
  if (variants.length === 0) return [];
  const or = variants.flatMap((v) => [`data->>name_ar.ilike.%${v}%`, `data->>name_en.ilike.%${v}%`]).join(',');
  const { data, error } = await supabase
    .from('unified_records')
    .select('id, data')
    .eq('model_id', mId)
    .or(or)
    .limit(limit);
  if (error) throw new Error(`resolver: ${mId} candidate lookup failed: ${error.message}`);
  return (data ?? []) as Array<{ id: string; data: Record<string, unknown> }>;
}

/**
 * `wassell_search_geo_elements` filters `p_city` against geo_elements.city, which
 * holds ENGLISH names («Riyadh»); the resolver's established city is Arabic
 * («الرياض»). Measured 2026-09-15: p_city='الرياض' → 0 rows, 'Riyadh' → rows.
 * Translate through the cities model (cached per adapter); an unknown city
 * passes through unchanged.
 */
async function cityNameForElements(
  supabase: SupabaseClient, cache: Map<string, string | null>, city: string | undefined,
): Promise<string | null> {
  const c = (city ?? '').trim();
  if (!c) return null;
  if (cache.has(c)) return cache.get(c) ?? c;
  let out: string | null = c;
  if (/[\u0600-\u06FF]/.test(c)) {
    const mId = await modelId(supabase, 'cities');
    if (mId) {
      const { data, error } = await supabase.from('unified_records').select('data').eq('model_id', mId).eq('data->>name_ar', c).limit(1);
      if (error) throw new Error(`resolver: city lookup for elements failed: ${error.message}`);
      const en = asStr((data?.[0]?.data as Record<string, unknown> | undefined)?.name_en);
      out = en || c;
    }
  }
  cache.set(c, out);
  return out;
}

export function createSupabaseResolverDb(supabase: SupabaseClient): ResolverDb {
  const cityCache = new Map<string, string | null>();
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
      // A bare road name («الملك فهد») ranks behind hospitals/parks/metro stops
      // that share it, so for roads also query the «طريق …» form.
      const t = token.trim();
      const queries = opts.kind === 'linestring' && !/^\s*(طريق|شارع|محور|الدائري)\s/.test(t) ? [`طريق ${t}`, t] : [t];
      const pCity = await cityNameForElements(supabase, cityCache, opts.city);
      const seen = new Map<string, Record<string, unknown>>();
      for (const q of queries) {
        const { data, error } = await supabase.rpc('wassell_search_geo_elements', {
          p_q: q, p_category: null, p_type: null,
          p_city: pCity, p_limit: 30, p_include_unapproved: false,
        });
        if (error) throw new Error(`resolver: geo element search failed: ${error.message}`);
        for (const r of (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>) {
          const id = asStr(r.external_id);
          if (id && !seen.has(id)) seen.set(id, r);
        }
      }
      return Array.from(seen.values()).map((r) => ({
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
