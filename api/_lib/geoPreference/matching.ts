/**
 * Unit → project geo-matching for the Geography Understanding Ability (v4 C4/A7,
 * v6 #4). Given a COMPILED `GeoPreference` (the Boolean compiler's output — hard
 * and soft groups of include/exclude anchor geometries), this module returns the
 * projects that match, WITH the spatial predicate that decided each match.
 *
 * ── The three design commitments this file implements ──────────────────────────
 *
 * 1. UNIT-LEVEL matching, PROJECT-LEVEL rollup. A project is not a point — it is a
 *    bag of units. So we evaluate the spatial predicate against each UNIT's own
 *    coordinate, then roll the per-unit booleans up to a project verdict via a
 *    PARAMETERIZABLE policy:
 *        • any_unit           — ≥1 unit satisfies (the "some inventory fits" rule)
 *        • n_units(k)         — ≥k units satisfy
 *        • share_of_units(f)  — the matched fraction ≥ f
 *    The chosen policy is STATED in the result (`MatchResult.policy`) so a reader
 *    always knows how "the project matches" was decided.
 *
 * 2. A PREDICATE that follows the SPATIAL RELATION, not the hard/soft strength.
 *    Whether a preference filters or ranks (hard vs soft) is ORTHOGONAL to HOW a
 *    candidate is tested against a shape. The relation type drives the predicate:
 *        • containment    — district / zone / "inside area"     (point-in-polygon)
 *        • accessibility  — "near a road" / corridor / band      (distance ≤ band,
 *                            plus a side test for a directional band) — models
 *                            entrance/reachability, not raw membership
 *        • intersection   — a broad proximity area (radius disc)  (overlap / within)
 *    See `predicateKind()` for the GeoOperation → relation mapping.
 *
 * 3. A GEOMETRY LADDER, finest-first, each rung carrying a CONFIDENCE, used only
 *    when finer data is missing:
 *        unit_point (0.95) → project_polygon (0.70) → project_centroid (0.45)
 *    When a project HAS units with coordinates we trust them and DO NOT fall to a
 *    coarser rung even if the rollup fails — finer data present wins. The polygon
 *    and centroid rungs exist for projects that carry no per-unit coordinates.
 *
 * ── ELIGIBILITY vs RANKING (kept strictly separate) ───────────────────────────
 *    • ELIGIBILITY is decided by HARD groups ONLY. A soft group can NEVER make a
 *      project eligible, and failing every soft preference NEVER removes an
 *      otherwise-eligible project from the result. With no hard groups at all,
 *      every candidate project is eligible (`eligibility_basis:'no_hard_constraint'`).
 *    • RANKING is a score over the eligible set from SOFT groups + priority
 *      (priority 1 = strongest ⇒ weight 1/priority). Soft matches only reorder;
 *      they never gate.
 *
 * ── DB-backed vs faked boundary ───────────────────────────────────────────────
 *    All Postgres access is behind the injected `MatchingDb` port, so the matching
 *    LOGIC below is pure and unit-testable with in-memory fakes (see
 *    __tests__/geoPreferenceMatching.test.ts). The real adapter (future
 *    `matchingDb.ts`, mirroring `resolverDb.ts`) would back the port like this:
 *      • listProjects()       ← `project_points` (geom→centroid, district_id) joined
 *                               to the `all_projects` records for any footprint polygon.
 *      • unitsForProjects()   ← `records` where model = 'units' and
 *                               data.project_id = <project> (scalar lookup or first
 *                               array element, per `_rollup_project_id_of`), reading
 *                               each unit's data.latitude / data.longitude.
 *      • resolveGeometries()  ← each AnchorRef.geometry_id → its concrete shape from
 *                               `district_boundaries` (polygons), `geo_elements`
 *                               (roads/landmarks), or the compiled
 *                               `client_pref_geometry` store; carries operation +
 *                               radius_or_band_m from the GeometryRecipe.
 *    NOTHING here writes to a client (read-only, review-first — same posture as the
 *    rest of the geoPreference stack).
 */

