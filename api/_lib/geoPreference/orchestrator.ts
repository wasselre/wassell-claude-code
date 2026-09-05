/**
 * Review-first pipeline orchestrator (v2 / v7).
 *
 * Wires the four deterministic halves of the Geography Understanding Ability into
 * one run and produces EXACTLY ONE side effect: a `pending` row in
 * `geo_pref_proposals`. It NEVER writes to a client record. Even the (currently
 * unreachable) `auto_write` decision is materialised as a pending proposal, so the
 * only path to a client's active preferences is proposal → human confirm → apply,
 * which lives entirely outside this module.
 *
 * The run:
 *   1. resolve each anchor across all evidence            (resolver.resolveAnchor)
 *   2. compile the evidence + relations into a GeoPreference (compiler.compile)
 *   3. classify the compiled expression's satisfiability   (satisfiability.classify)
 *   4. build deterministic GateSignals + AmbiguityConditions from 1–3 + evidence
 *   5. decide()                                            (gate.decide)
 *   6. write ONE pending proposal through the injected ProposalStore port
 *
 * DB access is entirely behind the injected `OrchestratorPorts` — the resolver's
 * own `ResolverDb` (via the resolution context) and the `ProposalStore`. There is
 * NO port through which this module could touch a client record; that is a
 * structural guarantee, not just a convention (see orchestrator.test.ts).
 */

import { resolveAnchor, type ResolutionContext } from './resolver.js';
import { compile } from './compiler.js';
import { classify, type SatUniverse } from './satisfiability.js';
import { decide, type GateConfig } from './gate.js';
import { geoObserver, type GeoObserver } from './observability.js';
import type {
  Evidence,
  EvidenceRelation,
  GateSignals,
  GateDecision,
  MaximumSafeAction,
  AmbiguityCondition,
  GeoPreference,
  ResolutionResult,
  SatisfiabilityFlag,
} from './ontology';

// ────────────────────────────────────────────────────────────────────────────
// Ports — the ONLY surfaces the orchestrator can write through. There is no
// client-record writer here BY DESIGN.
// ────────────────────────────────────────────────────────────────────────────

/** A pending proposal row — mirrors `geo_pref_proposals` (status is always pending here). */
export interface ProposalInput {
  client_id: string;
  checkpoint_id: string | null;
  proposed_action: ProposalAction;
  proposed_expression: GeoPreference;
  gate_signals: GateSignals;
}

export interface ProposalRecord extends ProposalInput {
  id: string;
  status: 'pending';
}

/** The `proposed_action` enum on `geo_pref_proposals` (no 'ignore'/'auto_write'). */
export type ProposalAction =
  | 'write_soft'
  | 'write_hard'
  | 'supersede'
  | 'confirm'
  | 'human_review';

export interface ProposalStore {
  /** Insert a `status='pending'` proposal and return the stored row. */
  createProposal(input: ProposalInput): Promise<ProposalRecord>;
}

export interface OrchestratorPorts {
  proposals: ProposalStore;
}

// ────────────────────────────────────────────────────────────────────────────
// Run context — everything the pure stages need, all injected.
// ────────────────────────────────────────────────────────────────────────────
export interface RunContext {
  client_id: string;
  checkpoint_id?: string | null;
  /** The per-checkpoint ceiling of what a perfect system could do (v6 #5). */
  maximum_safe_action: MaximumSafeAction;
  /** Resolution context shared across every anchor in this turn. */
  resolution: ResolutionContext;
  /** Bounded universe + inventory for the satisfiability pass. */
  universe: SatUniverse;
  /** The tunable gate thresholds (typically the geo_pref_gate_config row). */
  config: GateConfig;
  /**
   * Signal overrides. Some GateSignals cannot be derived from geometry alone
   * (notably source_quality — a property of the channel/source, not the map);
   * inject those here. Any provided field overrides the derived value.
   */
  signals?: Partial<GateSignals>;
  /** Extra deterministic ambiguity conditions detected upstream (merged in). */
  ambiguity?: AmbiguityCondition[];
  /**
   * Structured-event observer for stage boundaries. Defaults to the process-wide
   * `geoObserver` (console sink, silent under Vitest). Inject a capturing observer
   * in tests, or `nullObserver` to silence entirely.
   */
  observer?: GeoObserver;
}

