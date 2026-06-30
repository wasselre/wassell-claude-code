/**
 * Client location matching — deterministic reference implementation (v1).
 *
 * This is the TYPED, PURE-CODE twin of the SQL matcher in
 * supabase/migrations/2026-06-30_client_geo_matching.sql
 * (wassell_compile_client_geo + wassell_geo_match). At RUNTIME the Project Finder
 * calls the SQL RPCs (they scan the GiST-indexed point tables at scale). This
 * module exists so the matching RECIPE — OR-union of include items, dedup by id,
 * exclusion subtraction, and within_radius containment — is unit-testable in
 * vitest without a live Postgres, AND so other TS code can resolve items the same
 * way. The same dual-implementation pattern as geoVerify.ts ↔ v_all_projects_geo_integrity.
 *
 * ── MUST stay semantically identical to the SQL functions. ──
 * v1 supports exactly: include district, exclude district, within_radius of a
 * POINT geo_element. Road-directional / polygon / between / compound-AND beyond
 * within_radius are deliberately out of scope and are NOT implemented here.
 */

// ── GeoJSON (subset we accept for district boundaries) ──────────────────────
export interface GeoJsonGeometry {
  type: 'Polygon' | 'MultiPolygon' | string;
  // Polygon: number[][][]  |  MultiPolygon: number[][][][]  — always [lng, lat].
  coordinates: unknown;
}

// ── Preference item shapes (the JSONB stored on clients.data.location_items) ──
export type GeoPolarity = 'include' | 'exclude';

export interface DistrictItem {
  id: string;
  kind: 'district';
  polarity: GeoPolarity;
  district_id: string;
}

export interface WithinRadiusCondition {
  rule: 'within_radius';
  element_id: string;
  distance_m: number;
}

/** v1 supports only within_radius conditions. */
export type ElementCondition = WithinRadiusCondition;

export interface ElementRuleItem {
  id: string;
  kind: 'element_rule';
  polarity: GeoPolarity;
  /** Conditions inside ONE item are AND/intersection (v1: a single within_radius). */
  logic?: 'AND';
  conditions: ElementCondition[];
}

export type LocationItem = DistrictItem | ElementRuleItem;

// ── Resolution context: how to turn an item's references into geometry ──────
export interface CompileCtx {
  /** District boundary polygon (GeoJSON, [lng,lat]) or null when unknown. */
  districtBoundary(districtId: string): GeoJsonGeometry | null;
  /** Point geo_element location, or null when the element is missing/not a point. */
  elementPoint(elementId: string): { lat: number; lng: number } | null;
  /** Element geometry validity. Defaults to 'ok' (point landmarks are unambiguous). */
  elementValidationStatus?(elementId: string): 'ok' | 'needs_review';
}

export type ValidationStatus = 'ok' | 'needs_review';

export interface CompiledItem {
  itemId: string;
  polarity: GeoPolarity;
  kind: 'district' | 'element_rule';
  /** District ids for matching POINT-LESS candidates (projects with no pin). */
  districtIds: string[];
  /** True when this item has a geometric area (a polygon or a within_radius disc). */
  hasArea: boolean;
  /** Geometric containment test for a candidate point. False when !hasArea. */
  contains(lng: number, lat: number): boolean;
  /** 'needs_review' items are SKIPPED in matching (fail-closed, never silent — the
   *  caller surfaces the count). v1 point rules compile to 'ok'. */
  validationStatus: ValidationStatus;
}

export interface GeoCandidate {
  id: string;
  lat?: number | null;
  lng?: number | null;
  /** Stored districts-record id (for point-less candidates). */
  districtId?: string | null;
}

export interface GeoMatch {
  id: string;
  /** Ids of the include items this candidate satisfied (explainability). */
  matchedBy: string[];
}

// ── Pure geometry primitives (self-contained; no google.maps dependency) ─────

/** Great-circle distance in km. */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ray-casting point-in-ring ([lng,lat] rings). */
function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!, yi = ring[i]![1]!;
    const xj = ring[j]![0]!, yj = ring[j]![1]!;
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Point-in-polygon: ring[0] = outer, ring[1..] = holes. */
function pointInPolygonRings(lng: number, lat: number, rings: number[][][]): boolean {
  if (!rings.length) return false;
  if (!pointInRing(lng, lat, rings[0]!)) return false;
  for (let h = 1; h < rings.length; h++) {
    if (pointInRing(lng, lat, rings[h]!)) return false; // inside a hole
  }
  return true;
}

/** Point-in-geometry for Polygon | MultiPolygon ([lng,lat]). */
export function pointInPolygon(lng: number, lat: number, geometry: GeoJsonGeometry): boolean {
  if (geometry.type === 'Polygon') {
    return pointInPolygonRings(lng, lat, geometry.coordinates as number[][][]);
  }
  if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates as number[][][][]) {
      if (pointInPolygonRings(lng, lat, poly)) return true;
    }
    return false;
  }
  return false;
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ── Compile: one preference item → one CompiledItem ─────────────────────────

