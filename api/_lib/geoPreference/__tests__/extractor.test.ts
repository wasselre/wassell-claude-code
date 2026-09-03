import { describe, it, expect, beforeAll } from 'vitest';
import { extract, parseExtractorOutput, type Conversation } from '../extractor.js';
import { isActivePreference, type Evidence, type EvidenceRelation } from '../ontology.js';

/**
 * Stage-A extractor tests — STUB MODE ONLY (WA_EXTRACT_STUB=1), so nothing hits
 * an LLM and the run is fully deterministic/offline. These assert two things and
 * ONLY two things (extraction accuracy is gold-gated elsewhere and NOT claimed):
 *   1. the output is well-formed Evidence[] + EvidenceRelation[] per the ontology;
 *   2. the grammar-independence guardrails are enforced — a QUESTION is still a
 *      positive preference, and a CONDITIONAL is still an ACTIVE preference.
 */

beforeAll(() => {
  process.env.WA_EXTRACT_STUB = '1';
});

// A تركي-like messy Arabic conversation: villa; budget ≤ 2.5M; المهدية primary;
// الجبيلة as a compared alternative; a hard conditional ("if it's not north
// Riyadh it doesn't work for me"); and a QUESTION-form mention of النرجس.
const TURKI_CONVERSATION: Conversation = {
  channel: 'chat',
  id: 'conv-turki',
  turns: [
    { speaker: 'agent', text: 'حياك الله، وش تدور؟', ref: 'm1', timestamp: '2026-09-03T10:00:00Z' },
    { speaker: 'client', text: 'أبي فيلا، ميزانيتي ما تتجاوز مليونين ونص', ref: 'm2', timestamp: '2026-09-03T10:00:30Z' },
    { speaker: 'client', text: 'أبي المهدية بالدرجة الأولى، أو الجبيلة', ref: 'm3', timestamp: '2026-09-03T10:01:00Z' },
    { speaker: 'client', text: 'وبصراحة إذا مو شمال الرياض ما يناسبني', ref: 'm4', timestamp: '2026-09-03T10:01:30Z' },
    { speaker: 'client', text: 'بالمناسبة عندكم فلل بالنرجس؟', ref: 'm5', timestamp: '2026-09-03T10:02:00Z' },
  ],
};

const ANCHOR_TYPES = new Set(['district', 'city', 'region', 'town', 'direction', 'road', 'landmark', 'pin', 'relative_ref']);
const ROLES = new Set(['positive', 'negative', 'exploratory', 'none']);
const APPLIC = new Set(['active', 'exploratory', 'counterfactual', 'unclear']);
const HOLDER_ROLES = new Set(['buyer', 'co_decision_maker', 'beneficiary_occupant', 'influencer', 'unrelated_third_party', 'unknown']);
const RELATION_KINDS = new Set(['any_of', 'all_of', 'ranked_alternative', 'exception', 'comparison']);

function assertWellFormedEvidence(e: Evidence): void {
  expect(typeof e.id).toBe('string');
  expect(e.id.length).toBeGreaterThan(0);
  expect(typeof e.mention_span).toBe('string');
  expect(Array.isArray(e.anchors)).toBe(true);
  expect(e.anchors.length).toBeGreaterThan(0);
  for (const a of e.anchors) {
    expect(ANCHOR_TYPES.has(a.anchor_type)).toBe(true);
    expect(typeof a.span).toBe('string');
    expect(a.span.length).toBeGreaterThan(0);
    expect(typeof a.normalized_token).toBe('string');
  }
  expect(ROLES.has(e.preference_role)).toBe(true);
  expect(APPLIC.has(e.preference_applicability)).toBe(true);
  expect(HOLDER_ROLES.has(e.holder_role)).toBe(true);
  expect(e.source.channel === 'chat' || e.source.channel === 'call').toBe(true);
}

