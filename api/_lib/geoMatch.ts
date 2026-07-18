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
 * Supported element_rule conditions (geometry-aware):
 *   • within_radius   — within X m of a POINT element's centroid (disc).
 *   • within_distance — within X m of a LINE/POLYGON element's full geometry.
 *   • inside_area     — inside a POLYGON element.
 *   • north_of/south_of/east_of/west_of — cardinal side of a LINE element,
 *     relative to ST_ClosestPoint(line, candidate) (per-candidate, not a static area).
 * Plus include/exclude district. Conditions inside one item AND together.
 */

// ── GeoJSON (subset we accept: district/zone polygons + roads) ──────────────
export interface GeoJsonGeometry {
  type: 'Polygon' | 'MultiPolygon' | 'LineString' | 'MultiLineString' | 'Point' | string;
  // Polygon: number[][][] | MultiPolygon: number[][][][] | LineString: number[][]
  // | MultiLineString: number[][][] | Point: number[]  — always [lng, lat].
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

export type DirectionRule = 'north_of' | 'south_of' | 'east_of' | 'west_of';

/** Anchor's STABLE external_id (geo_elements.external_id) — NOT the uuid. */
export interface WithinRadiusCondition { rule: 'within_radius'; element_id: string; distance_m: number; }
export interface WithinDistanceCondition { rule: 'within_distance'; element_id: string; distance_m: number; }
export interface InsideAreaCondition { rule: 'inside_area'; element_id: string; }
/** BOUNDED band: on the chosen side of the line AND within distance_m of it
 *  (user decision 2026-07-18 — never an unbounded half-plane). Missing
 *  distance_m applies DIRECTION_DEFAULT_M. */
export interface DirectionalCondition { rule: DirectionRule; element_id: string; distance_m?: number; }

/** Default band depth for direction rules saved without a distance. */
export const DIRECTION_DEFAULT_M = 5000;

export type ElementCondition =
  | WithinRadiusCondition
  | WithinDistanceCondition
  | InsideAreaCondition
  | DirectionalCondition;

export interface ElementRuleItem {
  id: string;
  kind: 'element_rule';
  polarity: GeoPolarity;
  /** Conditions inside ONE item AND/intersect (in practice the UI adds one). */
  logic?: 'AND';
  conditions: ElementCondition[];
}

/** Free-drawn polygon from the map picker — a CLOSED outer ring ([lng,lat],
 *  first === last). Compiles to a plain polygon area, matched like a district
 *  boundary. Multiple drawn shapes are independent OR-union items. */
export interface DrawnAreaItem {
  id: string;
  kind: 'drawn_area';
  polarity: GeoPolarity;
  coordinates: [number, number][];
}

export type LocationItem = DistrictItem | ElementRuleItem | DrawnAreaItem;

// ── Resolution context: how to turn an item's references into geometry ──────

/** A within_radius anchor resolved from geo_elements (by external_id). The
 *  canonical matching point is (lat,lng) = the element's centroid_geog. The
 *  curation flags drive the usability gate below. */
export interface ResolvedGeoElement {
  /** Centroid (the within_radius point). */
  lat: number;
  lng: number;
  isActive: boolean;
  /** 'approved' | 'pending' | 'rejected' | … — only 'rejected' disqualifies. */
  reviewStatus: string;
  /** 0..1, or null when unknown (unknown is allowed). */
  confidenceScore: number | null;
  /** Full geometry (GeoJSON, [lng,lat]) — required for within_distance / inside_area
   *  / directional rules. within_radius needs only the centroid above. */
  geometry?: GeoJsonGeometry | null;
  /** Normalized kind: 'point' | 'linestring' | 'polygon'. Drives rule validity. */
  geomKind?: 'point' | 'linestring' | 'polygon' | null;
}

export interface CompileCtx {
  /** District boundary polygon (GeoJSON, [lng,lat]) or null when unknown. */
  districtBoundary(districtId: string): GeoJsonGeometry | null;
  /** Resolve a within_radius anchor by its STABLE external_id
   *  (geo_elements.external_id). Return null when no row exists for that id. */
  resolveElement(externalId: string): ResolvedGeoElement | null;
}

export type ValidationStatus = 'ok' | 'needs_review';

/** Minimum import confidence for a within_radius anchor to be matchable. Below
 *  this the compiled item is needs_review. Mirrors CONFIDENCE_FLOOR in the SQL
 *  wassell_compile_client_geo — keep the two in sync. */
export const CONFIDENCE_FLOOR = 0.5;

export type ElementUsability = 'usable' | 'missing' | 'inactive' | 'rejected' | 'low_confidence' | 'invalid';

/** The single anchor-usability rule, shared by compile. An anchor is usable iff
 *  it exists, is active, isn't rejected, isn't below the confidence floor, and
 *  has a finite point. Anything else → the compiled item is needs_review (never
 *  silently dropped). MUST stay identical to the SQL gate in wassell_compile_client_geo. */
export function elementUsability(e: ResolvedGeoElement | null): ElementUsability {
  if (!e) return 'missing';
  if (!e.isActive) return 'inactive';
  if (e.reviewStatus === 'rejected') return 'rejected';
  if (e.confidenceScore != null && e.confidenceScore < CONFIDENCE_FLOOR) return 'low_confidence';
  if (!isFiniteNum(e.lat) || !isFiniteNum(e.lng)) return 'invalid';
  return 'usable';
}

export interface CompiledItem {
  itemId: string;
  polarity: GeoPolarity;
  kind: 'district' | 'element_rule' | 'drawn_area';
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

export const isPolygonal = (g: GeoJsonGeometry): boolean => g.type === 'Polygon' || g.type === 'MultiPolygon';
export const isLineal = (g: GeoJsonGeometry): boolean => g.type === 'LineString' || g.type === 'MultiLineString';

/** Visit every segment [ax,ay]→[bx,by] of a line/polygon geometry ([lng,lat]). */
function eachSegment(geom: GeoJsonGeometry, cb: (ax: number, ay: number, bx: number, by: number) => void): void {
  const line = (pts: number[][]) => {
    for (let i = 1; i < pts.length; i++) cb(pts[i - 1]![0]!, pts[i - 1]![1]!, pts[i]![0]!, pts[i]![1]!);
  };
  switch (geom.type) {
    case 'LineString': line(geom.coordinates as number[][]); break;
    case 'MultiLineString': for (const l of geom.coordinates as number[][][]) line(l); break;
    case 'Polygon': for (const ring of geom.coordinates as number[][][]) line(ring); break;
    case 'MultiPolygon': for (const poly of geom.coordinates as number[][][][]) for (const ring of poly) line(ring); break;
    default: break;
  }
}

/** Closest point on segment a→b to p, in planar [lng,lat] (mirrors PostGIS
 *  ST_ClosestPoint, which is planar on geometry). */
function closestOnSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): [number, number] {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return [ax, ay];
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return [ax + t * dx, ay + t * dy];
}

/** Closest point on a line/polygon geometry to (lng,lat), ranked by planar
 *  distance (matches ST_ClosestPoint). Returns [lng,lat] or null when empty. */
export function closestPointOnGeometry(lng: number, lat: number, geom: GeoJsonGeometry): [number, number] | null {
  let best: [number, number] | null = null;
  let bestD2 = Infinity;
  eachSegment(geom, (ax, ay, bx, by) => {
    const [qx, qy] = closestOnSegment(lng, lat, ax, ay, bx, by);
    const d2 = (qx - lng) ** 2 + (qy - lat) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = [qx, qy]; }
  });
  return best;
}