export interface ReviewFirstResult {
  decision: GateDecision;
  /** The pending proposal, or null when the decision is 'ignore' (no side effect). */
  proposal: ProposalRecord | null;
  signals: GateSignals;
  ambiguity: AmbiguityCondition[];
  compiled: GeoPreference;
  satisfiability: SatisfiabilityFlag;
  resolutions: ResolutionResult[];
}

/**
 * Run the review-first pipeline for one checkpoint's evidence. The SOLE side
 * effect is `ports.proposals.createProposal` (skipped only for an 'ignore'
 * decision). Never writes a client record; never throws out of the pure stages.
 */
export async function runReviewFirst(
  evidence: Evidence[],
  relations: EvidenceRelation[],
  ctx: RunContext,
  ports: OrchestratorPorts,
): Promise<ReviewFirstResult> {
  const obs = ctx.observer ?? geoObserver;
  const meta = { client_id: ctx.client_id, checkpoint_id: ctx.checkpoint_id ?? null };

  // 1. Resolve every anchor across every mention against the map. (timed stage)
  const anchorCount = evidence.reduce((n, e) => n + e.anchors.length, 0);
  const resolutions: ResolutionResult[] = await obs.time(
    'resolution',
    { ...meta, detail: { anchors: anchorCount, mentions: evidence.length } },
    async () => {
      const out: ResolutionResult[] = [];
      for (const e of evidence) {
        for (const anchor of e.anchors) {
          out.push(await resolveAnchor(anchor, ctx.resolution));
        }
      }
      return out;
    },
  );

  // 2. Compile adjudicated evidence + relations into a Boolean expression.
  const compileResult = compile(evidence, relations);
  const compiled = compileResult.preference;

  // 3. Static satisfiability of the compiled expression against the universe.
  const satisfiability = classify(compiled, ctx.universe);

  // 4. Deterministic signals + ambiguity from the above (+ injected overrides).
  const ambiguity = buildAmbiguity(resolutions, compileResult.needs_confirm, ctx.ambiguity);
  const signals = buildGateSignals(evidence, resolutions, compileResult.needs_confirm, ctx.signals);

  // 5. The deterministic gate names the action.
  const decision = decide(signals, ctx.maximum_safe_action, ctx.config, ambiguity);
  obs.event({
    stage: 'gating',
    outcome: 'ok',
    ...meta,
    result: decision,
    detail: { ambiguity: ambiguity.length, satisfiability, max_safe_action: ctx.maximum_safe_action },
  });

  // 6. Materialise the decision as ONE pending proposal (the only side effect).
  //    'ignore' has no side effect — nothing to propose. Timed so a failing
  //    proposal write is recorded loudly (and still propagates — time() re-throws).
  let proposal: ProposalRecord | null = null;
  if (decision !== 'ignore') {
    const action = toProposalAction(decision, ctx.maximum_safe_action);
    proposal = await obs.time(
      'review_outcome',
      { ...meta, result: action, detail: { decision } },
      () =>
        ports.proposals.createProposal({
          client_id: ctx.client_id,
          checkpoint_id: ctx.checkpoint_id ?? null,
          proposed_action: action,
          proposed_expression: compiled,
          gate_signals: signals,
        }),
    );
  } else {
    obs.event({ stage: 'review_outcome', outcome: 'ok', ...meta, result: 'ignore' });
  }

  return { decision, proposal, signals, ambiguity, compiled, satisfiability, resolutions };
}

// ────────────────────────────────────────────────────────────────────────────
// Deterministic derivations.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Map a gate decision to the proposals table's `proposed_action`. An `auto_write`
 * decision is recorded as its underlying WRITE action (write_soft/write_hard/
 * supersede) with status 'pending' — it still routes through proposal → apply,
 * never a direct client write.
 */
