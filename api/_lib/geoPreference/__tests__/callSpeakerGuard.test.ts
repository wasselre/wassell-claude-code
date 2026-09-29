import { describe, it, expect } from 'vitest';
import { applyCallSpeakerGuard, isNotCustomersOnCall, applyCompanyRules } from '../companyRules.js';
import { evidenceForReview } from '../chatCard.js';
import { isActivePreference, type Evidence } from '../ontology.js';
import type { Conversation } from '../extractor.js';

/**
 * RULE 3 — the call speaker guard (call audit, 2026-09-29). The extractor
 * labels `speaker` from MODEL output, so a salesperson's place can come back as
 * the customer's. On a CALL, a mention counts as the customer's only if the
 * customer's own turns contain its words.
 */

const call: Conversation = {
  channel: 'call', id: 'call-1', speaker_labels: 'hatif_role',
  turns: [
    { speaker: 'agent', text: 'السلام عليكم، معك سعد من وصل العقارية. عندنا مشروع في النرجس فلل جديدة.', ref: 'call-1' },
    { speaker: 'client', text: 'وعليكم السلام. والله أبي بالنرجس أو الياسمين، بس مو شرق الرياض.', ref: 'call-1' },
    { speaker: 'agent', text: 'طيب وش رايك بحي الملقا؟', ref: 'call-1' },
    { speaker: 'client', text: 'لا ما أبي الملقا.', ref: 'call-1' },
  ],
};

const chat: Conversation = { ...call, channel: 'chat', id: '966500000000@c.us', speaker_labels: undefined };

const ev = (over: Partial<Evidence>): Evidence => ({
  id: 'e1',
  mention_span: 'أبي بالنرجس أو الياسمين',
  anchors: [{ anchor_type: 'district', span: 'النرجس', normalized_token: 'النرجس' }],
  speaker: 'client', preference_holder: 'client', holder_role: 'buyer', quoted_speaker: 'none',
  dialogue_act: 'statement', conditionality: 'asserted', temporal_reference: 'present',
  preference_applicability: 'active', preference_role: 'positive', commitment: 'preferred',
  hardness_evidence: 'none', modality: 'explicit',
  source: { channel: 'call', ref: 'call-1', timestamp: '' },
  ...over,
});

describe('call speaker guard — a place the salesperson said never draws', () => {
  it('«عندنا مشروع في النرجس» (the salesperson) labelled client ⇒ role none, off the map', () => {
    const rep = ev({ id: 'rep', mention_span: 'عندنا مشروع في النرجس' });
    expect(isActivePreference(rep)).toBe(true); // before: it WOULD have been drawn
    expect(isNotCustomersOnCall(rep, call)).toBe(true);
    const [after] = applyCallSpeakerGuard([rep], call);
    expect(after!.preference_role).toBe('none');
    expect(isActivePreference(after!)).toBe(false);
  });

  it('«أبي بالنرجس أو الياسمين» (the customer) is kept exactly', () => {
    const own = ev({ id: 'own' });
    expect(isNotCustomersOnCall(own, call)).toBe(false);
    expect(applyCallSpeakerGuard([own], call)[0]).toBe(own);
  });

  it("a part of the customer's words, and a refusal in the customer's words, are kept", () => {
    const part = ev({ id: 'p', mention_span: 'الياسمين' });
    const no = ev({ id: 'n', mention_span: 'ما أبي الملقا', preference_role: 'negative' });
    expect(applyCallSpeakerGuard([part, no], call)).toEqual([part, no]);
  });

  it('an unknown-speaker mention in the salesperson\'s words is demoted too', () => {
    const unk = ev({ id: 'u', speaker: 'unknown', mention_span: 'وش رايك بحي الملقا' });
    expect(applyCallSpeakerGuard([unk], call)[0]!.preference_role).toBe('none');
  });

  it('a salesperson question mislabelled as the customer\'s cannot be promoted by RULE 1', () => {
    const q = ev({ id: 'q', mention_span: 'وش رايك بحي الملقا', dialogue_act: 'question', preference_role: 'exploratory', preference_applicability: 'exploratory' });
    // Without the guard RULE 1 would promote it to a positive.
    expect(applyCompanyRules([q])[0]!.preference_role).toBe('positive');
    expect(applyCompanyRules(applyCallSpeakerGuard([q], call))[0]!.preference_role).toBe('none');
  });

  it('agent-labelled and already-none mentions are left to RULE 2 / untouched', () => {
    const agent = ev({ id: 'a', speaker: 'agent', mention_span: 'عندنا مشروع في النرجس' });
    const none = ev({ id: 'z', mention_span: 'عندنا مشروع في النرجس', preference_role: 'none' });
    const out = applyCallSpeakerGuard([agent, none], call);
    expect(out[0]).toBe(agent);
    expect(out[1]).toBe(none);
    expect(applyCompanyRules(out)[0]!.preference_role).toBe('none'); // RULE 2
  });

  it('chats are unchanged — their speakers come from the message direction, not a model', () => {
    const rep = ev({ id: 'rep', mention_span: 'عندنا مشروع في النرجس', source: { channel: 'chat', ref: 'm1', timestamp: '' } });
    expect(isNotCustomersOnCall(rep, chat)).toBe(false);
    expect(applyCallSpeakerGuard([rep], chat)[0]).toBe(rep);
  });

  it('never mutates its input', () => {
    const rep = ev({ id: 'rep', mention_span: 'عندنا مشروع في النرجس' });
    applyCallSpeakerGuard([rep], call);
    expect(rep.preference_role).toBe('positive');
  });
});

describe('evidenceForReview — the guard in BOTH analyze paths', () => {
  const rep = ev({ id: 'rep', mention_span: 'عندنا مشروع في النرجس' });
  const own = ev({ id: 'own' });
  it('call: reports the demoted ids and returns guarded evidence', () => {
    const r = evidenceForReview([rep, own], call);
    expect(r.demoted).toEqual(['rep']);
    expect(r.evidence.map((e) => e.preference_role)).toEqual(['none', 'positive']);
    expect(r.evidence[1]).toBe(own);
  });
  it('chat: the SAME array, nothing demoted', () => {
    const input = [rep, own];
    const r = evidenceForReview(input, chat);
    expect(r.evidence).toBe(input);
    expect(r.demoted).toEqual([]);
  });
});
