import { describe, it, expect } from 'vitest';
// The deterministic Phase 1 matching scorer + metadata enforcement live in the
// API agent (no DB / SDK runtime deps — only `import type`).
import { __test } from '../../../api/_lib/matchAgent';

const { scoreProject, collectAuthoritativeMeta, reconcileRecommendationPayload } = __test;

// A realistic project from the live all_projects shape (Riyadh apartment).
// Geography is relational: district_lookup / city_lookup hold record ids; the
// denormalized district_name / city_name are what facts display.
const DIST_FAROUQ = 'dist-farouq';
const CITY_RIYADH = 'city-riyadh';
const GEO = { reqDistrictId: DIST_FAROUQ, reqCityId: CITY_RIYADH }; // request resolved to الفاروق / الرياض
const PROJECT = {
  project_name: 'الماجدية 163',
  district_lookup: DIST_FAROUQ,
  city_lookup: CITY_RIYADH,
  district_name: 'الفاروق',
  city_name: 'الرياض',
  unit_types: ['apartments'], // note plural — synonym matching must handle it
  project_status: 'unknown',
  price_range: { min: 519000, max: 1149000 },
  area_range: { min: 89, max: 310.52 },
  bedroom_range: { min: 1, max: 3 },
  bathroom_range: { min: 2, max: 3 },
  available_units: 124,
  preferred_amenities: ['غرفة خادمة', 'صالة', 'مطبخ'],
};

describe('scoreProject (Phase 1 text matching)', () => {
  it('scores an exact district + in-budget + type match as a strong, exact match', () => {
    const r = scoreProject(PROJECT, {
      city: 'الرياض',
      district: 'الفاروق',
      property_type: 'شقة', // Arabic singular → must match stored "apartments"
      budget_max: 1_000_000,
      bedrooms: 2,
    }, GEO);
    expect(r.district_exact).toBe(true);
    expect(r.match_type).toBe('exact');
    expect(r.breakdown.type).toBe(1); // synonym شقة ↔ apartments
    expect(r.breakdown.budget).toBe(1); // 519k overlaps ≤ 1M
    expect(r.breakdown.bedrooms).toBe(1); // 2 ∈ [1,3]
    expect(r.band).toBe('strong');
    expect(r.score).toBeGreaterThanOrEqual(75);
  });

  it('falls back to a same-city half-credit when the district does not match', () => {
    const r = scoreProject(PROJECT, { city: 'الرياض', district: 'النرجس' }, { reqDistrictId: 'dist-narjis', reqCityId: CITY_RIYADH });
    expect(r.district_exact).toBe(false);
    expect(r.match_type).toBe('same_city');
    expect(r.breakdown.location).toBe(0.5);
  });

  it('marks an option just over budget as a stretch (≤15%) when allowed', () => {
    const r = scoreProject(PROJECT, { budget_max: 500_000, allow_stretch: true });
    // 519,000 ≤ 500,000 × 1.15 (=575,000) → stretch (0.5)
    expect(r.breakdown.budget).toBe(0.5);
    expect(r.match_type).toBe('stretch');
  });

  it('gives zero budget credit when the cheapest unit is beyond the stretch band', () => {
    const r = scoreProject(PROJECT, { budget_max: 400_000 });
    // 519,000 > 400,000 × 1.15 (=460,000) → no credit
    expect(r.breakdown.budget).toBe(0);
  });

  it('renormalizes: a lone matched city yields full marks (unspecified dims excluded)', () => {
    const r = scoreProject(PROJECT, { city: 'الرياض' }, { reqCityId: CITY_RIYADH });
    // Only location (matched) + availability (>0) apply → both 1 → 100.
    expect(r.match_type).toBe('exact');
    expect(r.score).toBe(100);
  });

  it('flags a data gap (and excludes the dimension) when budget is asked but price is missing', () => {
    const noPrice = { ...PROJECT, price_range: undefined };
    const r = scoreProject(noPrice, { budget_max: 800_000 });
    expect(r.breakdown.budget).toBeNull();
    expect(r.data_gaps).toContain('no price data');
    expect(r.missing_info.length).toBeGreaterThan(0);
  });

  it('caps the band at partial when the requested property type does not match', () => {
    // Townhouse requested, but the project is apartments, in the right district
    // and budget. Location+budget+availability would carry it to 75, but the
    // type-mismatch guard must prevent a "strong"/"good" label.
    const r = scoreProject(PROJECT, {
      city: 'الرياض',
      district: 'الفاروق',
      property_type: 'تاون هاوس',
      budget_max: 1_500_000,
    }, GEO);
    expect(r.breakdown.type).toBe(0); // apartments ≠ townhouse
    expect(r.score).toBe(75); // numeric score preserved for transparency
    expect(r.band).toBe('partial'); // …but never labelled strong/good
    expect(r.missing_info.some((m) => /unit type/i.test(m))).toBe(true);
  });

  it('detects a sold-out project (zero available units)', () => {
    const soldOut = { ...PROJECT, available_units: 0 };
    const r = scoreProject(soldOut, { city: 'الرياض' });
    expect(r.available_units_zero).toBe(true);
    expect(r.breakdown.availability).toBe(0);
  });

  it('builds facts only from present values — never emits a null/empty field', () => {
    const sparse = {
      project_name: 'X',
      city_name: 'الرياض',
      district_name: '',
      unit_types: [],
      available_units: 5,
    };
    const r = scoreProject(sparse, { city: 'الرياض' }, { reqCityId: CITY_RIYADH });
    expect(r.facts).toHaveProperty('city', 'الرياض');
    expect(r.facts).not.toHaveProperty('district'); // empty string omitted
    expect(r.facts).not.toHaveProperty('unit_types'); // empty array omitted
    expect(r.facts).not.toHaveProperty('price_range'); // absent omitted
  });
});

