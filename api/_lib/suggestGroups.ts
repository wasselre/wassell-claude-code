/**
 * Deterministic grouping layer for the Wassel Sales Assistant's "Suggested
 * Projects" view. Takes the SCORED candidates produced by
 * `matchProjectsCore` (api/_lib/matchAgent.ts) and buckets them into the five
 * sales-facing groups, assigning an honest `data_confidence` and a normalized
 * `data_gaps` list to every project.
 *
 * This is PURE (no DB, no LLM) — "Algorithm decides; AI explains." The grouping
 * is honest about the sparse data reality of the live DB:
 *   - 0 of ~978 projects have lat/lng → distance is district-CENTROID based,
 *     never project-pin based (distance_basis says so).
 *   - only ~11 of ~978 projects have linked units → price/unit rollups are
 *     usually absent. We NEVER fabricate budget confidence: a project with no
 *     price never enters `budget_matches`; the gap is surfaced instead.
 *
 * Bucketing recipe (each project lands in exactly one group):
 *   strong geography (exact) + within budget (or no budget asked) → exact_matches
 *   nearby district / same-city within distance, acceptable score  → nearby_alternatives
 *   reliable price AND within budget, geography not exact          → budget_matches
 *   strong geography but price missing / over budget               → location_matches
 *   all_projects fallback / needs verification / legacy-text / weak → fallback_matches
 */

import type { MatchCoreSuccess, MatchRequirements, MatchResultItem, MatchSource } from './matchAgent.js';

export type SuggestionGroupKey =
  | 'exact_matches'
  | 'nearby_alternatives'
  | 'budget_matches'
  | 'location_matches'
  | 'fallback_matches';

export const SUGGESTION_GROUP_KEYS: SuggestionGroupKey[] = [
  'exact_matches',
  'nearby_alternatives',
  'budget_matches',
  'location_matches',
  'fallback_matches',
];

export type DataConfidence = 'high' | 'medium' | 'low';
export type BudgetFit = 'within' | 'above' | 'below' | 'unknown';

/** Machine-readable gap codes — the UI localizes them to Arabic/English. */
export type DataGapCode =
  | 'missing_price_range'
  | 'missing_unit_types'
  | 'missing_area_range'
  | 'missing_bedroom_range'
  | 'missing_unit_inventory'
  | 'missing_project_coordinates'
  | 'legacy_text_match_only'
  | 'requires_verification';

/** Reason codes — the UI localizes them; `sales_reason` is a plain-English
 *  rendering kept for the audit log / non-UI consumers. */
export type ReasonCode =
  | 'exact_district'
  | 'exact_within_budget'
  | 'nearby_distance'
  | 'budget_fit'
  | 'strong_location_no_price'
  | 'strong_location_over_budget'
  | 'fallback_verify'
  | 'fallback_weak'
  | 'no_criteria';

export interface SuggestionItem {
  project_id: string;
  project_name: string;
  data_source: MatchSource;
  requires_verification: boolean;
  score: number;
  match_band: 'strong' | 'good' | 'partial';
  match_type: MatchResultItem['match_type'];
  group: SuggestionGroupKey;
  data_confidence: DataConfidence;
  data_gaps: DataGapCode[];
  /** Distance to the requested district's CENTROID (km), when computable. */
  distance_km: number | null;
  distance_basis: 'district_centroid' | null;
  budget_fit: BudgetFit;
  reason_code: ReasonCode;
  /** Plain-English reason for the audit log / API consumers. UI uses reason_code. */
  sales_reason: string;
  /** Present, non-empty project facts (price_range, area_range, available_units, …). */
  facts: Record<string, unknown>;
  score_breakdown: Record<string, number | null>;
  verification_warning?: string;
}

export interface GroupedSuggestions {
  groups: Record<SuggestionGroupKey, SuggestionItem[]>;
  metadata: {
    total_candidates: number;
    used_fallback: boolean;
    /** True when the requested district wasn't in the SPL set OR any project
     *  matched via legacy free text rather than the district_lookup id. */
    used_legacy_fallback: boolean;
    req_district_resolved: boolean;
    /** False when the client has NO matchable preference at all (no location,
     *  budget, type, area, or bedrooms). Then results are general available
     *  inventory, NOT matched to the client — the UI must say so. */
    has_criteria: boolean;
    counts: Record<SuggestionGroupKey, number>;
    /** How many of the SHOWN results came from each source (drives the source filter). */
    source_counts: Record<MatchSource, number>;
  };
}

export interface GroupOptions {
  /** Max projects per group (default 8). */
  perGroup?: number;
}

// project_status values from the live DB that mean "no longer selling" — these
// can never be exact/nearby/budget; they drop to fallback and read low-confidence.
const INACTIVE_STATUSES = new Set(['sold_out']);
// Ambiguous statuses that should NOT earn high data_confidence on their own.
const UNCLEAR_STATUSES = new Set(['unknown', '']);