/** Mirrors the per-item branch of wassell_compile_client_geo. */
export function compileItem(item: LocationItem, ctx: CompileCtx): CompiledItem {
  const polarity: GeoPolarity = item.polarity === 'exclude' ? 'exclude' : 'include';

  if (item.kind === 'district') {
    const districtId = (item.district_id ?? '').trim();
    if (!districtId) {
      return { itemId: item.id, polarity, kind: 'district', districtIds: [], hasArea: false, contains: () => false, validationStatus: 'needs_review' };
    }
    const boundary = ctx.districtBoundary(districtId);
    return {
      itemId: item.id,
      polarity,
      kind: 'district',
      districtIds: [districtId],
      hasArea: !!boundary,
      contains: boundary ? (lng, lat) => pointInPolygon(lng, lat, boundary) : () => false,
      validationStatus: 'ok', // a district item is usable even without a boundary (point-less fallback)
    };
  }

  // element_rule — v1: AND of within_radius discs (one disc in practice).
  const discs: Array<{ lat: number; lng: number; km: number }> = [];
  let validation: ValidationStatus = 'ok';
  const conditions = Array.isArray(item.conditions) ? item.conditions : [];
  if (!conditions.length) validation = 'needs_review';
  for (const cond of conditions) {
    if (cond.rule !== 'within_radius') {
      validation = 'needs_review'; // unsupported rule in v1
      continue;
    }
    const center = ctx.elementPoint(cond.element_id);
    const dist = Number(cond.distance_m);
    if (!center || !isFiniteNum(dist) || dist <= 0) {
      validation = 'needs_review';
      continue;
    }
    if ((ctx.elementValidationStatus?.(cond.element_id) ?? 'ok') !== 'ok') validation = 'needs_review';
    discs.push({ lat: center.lat, lng: center.lng, km: dist / 1000 });
  }
  const hasArea = discs.length > 0;
  return {
    itemId: item.id,
    polarity,
    kind: 'element_rule',
    districtIds: [],
    hasArea,
    // AND across conditions: the point must be within EVERY disc.
    contains: hasArea ? (lng, lat) => discs.every((d) => haversineKm(lat, lng, d.lat, d.lng) <= d.km) : () => false,
    validationStatus: validation,
  };
}

// ── Match: compiled items + candidates → matched ids (union, dedup, exclusion) ─

/** Does this candidate fall inside the compiled item? Mirrors the SQL predicate:
 *  a pinned candidate matches geometrically (pin wins, no stored-district trust);
 *  a point-less candidate matches by district-id membership only. */
function candidateInItem(c: GeoCandidate, item: CompiledItem): boolean {
  const hasPin = isFiniteNum(c.lat) && isFiniteNum(c.lng);
  if (hasPin) return item.hasArea && item.contains(c.lng as number, c.lat as number);
  return !!c.districtId && item.districtIds.includes(c.districtId);
}

/** For EXCLUSION, district membership applies even to pinned candidates (a stored
 *  exclude-district drops the candidate regardless of pin). Mirrors the SQL OR. */
function candidateInExclude(c: GeoCandidate, item: CompiledItem): boolean {
  const hasPin = isFiniteNum(c.lat) && isFiniteNum(c.lng);
  const inArea = hasPin && item.hasArea && item.contains(c.lng as number, c.lat as number);
  const inDistrict = !!c.districtId && item.districtIds.includes(c.districtId);
  return inArea || inDistrict;
}

/**
 * Match candidates against compiled preference items.
 *   • union: a candidate is matched if it satisfies ANY include item (OR).
 *   • dedup: each id appears once; matchedBy unions all satisfied include items.
 *   • exclusion: a candidate inside ANY exclude item is removed.
 *   • needs_review items are skipped (never silently — caller reports the count).
 */
export function matchCandidates(compiled: CompiledItem[], candidates: GeoCandidate[]): GeoMatch[] {
  const includes = compiled.filter((i) => i.polarity === 'include' && i.validationStatus === 'ok');
  const excludes = compiled.filter((i) => i.polarity === 'exclude' && i.validationStatus === 'ok');

  const byId = new Map<string, Set<string>>();
  for (const c of candidates) {
    const hits = includes.filter((i) => candidateInItem(c, i));
    if (!hits.length) continue;
    if (excludes.some((e) => candidateInExclude(c, e))) continue;
    const set = byId.get(c.id) ?? new Set<string>();
    for (const h of hits) set.add(h.itemId);
    byId.set(c.id, set);
  }
  return [...byId.entries()].map(([id, set]) => ({ id, matchedBy: [...set] }));
}

/** Convenience: compile a full item list, then match. */
export function compileAndMatch(
  items: LocationItem[],
  ctx: CompileCtx,
  candidates: GeoCandidate[],
): { matches: GeoMatch[]; needsReview: number } {
  const compiled = items.map((it) => compileItem(it, ctx));
  const needsReview = compiled.filter((c) => c.validationStatus === 'needs_review').length;
  return { matches: matchCandidates(compiled, candidates), needsReview };
}
