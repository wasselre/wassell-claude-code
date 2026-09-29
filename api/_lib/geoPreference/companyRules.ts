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
 *
 * RULE 2 — a place only the SALESPERSON said is never the customer's
 * preference (found live 2026-09-27: the rep offered «فيه فلل بالصحافة
 * والنرجس» as the chat's last message, the customer never answered, and the
 * card drew both districts as «يريد»; the verifier flagged it). The extractor
 * is told not to emit agent-only places, and to attribute an accepted
 * suggestion to the customer's own reply — but when it still emits one with
 * `speaker='agent'`, nothing downstream checked the speaker. Such a mention is
 * demoted to `preference_role='none'`: kept for the record, never on the map.
 *
 * RULE 3 (CALLS ONLY — the call audit, 2026-09-29) — on a call, a place is the
 * customer's only if the customer's OWN turns contain it. The extractor sets
 * `speaker` per mention from MODEL output, so a salesperson's «عندنا مشروع في
 * النرجس» can come back labelled 'client' — exactly how the preference quotes
 * went wrong (3 of 14 quoted the salesperson). {@link applyCallSpeakerGuard}
 * demotes any non-agent mention whose `mention_span` (folded like the
 * preference quotes, `normalizeForQuote`) is not in a `speaker==='client'` turn
 * to `preference_role='none'`. Deterministic, applied BEFORE rules 1–2 (so a
 * demoted mention can never be promoted by RULE 1), in BOTH extract and
 * review-only runs (chatCard.ts `evidenceForReview`). Chats are untouched:
 * their turns are labelled by the message direction, not by a model.
 */
import type { Evidence } from './ontology.js';
import type { Conversation } from './extractor.js';
import { customerSaidIt } from '../clientPrefs/quoteMatch.js';

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

/** True when RULE 2 demotes this mention: only the salesperson said it. */
export function isAgentOnlyMention(e: Evidence): boolean {
  return e.speaker === 'agent' && (e.preference_role === 'positive' || e.preference_role === 'negative');
}

/**
 * True when RULE 3 demotes this mention on a CALL: not the salesperson's (the
 * model said client / unknown), it could draw (role is not already 'none'), and
 * its words are nowhere in the customer's own turns.
 */
export function isNotCustomersOnCall(e: Evidence, conversation: Conversation): boolean {
  if (conversation.channel !== 'call') return false;
  if (e.speaker === 'agent' || e.preference_role === 'none') return false;
  return !customerSaidIt(conversation, e.mention_span || null);
}

/**
 * RULE 3 — the call speaker guard. For a CALL conversation, returns NEW objects
 * for the demoted mentions (`preference_role='none'`); any other channel gets
 * an unchanged copy (same mention objects). Never mutates.
 */
export function applyCallSpeakerGuard(evidence: readonly Evidence[], conversation: Conversation): Evidence[] {
  if (conversation.channel !== 'call') return [...evidence];
  return evidence.map((e) => (isNotCustomersOnCall(e, conversation) ? { ...e, preference_role: 'none' } : e));
}

/** Apply every company rule. Returns NEW objects for changed mentions; never mutates. */
export function applyCompanyRules(evidence: readonly Evidence[]): Evidence[] {
  return evidence.map((e) => {
    if (isAgentOnlyMention(e)) return { ...e, preference_role: 'none' };
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
