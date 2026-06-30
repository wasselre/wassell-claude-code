import { describe, it, expect } from 'vitest';
import {
  compileItem,
  compileAndMatch,
  matchCandidates,
  haversineKm,
  type CompileCtx,
  type GeoJsonGeometry,
  type LocationItem,
  type GeoCandidate,
} from '../geoMatch.js';

// ── Fixtures ────────────────────────────────────────────────────────────────
// District "A" — a 0.1°×0.1° square around central Riyadh ([lng,lat] GeoJSON).
const DISTRICT_A: GeoJsonGeometry = {
  type: 'Polygon',
  coordinates: [[[46.60, 24.60], [46.70, 24.60], [46.70, 24.70], [46.60, 24.70], [46.60, 24.60]]],
};
// District "B" — a disjoint square ~30 km east, no overlap with A or the KAFD disc.
const DISTRICT_B: GeoJsonGeometry = {
  type: 'Polygon',
  coordinates: [[[47.00, 24.60], [47.10, 24.60], [47.10, 24.70], [47.00, 24.70], [47.00, 24.60]]],
};

const KAFD = { lat: 24.7625, lng: 46.6406 }; // a point landmark NORTH of district A

// A usable, approved, high-confidence anchor resolver (mirrors geo_elements rows).
const okEl = (lat: number, lng: number) => ({ lat, lng, isActive: true, reviewStatus: 'approved', confidenceScore: 0.9 });
const ctx: CompileCtx = {
  districtBoundary: (id) => (id === 'dist-A' ? DISTRICT_A : id === 'dist-B' ? DISTRICT_B : null),
  resolveElement: (id) => (id === 'kafd' ? okEl(KAFD.lat, KAFD.lng) : null),
};

const includeDistrictA: LocationItem = { id: 'li-A', kind: 'district', polarity: 'include', district_id: 'dist-A' };
const includeDistrictB: LocationItem = { id: 'li-B', kind: 'district', polarity: 'include', district_id: 'dist-B' };
const excludeDistrictA: LocationItem = { id: 'li-xA', kind: 'district', polarity: 'exclude', district_id: 'dist-A' };
const within5kmKafd: LocationItem = {
  id: 'li-kafd', kind: 'element_rule', polarity: 'include',
  conditions: [{ rule: 'within_radius', element_id: 'kafd', distance_m: 5000 }],
};
const outside3kmKafd: LocationItem = {
  id: 'li-xkafd', kind: 'element_rule', polarity: 'exclude',
  conditions: [{ rule: 'within_radius', element_id: 'kafd', distance_m: 3000 }],
};

// ── radius containment ──────────────────────────────────────────────────────
describe('within_radius containment', () => {
  const compiled = compileItem(within5kmKafd, ctx);

  it('compiles to a usable area (ok, hasArea)', () => {
    expect(compiled.validationStatus).toBe('ok');
    expect(compiled.hasArea).toBe(true);
  });

  it('includes a point inside the radius', () => {
    // ~1 km north of KAFD.
    const near = { lng: KAFD.lng, lat: KAFD.lat + 0.009 };
    expect(haversineKm(near.lat, near.lng, KAFD.lat, KAFD.lng)).toBeLessThan(5);
    expect(compiled.contains(near.lng, near.lat)).toBe(true);
  });

  it('excludes a point outside the radius', () => {
    // ~8 km north of KAFD (0.072° ≈ 8 km).
    const far = { lng: KAFD.lng, lat: KAFD.lat + 0.072 };
    expect(haversineKm(far.lat, far.lng, KAFD.lat, KAFD.lng)).toBeGreaterThan(5);
    expect(compiled.contains(far.lng, far.lat)).toBe(false);
  });

  it('marks needs_review when the element is unresolved', () => {
    const bad: LocationItem = {
      id: 'li-bad', kind: 'element_rule', polarity: 'include',
      conditions: [{ rule: 'within_radius', element_id: 'missing', distance_m: 5000 }],
    };
    expect(compileItem(bad, ctx).validationStatus).toBe('needs_review');
  });
});

