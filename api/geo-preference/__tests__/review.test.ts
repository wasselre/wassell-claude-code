import { describe, it, expect } from 'vitest';
import {
  applyReview,
  geoPreferenceToLocationItems,
  mergeLocationItems,
  locationItemSignature,
  ReviewError,
  type ReviewDeps,
  type ProposalRow,
  type ClientWriteResult,
  type AuditRow,
  type ProposalPatch,
} from '../review.js';
import type {
  GeoPreference, GeoGroup, GeoClause, AnchorRef, GeoOperation, AnchorToken,
} from '../../_lib/geoPreference/ontology.js';
import type { LocationItem } from '../../../src/lib/geo/locationItems.js';

// ── GeoPreference builders ───────────────────────────────────────────────────
function anchorRef(operation: GeoOperation, ids: string[], opts: { span?: string; band?: number; anchors?: AnchorToken[] } = {}): AnchorRef {
  return {
    geometry_id: `geo:${ids.join('+')}`,
    recipe: {
      operation,
      source_anchors: opts.anchors ?? (opts.span ? [{ anchor_type: 'district', span: opts.span, normalized_token: opts.span }] : []),
      resolved_element_ids: ids,
      radius_or_band_m: opts.band,
      geo_data_version: 'test',
      resolver_version: 'test',
      compiled_at: '',
    },
  };
}
function clause(op: 'include' | 'exclude', anyOf: AnchorRef[]): GeoClause {
  return { op, anyOf };
}
function group(clauses: GeoClause[], over: Partial<GeoGroup> = {}): GeoGroup {
  return { id: over.id ?? 'g1', role: over.role ?? 'primary', strength: over.strength ?? 'soft', priority: over.priority ?? 1, clauses };
}
function pref(groups: GeoGroup[]): GeoPreference {
  return { schema_version: 'geo-pref/v7', groups };
}

// ── Mapping: GeoPreference → location_items ──────────────────────────────────
describe('geoPreferenceToLocationItems', () => {
  it('maps a district include clause to a district item', () => {
    const items = geoPreferenceToLocationItems(pref([group([clause('include', [anchorRef('district_polygon', ['d-narjis'], { span: 'النرجس' })])])]));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'district', polarity: 'include', district_id: 'd-narjis', district_label: 'النرجس' });
  });

  it('carries clause exclude polarity onto the item', () => {
    const items = geoPreferenceToLocationItems(pref([group([clause('exclude', [anchorRef('district_polygon', ['d-x'])])])]));
    expect(items[0]?.polarity).toBe('exclude');
  });

  it('flattens anyOf alternatives into independent union items', () => {
    const items = geoPreferenceToLocationItems(pref([group([
      clause('include', [anchorRef('district_polygon', ['d-a']), anchorRef('district_polygon', ['d-b'])]),
    ])]));
    expect(items.map((i) => (i.kind === 'district' ? i.district_id : null))).toEqual(['d-a', 'd-b']);
  });

  it('maps a within_radius landmark recipe (using its band) to an element rule', () => {
    const items = geoPreferenceToLocationItems(pref([group([clause('include', [anchorRef('within_radius', ['el-kafd'], { span: 'كافد', band: 2500 })])])]));
    expect(items[0]).toMatchObject({ kind: 'element_rule', polarity: 'include' });
    const cond = items[0]?.kind === 'element_rule' ? items[0].conditions[0] : undefined;
    expect(cond).toMatchObject({ rule: 'within_radius', element_id: 'el-kafd', distance_m: 2500 });
  });

  it('maps a directional_band with a detectable cardinal to a direction rule', () => {
    const anchors: AnchorToken[] = [
      { anchor_type: 'direction', span: 'north of', normalized_token: 'north' },
      { anchor_type: 'road', span: 'King Fahd Rd', normalized_token: 'king_fahd' },
    ];
    const items = geoPreferenceToLocationItems(pref([group([clause('include', [anchorRef('directional_band', ['north', 'king_fahd'], { anchors })])])]));
    const cond = items[0]?.kind === 'element_rule' ? items[0].conditions[0] : undefined;
    expect(cond).toMatchObject({ rule: 'north_of', element_id: 'king_fahd' });
  });

  it('drops a clause whose recipe resolved no ids (nothing to add silently)', () => {
    expect(geoPreferenceToLocationItems(pref([group([clause('include', [anchorRef('district_polygon', [])])])]))).toHaveLength(0);
  });
});

describe('mergeLocationItems', () => {
  it('unions and de-dupes by signature, ignoring the item uuid', () => {
    const existing = geoPreferenceToLocationItems(pref([group([clause('include', [anchorRef('district_polygon', ['d-a'])])])]));
    const incoming = geoPreferenceToLocationItems(pref([group([clause('include', [anchorRef('district_polygon', ['d-a']), anchorRef('district_polygon', ['d-b'])])])]));
    const merged = mergeLocationItems(existing, incoming);
    expect(merged).toHaveLength(2); // d-a not duplicated, d-b added
    expect(new Set(merged.map(locationItemSignature)).size).toBe(2);
  });
});

// ── applyReview: the action → (client write?) + audit safety property ─────────
interface Spy {
  applyCalls: { clientId: string; items: LocationItem[] }[];
  audits: AuditRow[];
  updates: { id: string; patch: ProposalPatch }[];
  accessChecks: string[];
}

