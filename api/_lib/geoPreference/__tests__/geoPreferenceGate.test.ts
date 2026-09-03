import { describe, it, expect, vi } from 'vitest';
import {
  decide,
  canAutoWrite,
  isWriteAction,
  INTERPRETATION_VETO_FLOOR,
  CONTRADICTION_CLEAR_FLOOR,
  type GateConfig,
} from '../gate';
import {
  runReviewFirst,
  type OrchestratorPorts,
  type ProposalStore,
  type ProposalRecord,
  type RunContext,
} from '../orchestrator';
import { type ResolverDb, type DistrictCandidate } from '../resolver';
import { type SatUniverse } from '../satisfiability';
import type {
  GateSignals,
  MaximumSafeAction,
  AmbiguityCondition,
  Evidence,
  AnchorToken,
  AnchorType,
} from '../ontology';

// ════════════════════════════════════════════════════════════════════════════
// Part 1 — the deterministic gate truth-table.
//
// All signals default to a PASSING configuration (well above every threshold);
// each case perturbs exactly one thing to prove that lever, and only that lever,
// moves the decision. The config mirrors geo_pref_gate_config but with
// auto_write_enabled flipped ON so the promotion path is even reachable — the
// last block re-asserts the default-OFF posture.
// ════════════════════════════════════════════════════════════════════════════

const goodSignals: GateSignals = {
  interpretation_confidence: 1,
  lexical_candidate_quality: 1,
  geo_resolution_margin: 1,
  context_consistency: 1,
  contradiction_signal: 1,
  source_quality: 1,
};

const enabledConfig: GateConfig = {
  auto_write_enabled: true,
  t_lexical_margin: 0.9,
  t_geo_margin: 0.9,
  t_source_quality: 0.9,
  min_action_assurance: { write_soft: 0.9, write_hard: 0.98, supersede: 0.99 },
};

const disabledConfig: GateConfig = { ...enabledConfig, auto_write_enabled: false };

const NO_AMBIGUITY: AmbiguityCondition[] = [];

describe('gate.decide — auto_write happy path (enabled)', () => {
  it('all thresholds met + no ambiguity + write action ⇒ auto_write', () => {
    expect(decide(goodSignals, 'write_soft', enabledConfig, NO_AMBIGUITY)).toBe('auto_write');
  });
});

describe('gate.decide — auto_write blocked when the master switch is OFF', () => {
  it('never returns auto_write with auto_write_enabled=false — even with perfect signals', () => {
    expect(decide(goodSignals, 'write_soft', disabledConfig, NO_AMBIGUITY)).toBe('confirm');
    expect(decide(goodSignals, 'write_hard', disabledConfig, NO_AMBIGUITY)).toBe('confirm');
    expect(decide(goodSignals, 'supersede', disabledConfig, NO_AMBIGUITY)).toBe('confirm');
  });

  it('the default posture only ever yields confirm/human_review/ignore', () => {
    const decisions = new Set<string>();
    const actions: MaximumSafeAction[] = [
      'ignore', 'retain_as_candidate', 'propose', 'write_soft', 'write_hard', 'supersede',
    ];
    for (const a of actions) {
      decisions.add(decide(goodSignals, a, disabledConfig, NO_AMBIGUITY));
      decisions.add(decide({ ...goodSignals, interpretation_confidence: 0.1 }, a, disabledConfig, NO_AMBIGUITY));
    }
    expect(decisions.has('auto_write')).toBe(false);
    for (const d of decisions) expect(['confirm', 'human_review', 'ignore']).toContain(d);
  });
});

describe('gate.decide — each low margin independently blocks auto_write', () => {
  it('lexical_candidate_quality below t_lexical_margin ⇒ confirm', () => {
    expect(decide({ ...goodSignals, lexical_candidate_quality: 0.89 }, 'write_soft', enabledConfig, NO_AMBIGUITY))
      .toBe('confirm');
  });

  it('geo_resolution_margin below t_geo_margin ⇒ confirm', () => {
    expect(decide({ ...goodSignals, geo_resolution_margin: 0.5 }, 'write_soft', enabledConfig, NO_AMBIGUITY))
      .toBe('confirm');
  });

  it('source_quality below t_source_quality ⇒ confirm', () => {
    expect(decide({ ...goodSignals, source_quality: 0.0 }, 'write_soft', enabledConfig, NO_AMBIGUITY))
      .toBe('confirm');
  });

  it('contradiction_signal below the clear floor ⇒ confirm', () => {
    expect(decide({ ...goodSignals, contradiction_signal: CONTRADICTION_CLEAR_FLOOR - 0.01 }, 'write_soft', enabledConfig, NO_AMBIGUITY))
      .toBe('confirm');
  });
});