describe('geoPreference Stage-A extractor (stub mode)', () => {
  it('produces well-formed Evidence[] + relations for the تركي fixture', async () => {
    const { evidence, relations } = await extract(TURKI_CONVERSATION);

    expect(Array.isArray(evidence)).toBe(true);
    expect(Array.isArray(relations)).toBe(true);
    expect(evidence.length).toBeGreaterThan(0);
    evidence.forEach(assertWellFormedEvidence);

    // every relation member points at a real emitted evidence id
    const ids = new Set(evidence.map((e) => e.id));
    for (const r of relations) {
      expect(RELATION_KINDS.has(r.relation)).toBe(true);
      expect(r.members.length).toBeGreaterThanOrEqual(2);
      for (const m of r.members) {
        if (m.type === 'evidence') expect(ids.has(m.id)).toBe(true);
      }
    }
  });

  it('GUARDRAIL: a QUESTION-form mention («عندكم فلل بالنرجس؟») is still preference_role=positive', async () => {
    const { evidence } = await extract(TURKI_CONVERSATION);
    const narjes = evidence.find((e) => e.anchors.some((a) => a.span.includes('النرجس')));
    expect(narjes).toBeDefined();
    expect(narjes!.dialogue_act).toBe('question');       // grammatically a question
    expect(narjes!.preference_role).toBe('positive');    // ...semantically a positive preference
  });

  it('GUARDRAIL: a CONDITIONAL («إذا مو شمال الرياض ما يناسبني») is preference_applicability=active (and hard)', async () => {
    const { evidence } = await extract(TURKI_CONVERSATION);
    const north = evidence.find((e) => e.anchors.some((a) => a.span.includes('شمال')));
    expect(north).toBeDefined();
    expect(north!.conditionality).toBe('conditional');           // grammatically conditional
    expect(north!.preference_applicability).toBe('active');      // ...semantically active
    expect(north!.hardness_evidence).toBe('explicit_force');     // «ما يناسبني» = hard
    expect(north!.commitment).toBe('required');
    expect(isActivePreference(north!)).toBe(true);               // passes the v7 active predicate
  });

  it('المهدية + الجبيلة produce a comparison/ranked relation between the two mentions', async () => {
    const { evidence, relations } = await extract(TURKI_CONVERSATION);
    const mahdiya = evidence.find((e) => e.anchors.some((a) => a.span.includes('المهدية')));
    const jubaylah = evidence.find((e) => e.anchors.some((a) => a.span.includes('الجبيلة')));
    expect(mahdiya).toBeDefined();
    expect(jubaylah).toBeDefined();

    const rel = relations.find(
      (r) =>
        (r.relation === 'comparison' || r.relation === 'ranked_alternative') &&
        r.members.some((m) => m.id === mahdiya!.id) &&
        r.members.some((m) => m.id === jubaylah!.id),
    );
    expect(rel).toBeDefined();
  });

  it('empty conversation ⇒ well-formed empty output', async () => {
    const { evidence, relations } = await extract({ channel: 'chat', turns: [] });
    expect(evidence).toEqual([]);
    expect(relations).toEqual([]);
  });
});

describe('parseExtractorOutput — validate/repair drops malformed shapes', () => {
  const source: Evidence['source'] = { channel: 'chat', ref: 'm1', timestamp: '' };

  it('drops a mention with an invalid preference_role and one with no anchors', () => {
    const raw = JSON.stringify({
      evidence: [
        { id: 'good', mention_span: 'المهدية', anchors: [{ anchor_type: 'district', span: 'المهدية', normalized_token: 'المهديه' }], preference_role: 'positive' },
        { id: 'bad-role', mention_span: 'x', anchors: [{ anchor_type: 'district', span: 'x', normalized_token: 'x' }], preference_role: 'totally_invalid' },
        { id: 'no-anchors', mention_span: 'y', anchors: [], preference_role: 'positive' },
      ],
      relations: [],
    });
    const { evidence } = parseExtractorOutput(raw, source);
    expect(evidence.map((e) => e.id)).toEqual(['good']);
    // repaired defaults are still valid enum members
    expect(APPLIC.has(evidence[0].preference_applicability)).toBe(true);
  });

  it('drops a relation whose members reference dropped/absent evidence', () => {
    const raw = JSON.stringify({
      evidence: [
        { id: 'e1', mention_span: 'المهدية', anchors: [{ anchor_type: 'district', span: 'المهدية', normalized_token: 'المهديه' }], preference_role: 'positive' },
      ],
      relations: [
        { id: 'r1', relation: 'comparison', members: [{ type: 'evidence', id: 'e1' }, { type: 'evidence', id: 'ghost' }], source_span: '', explicit_or_inferred: 'explicit' },
        { id: 'r2', relation: 'not_a_kind', members: [{ type: 'evidence', id: 'e1' }], source_span: '', explicit_or_inferred: 'explicit' },
      ],
    });
    const { relations } = parseExtractorOutput(raw, source);
    // r1 loses the ghost member → only 1 valid member → dropped; r2 has a bad kind → dropped.
    expect(relations).toEqual([]);
  });

  it('returns empty (never throws) on non-JSON garbage', () => {
    const out: { evidence: Evidence[]; relations: EvidenceRelation[] } = parseExtractorOutput('sorry, no JSON here', source);
    expect(out).toEqual({ evidence: [], relations: [] });
  });
});