function makeDeps(proposal: ProposalRow | null, over: Partial<ReviewDeps> = {}): { deps: ReviewDeps; spy: Spy } {
  const spy: Spy = { applyCalls: [], audits: [], updates: [], accessChecks: [] };
  const deps: ReviewDeps = {
    getProposal: async () => proposal,
    applyToClient: async (clientId, items): Promise<ClientWriteResult> => {
      spy.applyCalls.push({ clientId, items });
      const before: LocationItem[] = [];
      return { before, after: mergeLocationItems(before, items) };
    },
    updateProposal: async (id, patch) => { spy.updates.push({ id, patch }); },
    insertAudit: async (row) => { spy.audits.push(row); },
    assertCanApply: async (clientId) => { spy.accessChecks.push(clientId); },
    now: () => '2026-09-03T00:00:00.000Z',
    ...over,
  };
  return { deps, spy };
}

const baseProposal = (over: Partial<ProposalRow> = {}): ProposalRow => ({
  id: 'p1',
  client_id: 'c1',
  status: 'pending',
  proposed_action: 'confirm',
  proposed_expression: pref([group([clause('include', [anchorRef('district_polygon', ['d-a'], { span: 'A' })])])]),
  final_expression: null,
  reviewer_note: null,
  version: 3,
  ...over,
});

describe('applyReview — reject/must_confirm never write the client record', () => {
  it('reject: no client write, one audit row (applied=false), status rejected', async () => {
    const { deps, spy } = makeDeps(baseProposal());
    const out = await applyReview(deps, { proposalId: 'p1', action: 'reject', reviewerId: 'u1', note: 'not this one' });
    expect(spy.applyCalls).toHaveLength(0);        // THE SAFETY PROPERTY
    expect(spy.accessChecks).toHaveLength(0);
    expect(spy.audits).toHaveLength(1);
    expect(spy.audits[0]).toMatchObject({ action: 'reject', applied: false, status_after: 'rejected', reviewer_id: 'u1', note: 'not this one' });
    expect(spy.audits[0]?.location_items_after).toBeNull();
    expect(spy.updates[0]?.patch.status).toBe('rejected');
    expect(out.applied).toBe(false);
  });

  it('must_confirm: no client write, audit applied=false, status must_confirm', async () => {
    const { deps, spy } = makeDeps(baseProposal());
    const out = await applyReview(deps, { proposalId: 'p1', action: 'must_confirm', reviewerId: 'u1' });
    expect(spy.applyCalls).toHaveLength(0);        // THE SAFETY PROPERTY
    expect(spy.audits[0]).toMatchObject({ action: 'must_confirm', applied: false, status_after: 'must_confirm' });
    expect(out.status).toBe('must_confirm');
  });
});

describe('applyReview — confirm/edit apply with an audit row', () => {
  it('confirm: writes the client ONCE, audit applied=true with before/after, status applied', async () => {
    const { deps, spy } = makeDeps(baseProposal());
    const out = await applyReview(deps, { proposalId: 'p1', action: 'confirm', reviewerId: 'u1' });
    expect(spy.applyCalls).toHaveLength(1);
    expect(spy.accessChecks).toEqual(['c1']);      // access gated before writing
    expect(spy.applyCalls[0]?.items[0]).toMatchObject({ kind: 'district', district_id: 'd-a' });
    expect(spy.audits).toHaveLength(1);
    expect(spy.audits[0]).toMatchObject({ action: 'confirm', applied: true, status_after: 'applied', reviewer_id: 'u1' });
    expect(Array.isArray(spy.audits[0]?.location_items_after)).toBe(true);
    expect(spy.updates[0]?.patch.status).toBe('applied');
    expect(spy.updates[0]?.patch.final_expression).toBeUndefined(); // confirm doesn't set final_expression
    expect(out.applied).toBe(true);
  });

  it('edit: applies the EDITED expression and records final_expression', async () => {
    const { deps, spy } = makeDeps(baseProposal());
    const finalExpression = pref([group([clause('exclude', [anchorRef('district_polygon', ['d-z'], { span: 'Z' })])])]);
    await applyReview(deps, { proposalId: 'p1', action: 'edit', reviewerId: 'u1', finalExpression });
    expect(spy.applyCalls).toHaveLength(1);
    // The applied items come from the EDITED expression, not the original proposal.
    expect(spy.applyCalls[0]?.items[0]).toMatchObject({ kind: 'district', district_id: 'd-z', polarity: 'exclude' });
    expect(spy.updates[0]?.patch.final_expression).toEqual(finalExpression);
    expect(spy.audits[0]).toMatchObject({ action: 'edit', applied: true });
    expect(spy.audits[0]?.expression_after).toEqual(finalExpression);
  });

  it('edit without a finalExpression is rejected before any write', async () => {
    const { deps, spy } = makeDeps(baseProposal());
    await expect(applyReview(deps, { proposalId: 'p1', action: 'edit', reviewerId: 'u1' })).rejects.toMatchObject({ status: 400 });
    expect(spy.applyCalls).toHaveLength(0);
    expect(spy.audits).toHaveLength(0);
  });
});

describe('applyReview — guards', () => {
  it('404 when the proposal does not exist', async () => {
    const { deps } = makeDeps(null);
    await expect(applyReview(deps, { proposalId: 'nope', action: 'confirm', reviewerId: 'u1' })).rejects.toBeInstanceOf(ReviewError);
  });

  it('409 when the proposal was already resolved', async () => {
    const { deps, spy } = makeDeps(baseProposal({ status: 'applied' }));
    await expect(applyReview(deps, { proposalId: 'p1', action: 'confirm', reviewerId: 'u1' })).rejects.toMatchObject({ status: 409 });
    expect(spy.applyCalls).toHaveLength(0);
  });

  it('409 when the loaded version is stale', async () => {
    const { deps, spy } = makeDeps(baseProposal({ version: 5 }));
    await expect(applyReview(deps, { proposalId: 'p1', action: 'confirm', reviewerId: 'u1', expectedVersion: 3 })).rejects.toMatchObject({ status: 409 });
    expect(spy.applyCalls).toHaveLength(0);
  });
});
