import { describe, it, expect } from 'vitest';
import {
  matchGeoPreference,
  predicateKind,
  rollupSatisfied,
  LADDER_CONFIDENCE,
  type MatchingDb,
  type ProjectGeo,
  type UnitPoint,
  type ResolvedGeometry,
  type RollupPolicy,
} from '../geoPreference/matching.js';
import type { GeoJsonGeometry } from '../geoMatch.js';
import type {
  GeoPreference, GeoGroup, GeoClause, AnchorRef, GeoOperation,
} from '../geoPreference/ontology.js';

// ── Geometry fixtures ([lng,lat] GeoJSON) ────────────────────────────────────
// District A — 0.1°×0.1° square around central Riyadh.
const DISTRICT_A: GeoJsonGeometry = {
  type: 'Polygon',
  coordinates: [[[46.60, 24.60], [46.70, 24.60], [46.70, 24.70], [46.60, 24.70], [46.60, 24.60]]],
};
// District B — disjoint square ~30 km east.
const DISTRICT_B: GeoJsonGeometry = {
  type: 'Polygon',
  coordinates: [[[47.00, 24.60], [47.10, 24.60], [47.10, 24.70], [47.00, 24.70], [47.00, 24.60]]],
};
// A road (line) running east–west at lat 24.65, extending PAST district A's east edge.
const ROAD_H: GeoJsonGeometry = { type: 'LineString', coordinates: [[46.60, 24.65], [46.90, 24.65]] };

// ── Resolved-geometry catalog (what the DB port would hand back) ─────────────
const GEOMS: Record<string, ResolvedGeometry> = {
  'geo-distA': { geometry_id: 'geo-distA', operation: 'district_polygon', geometry: DISTRICT_A },
  'geo-distB': { geometry_id: 'geo-distB', operation: 'district_polygon', geometry: DISTRICT_B },
  'geo-roadH': { geometry_id: 'geo-roadH', operation: 'within_distance', geometry: ROAD_H, radius_or_band_m: 1000 },
  'geo-radius': { geometry_id: 'geo-radius', operation: 'within_radius', geometry: { type: 'Point', coordinates: [46.65, 24.65] }, radius_or_band_m: 3000 },
};

// ── Builders ─────────────────────────────────────────────────────────────────
function aref(geometry_id: string, operation: GeoOperation): AnchorRef {
  return {
    geometry_id,
    recipe: { operation, source_anchors: [], resolved_element_ids: [], geo_data_version: 'g', resolver_version: 'r', compiled_at: '2026-01-01T00:00:00Z' },
  };
}
const inc = (...ids: Array<[string, GeoOperation]>): GeoClause => ({ op: 'include', anyOf: ids.map(([id, op]) => aref(id, op)) });
const exc = (...ids: Array<[string, GeoOperation]>): GeoClause => ({ op: 'exclude', anyOf: ids.map(([id, op]) => aref(id, op)) });
function grp(id: string, strength: 'hard' | 'soft', priority: number, clauses: GeoClause[], role: GeoGroup['role'] = 'primary'): GeoGroup {
  return { id, role, strength, priority, clauses };
}
const pref = (groups: GeoGroup[]): GeoPreference => ({ schema_version: 'v1', groups });

function fakeDb(projects: ProjectGeo[], units: Record<string, UnitPoint[]>): MatchingDb {
  return {
    listProjects: async () => projects,
    unitsForProjects: async (ids) => Object.fromEntries(ids.map((id) => [id, units[id] ?? []])),
    resolveGeometries: async (refs) => refs.map((r) => GEOMS[r.geometry_id]).filter((g): g is ResolvedGeometry => !!g),
  };
}

const unit = (id: string, lng: number, lat: number): UnitPoint => ({ unit_id: id, lng, lat });

// ── predicate mapping (relation type, NOT hard/soft) ─────────────────────────
describe('predicate follows the spatial relation', () => {
  it('containment for district / zone / inside', () => {
    expect(predicateKind('district_polygon')).toBe('containment');
    expect(predicateKind('district_union')).toBe('containment');
    expect(predicateKind('zone_union')).toBe('containment');
  });
  it('accessibility for "near a road" / corridor / band', () => {
    expect(predicateKind('within_distance')).toBe('accessibility');
    expect(predicateKind('directional_band')).toBe('accessibility');
    expect(predicateKind('corridor')).toBe('accessibility');
  });
  it('intersection for a broad proximity area', () => {
    expect(predicateKind('within_radius')).toBe('intersection');
  });

  it('the matched hard group reports the predicate of its relation', async () => {
    // Three separate single-anchor hard prefs over one project whose unit
    // satisfies all three; each reports the predicate its relation implies.
    const p: ProjectGeo = { project_id: 'P' };
    const units = { P: [unit('u', 46.66, 24.66)] }; // inside A, ~1.6km from radius centre, ~1.2km from road

    const containment = await matchGeoPreference(pref([grp('g', 'hard', 1, [inc(['geo-distA', 'district_polygon'])])]), fakeDb([p], units));
    expect(containment.projects[0]!.hard_matches[0]!.predicate).toBe('containment');

    const accessibility = await matchGeoPreference(pref([grp('g', 'hard', 1, [inc(['geo-roadH', 'within_distance'])])]), fakeDb([p], { P: [unit('u', 46.66, 24.651)] }));
    expect(accessibility.projects[0]!.hard_matches[0]!.predicate).toBe('accessibility');

    const intersection = await matchGeoPreference(pref([grp('g', 'hard', 1, [inc(['geo-radius', 'within_radius'])])]), fakeDb([p], units));
    expect(intersection.projects[0]!.hard_matches[0]!.predicate).toBe('intersection');
  });
});

