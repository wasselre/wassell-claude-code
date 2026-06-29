import { describe, it, expect } from 'vitest';
import { __test, type MatchResultItem, type MatchCoreSuccess, type MatchRequirements } from '../matchAgent';
import { classifyGeo } from '../geoVerify';
import {
  groupForFinder,
  finderGroupFor,
  finderBand,
  buildExplanation,
  type FinderResult,
} from '../projectFinder';
import { assertRankingUnchanged, applyLlmExplanations, coerceParsedRequirements } from '../projectFinderAI';

const { scoreProject } = __test;

// ── Shared fixtures ──────────────────────────────────────────────────────────
const DIST_A = 'district-a';
const DIST_B = 'district-b';
const CITY = 'city-riyadh';
// Centroid of district A (Riyadh-ish) and a project pin ~5 km away (district B).
const A_CENTROID = { lat: 24.7136, lng: 46.6753 };
const NEAR_PIN = { lat: 24.758, lng: 46.69 }; // ~5.2 km from A_CENTROID
const FAR_PIN = { lat: 25.3, lng: 47.2 }; // ~90 km away

const baseProject = {
  project_name: 'Test Project',
  unit_types: ['apartments'],
  project_status: 'available',
  price_range: { min: 500_000, max: 1_200_000 },
  area_range: { min: 90, max: 300 },
  bedroom_range: { min: 1, max: 3 },
  bathroom_range: { min: 2, max: 4 },
  available_units: 50,
};

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1 — A project point INSIDE the requested district polygon is an EXACT match.
// (Geography is boundary-verified: the engine matches on the polygon-derived
// district, supplied here via the verified GeoContext.)
// ─────────────────────────────────────────────────────────────────────────────
describe('1. point inside requested district polygon → exact', () => {
  it('matches exact when the coordinate-verified district equals the requested one', () => {
    // classifyGeo proves the pin verifies to district A.
    const v = classifyGeo({ lat: A_CENTROID.lat, lng: A_CENTROID.lng, storedDistrictId: DIST_A, polygonDistrictId: DIST_A });
    expect(v.status).toBe('verified_match');
    expect(v.verified).toBe(true);
    expect(v.effectiveDistrictId).toBe(DIST_A);

    const r = scoreProject(baseProject, { district: 'الفاروق', city: 'الرياض' }, {
      projLat: A_CENTROID.lat, projLng: A_CENTROID.lng,
      reqLat: A_CENTROID.lat, reqLng: A_CENTROID.lng,
      reqDistrictId: DIST_A, reqCityId: CITY,
      projDistrictId: v.effectiveDistrictId, projCityId: CITY,
      geoConfidence: v.geoConfidence,
    });
    expect(r.match_type).toBe('exact');
    expect(r.location_tier).toBe('exact');
    expect(r.district_exact).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2 — Outside the requested district but within the nearby threshold → nearby,
// ranked by real distance, with distance_km.
// ─────────────────────────────────────────────────────────────────────────────
describe('2. nearby district within threshold → nearby (ranked by distance)', () => {
  it('scores a ~5km project in another district as nearby with distance_km', () => {
    const r = scoreProject(baseProject, { district: 'الفاروق' }, {
      projLat: NEAR_PIN.lat, projLng: NEAR_PIN.lng,
      reqLat: A_CENTROID.lat, reqLng: A_CENTROID.lng,
      reqDistrictId: DIST_A, reqCityId: CITY,
      projDistrictId: DIST_B, projCityId: CITY, // different (verified) district
      geoConfidence: 'high',
    });
    expect(r.match_type).toBe('nearby');
    expect(r.location_tier).toBe('nearby');
    expect(r.distance_km).not.toBeNull();
    expect(r.distance_km!).toBeGreaterThan(3);
    expect(r.distance_km!).toBeLessThan(8);
  });

  it('groups nearby matches and ranks closest-first', () => {
    const mk = (id: string, dist: number): MatchResultItem => ({
      project_id: id, project_name: id, data_source: 'our_projects',
      score: 70, match_band: 'good', match_type: 'nearby', district_match_basis: null,
      score_breakdown: {}, facts: {}, data_gaps: [], missing_info: [],
      location_tier: 'nearby', distance_km: dist, geo_confidence: 'high',
    });
    const core = makeCore({ our: [mk('far', 8), mk('close', 3)] });
    const res = groupForFinder(core, { district: 'الفاروق' });
    const nearby = res.groups.nearby_district_matches;
    expect(nearby.map((m) => m.project_id)).toEqual(['close', 'far']);
    expect(nearby[0]!.match_type).toBe('nearby');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3 — Stored district A but coordinates inside district B → MISMATCH detected,
// NOT treated as a trusted exact match for the stored district.
// ─────────────────────────────────────────────────────────────────────────────
describe('3. stored ≠ coordinate polygon → mismatch (no false exact)', () => {
  it('classifyGeo flags mismatch and trusts the polygon district', () => {
    const v = classifyGeo({ lat: NEAR_PIN.lat, lng: NEAR_PIN.lng, storedDistrictId: DIST_A, polygonDistrictId: DIST_B });
    expect(v.status).toBe('mismatch');
    expect(v.effectiveDistrictId).toBe(DIST_B); // trust coordinates, not stored text
    expect(v.geoConfidence).toBe('low');
    expect(v.mismatchWarnings.length).toBeGreaterThan(0);
    expect(v.dataGaps).toContain('district_mismatch');
  });

  it('a request for the STORED district does NOT score as exact (false-exact prevented)', () => {
    const v = classifyGeo({ lat: NEAR_PIN.lat, lng: NEAR_PIN.lng, storedDistrictId: DIST_A, polygonDistrictId: DIST_B });
    const r = scoreProject(baseProject, { district: 'الفاروق' }, {
      projLat: NEAR_PIN.lat, projLng: NEAR_PIN.lng,
      reqLat: A_CENTROID.lat, reqLng: A_CENTROID.lng,
      reqDistrictId: DIST_A, // request resolves to the stored district A
      reqCityId: CITY,
      projDistrictId: v.effectiveDistrictId, // verified = B
      projCityId: CITY, geoConfidence: v.geoConfidence,
    });
    expect(r.match_type).not.toBe('exact');
    expect(r.district_exact).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 4 — Missing lat/lng → low/medium geo confidence, NOT verified as exact.
// ─────────────────────────────────────────────────────────────────────────────
describe('4. missing coordinates → not coordinate-verified', () => {
  it('no coords + stored district → unverified_no_coords / medium / not verified', () => {
    const v = classifyGeo({ lat: null, lng: null, storedDistrictId: DIST_A, polygonDistrictId: null });
    expect(v.status).toBe('unverified_no_coords');
    expect(v.verified).toBe(false);
    expect(v.geoConfidence).toBe('medium');
    expect(v.dataGaps).toContain('missing_project_coordinates');
  });
  it('no coords + no stored district → no_geography / low', () => {
    const v = classifyGeo({ lat: null, lng: null, storedDistrictId: null, polygonDistrictId: null });
    expect(v.status).toBe('no_geography');
    expect(v.geoConfidence).toBe('low');
    expect(v.effectiveDistrictId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 5 — Client MULTI-district preferences: a project in ANY preferred district is exact.
// ─────────────────────────────────────────────────────────────────────────────
describe('5. client multi-district preferences', () => {
  it('matches exact when the verified district is in the requested set', () => {
    const r = scoreProject(baseProject, { district: 'الفاروق', districts: ['الفاروق', 'النرجس'] }, {
      reqDistrictId: DIST_A, reqDistrictIds: [DIST_A, DIST_B], reqCityId: CITY, reqCityIds: [CITY],
      projDistrictId: DIST_B, // not the primary, but in the set
      projCityId: CITY,
    });
    expect(r.match_type).toBe('exact');
    expect(r.district_exact).toBe(true);
  });
  it('a district outside the set is not exact', () => {
    const r = scoreProject(baseProject, { district: 'الفاروق', districts: ['الفاروق', 'النرجس'] }, {
      reqDistrictId: DIST_A, reqDistrictIds: [DIST_A, DIST_B], reqCityId: CITY, reqCityIds: [CITY],
      projDistrictId: 'district-c', projCityId: CITY,
    });
    expect(r.district_exact).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 6 — Units inherit project location: the scorer reads geography ONLY from the
// project-derived GeoContext, never from a per-unit field. (Units carry no own
// district; their geography is the project's project_location mirror.)
// ─────────────────────────────────────────────────────────────────────────────
describe('6. units inherit project location through project_location', () => {
  it('location matching ignores record-level district fields and uses the project GeoContext', () => {
    // A project record that (deliberately) has a misleading stray district in its
    // raw data — the scorer must NOT read it; only the GeoContext drives location.
    const withStray = { ...baseProject, district: 'SOME_RAW_TEXT', location: { district: 'raw-unverified' } };
    const r = scoreProject(withStray, { district: 'الفاروق' }, {
      projLat: A_CENTROID.lat, projLng: A_CENTROID.lng,
      reqLat: A_CENTROID.lat, reqLng: A_CENTROID.lng,
      reqDistrictId: DIST_A, reqCityId: CITY,
      projDistrictId: DIST_A, // the project's authoritative (verified) district
      projCityId: CITY, geoConfidence: 'high',
    });
    expect(r.match_type).toBe('exact'); // matched via GeoContext, not the stray data field
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 7 — Budget filtering.
// ─────────────────────────────────────────────────────────────────────────────
describe('7. budget filtering', () => {
  it('within budget → full budget credit', () => {
    const r = scoreProject(baseProject, { budget_max: 1_000_000 }, {});
    expect(r.breakdown.budget).toBe(1);
  });
  it('entirely above budget (no stretch) → zero budget credit', () => {
    const pricey = { ...baseProject, price_range: { min: 3_000_000, max: 5_000_000 } };
    const r = scoreProject(pricey, { budget_max: 1_000_000, allow_stretch: false }, {});
    expect(r.breakdown.budget).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 8 — Unit type filtering.
// ─────────────────────────────────────────────────────────────────────────────
describe('8. unit type filtering', () => {
  it('matching type → full type credit', () => {
    const r = scoreProject(baseProject, { property_type: 'شقة' }, {}); // apartment synonym
    expect(r.breakdown.type).toBe(1);
  });
  it('wrong type → type credit 0 and band capped to partial', () => {
    const villa = { ...baseProject, unit_types: ['villa'] };
    const r = scoreProject(villa, { property_type: 'شقة', budget_max: 2_000_000 }, {
      reqDistrictId: DIST_A, projDistrictId: DIST_A,
    });
    expect(r.breakdown.type).toBe(0);
    expect(r.band).toBe('partial');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 9 — Bedrooms / bathrooms filtering.
// ─────────────────────────────────────────────────────────────────────────────
describe('9. bedrooms / bathrooms filtering', () => {
  it('bedrooms in range → full credit; out of range → zero', () => {
    expect(scoreProject(baseProject, { bedrooms: 2 }, {}).breakdown.bedrooms).toBe(1);
    expect(scoreProject(baseProject, { bedrooms: 9 }, {}).breakdown.bedrooms).toBe(0);
  });
  it('bathrooms in range → full credit; out of range → zero', () => {
    expect(scoreProject(baseProject, { bathrooms: 3 }, {}).breakdown.bathrooms).toBe(1);
    expect(scoreProject(baseProject, { bathrooms: 9 }, {}).breakdown.bathrooms).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 10 — The LLM cannot change score, band, source, match_type, or ranking.
// ─────────────────────────────────────────────────────────────────────────────
describe('10. LLM cannot alter ranking — only explanation text', () => {
  const item = (id: string, score: number): MatchResultItem => ({
    project_id: id, project_name: id, data_source: 'our_projects',
    score, match_band: score >= 75 ? 'strong' : 'good', match_type: 'exact', district_match_basis: 'lookup',
    score_breakdown: {}, facts: {}, data_gaps: [], missing_info: [],
    location_tier: 'exact', distance_km: null, geo_confidence: 'high',
  });
  const core = makeCore({ our: [item('p1', 90), item('p2', 80)] });
  const res = groupForFinder(core, { district: 'الفاروق' });

  it('applies explanation text without moving ranking', () => {
    const after = applyLlmExplanations(res, { p1: 'Great fit.', p2: 'Solid option.' });
    expect(after.groups.exact_district_matches.map((m) => m.project_id)).toEqual(['p1', 'p2']);
    expect(after.groups.exact_district_matches[0]!.explanation).toBe('Great fit.');
    expect(after.groups.exact_district_matches[0]!.score).toBe(90);
  });

  it('ignores LLM attempts to add projects or change scores', () => {
    // A hostile payload: only project_id + explanation are read; everything else ignored.
    const after = applyLlmExplanations(res, { p1: 'x', p2: 'y', 'invented-id': 'should be dropped' });
    const ids = after.groups.exact_district_matches.map((m) => m.project_id);
    expect(ids).toEqual(['p1', 'p2']); // no invented project added
    // and the guard confirms nothing but text moved
    expect(() => assertRankingUnchanged(res, after)).not.toThrow();
  });

  it('assertRankingUnchanged THROWS if a ranking field is tampered with', () => {
    const tampered: FinderResult = {
      ...res,
      groups: {
        ...res.groups,
        exact_district_matches: [
          { ...res.groups.exact_district_matches[1]! }, // reordered!
          { ...res.groups.exact_district_matches[0]! },
        ],
      },
    };
    expect(() => assertRankingUnchanged(res, tampered)).toThrow(/ranking violation/i);
  });
});

// ── extra unit coverage for the pure grouping/explanation helpers ─────────────
describe('finder grouping helpers', () => {
  it('finderGroupFor: city-only exact lands in same_city, not exact_district', () => {
    const it1: MatchResultItem = {
      project_id: 'x', project_name: 'x', data_source: 'our_projects', score: 80, match_band: 'good',
      match_type: 'exact', district_match_basis: 'lookup', score_breakdown: {}, facts: {}, data_gaps: [],
      missing_info: [], location_tier: 'exact', distance_km: null, geo_confidence: 'high',
    };
    expect(finderGroupFor(it1, false).group).toBe('same_city_matches');
    expect(finderGroupFor(it1, true).group).toBe('exact_district_matches');
  });
  it('finderBand: partial + low geo → weak', () => {
    const weak: MatchResultItem = {
      project_id: 'x', project_name: 'x', data_source: 'all_projects', score: 45, match_band: 'partial',
      match_type: 'partial', district_match_basis: null, score_breakdown: {}, facts: {}, data_gaps: [],
      missing_info: [], location_tier: 'none', distance_km: null, geo_confidence: 'low',
      requires_verification: true,
    };
    expect(finderBand(weak)).toBe('weak');
  });
  it('buildExplanation grounds only in given facts', () => {
    const e = buildExplanation({
      match_type: 'nearby', match_band: 'good', source: 'our_projects', distance_km: 4.2,
      geo_confidence: 'high', facts: { district: 'النرجس', available_units: 12 }, data_gaps: [], mismatch_warnings: [],
    });
    expect(e).toMatch(/4.2 km/);
    expect(e).toMatch(/12 unit/);
  });

  it('buildExplanation localizes to Arabic when locale="ar"', () => {
    const e = buildExplanation({
      match_type: 'nearby', match_band: 'good', source: 'market_listings', distance_km: 4.7,
      geo_confidence: 'high', facts: { district: 'الندى', available_units: 161, price_range: { min: 819000, max: 2179000 } },
      data_gaps: [], mismatch_warnings: [],
    }, 'ar');
    expect(e).toContain('يبعد حوالي 4.7 كم');   // distance phrase in Arabic
    expect(e).toContain('الندى');                // grounded district
    expect(e).toContain('161 وحدة متاحة');       // availability in Arabic
    expect(e).toContain('السعر 819,000–2,179,000 ر.س'); // price with western digits
    expect(e).toContain('إعلانات السوق الخارجية'); // Arabic source label
    expect(e).not.toMatch(/[A-Za-z]/);            // no English leaked through
  });
});

describe('coerceParsedRequirements (LLM parse output is sanitised)', () => {
  it('keeps valid fields and drops junk', () => {
    const out = coerceParsedRequirements({
      city: 'الرياض', districts: ['النرجس', ''], budget_max: 1500000, bedrooms: '3', nonsense: true,
    });
    expect(out.city).toBe('الرياض');
    expect(out.districts).toEqual(['النرجس']);
    expect(out.district).toBe('النرجس');
    expect(out.budget_max).toBe(1500000);
    expect(out.bedrooms).toBeUndefined(); // string "3" is not a number → dropped
    expect((out as Record<string, unknown>).nonsense).toBeUndefined();
  });
});

// ── helper: build a minimal MatchCoreSuccess ─────────────────────────────────
function makeCore(parts: { our?: MatchResultItem[]; all?: MatchResultItem[]; market?: MatchResultItem[] }): MatchCoreSuccess {
  return {
    ok: true,
    requirements: {} as MatchRequirements,
    district_exact_match: false,
    used_fallback: false,
    notes: [],
    reqDistrictId: 'district-a',
    reqHasCentroid: true,
    our: parts.our ?? [],
    all: parts.all ?? [],
    market: parts.market ?? [],
    marketInfo: { status: 'ok' },
  };
}
