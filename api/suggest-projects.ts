/**
 * POST /api/suggest-projects
 *
 * DETERMINISTIC project recommendations for the Wassel Sales Assistant's
 * "Suggested Projects" modal. This endpoint runs the SAME scoring brain as the
 * `match_projects` tool (api/_lib/matchAgent.matchProjectsCore) but WITHOUT any
 * Anthropic call — it groups the scored candidates into the five sales-facing
 * buckets, labels each with data_confidence + data_gaps, computes the
 * missing-preference warnings, and writes one audit row. "Algorithm decides; AI
 * explains" — the LLM chat (the modal's right pane) still runs through /api/match
 * for narration / pitch / compare, grounded in these results.
 *
 * Input (JSON):
 *   {
 *     requirements: MatchRequirements,   // city/district/property_type/budget/area/bedrooms/amenities
 *     client_id?: string,                // the lead (audit only)
 *     followup_id?: string,              // the follow-up record (audit only)
 *     used_draft_values?: boolean,       // ran against unsaved follow-up edits
 *     perGroup?: number                  // max projects per group (default 8)
 *   }
 *
 * Auth: the caller's Supabase JWT (RLS-scoped) — the salesperson only matches
 * projects they can see, exactly like /api/match.
 */

import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import { matchProjectsCore, type MatchRequirements } from './_lib/matchAgent.js';
import { groupMatchResults, SUGGESTION_GROUP_KEYS, type GroupedSuggestions } from './_lib/suggestGroups.js';

export const config = { runtime: 'edge' };

interface SuggestBody {
  requirements?: Partial<MatchRequirements>;
  client_id?: string;
  followup_id?: string;
  used_draft_values?: boolean;
  perGroup?: number;
}

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const strArr = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : undefined;

/** Coerce the untrusted body.requirements into a clean MatchRequirements. */
function normalizeRequirements(raw: Partial<MatchRequirements> | undefined): MatchRequirements {
  const r = raw ?? {};
  const out: MatchRequirements = {};
  const city = str(r.city); if (city) out.city = city;
  const district = str(r.district); if (district) out.district = district;
  const propertyType = str(r.property_type); if (propertyType) out.property_type = propertyType;
  const budgetMin = num(r.budget_min); if (budgetMin != null) out.budget_min = budgetMin;
  const budgetMax = num(r.budget_max); if (budgetMax != null) out.budget_max = budgetMax;
  const areaMin = num(r.area_min); if (areaMin != null) out.area_min = areaMin;
  const areaMax = num(r.area_max); if (areaMax != null) out.area_max = areaMax;
  const bedrooms = num(r.bedrooms); if (bedrooms != null) out.bedrooms = bedrooms;
  const lifestyle = strArr(r.lifestyle); if (lifestyle?.length) out.lifestyle = lifestyle;
  const amenities = strArr(r.amenities); if (amenities?.length) out.amenities = amenities;
  if (r.include_sold_out === true) out.include_sold_out = true;
  if (r.allow_stretch === false) out.allow_stretch = false;
  return out;
}

/** Which REQUIRED preferences are missing — drives the modal's warning banner. */
function missingPreferences(req: MatchRequirements): string[] {
  const missing: string[] = [];
  if (req.budget_min == null && req.budget_max == null) missing.push('budget');
  if (!req.district && !req.city) missing.push('location');
  if (!req.property_type) missing.push('unit_type');
  if (req.bedrooms == null) missing.push('bedrooms');
  return missing;
}

function allProjectIds(grouped: GroupedSuggestions): string[] {
  const ids: string[] = [];
  for (const key of SUGGESTION_GROUP_KEYS) {
    for (const item of grouped.groups[key]) ids.push(item.project_id);
  }
  return ids;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async (user) => {
    let body: SuggestBody;
    try {
      body = (await req.json()) as SuggestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }

    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) return jsonError(500, 'Supabase env vars missing');

    // RLS-scoped to the caller — only projects/clients they can see.
    const jwt = (req.headers.get('Authorization') ?? '').slice(7).trim();
    const supabase = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    const requirements = normalizeRequirements(body.requirements);
    const usedDraftValues = body.used_draft_values === true;

    // No criteria → no recommendation. With zero requirements the scorer can only
    // grade availability, which makes EVERY in-stock project a meaningless 100/strong
    // "match". That's not a recommendation — it's the whole catalogue. Short-circuit
    // to an empty result + `needs_preferences` so the UI asks for preferences instead
    // of showing misleading strong matches. (No audit row — nothing was recommended.)
    const hasCriteria = !!(
      requirements.district ||
      requirements.city ||
      requirements.property_type ||
      requirements.budget_min != null ||
      requirements.budget_max != null ||
      requirements.area_min != null ||
      requirements.area_max != null ||
      requirements.bedrooms != null ||
      (requirements.amenities && requirements.amenities.length > 0)
    );
    if (!hasCriteria) {
      const emptyGroups = Object.fromEntries(SUGGESTION_GROUP_KEYS.map((k) => [k, []]));
      const zeroCounts = Object.fromEntries(SUGGESTION_GROUP_KEYS.map((k) => [k, 0]));
      return jsonOk({
        client_preferences_summary: {
          requirements,
          missing_required_preferences: missingPreferences(requirements),
        },
        groups: emptyGroups,
        metadata: {
          total_candidates: 0,
          used_fallback: false,
          used_legacy_fallback: false,
          req_district_resolved: false,
          counts: zeroCounts,
          used_draft_values: usedDraftValues,
          needs_preferences: true,
          generated_at: new Date().toISOString(),
        },
      });
    }

    // Show all THREE sources side by side (our_projects + market_listings +
    // all_projects), each labelled by source — not the LLM tool's fallback-gated view.
    const core = await matchProjectsCore(supabase, requirements, { alwaysScoreAll: true, includeMarket: true });
    if (!core.ok) {
      // Surface loudly (never silently swallow) but keep a renderable shape.
      console.error('[suggest-projects] match core failed:', core.error);
      return jsonError(502, `matching failed: ${core.error}`);
    }

    const grouped = groupMatchResults(core, requirements, { perGroup: num(body.perGroup) ?? 8 });
    const missing = missingPreferences(requirements);
    const projectIds = allProjectIds(grouped);

    const response = {
      client_preferences_summary: {
        requirements,
        missing_required_preferences: missing,
      },
      groups: grouped.groups,
      metadata: {
        ...grouped.metadata,
        used_draft_values: usedDraftValues,
        generated_at: new Date().toISOString(),
      },
    };

    // Audit log — best-effort. Surface failures to the server log (never silently
    // swallow), but don't fail the user's recommendation on an audit write.
    const { error: auditErr } = await supabase.from('assistant_recommendation_runs').insert({
      client_id: str(body.client_id) ?? null,
      followup_id: str(body.followup_id) ?? null,
      input_preferences: requirements,
      result_summary: { counts: grouped.metadata.counts, metadata: response.metadata },
      result_project_ids: projectIds,
      used_draft_values: usedDraftValues,
      used_legacy_fallback: grouped.metadata.used_legacy_fallback,
      created_by: user.userId,
    });
    if (auditErr) {
      console.error('[suggest-projects] audit insert failed:', auditErr.message);
    }

    return jsonOk(response);
  });
}
