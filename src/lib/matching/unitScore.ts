// PURE per-unit fit scorer for the Project Finder's "suggested units" — the unit
// twin of the server's project scorer (api/_lib/matchAgent.ts scoreProject). The
// finder ranks PROJECTS server-side from rollup ranges; this ranks the UNITS
// inside a matched project against the same client requirements, so each project
// card can surface its best-fitting units (not just aggregate ranges).
//
// It mirrors scoreProject's recipe adapted to a unit's SCALAR facts (one price,
// one area, one bed/bath count, one type, one status) instead of ranges:
//   - a requested dimension the unit has NO data for keeps full weight and earns
//     0 (an unconfirmable requirement drags the score down — never silently
//     dropped), same honesty rule as the project scorer;
//   - a dimension the client didn't ask about is excluded from the average;
//   - availability always applies (intrinsic quality signal).
// No I/O, no React — unit-tested directly.

import type { MatchRequirementsInput } from './requirements';
import type { UnitView } from '@/lib/projects/unitView';
import { normalizeForSearch } from '@/lib/recordSearch';

/** Band cutoffs — same spirit as the project scorer (STRONG 80 / GOOD 60). */
const STRONG = 80;
const GOOD = 60;
/** Above-budget stretch tolerance + under-budget soft floor (mirror scoreProject). */
const STRETCH_TOLERANCE = 1.1;
const BUDGET_FLOOR_TOLERANCE = 0.9;

const WEIGHTS = {
  budget: 30,
  type: 25,
  area: 15,
  bedrooms: 15,
  bathrooms: 5,
  availability: 10,
} as const;
type Dim = keyof typeof WEIGHTS;

export type UnitBand = 'strong' | 'good' | 'partial';

export interface UnitScore {
  unit: UnitView;
  score: number; // 0..100
  band: UnitBand;
  breakdown: Record<string, number | null>;
}

/** Availability credit by unit status. Sold is filtered out before scoring, so it
 *  only appears here defensively. Unknown status → neutral 0.5 (same as the project
 *  scorer's unknown-availability handling). */
function availabilityValue(statusValue: string | null): number {
  switch (statusValue) {
    case 'available':
      return 1;
    case 'reserved':
      return 0.6;
    case 'under_construction':
      return 0.5;
    case 'sold':
      return 0;
    default:
      return 0.5;
  }
}

/** Property-type synonyms so a client's Arabic label matches a unit whose type is
 *  stored as an English value (or vice versa). Normalized on both sides. */
const TYPE_SYNONYMS: string[][] = [
  ['شقة', 'شقق', 'apartment', 'apartments', 'flat', 'flats'],
  ['فيلا', 'فلل', 'villa', 'villas'],
  ['دور', 'أدوار', 'floor', 'floors'],
  ['تاون هاوس', 'تاونهاوس', 'townhouse', 'townhouses'],
  ['دوبلكس', 'دبلكس', 'duplex', 'duplexes'],
  ['بنتهاوس', 'penthouse', 'penthouses'],
  ['استوديو', 'ستوديو', 'studio', 'studios'],
  ['أرض', 'ارض', 'اراضي', 'land', 'lands', 'plot', 'plots'],
];

/** True when the unit's type matches ANY requested type (synonym + substring aware). */
function typeMatches(unitTypeTokens: string[], reqTypes: string[]): boolean {
  const unitNorm = unitTypeTokens.map((t) => normalizeForSearch(t)).filter(Boolean);
  if (unitNorm.length === 0) return false;
  for (const rt of reqTypes) {
    const r = normalizeForSearch(rt);
    if (!r) continue;
    // Expand the requested type through its synonym group.
    const group = TYPE_SYNONYMS.find((g) => g.some((s) => normalizeForSearch(s) === r));
    const needles = group ? group.map((s) => normalizeForSearch(s)) : [r];
    if (unitNorm.some((u) => needles.some((n) => u === n || u.includes(n) || n.includes(u)))) return true;
  }
  return false;
}

