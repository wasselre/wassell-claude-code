import { describe, it, expect } from 'vitest';
import {
  computeGeoMetrics, computeChannelMetrics, proveCoverageNotInflatableByMustConfirm,
  isMustConfirm, hasSevere, scored, notApplicable,
  type ScoredUnit, type SevereFlags,
} from '../geoPreference/metrics.js';
import {
  evaluateAllCheckpoints, evaluateFinalStateOnly, compareExpressions, FrozenTestGuard,
  FrozenTestGuardError, type EvalDatum,
} from '../geoPreference/evalHarness.js';
import {
  LABELING_INSTRUMENT, FUZZY_FIELDS, ESCAPES, adjudicate, cohenKappa,
  mapDisagreementToMustConfirm, EVIDENCE_FIELDS, CHECKPOINT_FIELDS,
} from '../geoPreference/labelingInstrument.js';
import type {
  Channel, RequiredHandling, GateDecision,
} from '../geoPreference/metrics.js';
import type {
  GeoPreference, GeoGroup, AnchorRef, Checkpoint,
} from '../geoPreference/ontology.js';

// ── ScoredUnit builder ───────────────────────────────────────────────────────
const NO_SEVERE: SevereFlags = {
  wrong_hard_include: false, wrong_hard_exclude: false,
  wrong_supersession: false, wrong_city: false, wrong_geo_entity: false,
};

function mkUnit(over: Partial<ScoredUnit> & Pick<ScoredUnit, 'id' | 'client_id' | 'channel'>): ScoredUnit {
  const allCorrect = {
    mention_detection: scored(true),
    interpretation: {
      speech_act: scored(true), preference_role: scored(true), commitment: scored(true),
      holder_role: scored(true), applicability: scored(true),
    },
    anchor_extraction: scored(true),
    entity_resolution: scored(true),
    geometry_construction: scored(true),
    matching: scored(true),
  };
  return {
    gold_handling: 'resolvable_without_customer',
    predicted_gate: 'auto_write',
    stages: over.stages ?? allCorrect,
    severe: over.severe ?? NO_SEVERE,
    final_correct: over.final_correct ?? true,
    ...over,
  };
}

// ── The synthetic gold fixture (chat) ────────────────────────────────────────
// c1: two auto-writes, one clean + one corrupt (severe, written).
// c2: a correct confirm + a WRONGLY auto-written must_confirm (severe).
// c3: a correct auto-ignore.
const chatUnits: ScoredUnit[] = [
  mkUnit({ id: 'u1', client_id: 'c1', channel: 'chat' }),
  mkUnit({
    id: 'u2', client_id: 'c1', channel: 'chat',
    final_correct: false,
    severe: { ...NO_SEVERE, wrong_hard_include: true },
    stages: {
      mention_detection: scored(true),
      interpretation: {
        speech_act: scored(true), preference_role: scored(true), commitment: scored(true),
        holder_role: scored(true), applicability: scored(true),
      },
      anchor_extraction: scored(true),
      entity_resolution: scored(true),
      geometry_construction: scored(true),
      matching: scored(false), // the mistake
    },
  }),
  mkUnit({
    id: 'u3', client_id: 'c2', channel: 'chat',
    gold_handling: 'customer_confirmation_required', predicted_gate: 'confirm',
  }),
  mkUnit({
    id: 'u4', client_id: 'c2', channel: 'chat',
    gold_handling: 'customer_confirmation_required', predicted_gate: 'auto_write', // WRONGLY auto-wrote
    final_correct: false,
    severe: { ...NO_SEVERE, wrong_city: true },
    stages: {
      mention_detection: scored(true),
      interpretation: {
        speech_act: scored(true), preference_role: scored(true), commitment: scored(true),
        holder_role: scored(true), applicability: scored(true),
      },
      anchor_extraction: scored(true),
      entity_resolution: scored(false), // resolved the wrong city
      geometry_construction: scored(true),
      matching: scored(true),
    },
  }),
  mkUnit({
    id: 'u5', client_id: 'c3', channel: 'chat',
    gold_handling: 'no_profile_effect', predicted_gate: 'ignore',
  }),
];