/** Great-circle distance (km) from (lng,lat) to a line/polygon geometry. A point
 *  inside a polygon has distance 0 (mirrors ST_Distance/ST_DWithin on the full geom). */
export function distanceToGeometryKm(lng: number, lat: number, geom: GeoJsonGeometry): number {
  if (isPolygonal(geom) && pointInPolygon(lng, lat, geom)) return 0;
  let best = Infinity;
  eachSegment(geom, (ax, ay, bx, by) => {
    const [qx, qy] = closestOnSegment(lng, lat, ax, ay, bx, by);
    const d = haversineKm(lat, lng, qy, qx);
    if (d < best) best = d;
  });
  return best;
}

/** Cardinal-direction predicate: candidate vs ST_ClosestPoint(line, candidate).
 *  north: lat greater; south: lat less; east: lng greater; west: lng less. */
export function directionalMatch(lng: number, lat: number, geom: GeoJsonGeometry, rule: DirectionRule): boolean {
  const q = closestPointOnGeometry(lng, lat, geom);
  if (!q) return false;
  const [qx, qy] = q;
  switch (rule) {
    case 'north_of': return lat > qy;
    case 'south_of': return lat < qy;
    case 'east_of': return lng > qx;
    case 'west_of': return lng < qx;
    default: return false;
  }
}

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

  if (item.kind === 'drawn_area') {
    // Mirrors the SQL drawn_area branch: a valid CLOSED ring of ≥4 points
    // ([lng,lat], first === last) compiles to a polygon area; anything
    // malformed is needs_review — never silently dropped.
    const ring = Array.isArray(item.coordinates) ? item.coordinates : [];
    const closed =
      ring.length >= 4 &&
      ring.every((c) => Array.isArray(c) && isFiniteNum(c[0]) && isFiniteNum(c[1])) &&
      ring[0]![0] === ring[ring.length - 1]![0] &&
      ring[0]![1] === ring[ring.length - 1]![1];
    if (!closed) {
      return { itemId: item.id, polarity, kind: 'drawn_area', districtIds: [], hasArea: false, contains: () => false, validationStatus: 'needs_review' };
    }
    const geom: GeoJsonGeometry = { type: 'Polygon', coordinates: [ring] };
    return {
      itemId: item.id,
      polarity,
      kind: 'drawn_area',
      districtIds: [],
      hasArea: true,
      contains: (lng, lat) => pointInPolygon(lng, lat, geom),
      validationStatus: 'ok',
    };
  }

  // element_rule — AND of geometry predicates (in practice one per item).
  const preds: Array<(lng: number, lat: number) => boolean> = [];
  let validation: ValidationStatus = 'ok';
  const conditions = Array.isArray(item.conditions) ? item.conditions : [];
  if (!conditions.length) validation = 'needs_review';
  for (const cond of conditions) {
    // Resolve the anchor by external_id and apply the shared usability gate
    // (missing | inactive | rejected | low_confidence | invalid → needs_review).
    const el = ctx.resolveElement(cond.element_id);
    if (elementUsability(el) !== 'usable') { validation = 'needs_review'; continue; }
    const geom = el!.geometry ?? null;

    if (cond.rule === 'within_radius') {
      const dist = Number(cond.distance_m);
      if (!isFiniteNum(dist) || dist <= 0) { validation = 'needs_review'; continue; }
      const { lat: clat, lng: clng } = el!;
      const km = dist / 1000;
      preds.push((lng, lat) => haversineKm(lat, lng, clat, clng) <= km);
    } else if (cond.rule === 'within_distance') {
      const dist = Number(cond.distance_m);
      if (!isFiniteNum(dist) || dist <= 0 || !geom) { validation = 'needs_review'; continue; }
      const km = dist / 1000;
      preds.push((lng, lat) => distanceToGeometryKm(lng, lat, geom) <= km);
    } else if (cond.rule === 'inside_area') {
      if (!geom || !isPolygonal(geom)) { validation = 'needs_review'; continue; }
      preds.push((lng, lat) => pointInPolygon(lng, lat, geom));
    } else if (cond.rule === 'north_of' || cond.rule === 'south_of' || cond.rule === 'east_of' || cond.rule === 'west_of') {
      if (!geom || !isLineal(geom)) { validation = 'needs_review'; continue; }
      const dir = cond.rule;
      // BOUNDED: side-of-road AND within distance_m of it — mirrors the SQL
      // compiler's buffer(geom, distance_m) ∧ side test (2026-07-18).
      const dRaw = Number((cond as DirectionalCondition).distance_m);
      const km = (Number.isFinite(dRaw) && dRaw > 0 ? dRaw : DIRECTION_DEFAULT_M) / 1000;
      preds.push((lng, lat) => directionalMatch(lng, lat, geom, dir) && distanceToGeometryKm(lng, lat, geom) <= km);
    } else {
      validation = 'needs_review'; // unknown rule
    }
  }
  const hasArea = preds.length > 0;
  return {
    itemId: item.id,
    polarity,
    kind: 'element_rule',
    districtIds: [],
    hasArea,
    // AND across conditions: the point must satisfy EVERY predicate.
    contains: hasArea ? (lng, lat) => preds.every((p) => p(lng, lat)) : () => false,
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