// ── eligibility (hard only) vs ranking (soft only) ───────────────────────────
describe('eligibility derives from hard groups only; soft groups only rank', () => {
  // hard: inside district A (containment). soft: near road H (accessibility).
  const geoPref = pref([
    grp('hard-A', 'hard', 1, [inc(['geo-distA', 'district_polygon'])]),
    grp('soft-road', 'soft', 1, [inc(['geo-roadH', 'within_distance'])]),
  ]);

  const projects: ProjectGeo[] = [
    { project_id: 'P1' }, // in A AND near road
    { project_id: 'P2' }, // NOT in A but near road (soft only)
    { project_id: 'P3' }, // in A, far from road (hard only)
  ];
  const units = {
    P1: [unit('u1', 46.65, 24.651)], // inside A, ~0.1km from road
    P2: [unit('u2', 46.75, 24.651)], // east of A (lng>46.70) → outside A, but ~0.1km from road
    P3: [unit('u3', 46.62, 24.62)],  // inside A, ~3.3km south of road
  };

  it('a soft-only match NEVER creates eligibility (P2 excluded)', async () => {
    const r = await matchGeoPreference(geoPref, fakeDb(projects, units));
    expect(r.eligibility_basis).toBe('hard_groups');
    expect(r.projects.map((p) => p.project_id).sort()).toEqual(['P1', 'P3']); // P2 gone
    expect(r.projects.every((p) => p.eligible)).toBe(true);
  });

  it('failing the soft pref NEVER removes eligible inventory (P3 kept)', async () => {
    const r = await matchGeoPreference(geoPref, fakeDb(projects, units));
    const p3 = r.projects.find((p) => p.project_id === 'P3')!;
    expect(p3.eligible).toBe(true);
    expect(p3.soft_matches).toHaveLength(0); // failed the soft pref, still present
    expect(p3.hard_matches).toHaveLength(1);
  });

  it('soft groups only RE-RANK: P1 (hard+soft) outranks P3 (hard only)', async () => {
    const r = await matchGeoPreference(geoPref, fakeDb(projects, units));
    const ids = r.projects.map((p) => p.project_id);
    expect(ids.indexOf('P1')).toBeLessThan(ids.indexOf('P3'));
    const p1 = r.projects.find((p) => p.project_id === 'P1')!;
    const p3 = r.projects.find((p) => p.project_id === 'P3')!;
    expect(p1.soft_matches).toHaveLength(1);
    expect(p1.score).toBeGreaterThan(p3.score);
  });

  it('with NO hard groups, every project is eligible (soft cannot gate)', async () => {
    const softOnly = pref([grp('soft-road', 'soft', 1, [inc(['geo-roadH', 'within_distance'])])]);
    const r = await matchGeoPreference(softOnly, fakeDb(projects, units));
    expect(r.eligibility_basis).toBe('no_hard_constraint');
    expect(r.projects.map((p) => p.project_id).sort()).toEqual(['P1', 'P2', 'P3']);
    // P1/P2 near the road rank above P3 which is not.
    expect(r.projects[r.projects.length - 1]!.project_id).toBe('P3');
  });

  it('a hard EXCLUDE removes an otherwise-eligible project', async () => {
    // hard include A, hard exclude the radius disc around A's centre.
    const withExclude = pref([grp('hard', 'hard', 1, [inc(['geo-distA', 'district_polygon']), exc(['geo-radius', 'within_radius'])])]);
    const near = { X: [unit('ux', 46.65, 24.655)] }; // in A AND ~0.6km from centre → inside exclude disc
    const far = { Y: [unit('uy', 46.62, 24.62)] };    // in A, ~4km from centre → outside exclude disc
    const r = await matchGeoPreference(withExclude, fakeDb([{ project_id: 'X' }, { project_id: 'Y' }], { ...near, ...far }));
    expect(r.projects.map((p) => p.project_id)).toEqual(['Y']);
  });
});

