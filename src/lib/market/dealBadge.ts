/**
 * Deterministic deal-quality badge engine for the Project Finder (Market Intelligence).
 *
 * ZERO AI. Given a candidate's price/m² and the precomputed benchmark for its
 * district × canonical type, classify it against the asking-market percentiles.
 * This is decision-support ONLY: it never changes Finder ranking/score/order
 * (the assertRankingUnchanged guard still holds — badges are attached AFTER ranking).
 *
 * Honesty rules (spec §10), enforced here:
 *  • "strong_value" requires price+area, a computable price/m², a geo-verified
 *    district, a property type that matches the benchmark segment, and a
 *    medium/high-confidence benchmark — only then, price/m² ≤ P25.
 *  • A low-confidence benchmark can never yield "strong_value" → "potential_value".
 *  • Missing price/area → explicit missing_* badge (never a value verdict).
 *  • No benchmark for the segment → "no_benchmark" (never a fake verdict).
 *  • External / unverified-catalog sources always carry verify_before_offering.
 */

import type { ConfidenceGrade } from './types';

export type DealBadgeKind =
  | 'strong_value'      // ≤ P25, confident benchmark, geo-verified
  | 'fair_market'       // between P25 and P75
  | 'premium_price'     // ≥ P75
  | 'potential_value'   // looks cheap but benchmark/geo too weak to confirm → verify
  | 'thin_market'       // benchmark too thin/low-confidence to judge
  | 'no_benchmark'      // no benchmark segment exists
  | 'missing_price'     // candidate has no price
  | 'missing_area';     // candidate has no area

export type FinderSource = 'our_projects' | 'all_projects' | 'market_listings';

export interface BenchmarkSlice {
  p25_price_per_sqm: number | null;
  p75_price_per_sqm: number | null;
  median_price_per_sqm: number | null;
  deduped_count: number;
  duplicate_ratio: number;
  confidence_grade: ConfidenceGrade;
  has_transaction: boolean;
}

export interface DealBadgeInput {
  source: FinderSource;
  pricePerSqm: number | null;
  hasPrice: boolean;
  hasArea: boolean;
  /** District resolved/boundary-verified for this candidate. */
  geoVerified: boolean;
  /** The candidate's canonical type matches the benchmark's segment type. */
  typeMatchesBenchmark: boolean;
  /** Benchmark for this candidate's district × canonical type, or null if none. */
  benchmark: BenchmarkSlice | null;
}

export interface DealBadge {
  kind: DealBadgeKind;
  /** Confidence of the *benchmark* this verdict rests on (null when N/A). */
  confidence: ConfidenceGrade | null;
  /** External/unverified source → must be checked before offering to a client. */
  verify_before_offering: boolean;
  /** Benchmark has transaction support (stronger) vs asking-only. */
  transaction_supported: boolean;
  asking_only: boolean;
  /** Benchmark carries meaningful duplicate risk. */
  possible_duplicate: boolean;
  /** Candidate price/m² vs benchmark median, as a signed % (null when N/A). */
  vs_median_pct: number | null;
}

const DUPLICATE_RISK = 0.4;

export function computeDealBadge(input: DealBadgeInput): DealBadge {
  const { source, pricePerSqm, hasPrice, hasArea, geoVerified, typeMatchesBenchmark, benchmark } = input;

  // verify-before-offering: only our verified portfolio is exempt.
  const verify = source !== 'our_projects';
  const asking_only = !!benchmark && !benchmark.has_transaction;
  const transaction_supported = !!benchmark && benchmark.has_transaction;
  const possible_duplicate = !!benchmark && benchmark.duplicate_ratio > DUPLICATE_RISK;

  const base = {
    confidence: benchmark?.confidence_grade ?? null,
    verify_before_offering: verify,
    transaction_supported,
    asking_only,
    possible_duplicate,
    vs_median_pct: null as number | null,
  };

  // Hard gates first — never emit a value verdict on missing data.
  if (!hasPrice) return { ...base, kind: 'missing_price' };
  if (!hasArea || pricePerSqm == null || !Number.isFinite(pricePerSqm) || pricePerSqm <= 0) {
    return { ...base, kind: 'missing_area' };
  }
  if (!benchmark || !typeMatchesBenchmark) return { ...base, kind: 'no_benchmark' };

  const { p25_price_per_sqm: p25, p75_price_per_sqm: p75, median_price_per_sqm: med, confidence_grade } = benchmark;
  if (p25 == null || p75 == null) return { ...base, kind: 'no_benchmark' };

  const vs_median_pct = med && med > 0 ? ((pricePerSqm - med) / med) * 100 : null;
  const out = { ...base, vs_median_pct };

  // Low-confidence benchmark: cannot make a confident verdict.
  if (confidence_grade === 'low') {
    return { ...out, kind: pricePerSqm <= p25 ? 'potential_value' : 'thin_market' };
  }

  // Confident benchmark, but geography unverified → can't certify "strong value".
  if (pricePerSqm <= p25) {
    return { ...out, kind: geoVerified ? 'strong_value' : 'potential_value' };
  }
  if (pricePerSqm >= p75) return { ...out, kind: 'premium_price' };
  return { ...out, kind: 'fair_market' };
}

/** Bilingual labels for a badge kind (PDF / non-i18n use; the SPA uses i18n keys). */
export const DEAL_BADGE_LABELS: Record<DealBadgeKind, { ar: string; en: string }> = {
  strong_value:    { ar: 'قيمة قوية', en: 'Strong value' },
  fair_market:     { ar: 'سعر سوقي عادل', en: 'Fair market' },
  premium_price:   { ar: 'سعر مرتفع', en: 'Premium price' },
  potential_value: { ar: 'قيمة محتملة — يلزم التحقق', en: 'Potential value — verify' },
  thin_market:     { ar: 'بيانات سوق محدودة', en: 'Thin market' },
  no_benchmark:    { ar: 'لا يوجد مرجع سعري', en: 'No benchmark' },
  missing_price:   { ar: 'السعر غير متوفر', en: 'Missing price' },
  missing_area:    { ar: 'المساحة غير متوفرة', en: 'Missing area' },
};

export function dealBadgeLabel(kind: DealBadgeKind, isAr: boolean): string {
  const m = DEAL_BADGE_LABELS[kind];
  return isAr ? m.ar : m.en;
}

/** A coarse tone for styling: positive / neutral / caution / negative / unknown. */
export function dealBadgeTone(kind: DealBadgeKind): 'good' | 'neutral' | 'warn' | 'high' | 'unknown' {
  switch (kind) {
    case 'strong_value': return 'good';
    case 'fair_market': return 'neutral';
    case 'premium_price': return 'high';
    case 'potential_value': return 'warn';
    case 'thin_market':
    case 'no_benchmark':
    case 'missing_price':
    case 'missing_area': return 'unknown';
  }
}