describe('gate.decide — interpretation_confidence is VETO-ONLY', () => {
  it('low interpretation_confidence ⇒ human_review (never confirm/auto_write)', () => {
    expect(decide({ ...goodSignals, interpretation_confidence: INTERPRETATION_VETO_FLOOR - 0.01 }, 'write_soft', enabledConfig, NO_AMBIGUITY))
      .toBe('human_review');
  });

  it('high interpretation_confidence NEVER promotes on its own — the other gates still decide', () => {
    // Perfect interpretation confidence but a failing geo margin must NOT auto_write.
    expect(decide({ ...goodSignals, interpretation_confidence: 1, geo_resolution_margin: 0 }, 'write_soft', enabledConfig, NO_AMBIGUITY))
      .toBe('confirm');
    // interpretation_confidence is absent from the promotion predicate entirely.
    expect(canAutoWrite({ ...goodSignals, interpretation_confidence: 0 /* ignored by predicate */ }, 'write_soft', enabledConfig))
      .toBe(true);
  });

  it('the veto outranks a would-be auto_write', () => {
    expect(decide({ ...goodSignals, interpretation_confidence: 0.2 }, 'supersede', enabledConfig, NO_AMBIGUITY))
      .toBe('human_review');
  });
});

describe('gate.decide — any ambiguity forces confirm', () => {
  const ambiguities: AmbiguityCondition[] = [
    'unresolved_reference', 'multiple_plausible_entities', 'missing_radius',
    'unclear_preference_holder', 'uncertain_commitment_question', 'contradiction_without_replacement',
  ];
  for (const a of ambiguities) {
    it(`ambiguity [${a}] ⇒ confirm even with otherwise-perfect signals`, () => {
      expect(decide(goodSignals, 'write_hard', enabledConfig, [a])).toBe('confirm');
    });
  }
});

describe('gate.decide — action-sensitivity ordering (supersede > write_hard > write_soft)', () => {
  // context_consistency is the action-sensitive assurance measure. Pin it between
  // the write_hard (0.98) and supersede (0.99) floors: write_hard promotes, supersede does not.
  const between = { ...goodSignals, context_consistency: 0.985 };

  it('assurance clears write_soft and write_hard but NOT supersede', () => {
    expect(decide(between, 'write_soft', enabledConfig, NO_AMBIGUITY)).toBe('auto_write');
    expect(decide(between, 'write_hard', enabledConfig, NO_AMBIGUITY)).toBe('auto_write');
    expect(decide(between, 'supersede', enabledConfig, NO_AMBIGUITY)).toBe('confirm');
  });

  it('lowering assurance below the write_hard floor drops write_hard too, write_soft survives', () => {
    const low = { ...goodSignals, context_consistency: 0.92 };
    expect(decide(low, 'write_soft', enabledConfig, NO_AMBIGUITY)).toBe('auto_write');
    expect(decide(low, 'write_hard', enabledConfig, NO_AMBIGUITY)).toBe('confirm');
    expect(decide(low, 'supersede', enabledConfig, NO_AMBIGUITY)).toBe('confirm');
  });
});