const HUMAN_GAP_TO_CODE: Record<string, DataGapCode> = {
  'no price data': 'missing_price_range',
  'no unit type data': 'missing_unit_types',
  'no area data': 'missing_area_range',
  'no bedroom data': 'missing_bedroom_range',
  'no availability data': 'missing_unit_inventory',
};

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function asNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Extract a {min,max} from a facts value (range object or flat number). */
function pickRange(v: unknown): { min: number | null; max: number | null } | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const min = asNum(o.min);
    const max = asNum(o.max);
    if (min == null && max == null) return null;
    return { min, max };
  }
  const flat = asNum(v);
  return flat != null ? { min: flat, max: flat } : null;
}

function computeBudgetFit(req: MatchRequirements, priceRange: { min: number | null; max: number | null } | null): BudgetFit {
  const hasBudget = req.budget_min != null || req.budget_max != null;
  if (!hasBudget || !priceRange) return 'unknown';
  const pmin = priceRange.min ?? priceRange.max ?? 0;
  const pmax = priceRange.max ?? priceRange.min ?? pmin;
  const lo = req.budget_min ?? 0;
  const hi = req.budget_max ?? Number.POSITIVE_INFINITY;
  if (pmax >= lo && pmin <= hi) return 'within';
  if (pmin > hi) return 'above';
  return 'below';
}

function buildGaps(item: MatchResultItem, req: MatchRequirements, priceKnown: boolean): DataGapCode[] {
  const codes = new Set<DataGapCode>();
  for (const g of item.data_gaps) {
    const code = HUMAN_GAP_TO_CODE[g];
    if (code) codes.add(code);
  }
  if (!priceKnown) codes.add('missing_price_range');
  if (asNum(item.facts.available_units) == null && asNum(item.facts.unit_count) == null) {
    codes.add('missing_unit_inventory');
  }
  if (item.requires_verification || item.data_source === 'all_projects') codes.add('requires_verification');
  if (item.district_match_basis === 'text') codes.add('legacy_text_match_only');
  // No project has lat/lng yet, so when a location was requested and this isn't an
  // exact district hit, we couldn't pin-rank it — surface that honestly.
  if ((req.district || req.city) && item.match_type !== 'exact' && item.distance_km == null) {
    codes.add('missing_project_coordinates');
  }
  return [...codes];
}

function computeConfidence(item: MatchResultItem, status: string, priceKnown: boolean, unitKnown: boolean): DataConfidence {
  if (
    item.requires_verification ||
    item.data_source === 'all_projects' ||
    item.match_band === 'partial' ||
    item.district_match_basis === 'text' ||
    INACTIVE_STATUSES.has(status)
  ) {
    return 'low';
  }
  const active = !!status && !UNCLEAR_STATUSES.has(status) && !INACTIVE_STATUSES.has(status);
  if (item.district_match_basis === 'lookup' && active && priceKnown && unitKnown) return 'high';
  return 'medium';
}

function pickBucket(
  item: MatchResultItem,
  req: MatchRequirements,
  status: string,
  priceKnown: boolean,
  fit: BudgetFit,
): SuggestionGroupKey {
  // Honest fallbacks first. NOTE: SOURCE is orthogonal to quality — an
  // all_projects / market_listings result is bucketed by how well it MATCHES
  // (and badged with its source + a verify banner), not auto-dumped to fallback.
  // Only a sold-out/inactive project or a genuinely weak (partial) match falls back.
  if (INACTIVE_STATUSES.has(status)) return 'fallback_matches';
  if (item.match_band === 'partial') return 'fallback_matches';

  const hasBudgetReq = req.budget_min != null || req.budget_max != null;

  if (item.match_type === 'exact') {
    if (!hasBudgetReq) return 'exact_matches';
    if (priceKnown && (fit === 'within' || fit === 'below')) return 'exact_matches';
    // Exact geography but price missing or over budget → still a strong location.
    return 'location_matches';
  }

  // Non-exact (nearby / same_city / stretch).
  if (priceKnown && fit === 'above') return 'location_matches'; // over budget anywhere
  if (priceKnown && (fit === 'within' || fit === 'below')) return 'budget_matches';
  if (item.match_type === 'nearby') return 'nearby_alternatives';
  return 'location_matches'; // same-city / stretch, price unknown
}