describe('deterministic metadata enforcement (Phase 1.1)', () => {
  // A match_projects result where the project is authoritatively 44 / partial.
  const MATCH_RESULT = JSON.stringify({
    used_fallback: false,
    our_projects: {
      source: 'our_projects',
      results: [
        {
          project_id: 'proj-rifan',
          project_name: 'فلل رِفان',
          data_source: 'our_projects',
          score: 44,
          match_band: 'partial',
          match_type: 'partial',
        },
      ],
    },
    all_projects: null,
  });

  it('forces the card back to the tool score/band even when the LLM upgraded it', () => {
    const auth = collectAuthoritativeMeta(MATCH_RESULT);
    expect(auth.get('proj-rifan')).toMatchObject({ score: 44, match_band: 'partial' });

    // The model tried to present it as a strong 70/good match.
    const llmPayload = {
      summary: '…',
      recommendations: [
        {
          project_id: 'proj-rifan',
          project_name: 'فلل رِفان',
          data_source: 'our_projects',
          score: 70, // re-derived by the LLM — must be overwritten
          match_band: 'good', // re-banded by the LLM — must be overwritten
          match_type: 'exact',
          why: 'villas in Riyadh',
          pitch: '…',
        },
      ],
    };

    const { payload, corrections } = reconcileRecommendationPayload(llmPayload, auth);
    const rec = (payload as typeof llmPayload).recommendations[0];
    expect(rec.score).toBe(44); // preserved from the tool
    expect(rec.match_band).toBe('partial'); // preserved from the tool
    expect(rec.match_type).toBe('partial'); // also corrected
    expect(corrections.some((c) => c.field === 'score' && c.from === 70 && c.to === 44)).toBe(true);
    expect(corrections.some((c) => c.field === 'match_band' && c.from === 'good' && c.to === 'partial')).toBe(true);
  });

  it('forces requires_verification + data_source from the tool (no fake "verified")', () => {
    const matchWithFallback = JSON.stringify({
      used_fallback: true,
      our_projects: { results: [] },
      all_projects: {
        results: [
          { project_id: 'p1', project_name: 'X', data_source: 'all_projects', score: 50, match_band: 'partial', match_type: 'partial', requires_verification: true },
        ],
      },
    });
    const auth = collectAuthoritativeMeta(matchWithFallback);
    // LLM tried to drop the verification flag and call it our_projects.
    const payloadIn = {
      recommendations: [
        { project_id: 'p1', project_name: 'X', data_source: 'our_projects', requires_verification: false, score: 50, match_band: 'partial', why: '', pitch: '' },
      ],
    };
    const { payload } = reconcileRecommendationPayload(payloadIn, auth) as { payload: typeof payloadIn };
    expect(payload.recommendations[0].requires_verification).toBe(true);
    expect(payload.recommendations[0].data_source).toBe('all_projects');
    expect((payload as Record<string, unknown>).requires_verification).toBe(true); // top-level rollup
  });

  it('leaves a recommendation untouched when its project_id has no authoritative entry', () => {
    const auth = collectAuthoritativeMeta(MATCH_RESULT);
    const payloadIn = { recommendations: [{ project_id: 'unknown-id', project_name: 'Y', score: 88, match_band: 'strong', why: '', pitch: '' }] };
    const { payload, corrections } = reconcileRecommendationPayload(payloadIn, auth) as { payload: typeof payloadIn; corrections: unknown[] };
    expect(payload.recommendations[0].score).toBe(88); // no source to enforce → left as-is
    expect(corrections.length).toBe(0);
  });
});
