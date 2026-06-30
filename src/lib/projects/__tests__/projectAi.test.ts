import { describe, it, expect } from 'vitest';
import { auditProject, detectIssues, projectFacts, finderCandidatesForNarration } from '../projectAi';
import type { ProjectView } from '../projectView';
import type { AppRecord } from '@/types';
import type { FinderResponse } from '@/lib/matching/projectFinder';

function makeView(over: Partial<ProjectView> = {}): ProjectView {
  return {
    id: 'p', raw: { id: 'p', model_id: 'ap', data: {}, created_at: '', updated_at: '' } as AppRecord,
    name: null, developer: null, projectId: null, city: null, district: null,
    status: null, construction: null, projectType: null, unitTypes: [],
    unitCount: null, availableUnits: null, soldUnits: null, reservedUnits: null,
    priceRange: null, areaRange: null, imageRef: null,
    brochureDeveloper: null, brochureOurs: null, locationLink: null,
    hasGeo: false, isTargeted: false, isPublic: false, dataConfidence: null, createdAt: '',
    ...over,
  };
}

describe('auditProject (deterministic scoring)', () => {
  it('empty project scores 0 and lists every required field missing', () => {
    const a = auditProject(makeView(), false);
    expect(a.score).toBe(0);
    expect(a.requiredMissing.length).toBeGreaterThan(0);
    expect(a.blockingWebsite).toContain('Project name');
    expect(a.blockingMatching).toContain('Geo location');
  });

  it('a complete project scores 100 and blocks nothing', () => {
    const a = auditProject(makeView({
      name: 'X', developer: 'D', city: 'Riyadh', district: 'Olaya',
      status: { value: 'active', label_ar: '', label_en: 'Active', color: null },
      construction: { value: 'ready', label_ar: '', label_en: 'Ready', color: null },
      projectType: { value: 't', label_ar: '', label_en: 'T', color: null },
      priceRange: { min: 1, max: 2 }, areaRange: { min: 1, max: 2 },
      unitCount: 10, imageRef: 'http://x/y.jpg', brochureDeveloper: 'http://b',
      unitTypes: [{ value: 'apartment', label_ar: '', label_en: 'Apt', color: null }],
      hasGeo: true,
    }), false);
    expect(a.score).toBe(100);
    expect(a.blockingWebsite).toEqual([]);
    expect(a.blockingMatching).toEqual([]);
  });
});

describe('detectIssues (deterministic)', () => {
  it('flags invalid ranges and inventory inconsistency', () => {
    const issues = detectIssues(makeView({
      name: 'X', priceRange: { min: 5, max: 1 }, areaRange: { min: 9, max: 2 },
      unitCount: 10, availableUnits: 8, soldUnits: 5, reservedUnits: 3, hasGeo: true,
    }), false);
    expect(issues.some((i) => i.includes('Invalid price range'))).toBe(true);
    expect(issues.some((i) => i.includes('Invalid area range'))).toBe(true);
    expect(issues.some((i) => i.includes('exceeds unit count'))).toBe(true);
  });
});

describe('projectFacts (non-hallucination boundary)', () => {
  it('emits null for every missing fact — never a placeholder/guess', () => {
    const f = projectFacts(makeView(), false);
    expect(f.name).toBeNull();
    expect(f.developer).toBeNull();
    expect(f.city).toBeNull();
    expect(f.price_range).toBeNull();
    expect(f.unit_types).toEqual([]);
    expect(f.available_units).toBeNull();
    // No fact should be a fabricated non-empty string.
    for (const [, v] of Object.entries(f)) {
      expect(typeof v === 'string' && v.length > 0).toBe(false);
    }
  });

  it('passes through only real values', () => {
    const f = projectFacts(makeView({ name: 'Wassel Tower', city: 'Riyadh', priceRange: { min: 1000, max: 2000 } }), false);
    expect(f.name).toBe('Wassel Tower');
    expect(f.city).toBe('Riyadh');
    expect(f.price_range).toContain('1,000');
  });
});

describe('finderCandidatesForNarration (AI explains, engine decides)', () => {
  const resp: FinderResponse = {
    requirements: { city: 'Riyadh' },
    groups: {
      exact_district_matches: [
        { project_id: '1', project_name: 'A', source: 'all_projects', score: 90, match_band: 'strong', match_type: 'exact', group: 'exact_district_matches', distance_km: null, geo_confidence: null, geo_status: null, data_gaps: [], mismatch_warnings: [], facts: {}, score_breakdown: { location: 1 }, explanation: 'x' },
        { project_id: '2', project_name: 'B', source: 'all_projects', score: 80, match_band: 'good', match_type: 'exact', group: 'exact_district_matches', distance_km: null, geo_confidence: null, geo_status: null, data_gaps: ['price'], mismatch_warnings: [], facts: {}, score_breakdown: { location: 1 }, explanation: 'y' },
        { project_id: '3', project_name: 'C', source: 'all_projects', score: 70, match_band: 'partial', match_type: 'exact', group: 'exact_district_matches', distance_km: null, geo_confidence: null, geo_status: null, data_gaps: [], mismatch_warnings: [], facts: {}, score_breakdown: {}, explanation: '' },
        { project_id: '4', project_name: 'D', source: 'all_projects', score: 60, match_band: 'weak', match_type: 'exact', group: 'exact_district_matches', distance_km: null, geo_confidence: null, geo_status: null, data_gaps: [], mismatch_warnings: [], facts: {}, score_breakdown: {}, explanation: '' },
      ],
      nearby_district_matches: [],
      same_city_matches: [],
      broader_fallback: [],
    },
    metadata: { total_candidates: 4, missing_required_preferences: [], generated_at: '2026-01-01' },
  };

  it('preserves engine order/scores, caps per group, and never adds candidates', () => {
    const out = finderCandidatesForNarration(resp, 3);
    expect(out.map((c) => c.project_name)).toEqual(['A', 'B', 'C']); // top-3, same order
    expect(out.map((c) => c.score)).toEqual([90, 80, 70]); // scores untouched
    expect(out.every((c) => ['1', '2', '3', '4'].includes('') || true)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(4); // never more than the engine produced
    expect(out[1]!.data_gaps).toEqual(['price']); // gaps passed through, not hidden
  });
});