// ── anchor usability gate (missing | inactive | rejected | low_confidence | invalid) ─
describe('within_radius anchor usability gate', () => {
  const ruleOn = (id: string): LocationItem => ({
    id: 'li', kind: 'element_rule', polarity: 'include',
    conditions: [{ rule: 'within_radius', element_id: id, distance_m: 5000 }],
  });
  const ctxFor = (el: ReturnType<CompileCtx['resolveElement']>): CompileCtx => ({
    districtBoundary: () => null,
    resolveElement: () => el,
  });

  it('usable: active, approved, confidence ≥ floor → ok', () => {
    expect(compileItem(ruleOn('x'), ctxFor({ lat: 24.7, lng: 46.6, isActive: true, reviewStatus: 'approved', confidenceScore: 0.9 })).validationStatus).toBe('ok');
  });
  it('inactive → needs_review', () => {
    expect(compileItem(ruleOn('x'), ctxFor({ lat: 24.7, lng: 46.6, isActive: false, reviewStatus: 'approved', confidenceScore: 0.9 })).validationStatus).toBe('needs_review');
  });
  it('rejected → needs_review', () => {
    expect(compileItem(ruleOn('x'), ctxFor({ lat: 24.7, lng: 46.6, isActive: true, reviewStatus: 'rejected', confidenceScore: 0.9 })).validationStatus).toBe('needs_review');
  });
  it('low confidence (< 0.5) → needs_review', () => {
    expect(compileItem(ruleOn('x'), ctxFor({ lat: 24.7, lng: 46.6, isActive: true, reviewStatus: 'approved', confidenceScore: 0.3 })).validationStatus).toBe('needs_review');
  });
  it('null confidence is allowed (unknown ≠ low) → ok', () => {
    expect(compileItem(ruleOn('x'), ctxFor({ lat: 24.7, lng: 46.6, isActive: true, reviewStatus: 'pending', confidenceScore: null })).validationStatus).toBe('ok');
  });
  it('invalid coordinates → needs_review', () => {
    expect(compileItem(ruleOn('x'), ctxFor({ lat: NaN, lng: 46.6, isActive: true, reviewStatus: 'approved', confidenceScore: 0.9 })).validationStatus).toBe('needs_review');
  });
});

// ── OR union across items ───────────────────────────────────────────────────
describe('OR union across location items', () => {
  // Candidate in A only, candidate in KAFD-radius only, candidate in B only.
  const inA: GeoCandidate = { id: 'p_inA', lng: 46.65, lat: 24.65 };                 // inside district A
  const inKafd: GeoCandidate = { id: 'p_inKafd', lng: KAFD.lng, lat: KAFD.lat + 0.009 }; // ~1km from KAFD (outside A)
  const inB: GeoCandidate = { id: 'p_inB', lng: 47.05, lat: 24.65 };                 // inside district B only
  const nowhere: GeoCandidate = { id: 'p_none', lng: 50.0, lat: 26.0 };              // far away

  it('unions district A OR within-5km-KAFD — both sets contribute', () => {
    const { matches } = compileAndMatch([includeDistrictA, within5kmKafd], ctx, [inA, inKafd, inB, nowhere]);
    const ids = matches.map((m) => m.id).sort();
    expect(ids).toEqual(['p_inA', 'p_inKafd']); // B and nowhere excluded; union of the two areas
  });

  it('the KAFD candidate is matched by the radius item, not the district item', () => {
    const { matches } = compileAndMatch([includeDistrictA, within5kmKafd], ctx, [inKafd]);
    expect(matches[0]!.matchedBy).toEqual(['li-kafd']);
  });

  it('three include items union into one combined set', () => {
    const { matches } = compileAndMatch([includeDistrictA, includeDistrictB, within5kmKafd], ctx, [inA, inKafd, inB, nowhere]);
    expect(matches.map((m) => m.id).sort()).toEqual(['p_inA', 'p_inB', 'p_inKafd']);
  });
});

