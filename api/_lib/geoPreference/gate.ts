/**
 * Deterministic confidence gate (v2 §5 / v4 A7) — the FINAL arbiter between an
 * interpreted+resolved+compiled preference and what the ability is allowed to do
 * with it. It is PURE and side-effect-free: it reads {@link GateSignals}, the
 * per-checkpoint {@link MaximumSafeAction} ceiling, the tunable {@link GateConfig}
 * thresholds, and the deterministic {@link AmbiguityCondition} list, and returns a
 * single {@link GateDecision}. It writes to nothing.
 *
 * The load-bearing rules (from the task spec + ontology.ts):
 *
 *  1. `interpretation_confidence` is VETO-ONLY. A low model confidence forces
 *     `human_review` and NEVER contributes to promoting a decision to
 *     `auto_write`. (The whole design principle: AI interprets meaning, but its
 *     self-reported confidence can only hold the system back, never push it
 *     forward — semantics + deterministic margins do the promoting.)
 *
 *  2. `auto_write` requires ALL of:
 *       - config.auto_write_enabled === true                (master switch)
 *       - the action is itself a WRITE action               (write_soft|write_hard|supersede)
 *       - lexical_candidate_quality ≥ t_lexical_margin
 *       - geo_resolution_margin   ≥ t_geo_margin
 *       - source_quality          ≥ t_source_quality
 *       - context_consistency     ≥ min_action_assurance[action]   (action-sensitive)
 *       - contradiction_signal is clear (≥ CONTRADICTION_CLEAR_FLOOR)
 *       - ambiguity is empty
 *     Action-sensitivity: `min_action_assurance` orders supersede > write_hard >
 *     write_soft, so a stronger, harder-to-undo action needs a higher assurance
 *     (context_consistency) bar. `context_consistency` is the ONE signal the three
 *     fixed-threshold checks don't consume, so it is the natural action-sensitive
 *     assurance measure.
 *
 *  3. Any ambiguity condition ⇒ `confirm` (route to the customer). Ambiguity is a
 *     deterministic list produced upstream (unresolved reference, multiple
 *     plausible entities, missing radius, …) — never a model score.
 *
 *  4. With `auto_write_enabled === false` (the review-first default) the gate can
 *     NEVER return `auto_write` — only `confirm` / `human_review` / `ignore`.
 *
 * Nothing here — and nothing downstream of a `confirm`/`auto_write` decision —
 * writes to a client record directly. `auto_write` still routes through a pending
 * proposal → apply step (see orchestrator.ts). The gate only NAMES the action.
 */

import type {
  GateSignals,
  GateDecision,
  MaximumSafeAction,
  AmbiguityCondition,
} from './ontology';

/** The tunable thresholds — mirrors the `geo_pref_gate_config` row (1:1). */
export interface GateConfig {
  /** MASTER switch. False (the default) ⇒ auto_write is unreachable. */
  auto_write_enabled: boolean;
  t_lexical_margin: number;
  t_geo_margin: number;
  t_source_quality: number;
  /** Action-sensitive assurance floors, keyed by write action. */
  min_action_assurance: Partial<Record<WriteAction, number>>;
}

/** The subset of {@link MaximumSafeAction} that actually writes a preference. */
export type WriteAction = 'write_soft' | 'write_hard' | 'supersede';

const WRITE_ACTIONS: ReadonlySet<string> = new Set<WriteAction>([
  'write_soft',
  'write_hard',
  'supersede',
]);

export function isWriteAction(action: MaximumSafeAction): action is WriteAction {
  return WRITE_ACTIONS.has(action);
}

/**
 * Interpretation-confidence VETO floor. Below this the model's own read of the
 * utterance is too weak to act on unattended → escalate to a human. There is no
 * config column for this yet, so it lives here as a conservative code constant;
 * it is a floor (veto), never a promoter. Exported so tests pin it explicitly.
 */
export const INTERPRETATION_VETO_FLOOR = 0.5;

/**
 * `contradiction_signal` at/above this is "clear" (no unresolved contradiction).
 * Conservative (matches the review-first config defaults). Exported for tests.
 */
export const CONTRADICTION_CLEAR_FLOOR = 0.9;

/**
 * The deterministic gate. Pure — no I/O, no client write, no throw.
 *
 * Precedence (most severe first):
 *   ignore ceiling → interpretation veto → ambiguity → auto_write attempt → confirm
 */
export function decide(
  signals: GateSignals,
  action: MaximumSafeAction,
  config: GateConfig,
  ambiguity: AmbiguityCondition[],
): GateDecision {
  // 0. Nothing a perfect system could do here ⇒ nothing to gate.
  if (action === 'ignore') return 'ignore';

  // 1. Interpretation confidence is VETO-ONLY: low ⇒ human_review. This can only
  //    hold the system back; it never appears in the auto_write predicate below.
  if (signals.interpretation_confidence < INTERPRETATION_VETO_FLOOR) {
    return 'human_review';
  }

  // 2. Any deterministic ambiguity ⇒ ask the customer.
  if (ambiguity.length > 0) return 'confirm';

  // 3. Attempt auto_write — ALL conditions must hold. `auto_write_enabled === false`
  //    short-circuits here, so the review-first default can never auto_write.
  if (canAutoWrite(signals, action, config)) return 'auto_write';

  // 4. Actionable but not auto-writable ⇒ create a pending proposal for review.
  return 'confirm';
}

/**
 * The full auto_write predicate. Returns true ONLY when every condition in rule 2
 * of the module doc holds. `interpretation_confidence` is deliberately absent —
 * it is veto-only and must never promote.
 */
export function canAutoWrite(
  signals: GateSignals,
  action: MaximumSafeAction,
  config: GateConfig,
): boolean {
  if (!config.auto_write_enabled) return false;
  // auto_write only makes sense for a write action; retain_as_candidate / propose
  // are not writes, and min_action_assurance has no floor for them.
  if (!isWriteAction(action)) return false;

  // A missing floor for a write action fails CLOSED (Infinity), never open.
  const assuranceFloor = config.min_action_assurance[action] ?? Number.POSITIVE_INFINITY;

  return (
    signals.lexical_candidate_quality >= config.t_lexical_margin &&
    signals.geo_resolution_margin >= config.t_geo_margin &&
    signals.source_quality >= config.t_source_quality &&
    signals.context_consistency >= assuranceFloor &&
    signals.contradiction_signal >= CONTRADICTION_CLEAR_FLOOR
  );
}
