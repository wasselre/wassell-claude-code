import { describe, it, expect } from 'vitest';
import { groupMatchResults, __test } from '../../../api/_lib/suggestGroups';
import type { MatchResultItem, MatchCoreSuccess, MatchRequirements } from '../../../api/_lib/matchAgent';

const { computeBudgetFit } = __test;

/** Build a MatchResultItem with sane defaults; override what each test cares about. */
function item(o: Partial<MatchResultItem> & { project_id: string }): MatchResultItem {
  return {
    project_id: o.project_id,
    project_name: o.project_name ?? o.project_id,
    data_source: o.data_source ?? 'our_projects',
    requires_verification: o.requires_verification,
    verification_warning: o.verification_warning,
    score: o.score ?? 80,
    match_band: o.match_band ?? 'strong',
    match_type: o.match_type ?? 'exact',
    district_match_basis: o.district_match_basis ?? 'lookup',
    score_breakdown: o.score_breakdown ?? { location: 1, budget: 1 },
    facts: o.facts ?? {},
    data_gaps: o.data_gaps ?? [],
    missing_info: o.missing_info ?? [],
    location_tier: o.location_tier ?? 'exact',
    distance_km: o.distance_km ?? null,
    geo_confidence: o.geo_confidence ?? null,
  };
}

function core(our: MatchResultItem[], all: MatchResultItem[] = [], extra?: Partial<MatchCoreSuccess>): MatchCoreSuccess {
  return {
    ok: true,
    requirements: {},
    district_exact_match: our.some((i) => i.match_type === 'exact'),
    used_fallback: all.length > 0,
    notes: [],
    reqDistrictId: 'district-1',
    reqHasCentroid: true,
    our,
    all,
    ...extra,
  };
}

const ACTIVE = 'available_on_map';
const REQ_WITH_BUDGET: MatchRequirements = { district: 'النرجس', budget_max: 1_000_000 };