// ── dedup by id ─────────────────────────────────────────────────────────────
describe('dedup by id', () => {
  it('a candidate satisfying multiple items appears once with both item ids', () => {
    // A point inside district A AND within 5km of KAFD — but KAFD (24.7625) is
    // north of A's top edge (24.70), so craft a point in their overlap instead:
    // place a point just inside A's north edge and shrink? Simpler: use a candidate
    // that matches district A and ALSO district A again via a second include? Use
    // district A + a radius around a point INSIDE A.
    const ctx2: CompileCtx = { ...ctx, resolveElement: (id) => (id === 'center' ? okEl(24.65, 46.65) : ctx.resolveElement(id)) };
    const within2kmCenter: LocationItem = {
      id: 'li-center', kind: 'element_rule', polarity: 'include',
      conditions: [{ rule: 'within_radius', element_id: 'center', distance_m: 2000 }],
    };
    const overlap: GeoCandidate = { id: 'p_overlap', lng: 46.65, lat: 24.65 }; // in A AND within 2km of center
    const matches = matchCandidates(
      [compileItem(includeDistrictA, ctx2), compileItem(within2kmCenter, ctx2)],
      [overlap, overlap], // same id twice (e.g. project + listing tables) → must dedup
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]!.id).toBe('p_overlap');
    expect(matches[0]!.matchedBy.sort()).toEqual(['li-A', 'li-center']);
  });
});

// ── exclusion subtraction ───────────────────────────────────────────────────
describe('exclusion subtraction', () => {
  it('exclude district removes a candidate inside it (point-in-polygon)', () => {
    const inA: GeoCandidate = { id: 'p_inA', lng: 46.65, lat: 24.65 };
    const inB: GeoCandidate = { id: 'p_inB', lng: 47.05, lat: 24.65 };
    const { matches } = compileAndMatch([includeDistrictA, includeDistrictB, excludeDistrictA], ctx, [inA, inB]);
    expect(matches.map((m) => m.id)).toEqual(['p_inB']); // A subtracted, B kept
  });

  it('exclude district removes a POINT-LESS candidate by stored district id', () => {
    const pointless: GeoCandidate = { id: 'p_pl', districtId: 'dist-A' }; // no pin
    const { matches } = compileAndMatch([includeDistrictA, excludeDistrictA], ctx, [pointless]);
    expect(matches).toHaveLength(0);
  });

  it('outside_radius (exclude radius) carves a hole out of an include district', () => {
    // Include a big disc around KAFD, exclude the inner 3km — a point 1km from KAFD
    // is in the include but also in the exclude → dropped; a point 4km away survives.
    const within10kmKafd: LocationItem = {
      id: 'li-k10', kind: 'element_rule', polarity: 'include',
      conditions: [{ rule: 'within_radius', element_id: 'kafd', distance_m: 10000 }],
    };
    const near1km: GeoCandidate = { id: 'p_1km', lng: KAFD.lng, lat: KAFD.lat + 0.009 };  // ~1km
    const near4km: GeoCandidate = { id: 'p_4km', lng: KAFD.lng, lat: KAFD.lat + 0.036 };  // ~4km
    const { matches } = compileAndMatch([within10kmKafd, outside3kmKafd], ctx, [near1km, near4km]);
    expect(matches.map((m) => m.id)).toEqual(['p_4km']);
  });
});

// ── point-less candidate via include district ───────────────────────────────
describe('point-less candidates', () => {
  it('a project with no pin matches by stored district id (include district)', () => {
    const pointless: GeoCandidate = { id: 'p_pl', districtId: 'dist-A' };
    const { matches } = compileAndMatch([includeDistrictA], ctx, [pointless]);
    expect(matches.map((m) => m.id)).toEqual(['p_pl']);
  });

  it('a point-less project can NOT match a radius-only preference', () => {
    const pointless: GeoCandidate = { id: 'p_pl', districtId: 'dist-A' };
    const { matches } = compileAndMatch([within5kmKafd], ctx, [pointless]);
    expect(matches).toHaveLength(0); // no pin → radius is unprovable → not a false match
  });
});
