/**
 * «قريب من …» for the sales agent: a place the customer named (a road, a mall,
 * a university, a landmark) or a kind of place («محطة مترو») → the distance in
 * km from each project's own coordinates, through two service-role RPCs
 * (migration 2026-10-01_sales_agent_places_and_plan_checks.sql).
 *
 * The retrieval test before this existed: «an apartment within 3 km of Riyadh
 * Park» → the agent guessed five neighbouring districts and missed 2 of the 3
 * projects actually inside the radius. A place we cannot find is reported back
 * (unresolved), never replaced by a guess.
 *
 * A NAMED place goes through the geography engine's own resolver (the one the
 * places card uses — api/_lib/geoPreference/resolver.ts): exact names only, a
 * name shared by several places (a chain mall's branches, a station named like
 * a district) comes back unresolved instead of silently taking the first hit,
 * and «محطة / مترو» picks the metro station. Until 2026-10-04 this was a fuzzy
 * top-result search of its own — a second, looser way of reading places.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveAnchor } from '../geoPreference/resolver.js';
import { createSupabaseResolverDb } from '../geoPreference/resolverDb.js';

export type PlaceCategory = 'metro' | 'mall' | 'hospital' | 'university' | 'park';
export const PLACE_CATEGORIES: PlaceCategory[] = ['metro', 'mall', 'hospital', 'university', 'park'];
const CATEGORY_TYPES: Record<PlaceCategory, string[]> = {
  metro: ['metro_stations'], mall: ['malls'], hospital: ['hospitals'], university: ['universities'], park: ['parks'],
};
const CATEGORY_LABEL: Record<PlaceCategory, string> = {
  metro: 'أقرب محطة مترو', mall: 'أقرب مول', hospital: 'أقرب مستشفى', university: 'أقرب جامعة', park: 'أقرب حديقة',
};

export interface NearCondition { place?: string; category?: PlaceCategory; max_km: number }

export interface ResolvedNear {
  /** What the agent quotes: the place's real name, or «أقرب محطة مترو». */
  label: string;
  max_km: number;
  elementIds: string[] | null;
  elementTypes: string[] | null;
}

/** City → geo_elements external_id prefix. Unknown city → none (no geography). */
const CITY_PREFIX: Record<string, string> = { 'الرياض': 'RUH', 'جدة': 'JED', 'الدمام': 'DMM', 'الخبر': 'KHB', 'المدينة المنورة': 'MED' };
export function cityPrefix(city: string | null | undefined): string | null {
  const c = String(city ?? '').trim() || 'الرياض';
  return CITY_PREFIX[c] ?? (/riyadh/i.test(c) ? 'RUH' : null);
}

export function asNearConditions(v: unknown): NearCondition[] {
  if (!Array.isArray(v)) return [];
  const out: NearCondition[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const km = typeof o.max_km === 'number' && o.max_km > 0 ? Math.min(o.max_km, 50) : null;
    if (!km) continue;
    const category = typeof o.category === 'string' && (PLACE_CATEGORIES as string[]).includes(o.category) ? (o.category as PlaceCategory) : undefined;
    const place = typeof o.place === 'string' && o.place.trim() ? o.place.trim() : undefined;
    if (place || category) out.push({ place, category, max_km: km });
  }
  return out.slice(0, 3);
}

export async function resolveNear(
  svc: SupabaseClient, conds: NearCondition[], prefix: string,
): Promise<{ resolved: ResolvedNear[]; unresolved: string[] }> {
  const resolved: ResolvedNear[] = [];
  const unresolved: string[] = [];
  for (const c of conds) {
    if (!c.place && c.category) {
      resolved.push({ label: CATEGORY_LABEL[c.category], max_km: c.max_km, elementIds: null, elementTypes: CATEGORY_TYPES[c.category] });
      continue;
    }
    const hit = await resolveNamedPlace(svc, c.place!, c.max_km, prefix);
    if (!hit) { unresolved.push(c.place!); continue; }
    resolved.push({ label: hit.label, max_km: c.max_km, elementIds: hit.ids, elementTypes: null });
  }
  return { resolved, unresolved };
}

const CITY_OF_PREFIX: Record<string, string> = Object.fromEntries(Object.entries(CITY_PREFIX).map(([city, p]) => [p, city]));
const ROAD_WORD = /^\s*(?:ال)?(?:طريق|شارع|دائري|محور)\s|^\s*الدائري/;
const STATION_WORD = /محط[ةه]|مترو|\bmetro\b|\bstation\b/i;

/**
 * One named place → its geo_elements ids (uuid) and real name, through the
 * geography engine's resolver. null = not on the map, or ambiguous (the agent
 * asks back).
 */
export async function resolveNamedPlace(
  svc: SupabaseClient, place: string, maxKm: number, prefix: string,
): Promise<{ ids: string[]; label: string } | null> {
  const isRoad = ROAD_WORD.test(place);
  const r = await resolveAnchor(
    { anchor_type: isRoad ? 'road' : 'landmark', span: place, normalized_token: place },
    {
      db: createSupabaseResolverDb(svc),
      preferCountry: 'SA',
      established_city: CITY_OF_PREFIX[prefix] ?? 'الرياض',
      radius_m: Math.round(maxKm * 1000),
      proximity: isRoad,
      station: STATION_WORD.test(place),
    },
  );
  const ext = r.status === 'resolved' ? (r.recipe?.resolved_element_ids ?? []).map(String) : [];
  if (!ext.length) {
    console.log(`[salesAgent/places] «${place}» not resolved (${r.status === 'resolved' ? 'no ids' : r.reason ?? r.status})`);
    return null;
  }
  const { data, error } = await svc.from('geo_elements').select('id, name_ar, external_id').in('external_id', ext);
  if (error) throw new Error(`places: element lookup failed: ${error.message}`);
  const rows = (data ?? []) as Array<{ id: string; name_ar: string | null; external_id: string }>;
  if (!rows.length) return null;
  return { ids: rows.map((x) => x.id), label: rows[0]!.name_ar || place };
}

/** km from each project to the nearest element of the condition (projects
 *  without coordinates are absent from the map). */
export async function distancesFor(svc: SupabaseClient, projectIds: string[], r: ResolvedNear, prefix: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!projectIds.length) return out;
  const { data, error } = await svc.rpc('sales_agent_project_distances', {
    p_project_ids: projectIds, p_element_ids: r.elementIds, p_element_types: r.elementTypes, p_city_prefix: prefix,
  });
  if (error) throw new Error(`places: distance failed: ${error.message}`);
  for (const row of (data ?? []) as Array<{ project_id: string; km: number | string }>) {
    const km = typeof row.km === 'number' ? row.km : parseFloat(row.km);
    if (Number.isFinite(km)) out.set(row.project_id, km);
  }
  return out;
}
