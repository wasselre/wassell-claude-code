import { describe, it, expect } from 'vitest';
import { applyCompanyRules, isQuestionAsInterest, isAgentOnlyMention } from '../companyRules.js';
import { isActivePreference, type Evidence } from '../ontology.js';

/** RULE 1 — a customer's question about a place is interest (operator, 2026-09-27). */
const ev = (over: Partial<Evidence>): Evidence => ({
  id: 'e1',
  mention_span: 'فيه الازدهار موجود؟',
  anchors: [{ anchor_type: 'district', span: 'الازدهار', normalized_token: 'الازدهار' }],
  speaker: 'client', preference_holder: 'client', holder_role: 'buyer', quoted_speaker: 'none',
  dialogue_act: 'question', conditionality: 'asserted', temporal_reference: 'none_explicit',
  preference_applicability: 'exploratory', preference_role: 'exploratory', commitment: 'considered',
  hardness_evidence: 'none', modality: 'explicit',
  source: { channel: 'chat', ref: 'm1', timestamp: '' },
  ...over,
});

describe('applyCompanyRules — a customer question is interest', () => {
  it('promotes a client question read as exploratory to a SOFT active positive the map draws', () => {
    const before = ev({});
    expect(isActivePreference(before)).toBe(false);
    const [after] = applyCompanyRules([before]);
    expect(after!.preference_role).toBe('positive');
    expect(after!.preference_applicability).toBe('active');
    expect(after!.commitment).toBe('acceptable');
    expect(after!.modality).toBe('inferred');
    expect(isActivePreference(after!)).toBe(true);
  });
  it('keeps a stronger commitment the model already gave', () => {
    const [after] = applyCompanyRules([ev({ commitment: 'preferred' })]);
    expect(after!.commitment).toBe('preferred');
  });
  it('never touches the agent, a statement, a refusal, a counterfactual, or a third party', () => {
    for (const over of [
      { speaker: 'agent' as const },
      { dialogue_act: 'statement' as const },
      { preference_role: 'negative' as const },
      { preference_role: 'none' as const },
      { preference_applicability: 'counterfactual' as const },
      { holder_role: 'unrelated_third_party' as const },
    ]) {
      const e = ev(over);
      expect(isQuestionAsInterest(e)).toBe(false);
      expect(applyCompanyRules([e])[0]).toBe(e);
    }
  });
  it('does not mutate its input', () => {
    const e = ev({});
    applyCompanyRules([e]);
    expect(e.preference_role).toBe('exploratory');
  });
});

describe("applyCompanyRules — a place only the salesperson said is never the customer's", () => {
  it('«فيه فلل بالصحافة والنرجس» from the rep, unanswered → off the map', () => {
    const rep = ev({ mention_span: 'الصحافة والنرجس', speaker: 'agent', dialogue_act: 'answer', preference_role: 'positive', preference_applicability: 'active', commitment: 'acceptable' });
    expect(isActivePreference(rep)).toBe(true); // before: it WOULD have been drawn
    const [after] = applyCompanyRules([rep]);
    expect(isAgentOnlyMention(rep)).toBe(true);
    expect(after!.preference_role).toBe('none');
    expect(isActivePreference(after!)).toBe(false);
  });
  it("the customer's own mention is untouched", () => {
    const own = ev({ speaker: 'client', dialogue_act: 'statement', preference_role: 'positive', preference_applicability: 'active', commitment: 'preferred' });
    expect(applyCompanyRules([own])[0]).toBe(own);
  });
});
