import { describe, it, expect } from 'vitest';
import { __test } from '../../../api/_lib/matchAgent';

const { adaptListingToScorable, scoreProject } = __test;

/**
 * A market_listings record is a SINGLE unit with scalar price/area/bedrooms +
 * real per-listing coordinates. The adapter must map it into the all_projects
 * shape so the ONE deterministic scorer grades it like any project.
 */
describe('adaptListingToScorable', () => {
  const RAW = {
    title: 'شقة فاخرة في النرجس',
    city: 'الرياض',
    district: 'النرجس',
    district_lookup: 'district-narjis',
    property_type: 'شقة',
    price: 850_000,
    area: 165,
    bedrooms: 3,
    bathrooms: 4,
    is_active: true,
    latitude: 24.83,
    longitude: 46.64,
    features: ['مسبح', 'مصعد'],
  };

  it('maps scalars to {min,max} ranges + availability + types', () => {
    const a = adaptListingToScorable(RAW);
    expect(a.price_range).toEqual({ min: 850_000, max: 850_000 });
    expect(a.area_range).toEqual({ min: 165, max: 165 });
    expect(a.bedroom_range).toEqual({ min: 3, max: 3 });
    expect(a.available_units).toBe(1);
    expect(a.unit_types).toContain('شقة');
    expect(a.district_lookup).toBe('district-narjis');
    expect(a.project_name).toBe('شقة فاخرة في النرجس');
  });

  it('a sold/inactive listing reads as zero availability', () => {
    expect(adaptListingToScorable({ ...RAW, is_active: false }).available_units).toBe(0);
    expect(adaptListingToScorable({ ...RAW, sold_at: '2026-06-01' }).available_units).toBe(0);
  });

  it('scores as an EXACT, in-budget match when its district_lookup equals the request', () => {
    const a = adaptListingToScorable(RAW);
    const s = scoreProject(a, { district: 'النرجس', property_type: 'شقة', budget_max: 1_000_000, bedrooms: 3 }, {
      reqDistrictId: 'district-narjis', reqLat: 24.83, reqLng: 46.64, projLat: 24.83, projLng: 46.64,
    });
    expect(s.district_exact).toBe(true);
    expect(s.district_match_basis).toBe('lookup');
    expect(s.match_type).toBe('exact');
    expect(s.breakdown.budget).toBe(1); // 850k ≤ 1M
    expect(s.breakdown.type).toBe(1);   // شقة
    expect(s.breakdown.bedrooms).toBe(1); // 3 ∈ [3,3]
    expect(s.band).toBe('strong');
  });
});
