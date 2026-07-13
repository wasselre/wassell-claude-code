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

// ── geometry-aware element rules: roads (line) + zones (polygon) ─────────────
describe('line + polygon element rules', () => {
  // Horizontal road (east-west) at lat 24.65; vertical road at lng 46.65.
  const ROAD_H: GeoJsonGeometry = { type: 'LineString', coordinates: [[46.60, 24.65], [46.70, 24.65]] };
  const ROAD_V: GeoJsonGeometry = { type: 'LineString', coordinates: [[46.65, 24.60], [46.65, 24.70]] };
  // Zone polygon = the DISTRICT_A square (46.60–46.70, 24.60–24.70).
  const ZONE: GeoJsonGeometry = DISTRICT_A;

  const geoEl = (lat: number, lng: number, geometry: GeoJsonGeometry, geomKind: 'point' | 'linestring' | 'polygon') =>
    ({ lat, lng, isActive: true, reviewStatus: 'approved', confidenceScore: 0.9, geometry, geomKind });
  const gctx: CompileCtx = {
    districtBoundary: () => null,
    resolveElement: (id) =>
      id === 'road_h' ? geoEl(24.65, 46.65, ROAD_H, 'linestring')
        : id === 'road_v' ? geoEl(24.65, 46.65, ROAD_V, 'linestring')
          : id === 'zone' ? geoEl(24.65, 46.65, ZONE, 'polygon')
            : id === 'kafd_pt' ? { lat: KAFD.lat, lng: KAFD.lng, isActive: true, reviewStatus: 'approved', confidenceScore: 0.9, geometry: { type: 'Point', coordinates: [KAFD.lng, KAFD.lat] } as GeoJsonGeometry, geomKind: 'point' as const }
              : null,
  };
  const rule = (r: string, element_id: string, extra: Record<string, unknown> = {}, polarity: 'include' | 'exclude' = 'include'): LocationItem =>
    ({ id: `li-${r}`, kind: 'element_rule', polarity, conditions: [{ rule: r, element_id, ...extra }] as never });

  it('north_of / south_of a horizontal road', () => {
    const north = compileItem(rule('north_of', 'road_h'), gctx);
    expect(north.validationStatus).toBe('ok');
    expect(north.contains(46.65, 24.66)).toBe(true);  // north of the road
    expect(north.contains(46.65, 24.64)).toBe(false); // south of the road
    const south = compileItem(rule('south_of', 'road_h'), gctx);
    expect(south.contains(46.65, 24.64)).toBe(true);
    expect(south.contains(46.65, 24.66)).toBe(false);
  });

  it('east_of / west_of a vertical road', () => {
    const east = compileItem(rule('east_of', 'road_v'), gctx);
    expect(east.contains(46.66, 24.65)).toBe(true);   // east of the road
    expect(east.contains(46.64, 24.65)).toBe(false);  // west of the road
    const west = compileItem(rule('west_of', 'road_v'), gctx);
    expect(west.contains(46.64, 24.65)).toBe(true);
    expect(west.contains(46.66, 24.65)).toBe(false);
  });

  it('within_distance of a road uses the full line, not a centroid', () => {
    const near = compileItem(rule('within_distance', 'road_h', { distance_m: 1000 }), gctx);
    expect(near.validationStatus).toBe('ok');
    // ~0.5 km north of the road (still 1 km even though far from the road's midpoint).
    expect(near.contains(46.61, 24.6545)).toBe(true);
    // ~5.5 km north of the road → outside 1 km.
    expect(near.contains(46.65, 24.70)).toBe(false);
  });

  it('inside_area of a zone polygon (include + exclude)', () => {
    const inside = compileItem(rule('inside_area', 'zone'), gctx);
    expect(inside.contains(46.65, 24.65)).toBe(true);  // inside the zone
    expect(inside.contains(47.05, 24.65)).toBe(false); // outside the zone
    // exclude inside_area removes a candidate inside the zone.
    const cIn: GeoCandidate = { id: 'p_in', lng: 46.65, lat: 24.65 };
    const cOut: GeoCandidate = { id: 'p_out', lng: 47.05, lat: 24.65 };
    const { matches } = compileAndMatch(
      [includeDistrictB, rule('inside_area', 'zone', {}, 'exclude')], gctx2WithB(gctx), [cIn, cOut],
    );
    // include = district B (contains p_out's 47.05/24.65), exclude = inside zone (drops nothing in B).
    expect(matches.map((m) => m.id)).toEqual(['p_out']);
  });

  it('within_distance of a zone polygon (edge collar, inside = 0 distance)', () => {
    const near = compileItem(rule('within_distance', 'zone', { distance_m: 1000 }), gctx);
    expect(near.contains(46.65, 24.65)).toBe(true);    // inside → distance 0
    expect(near.contains(46.705, 24.65)).toBe(true);   // ~0.5 km east of the edge
    expect(near.contains(46.80, 24.65)).toBe(false);   // ~10 km east of the edge
  });

  it('geometry/kind mismatch → needs_review (never a silent wrong match)', () => {
    expect(compileItem(rule('inside_area', 'road_h'), gctx).validationStatus).toBe('needs_review'); // line, not polygon
    expect(compileItem(rule('north_of', 'zone'), gctx).validationStatus).toBe('needs_review');      // polygon, not line
    expect(compileItem(rule('north_of', 'kafd_pt'), gctx).validationStatus).toBe('needs_review');   // point, not line
  });
});