// ── compound project under each rollup policy ────────────────────────────────
describe('compound project (some units inside, some outside) under each rollup policy', () => {
  // 4 units: exactly 1 inside district A, 3 outside (in district B's area).
  const compound: ProjectGeo = { project_id: 'C' };
  const units = {
    C: [
      unit('in1', 46.65, 24.65),   // inside A
      unit('out1', 47.05, 24.65),  // outside A
      unit('out2', 47.06, 24.66),  // outside A
      unit('out3', 47.04, 24.64),  // outside A
    ],
  };
  const hardA = pref([grp('hard-A', 'hard', 1, [inc(['geo-distA', 'district_polygon'])])]);

  const run = (policy: RollupPolicy) => matchGeoPreference(hardA, fakeDb([compound], units), policy);

  it('any_unit → eligible (1 of 4 fits); policy + rollup tally stated in result', async () => {
    const r = await run({ kind: 'any_unit' });
    expect(r.policy).toEqual({ kind: 'any_unit' });
    expect(r.projects.map((p) => p.project_id)).toEqual(['C']);
    const hm = r.projects[0]!.hard_matches[0]!;
    expect(hm.ladder_rung).toBe('unit_point');
    expect(hm.units_total).toBe(4);
    expect(hm.units_matched).toBe(1);
    expect(hm.confidence).toBe(LADDER_CONFIDENCE.unit_point);
  });

  it('n_units(2) → NOT eligible (only 1 fits)', async () => {
    const r = await run({ kind: 'n_units', k: 2 });
    expect(r.projects).toHaveLength(0);
  });

  it('n_units(1) → eligible', async () => {
    const r = await run({ kind: 'n_units', k: 1 });
    expect(r.projects.map((p) => p.project_id)).toEqual(['C']);
  });

  it('share_of_units(0.5) → NOT eligible (0.25 < 0.5)', async () => {
    const r = await run({ kind: 'share_of_units', fraction: 0.5 });
    expect(r.projects).toHaveLength(0);
  });

  it('share_of_units(0.25) → eligible (0.25 ≥ 0.25)', async () => {
    const r = await run({ kind: 'share_of_units', fraction: 0.25 });
    expect(r.projects.map((p) => p.project_id)).toEqual(['C']);
  });

  it('rollupSatisfied is the single source of the policy semantics', () => {
    expect(rollupSatisfied({ kind: 'any_unit' }, 1, 4)).toBe(true);
    expect(rollupSatisfied({ kind: 'any_unit' }, 0, 4)).toBe(false);
    expect(rollupSatisfied({ kind: 'n_units', k: 2 }, 1, 4)).toBe(false);
    expect(rollupSatisfied({ kind: 'share_of_units', fraction: 0.5 }, 2, 4)).toBe(true);
    expect(rollupSatisfied({ kind: 'any_unit' }, 1, 0)).toBe(false); // no units-with-coords
  });
});

// ── geometry ladder: unit_point → project_polygon → project_centroid ─────────
describe('geometry ladder falls back only when finer data is missing', () => {
  const hardA = pref([grp('hard-A', 'hard', 1, [inc(['geo-distA', 'district_polygon'])])]);

  it('a project with NO units matches via its footprint polygon (medium confidence)', async () => {
    const poly: GeoJsonGeometry = { type: 'Polygon', coordinates: [[[46.64, 24.64], [46.66, 24.64], [46.66, 24.66], [46.64, 24.66], [46.64, 24.64]]] };
    const r = await matchGeoPreference(hardA, fakeDb([{ project_id: 'PP', polygon: poly }], { PP: [] }));
    const hm = r.projects[0]!.hard_matches[0]!;
    expect(hm.ladder_rung).toBe('project_polygon');
    expect(hm.confidence).toBe(LADDER_CONFIDENCE.project_polygon);
  });

  it('a project with only a centroid matches via the centroid rung (lowest confidence)', async () => {
    const r = await matchGeoPreference(hardA, fakeDb([{ project_id: 'PC', centroid: { lat: 24.65, lng: 46.65 } }], { PC: [] }));
    const hm = r.projects[0]!.hard_matches[0]!;
    expect(hm.ladder_rung).toBe('project_centroid');
    expect(hm.confidence).toBe(LADDER_CONFIDENCE.project_centroid);
  });

  it('unit coordinates are authoritative: a failed unit rollup does NOT fall back to a matching centroid', async () => {
    // Units all OUTSIDE A (rollup fails), but the centroid IS inside A. Finer data wins → excluded.
    const proj: ProjectGeo = { project_id: 'PU', centroid: { lat: 24.65, lng: 46.65 } };
    const units = { PU: [unit('o1', 47.05, 24.65), unit('o2', 47.06, 24.66)] };
    const r = await matchGeoPreference(hardA, fakeDb([proj], units), { kind: 'any_unit' });
    expect(r.projects).toHaveLength(0);
  });
});
