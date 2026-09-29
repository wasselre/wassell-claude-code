import { describe, it, expect } from 'vitest';
import { groupCallBlocks } from '../callBlocks';
import type { CallGeoDTO, CallProposalDTO } from '../../components/PrefSuggestionsSection';
import type { GeoCardDTO } from '../geoRows';

const pref = (id: string, call_id: string | null, call_at: string | null, status: CallProposalDTO['status'] = 'pending'): CallProposalDTO => ({
  id, version: 1, status, call_id, call_at, suggestions: {}, current_values: {},
  created_at: '2026-09-01T00:00:00.000Z', decided_at: null, saved_fields: null,
});
const card: GeoCardDTO = {
  status: 'pending', checkpoint_id: 'cp', proposal: null, mentions: [], names: {}, analyzed_at: null,
  stale: false, graded: false, can_reanalyze: true, customer_messages: 0,
};
const geo = (call_id: string, call_at: string | null): CallGeoDTO => ({ call_id, call_at, proposal_id: `g-${call_id}`, card, has_places: false });

describe('groupCallBlocks', () => {
  it('one block per call: preferences and places of the same call together, newest call first', () => {
    const blocks = groupCallBlocks(
      [pref('p1', 'c1', '2026-09-20T10:00:00.000Z'), pref('p2', 'c2', '2026-09-25T10:00:00.000Z')],
      [geo('c1', '2026-09-20T10:00:00.000Z'), geo('c3', '2026-09-27T10:00:00.000Z')],
    );
    expect(blocks.map((b) => [b.key, b.pref?.id ?? null, b.geo?.proposal_id ?? null])).toEqual([
      ['c3', null, 'g-c3'],
      ['c2', 'p2', null],
      ['c1', 'p1', 'g-c1'],
    ]);
  });
  it('a superseded preference proposal is dropped; a call with nothing left is not shown', () => {
    expect(groupCallBlocks([pref('p1', 'c1', null, 'superseded')], [])).toEqual([]);
  });
  it('a preference proposal without a call id is its own block, dated by its creation', () => {
    const [b] = groupCallBlocks([pref('p9', null, null)], []);
    expect(b).toMatchObject({ key: 'proposal:p9', callAt: '2026-09-01T00:00:00.000Z' });
  });
});
