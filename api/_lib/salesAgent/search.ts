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
import type { Slots } from './decide.js';

export interface ProjectPick {
  /** all_projects (master) id — what the send flow and the sent log use. */
  projectId: string;
  projectName: string;
  /** A region was asked for and this project is outside it (closest we have). */
  outsideZone: boolean;
  /** What had to be widened to find it, or null for an exact match. */
  relaxed: string | null;
}

const IN_ZONE_GROUPS = new Set(['exact_district_matches', 'nearby_district_matches']);

/** Resolve a Finder match id to the all_projects master id. For source
 *  'our_projects' the engine may hand back either the our_projects record or the
 *  master — resolve defensively instead of assuming. */
async function makeMasterResolver(svc: SupabaseClient): Promise<(id: string) => Promise<string | null>> {
  const { data: models, error } = await svc.from('models').select('id, name').in('name', ['all_projects', 'our_projects']);
  if (error) throw new Error(`sales agent: models lookup failed: ${error.message}`);
  const apId = (models ?? []).find((m) => m.name === 'all_projects')?.id as string | undefined;
  const opId = (models ?? []).find((m) => m.name === 'our_projects')?.id as string | undefined;
  const cache = new Map<string, string | null>();
  return async (id: string) => {
    if (cache.has(id)) return cache.get(id)!;
    const { data: row, error: rErr } = await svc.from('records').select('id, model_id, data').eq('id', id).maybeSingle();
    if (rErr) throw new Error(`sales agent: project lookup failed: ${rErr.message}`);
    let master: string | null = null;
    const r = row as { id: string; model_id: string; data: Record<string, unknown> } | null;
    // Guard `r` AND the model ids: an empty models lookup must not make
    // `undefined === undefined` read a missing row as a match.
    if (r && apId && r.model_id === apId) master = r.id;
    else if (r && opId && r.model_id === opId) {
      const link = r.data?.project;
      master = typeof link === 'string' ? link : Array.isArray(link) && typeof link[0] === 'string' ? link[0] : null;
    }
    cache.set(id, master);
    return master;
  };
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

  const attempts: Array<{ req: MatchRequirements; relaxed: string | null }> = [{ req: exact, relaxed: null }];
  if (types.length) {
    const { property_type: _a, property_types: _b, ...noType } = exact;
    attempts.push({ req: noType, relaxed: 'unit_type' });
  }
  if (slots.bedrooms_min || slots.budget_max) {
    const wide: MatchRequirements = { ...base };
    if (slots.budget_max) wide.budget_max = Math.round(slots.budget_max * 1.15);
    attempts.push({ req: wide, relaxed: 'specs_and_budget' });
  }

  const toMaster = await makeMasterResolver(svc);
  const excluded = new Set(exclude);

  for (const attempt of attempts) {
    const out = await findMatchingProjects(svc, attempt.req, { perGroup: 10, sources: ['our_projects'], locale: 'ar' });
    // A Finder failure must fail the TURN (and be retried), never read as "nothing
    // matches" — telling a customer we have nothing because a query timed out is
    // a lie. The caller's job wrapper records it.
    if (!out.ok) throw new Error(`sales agent: finder failed: ${out.error}`);
    for (const g of FINDER_GROUP_KEYS) {
      for (const m of out.result.groups[g] ?? []) {
        const master = await toMaster(m.project_id);
        if (!master || excluded.has(master)) continue;
        return {
          projectId: master,
          projectName: m.project_name,
          outsideZone: !!slots.zone && !!base.district_ids?.length && !IN_ZONE_GROUPS.has(g),
          relaxed: attempt.relaxed,
        };
      }
    }
  }
  return null;
}
