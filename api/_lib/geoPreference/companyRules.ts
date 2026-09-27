/**
 * Company rules applied to extracted evidence BEFORE it is compiled into a map.
 *
 * These are operator decisions, not model judgement, so they are deterministic
 * and live in code rather than in a prompt the model may or may not follow.
 * The stored evidence rows are never modified — the rules shape the proposal
 * only, so a rule change takes effect on a re-review without re-extraction.
 *
 * RULE 1 — a customer's QUESTION about a place is interest (operator,
 * 2026-09-27: "yes question is interest"). The extractor tends to label
 * «فيه الازدهار موجود؟», «حي الفاروق؟», «اللي في النرجس كم سعرها؟» as
 * `preference_role='exploratory'`, and the compiler only draws `positive` /
 * `negative` mentions — so on calib-002, 18 customer questions never reached
 * the map. A client-spoken question with an exploratory reading is promoted to
 * a SOFT positive: `preference_role='positive'`, `preference_applicability=
 * 'active'`, `commitment` at least 'acceptable', `modality='inferred'` (so the
 * promotion stays visible). It never touches:
 *   • anything the agent said (a rep's suggestion is not the customer's interest),
 *   • a mention already read as positive or negative (a later explicit refusal
 *     is extracted as its own negative mention and wins as an exclude),
 *   • a question that is not about the customer's own purchase (holder not a
 *     buyer / co-decision-maker / occupant),
 *   • counterfactual readings («لو كنت ساكن هناك…») — those are not interest.
 */
import type { Evidence } from './ontology.js';

const OWN_PURCHASE_ROLES: ReadonlySet<Evidence['holder_role']> = new Set(['buyer', 'co_decision_maker', 'beneficiary_occupant']);

/** True when RULE 1 promotes this mention (exported for tests and the grader). */
export function isQuestionAsInterest(e: Evidence): boolean {
  return (
    e.speaker === 'client' &&
    e.dialogue_act === 'question' &&
    e.preference_role === 'exploratory' &&
    e.preference_applicability !== 'counterfactual' &&
    OWN_PURCHASE_ROLES.has(e.holder_role)
  );
}

/** Apply every company rule. Returns NEW objects for changed mentions; never mutates. */
export function applyCompanyRules(evidence: readonly Evidence[]): Evidence[] {
  return evidence.map((e) => {
    if (!isQuestionAsInterest(e)) return e;
    return {
      ...e,
      preference_role: 'positive',
      preference_applicability: 'active',
      commitment: e.commitment === 'required' || e.commitment === 'preferred' ? e.commitment : 'acceptable',
      modality: 'inferred',
    };
  });
}
