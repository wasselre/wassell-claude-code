import { describe, it, expect } from 'vitest';
import { pickSavablePlaces, placementIsSavable } from '../autoSave.js';
import type { GeoPreference, GeometryRecipe, AnchorToken } from '../../geoPreference/ontology.js';

const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
const anchor = (span: string): AnchorToken => ({ anchor_type: 'district', span, normalized_token: span });
const recipe = (over: Partial<GeometryRecipe>): GeometryRecipe => ({
  operation: 'district_polygon', source_anchors: [], resolved_element_ids: [],
  geo_data_version: 'v1', resolver_version: 'r1', compiled_at: '2026-10-04T00:00:00Z', ...over,
});
const expr = (refs: Array<{ eid: string; recipe: GeometryRecipe }>): GeoPreference => ({
  schema_version: 'v1',
  groups: [{ id: 'g1', role: 'primary', strength: 'soft', priority: 1,
    clauses: refs.map((r) => ({ op: 'include' as const, anyOf: [{ geometry_id: `geo:${r.eid}`, recipe: r.recipe }] })) }],
});

describe('auto-save places — only what is resolved, savable and not doubted', () => {
  const e = expr([
    { eid: 'e1', recipe: recipe({ resolved_element_ids: [D1], source_anchors: [anchor('النرجس')] }) },
    { eid: 'e2', recipe: recipe({ resolved_element_ids: [D2], source_anchors: [anchor('العليا')] }) },
    { eid: 'e3', recipe: recipe({ resolved_element_ids: [], source_anchors: [anchor('مكان ما')] }) },
  ]);
  it('keeps resolved places, drops an unresolved one', () => {
    const r = pickSavablePlaces(e, null);
    expect(r.keep.sort()).toEqual(['e1', 'e2']);
    expect(r.drop).toEqual([{ evidenceId: 'e3', label: 'مكان ما', why: 'unsavable' }]);
  });
  it('drops a place the checker doubted (only when the checker ran)', () => {
    const v = { status: 'ok', mentions: [{ evidence_id: 'e2', verdict: 'not_a_preference', reason: 'سكنه الحالي' }, { evidence_id: 'e1', verdict: 'right' }] };
    const r = pickSavablePlaces(e, v);
    expect(r.keep).toEqual(['e1']);
    expect(r.drop.find((d) => d.evidenceId === 'e2')).toEqual({ evidenceId: 'e2', label: 'العليا', why: 'doubted', reason: 'سكنه الحالي' });
    const errored = pickSavablePlaces(e, { status: 'error', mentions: v.mentions });
    expect(errored.keep.sort()).toEqual(['e1', 'e2']);
  });
  it('a side clip with nothing on that side, and a band with no side, are not savable', () => {
    expect(placementIsSavable({ polarity: 'include', operation: 'district_side_clip', element_ids: [D1], resolved: true, label: '', clip_state: 'empty' })).toBe(false);
    expect(placementIsSavable({ polarity: 'include', operation: 'district_side_clip', element_ids: [D1], resolved: true, label: '', clip_state: 'ok' })).toBe(true);
    expect(placementIsSavable({ polarity: 'include', operation: 'directional_band', element_ids: ['R'], resolved: true, label: '', side: null })).toBe(false);
  });
});

describe('groupAddedByMention — one trail line per thing the customer said', () => {
  it('groups added items by the mention that produced them', async () => {
    const { groupAddedByMention } = await import('../autoSave.js');
    const { geoPreferenceToLocationItems } = await import('../../../geo-preference/review.js');
    const e = expr([
      { eid: 'e1', recipe: recipe({ operation: 'district_union', resolved_element_ids: [D1, D2], source_anchors: [anchor('شمال الرياض')] }) },
      { eid: 'e2', recipe: recipe({ resolved_element_ids: ['33333333-3333-4333-8333-333333333333'], source_anchors: [anchor('العليا')] }) },
    ]);
    const all = geoPreferenceToLocationItems(e);
    const g = groupAddedByMention(e, ['e1', 'e2'], all);
    expect(g.map((x) => [x.label, x.items.length])).toEqual([['شمال الرياض', 2], ['العليا', 1]]);
    // only what was actually ADDED is listed (D1 was already saved)
    const g2 = groupAddedByMention(e, ['e1', 'e2'], all.filter((i) => (i as { district_id?: string }).district_id !== D1));
    expect(g2.map((x) => [x.label, x.items.length])).toEqual([['شمال الرياض', 1], ['العليا', 1]]);
  });
});
