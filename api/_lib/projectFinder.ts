/**
 * Project Finder — the deterministic real-estate matching engine.
 *
 * ONE focused capability: given a client's requirements, find and RANK the right
 * projects. The selection, scoring, and ranking are 100% deterministic code
 * (matchProjectsCore + scoreProject in matchAgent.ts, geography boundary-verified
 * via geoVerify.ts + the PostGIS districts_for_points RPC). NO AI decides which
 * project is best, scores a project, or changes the ranking.
 *
 * This module is the thin layer that:
 *   1. runs the deterministic core (PostGIS verification ON),
 *   2. buckets the scored candidates into the four location-centric groups, and
 *   3. attaches a deterministic templated explanation to each match.
 *
 * The optional LLM (api/_lib/projectFinderAI.ts) may ONLY (a) parse messy text
 * into requirements BEFORE this runs, and (b) replace the `explanation` string
 * AFTER this runs — never the score, band, source, match_type, or order. The
 * endpoint enforces that with assertRankingUnchanged().
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  matchProjectsCore,
  type MatchCoreSuccess,
  type MatchRequirements,
  type MatchResultItem,
  type MatchSource,
} from './matchAgent.js';
import type { GeoStatus } from './geoVerify.js';

export type { MatchSource } from './matchAgent.js';

export type FinderGroupKey =
  | 'exact_district_matches'
  | 'nearby_district_matches'
  | 'same_city_matches'
  | 'broader_fallback';

export const FINDER_GROUP_KEYS: FinderGroupKey[] = [
  'exact_district_matches',
  'nearby_district_matches',
  'same_city_matches',
  'broader_fallback',
];

export type FinderBand = 'strong' | 'good' | 'partial' | 'weak';
export type FinderMatchType = 'exact' | 'nearby' | 'same_city' | 'fallback';

export interface FinderMatch {
  project_id: string;
  project_name: string;
  source: MatchSource;
  score: number;
  match_band: FinderBand;
  match_type: FinderMatchType;
  group: FinderGroupKey;
  distance_km: number | null;
  geo_confidence: string | null;
  geo_status: GeoStatus | null;
  data_gaps: string[];
  mismatch_warnings: string[];
  /** The verified facts the score was computed from (price/area/beds/baths/etc.). */
  facts: Record<string, unknown>;
  /** Per-dimension subscores (transparency). */
  score_breakdown: Record<string, number | null>;
  /** Short sales-friendly explanation. Deterministic by default; the endpoint may
   *  REPLACE the text with an LLM-written one (never the ranking fields). */
  explanation: string;
}

export interface FinderResult {
  requirements: MatchRequirements;
  groups: Record<FinderGroupKey, FinderMatch[]>;
  metadata: {
    total_candidates: number;
    req_district_resolved: boolean;
    district_requested: boolean;
    counts: Record<FinderGroupKey, number>;
    source_counts: Record<MatchSource, number>;
    /** Geo-verification breakdown across the SHOWN matches. */
    geo_counts: Record<GeoStatus | 'unknown', number>;
    missing_required_preferences: string[];
    notes: string[];
  };
}

export interface FinderOptions {
  perGroup?: number;
  /** Which sources to include. Default: all three. */
  sources?: MatchSource[];
}

// ── pure helpers ────────────────────────────────────────────────────────────

const BAND_RANK: Record<FinderBand, number> = { strong: 0, good: 1, partial: 2, weak: 3 };

function asNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Map the engine's band + geo signals to the finder's 4-band scale. A 'partial'
 *  match with low/no geo confidence or that needs verification is the weakest. */
export function finderBand(item: MatchResultItem): FinderBand {
  if (item.match_band === 'strong') return 'strong';
  if (item.match_band === 'good') return 'good';
  const lowGeo =
    item.geo_confidence === 'low' ||
    item.geo_status === 'no_geography' ||
    item.geo_status === 'mismatch' ||
    item.geo_status === 'outside_known_districts' ||
    item.requires_verification === true;
  return lowGeo ? 'weak' : 'partial';
}

/** Decide which of the four groups a scored item belongs to, and its finder
 *  match_type. District-exactness only counts when a district was requested. */
