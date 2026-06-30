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
  type MarketInfo,
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
  /** Decision-support deal-quality badge (Market Intelligence). NON-ranking — attached
   *  by the endpoint AFTER ranking + the assertRankingUnchanged guard, so it can never
   *  influence score/band/source/match_type/order. */
  deal?: import('../../src/lib/market/dealBadge.js').DealBadge;
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
    /** Market-source status — lets the UI be honest when market wasn't fully scanned
     *  (too dense → ask for more criteria) instead of silently showing a subset. */
    market: MarketInfo;
  };
}

export interface FinderOptions {
  /** Max results per group. Default 8. Pass 0 (or negative) for UNLIMITED — no cap. */
  perGroup?: number;
  /** Only keep matches scoring >= this (0–100). Omit for the engine floor (MIN_RETURN). */
  minScore?: number;
  /** Which sources to include. Default: our_projects + all_projects (the
   *  boundary-verified catalog). `market_listings` is OPT-IN — it's external/
   *  unverified and its area scan can be slow for ultra-dense districts. */
  sources?: MatchSource[];
  /** Language for the deterministic explanation string. Default 'en'. */
  locale?: 'ar' | 'en';
}

/** Default finder sources — the verified project catalog, market opt-in. */
export const DEFAULT_FINDER_SOURCES: MatchSource[] = ['our_projects', 'all_projects'];

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

/** Entry price per m² (from the match's facts) — used as a BEST-VALUE tiebreaker
 *  (lower = better value) when many matches tie on band+score. null when unknown
 *  (sorted last). Within a district this equals "most below the benchmark median". */
function matchPpm2(m: FinderMatch): number | null {
  const pr = m.facts.price_range as { min?: unknown } | undefined;
  const ar = m.facts.area_range as { min?: unknown } | undefined;
  const price = pr ? asNum(pr.min) : null;
  const area = ar ? asNum(ar.min) : null;
  return price != null && price > 0 && area != null && area > 0 ? price / area : null;
}
const ppm2Asc = (a: FinderMatch, b: FinderMatch) =>
  (matchPpm2(a) ?? Number.POSITIVE_INFINITY) - (matchPpm2(b) ?? Number.POSITIVE_INFINITY);

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

const SOURCE_LABEL: Record<'ar' | 'en', Record<MatchSource, string>> = {
  en: {
    our_projects: 'our portfolio',
    all_projects: 'the broad projects database (verify before offering)',
    market_listings: 'external market listings (verify before offering)',
  },
  ar: {
    our_projects: 'مشاريعنا',
    all_projects: 'قاعدة كل المشاريع (تحقّق قبل العرض)',
    market_listings: 'إعلانات السوق الخارجية (تحقّق قبل العرض)',
  },
};

/** Western-digit number formatting, used for both locales (matches FinderCard). */
const fmtN = (n: number) => Math.round(n).toLocaleString('en-US');

/** Deterministic, fact-grounded explanation. NO invention — only what the scorer
 *  verified. The LLM may later REPLACE this string, but never the ranking.
 *  Bilingual: `locale` defaults to 'en' so existing callers/tests are unchanged. */
