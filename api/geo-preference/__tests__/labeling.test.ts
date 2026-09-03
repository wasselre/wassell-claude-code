import { describe, it, expect } from 'vitest';
import {
  visibleBlindLabels, pairBlindLabels, computeAgreement,
  redactContextForRole, pseudonym,
  buildGoldExport, assertTestExportAllowed, ExportGuardError,
  fieldsForRoleAndKind, ENTITIES_FOR_ROLE,
  type LabelRow,
} from '../labeling.js';

/**
 * Unit tests for the geo-preference labeling instrument's PURE logic (no live DB,
 * no handler). Four properties the workflow's correctness depends on:
 *   1. BLINDNESS — a peer's blind label is invisible until adjudication opens.
 *   2. AGREEMENT — Cohen's κ / confusion are computed from paired blind labels.
 *   3. EXPORT GUARD — frozen TEST/holdout gold never leaves during tuning.
 *   4. PII REDACTION — person identity pseudonymized for all; geometry role-gated.
 */

function mk(over: Partial<LabelRow>): LabelRow {
  return {
    batch_id: 'b1', subject_kind: 'evidence', subject_ref: 's1',
    field: 'evidence.holder_role', value: 'buyer',
    is_escape: false, annotator_id: 'A', role: 'meaning', round: 'blind',
    ...over,
  };
}

// ── 1. Blindness ────────────────────────────────────────────────────────────
describe('blindness', () => {
  const rows = [
    mk({ annotator_id: 'A', value: 'buyer' }),
    mk({ annotator_id: 'B', value: 'influencer' }),
  ];

  it('hides a peer blind label before adjudication opens', () => {
    const seen = visibleBlindLabels(rows, 'A', 'meaning', false);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.annotator_id).toBe('A');
  });

  it('reveals all blind labels once adjudication opens', () => {
    const seen = visibleBlindLabels(rows, 'A', 'meaning', true);
    expect(seen).toHaveLength(2);
  });

  it('lets an adjudicator see adjudication rows even while closed', () => {
    const adj = [mk({ round: 'adjudication', role: 'adjudicator', annotator_id: 'J' })];
    expect(visibleBlindLabels(adj, 'X', 'adjudicator', false)).toHaveLength(1);
    // ...but a meaning annotator does not, while closed.
    expect(visibleBlindLabels(adj, 'X', 'meaning', false)).toHaveLength(0);
  });
});

// ── 2. Agreement / κ ────────────────────────────────────────────────────────
describe('agreement (κ + confusion)', () => {
  it('pairs two annotators per (subject, field)', () => {
    const rows = [
      mk({ subject_ref: 's1', annotator_id: 'A', value: 'buyer' }),
      mk({ subject_ref: 's1', annotator_id: 'B', value: 'buyer' }),
      mk({ subject_ref: 's2', annotator_id: 'A', value: 'buyer' }),
      mk({ subject_ref: 's2', annotator_id: 'B', value: 'influencer' }),
    ];
    const pairs = pairBlindLabels(rows);
    expect(pairs).toHaveLength(2); // one pair per subject
  });

  it('computes raw agreement, κ and surfaces the disagreement', () => {
    // 4 items: 3 agree (buyer/buyer), 1 disagrees (buyer/influencer).
    const rows: LabelRow[] = [];
    for (let i = 0; i < 3; i++) {
      rows.push(mk({ subject_ref: `s${i}`, annotator_id: 'A', value: 'buyer' }));
      rows.push(mk({ subject_ref: `s${i}`, annotator_id: 'B', value: 'buyer' }));
    }
    rows.push(mk({ subject_ref: 's3', annotator_id: 'A', value: 'buyer' }));
    rows.push(mk({ subject_ref: 's3', annotator_id: 'B', value: 'influencer' }));

    const res = computeAgreement(rows);
    const field = res.per_field.find((f) => f.field === 'evidence.holder_role')!;
    expect(field.n).toBe(4);
    expect(field.raw_agreement).toBeCloseTo(0.75, 5);
    expect(field.cohen_kappa).toBeGreaterThan(-1);
    expect(field.cohen_kappa).toBeLessThanOrEqual(1);
    // The single disagreement survives → one must-confirm survivor.
    expect(res.survivors).toHaveLength(1);
    expect(res.survivors[0]!.field).toBe('evidence.holder_role');
    expect(res.survivors[0]!.must_confirm_condition).toBe('unclear_preference_holder');
  });

  it('perfect agreement gives κ = 1', () => {
    const rows = [
      mk({ subject_ref: 's1', annotator_id: 'A', value: 'buyer' }),
      mk({ subject_ref: 's1', annotator_id: 'B', value: 'buyer' }),
      mk({ subject_ref: 's2', annotator_id: 'A', value: 'influencer' }),
      mk({ subject_ref: 's2', annotator_id: 'B', value: 'influencer' }),
    ];
    const res = computeAgreement(rows);
    const field = res.per_field.find((f) => f.field === 'evidence.holder_role')!;
    expect(field.raw_agreement).toBe(1);
    expect(field.cohen_kappa).toBe(1);
    expect(res.survivors).toHaveLength(0);
  });
});

