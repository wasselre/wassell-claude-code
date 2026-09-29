/**
 * The sales agent's SEARCH sub-agent: the Project Finder, run in-process with
 * the service role (same engine the Finder page and the voice agent use), over
 * OUR projects only, returning the single best project not already sent and not
 * the ad's project the lead passed on.
 *
 * Ranking is 100% the engine's (group order: exact district → nearby → same city
 * → broader; then band/score). We only choose WHICH requirements to send, down
 * the same relaxation ladder the voice agent uses — an empty answer is a dead
 * end in a chat just as on a call.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { findMatchingProjects, FINDER_GROUP_KEYS } from '../projectFinder.js';
import type { MatchRequirements } from '../matchAgent.js';
import { normalizeUnitType, type Slots } from './decide.js';

export interface ProjectPick {
  /** all_projects (master) id — what the send flow and the sent log use. */
  projectId: string;
  projectName: string;
  /** A region was asked for and this project is outside it (closest we have). */
  outsideZone: boolean;
  /** What had to be widened to find it, or null for an exact match. */
  relaxed: string | null;
}

export const IN_ZONE_GROUPS = new Set(['exact_district_matches', 'nearby_district_matches']);

export interface Master { id: string; data: Record<string, unknown> }

/** Resolve a Finder match id to the all_projects master row. For source
 *  'our_projects' the engine may hand back either the our_projects record or the
 *  master — resolve defensively instead of assuming. */
export async function makeMasterResolver(svc: SupabaseClient): Promise<(id: string) => Promise<Master | null>> {
  const { data: models, error } = await svc.from('models').select('id, name').in('name', ['all_projects', 'our_projects']);
  if (error) throw new Error(`sales agent: models lookup failed: ${error.message}`);
  const apId = (models ?? []).find((m) => m.name === 'all_projects')?.id as string | undefined;
  const opId = (models ?? []).find((m) => m.name === 'our_projects')?.id as string | undefined;
  const cache = new Map<string, Master | null>();
  const readRow = async (id: string) => {
    const { data: row, error: rErr } = await svc.from('records').select('id, model_id, data').eq('id', id).maybeSingle();
    if (rErr) throw new Error(`sales agent: project lookup failed: ${rErr.message}`);
    return row as { id: string; model_id: string; data: Record<string, unknown> } | null;
  };
  return async (id: string) => {
    if (cache.has(id)) return cache.get(id)!;
    const r = await readRow(id);
    let master: Master | null = null;
    // Guard `r` AND the model ids: an empty models lookup must not make
    // `undefined === undefined` read a missing row as a match.
    if (r && apId && r.model_id === apId) master = { id: r.id, data: r.data ?? {} };
    else if (r && opId && r.model_id === opId) {
      const link = r.data?.project;
      const masterId = typeof link === 'string' ? link : Array.isArray(link) && typeof link[0] === 'string' ? link[0] : null;
      const m = masterId ? await readRow(masterId) : null;
      if (m && m.model_id === apId) master = { id: m.id, data: m.data ?? {} };
    }
    cache.set(id, master);
    return master;
  };
}

export function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[,\s]/g, '')) : NaN;
  return Number.isFinite(n) ? n : null;
}
export function range(v: unknown): { min: number | null; max: number | null } {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  return { min: num(o.min), max: num(o.max) };
}

export interface FitCheck {
  /** Customer's wanted types (agent labels). Empty = any. */
  types: string[];
  /** true: the project MUST list one of `types`; false: an unlisted type passes. */
  strictType: boolean;
  checkType: boolean;
  bedroomsMin: number | null;
  budgetMax: number | null;
  /** With a budget: an unknown available price does NOT count as within it. */
  requireKnownPrice?: boolean;
}

/**
 * Does the project's OWN data fit what the customer asked? The Finder matches
 * our projects loosely (type/bedrooms only break ties), so its "exact" group can
 * hold a project that has none of the asked unit type — on 2026-09-29 an
 * apartment ask got أكنان 25 (floors/villas only) while ريّا النخيل (apartments,
 * 1–3 bedrooms) was there. Missing data never disqualifies except under
 * strictType; a sold-out project (0 available) always does.
 */