describe('gate.decide — non-write ceilings', () => {
  it("action 'ignore' ⇒ ignore (nothing to gate), even with an ambiguity present", () => {
    expect(decide(goodSignals, 'ignore', enabledConfig, ['missing_radius'])).toBe('ignore');
  });

  it("'propose' / 'retain_as_candidate' can never auto_write (not write actions)", () => {
    expect(isWriteAction('propose')).toBe(false);
    expect(isWriteAction('retain_as_candidate')).toBe(false);
    expect(decide(goodSignals, 'propose', enabledConfig, NO_AMBIGUITY)).toBe('confirm');
    expect(decide(goodSignals, 'retain_as_candidate', enabledConfig, NO_AMBIGUITY)).toBe('confirm');
  });

  it('a write action with NO configured assurance floor fails closed ⇒ confirm', () => {
    const noFloor: GateConfig = { ...enabledConfig, min_action_assurance: {} };
    expect(decide(goodSignals, 'write_soft', noFloor, NO_AMBIGUITY)).toBe('confirm');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Part 2 — the orchestrator: a run that produces a PROPOSAL and NEVER a client write.
// ════════════════════════════════════════════════════════════════════════════

// A resolvable synthetic district.
const DISTRICT: DistrictCandidate = {
  id: 'd-mahdiyah', name_ar: 'المهدية', name_en: 'Al Mahdiyah', aliases: [],
  city_id: 'الرياض', city_name_ar: 'الرياض', city_name_en: 'Riyadh',
  region_name_ar: 'منطقة الرياض', region_name_en: 'Riyadh Region', country_code: 'SA',
  centroid_lat: 24.63, centroid_lng: 46.55,
};

function fakeResolverDb(): ResolverDb {
  return {
    async findDistricts() { return [DISTRICT]; }, // single exact candidate ⇒ resolves
    async findCities() { return []; },
    async findElements() { return []; },
    async zoneDistricts() { return []; },
    async districtForPoint() { return null; },
  };
}

// A permissive universe: one cell, positive inventory. Satisfiability is part of
// the pipeline output but does not gate the decision.
const universe: SatUniverse = {
  universe: ['c1'],
  cellsOf() { return ['c1']; },
  inventoryIn() { return 5; },
};

function anchor(type: AnchorType, token: string): AnchorToken {
  return { anchor_type: type, span: token, normalized_token: token };
}

// One active buyer preference for حي المهدية.
function activeEvidence(): Evidence {
  return {
    id: 'ev1',
    mention_span: 'أبغى في المهدية',
    anchors: [anchor('district', 'المهدية')],
    speaker: 'client',
    preference_holder: 'client',
    holder_role: 'buyer',
    quoted_speaker: 'none',
    dialogue_act: 'statement',
    conditionality: 'asserted',
    temporal_reference: 'present',
    preference_applicability: 'active',
    preference_role: 'positive',
    commitment: 'preferred',
    hardness_evidence: 'none',
    modality: 'explicit',
    source: { channel: 'chat', ref: 'ev1-msg', timestamp: '2026-09-03T00:00:00Z' },
  };
}

// A ProposalStore fake that records every write; plus a client-record writer spy
// that the orchestrator has NO port to reach — if it is ever called, the design
// broke. The orchestrator type accepts only { proposals }, so this is belt+braces.
function makePorts() {
  const created: ProposalRecord[] = [];
  const clientRecordWrite = vi.fn(); // MUST stay untouched
  const proposals: ProposalStore = {
    async createProposal(input) {
      const row: ProposalRecord = { ...input, id: `prop-${created.length + 1}`, status: 'pending' };
      created.push(row);
      return row;
    },
  };
  const ports: OrchestratorPorts = { proposals };
  return { ports, created, clientRecordWrite };
}

function baseCtx(over: Partial<RunContext> = {}): RunContext {
  return {
    client_id: 'client-123',
    checkpoint_id: 'chk-1',
    maximum_safe_action: 'write_soft',
    resolution: { db: fakeResolverDb(), preferCountry: 'SA', established_city: 'الرياض' },
    universe,
    config: disabledConfig, // review-first default: auto_write OFF
    ...over,
  };
}

describe('orchestrator.runReviewFirst — produces a pending proposal, never a client write', () => {
  it('review-first default ⇒ confirm, and writes exactly ONE pending proposal', async () => {
    const { ports, created, clientRecordWrite } = makePorts();
    const res = await runReviewFirst([activeEvidence()], [], baseCtx(), ports);

    // The decision routes to the customer (auto_write is off by default).
    expect(res.decision).toBe('confirm');

    // Exactly one proposal, pending, carrying the compiled expression + signals.
    expect(created).toHaveLength(1);
    expect(res.proposal).not.toBeNull();
    expect(res.proposal!.status).toBe('pending');
    expect(res.proposal!.proposed_action).toBe('confirm');
    expect(res.proposal!.client_id).toBe('client-123');
    expect(res.proposal!.checkpoint_id).toBe('chk-1');
    expect(res.proposal!.proposed_expression).toBe(res.compiled);
    expect(res.proposal!.gate_signals).toBe(res.signals);

    // The anchor resolved, so the pipeline saw a satisfiable, unambiguous run.
    expect(res.resolutions).toHaveLength(1);
    expect(res.resolutions[0]!.status).toBe('resolved');
    expect(res.ambiguity).toEqual([]);
    expect(res.satisfiability).toBe('spatially_narrow'); // single cell

    // THE core safety invariant: no client-record write ever happened.
    expect(clientRecordWrite).not.toHaveBeenCalled();
  });

  it('even an auto_write decision routes through a pending proposal, not a client write', async () => {
    const { ports, created, clientRecordWrite } = makePorts();
    // Force the (currently disabled-by-default) auto_write path ON and inject
    // passing signals so the gate would say auto_write.
    const res = await runReviewFirst([activeEvidence()], [], baseCtx({
      config: enabledConfig,
      maximum_safe_action: 'write_soft',
      signals: { source_quality: 1, geo_resolution_margin: 1, lexical_candidate_quality: 1, context_consistency: 1, contradiction_signal: 1 },
    }), ports);

    expect(res.decision).toBe('auto_write');
    // Still: the ONLY side effect is a pending proposal (proposed_action = the write action).
    expect(created).toHaveLength(1);
    expect(res.proposal!.status).toBe('pending');
    expect(res.proposal!.proposed_action).toBe('write_soft');
    expect(clientRecordWrite).not.toHaveBeenCalled();
  });

  it("an 'ignore' ceiling writes no proposal at all (zero side effects)", async () => {
    const { ports, created, clientRecordWrite } = makePorts();
    const res = await runReviewFirst([activeEvidence()], [], baseCtx({ maximum_safe_action: 'ignore' }), ports);
    expect(res.decision).toBe('ignore');
    expect(res.proposal).toBeNull();
    expect(created).toHaveLength(0);
    expect(clientRecordWrite).not.toHaveBeenCalled();
  });
});