// Two call-channel units so per-channel separation is exercised.
const callUnits: ScoredUnit[] = [
  mkUnit({ id: 'u7', client_id: 'c4', channel: 'call' }),
  mkUnit({
    id: 'u8', client_id: 'c4', channel: 'call',
    gold_handling: 'human_geo_review_required', predicted_gate: 'human_review',
  }),
];

const allUnits = [...chatUnits, ...callUnits];

// ── (a) the six metrics compute correctly ────────────────────────────────────
describe('(a) action-sensitive metrics compute correctly, per channel', () => {
  const report = computeGeoMetrics(allUnits);

  it('separates chat from call and keeps a combined pool', () => {
    expect(report.chat.total_volume).toBe(5);
    expect(report.call.total_volume).toBe(2);
    expect(report.combined.total_volume).toBe(7);
  });

  it('field_level_error = wrong applicable fields / all applicable fields', () => {
    // 5 units × 10 applicable fields = 50; wrong = u2.matching + u4.entity = 2.
    expect(report.chat.field_level_error).toBeCloseTo(2 / 50, 12);
  });

  it('record_level_error = units with ≥1 wrong field / total', () => {
    expect(report.chat.record_level_error).toBeCloseTo(2 / 5, 12); // u2, u4
  });

  it('severe_error_rate = units with any severe mistake / total', () => {
    expect(report.chat.severe_error_rate).toBeCloseTo(2 / 5, 12); // u2, u4
  });

  it('client_level_corruption = clients with a WRITTEN severe error / clients', () => {
    // c1 (u2 auto_write+severe) and c2 (u4 auto_write+severe) corrupted; c3 clean.
    expect(report.chat.client_level_corruption).toBeCloseTo(2 / 3, 12);
  });

  it('automation_coverage = correctly auto-handled / total (must_confirm in denom)', () => {
    expect(report.chat.automation_coverage).toBeCloseTo(2 / 5, 12); // u1 + u5
    expect(report.call.automation_coverage).toBeCloseTo(1 / 2, 12); // u7 only
  });

  it('review_burden and confirmation_rate over total', () => {
    expect(report.chat.review_burden).toBeCloseTo(1 / 5, 12);       // u3
    expect(report.chat.confirmation_rate).toBeCloseTo(1 / 5, 12);   // u3
    expect(report.call.review_burden).toBeCloseTo(1 / 2, 12);       // u8 human_review
  });

  it('per-stage accuracy isolates the two failing stages', () => {
    expect(report.chat.stage_accuracy.matching).toBeCloseTo(4 / 5, 12);          // u2 wrong
    expect(report.chat.stage_accuracy.entity_resolution).toBeCloseTo(4 / 5, 12); // u4 wrong
    expect(report.chat.stage_accuracy.interpretation.overall).toBeCloseTo(1, 12);
    expect(report.chat.stage_accuracy.geometry_construction).toBeCloseTo(1, 12);
  });
});

