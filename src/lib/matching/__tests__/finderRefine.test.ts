import { describe, it, expect } from 'vitest';
import { buildFinderTabs } from '../finderRefine';
import type { FinderGroupKey, FinderMatch, OurFit } from '../projectFinder';
import { FINDER_GROUP_KEYS } from '../projectFinder';

/** Minimal our_projects FinderMatch for the ranking tests. */
function ours(
  id: string,
  fit: OurFit['location'],
  distance_km: number | null,
  score = 100,
): FinderMatch {
  return {
    project_id: id,
    project_name: id,
    source: 'our_projects',
    score,
    match_band: 'strong',
    match_type: fit === 'in_area' ? 'exact' : 'same_city',
    group: fit === 'in_area' ? 'exact_district_matches' : 'same_city_matches',
    distance_km,
    geo_confidence: 'high',
    geo_status: 'verified_match',
    data_gaps: [],
    mismatch_warnings: [],
    facts: {},
    score_breakdown: {},
    explanation: '',
    our_fit: { location: fit, distance_km },
  };
}

function groupsOf(items: FinderMatch[]): Record<FinderGroupKey, FinderMatch[]> {
  const g = Object.fromEntries(FINDER_GROUP_KEYS.map((k) => [k, []])) as Record<FinderGroupKey, FinderMatch[]>;
  for (const it of items) g[it.group].push(it);
  return g;
}

describe('buildFinderTabs — our-projects ranking', () => {
  it('puts in-area projects before out-of-area ones regardless of centroid distance', () => {
    // The in-area project happens to sit FARTHER from the area centroid than an
    // out-of-area one — location fit must still win (an in-area match is better).
    const inAreaFar = ours('in-area-far', 'in_area', 9);
    const outsideNear = ours('outside-near', 'same_city', 3);
    const { ourProjects } = buildFinderTabs(groupsOf([outsideNear, inAreaFar]));
    expect(ourProjects.map((m) => m.project_id)).toEqual(['in-area-far', 'outside-near']);
  });

  it('ranks out-of-area projects by closest distance first (nulls last)', () => {
    const far = ours('far', 'same_city', 12);
    const near = ours('near', 'same_city', 4);
    const noDist = ours('no-distance', 'same_city', null);
    const { ourProjects } = buildFinderTabs(groupsOf([far, noDist, near]));
    expect(ourProjects.map((m) => m.project_id)).toEqual(['near', 'far', 'no-distance']);
  });

  it('orders the full ladder: in_area → nearby → same_city → other, distance within tier', () => {
    const items = [
      ours('other', 'other', 20),
      ours('samecity-b', 'same_city', 10),
      ours('nearby', 'nearby', 2),
      ours('samecity-a', 'same_city', 5),
      ours('inarea', 'in_area', 8),
    ];
    const { ourProjects } = buildFinderTabs(groupsOf(items));
    expect(ourProjects.map((m) => m.project_id)).toEqual([
      'inarea', 'nearby', 'samecity-a', 'samecity-b', 'other',
    ]);
  });
});
