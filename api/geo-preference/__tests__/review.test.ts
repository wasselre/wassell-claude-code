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

  it('never turns an UNRESOLVED (stub) mention into a location item — its "ids" are words, not places', () => {
    const stub = anchorRef('district_polygon', ['المعذر', 'الشمالي'], { span: 'المعذر الشمالي' });
    stub.recipe!.geo_data_version = 'stub';
    const real = anchorRef('district_polygon', ['11111111-1111-4111-8111-111111111111'], { span: 'النرجس' });
    const items = geoPreferenceToLocationItems(pref([group([clause('include', [stub, real])])]));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'district', district_id: '11111111-1111-4111-8111-111111111111' });
  });
  it('drops a clause whose recipe resolved no ids (nothing to add silently)', () => {
    expect(geoPreferenceToLocationItems(pref([group([clause('include', [anchorRef('district_polygon', [])])])]))).toHaveLength(0);
  });

  it('maps a zone_union recipe to DISTRICT items (its ids are district record ids)', () => {
    const ref: AnchorRef = {
      geometry_id: 'geo:11111111-1111-4111-8111-111111111111+22222222-2222-4222-8222-222222222222',
      recipe: {
        operation: 'zone_union',
        source_anchors: [{ anchor_type: 'direction', span: 'شمال الرياض', normalized_token: 'شمال_الرياض' }],
        resolved_element_ids: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
        radius_or_band_m: undefined,
        geo_data_version: 'test',
        resolver_version: 'test',
        compiled_at: '',
      },
    };
    const items = geoPreferenceToLocationItems(pref([group([clause('include', [ref])])]));
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'district', polarity: 'include', district_id: '11111111-1111-4111-8111-111111111111', district_label: 'شمال الرياض' });
    expect(items[1]).toMatchObject({ kind: 'district', polarity: 'include', district_id: '22222222-2222-4222-8222-222222222222', district_label: 'شمال الرياض' });
    expect(items.some((i) => i.kind === 'element_rule')).toBe(false);
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
    // Dismissing is a decision about the client too — access is checked (2026-09-27).
    expect(spy.accessChecks).toEqual(['c1']);
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

describe('geoPreferenceToLocationItems — district_side_clip (2026-09-15)', () => {
  const ring: [number, number][] = [[46.60, 24.70], [46.62, 24.70], [46.62, 24.72], [46.60, 24.72], [46.60, 24.70]];
  const base = {
    schema_version: 'geo-pref/v7',
    groups: [{ id: 'g1', role: 'primary' as const, strength: 'soft' as const, priority: 1, clauses: [{ op: 'include' as const, anyOf: [{ geometry_id: 'geo:e1', recipe: {
      operation: 'district_side_clip' as const, source_anchors: [{ anchor_type: 'district' as const, span: 'العليا', normalized_token: 'العليا' }, { anchor_type: 'direction' as const, span: 'غرب الملك فهد', normalized_token: 'غرب الملك فهد' }],
      resolved_element_ids: ['d-olaya', 'RUH-ROAD-0694'], side: 'west' as const, geo_data_version: 'x', resolver_version: 'x', compiled_at: '',
      clip_parts: [{ district_id: 'd-olaya', name: 'حي العليا', crossed: true, kept: true, kept_km2: 3.89, total_km2: 10.84 }],
    } }] }] }],
  };
  it('with a clipped shape → ONE drawn_area per polygon, closed ring in [lng,lat], labelled with the district + side', () => {
    const pref = JSON.parse(JSON.stringify(base));
    pref.groups[0].clauses[0].anyOf[0].recipe.clip_geojson = { type: 'MultiPolygon', coordinates: [[ring]] };
    const items = geoPreferenceToLocationItems(pref);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('drawn_area');
    const d = items[0] as Extract<LocationItem, { kind: 'drawn_area' }>;
    expect(d.coordinates[0]).toEqual(d.coordinates[d.coordinates.length - 1]);
    expect(d.coordinates).toHaveLength(5);
    expect(d.label).toContain('حي العليا');
    expect(d.label).toContain('غرب');
    expect(d.polarity).toBe('include');
  });
  it('a legacy row with NO shape saves nothing — the old "districts + side rule" fallback was the WHOLE district (2026-10-03)', () => {
    const noClip = JSON.parse(JSON.stringify(base));
    delete noClip.groups[0].clauses[0].anyOf[0].recipe.clip_parts;
    expect(geoPreferenceToLocationItems(noClip)).toEqual([]);
    // Parts without a shape cannot be drawn either.
    expect(geoPreferenceToLocationItems(JSON.parse(JSON.stringify(base)))).toEqual([]);
  });

  it('a clip that keeps NOTHING (every district on the other side) saves nothing — never the district it dropped (finding 23)', () => {
    const empty = JSON.parse(JSON.stringify(base));
    const recipe = empty.groups[0].clauses[0].anyOf[0].recipe;
    recipe.clip_geojson = { type: 'MultiPolygon', coordinates: [] };
    recipe.clip_parts = [{ district_id: 'd-malqa', name: 'حي الملقا', crossed: false, kept: false, kept_km2: 0, total_km2: 21.85 }];
    recipe.resolved_element_ids = ['d-malqa', 'RUH-ROAD-0681'];
    recipe.side = 'north';
    expect(geoPreferenceToLocationItems(empty)).toEqual([]);
    // Parts all dropped wins even if a stray polygon is present.
    recipe.clip_geojson = { type: 'MultiPolygon', coordinates: [[ring]] };
    expect(geoPreferenceToLocationItems(empty)).toEqual([]);
  });
});