describe('groupMatchResults — bucketing', () => {
  it('exact district (lookup) within budget → exact_matches, high confidence', () => {
    const it1 = item({
      project_id: 'p1', match_type: 'exact', district_match_basis: 'lookup',
      facts: { project_status: ACTIVE, price_range: { min: 500_000, max: 900_000 }, available_units: 10 },
    });
    const g = groupMatchResults(core([it1]), REQ_WITH_BUDGET);
    expect(g.groups.exact_matches.map((x) => x.project_id)).toContain('p1');
    expect(g.groups.exact_matches[0]!.data_confidence).toBe('high');
    expect(g.groups.exact_matches[0]!.budget_fit).toBe('within');
  });

  it('exact district but price MISSING → location_matches with a missing_price_range gap (never fabricates budget fit)', () => {
    const it1 = item({
      project_id: 'p2', match_type: 'exact', district_match_basis: 'lookup',
      facts: { project_status: ACTIVE }, // no price, no units
      data_gaps: ['no price data', 'no availability data'],
    });
    const g = groupMatchResults(core([it1]), REQ_WITH_BUDGET);
    expect(g.groups.location_matches.map((x) => x.project_id)).toContain('p2');
    expect(g.groups.budget_matches).toHaveLength(0);
    const card = g.groups.location_matches[0]!;
    expect(card.data_gaps).toContain('missing_price_range');
    expect(card.data_confidence).toBe('medium');
  });

  it('nearby district → nearby_alternatives', () => {
    const it1 = item({
      project_id: 'p3', match_type: 'nearby', district_match_basis: null, location_tier: 'nearby', distance_km: 5,
      facts: { project_status: ACTIVE },
    });
    const g = groupMatchResults(core([it1]), { district: 'النرجس' });
    expect(g.groups.nearby_alternatives.map((x) => x.project_id)).toContain('p3');
    expect(g.groups.nearby_alternatives[0]!.distance_basis).toBe('district_centroid');
  });

  it('budget_matches ONLY for reliable price within budget AND non-exact geography', () => {
    const it1 = item({
      project_id: 'p4', match_type: 'nearby', district_match_basis: null, location_tier: 'nearby', distance_km: 4,
      facts: { project_status: ACTIVE, price_range: { min: 400_000, max: 600_000 }, available_units: 5 },
    });
    const g = groupMatchResults(core([it1]), { district: 'النرجس', budget_max: 700_000 });
    expect(g.groups.budget_matches.map((x) => x.project_id)).toContain('p4');
  });

  it('over budget anywhere → location_matches (with a budget warning reason)', () => {
    const it1 = item({
      project_id: 'p5', match_type: 'nearby', district_match_basis: null, location_tier: 'nearby', distance_km: 4,
      facts: { project_status: ACTIVE, price_range: { min: 2_000_000, max: 3_000_000 }, available_units: 5 },
    });
    const g = groupMatchResults(core([it1]), { district: 'النرجس', budget_max: 700_000 });
    expect(g.groups.location_matches.map((x) => x.project_id)).toContain('p5');
    expect(g.groups.location_matches[0]!.budget_fit).toBe('above');
    expect(g.groups.location_matches[0]!.reason_code).toBe('strong_location_over_budget');
  });

  it('legacy TEXT district match → legacy_text_match_only gap + low confidence (still placed by geography)', () => {
    const it1 = item({
      project_id: 'p6', match_type: 'exact', district_match_basis: 'text',
      facts: { project_status: ACTIVE, price_range: { min: 500_000, max: 600_000 }, available_units: 3 },
    });
    const g = groupMatchResults(core([it1]), REQ_WITH_BUDGET);
    expect(g.groups.exact_matches.map((x) => x.project_id)).toContain('p6');
    expect(g.groups.exact_matches[0]!.data_gaps).toContain('legacy_text_match_only');
    expect(g.groups.exact_matches[0]!.data_confidence).toBe('low');
  });

  it('all_projects fallback → fallback_matches + requires_verification gap', () => {
    const it1 = item({
      project_id: 'p7', data_source: 'all_projects', requires_verification: true,
      verification_warning: 'verify me', match_type: 'exact',
      facts: { project_status: ACTIVE, price_range: { min: 500_000, max: 600_000 } },
    });
    const g = groupMatchResults(core([], [it1], { used_fallback: true }), REQ_WITH_BUDGET);
    expect(g.groups.fallback_matches.map((x) => x.project_id)).toContain('p7');
    expect(g.groups.fallback_matches[0]!.data_gaps).toContain('requires_verification');
    expect(g.groups.fallback_matches[0]!.data_confidence).toBe('low');
  });

  it('partial band → fallback_matches', () => {
    const it1 = item({ project_id: 'p8', match_band: 'partial', match_type: 'exact', facts: { project_status: ACTIVE } });
    const g = groupMatchResults(core([it1]), REQ_WITH_BUDGET);
    expect(g.groups.fallback_matches.map((x) => x.project_id)).toContain('p8');
  });

  it('sold_out status → fallback even when geography+price are exact', () => {
    const it1 = item({
      project_id: 'p9', match_type: 'exact', district_match_basis: 'lookup',
      facts: { project_status: 'sold_out', price_range: { min: 500_000, max: 600_000 }, available_units: 0 },
    });
    const g = groupMatchResults(core([it1]), REQ_WITH_BUDGET);
    expect(g.groups.fallback_matches.map((x) => x.project_id)).toContain('p9');
    expect(g.groups.exact_matches).toHaveLength(0);
  });

  it('exact with NO budget requested → still exact_matches', () => {
    const it1 = item({ project_id: 'p10', match_type: 'exact', district_match_basis: 'lookup', facts: { project_status: ACTIVE } });
    const g = groupMatchResults(core([it1]), { district: 'النرجس' });
    expect(g.groups.exact_matches.map((x) => x.project_id)).toContain('p10');
  });

  it('marks used_legacy_fallback when any item matched via text', () => {
    const it1 = item({ project_id: 'p11', match_type: 'exact', district_match_basis: 'text', facts: { project_status: ACTIVE } });
    const g = groupMatchResults(core([it1]), REQ_WITH_BUDGET);
    expect(g.metadata.used_legacy_fallback).toBe(true);
  });

  it('marks used_legacy_fallback when the district could not be resolved', () => {
    const it1 = item({ project_id: 'p12', match_type: 'same_city', district_match_basis: null, facts: { project_status: ACTIVE } });
    const g = groupMatchResults(core([it1], [], { reqDistrictId: null }), { district: 'حي غير موجود' });
    expect(g.metadata.used_legacy_fallback).toBe(true);
  });

  it('caps each group at perGroup', () => {
    const many = Array.from({ length: 12 }, (_, i) => item({
      project_id: `m${i}`, match_type: 'exact', district_match_basis: 'lookup', facts: { project_status: ACTIVE },
    }));
    const g = groupMatchResults(core(many), { district: 'النرجس' }, { perGroup: 5 });
    expect(g.groups.exact_matches).toHaveLength(5);
    expect(g.metadata.counts.exact_matches).toBe(12); // count reflects the true total
  });
});

describe('computeBudgetFit', () => {
  const price = { min: 500_000, max: 800_000 };
  it('within when the range overlaps the budget', () => {
    expect(computeBudgetFit({ budget_max: 1_000_000 }, price)).toBe('within');
  });
  it('above when the cheapest unit exceeds the ceiling', () => {
    expect(computeBudgetFit({ budget_max: 400_000 }, price)).toBe('above');
  });
  it('below when priced under the customer floor', () => {
    expect(computeBudgetFit({ budget_min: 1_000_000 }, price)).toBe('below');
  });
  it('unknown when no budget asked or no price', () => {
    expect(computeBudgetFit({}, price)).toBe('unknown');
    expect(computeBudgetFit({ budget_max: 1_000_000 }, null)).toBe('unknown');
  });
});
