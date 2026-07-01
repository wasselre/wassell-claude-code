/**
 * POST /api/project-finder
 *
 * The Project Finder endpoint. ONE job: find + rank the right projects for a
 * client's requirements. The selection/scoring/ranking is 100% DETERMINISTIC
 * (findMatchingProjects → matchProjectsCore, geography PostGIS-verified). The LLM
 * is OPTIONAL and bounded to two things only:
 *   - parse:   messy `text` → structured requirements (BEFORE ranking).
 *   - explain: short per-match explanation (AFTER ranking).
 * After the explanation step the server runs assertRankingUnchanged() — the LLM
 * physically cannot change score/band/source/match_type/order. No next-best-action,
 * no lead temperature, no task creation, no message drafting, no AI-picked projects.
 *
 * Input (JSON):
 *   {
 *     requirements?: MatchRequirements,  // explicit structured prefs (win over parsed)
 *     text?: string,                     // free text to parse into requirements (opt-in via parse)
 *     parse?: boolean,                   // run the LLM text parser (default: true when text given)
 *     explain?: boolean,                 // run the LLM explanation writer (default: true)
 *     sources?: ('our_projects'|'all_projects'|'market_listings')[],
 *     client_id?: string, followup_id?: string,  // audit only
 *     perGroup?: number
 *   }
 *
 * Auth: the caller's Supabase JWT (RLS-scoped) — a salesperson only matches the
 * projects they can see.
 */

import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import type { MatchRequirements } from './_lib/matchAgent.js';
import {
  findMatchingProjects,
  hasAnyCriteria,
  missingPreferences,
  FINDER_GROUP_KEYS,
  DEFAULT_FINDER_SOURCES,
  type MatchSource,
} from './_lib/projectFinder.js';
import { parseRequirements, explainMatches, applyLlmExplanations } from './_lib/projectFinderAI.js';
import { enrichWithDealBadges } from './_lib/marketBadge.js';

export const config = { runtime: 'edge' };