describe('geoPreferenceToLocationItems — directional_band side and label (2026-10-03)', () => {
  const band = (anchors: AnchorToken[], side?: 'north' | 'south' | 'east' | 'west', band_m?: number): GeoPreference => {
    const ref = anchorRef('directional_band', ['RUH-RING-0853'], { anchors, band: band_m });
    if (side) ref.recipe!.side = side;
    return pref([group([clause('include', [ref])])]);
  };
  const rule = (items: LocationItem[]) => (items[0]?.kind === 'element_rule' ? items[0] : null);

  it('the recipe\'s side wins over any name: «جنوب الدائري الشمالي» is SOUTH (finding 21)', () => {
    const items = geoPreferenceToLocationItems(band([{ anchor_type: 'direction', span: 'جنوب الدائري الشمالي', normalized_token: 'جنوب الدائري الشمالي' }], 'south'));
    expect(rule(items)?.conditions[0]).toMatchObject({ rule: 'south_of', element_id: 'RUH-RING-0853', distance_m: 5000 });
  });

  it('a legacy band with no side reads ONLY the leading direction word — never one inside the road\'s name', () => {
    const one = geoPreferenceToLocationItems(band([{ anchor_type: 'direction', span: 'جنوب الدائري الشمالي', normalized_token: 'جنوب الدائري الشمالي' }]));
    expect(rule(one)?.conditions[0]).toMatchObject({ rule: 'south_of' });
    const split = geoPreferenceToLocationItems(band([
      { anchor_type: 'direction', span: 'غرب', normalized_token: 'غرب' },
      { anchor_type: 'road', span: 'طريق الدائري الشرقي', normalized_token: 'طريق الدائري الشرقي' },
    ]));
    expect(rule(split)?.conditions[0]).toMatchObject({ rule: 'west_of' });
    // A diagonal has no road side → NOTHING (round 3, #13/#16): it used to save a
    // 5 km within_distance strip on BOTH sides of the whole road.
    const diag = geoPreferenceToLocationItems(band([{ anchor_type: 'direction', span: 'شمال شرق الملك فهد', normalized_token: 'شمال شرق الملك فهد' }]));
    expect(diag).toEqual([]);
  });

  it('round 3 #13/#16: a band with no side never becomes a both-sides within_distance corridor', () => {
    // The new resolver never produces one (a diagonal asks); a stored one saves nothing.
    expect(geoPreferenceToLocationItems(band([{ anchor_type: 'direction', span: 'شمال شرق طريق الملك فهد', normalized_token: 'شمال شرق طريق الملك فهد' }], undefined, 5000))).toEqual([]);
    expect(geoPreferenceToLocationItems(band([{ anchor_type: 'direction', span: 'وسط الملك فهد', normalized_token: 'وسط الملك فهد' }]))).toEqual([]);
    expect(geoPreferenceToLocationItems(band([{ anchor_type: 'road', span: 'طريق الملك فهد', normalized_token: 'طريق الملك فهد' }]))).toEqual([]);
  });

  it('round 3 #21: the side comes from the token the resolver PARSED — a diagonal there never falls through to the span', () => {
    const anchors: AnchorToken[] = [{ anchor_type: 'direction', span: 'الشمال الشرقي من طريق الملك فهد', normalized_token: 'شمال شرق طريق الملك فهد' }];
    expect(geoPreferenceToLocationItems(band(anchors))).toEqual([]);
    // The adjectival diagonal on its own is a diagonal too.
    expect(geoPreferenceToLocationItems(band([{ anchor_type: 'direction', span: 'الشمال الشرقي من طريق الملك فهد', normalized_token: 'الشمال الشرقي من طريق الملك فهد' }]))).toEqual([]);
    // A recorded side always wins.
    expect(rule(geoPreferenceToLocationItems(band(anchors, 'north')))?.conditions[0]).toMatchObject({ rule: 'north_of' });
  });

  it('the chip is labelled with the ROAD, so it reads «غرب الملك فهد», never «غرب غرب الملك فهد» (finding 24)', () => {
    const folded = geoPreferenceToLocationItems(band([{ anchor_type: 'direction', span: 'غرب الملك فهد', normalized_token: 'غرب الملك فهد' }], 'west'));
    expect(rule(folded)?.element_label).toBe('الملك فهد');
    const split = geoPreferenceToLocationItems(band([
      { anchor_type: 'direction', span: 'شمال', normalized_token: 'شمال' },
      { anchor_type: 'road', span: 'طريق الملك سلمان', normalized_token: 'طريق الملك سلمان' },
    ], 'north', 2000));
    expect(rule(split)?.element_label).toBe('طريق الملك سلمان');
    expect(rule(split)?.conditions[0]).toMatchObject({ rule: 'north_of', distance_m: 2000 });
  });
});

describe('geoPreferenceToLocationItems — a corridor never saves a silent width (HARD RULE 4)', () => {
  it('no stated width → nothing; a stated width → that width per road', () => {
    expect(geoPreferenceToLocationItems(pref([group([clause('include', [anchorRef('corridor', ['r1', 'r2'], { span: 'بين طريقين' })])])]))).toEqual([]);
    const items = geoPreferenceToLocationItems(pref([group([clause('include', [anchorRef('corridor', ['r1', 'r2'], { span: 'بين طريقين', band: 1500 })])])]));
    expect(items.map((i) => (i.kind === 'element_rule' ? i.conditions[0] : null))).toEqual([
      { rule: 'within_distance', element_id: 'r1', distance_m: 1500 },
      { rule: 'within_distance', element_id: 'r2', distance_m: 1500 },
    ]);
  });
});