import {
  pointInPolygon,
  distanceToGeometryKm,
  haversineKm,
  directionalMatch,
  isPolygonal,
  isLineal,
  type GeoJsonGeometry,
  type DirectionRule,
} from '../geoMatch.js';
import type {
  GeoPreference, GeoGroup, GeoClause, AnchorRef, GeoOperation,
} from './ontology.js';

// ────────────────────────────────────────────────────────────────────────────
// Rollup policy — HOW per-unit matches become a project verdict. Stated in result.
// ────────────────────────────────────────────────────────────────────────────
export type RollupPolicy =
  | { kind: 'any_unit' }
  | { kind: 'n_units'; k: number }
  | { kind: 'share_of_units'; fraction: number };

export const DEFAULT_ROLLUP_POLICY: RollupPolicy = { kind: 'any_unit' };

/** Apply a rollup policy to the per-unit tally. `total` is units WITH coordinates. */
export function rollupSatisfied(policy: RollupPolicy, matched: number, total: number): boolean {
  if (total <= 0) return false;
  switch (policy.kind) {
    case 'any_unit': return matched >= 1;
    case 'n_units': return matched >= Math.max(1, Math.floor(policy.k));
    case 'share_of_units': return matched / total >= policy.fraction;
    default: return false;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Spatial relation → predicate. Orthogonal to hard/soft (design commitment #2).
// ────────────────────────────────────────────────────────────────────────────
export type PredicateKind = 'containment' | 'accessibility' | 'intersection';

/** Map a compiled GeometryRecipe operation to the spatial relation it expresses. */
export function predicateKind(op: GeoOperation): PredicateKind {
  switch (op) {
    case 'district_polygon':
    case 'district_union':
    case 'zone_union':
    case 'pin_containing_district':
      return 'containment';
    case 'directional_band':
    case 'corridor':
    case 'within_distance':
      return 'accessibility';
    case 'within_radius':
    case 'pin_point':
      return 'intersection';
    default:
      return 'intersection';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Geometry ladder — finest first; each rung carries a confidence.
// ────────────────────────────────────────────────────────────────────────────
export type LadderRung = 'unit_point' | 'project_polygon' | 'project_centroid';

export const LADDER_CONFIDENCE: Record<LadderRung, number> = {
  unit_point: 0.95,
  project_polygon: 0.70,
  project_centroid: 0.45,
};

// ────────────────────────────────────────────────────────────────────────────
// DB port — the only surface that would touch Postgres. Faked in tests.
// ────────────────────────────────────────────────────────────────────────────

/** A concrete shape resolved for one AnchorRef.geometry_id ([lng,lat] GeoJSON). */
export interface ResolvedGeometry {
  geometry_id: string;
  operation: GeoOperation;
  /** The shape to test against, or null when the id could not be resolved. */
  geometry: GeoJsonGeometry | null;
  /** Radius (within_radius) or band depth (accessibility) in metres. */
  radius_or_band_m?: number | null;
  /** Side for a directional_band (optional; absent ⇒ pure distance band). */
  direction?: DirectionRule | null;
}

/** One unit's matchable coordinate (data.latitude/longitude on a units record). */
export interface UnitPoint {
  unit_id: string;
  lat: number | null;
  lng: number | null;
}

/** A project's geometry-ladder data (the coarser rungs). */
export interface ProjectGeo {
  project_id: string;
  /** Project footprint polygon ([lng,lat]) when known — the polygon rung. */
  polygon?: GeoJsonGeometry | null;
  /** Project centroid (project_points.geom) — the centroid rung. */
  centroid?: { lat: number; lng: number } | null;
}

export interface MatchingDb {
  /** All candidate projects with their coarse geometry (polygon + centroid). */
  listProjects(): Promise<ProjectGeo[]>;
  /** The units (with coordinates) for the given project ids, keyed by project id. */
  unitsForProjects(projectIds: string[]): Promise<Record<string, UnitPoint[]>>;
  /** Resolve every referenced anchor geometry_id to a concrete shape. */
  resolveGeometries(refs: AnchorRef[]): Promise<ResolvedGeometry[]>;
}

// ────────────────────────────────────────────────────────────────────────────
// Result shapes.
// ────────────────────────────────────────────────────────────────────────────
export interface GroupMatch {
  group_id: string;
  role: GeoGroup['role'];
  strength: GeoGroup['strength'];
  priority: number;
  /** The spatial relation that decided the match (design commitment #2). */
  predicate: PredicateKind;
  /** Which ladder rung produced the verdict (design commitment #3). */
  ladder_rung: LadderRung;
  confidence: number;
  /** Rollup evidence — present when matched at the unit rung. */
  units_total?: number;
  units_matched?: number;
  /** The anchor geometry_ids that were satisfied (explainability). */
  matched_geometry_ids: string[];
}

export interface ProjectMatch {
  project_id: string;
  /** Eligible strictly by hard groups (soft never affects this). */
  eligible: boolean;
  /** Ranking score over the eligible set (soft groups + priority). */
  score: number;
  hard_matches: GroupMatch[];
  soft_matches: GroupMatch[];
}

export interface MatchResult {
  /** The rollup policy this run used — STATED so the reader knows the rule. */
  policy: RollupPolicy;
  eligibility_basis: 'hard_groups' | 'no_hard_constraint';
  hard_group_ids: string[];
  soft_group_ids: string[];
  /** Eligible projects only, sorted by score desc (project_id tiebreak). */
  projects: ProjectMatch[];
}

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Extract [lng,lat] from a Point geometry, else null. */
function pointCoords(g: GeoJsonGeometry): [number, number] | null {
  if (g.type !== 'Point') return null;
  const c = g.coordinates as unknown;
  if (Array.isArray(c) && isFiniteNum(c[0]) && isFiniteNum(c[1])) return [c[0], c[1]];
  return null;
}

/** Representative interior point of a polygon (mean of its outer-ring vertices).
 *  Used at the project_polygon rung so a footprint can be tested with the pure
 *  point-in-polygon primitives; true polygon-polygon overlap is a later refinement. */
function polygonRepresentativePoint(g: GeoJsonGeometry): [number, number] | null {
  let ring: number[][] | null = null;
  if (g.type === 'Polygon') ring = (g.coordinates as number[][][])[0] ?? null;
  else if (g.type === 'MultiPolygon') ring = (g.coordinates as number[][][][])[0]?.[0] ?? null;
  if (!ring || !ring.length) return null;
  // Drop the closing duplicate vertex if present.
  const pts = ring.length > 1 && ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1]
    ? ring.slice(0, -1) : ring;
  let sx = 0, sy = 0, n = 0;
  for (const p of pts) { if (isFiniteNum(p[0]) && isFiniteNum(p[1])) { sx += p[0]!; sy += p[1]!; n++; } }
  return n ? [sx / n, sy / n] : null;
}

/** Does a single point satisfy one resolved anchor geometry, by its relation? */
function pointSatisfiesAnchor(g: ResolvedGeometry | undefined, lng: number, lat: number): boolean {
  if (!g || !g.geometry) return false;
  const kind = predicateKind(g.operation);

  if (kind === 'containment') {
    return isPolygonal(g.geometry) && pointInPolygon(lng, lat, g.geometry);
  }

  if (kind === 'accessibility') {
    const bandKm = (isFiniteNum(g.radius_or_band_m) ? (g.radius_or_band_m as number) : 5000) / 1000;
    const near = distanceToGeometryKm(lng, lat, g.geometry) <= bandKm;
    if (g.direction && isLineal(g.geometry)) return near && directionalMatch(lng, lat, g.geometry, g.direction);
    return near;
  }

  // intersection (broad proximity area).
  if (g.operation === 'within_radius') {
    const c = pointCoords(g.geometry);
    if (c && isFiniteNum(g.radius_or_band_m)) {
      return haversineKm(lat, lng, c[1], c[0]) <= (g.radius_or_band_m as number) / 1000;
    }
    // Pre-buffered disc supplied as a polygon.
    return isPolygonal(g.geometry) && pointInPolygon(lng, lat, g.geometry);
  }
  if (isPolygonal(g.geometry)) return pointInPolygon(lng, lat, g.geometry);
  return distanceToGeometryKm(lng, lat, g.geometry) === 0;
}

interface PointVerdict { satisfied: boolean; predicate: PredicateKind; matchedGeomIds: string[]; }

/** Evaluate a whole GROUP (AND of clauses; include=inside one anchor, exclude=inside
 *  none) against ONE point. Returns whether it holds, the decisive predicate, and
 *  the matched include geometry_ids. */
function pointSatisfiesGroup(
  group: GeoGroup, lng: number, lat: number, resolved: Map<string, ResolvedGeometry>,
): PointVerdict {
  const matchedGeomIds: string[] = [];
  let predicate: PredicateKind | null = null;
  let firstExcludePredicate: PredicateKind | null = null;

  for (const clause of group.clauses) {
    const hit = clauseHit(clause, lng, lat, resolved);
    if (clause.op === 'include') {
      if (!hit.satisfied) return { satisfied: false, predicate: 'containment', matchedGeomIds: [] };
      if (predicate == null) predicate = hit.predicate; // first include decides the reported predicate
      matchedGeomIds.push(...hit.geomIds);
    } else {
      // exclude: the point must be inside NONE of the anyOf anchors.
      if (firstExcludePredicate == null && clause.anyOf.length) {
        firstExcludePredicate = predicateKind(resolved.get(clause.anyOf[0]!.geometry_id)?.operation ?? 'within_radius');
      }
      if (hit.satisfied) return { satisfied: false, predicate: 'containment', matchedGeomIds: [] };
    }
  }
  return { satisfied: true, predicate: predicate ?? firstExcludePredicate ?? 'containment', matchedGeomIds };
}

/** OR within a clause: is the point inside ANY anchor of the clause? */
function clauseHit(
  clause: GeoClause, lng: number, lat: number, resolved: Map<string, ResolvedGeometry>,
): { satisfied: boolean; predicate: PredicateKind; geomIds: string[] } {
  const geomIds: string[] = [];
  let predicate: PredicateKind = 'containment';
  let any = false;
  for (const ref of clause.anyOf) {
    const g = resolved.get(ref.geometry_id);
    if (pointSatisfiesAnchor(g, lng, lat)) {
      any = true;
      geomIds.push(ref.geometry_id);
      if (g) predicate = predicateKind(g.operation);
    }
  }
  return { satisfied: any, predicate, geomIds };
}

/** Evaluate a group against a project via the geometry ladder + rollup policy. */
function evaluateGroupForProject(
  group: GeoGroup, project: ProjectGeo, units: UnitPoint[],
  resolved: Map<string, ResolvedGeometry>, policy: RollupPolicy,
): GroupMatch | null {
  const base = {
    group_id: group.id, role: group.role, strength: group.strength, priority: group.priority,
  };

  // Rung 1 — unit points (finest). When units with coords exist, they are
  // authoritative: we do NOT fall to a coarser rung if the rollup fails.
  const unitsWithCoords = units.filter((u) => isFiniteNum(u.lat) && isFiniteNum(u.lng));
  if (unitsWithCoords.length > 0) {
    let matched = 0;
    const geomIds = new Set<string>();
    let predicate: PredicateKind | null = null;
    for (const u of unitsWithCoords) {
      const v = pointSatisfiesGroup(group, u.lng as number, u.lat as number, resolved);
      if (v.satisfied) {
        matched++;
        v.matchedGeomIds.forEach((id) => geomIds.add(id));
        if (predicate == null) predicate = v.predicate;
      }
    }
    if (rollupSatisfied(policy, matched, unitsWithCoords.length)) {
      return {
        ...base, predicate: predicate ?? 'containment', ladder_rung: 'unit_point',
        confidence: LADDER_CONFIDENCE.unit_point, units_total: unitsWithCoords.length,
        units_matched: matched, matched_geometry_ids: [...geomIds],
      };
    }
    return null;
  }

  // Rung 2 — project footprint polygon (medium confidence).
  if (project.polygon) {
    const rep = polygonRepresentativePoint(project.polygon);
    if (rep) {
      const v = pointSatisfiesGroup(group, rep[0], rep[1], resolved);
      if (v.satisfied) {
        return {
          ...base, predicate: v.predicate, ladder_rung: 'project_polygon',
          confidence: LADDER_CONFIDENCE.project_polygon, matched_geometry_ids: v.matchedGeomIds,
        };
      }
    }
    return null;
  }

  // Rung 3 — project centroid (lowest confidence).
  if (project.centroid && isFiniteNum(project.centroid.lat) && isFiniteNum(project.centroid.lng)) {
    const v = pointSatisfiesGroup(group, project.centroid.lng, project.centroid.lat, resolved);
    if (v.satisfied) {
      return {
        ...base, predicate: v.predicate, ladder_rung: 'project_centroid',
        confidence: LADDER_CONFIDENCE.project_centroid, matched_geometry_ids: v.matchedGeomIds,
      };
    }
  }
  return null;
}

/** Soft-group weight from priority (1 = strongest ⇒ 1.0). */
function softWeight(priority: number): number {
  return 1 / Math.max(1, priority);
}

/** Gather every AnchorRef referenced anywhere in the preference. */
function allAnchorRefs(pref: GeoPreference): AnchorRef[] {
  const refs: AnchorRef[] = [];
  for (const g of pref.groups) for (const c of g.clauses) for (const a of c.anyOf) refs.push(a);
  return refs;
}

// ────────────────────────────────────────────────────────────────────────────
// Public entry point.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Match a compiled GeoPreference against the project/unit inventory behind `db`.
 * Eligibility = HARD groups only; ranking = SOFT groups + priority. The rollup
 * policy (how per-unit matches become a project verdict) defaults to `any_unit`
 * and is echoed back in `MatchResult.policy`.
 */
export async function matchGeoPreference(
  pref: GeoPreference,
  db: MatchingDb,
  policy: RollupPolicy = DEFAULT_ROLLUP_POLICY,
): Promise<MatchResult> {
  const hardGroups = pref.groups.filter((g) => g.strength === 'hard');
  const softGroups = pref.groups.filter((g) => g.strength === 'soft');

  const resolvedList = await db.resolveGeometries(allAnchorRefs(pref));
  const resolved = new Map<string, ResolvedGeometry>(resolvedList.map((r) => [r.geometry_id, r]));

  const projects = await db.listProjects();
  const unitsByProject = await db.unitsForProjects(projects.map((p) => p.project_id));

  const hasHard = hardGroups.length > 0;
  const out: ProjectMatch[] = [];

  for (const project of projects) {
    const units = unitsByProject[project.project_id] ?? [];

    // ELIGIBILITY — hard groups only (OR across ranked alternatives). No hard
    // groups ⇒ every project is eligible (soft can never gate).
    const hardMatches: GroupMatch[] = [];
    for (const g of hardGroups) {
      const m = evaluateGroupForProject(g, project, units, resolved, policy);
      if (m) hardMatches.push(m);
    }
    const eligible = hasHard ? hardMatches.length > 0 : true;
    if (!eligible) continue;

    // RANKING — soft groups only (never affects eligibility).
    const softMatches: GroupMatch[] = [];
    for (const g of softGroups) {
      const m = evaluateGroupForProject(g, project, units, resolved, policy);
      if (m) softMatches.push(m);
    }

    const eligibilityConfidence = hasHard
      ? Math.max(...hardMatches.map((m) => m.confidence))
      : 0.5; // neutral base when there is no hard constraint
    const softContribution = softMatches.reduce((s, m) => s + softWeight(m.priority) * m.confidence, 0);

    out.push({
      project_id: project.project_id,
      eligible: true,
      score: eligibilityConfidence + softContribution,
      hard_matches: hardMatches,
      soft_matches: softMatches,
    });
  }

  out.sort((a, b) => (b.score - a.score) || a.project_id.localeCompare(b.project_id));

  return {
    policy,
    eligibility_basis: hasHard ? 'hard_groups' : 'no_hard_constraint',
    hard_group_ids: hardGroups.map((g) => g.id),
    soft_group_ids: softGroups.map((g) => g.id),
    projects: out,
  };
}