export function projectFits(data: Record<string, unknown>, f: FitCheck): boolean {
  const available = num(data.available_units);
  if (available !== null && available <= 0) return false;
  if (f.checkType && f.types.length) {
    const raw = Array.isArray(data.unit_types) ? data.unit_types : [];
    const known = new Set(raw.filter((x): x is string => typeof x === 'string').map(normalizeUnitType).filter((x): x is string => !!x));
    if (known.size === 0 ? f.strictType : !f.types.some((t) => known.has(t))) return false;
  }
  if (f.bedroomsMin) {
    const beds = range(data.bedroom_range);
    if (beds.max !== null && beds.max < f.bedroomsMin) return false;
  }
  if (f.budgetMax) {
    const price = range(data.available_price_range);
    if (price.min === null ? f.requireKnownPrice === true : price.min > f.budgetMax) return false;
  }
  return true;
}

export async function findBestProject(
  svc: SupabaseClient,
  slots: Slots,
  exclude: string[],
): Promise<ProjectPick | null> {
  const city = slots.city ?? 'الرياض';
  const base: MatchRequirements = { city };

  // Region → concrete districts, deterministically (curated override, else the
  // coordinate bands) — exactly what /api/project-finder does for {city, zone}.
  if (slots.zone) {
    const { data: zoneRows, error } = await svc.rpc('wassell_city_zone_districts', { p_city: city, p_zone: slots.zone });
    if (error) throw new Error(`sales agent: zone → districts failed: ${error.message}`);
    const rows = (zoneRows ?? []) as Array<{ district_id: string; district_name: string }>;
    if (rows.length) {
      base.zone = slots.zone;
      base.district_ids = rows.map((r) => r.district_id).filter(Boolean);
      base.districts = rows.map((r) => r.district_name).filter(Boolean);
      if (base.districts.length) base.district = base.districts[0];
    }
  }

  const types = slots.unit_types ?? [];
  const exact: MatchRequirements = { ...base };
  if (types.length) { exact.property_types = types; exact.property_type = types[0]; }
  if (slots.bedrooms_min) exact.bedrooms = slots.bedrooms_min;
  if (slots.budget_max) exact.budget_max = slots.budget_max;

  const beds = slots.bedrooms_min ?? null;
  const budget = slots.budget_max ?? null;
  const fit = (o: Partial<FitCheck>): FitCheck =>
    ({ types, strictType: false, checkType: true, bedroomsMin: beds, budgetMax: budget, ...o });

  // Ladder: first a project that LISTS the asked type, then one whose type is
  // unrecorded, then any type (said honestly), then widened specs/budget.
  const attempts: Array<{ req: MatchRequirements; relaxed: string | null; check: FitCheck }> = [
    { req: exact, relaxed: null, check: fit({ strictType: true }) },
    { req: exact, relaxed: null, check: fit({}) },
  ];
  if (types.length) {
    const { property_type: _a, property_types: _b, ...noType } = exact;
    attempts.push({ req: noType, relaxed: 'unit_type', check: fit({ checkType: false }) });
  }
  if (beds || budget) {
    const wide: MatchRequirements = { ...base };
    const wideBudget = budget ? Math.round(budget * 1.15) : null;
    if (wideBudget) wide.budget_max = wideBudget;
    attempts.push({
      req: wide, relaxed: 'specs_and_budget',
      check: fit({ checkType: false, bedroomsMin: null, budgetMax: wideBudget }),
    });
  }

  const toMaster = await makeMasterResolver(svc);
  const excluded = new Set(exclude);
  const finderCache = new Map<MatchRequirements, Awaited<ReturnType<typeof findMatchingProjects>>>();

  for (const attempt of attempts) {
    let out = finderCache.get(attempt.req);
    if (!out) {
      out = await findMatchingProjects(svc, attempt.req, { perGroup: 10, sources: ['our_projects'], locale: 'ar' });
      finderCache.set(attempt.req, out);
    }
    // A Finder failure must fail the TURN (and be retried), never read as "nothing
    // matches" — telling a customer we have nothing because a query timed out is
    // a lie. The caller's job wrapper records it.
    if (!out.ok) throw new Error(`sales agent: finder failed: ${out.error}`);
    for (const g of FINDER_GROUP_KEYS) {
      for (const m of out.result.groups[g] ?? []) {
        const master = await toMaster(m.project_id);
        if (!master || excluded.has(master.id)) continue;
        if (!projectFits(master.data, attempt.check)) continue;
        return {
          projectId: master.id,
          projectName: m.project_name,
          outsideZone: !!slots.zone && !!base.district_ids?.length && !IN_ZONE_GROUPS.has(g),
          relaxed: attempt.relaxed,
        };
      }
    }
  }
  return null;
}