// ── (b) must_confirm cases MUST stay in coverage denominators ────────────────
describe('(b) must_confirm cases remain in the coverage denominator', () => {
  const chat = computeChannelMetrics(chatUnits, 'chat');

  it('total_volume and coverage include the must_confirm cases', () => {
    expect(chat.must_confirm_volume).toBe(2); // u3, u4
    expect(chat.total_volume).toBe(5);        // includes the 2 must_confirm
    expect(chat.automation_coverage).toBeCloseTo(2 / 5, 12);
  });

  it('FAILS if must_confirm were excluded from the denominator', () => {
    // Reproduce the tempting bug: drop must_confirm from the denominator.
    const buggyDenominator = chatUnits.filter((u) => !isMustConfirm(u)).length; // = 3
    const coveredCount = 2; // u1, u5
    const buggyCoverage = coveredCount / buggyDenominator; // 0.6667 — inflated
    // The real metric must NOT equal the inflated one; it must equal covered/total.
    expect(chat.automation_coverage).not.toBeCloseTo(buggyCoverage, 6);
    expect(chat.automation_coverage).toBeCloseTo(coveredCount / chat.total_volume, 12);
  });

  it('auto-write-allowed coverage is the ONLY place must_confirm is excluded', () => {
    // allowed subset = u1, u2 (resolvable_without_customer); covered = u1.
    expect(chat.auto_write_allowed_volume).toBe(2);
    expect(chat.auto_write_allowed_coverage).toBeCloseTo(1 / 2, 12);
  });

  it('coverage cannot be inflated by reclassifying a hard case as must_confirm', () => {
    // Reclassify u1 (a covered case) → must_confirm+confirm. Coverage can only fall.
    const proof = proveCoverageNotInflatableByMustConfirm(chatUnits, ['u1']);
    expect(proof.total_unchanged).toBe(true);
    expect(proof.monotone_non_increasing).toBe(true);
    expect(proof.reclassified_coverage).toBeCloseTo(1 / 5, 12); // only u5 left covered
    expect(proof.reclassified_coverage).toBeLessThan(proof.baseline_coverage);
  });
});

// ── Fixture builders for the harness (checkpoint) tests ──────────────────────
function aref(geometry_id: string, elementId: string): AnchorRef {
  return {
    geometry_id,
    recipe: {
      operation: 'district_polygon', source_anchors: [], resolved_element_ids: [elementId],
      geo_data_version: 'g1', resolver_version: 'r1', compiled_at: '2026-01-01T00:00:00Z',
    },
  };
}
function hardIncludeGroup(geometry_id: string, elementId: string, role: GeoGroup['role'], priority: number): GeoGroup {
  return { id: `g-${geometry_id}`, role, strength: 'hard', priority, clauses: [{ op: 'include', anyOf: [aref(geometry_id, elementId)] }] };
}
function pref(groups: GeoGroup[]): GeoPreference {
  return { schema_version: 'v1', groups };
}
function checkpoint(
  turn: string, ts: string, actual: GeoPreference, canonical: GeoPreference,
  required_handling: RequiredHandling,
): Checkpoint {
  return {
    conversation_id: 'conv1', turn_id: turn, as_of_timestamp: ts,
    member_message_ids: [turn], expected_processing: 'evaluate_now',
    evidence_visible_so_far: [], lifecycle_by_mention: {},
    actual_compiler_output: actual, canonical_expected_expression: canonical,
    required_handling, maximum_safe_action: 'write_hard', universe_source: 'explicit',
  };
}
function datum(cp: Checkpoint, gate: GateDecision = 'auto_write', channel: Channel = 'chat'): EvalDatum {
  return { checkpoint: cp, channel, client_id: 'c9', predicted_gate: gate, split: 'dev' };
}

// A ⇒ supersede-to-B conversation. Final state (CP3) is correct; the botched
// supersession lives only at CP2.
const A = pref([hardIncludeGroup('geo-A', 'el-A', 'primary', 1)]);
const B = pref([hardIncludeGroup('geo-B', 'el-B', 'primary', 1)]);
// CP2 actual FAILS the supersession: keeps A AND adds B as an alternative.
const A_AND_B = pref([
  hardIncludeGroup('geo-A', 'el-A', 'primary', 1),
  hardIncludeGroup('geo-B', 'el-B', 'alternative', 2),
]);

const supersessionConversation: EvalDatum[] = [
  datum(checkpoint('t1', '2026-01-01T00:00:01Z', A, A, 'resolvable_without_customer')),        // match
  datum(checkpoint('t2', '2026-01-01T00:00:02Z', A_AND_B, B, 'resolvable_without_customer')),  // botched supersession
  datum(checkpoint('t3', '2026-01-01T00:00:03Z', B, B, 'resolvable_without_customer')),        // self-corrected
];