function reasonFor(group: SuggestionGroupKey, item: MatchResultItem, fit: BudgetFit): { code: ReasonCode; text: string } {
  switch (group) {
    case 'exact_matches':
      return fit === 'within' || fit === 'below'
        ? { code: 'exact_within_budget', text: 'Exact location match and within budget.' }
        : { code: 'exact_district', text: 'Exact location match for the requested district.' };
    case 'nearby_alternatives':
      return {
        code: 'nearby_distance',
        text: item.distance_km != null
          ? `Nearby — about ${item.distance_km} km from the requested district.`
          : 'Nearby alternative in the same area.',
      };
    case 'budget_matches':
      return { code: 'budget_fit', text: 'Reliable pricing that fits the budget.' };
    case 'location_matches':
      return fit === 'above'
        ? { code: 'strong_location_over_budget', text: 'Strong location, but priced above the budget — confirm flexibility.' }
        : { code: 'strong_location_no_price', text: 'Strong location match; pricing/unit data is missing — verify before offering.' };
    case 'fallback_matches':
    default:
      return item.requires_verification || item.data_source === 'all_projects'
        ? { code: 'fallback_verify', text: 'From the broad database — verify details before offering.' }
        : { code: 'fallback_weak', text: 'Partial match — weaker fit or missing key data.' };
  }
}

/**
 * Group + label the scored candidates from matchProjectsCore. Pure & deterministic.
 */
export function groupMatchResults(
  core: MatchCoreSuccess,
  req: MatchRequirements,
  opts: GroupOptions = {},
): GroupedSuggestions {
  const perGroup = opts.perGroup ?? 8;
  const groups: Record<SuggestionGroupKey, SuggestionItem[]> = {
    exact_matches: [],
    nearby_alternatives: [],
    budget_matches: [],
    location_matches: [],
    fallback_matches: [],
  };

  // Does the client have ANY matchable preference? With none, the only dimension
  // scoreProject can apply is `availability`, which renormalizes to 100/strong —
  // so EVERY available project looks like a "strong match". That's misleading: it
  // matched nothing about the client. In that case we present everything as honest
  // fallback ("available inventory, not matched") so the UI can't claim a match.
  const hasAnyCriteria = !!(
    req.district || req.city || req.property_type ||
    (req.districts && req.districts.length) ||
    (req.cities && req.cities.length) ||
    (req.property_types && req.property_types.length) ||
    req.budget_min != null || req.budget_max != null ||
    req.area_min != null || req.area_max != null || req.bedrooms != null
  );

  // All three sources, each carrying its own data_source label: our_projects
  // (curated) first, then market_listings (external ads), then the broad
  // all_projects DB. Quality buckets are source-agnostic; the card shows the source.
  const candidates = [...core.our, ...core.market, ...core.all];
  let anyTextMatch = false;

  for (const item of candidates) {
    const status = asStr(item.facts.project_status);
    const priceRange = pickRange(item.facts.price_range);
    const priceKnown = priceRange != null;
    const unitKnown = asNum(item.facts.available_units) != null || asNum(item.facts.unit_count) != null;
    const fit = computeBudgetFit(req, priceRange);
    if (item.district_match_basis === 'text') anyTextMatch = true;

    let group = pickBucket(item, req, status, priceKnown, fit);
    let reason = reasonFor(group, item, fit);
    let confidence = computeConfidence(item, status, priceKnown, unitKnown);
    let band = item.match_band;
    if (!hasAnyCriteria) {
      // No criteria → honest fallback, never a "strong match".
      group = 'fallback_matches';
      reason = { code: 'no_criteria', text: 'No preferences set — general available inventory, not matched to this client.' };
      confidence = 'low';
      band = 'partial';
    }

    groups[group].push({
      project_id: item.project_id,
      project_name: item.project_name,
      data_source: item.data_source,
      requires_verification: item.requires_verification === true || item.data_source === 'all_projects',
      score: item.score,
      match_band: band,
      match_type: item.match_type,
      group,
      data_confidence: confidence,
      data_gaps: buildGaps(item, req, priceKnown),
      distance_km: item.distance_km,
      distance_basis: item.distance_km != null ? 'district_centroid' : null,
      budget_fit: fit,
      reason_code: reason.code,
      sales_reason: reason.text,
      facts: item.facts,
      score_breakdown: item.score_breakdown,
      ...(item.verification_warning ? { verification_warning: item.verification_warning } : {}),
    });
  }

  // Cap each group; the source lists are already sorted by band then score.
  const counts = {} as Record<SuggestionGroupKey, number>;
  for (const key of SUGGESTION_GROUP_KEYS) {
    counts[key] = groups[key].length;
    groups[key] = groups[key].slice(0, perGroup);
  }

  // Per-source counts across the SHOWN (post-slice) results — drives the source filter.
  const source_counts: Record<MatchSource, number> = { our_projects: 0, all_projects: 0, market_listings: 0 };
  for (const key of SUGGESTION_GROUP_KEYS) {
    for (const it of groups[key]) source_counts[it.data_source] += 1;
  }

  return {
    groups,
    metadata: {
      total_candidates: candidates.length,
      used_fallback: core.used_fallback,
      used_legacy_fallback: (!!req.district && !core.reqDistrictId) || anyTextMatch,
      req_district_resolved: !!core.reqDistrictId,
      has_criteria: hasAnyCriteria,
      counts,
      source_counts,
    },
  };
}

export const __test = { groupMatchResults, computeBudgetFit, pickBucket, computeConfidence, buildGaps };