// ── 3. Export guard (frozen TEST discipline) ────────────────────────────────
describe('export guard', () => {
  const base = () => ({
    evidence: [
      { id: 'e-dev', client_id: 'c-dev', conversation_id: 'conv-dev' },
      { id: 'e-test', client_id: 'c-test', conversation_id: 'conv-test' },
    ],
    relations: [
      { id: 'r-dev', conversation_id: 'conv-dev' },
      { id: 'r-test', conversation_id: 'conv-test' },
    ],
    checkpoints: [
      { id: 'k-dev', client_id: 'c-dev', conversation_id: 'conv-dev', canonical_expected_expression: { groups: [] } },
      { id: 'k-test', client_id: 'c-test', conversation_id: 'conv-test', canonical_expected_expression: { groups: [] } },
    ],
    splitByClient: { 'c-dev': 'dev' as const, 'c-test': 'test' as const },
  });

  it('excludes frozen TEST rows during tuning (gate closed, include_test off)', () => {
    const out = buildGoldExport({ ...base(), includeTest: false, gateCleared: false });
    expect(out.gold_evidence_and_relations.evidence.map((e: any) => e.id)).toEqual(['e-dev']);
    expect(out.gold_evidence_and_relations.relations.map((r: any) => r.id)).toEqual(['r-dev']);
    expect(out.canonical_expected_expression.map((c) => c.checkpoint_id)).toEqual(['k-dev']);
    expect(out.included_splits).toEqual(['dev']);
    expect(out.excluded_frozen_count).toBeGreaterThan(0);
  });

  it('REFUSES a TEST export while the gate is closed', () => {
    expect(() => assertTestExportAllowed(true, false)).toThrow(ExportGuardError);
    expect(() => buildGoldExport({ ...base(), includeTest: true, gateCleared: false })).toThrow(ExportGuardError);
  });

  it('includes TEST only once the gate is cleared', () => {
    const out = buildGoldExport({ ...base(), includeTest: true, gateCleared: true });
    expect(out.gold_evidence_and_relations.evidence).toHaveLength(2);
    expect(out.included_splits).toContain('test');
    expect(out.excluded_frozen_count).toBe(0);
  });
});

// ── 4. PII redaction by role ────────────────────────────────────────────────
describe('PII redaction', () => {
  const ctx = {
    client_name: 'محمد العتيبي',
    phone: '+966501234567',
    mention_span: 'أبغى شقة قريبة، جوالي 0501234567',
    anchor: { pin_id: 'pin-abc-123', lat: 24.712345, lng: 46.678901 },
  };

  it('meaning: pseudonymizes identity, hides geometry, scrubs phones in text', () => {
    const r = redactContextForRole(ctx, 'meaning') as any;
    expect(r.client_name).toMatch(/^person_/);
    expect(r.phone).toMatch(/^person_/);
    expect(r.mention_span).toContain('[phone]');
    expect(r.mention_span).not.toContain('0501234567');
    expect(r.anchor.pin_id).toBe('[geo-hidden]');
    expect(r.anchor.lat).toBe('[geo-hidden]');
  });

  it('geo_operator: sees coordinates, pseudonymizes pins + identity', () => {
    const r = redactContextForRole(ctx, 'geo_operator') as any;
    expect(r.client_name).toMatch(/^person_/);
    expect(r.anchor.pin_id).toMatch(/^pin_/);
    expect(typeof r.anchor.lat).toBe('number');
    // coordinate precision reduced (pseudonymized), not the raw value
    expect(r.anchor.lat).toBe(24.712);
  });

  it('pseudonym is deterministic and stable', () => {
    expect(pseudonym('person', '+966501234567')).toBe(pseudonym('person', '+966501234567'));
    expect(pseudonym('person', 'a')).not.toBe(pseudonym('person', 'b'));
  });

  it('never mutates the input', () => {
    const snap = JSON.stringify(ctx);
    redactContextForRole(ctx, 'meaning');
    expect(JSON.stringify(ctx)).toBe(snap);
  });
});

// ── role ↔ field mapping ────────────────────────────────────────────────────
describe('role field mapping', () => {
  it('meaning labels evidence fields, not anchor fields', () => {
    expect(fieldsForRoleAndKind('meaning', 'evidence').length).toBeGreaterThan(0);
    expect(fieldsForRoleAndKind('meaning', 'anchor')).toHaveLength(0);
  });
  it('geo_operator labels anchor fields only', () => {
    expect(fieldsForRoleAndKind('geo_operator', 'anchor').length).toBeGreaterThan(0);
    expect(fieldsForRoleAndKind('geo_operator', 'evidence')).toHaveLength(0);
    expect(ENTITIES_FOR_ROLE.geo_operator).toEqual(['anchor']);
  });
});