export function toProposalAction(
  decision: GateDecision,
  action: MaximumSafeAction,
): ProposalAction {
  if (decision === 'auto_write') {
    // The gate only returns auto_write for a write action (see gate.canAutoWrite),
    // so this narrowing always succeeds; fall back to human_review defensively.
    if (action === 'write_soft' || action === 'write_hard' || action === 'supersede') {
      return action;
    }
    return 'human_review';
  }
  if (decision === 'human_review') return 'human_review';
  // 'confirm' (and any residual) ⇒ customer confirmation.
  return 'confirm';
}

/** Resolver reason → deterministic ambiguity condition. */
function ambiguityForReason(reason: string | undefined): AmbiguityCondition {
  switch (reason) {
    case 'ambiguous_entity':
      return 'multiple_plausible_entities';
    case 'missing_radius':
      return 'missing_radius';
    default:
      // outside_admin, corridor_underspecified, pin_scope_unclear, tie, … all mean
      // "we could not pin the reference down" → confirm with the customer.
      return 'unresolved_reference';
  }
}

/**
 * Build the deterministic ambiguity list: any anchor that did not resolve cleanly
 * contributes a condition, a structurally-uncertain compile adds
 * `contradiction_without_replacement`, and any caller-supplied conditions merge
 * in. De-duplicated, order-stable.
 */
export function buildAmbiguity(
  resolutions: ResolutionResult[],
  compileNeedsConfirm: boolean,
  extra: AmbiguityCondition[] = [],
): AmbiguityCondition[] {
  const out: AmbiguityCondition[] = [];
  const seen = new Set<AmbiguityCondition>();
  const add = (c: AmbiguityCondition) => {
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  };
  for (const r of resolutions) {
    if (r.status !== 'resolved') add(ambiguityForReason(r.reason));
  }
  if (compileNeedsConfirm) add('contradiction_without_replacement');
  for (const c of extra) add(c);
  return out;
}

/**
 * Derive GateSignals from resolution outcomes + compile result + evidence, with
 * caller overrides applied last. The recipe is deterministic:
 *  - interpretation_confidence: min over model-emitted evidence confidences
 *    (absent ⇒ 1; e.g. gold-derived evidence never carries a model confidence).
 *  - lexical_candidate_quality / geo_resolution_margin: any unresolved anchor
 *    zeroes both (nothing is safely writable); otherwise geo margin is the min
 *    candidate margin and lexical quality is 1 (the resolver's exact-match gate
 *    guarantees the selected place was an exact official/alias hit).
 *  - context_consistency: 1 when everything resolved, else 0.
 *  - contradiction_signal: 0 when the compile flagged needs_confirm, else 1.
 *  - source_quality: defaults to 1 (a channel property — inject to override).
 */
export function buildGateSignals(
  evidence: Evidence[],
  resolutions: ResolutionResult[],
  compileNeedsConfirm: boolean,
  overrides: Partial<GateSignals> = {},
): GateSignals {
  const anyUnresolved = resolutions.some((r) => r.status !== 'resolved');
  const margins = resolutions
    .filter((r) => r.status === 'resolved')
    .map((r) => (typeof r.candidate_margin === 'number' ? r.candidate_margin : 1));

  const confs = evidence
    .map((e) => e.interpretation_confidence)
    .filter((c): c is number => typeof c === 'number');

  const derived: GateSignals = {
    interpretation_confidence: confs.length ? Math.min(...confs) : 1,
    lexical_candidate_quality: anyUnresolved ? 0 : 1,
    geo_resolution_margin: anyUnresolved ? 0 : margins.length ? Math.min(...margins) : 0,
    context_consistency: anyUnresolved ? 0 : 1,
    contradiction_signal: compileNeedsConfirm ? 0 : 1,
    source_quality: 1,
  };

  return { ...derived, ...overrides };
}
