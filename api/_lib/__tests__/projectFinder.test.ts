import { describe, it, expect } from 'vitest';
import {
  __test, passesRequiredAmenities, marketBudgetBounds, firstFailedHardConstraint, typeTextMatches,
  type MatchResultItem, type MatchCoreSuccess, type MatchRequirements,
} from '../matchAgent';
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
  it('MORE bedrooms than requested is a full match (at-least semantics)', () => {
    const seven = { ...baseProject, bedroom_range: { min: 7, max: 7 } };
    expect(scoreProject(seven, { bedrooms: 6 }, {}).breakdown.bedrooms).toBe(1);
    const five = { ...baseProject, bedroom_range: { min: 5, max: 5 } };
    expect(scoreProject(five, { bedrooms: 6 }, {}).breakdown.bedrooms).toBe(0.6); // one under → near-miss
    const three = { ...baseProject, bedroom_range: { min: 3, max: 3 } };
    expect(scoreProject(three, { bedrooms: 6 }, {}).breakdown.bedrooms).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 9b — Soft budget floor: slightly under-budget surfaces with near-full
// credit; far under stays "wrong segment".
// ─────────────────────────────────────────────────────────────────────────────
describe('9b. soft budget floor (10% tolerance below budget_min)', () => {
  it('within 10% below the floor → 0.9 credit', () => {
    // price max 1.2M vs floor 1.3M → 1.2M >= 1.3M×0.9 (1.17M) → near-full credit.
    const r = scoreProject(baseProject, { budget_min: 1_300_000, budget_max: 2_000_000 }, {});
    expect(r.breakdown.budget).toBe(0.9);
  });
  it('far below the floor → wrong segment, mild credit (0.2)', () => {
    const r = scoreProject(baseProject, { budget_min: 5_000_000, budget_max: 6_000_000 }, {});
    expect(r.breakdown.budget).toBe(0.2);
  });
  it('inside the window is still a full match', () => {
    const r = scoreProject(baseProject, { budget_min: 600_000, budget_max: 2_000_000 }, {});
    expect(r.breakdown.budget).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 9b-ii — The market PRE-FILTER window must be wider than the stated budget
// on BOTH sides, or the scorer's tolerances are unreachable for market listings.
// Regression: a 1.85M listing was invisible to a 1.8M search because the DB cut
// at the exact ceiling, so the 15% stretch branch could never fire (2026-07-19).
// ─────────────────────────────────────────────────────────────────────────────
describe('9b-ii. market pre-filter budget window (±15% default band)', () => {
  it('widens BOTH bounds so the scorer decides, not the SQL filter', () => {
    const b = marketBudgetBounds({ budget_min: 2_000_000, budget_max: 1_800_000 });
    expect(b.p_budget_min).toBe(1_700_000); // 2.0M × 0.85
    expect(b.p_budget_max).toBe(2_070_000); // 1.8M × 1.15
  });
  it('the band follows the budget CONSTRAINT tolerance', () => {
    const tight = marketBudgetBounds({ budget_max: 1_000_000, constraints: { budget: { mode: 'hard', tolerance_pct: 0 } } });
    expect(tight.p_budget_max).toBe(1_000_000);
    const loose = marketBudgetBounds({ budget_max: 1_000_000, constraints: { budget: { mode: 'hard', tolerance_pct: 0.25 } } });
    expect(loose.p_budget_max).toBe(1_250_000);
  });
  it('the live-miss listing (1.85M vs a 1.8M budget) survives the pre-filter', () => {
    const { p_budget_max } = marketBudgetBounds({ budget_max: 1_800_000 });
    expect(1_850_000).toBeLessThanOrEqual(p_budget_max!);
  });
  it('allow_stretch:false → exact ceiling, no widening', () => {
    const b = marketBudgetBounds({ budget_max: 1_800_000, allow_stretch: false });
    expect(b.p_budget_max).toBe(1_800_000);
    expect(1_850_000).toBeGreaterThan(b.p_budget_max!);
  });
  it('absent bounds stay null (no filter)', () => {
    expect(marketBudgetBounds({})).toEqual({ p_budget_min: null, p_budget_max: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 9d — PER-FIELD hard constraints. The regression that motivated them: a
// 125 m² villa scored 89% against a 500–750 m² request because area was a soft
// 10-of-90 dimension and had NO pre-filter at all (live 2026-07-19).
// ─────────────────────────────────────────────────────────────────────────────
describe('9d. per-field hard constraints', () => {
  const small = { ...baseProject, area_range: { min: 125, max: 125 } };
  const req = { area_min: 500, area_max: 750 } as MatchRequirements;

  it('area HARD (default) excludes the 125 m² candidate outright', () => {
    expect(firstFailedHardConstraint(small, req)).toBe('area');
  });
  it('area SOFT keeps the old score-only behavior (nothing excluded)', () => {
    expect(firstFailedHardConstraint(small, { ...req, constraints: { area: { mode: 'soft' } } })).toBeNull();
    // …and it still scores badly, which is the point of soft mode.
    expect(scoreProject(small, req, {}).breakdown.area).toBe(0);
  });
  it('the tolerance band widens INCLUSION on both sides', () => {
    const justUnder = { ...baseProject, area_range: { min: 450, max: 450 } }; // 10% under 500
    expect(firstFailedHardConstraint(justUnder, { ...req, constraints: { area: { mode: 'hard', tolerance_pct: 0 } } })).toBe('area');
    expect(firstFailedHardConstraint(justUnder, { ...req, constraints: { area: { mode: 'hard', tolerance_pct: 0.15 } } })).toBeNull();
  });
  it('an overlapping span passes (a project with SOME units in range)', () => {
    const spans = { ...baseProject, area_range: { min: 300, max: 800 } };
    expect(firstFailedHardConstraint(spans, req)).toBeNull();
  });
  it('fails CLOSED when the candidate has no data for a hard field', () => {
    const noArea = { ...baseProject, area_range: undefined };
    expect(firstFailedHardConstraint(noArea, req)).toBe('area');
    expect(firstFailedHardConstraint(noArea, { ...req, constraints: { area: { mode: 'soft' } } })).toBeNull();
  });
  it('bedrooms/bathrooms are AT-LEAST — more than asked still passes', () => {
    const seven = { ...baseProject, bedroom_range: { min: 7, max: 7 } };
    expect(firstFailedHardConstraint(seven, { bedrooms: 6 })).toBeNull();
    const four = { ...baseProject, bedroom_range: { min: 4, max: 4 } };
    expect(firstFailedHardConstraint(four, { bedrooms: 6 })).toBe('bedrooms');
  });
  it('budget honors allow_stretch:false by collapsing the upper band', () => {
    const over = { ...baseProject, price_range: { min: 1_850_000, max: 1_850_000 } };
    expect(firstFailedHardConstraint(over, { budget_max: 1_800_000 })).toBeNull(); // within +15%
    expect(firstFailedHardConstraint(over, { budget_max: 1_800_000, allow_stretch: false })).toBe('budget');
  });
  it('reports the FIRST failing field (drives the per-field drop counts)', () => {
    const wrong = { ...baseProject, area_range: { min: 100, max: 100 }, price_range: { min: 9_000_000, max: 9_000_000 } };
    expect(firstFailedHardConstraint(wrong, { area_min: 500, budget_max: 1_000_000 })).toBe('budget');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 9e — Property type is matched on the PRIMARY type, not any substring.
// Regression: "شقة في فيلا" matched a villa request via includes() and an
// apartment outranked real villas (live 2026-07-19).
// ─────────────────────────────────────────────────────────────────────────────
describe('9e. primary-type matching', () => {
  const villaNeedles = ['villa', 'villas', 'فيلا', 'فلل'];
  it('"شقة في فيلا" does NOT satisfy a villa request', () => {
    expect(typeTextMatches('شقة في فيلا', villaNeedles)).toBe(false);
  });
  it('a real villa still matches', () => {
    expect(typeTextMatches('فيلا، sale، فلل-للبيع', villaNeedles)).toBe(true);
  });
  it('the earliest keyword wins for concatenated Aqar type text', () => {
    expect(typeTextMatches('تاون هاوس sale فلل-للبيع', villaNeedles)).toBe(false);
    expect(typeTextMatches('تاون هاوس sale فلل-للبيع', ['تاون هاوس', 'townhouse'])).toBe(true);
  });
  it('unknown type text falls back to the loose test (no data loss)', () => {
    expect(typeTextMatches('something-else', ['something'])).toBe(true);
  });
  it('the apartment is now EXCLUDED from a villa-only search', () => {
    const apt = { ...baseProject, unit_types: ['شقة في فيلا', 'sale', 'شقق-للبيع'] };
    expect(firstFailedHardConstraint(apt, { property_type: 'فيلا' })).toBe('property_type');
    expect(scoreProject(apt, { property_type: 'فيلا' }, {}).breakdown.type).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST 9c — required_amenities is a HARD gate that fails closed.
// ─────────────────────────────────────────────────────────────────────────────
describe('9c. required amenities hard gate', () => {
  const withAmenities = { ...baseProject, preferred_amenities: ['غرفة سائق', 'ملحق سفلي', 'مصعد'] };
  it('passes when every required amenity fuzzy-matches the evidence', () => {
    expect(passesRequiredAmenities(withAmenities, { required_amenities: ['غرفة سائق', 'ملحق'] })).toBe(true);
  });
  it('fails when ANY required amenity is missing', () => {
    expect(passesRequiredAmenities(withAmenities, { required_amenities: ['غرفة سائق', 'مسبح'] })).toBe(false);
  });
  it('fails CLOSED when the candidate has no amenity data', () => {
    expect(passesRequiredAmenities(baseProject, { required_amenities: ['ملحق'] })).toBe(false);
  });
  it('no required amenities → always passes', () => {
    expect(passesRequiredAmenities(baseProject, {})).toBe(true);
    expect(passesRequiredAmenities(baseProject, { required_amenities: [] })).toBe(true);
  });
  it('required amenities also earn the amenities subscore', () => {
    const r = scoreProject(withAmenities, { required_amenities: ['غرفة سائق', 'ملحق'] }, {});
    expect(r.breakdown.amenities).toBe(1);
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

// ─────────────────────────────────────────────────────────────────────────────
// Grouping is LOCATION-CENTRIC (2026-07-02 fix): a project inside a selected
// district must NEVER be grouped/labelled "outside the requested area", even
// when its overall fit is weak (wrong type / missing price → band 'partial').
// ─────────────────────────────────────────────────────────────────────────────
describe('location-centric grouping (in-district weak fits stay in-district)', () => {
  it('an in-district project with a partial band stays in exact_district_matches', () => {
    // Wrong unit type caps the band to partial — but the location is exact
    // (in the SECOND of two selected districts: multi-district OR).
    const villa = { ...baseProject, unit_types: ['villa'] };
    const s = scoreProject(villa, { district: 'الفاروق', districts: ['الفاروق', 'النرجس'], property_type: 'شقة' }, {
      reqDistrictId: DIST_A, reqDistrictIds: [DIST_A, DIST_B], reqCityId: CITY, reqCityIds: [CITY],
      projDistrictId: DIST_B, projCityId: CITY,
    });
    expect(s.location_tier).toBe('exact');
    expect(s.district_exact).toBe(true);
    expect(s.band).toBe('partial');

    const item: MatchResultItem = {
      project_id: 'x', project_name: 'x', data_source: 'our_projects', score: s.score,
      match_band: s.band, match_type: s.match_type, district_match_basis: s.district_match_basis,
      score_breakdown: s.breakdown, facts: s.facts, data_gaps: s.data_gaps, missing_info: s.missing_info,
      location_tier: s.location_tier, distance_km: s.distance_km, geo_confidence: s.geo_confidence,
    };
    const g = finderGroupFor(item, true);
    expect(g.group).toBe('exact_district_matches'); // NOT broader_fallback
    expect(g.match_type).toBe('exact');             // card never claims "outside"
  });

  it('district_ids alone (no district name) still counts as a requested district', () => {
    const s = scoreProject(baseProject, { district_ids: ['some-district-id'] }, {
      reqDistrictIds: [DIST_A], projDistrictId: DIST_A, projCityId: CITY,
    });
    expect(s.location_tier).toBe('exact');
    expect(s.district_exact).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Distance is reported for EVERY tier, measured to the NEAREST selected
// reference (district centroid or location element), with its name.
// ─────────────────────────────────────────────────────────────────────────────
describe('distance from the nearest selected reference', () => {
  it('same-city results still carry distance_km + the nearest reference name', () => {
    const s = scoreProject(baseProject, { district: 'الفاروق' }, {
      projLat: FAR_PIN.lat, projLng: FAR_PIN.lng,
      reqDistrictId: DIST_A, reqCityId: CITY,
      reqCentroids: [{ lat: A_CENTROID.lat, lng: A_CENTROID.lng, name: 'الفاروق' }],
      projDistrictId: DIST_B, projCityId: CITY,
    });
    expect(s.location_tier).toBe('same_city'); // ~90 km — beyond the nearby tier
    expect(s.distance_km).not.toBeNull();      // …but the distance is still shown
    expect(s.nearest_ref_name).toBe('الفاروق');
  });

  it('picks the CLOSEST of several selected references and names it', () => {
    const s = scoreProject(baseProject, { district: 'أ', districts: ['أ', 'ب'] }, {
      projLat: NEAR_PIN.lat, projLng: NEAR_PIN.lng,
      reqDistrictIds: [DIST_A, DIST_B],
      reqCentroids: [
        { lat: FAR_PIN.lat, lng: FAR_PIN.lng, name: 'بعيد' },
        { lat: A_CENTROID.lat, lng: A_CENTROID.lng, name: 'قريب' },
      ],
      projDistrictId: 'district-c', projCityId: CITY,
    });
    expect(s.location_tier).toBe('nearby');
    expect(s.nearest_ref_name).toBe('قريب');
  });

  it('fallback explanation names the closest selected area when distance is known', () => {
    const e = buildExplanation({
      match_type: 'fallback', match_band: 'partial', source: 'all_projects', distance_km: 18.4,
      nearest_ref_name: 'النرجس', geo_confidence: null, facts: {}, data_gaps: [], mismatch_warnings: [],
    }, 'ar');
    expect(e).toContain('18.4');
    expect(e).toContain('النرجس');
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

// ─────────────────────────────────────────────────────────────────────────────
// A requested dimension the project has NO data for must NOT be renormalized away —
// it earns 0 at full weight, so a no-price listing can never score 100 when the
// client gave a budget.
// ─────────────────────────────────────────────────────────────────────────────
describe('requested-but-missing data penalizes the score (no free 100%)', () => {
  const noPriceProject = {
    project_name: 'No Price Listing',
    unit_types: ['apartments'],
    project_status: 'available',
    area_range: { min: 90, max: 300 },
    available_units: 5,
    // NB: no price_range at all
  };
  const geo = {
    projLat: A_CENTROID.lat, projLng: A_CENTROID.lng,
    reqLat: A_CENTROID.lat, reqLng: A_CENTROID.lng,
    reqDistrictId: DIST_A, reqCityId: CITY,
    projDistrictId: DIST_A, projCityId: CITY, geoConfidence: 'high' as const,
  };

  it('no price + client has a budget → budget subscore 0, score well below 100', () => {
    const r = scoreProject(noPriceProject, { city: 'الرياض', district: 'الفاروق', budget_max: 1_000_000, property_type: 'شقة', area_min: 90, area_max: 300 }, geo);
    expect(r.breakdown.budget).toBe(0);          // unconfirmable → 0, not null
    expect(r.data_gaps).toContain('no price data');
    expect(r.score).toBeLessThan(100);
    expect(r.score).toBeLessThan(75); // below the STRONG threshold — not a perfect match
  });

  it('SAME project with a price IN budget scores higher (data-complete wins)', () => {
    const withPrice = { ...noPriceProject, price_range: { min: 700_000, max: 950_000 } };
    const a = scoreProject(noPriceProject, { city: 'الرياض', district: 'الفاروق', budget_max: 1_000_000, property_type: 'شقة' }, geo);
    const b = scoreProject(withPrice, { city: 'الرياض', district: 'الفاروق', budget_max: 1_000_000, property_type: 'شقة' }, geo);
    expect(b.score).toBeGreaterThan(a.score);
    expect(b.breakdown.budget).toBe(1);
  });

  it('a dimension the client did NOT ask about is still dropped (no penalty)', () => {
    // No budget requested → a missing price must not penalize.
    const r = scoreProject(noPriceProject, { city: 'الرياض', district: 'الفاروق', property_type: 'شقة' }, geo);
    expect(r.breakdown.budget).toBeNull();
    expect(r.score).toBe(100); // location + type + availability all perfect, budget excluded
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

// ── OUR PORTFOLIO preferential (loose) treatment in the grouping layer ───────
describe('our_projects get preferential grouping (loose matching)', () => {
  const mkItem = (over: Partial<MatchResultItem> & { project_id: string; data_source: MatchResultItem['data_source']; score: number }): MatchResultItem => ({
    project_name: over.project_id, match_band: 'partial', match_type: 'same_city', district_match_basis: null,
    score_breakdown: {}, facts: {}, data_gaps: [], missing_info: [],
    location_tier: 'same_city', distance_km: null, geo_confidence: null, ...over,
  });

  it('exempts our_projects from the caller minScore floor; still applies it to others', () => {
    const core = makeCore({
      our: [mkItem({ project_id: 'ours-weak', data_source: 'our_projects', score: 55 })],
      all: [mkItem({ project_id: 'all-weak', data_source: 'all_projects', score: 55 })],
      market: [mkItem({ project_id: 'mkt-weak', data_source: 'market_listings', score: 55 })],
    });
    const res = groupForFinder(core, {}, { minScore: 70, sources: ['our_projects', 'all_projects', 'market_listings'] });
    const ids = FINDER_GROUP_KEYS_LOCAL.flatMap((k) => res.groups[k].map((m) => m.project_id));
    expect(ids).toContain('ours-weak');       // our project survives the 70 floor
    expect(ids).not.toContain('all-weak');     // all_projects dropped
    expect(ids).not.toContain('mkt-weak');     // market dropped
  });

  it('passes our_fit through to the FinderMatch', () => {
    const core = makeCore({
      our: [mkItem({
        project_id: 'ours', data_source: 'our_projects', score: 82,
        our_fit: { location: 'nearby', distance_km: 2.1, budget: 'within', area: 'match' },
      })],
    });
    const res = groupForFinder(core, {}, { sources: ['our_projects'] });
    const m = FINDER_GROUP_KEYS_LOCAL.flatMap((k) => res.groups[k]).find((x) => x.project_id === 'ours');
    expect(m?.our_fit).toEqual({ location: 'nearby', distance_km: 2.1, budget: 'within', area: 'match' });
  });
});

// ── unit age (عمر العقار) ───────────────────────────────────────────────────
import { __test as matchTest } from '../matchAgent.js';
import { FINDER_GROUP_KEYS as FINDER_GROUP_KEYS_LOCAL } from '../projectFinder.js';

describe('computeOurFit location — a drawn gate is the ONLY proof of "in area"', () => {
  const fit = matchTest.computeOurFit;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scored = (tier: string, dist: number | null = null): any => ({ location_tier: tier, distance_km: dist });

  it('gate active + OUTSIDE + tier "exact" (city-only match) → same_city, NOT in_area', () => {
    // The live bug: a city-only request marks every same-city project location_tier
    // "exact"; a Jadriyah project outside a north-Riyadh polygon must not read in_area.
    const f = fit({}, { city: 'الرياض' } as MatchRequirements, /*gate*/ true, /*inside*/ false, scored('exact', 8));
    expect(f.location).toBe('same_city');
  });
  it('gate active + INSIDE → in_area', () => {
    expect(fit({}, {} as MatchRequirements, true, true, scored('exact')).location).toBe('in_area');
  });
  it('gate active + OUTSIDE + tier "none" (different city) → other', () => {
    expect(fit({}, {} as MatchRequirements, true, false, scored('none')).location).toBe('other');
  });
  it('no gate + a district WAS requested + tier "exact" → in_area', () => {
    const f = fit({}, { district: 'العليا' } as MatchRequirements, false, false, scored('exact'));
    expect(f.location).toBe('in_area');
  });
  it('no gate + city-only + tier "exact" → same_city (the city is the area)', () => {
    const f = fit({}, { city: 'الرياض' } as MatchRequirements, false, false, scored('exact'));
    expect(f.location).toBe('same_city');
  });
});

describe('unit age parsing (TS twin of wassell_parse_unit_age — keep in sync)', () => {
  const p = matchTest.parseUnitAgeText;
  it('parses the observed Aqar value space', () => {
    expect(p('جديد')).toBe(0);
    expect(p('جديدة')).toBe(0);
    expect(p('سنتين')).toBe(2);
    expect(p('سنتان')).toBe(2);
    expect(p('سنة')).toBe(1);
    expect(p('سنة ونصف')).toBe(1);
    expect(p('9 سنة')).toBe(9);
    expect(p('5 سنوات')).toBe(5);
    expect(p('15')).toBe(15);
    expect(p('أكثر من 10 سنوات')).toBe(11);
    expect(p('أكثر من 30 سنة')).toBe(31);
  });
  it('null/empty/junk → null (requested-but-missing at scoring time)', () => {
    expect(p(null)).toBeNull();
    expect(p('')).toBeNull();
    expect(p('غير معروف')).toBeNull();
  });
});

describe('unit-age scoring dimension', () => {
  const score = (data: Record<string, unknown>, max: number) =>
    matchTest.scoreProject({ available_units: 1, ...data }, { max_unit_age: max });
  it('at/under the max → full credit; ≤2 years over → half; far over → 0', () => {
    expect(score({ unit_age: 0 }, 0).breakdown.unit_age).toBe(1);
    expect(score({ unit_age: 2 }, 0).breakdown.unit_age).toBe(0.5);
    expect(score({ unit_age: 5 }, 0).breakdown.unit_age).toBe(0);
    expect(score({ unit_age: 4 }, 5).breakdown.unit_age).toBe(1);
  });
  it('age unknown → requested-but-missing (0 credit, full weight, gap recorded)', () => {
    const s = score({}, 0);
    expect(s.breakdown.unit_age).toBe(0);
    expect(s.data_gaps).toContain('no unit age data');
  });
  it('not requested → dimension excluded entirely', () => {
    const s = matchTest.scoreProject({ available_units: 1, unit_age: 30 }, {});
    expect(s.breakdown.unit_age).toBeNull();
  });
});

describe('listing adapter carries the parsed age', () => {
  it('adaptListingToScorable parses the age text into unit_age', () => {
    const a = matchTest.adaptListingToScorable({ title: 'x', is_active: true, age: 'أكثر من 10 سنوات' });
    expect(a.unit_age).toBe(11);
    const b = matchTest.adaptListingToScorable({ title: 'x', is_active: true, age: 'جديد' });
    expect(b.unit_age).toBe(0);
    const c = matchTest.adaptListingToScorable({ title: 'x', is_active: true });
    expect(c.unit_age).toBeUndefined();
  });
});