// ── (c) checkpoint eval catches a supersession final-state eval misses ───────
describe('(c) checkpoint-granular eval catches a mid-conversation supersession', () => {
  it('final-state-only eval sees a clean conversation (misses the botch)', () => {
    const run = evaluateFinalStateOnly(supersessionConversation);
    expect(run.units).toHaveLength(1);                          // only CP3
    expect(run.metrics.combined.severe_error_rate).toBe(0);
    expect(run.metrics.combined.record_level_error).toBe(0);
    expect(run.clients.every((c) => !c.corrupted)).toBe(true);
  });

  it('all-checkpoint eval flags the CP2 supersession failure', () => {
    const run = evaluateAllCheckpoints(supersessionConversation);
    expect(run.units).toHaveLength(3);
    expect(run.metrics.combined.severe_error_rate).toBeGreaterThan(0);

    const cp2 = run.diffs.get('conv1:t2')!;
    expect(cp2.supersession_mismatch).toBe(true);
    expect(cp2.hard_include_mismatch).toBe(true);

    // The client IS flagged corrupted (CP2 was auto-written with a severe error).
    expect(run.clients.find((c) => c.client_id === 'c9')?.corrupted).toBe(true);

    // And the final checkpoint alone is clean — proving the catch is temporal.
    expect(run.diffs.get('conv1:t3')!.expression_match).toBe(true);
  });
});

// ── compareExpressions direct + city (namesake) detection ────────────────────
describe('compareExpressions', () => {
  it('identical expressions match with no severe flags', () => {
    const d = compareExpressions(A, A);
    expect(d.expression_match).toBe(true);
    expect(hasSevere({
      wrong_hard_include: d.hard_include_mismatch, wrong_hard_exclude: d.hard_exclude_mismatch,
      wrong_supersession: d.supersession_mismatch, wrong_city: d.city_mismatch,
      wrong_geo_entity: d.geo_entity_mismatch,
    })).toBe(false);
  });

  it('detects a wrong city via the namesake resolver', () => {
    // Same geometry_id shape, but element ids resolve to different cities.
    const riyadhNarjis = pref([hardIncludeGroup('geo-N', 'el-riyadh-narjis', 'primary', 1)]);
    const jeddahNarjis = pref([hardIncludeGroup('geo-N', 'el-jeddah-narjis', 'primary', 1)]);
    const cityOfElement = (el: string) => (el.includes('riyadh') ? 'Riyadh' : el.includes('jeddah') ? 'Jeddah' : null);
    const d = compareExpressions(jeddahNarjis, riyadhNarjis, { cityOfElement });
    expect(d.city_mismatch).toBe(true);
    expect(d.geo_entity_mismatch).toBe(true); // element ids differ too
    expect(d.expression_match).toBe(false);
  });
});

// ── Frozen DEV/TEST discipline ───────────────────────────────────────────────
describe('FrozenTestGuard (frozen TEST discipline)', () => {
  const devDatum = { ...datum(checkpoint('t1', '2026-01-01T00:00:01Z', A, A, 'resolvable_without_customer')), split: 'dev' as const };
  const testDatum = { ...datum(checkpoint('t9', '2026-01-01T00:00:09Z', A, A, 'resolvable_without_customer')), split: 'test' as const };

  it('reports on DEV freely while tuning', () => {
    const guard = new FrozenTestGuard();
    expect(guard.phase).toBe('tuning');
    expect(() => guard.reportOnDev([devDatum, testDatum])).not.toThrow();
  });

  it('REFUSES to report on TEST while tuning', () => {
    const guard = new FrozenTestGuard();
    expect(() => guard.reportOnTest([devDatum, testDatum])).toThrow(FrozenTestGuardError);
  });

  it('allows TEST exactly once after freeze(), then refuses re-reads', () => {
    const guard = new FrozenTestGuard();
    guard.freeze();
    const run = guard.reportOnTest([devDatum, testDatum]);
    expect(run.units).toHaveLength(1); // only the test-split datum
    expect(() => guard.reportOnTest([devDatum, testDatum])).toThrow(/already reported/);
  });
});

