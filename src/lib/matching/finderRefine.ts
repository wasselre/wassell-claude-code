/**
 * Shared client-side refinement for the deterministic Project Finder results —
 * used by BOTH the standalone Project Finder page and the Follow-up "Suggested
 * Projects" modal so they behave identically. Operates on the already-fetched
 * groups (everything ≥ 70); NO re-fetch.
 *
 *   • score threshold (70→100) — raise the minimum match, shrink the list;
 *   • sort (best match / price / area / nearest / availability / name);
 *   • HARD post-filters (max price, area window, min beds, available-only,
 *     coordinate-verified-only) to focus a large set.
 */

import { FINDER_GROUP_KEYS, type FinderGroupKey, type FinderMatch } from './projectFinder';

export type SortKey =
  | 'score' | 'price_asc' | 'price_desc' | 'area_desc' | 'area_asc' | 'distance' | 'available_desc' | 'name';

export const SORT_LABELS: Record<SortKey, { ar: string; en: string }> = {
  score: { ar: 'الأفضل تطابقاً', en: 'Best match' },
  price_asc: { ar: 'السعر: الأقل أولاً', en: 'Price: low → high' },
  price_desc: { ar: 'السعر: الأعلى أولاً', en: 'Price: high → low' },
  area_desc: { ar: 'المساحة: الأكبر أولاً', en: 'Area: large → small' },
  area_asc: { ar: 'المساحة: الأصغر أولاً', en: 'Area: small → large' },
  distance: { ar: 'الأقرب مسافةً', en: 'Nearest' },
  available_desc: { ar: 'الأكثر وحدات متاحة', en: 'Most available units' },
  name: { ar: 'الاسم (أ → ي)', en: 'Name (A → Z)' },
};

export interface Refine {
  priceMax: number | '';
  areaMin: number | '';
  areaMax: number | '';
  bedroomsMin: number | '';
  availableOnly: boolean;
  verifiedOnly: boolean;
}
export const REFINE_DEFAULT: Refine = {
  priceMax: '', areaMin: '', areaMax: '', bedroomsMin: '', availableOnly: false, verifiedOnly: false,
};
export const refineIsActive = (r: Refine): boolean =>
  r.priceMax !== '' || r.areaMin !== '' || r.areaMax !== '' || r.bedroomsMin !== '' || r.availableOnly || r.verifiedOnly;

/** Default fetch floor — the engine returns everything at or above this. */
export const FETCH_FLOOR = 70;
export const BEDROOM_OPTS = [1, 2, 3, 4, 5, 6];

/** A fact that's either a scalar number or a { min, max } range → {min,max}. */
export function factRange(facts: Record<string, unknown>, key: string): { min: number | null; max: number | null } {
  const v = facts?.[key];
  if (v == null) return { min: null, max: null };
  if (typeof v === 'number' && Number.isFinite(v)) return { min: v, max: v };
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const mn = typeof o.min === 'number' ? o.min : Number(o.min);
    const mx = typeof o.max === 'number' ? o.max : Number(o.max);
    return { min: Number.isFinite(mn) ? mn : null, max: Number.isFinite(mx) ? mx : null };
  }
  return { min: null, max: null };
}
export const availOf = (item: FinderMatch): number | null =>
  typeof item.facts?.available_units === 'number' ? (item.facts.available_units as number) : null;

/** HARD post-filters over the already-scored set — focus a large result list. */
export function passesRefine(item: FinderMatch, r: Refine): boolean {
  const price = factRange(item.facts, 'price_range');
  const area = factRange(item.facts, 'area_range');
  const beds = factRange(item.facts, 'bedroom_range');
  if (r.priceMax !== '' && (price.min == null || price.min > r.priceMax)) return false;
  if (r.areaMin !== '' && (area.max == null || area.max < r.areaMin)) return false;
  if (r.areaMax !== '' && (area.min == null || area.min > r.areaMax)) return false;
  if (r.bedroomsMin !== '' && (beds.max == null || beds.max < r.bedroomsMin)) return false;
  if (r.availableOnly) { const a = availOf(item); if (a == null || a <= 0) return false; }
  if (r.verifiedOnly && item.geo_status !== 'verified_match' && item.geo_status !== 'verified_derived') return false;
  return true;
}

/** Compare two nullable numbers; nulls always sort last regardless of direction. */
function cmpNum(a: number | null, b: number | null, asc: boolean): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return asc ? a - b : b - a;
}

export function sortItems(items: FinderMatch[], key: SortKey): FinderMatch[] {
  const arr = [...items];
  switch (key) {
    case 'price_asc': return arr.sort((a, b) => cmpNum(factRange(a.facts, 'price_range').min, factRange(b.facts, 'price_range').min, true));
    case 'price_desc': return arr.sort((a, b) => cmpNum(factRange(a.facts, 'price_range').max, factRange(b.facts, 'price_range').max, false));
    case 'area_desc': return arr.sort((a, b) => cmpNum(factRange(a.facts, 'area_range').max, factRange(b.facts, 'area_range').max, false));
    case 'area_asc': return arr.sort((a, b) => cmpNum(factRange(a.facts, 'area_range').min, factRange(b.facts, 'area_range').min, true));
    case 'distance': return arr.sort((a, b) => cmpNum(a.distance_km, b.distance_km, true));
    case 'available_desc': return arr.sort((a, b) => cmpNum(availOf(a), availOf(b), false));
    case 'name': return arr.sort((a, b) => a.project_name.localeCompare(b.project_name, 'ar'));
    case 'score':
    default: return arr.sort((a, b) => b.score - a.score);
  }
}

/** Apply score threshold + refine filters, then sort — per group. */
export function refineGroups(
  groups: Record<FinderGroupKey, FinderMatch[]> | undefined,
  scoreThreshold: number,
  refine: Refine,
  sortKey: SortKey,
): Record<FinderGroupKey, FinderMatch[]> {
  const out = {} as Record<FinderGroupKey, FinderMatch[]>;
  for (const k of FINDER_GROUP_KEYS) {
    const base = (groups?.[k] ?? []).filter((it) => it.score >= scoreThreshold && passesRefine(it, refine));
    out[k] = sortItems(base, sortKey);
  }
  return out;
}

export const totalInGroups = (groups: Record<FinderGroupKey, FinderMatch[]> | undefined): number =>
  FINDER_GROUP_KEYS.reduce((n, k) => n + (groups?.[k]?.length ?? 0), 0);
