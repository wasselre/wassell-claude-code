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
 */
import type { SupabaseClient } from '@supabase/supabase-js';

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
    const { data, error } = await svc.rpc('sales_agent_find_places', { p_query: c.place, p_city_prefix: prefix, p_limit: 6 });
    if (error) throw new Error(`places: lookup failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ id: string; name_ar: string; element_type: string }>;
    if (!rows.length) { unresolved.push(c.place!); continue; }
    // The best match, plus its duplicates/companions of the same kind (a
    // university mapped as two polygons; a road and its service road).
    const top = rows[0]!;
    const core = top.name_ar.replace(/\s*(الفرعي|بنت عبد ?الرحمن)$/, '').trim();
    const ids = rows.filter((r) => r.element_type === top.element_type && (r.name_ar.includes(core) || core.includes(r.name_ar))).map((r) => r.id);
    resolved.push({ label: top.name_ar, max_km: c.max_km, elementIds: ids, elementTypes: null });
  }
  return { resolved, unresolved };
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