// District B as an include, reusing the top-level fixture via a merged ctx.
function gctx2WithB(base: CompileCtx): CompileCtx {
  return {
    resolveElement: base.resolveElement,
    districtBoundary: (id) => (id === 'dist-B' ? DISTRICT_B : null),
  };
}

// ── drawn_area (free-drawn polygon from the map picker) ─────────────────────
describe('drawn_area items', () => {
  const RING: [number, number][] = [[46.60, 24.60], [46.70, 24.60], [46.70, 24.70], [46.60, 24.70], [46.60, 24.60]];
  const drawn: LocationItem = { id: 'li-drawn', kind: 'drawn_area', polarity: 'include', coordinates: RING };

  it('a closed ring compiles ok and contains its interior only', () => {
    const c = compileItem(drawn, ctx);
    expect(c.validationStatus).toBe('ok');
    expect(c.hasArea).toBe(true);
    expect(c.contains(46.65, 24.65)).toBe(true);  // inside
    expect(c.contains(46.75, 24.65)).toBe(false); // outside
  });

  it('an OPEN ring or too-few points → needs_review (mirrors the SQL gate)', () => {
    const open: LocationItem = { id: 'li-open', kind: 'drawn_area', polarity: 'include', coordinates: RING.slice(0, 4) as [number, number][] };
    expect(compileItem(open, ctx).validationStatus).toBe('needs_review');
    const tiny: LocationItem = { id: 'li-tiny', kind: 'drawn_area', polarity: 'include', coordinates: [[46.6, 24.6], [46.7, 24.6], [46.6, 24.6]] };
    expect(compileItem(tiny, ctx).validationStatus).toBe('needs_review');
  });

  it('multiple drawn shapes OR-union; an exclude drawn area subtracts', () => {
    const RING_B: [number, number][] = [[47.00, 24.60], [47.10, 24.60], [47.10, 24.70], [47.00, 24.70], [47.00, 24.60]];
    const drawnB: LocationItem = { id: 'li-drawn-B', kind: 'drawn_area', polarity: 'include', coordinates: RING_B };
    const inA: GeoCandidate = { id: 'p-a', lat: 24.65, lng: 46.65 };
    const inB: GeoCandidate = { id: 'p-b', lat: 24.65, lng: 47.05 };
    const outside: GeoCandidate = { id: 'p-out', lat: 24.65, lng: 46.85 };
    const { matches } = compileAndMatch([drawn, drawnB], ctx, [inA, inB, outside]);
    expect(matches.map((m) => m.id).sort()).toEqual(['p-a', 'p-b']);

    const excludeDrawnA: LocationItem = { id: 'li-xdrawn', kind: 'drawn_area', polarity: 'exclude', coordinates: RING };
    const both = compileAndMatch([drawn, drawnB, excludeDrawnA], ctx, [inA, inB]);
    expect(both.matches.map((m) => m.id)).toEqual(['p-b']);
  });
});