// ── Labeling instrument + adjudication ───────────────────────────────────────
describe('labeling instrument config is ontology-complete', () => {
  it('covers evidence, anchor, relation and checkpoint entities', () => {
    const entities = new Set(LABELING_INSTRUMENT.map((f) => f.entity));
    expect(entities).toEqual(new Set(['evidence', 'anchor', 'relation', 'checkpoint']));
  });

  it('every fuzzy field offers all three escape hatches', () => {
    for (const d of LABELING_INSTRUMENT) {
      if (d.fuzzy) expect([...d.escapes].sort()).toEqual([...ESCAPES].sort());
    }
    expect(FUZZY_FIELDS.length).toBeGreaterThan(0);
  });

  it('enum fields carry their allowed values from the ontology', () => {
    const holderRole = EVIDENCE_FIELDS.find((f) => f.field === 'holder_role')!;
    expect(holderRole.allowed_values).toContain('buyer');
    expect(holderRole.allowed_values).toContain('unrelated_third_party');
    const reqHandling = CHECKPOINT_FIELDS.find((f) => f.field === 'required_handling')!;
    expect(reqHandling.allowed_values).toContain('customer_confirmation_required');
  });
});

describe('adjudication: agreement, Cohen κ, survivors → must-confirm', () => {
  it('cohenKappa matches a hand-computed value', () => {
    // po=0.75, pe=0.5 ⇒ κ=0.5.
    const pairs: [string, string][] = [['x', 'x'], ['x', 'x'], ['y', 'y'], ['x', 'y']];
    expect(cohenKappa(pairs)).toBeCloseTo(0.5, 12);
  });

  it('perfect agreement ⇒ κ = 1; single-category ⇒ defined, not NaN', () => {
    expect(cohenKappa([['a', 'a'], ['b', 'b']])).toBeCloseTo(1, 12);
    expect(Number.isNaN(cohenKappa([['a', 'a'], ['a', 'a']]))).toBe(false);
  });

  it('surviving disagreements map to the right operational must-confirm condition', () => {
    expect(mapDisagreementToMustConfirm('evidence.holder_role', 'buyer', 'influencer')).toBe('unclear_preference_holder');
    expect(mapDisagreementToMustConfirm('evidence.commitment', 'required', 'preferred')).toBe('uncertain_commitment_question');
    expect(mapDisagreementToMustConfirm('anchor.anchor_type', 'district', 'landmark')).toBe('multiple_plausible_entities');
    expect(mapDisagreementToMustConfirm('checkpoint.lifecycle_by_mention', 'active', 'superseded')).toBe('contradiction_without_replacement');
    expect(mapDisagreementToMustConfirm('checkpoint.universe_source', 'explicit', 'unknown')).toBe('missing_radius');
    expect(mapDisagreementToMustConfirm('evidence.preference_applicability', 'active', 'exploratory')).toBe('unresolved_reference');
  });

  it('adjudicate produces per-field κ and one survivor per disagreement', () => {
    const result = adjudicate([
      { item_id: 'm1', field: 'evidence.holder_role', labeler_a: 'buyer', labeler_b: 'buyer' },
      { item_id: 'm2', field: 'evidence.holder_role', labeler_a: 'buyer', labeler_b: 'influencer' }, // disagree
      { item_id: 'm3', field: 'evidence.commitment', labeler_a: 'required', labeler_b: 'required' },
    ]);
    const holder = result.per_field.find((f) => f.field === 'evidence.holder_role')!;
    expect(holder.n).toBe(2);
    expect(holder.raw_agreement).toBeCloseTo(1 / 2, 12);
    expect(result.survivors).toHaveLength(1);
    expect(result.survivors[0]).toMatchObject({
      item_id: 'm2', field: 'evidence.holder_role', must_confirm_condition: 'unclear_preference_holder',
    });
  });
});

// silence unused-import guard for notApplicable (kept for parity with the harness API)
void notApplicable;
