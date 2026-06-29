/**
 * Attach deal-quality badges to Project Finder matches (Market Intelligence).
 *
 * PURELY ADDITIVE + POST-RANKING: this runs AFTER findMatchingProjects and the
 * assertRankingUnchanged guard, and only sets the non-ranking `deal` field on
 * each FinderMatch. It cannot change score / band / source / match_type / order.
 *
 * It reads market_benchmarks (asking, latest snapshot, 'all' bedrooms) for the
 * districts present in the result, then classifies each candidate's price/m²
 * against that segment via the shared deterministic computeDealBadge().
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FinderResult, FinderMatch } from './projectFinder.js';
import { FINDER_GROUP_KEYS } from './projectFinder.js';
import { canonPropertyType } from '../../src/lib/market/propertyType.js';
import { computeDealBadge, type BenchmarkSlice, type FinderSource } from '../../src/lib/market/dealBadge.js';

function asNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
}

/** price/m² from a match's facts (price_range / area_range; single-unit listings have min==max). */
function ppm2FromFacts(facts: Record<string, unknown>): { ppm2: number | null; hasPrice: boolean; hasArea: boolean } {
  const pr = facts.price_range as { min?: unknown; max?: unknown } | undefined;
  const ar = facts.area_range as { min?: unknown; max?: unknown } | undefined;
  const price = pr ? asNum(pr.min) ?? asNum(pr.max) : null;
  const area = ar ? asNum(ar.min) ?? asNum(ar.max) : null;
  const hasPrice = price != null && price > 0;
  const hasArea = area != null && area > 0;
  const ppm2 = hasPrice && hasArea ? (price as number) / (area as number) : null;
  return { ppm2, hasPrice, hasArea };
}

/** Canonical type for a match: prefer its own unit_types, else the requirement. */
function canonForMatch(facts: Record<string, unknown>, reqType: string | undefined): string {
  const types = facts.unit_types;
  if (Array.isArray(types) && types.length && typeof types[0] === 'string') return canonPropertyType(types[0]);
  if (reqType) return canonPropertyType(reqType);
  return 'أخرى';
}

function districtName(facts: Record<string, unknown>): string | null {
  const d = facts.district;
  return typeof d === 'string' && d.trim() !== '' ? d.trim() : null;
}

export async function enrichWithDealBadges(
  supabase: SupabaseClient,
  result: FinderResult,
): Promise<void> {
  // Collect the district names present across all shown matches.
  const names = new Set<string>();
  for (const k of FINDER_GROUP_KEYS) for (const m of result.groups[k]) {
    const n = districtName(m.facts);
    if (n) names.add(n);
  }
  if (names.size === 0) return;

  const snapRow = await supabase.from('market_benchmarks').select('snapshot_date').order('snapshot_date', { ascending: false }).limit(1).maybeSingle();
  const snap = (snapRow.data?.snapshot_date as string) ?? null;
  if (!snap) return;

  // Benchmarks for those districts (match by AR or EN name). 'all' bedrooms, asking.
  const list = [...names];
  const { data, error } = await supabase
    .from('market_benchmarks')
    .select('district_name, district_name_en, property_type, p25_price_per_sqm, p75_price_per_sqm, median_price_per_sqm, deduped_count, duplicate_ratio, confidence_grade, transaction_count')
    .eq('snapshot_date', snap).eq('source_type', 'asking').eq('bedrooms_bucket', 'all')
    .or(list.map((n) => `district_name.eq.${n},district_name_en.eq.${n}`).join(','));
  if (error || !data) return;

  // index by `${name}|${canon_type}` for both AR and EN names.
  const idx = new Map<string, BenchmarkSlice>();
  for (const r of data as Array<Record<string, unknown>>) {
    const slice: BenchmarkSlice = {
      p25_price_per_sqm: asNum(r.p25_price_per_sqm),
      p75_price_per_sqm: asNum(r.p75_price_per_sqm),
      median_price_per_sqm: asNum(r.median_price_per_sqm),
      deduped_count: asNum(r.deduped_count) ?? 0,
      duplicate_ratio: asNum(r.duplicate_ratio) ?? 0,
      confidence_grade: (r.confidence_grade as 'high' | 'medium' | 'low') ?? 'low',
      has_transaction: (asNum(r.transaction_count) ?? 0) > 0,
    };
    const pt = String(r.property_type);
    if (r.district_name) idx.set(`${r.district_name}|${pt}`, slice);
    if (r.district_name_en) idx.set(`${r.district_name_en}|${pt}`, slice);
  }

  const reqType = (result.requirements.property_type as string | undefined) ?? undefined;
  for (const k of FINDER_GROUP_KEYS) {
    for (const m of result.groups[k]) applyBadge(m, idx, reqType);
  }
}

function applyBadge(m: FinderMatch, idx: Map<string, BenchmarkSlice>, reqType: string | undefined): void {
  const name = districtName(m.facts);
  const canon = canonForMatch(m.facts, reqType);
  const benchmark = name ? idx.get(`${name}|${canon}`) ?? null : null;
  const { ppm2, hasPrice, hasArea } = ppm2FromFacts(m.facts);
  m.deal = computeDealBadge({
    source: m.source as FinderSource,
    pricePerSqm: ppm2,
    hasPrice,
    hasArea,
    geoVerified: m.geo_status === 'exact',
    typeMatchesBenchmark: benchmark != null,
    benchmark,
  });
}