export function buildExplanation(
  m: {
    match_type: FinderMatchType;
    match_band: FinderBand;
    source: MatchSource;
    distance_km: number | null;
    geo_confidence: string | null;
    facts: Record<string, unknown>;
    data_gaps: string[];
    mismatch_warnings: string[];
  },
  locale: 'ar' | 'en' = 'en',
): string {
  const ar = locale === 'ar';
  const parts: string[] = [];
  const district = typeof m.facts.district === 'string' ? m.facts.district : null;
  const city = typeof m.facts.city === 'string' ? m.facts.city : null;

  switch (m.match_type) {
    case 'exact':
      if (ar) {
        parts.push(
          district
            ? `في الحي المطلوب (${district})${m.geo_confidence === 'high' ? ' — موثّق بالإحداثيات' : ''}.`
            : 'في الموقع المطلوب.',
        );
      } else {
        parts.push(
          district
            ? `In the requested district (${district})${m.geo_confidence === 'high' ? ', coordinate-verified' : ''}.`
            : 'In the requested location.',
        );
      }
      break;
    case 'nearby':
      if (ar) {
        parts.push(
          m.distance_km != null
            ? `يبعد حوالي ${m.distance_km} كم عن الحي المطلوب${district ? ` (في ${district})` : ''}.`
            : 'بديل قريب.',
        );
      } else {
        parts.push(
          m.distance_km != null
            ? `About ${m.distance_km} km from the requested district${district ? ` (in ${district})` : ''}.`
            : 'A nearby alternative.',
        );
      }
      break;
    case 'same_city':
      if (ar) parts.push(city ? `في نفس المدينة (${city})، حي مختلف.` : 'في نفس المدينة.');
      else parts.push(city ? `In the same city (${city}), different district.` : 'In the same city.');
      break;
    default:
      parts.push(ar ? 'نتيجة بحث موسّع — خارج المنطقة المطلوبة.' : 'Broader-search result — outside the requested area.');
  }

  const price = m.facts.price_range as { min?: number; max?: number } | undefined;
  if (price && (asNum(price.min) != null || asNum(price.max) != null)) {
    const lo = asNum(price.min);
    const hi = asNum(price.max);
    const cur = ar ? 'ر.س' : 'SAR';
    if (lo != null && hi != null && lo !== hi) parts.push(ar ? `السعر ${fmtN(lo)}–${fmtN(hi)} ${cur}.` : `Price ${fmtN(lo)}–${fmtN(hi)} ${cur}.`);
    else parts.push(ar ? `السعر ~${fmtN((lo ?? hi)!)} ${cur}.` : `Price ~${fmtN((lo ?? hi)!)} ${cur}.`);
  }
  const avail = asNum(m.facts.available_units);
  if (avail != null && avail > 0) parts.push(ar ? `${avail} وحدة متاحة.` : `${avail} unit(s) available.`);

  if (m.match_band === 'weak') parts.push(ar ? 'ملاءمة ضعيفة — يرجى المراجعة بعناية.' : 'Weak fit — review carefully.');
  if (m.source !== 'our_projects') parts.push(ar ? `المصدر: ${SOURCE_LABEL.ar[m.source]}.` : `Source: ${SOURCE_LABEL.en[m.source]}.`);
  if (m.mismatch_warnings.length) parts.push(m.mismatch_warnings[0]!);
  if (m.data_gaps.includes('missing_project_coordinates')) {
    parts.push(ar ? 'لا يوجد موقع على الخريطة — الحي غير موثّق بالإحداثيات.' : 'No map pin — district not coordinate-verified.');
  }

  return parts.join(' ');
}

function toFinderMatch(item: MatchResultItem, districtRequested: boolean, locale: 'ar' | 'en'): FinderMatch {
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
  }, locale);
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
  const minScore = opts.minScore ?? null;
  const sources = opts.sources ?? DEFAULT_FINDER_SOURCES;
  const locale = opts.locale ?? 'en';
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
    // Score floor (e.g. "show all options ≥ 70"). The engine already drops < MIN_RETURN;
    // this is an optional stricter, caller-set threshold.
    if (minScore != null && item.score < minScore) continue;
    const m = toFinderMatch(item, districtRequested, locale);
    groups[m.group].push(m);
  }

  // Rank within each group (deterministic). Nearby is ranked by REAL distance
  // (closest first), nulls last; everything else by band then score.
  // Band → score → BEST VALUE (cheapest price/m² first) → name. The ppm2 tiebreaker
  // makes a large "all ≥ N" list usefully ordered when many candidates tie on score.
  const byBandScore = (a: FinderMatch, b: FinderMatch) =>
    BAND_RANK[a.match_band] - BAND_RANK[b.match_band] || b.score - a.score ||
    ppm2Asc(a, b) || a.project_name.localeCompare(b.project_name);
  groups.nearby_district_matches.sort(
    (a, b) =>
      (a.distance_km ?? Number.POSITIVE_INFINITY) - (b.distance_km ?? Number.POSITIVE_INFINITY) ||
      b.score - a.score || ppm2Asc(a, b),
  );
  groups.exact_district_matches.sort(byBandScore);
  groups.same_city_matches.sort(byBandScore);
  groups.broader_fallback.sort(byBandScore);

  const counts = {} as Record<FinderGroupKey, number>;
  for (const k of FINDER_GROUP_KEYS) {
    counts[k] = groups[k].length;
    // perGroup <= 0 → UNLIMITED (return every match in the group).
    if (perGroup > 0) groups[k] = groups[k].slice(0, perGroup);
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
      market: core.marketInfo,
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
    includeMarket: (opts.sources ?? DEFAULT_FINDER_SOURCES).includes('market_listings'),
    verifyGeo: true,
  });
  if (!core.ok) return { ok: false, error: core.error };
  return { ok: true, result: groupForFinder(core, req, opts) };
}
