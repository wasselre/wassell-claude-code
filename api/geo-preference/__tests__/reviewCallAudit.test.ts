import { describe, it, expect } from 'vitest';
import {
  applyReview, buildGeoApplyData, mergeLocationItems, ReviewError, CLIENT_HAS_PLACES,
  type ReviewDeps, type ProposalRow, type ClientWriteResult, type ApplyOptions,
} from '../review.js';
import type { GeoPreference } from '../../_lib/geoPreference/ontology.js';
import { parseLocationItems, newDistrictItem, type LocationItem } from '../../../src/lib/geo/locationItems.js';

/**
 * Places from a CALL (the call audit, 2026-09-29_02) are FILL-EMPTY-ONLY: the
 * save must refuse — on the fresh row, inside the versioned write — when the
 * client already has places, and leave the proposal pending. Chat proposals
 * keep today's union.
 */

const D_NEW = '44444444-4444-4444-8444-444444444444';
const D_OLD = '55555555-5555-4555-8555-555555555555';

const expr: GeoPreference = {
  schema_version: 'geo-pref/v7',
  groups: [{
    id: 'g1', role: 'primary', strength: 'soft', priority: 1,
    clauses: [{ op: 'include', anyOf: [{
      geometry_id: 'geo:e1',
      recipe: {
        operation: 'district_polygon',
        source_anchors: [{ anchor_type: 'district', span: 'N', normalized_token: 'N' }],
        resolved_element_ids: [D_NEW], geo_data_version: 'test', resolver_version: 'test', compiled_at: '',
      },
    }] }],
  }],
};

const proposal = (): ProposalRow => ({
  id: 'p-call', client_id: 'c1', status: 'pending', proposed_action: 'confirm',
  proposed_expression: expr, final_expression: null, reviewer_note: null, version: 1,
});

/**
 * A fake client store whose applyToClient behaves like the real port: it builds
 * the new data on the FRESH row with buildGeoApplyData (throwing on refusal).
 */
function makeDeps(client: { location_items?: unknown }, isCall: boolean) {
  const store = { data: { ...client } as Record<string, unknown> };
  const spy = { updates: 0, audits: 0, applyOpts: [] as ApplyOptions[], writes: 0 };
  const deps: ReviewDeps = {
    getProposal: async () => proposal(),
    isCallAuditProposal: async () => isCall,
    applyToClient: async (_clientId, items, opts): Promise<ClientWriteResult> => {
      spy.applyOpts.push(opts);
      const before = parseLocationItems(store.data.location_items);
      store.data = buildGeoApplyData(store.data, items, opts); // throws ⇒ nothing written
      spy.writes += 1;
      return { before, after: parseLocationItems(store.data.location_items) };
    },
    updateProposal: async () => { spy.updates += 1; },
    insertAudit: async () => { spy.audits += 1; },
    now: () => '2026-09-29T00:00:00.000Z',
  };
  return { deps, spy, store };
}

describe('buildGeoApplyData — the fresh-row decision', () => {
  const items: LocationItem[] = [newDistrictItem(D_NEW, 'N', 'include')];
  const existing: LocationItem[] = [newDistrictItem(D_OLD, 'O', 'include')];

  it('call proposal + client with places ⇒ 409 client_has_places', () => {
    let caught: unknown = null;
    try {
      buildGeoApplyData({ location_items: existing }, items, { onlyIfNoPlaces: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReviewError);
    expect(caught).toMatchObject({ status: 409, message: CLIENT_HAS_PLACES });
  });
  it('call proposal + client with none ⇒ the items are written', () => {
    const out = buildGeoApplyData({ client_name: 'x' }, items, { onlyIfNoPlaces: true });
    expect(out.client_name).toBe('x');
    expect(parseLocationItems(out.location_items)).toHaveLength(1);
  });
  it('chat proposal ⇒ union onto the existing places, exactly as before', () => {
    const out = buildGeoApplyData({ location_items: existing }, items, { onlyIfNoPlaces: false });
    expect(parseLocationItems(out.location_items)).toEqual(mergeLocationItems(existing, items));
    expect(parseLocationItems(out.location_items)).toHaveLength(2);
  });
});

describe('applyReview — a call-audit geo proposal is fill-empty-only', () => {
  it('client already has places ⇒ refused with 409, NOTHING written, proposal left pending (no update, no audit)', async () => {
    const { deps, spy, store } = makeDeps({ location_items: [newDistrictItem(D_OLD, 'O', 'include')] }, true);
    const err = await applyReview(deps, { proposalId: 'p-call', action: 'confirm', reviewerId: 'u1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReviewError);
    expect(err).toMatchObject({ status: 409, message: CLIENT_HAS_PLACES });
    expect(spy.applyOpts).toEqual([{ onlyIfNoPlaces: true }]);
    expect(spy.writes).toBe(0);
    expect(parseLocationItems(store.data.location_items)).toHaveLength(1); // untouched
    expect(spy.updates).toBe(0);
    expect(spy.audits).toBe(0);
  });

  it('client has no places ⇒ applied', async () => {
    const { deps, spy, store } = makeDeps({}, true);
    const out = await applyReview(deps, { proposalId: 'p-call', action: 'confirm', reviewerId: 'u1' });
    expect(out.applied).toBe(true);
    expect(spy.writes).toBe(1);
    expect(parseLocationItems(store.data.location_items)).toHaveLength(1);
  });

  it('a CHAT proposal on a client with places still unions (today\'s behaviour)', async () => {
    const { deps, spy, store } = makeDeps({ location_items: [newDistrictItem(D_OLD, 'O', 'include')] }, false);
    const out = await applyReview(deps, { proposalId: 'p-call', action: 'confirm', reviewerId: 'u1' });
    expect(out.applied).toBe(true);
    expect(spy.applyOpts).toEqual([{ onlyIfNoPlaces: false }]);
    expect(parseLocationItems(store.data.location_items)).toHaveLength(2);
  });

  it('dismissing a call proposal on a client with places works (reject never writes)', async () => {
    const { deps, spy } = makeDeps({ location_items: [newDistrictItem(D_OLD, 'O', 'include')] }, true);
    const out = await applyReview(deps, { proposalId: 'p-call', action: 'reject', reviewerId: 'u1' });
    expect(out.status).toBe('rejected');
    expect(spy.writes).toBe(0);
    expect(spy.applyOpts).toEqual([]);
  });

  it('deps without isCallAuditProposal (older wiring) ⇒ treated as a chat proposal', async () => {
    const { deps, spy } = makeDeps({}, true);
    delete deps.isCallAuditProposal;
    await applyReview(deps, { proposalId: 'p-call', action: 'confirm', reviewerId: 'u1' });
    expect(spy.applyOpts).toEqual([{ onlyIfNoPlaces: false }]);
  });
});