interface FinderBody {
  requirements?: Partial<MatchRequirements>;
  text?: string;
  parse?: boolean;
  explain?: boolean;
  sources?: string[];
  locale?: string;
  client_id?: string;
  followup_id?: string;
  perGroup?: number;
  minScore?: number;
  /**
   * The client's CURRENT location_items (district + geo-element rules) as the user
   * is editing them — may differ from the saved record. When present, the geo gate
   * compiles from THESE (via wassell_compile_geo_items) so an unsaved "south of the
   * road" edit filters to the south immediately. Omitted → compile from the saved
   * record (wassell_compile_client_geo).
   */
  location_items?: unknown;
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

const VALID_SOURCES: MatchSource[] = ['our_projects', 'all_projects', 'market_listings'];

/** Clean the untrusted body.requirements into a trusted MatchRequirements. */
function normalizeRequirements(raw: Partial<MatchRequirements> | undefined): MatchRequirements {
  const r = raw ?? {};
  const out: MatchRequirements = {};
  const city = str(r.city); if (city) out.city = city;
  const district = str(r.district); if (district) out.district = district;
  const districts = strArr(r.districts); if (districts?.length) { out.districts = districts; if (!out.district) out.district = districts[0]; }
  const districtIds = strArr(r.district_ids); if (districtIds?.length) out.district_ids = districtIds;
  const zone = str(r.zone); if (zone) out.zone = zone;
  const pt = str(r.property_type); if (pt) out.property_type = pt;
  const bmin = num(r.budget_min); if (bmin != null) out.budget_min = bmin;
  const bmax = num(r.budget_max); if (bmax != null) out.budget_max = bmax;
  const amin = num(r.area_min); if (amin != null) out.area_min = amin;
  const amax = num(r.area_max); if (amax != null) out.area_max = amax;
  const beds = num(r.bedrooms); if (beds != null) out.bedrooms = beds;
  const baths = num(r.bathrooms); if (baths != null) out.bathrooms = baths;
  const amenities = strArr(r.amenities); if (amenities?.length) out.amenities = amenities;
  if (r.include_sold_out === true) out.include_sold_out = true;
  if (r.allow_stretch === false) out.allow_stretch = false;
  return out;
}

/** Merge parsed-from-text requirements (base) with explicit ones (override). */
function mergeRequirements(parsed: MatchRequirements, explicit: MatchRequirements): MatchRequirements {
  const merged: MatchRequirements = { ...parsed, ...explicit };
  // districts/district stay consistent: explicit districts win; else parsed.
  if (explicit.districts?.length) merged.districts = explicit.districts;
  if (!merged.district && merged.districts?.length) merged.district = merged.districts[0];
  return merged;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async (user) => {
    let body: FinderBody;
    try {
      body = (await req.json()) as FinderBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }

    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) return jsonError(500, 'Supabase env vars missing');

    const jwt = (req.headers.get('Authorization') ?? '').slice(7).trim();
    const supabase = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const explicit = normalizeRequirements(body.requirements);

    // (1) Optional LLM PARSE of free text → requirements (bounded; never picks projects).
    const text = str(body.text);
    const wantParse = body.parse !== false && !!text;
    let parsed: MatchRequirements = {};
    let usedAiParse = false;
    if (wantParse && apiKey) {
      parsed = await parseRequirements(text!, apiKey);
      usedAiParse = Object.keys(parsed).length > 0;
    }
    const requirements = mergeRequirements(parsed, explicit);

    // Directional zone ("north of Riyadh" / "شمال الرياض") → concrete district ids,
    // DETERMINISTICALLY (curated override wins, else geometric centroid bands). The
    // LLM only supplied the words {city, zone}; this expansion is pure SQL. Only when
    // no explicit district was given (an explicit district always wins over a zone).
    if (requirements.zone && requirements.city &&
        !requirements.district_ids?.length && !requirements.districts?.length && !requirements.district) {
      const { data: zoneRows, error: zoneErr } = await supabase.rpc('wassell_city_zone_districts', {
        p_city: requirements.city, p_zone: requirements.zone,
      });
      if (!zoneErr && Array.isArray(zoneRows) && zoneRows.length) {
        requirements.district_ids = zoneRows.map((r: { district_id: string }) => r.district_id).filter(Boolean);
        requirements.districts = zoneRows.map((r: { district_name: string }) => r.district_name).filter(Boolean);
        if (requirements.districts.length) requirements.district = requirements.districts[0];
      }
    }

    // Default to the boundary-verified catalog (our_projects + all_projects).
    // market_listings is OPT-IN via an explicit `sources` (external/unverified +
    // its area scan can exceed the edge timeout for ultra-dense districts).
    const sources = (strArr(body.sources)?.filter((s): s is MatchSource => (VALID_SOURCES as string[]).includes(s)) ??
      DEFAULT_FINDER_SOURCES) as MatchSource[];

    // Language for the deterministic per-card explanation string (default Arabic —
    // this is an Arabic-first app; the caller passes 'en' for the English UI).
    const locale: 'ar' | 'en' = body.locale === 'en' ? 'en' : 'ar';

    // Short-circuit: no matchable preference → ask for preferences (no misleading
    // "everything is a strong match"). No audit row — nothing was recommended.
    if (!hasAnyCriteria(requirements)) {
      const emptyGroups = Object.fromEntries(FINDER_GROUP_KEYS.map((k) => [k, []]));
      return jsonOk({
        requirements,
        groups: emptyGroups,
        metadata: {
          total_candidates: 0,
          needs_preferences: true,
          missing_required_preferences: missingPreferences(requirements),
          used_ai_parse: usedAiParse,
          used_ai_explain: false,
          generated_at: new Date().toISOString(),
        },
      });
    }

    // (1b) Client LOCATION-PREFERENCE gate (deterministic, PostGIS, no AI). When the
    //      client has `location_items` (include/exclude district, within_radius of a
    //      point landmark), compile them and resolve the eligible record ids. The
    //      finder then scores ONLY those candidates (OR-union of items, excludes
    //      subtracted) — it never alters scoreProject's weights. Best-effort: a
    //      compile/match failure is logged and falls back to NO gate (the legacy
    //      requirements-only behavior) rather than silently returning nothing.
    let geoMatchIds: Set<string> | null = null;
    let geoFilter: { applied: boolean; match_count: number; needs_review: number } | null = null;
    const clientId = str(body.client_id);
    if (clientId) {
      // Compile from the DRAFT location_items when the caller supplied them (so an
      // unsaved "south of the road" edit filters immediately); else the saved record.
      const draftItems = Array.isArray(body.location_items) ? body.location_items : null;
      const { data: compiled, error: compileErr } = draftItems
        ? await supabase.rpc('wassell_compile_geo_items', { p_client_id: clientId, p_items: draftItems })
        : await supabase.rpc('wassell_compile_client_geo', { p_client_id: clientId });
      if (compileErr) {
        console.error('[project-finder] geo compile failed:', compileErr.message);
      } else {
        const includes = Number((compiled as { includes?: number } | null)?.includes ?? 0);
        const needsReview = Number((compiled as { needs_review?: number } | null)?.needs_review ?? 0);
        if (includes > 0) {
          // Get the FULL in-area record-id set in ONE call. The row-returning
          // wassell_geo_match is capped at PostgREST's ~1000-row response (the area can
          // be thousands — north-of-King-Salman-Rd = 8046), which silently truncated the
          // gate. wassell_geo_match_ids returns a single uuid[] (one row → no cap), and
          // the underlying scan runs exactly once.
          const { data: idArr, error: matchErr } = await supabase.rpc('wassell_geo_match_ids', {
            p_client_id: clientId,
          });
          if (matchErr) {
            console.error('[project-finder] geo match failed:', matchErr.message);
          } else {
            geoMatchIds = new Set(((idArr as string[] | null) ?? []).filter(Boolean));
            geoFilter = { applied: true, match_count: geoMatchIds.size, needs_review: needsReview };
          }
        } else if (needsReview > 0) {
          // Includes exist but none are usable yet (e.g. unresolved element). Surface
          // it — do NOT gate (would return nothing and read as "no results").
          geoFilter = { applied: false, match_count: 0, needs_review: needsReview };
        }
      }
    }

    // (2) DETERMINISTIC engine — selection, scoring, ranking. No AI.
    // perGroup: 0 = UNLIMITED (show every match). Otherwise default 8.
    const reqPerGroup = num(body.perGroup);
    const finder = await findMatchingProjects(supabase, requirements, {
      perGroup: reqPerGroup != null ? reqPerGroup : 8,
      minScore: num(body.minScore),
      sources,
      locale,
      geoMatchIds,
    });
    if (!finder.ok) {
      console.error('[project-finder] engine failed:', finder.error);
      return jsonError(502, `project finder failed: ${finder.error}`);
    }
    let result = finder.result;

    // (3) Optional LLM EXPLANATION — replaces explanation strings only; the guard
    //     (inside applyLlmExplanations) proves no ranking field moved.
    let usedAiExplain = false;
    if (body.explain !== false && apiKey) {
      const explanations = await explainMatches(result, apiKey);
      if (Object.keys(explanations).length > 0) {
        result = applyLlmExplanations(result, explanations); // throws if ranking changed
        usedAiExplain = true;
      }
    }

    // (4) Deal-quality badges (Market Intelligence) — PURELY ADDITIVE + post-ranking.
    //     Attaches the non-ranking `deal` field; cannot change score/band/order.
    try {
      await enrichWithDealBadges(supabase, result);
    } catch (e) {
      console.error('[project-finder] deal-badge enrichment failed (non-fatal):', e instanceof Error ? e.message : e);
    }

    // Audit (best-effort; never fails the recommendation).
    const projectIds = FINDER_GROUP_KEYS.flatMap((k) => result.groups[k].map((m) => m.project_id));
    const { error: auditErr } = await supabase.from('assistant_recommendation_runs').insert({
      client_id: str(body.client_id) ?? null,
      followup_id: str(body.followup_id) ?? null,
      input_preferences: requirements,
      result_summary: { counts: result.metadata.counts, geo_counts: result.metadata.geo_counts, used_ai_parse: usedAiParse, used_ai_explain: usedAiExplain },
      result_project_ids: projectIds,
      used_draft_values: false,
      used_legacy_fallback: false,
      created_by: user.userId,
    });
    if (auditErr) console.error('[project-finder] audit insert failed:', auditErr.message);

    return jsonOk({
      requirements: result.requirements,
      groups: result.groups,
      metadata: {
        ...result.metadata,
        used_ai_parse: usedAiParse,
        used_ai_explain: usedAiExplain,
        geo_filter: geoFilter,
        generated_at: new Date().toISOString(),
      },
    });
  });
}