export function finderGroupFor(
  item: MatchResultItem,
  districtRequested: boolean,
): { group: FinderGroupKey; match_type: FinderMatchType } {
  // 'partial' band = neither a good location nor a good overall fit → fallback.
  if (item.match_band === 'partial') return { group: 'broader_fallback', match_type: 'fallback' };

  switch (item.location_tier) {
    case 'exact':
      // A district-level exact only when the client actually asked for a district.
      // A city-only request that lands "exact" is really a same-city result.
      return districtRequested
        ? { group: 'exact_district_matches', match_type: 'exact' }
        : { group: 'same_city_matches', match_type: 'same_city' };
    case 'nearby':
      return { group: 'nearby_district_matches', match_type: 'nearby' };
    case 'same_city':
      return { group: 'same_city_matches', match_type: 'same_city' };
    default:
      return { group: 'broader_fallback', match_type: 'fallback' };
  }
}

const SOURCE_LABEL: Record<MatchSource, string> = {
  our_projects: 'our portfolio',
  all_projects: 'the broad projects database (verify before offering)',
  market_listings: 'external market listings (verify before offering)',
};

/** Deterministic, fact-grounded explanation. NO invention — only what the scorer
 *  verified. The LLM may later REPLACE this string, but never the ranking. */
export function buildExplanation(m: {
  match_type: FinderMatchType;
  match_band: FinderBand;
  source: MatchSource;
  distance_km: number | null;
  geo_confidence: string | null;
  facts: Record<string, unknown>;
  data_gaps: string[];
  mismatch_warnings: string[];
}): string {
  const parts: string[] = [];
  const district = typeof m.facts.district === 'string' ? m.facts.district : null;
  const city = typeof m.facts.city === 'string' ? m.facts.city : null;

  switch (m.match_type) {
    case 'exact':
      parts.push(
        district
          ? `In the requested district (${district})${m.geo_confidence === 'high' ? ', coordinate-verified' : ''}.`
          : 'In the requested location.',
      );
      break;
    case 'nearby':
      parts.push(
        m.distance_km != null
          ? `About ${m.distance_km} km from the requested district${district ? ` (in ${district})` : ''}.`
          : 'A nearby alternative.',
      );
      break;
    case 'same_city':
      parts.push(city ? `In the same city (${city}), different district.` : 'In the same city.');
      break;
    default:
      parts.push('Broader-search result — outside the requested area.');
  }

  const price = m.facts.price_range as { min?: number; max?: number } | undefined;
  if (price && (asNum(price.min) != null || asNum(price.max) != null)) {
    const lo = asNum(price.min);
    const hi = asNum(price.max);
    if (lo != null && hi != null && lo !== hi) parts.push(`Price ${Math.round(lo).toLocaleString()}–${Math.round(hi).toLocaleString()} SAR.`);
    else parts.push(`Price ~${Math.round((lo ?? hi)!).toLocaleString()} SAR.`);
  }
  const avail = asNum(m.facts.available_units);
  if (avail != null && avail > 0) parts.push(`${avail} unit(s) available.`);

  if (m.match_band === 'weak') parts.push('Weak fit — review carefully.');
  if (m.source !== 'our_projects') parts.push(`Source: ${SOURCE_LABEL[m.source]}.`);
  if (m.mismatch_warnings.length) parts.push(m.mismatch_warnings[0]!);
  if (m.data_gaps.includes('missing_project_coordinates')) parts.push('No map pin — district not coordinate-verified.');

  return parts.join(' ');
}

function toFinderMatch(item: MatchResultItem, districtRequested: boolean): FinderMatch {
  const { group, match_type } = finderGroupFor(item, districtRequested);
  const band = finderBand(item);
  const mismatch = item.mismatch_warnings ?? [];
  const geo_status = item.geo_status ?? null;
  const explanation = buildExplanation({
    match_type,
    match_band: band,
    source: item.data_source,
    distance_km: item.distance_km,
    geo_confidence: item.geo_confidence,
    facts: item.facts,
    data_gaps: item.data_gaps,
    mismatch_warnings: mismatch,
  });
  return {
    project_id: item.project_id,
    project_name: item.project_name,
    source: item.data_source,
    score: item.score,
    match_band: band,
    match_type,
    group,
    distance_km: item.distance_km,
    geo_confidence: item.geo_confidence,
    geo_status,
    data_gaps: item.data_gaps,
    mismatch_warnings: mismatch,
    facts: item.facts,
    score_breakdown: item.score_breakdown,
    explanation,
  };
}

/**
 * Pure grouping: scored candidates → the four location-centric finder groups.
 * Deterministic. Exported for tests. The ranking order is set HERE (code), never
 * by an LLM.
 */
