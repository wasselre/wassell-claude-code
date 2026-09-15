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
  GeoClause,
  GeometryRecipe,
  ResolutionResult,
  SatisfiabilityFlag,
} from './ontology.js';

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
  /** The evidence rows (persisted ids) this proposal was compiled from. */
  source_evidence_ids?: string[];
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

  // 2. Compile adjudicated evidence + relations into a Boolean expression, then
  //    overwrite each mention's STUB recipe (names, geo_data_version='stub') with
  //    the resolver's REAL recipe (district / element ids) wherever every anchor
  //    of that mention resolved. Until 2026-09-13 the resolver's output only fed
  //    the gate signals and the stored expression carried names — so nothing was
  //    ever actually "selected on the map".
  const compileResult = compile(evidence, relations);
  const merged = mergeResolutionsIntoPreference(compileResult.preference, evidence, resolutions);
  const compiled = merged.preference;
  obs.event({
    stage: 'resolution', outcome: 'ok', ...meta, result: 'merged',
    detail: { resolved_mentions: merged.resolved_evidence, unresolved_mentions: merged.unresolved_evidence },
  });

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
          source_evidence_ids: evidence.map((e) => e.id),
        }),
    );
  } else {
    obs.event({ stage: 'review_outcome', outcome: 'ok', ...meta, result: 'ignore' });
  }

  return { decision, proposal, signals, ambiguity, compiled, satisfiability, resolutions };
}

// ────────────────────────────────────────────────────────────────────────────
// Resolution → compiled expression. PURE.
// ────────────────────────────────────────────────────────────────────────────

/** Operations whose geometry is a union of admin polygons (mergeable into one district_union). */
const ADMIN_UNION_OPS = new Set<string>(['district_polygon', 'district_union', 'zone_union', 'pin_containing_district']);

export interface MergedPreference {
  preference: GeoPreference;
  /** Mentions whose stub recipe was replaced by resolver output. */
  resolved_evidence: number;
  /** Mentions left as stubs (some anchor needs_confirm / unresolvable). */
  unresolved_evidence: number;
}

/**
 * Overwrite the compiler's per-mention stub recipes with the resolver's recipes.
 * `resolutions` is in evidence × anchor order (exactly how runReviewFirst
 * produced it). A mention is replaced only when EVERY anchor resolved — a
 * partial result is never mixed (ids beside names) so consumers can trust that
 * `geo_data_version !== 'stub'` means "real ids". Never mutates its inputs.
 */
export function mergeResolutionsIntoPreference(
  pref: GeoPreference,
  evidence: Evidence[],
  resolutions: ResolutionResult[],
): MergedPreference {
  const perEvidence = new Map<string, ResolutionResult[]>();
  let cursor = 0;
  for (const e of evidence) {
    perEvidence.set(e.id, resolutions.slice(cursor, cursor + e.anchors.length));
    cursor += e.anchors.length;
  }
  const evById = new Map(evidence.map((e) => [e.id, e] as const));

  const out = JSON.parse(JSON.stringify(pref)) as GeoPreference;
  let resolved = 0;
  let unresolved = 0;
  for (const group of out.groups ?? []) {
    const added: GeoClause[] = [];
    for (const clause of group.clauses ?? []) {
      for (const ref of clause.anyOf ?? []) {
        const eid = typeof ref.geometry_id === 'string' && ref.geometry_id.startsWith('geo:') ? ref.geometry_id.slice(4) : '';
        const ev = eid ? evById.get(eid) : undefined;
        const rs = eid ? perEvidence.get(eid) : undefined;
        if (!ev || !rs || rs.length === 0) continue;
        const allResolved = rs.every((r) => r.status === 'resolved' && r.recipe);
        if (!allResolved) { unresolved += 1; continue; }
        const recipes = rs.map((r) => r.recipe!);
        const adminIdx = recipes.map((r, i) => (ADMIN_UNION_OPS.has(r.operation) ? i : -1)).filter((i) => i >= 0);
        const bandIdx = recipes.map((r, i) => (ADMIN_UNION_OPS.has(r.operation) ? -1 : i)).filter((i) => i >= 0);
        if (recipes.length === 1) {
          ref.recipe = { ...recipes[0]!, source_anchors: ev.anchors };
        } else if (bandIdx.length === 0) {
          // Several admin places in one mention («المهدية أو الجبيلة») → one union.
          const ids = Array.from(new Set(recipes.flatMap((r) => r.resolved_element_ids)));
          ref.recipe = { ...recipes[0]!, operation: 'district_union', source_anchors: ev.anchors, resolved_element_ids: ids };
        } else if (adminIdx.length === 0) {
          // Several element geometries → keep the first (corridor/band already carries its roads).
          ref.recipe = { ...recipes[bandIdx[0]!]!, source_anchors: ev.anchors };
        } else {
          // MIXED — «العليا (غرب الملك فهد)»: a district AND a side of a road. That
          // is an intersection, so the mention becomes TWO clauses of the group
          // (AND): this ref keeps the band, and an extra include clause carries
          // the district(s). Never merge a district id into a band's road list.
          const band = recipes[bandIdx[0]!]!;
          const adminIds = Array.from(new Set(adminIdx.flatMap((i) => recipes[i]!.resolved_element_ids)));
          const adminRecipe: GeometryRecipe = {
            ...recipes[adminIdx[0]!]!,
            operation: adminIds.length > 1 ? 'district_union' : recipes[adminIdx[0]!]!.operation,
            source_anchors: adminIdx.map((i) => ev.anchors[i]!),
            resolved_element_ids: adminIds,
          };
          ref.recipe = { ...band, source_anchors: bandIdx.map((i) => ev.anchors[i]!) };
          if (clause.op === 'include') {
            added.push({ op: 'include', anyOf: [{ geometry_id: `${ref.geometry_id}:admin`, recipe: adminRecipe }] });
          }
          // An EXCLUDE of «district ∧ band» cannot be split into two excludes
          // (that over-excludes the whole district); the band alone is kept.
        }
        resolved += 1;
      }
    }
    if (added.length) group.clauses.push(...added);
  }
  return { preference: out, resolved_evidence: resolved, unresolved_evidence: unresolved };
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