/** Deterministic fit score for ONE unit against the client requirements. */
export function scoreUnit(unit: UnitView, req: MatchRequirementsInput): UnitScore {
  const dims: Record<Dim, number | null> = {
    budget: null, type: null, area: null, bedrooms: null, bathrooms: null, availability: null,
  };
  const requestedMissing = new Set<Dim>();

  // ── Budget (SAR) ──
  if (req.budget_min != null || req.budget_max != null) {
    const price = unit.totalPrice;
    if (price == null || price <= 0) {
      requestedMissing.add('budget');
    } else {
      const lo = req.budget_min ?? 0;
      const hi = req.budget_max ?? Number.POSITIVE_INFINITY;
      if (price >= lo && price <= hi) dims.budget = 1;
      else if (price > hi) dims.budget = price <= hi * STRETCH_TOLERANCE ? 0.5 : 0;
      else dims.budget = price >= lo * BUDGET_FLOOR_TOLERANCE ? 0.9 : 0.2; // under floor
    }
  }

  // ── Property type (OR over requested types) ──
  const reqTypes = req.property_types?.length ? req.property_types : req.property_type ? [req.property_type] : [];
  if (reqTypes.length) {
    const tokens = [unit.type?.value, unit.type?.label_ar, unit.type?.label_en].filter(
      (t): t is string => typeof t === 'string' && t.trim() !== '',
    );
    if (tokens.length === 0) requestedMissing.add('type');
    else dims.type = typeMatches(tokens, reqTypes) ? 1 : 0;
  }

  // ── Area (m²) ──
  if (req.area_min != null || req.area_max != null) {
    const a = unit.area;
    if (a == null || a <= 0) {
      requestedMissing.add('area');
    } else {
      const lo = req.area_min ?? 0;
      const hi = req.area_max ?? Number.POSITIVE_INFINITY;
      if (a >= lo && a <= hi) dims.area = 1;
      else {
        const near = a > hi ? a <= hi * 1.15 : a >= lo * 0.85;
        dims.area = near ? 0.5 : 0;
      }
    }
  }

  // ── Bedrooms (AT-LEAST: the request is a minimum) ──
  if (req.bedrooms != null) {
    const b = unit.bedrooms;
    if (b == null) requestedMissing.add('bedrooms');
    else if (b >= req.bedrooms) dims.bedrooms = 1;
    else if (b >= req.bedrooms - 1) dims.bedrooms = 0.6;
    else dims.bedrooms = 0;
  }

  // ── Bathrooms (±1 near-miss) ──
  // MatchRequirementsInput carries no bathrooms field today, so this dimension is
  // simply never requested; kept for parity with the project scorer.
  const reqBaths = (req as { bathrooms?: number }).bathrooms;
  if (reqBaths != null) {
    const bt = unit.bathrooms;
    if (bt == null) requestedMissing.add('bathrooms');
    else if (bt === reqBaths) dims.bathrooms = 1;
    else if (Math.abs(bt - reqBaths) <= 1) dims.bathrooms = 0.6;
    else dims.bathrooms = 0;
  }

  // ── Availability (always applies) ──
  dims.availability = availabilityValue(unit.status?.value ?? null);

  // ── Weighted, renormalized average (same accounting as scoreProject) ──
  let num = 0;
  let den = 0;
  const breakdown: Record<string, number | null> = {};
  (Object.keys(WEIGHTS) as Dim[]).forEach((k) => {
    const sub = dims[k];
    if (sub != null) {
      breakdown[k] = sub;
      num += WEIGHTS[k] * sub;
      den += WEIGHTS[k];
    } else if (requestedMissing.has(k)) {
      breakdown[k] = 0;
      den += WEIGHTS[k];
    } else {
      breakdown[k] = null;
    }
  });
  const score = den > 0 ? Math.round((num / den) * 100) : 0;
  let band: UnitBand = score >= STRONG ? 'strong' : score >= GOOD ? 'good' : 'partial';
  // Categorical guard: a requested type that this unit is NOT can never read as a
  // strong/good suggestion, even if price/area carry the number up.
  if (reqTypes.length > 0 && dims.type === 0 && band !== 'partial') band = 'partial';

  return { unit, score, band, breakdown };
}

/**
 * Rank a project's units by fit and return the best `limit`. Sold units are
 * excluded (not offerable). Ties break toward availability, then best value
 * (cheapest price/m²), then cheapest price, then largest area — deterministic.
 */
export function rankUnits(units: UnitView[], req: MatchRequirementsInput, limit = 3): UnitScore[] {
  const availRank = (s: string | null) =>
    s === 'available' ? 0 : s === 'reserved' ? 1 : s === 'under_construction' ? 2 : 3;
  const nn = (v: number | null, fb: number) => (v == null ? fb : v);
  const scored = units
    .filter((u) => u.status?.value !== 'sold')
    .map((u) => scoreUnit(u, req));
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      availRank(a.unit.status?.value ?? null) - availRank(b.unit.status?.value ?? null) ||
      nn(a.unit.pricePerM2, Number.POSITIVE_INFINITY) - nn(b.unit.pricePerM2, Number.POSITIVE_INFINITY) ||
      nn(a.unit.totalPrice, Number.POSITIVE_INFINITY) - nn(b.unit.totalPrice, Number.POSITIVE_INFINITY) ||
      nn(b.unit.area, -1) - nn(a.unit.area, -1),
  );
  return limit > 0 ? scored.slice(0, limit) : scored;
}
