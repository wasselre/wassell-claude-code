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
import { isLatinToken, latinVariants } from './latinNames.js';
import type {
  ResolverDb, DistrictCandidate, CityCandidate, RegionCandidate, ElementCandidate,
  ZoneDistrict, PointDistrict, RoadAxis, NameInText,
} from './resolver.js';

const asStr = (v: unknown): string => (typeof v === 'string' ? v : '');
const asNum = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
};
const asAliases = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [];

/** The model id for a model name; null only when no such model exists — a failed query THROWS. */
async function modelId(supabase: SupabaseClient, name: string): Promise<string | null> {
  const { data, error } = await supabase.from('models').select('id').eq('name', name).maybeSingle();
  // Until 2026-10-04 the error was ignored: a failed read looked like "no such
  // model" and every lookup of that kind silently found nothing.
  if (error) throw new Error(`resolver: model lookup for ${name} failed: ${error.message}`);
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
  // A Latin token («Malga») also tries its transliteration spellings (q↔g …) so
  // the official English name («Al Malqa Dist.») becomes a candidate at all.
  const variants = Array.from(new Set([
    ...lexicalVariants(token),
    ...(isLatinToken(token) ? latinVariants(token) : []),
  ])).map((v) => v.replace(/[%_,()]/g, '')).filter(Boolean);
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
 * passes through unchanged (so a city we cannot name finds NO element rather
 * than another city's). Since 2026-10-03 the city can be the one the customer
 * named in the mention («بجدة شمال طريق …», anchorPrep.ts), whose extractor
 * token is folded («جده»), so the lookup tries its spelling variants too.
 */
async function cityNameForElements(
  supabase: SupabaseClient, cache: Map<string, string | null>, city: string | undefined,
): Promise<string | null> {
  const c = (city ?? '').trim();
  if (!c) return null;
  if (cache.has(c)) return cache.get(c) ?? c;
  const out = isArabicText(c) ? ((await arabicCityEnglishName(supabase, c)) || c) : c;
  cache.set(c, out);
  return out;
}

const isArabicText = (s: string): boolean => /[\u0600-\u06FF]/.test(s);

/**
 * cities.name_en of the city whose Arabic name is `c` in one of its lexical
 * spellings (ة/ه, ى/ي, أإآ/ا, with/without «ال») — the exact spelling first.
 * '' when no city has that name (or the cities model is absent). THROWS on error.
 */
async function arabicCityEnglishName(supabase: SupabaseClient, c: string): Promise<string> {
  const mId = await modelId(supabase, 'cities');
  if (!mId) return '';
  const variants = lexicalVariants(c).map((v) => v.replace(/[,()"]/g, '')).filter(Boolean);
  if (variants.length === 0) return '';
  const { data, error } = await supabase.from('unified_records').select('data').eq('model_id', mId).in('data->>name_ar', variants).limit(5);
  if (error) throw new Error(`resolver: city lookup for elements failed: ${error.message}`);
  // Prefer the exact spelling when several variants match.
  const rows = (data ?? []).map((r) => r.data as Record<string, unknown>);
  const hit = rows.find((d) => asStr(d.name_ar) === c) ?? rows[0];
  return asStr(hit?.name_en);
}

/** cities.name_en equal (case-insensitive) to a Latin `c` («riyadh» → «Riyadh»); '' when none. THROWS on error. */
async function latinCityEnglishName(supabase: SupabaseClient, c: string): Promise<string> {
  const mId = await modelId(supabase, 'cities');
  if (!mId) return '';
  // ILIKE without wildcards is a case-insensitive equality; strip the pattern
  // characters (and the PostgREST separators) so the input cannot widen it.
  const clean = c.replace(/[%_,()"\\*]/g, '').trim();
  if (!clean) return '';
  const { data, error } = await supabase.from('unified_records').select('data').eq('model_id', mId).ilike('data->>name_en', clean).limit(5);
  if (error) throw new Error(`resolver: city label lookup failed: ${error.message}`);
  const rows = (data ?? []).map((r) => r.data as Record<string, unknown>);
  const hit = rows.find((d) => asStr(d.name_en).trim().toLowerCase() === c.trim().toLowerCase());
  return asStr(hit?.name_en);
}

/**
 * Parse the `wassell_geo_road_axis` jsonb. A shape we do not recognise THROWS
 * — it is a broken contract between the SQL and this adapter, and reading it
 * as "no road" would turn a bug into a quiet "please confirm" forever.
 */
export function parseRoadAxis(v: unknown): RoadAxis {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('resolver: road axis returned no object');
  const o = v as Record<string, unknown>;
  if (o.found === false) return { found: false };
  if (o.found !== true) throw new Error('resolver: road axis returned no `found` flag');
  const scope = o.scope;
  if (scope !== 'district' && scope !== 'window' && scope !== 'road') {
    throw new Error(`resolver: road axis returned an unknown scope ${JSON.stringify(scope)}`);
  }
  const ew = asNum(o.ew_m);
  const ns = asNum(o.ns_m);
  if (ew === null || ns === null) throw new Error('resolver: road axis returned no ew_m / ns_m');
  return { found: true, scope, ew_m: ew, ns_m: ns };
}

/** PostgREST's row cap: a page this full may have been cut short. */
const ALIAS_PAGE_LIMIT = 1000;

/** geo_element_aliases for the given elements, by external id. THROWS on error (and on a suspiciously full page). */
async function loadElementAliases(supabase: SupabaseClient, ids: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const { data, error } = await supabase
    .from('geo_element_aliases')
    .select('external_id, alias')
    .in('external_id', [...ids])
    .limit(ALIAS_PAGE_LIMIT);
  if (error) throw new Error(`resolver: geo element alias lookup failed: ${error.message}`);
  const rows = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>;
  // ≤ 60 elements carry ~1.5 aliases each; a full page means rows were dropped.
  if (rows.length >= ALIAS_PAGE_LIMIT) throw new Error(`resolver: geo element alias lookup hit the ${ALIAS_PAGE_LIMIT}-row cap for ${ids.length} elements`);
  for (const r of rows) {
    const id = asStr(r.external_id);
    const alias = asStr(r.alias).trim();
    if (!id || !alias) continue;
    const list = out.get(id) ?? [];
    if (!list.includes(alias)) list.push(alias);
    out.set(id, list);
  }
  return out;
}

export function createSupabaseResolverDb(supabase: SupabaseClient): ResolverDb {
  const cityCache = new Map<string, string | null>();
  const labelCache = new Map<string, string | null>();
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
      // The search RPC MATCHES aliases but does not return them; without them an
      // element found by its alias («جامعة الأميرة نورة») could never be exact.
      const aliases = await loadElementAliases(supabase, Array.from(seen.keys()));
      return Array.from(seen.values()).map((r) => ({
        external_id: asStr(r.external_id),
        name_ar: asStr(r.name_ar),
        name_en: asStr(r.name_en),
        aliases: aliases.get(asStr(r.external_id)) ?? [],
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
      // Until 2026-10-04 an error read as "this city has no such zone" — the
      // card then asked about a place it could have drawn, and nobody knew why.
      if (error) throw new Error(`resolver: zone lookup failed for ${city}/${zone}: ${error.message}`);
      if (!Array.isArray(data)) return [];
      return (data as Array<{ district_id: string; district_name: string }>)
        .map((r) => ({ district_id: asStr(r.district_id), district_name: asStr(r.district_name) }))
        .filter((r) => r.district_id);
    },

    async districtForPoint(lat: number, lng: number): Promise<PointDistrict | null> {
      const { data, error } = await supabase.rpc('districts_for_points', {
        p_points: [{ id: 'anchor', lat, lng }],
      });
      if (error) throw new Error(`resolver: point-in-district lookup failed: ${error.message}`);
      if (!Array.isArray(data) || !data.length) return null;
      const hit = data[0] as Record<string, unknown>;
      return {
        district_record_id: asStr(hit.district_record_id) || null,
        city_id: asStr(hit.city_id) || null,
        region_id: asStr(hit.region_id) || null,
      };
    },

    async roadAxis(externalId: string, districtIds?: string[]): Promise<RoadAxis> {
      const { data, error } = await supabase.rpc('wassell_geo_road_axis', {
        p_road_external_id: externalId,
        p_district_ids: districtIds && districtIds.length > 0 ? districtIds : null,
      });
      if (error) throw new Error(`resolver: road axis lookup failed for ${externalId}: ${error.message}`);
      return parseRoadAxis(data);
    },

    async cityLabel(cityAr: string): Promise<string | null> {
      const c = (cityAr ?? '').trim();
      if (!c) return null;
      if (labelCache.has(c)) return labelCache.get(c) ?? null;
      // Unlike cityNameForElements, an unknown city is NULL here, never the input
      // passed through: the caller must be able to tell "unknown" from a label.
      const en = isArabicText(c)
        ? await arabicCityEnglishName(supabase, c)
        : /[a-z]/i.test(c) ? await latinCityEnglishName(supabase, c) : '';
      const out = en || null;
      labelCache.set(c, out);
      return out;
    },

    async namesInText(text: string): Promise<NameInText[]> {
      const { data, error } = await supabase.rpc('wassell_geo_names_in_text', { p_text: text });
      if (error) throw new Error(`resolver: names-in-text lookup failed: ${error.message}`);
      if (data == null) return [];
      if (!Array.isArray(data)) throw new Error('resolver: names-in-text returned no row list');
      return (data as Array<Record<string, unknown>>)
        .map((r) => ({ external_id: asStr(r.external_id), name: asStr(r.name), category: asStr(r.category) || null }))
        .filter((r) => r.external_id && r.name);
    },
  };
}