export function groupForFinder(
  core: MatchCoreSuccess,
  req: MatchRequirements,
  opts: FinderOptions = {},
): FinderResult {
  const perGroup = opts.perGroup ?? 8;
  const sources = opts.sources ?? ['our_projects', 'all_projects', 'market_listings'];
  const districtRequested = !!(req.district || (req.districts && req.districts.length));

  const pool: MatchResultItem[] = [];
  if (sources.includes('our_projects')) pool.push(...core.our);
  if (sources.includes('all_projects')) pool.push(...core.all);
  if (sources.includes('market_listings')) pool.push(...core.market);

  const groups: Record<FinderGroupKey, FinderMatch[]> = {
    exact_district_matches: [],
    nearby_district_matches: [],
    same_city_matches: [],
    broader_fallback: [],
  };

  for (const item of pool) {
    const m = toFinderMatch(item, districtRequested);
    groups[m.group].push(m);
  }

  // Rank within each group (deterministic). Nearby is ranked by REAL distance
  // (closest first), nulls last; everything else by band then score.
  const byBandScore = (a: FinderMatch, b: FinderMatch) =>
    BAND_RANK[a.match_band] - BAND_RANK[b.match_band] || b.score - a.score || a.project_name.localeCompare(b.project_name);
  groups.nearby_district_matches.sort(
    (a, b) =>
      (a.distance_km ?? Number.POSITIVE_INFINITY) - (b.distance_km ?? Number.POSITIVE_INFINITY) ||
      b.score - a.score,
  );
  groups.exact_district_matches.sort(byBandScore);
  groups.same_city_matches.sort(byBandScore);
  groups.broader_fallback.sort(byBandScore);

  const counts = {} as Record<FinderGroupKey, number>;
  for (const k of FINDER_GROUP_KEYS) {
    counts[k] = groups[k].length;
    groups[k] = groups[k].slice(0, perGroup);
  }

  const source_counts: Record<MatchSource, number> = { our_projects: 0, all_projects: 0, market_listings: 0 };
  const geo_counts = {} as Record<GeoStatus | 'unknown', number>;
  for (const k of FINDER_GROUP_KEYS) {
    for (const m of groups[k]) {
      source_counts[m.source] += 1;
      const key = (m.geo_status ?? 'unknown') as GeoStatus | 'unknown';
      geo_counts[key] = (geo_counts[key] ?? 0) + 1;
    }
  }

  return {
    requirements: req,
    groups,
    metadata: {
      total_candidates: pool.length,
      req_district_resolved: !!core.reqDistrictId,
      district_requested: districtRequested,
      counts,
      source_counts,
      geo_counts,
      missing_required_preferences: missingPreferences(req),
      notes: core.notes,
    },
  };
}

/** REQUIRED preferences that are missing — drives the UI's "add preferences" hint. */
export function missingPreferences(req: MatchRequirements): string[] {
  const missing: string[] = [];
  if (req.budget_min == null && req.budget_max == null) missing.push('budget');
  if (!req.district && !(req.districts && req.districts.length) && !req.city) missing.push('location');
  if (!req.property_type) missing.push('unit_type');
  if (req.bedrooms == null) missing.push('bedrooms');
  return missing;
}

/** True when the requirements carry at least one matchable preference. With none,
 *  every available project scores 100 on availability alone — not a recommendation. */
export function hasAnyCriteria(req: MatchRequirements): boolean {
  return !!(
    req.district ||
    (req.districts && req.districts.length) ||
    req.city ||
    req.property_type ||
    req.budget_min != null ||
    req.budget_max != null ||
    req.area_min != null ||
    req.area_max != null ||
    req.bedrooms != null ||
    req.bathrooms != null ||
    (req.amenities && req.amenities.length > 0)
  );
}

/**
 * The single deterministic entry point. Runs the boundary-verified core and groups
 * the results. NO AI. (The endpoint wraps this with optional LLM parse/explain.)
 */
export async function findMatchingProjects(
  supabase: SupabaseClient,
  req: MatchRequirements,
  opts: FinderOptions = {},
): Promise<{ ok: true; result: FinderResult } | { ok: false; error: string }> {
  const core = await matchProjectsCore(supabase, req, {
    alwaysScoreAll: true,
    includeMarket: (opts.sources ?? ['our_projects', 'all_projects', 'market_listings']).includes('market_listings'),
    verifyGeo: true,
  });
  if (!core.ok) return { ok: false, error: core.error };
  return { ok: true, result: groupForFinder(core, req, opts) };
}
