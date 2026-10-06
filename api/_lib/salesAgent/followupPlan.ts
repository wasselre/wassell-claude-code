/**
 * What a WhatsApp follow-up is ABOUT — decided in code, before the writer
 * writes (operator, 2026-10-06):
 *
 *   1. A project the client is interested in (interest score > 15) → ask about it.
 *   2. Several → the highest score wins.
 *   3. None above 15 → either suggest a NEW project that fits the client's saved
 *      needs (the sales agent's project search, inside their saved places), or —
 *      when the needs are too thin to search, or nothing new fits — say «if those
 *      didn't suit you we have other options» and ask for the missing
 *      preferences, saying we need them to send the best fit.
 *   4. When the client's PREVIOUS AI follow-up asked about a project (1 or 2),
 *      this one goes straight to 3.
 *
 * The interest score is v_client_project_interest.score: link engagement plus
 * asked (15) / wants (25) / appointment (40) / visit (50) — weights in
 * ai_automation_settings.interest_weights.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { searchProjects, type SearchCriteria } from './catalog.js';
import { matchSavedPlaces } from './geoGate.js';
import { profileLine } from './savedProfile.js';
import type { RequestGap } from '../../../src/lib/clients/requestReadiness.js';

export const INTEREST_THRESHOLD = 15;
/** Option statuses that mean «don't bring this project up again». */
export const DEAD_OPTION = new Set(['not_interested', 'eliminated', 'closed']);

export interface InterestCandidate { projectId: string; score: number }

/** What the previous AI follow-up to this client was about (ai_actions.context.focus). */
export interface FollowupFocus {
  mode: 'project' | 'new_project' | 'preferences';
  project_id?: string | null;
  project_name?: string | null;
}

export type PlanChoice =
  | { mode: 'project'; projectId: string; score: number }
  | { mode: 'search' }
  | { mode: 'preferences'; gaps: RequestGap[] };

/**
 * PURE — steps 1, 2 and 4, and whether step 3 can search. `deadIds` = projects
 * the client turned down (options marked not interested / eliminated / closed).
 */
export function choosePlan(args: {
  candidates: readonly InterestCandidate[];
  deadIds: ReadonlySet<string>;
  lastFocus: FollowupFocus | null;
  gaps: RequestGap[];
}): PlanChoice {
  if (args.lastFocus?.mode !== 'project') {
    const best = args.candidates
      .filter((c) => c.score > INTEREST_THRESHOLD && !args.deadIds.has(c.projectId))
      .sort((a, b) => b.score - a.score)[0];
    if (best) return { mode: 'project', projectId: best.projectId, score: best.score };
  }
  return args.gaps.length === 0 ? { mode: 'search' } : { mode: 'preferences', gaps: args.gaps };
}

/** PURE — the client's saved preferences as search criteria (the active profile's flat fields). */
export function criteriaFromClient(d: Record<string, unknown>): SearchCriteria {
  const lo = (v: unknown): number | null => {
    const n = v && typeof v === 'object' ? Number((v as { min?: unknown }).min) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const hi = (v: unknown): number | null => {
    const n = v && typeof v === 'object' ? Number((v as { max?: unknown }).max) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const types = Array.isArray(d.preferred_unit_type)
    ? d.preferred_unit_type.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    : typeof d.preferred_unit_type === 'string' && d.preferred_unit_type.trim() ? [d.preferred_unit_type] : [];
  const readiness = Array.isArray(d.preferred_readiness) && d.preferred_readiness.length === 1
    ? d.preferred_readiness[0] : null;
  return {
    unit_types: types,
    bedrooms_min: lo(d.preferred_bedrooms),
    budget_max: hi(d.budget),
    area_min: lo(d.preferred_area),
    readiness: readiness === 'ready' || readiness === 'off_plan' ? readiness : null,
  };
}

export interface NewProject {
  projectId: string; name: string; district: string | null;
  readiness: 'ready' | 'off_plan' | null; priceFrom: number | null;
}

/**
 * Step 3's search: the best project of OURS inside the client's saved places
 * that fits their saved needs and is not one we already sent / they already
 * have / turned down. null = nothing new fits. A search failure throws — the
 * caller decides; it must never read as «nothing fits».
 */
export async function findNewProject(
  svc: SupabaseClient, clientData: Record<string, unknown>, exclude: readonly string[],
): Promise<NewProject | null> {
  const criteria = criteriaFromClient(clientData);
  const { items, placeLabels } = profileLine(clientData);
  const area = await matchSavedPlaces(svc, items, placeLabels);
  // Saved places that hold none of our projects: nothing to suggest there.
  if (!area.ids || area.ids.size === 0) return null;
  criteria.area_ids = [...area.ids];
  const r = await searchProjects(svc, criteria, { exclude: [...exclude] });
  const p = r.projects.find((x) => !exclude.includes(x.project_id));
  if (!p) return null;
  return { projectId: p.project_id, name: p.name, district: p.district, readiness: p.readiness === 'ready' || p.readiness === 'off_plan' ? p.readiness : null, priceFrom: p.price_from };
}

/** Arabic names of the missing preferences, for the writer. */
export function gapLabels(gaps: readonly RequestGap[]): string[] {
  return gaps.map((g) => (g === 'unit_type' ? 'نوع الوحدة (شقة / فيلا / دور / تاون هاوس)' : g === 'districts' ? 'الحي أو المنطقة' : 'الميزانية أو عدد الغرف أو المساحة'));
}
