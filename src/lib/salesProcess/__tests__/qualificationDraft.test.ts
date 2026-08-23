import { describe, it, expect } from 'vitest';
import {
  seedQualification, applyRepEdit, applyAiEvidence, applyExtraction, applyOp,
  computeDiff, resolveDistrictInIndex, extractionToEvidence, valueEqual,
  HIGH_CONFIDENCE_THRESHOLD,
  type QualificationState, type DistrictIndex, type ExtractionInput,
} from '../qualificationDraft';

const HI = HIGH_CONFIDENCE_THRESHOLD; // 80
const NOW = 1_000;

const ev = (slug: string, value: unknown, confidence: number, extra: Record<string, unknown> = {}) =>
  ({ slug, value, confidence, ...extra });

function seed(saved: Record<string, unknown> = {}): QualificationState {
  return seedQualification(saved);
}

describe('applyAiEvidence — empty fill (gate 1)', () => {
  it('high-confidence fills an empty field with no rep action, marked ai_filled/green', () => {
    const s = applyAiEvidence(seed({}), [ev('preferred_unit_type', ['شقة'], 90)], { savedData: {}, now: NOW });
    expect(s.draft.preferred_unit_type).toEqual(['شقة']);
    expect(s.meta.preferred_unit_type.provenance).toBe('ai_filled');
    expect(s.meta.preferred_unit_type.needsReview).toBe(false);
    expect(s.exceptions).toHaveLength(0);
  });

  it('fills a range field (budget) from empty', () => {
    const s = applyAiEvidence(seed({}), [ev('budget', { max: 1_500_000 }, 85)], { savedData: {}, now: NOW });
    expect(s.draft.budget).toEqual({ max: 1_500_000 });
    expect(s.meta.budget.provenance).toBe('ai_filled');
  });
});

describe('draft reacts / feeds the meter (gate 2)', () => {
  it('an applied value changes the draft object the meter keys on', () => {
    const before = seed({});
    const after = applyAiEvidence(before, [ev('budget', { max: 2_000_000 }, 90)], { savedData: {}, now: NOW });
    expect(after.draft).not.toBe(before.draft);
    expect(after.draft.budget).toEqual({ max: 2_000_000 });
  });
});

describe('never persists (gate 3)', () => {
  it('the reducer only returns state — it has no persistence side effect to assert against', () => {
    // Structural guarantee: the module imports nothing that can write (no store, no
    // supabase). This test documents the contract; the value is the frozen input.
    const saved = { budget: { max: 1_000_000 } };
    const s = applyAiEvidence(seed(saved), [ev('budget', { max: 2_000_000 }, 90)], { savedData: saved, now: NOW });
    expect(saved).toEqual({ budget: { max: 1_000_000 } }); // savedData untouched
    expect(s.draft.budget).toEqual({ max: 2_000_000 });
  });
});

describe('rep-edit lock (gate 4)', () => {
  it('a rep edit locks the field; later AI cannot overwrite it and becomes a conflict', () => {
    let s = seed({});
    s = applyRepEdit(s, 'preferred_unit_type', ['فيلا']);
    s = applyAiEvidence(s, [ev('preferred_unit_type', ['شقة'], 95)], { savedData: {}, now: NOW });
    expect(s.draft.preferred_unit_type).toEqual(['فيلا']); // unchanged
    expect(s.meta.preferred_unit_type.provenance).toBe('rep_edited');
    expect(s.exceptions).toHaveLength(1);
    expect(s.exceptions[0]).toMatchObject({ slug: 'preferred_unit_type', kind: 'conflict_rep_edit' });
  });

  it('a rep edit clears a prior exception for that field', () => {
    let s = applyAiEvidence(seed({ budget: { max: 1_000_000 } }), [ev('budget', { max: 3_000_000 }, 50)], { savedData: { budget: { max: 1_000_000 } }, now: NOW });
    expect(s.exceptions).toHaveLength(1); // low-confidence
    s = applyRepEdit(s, 'budget', { max: 2_000_000 });
    expect(s.exceptions).toHaveLength(0);
  });
});

describe('changed-from-saved is flagged (gate 5)', () => {
  it('high-confidence change to a saved value is amber + needsReview and shows in the diff', () => {
    const saved = { budget: { max: 2_000_000 } };
    const s = applyAiEvidence(seed(saved), [ev('budget', { max: 1_500_000 }, 90, { quote: 'حدود مليون ونص' })], { savedData: saved, now: NOW });
    expect(s.draft.budget).toEqual({ max: 1_500_000 }); // applied (enters draft → moves count)
    expect(s.meta.budget.provenance).toBe('ai_changed');
    expect(s.meta.budget.needsReview).toBe(true);
    const diff = computeDiff(s, saved);
    expect(diff).toEqual([{ slug: 'budget', savedValue: { max: 2_000_000 }, draftValue: { max: 1_500_000 }, provenance: 'ai_changed', needsReview: true, aiQuote: 'حدود مليون ونص' }]);
  });
});

describe('low-confidence & conflicts do not alter the draft (gate 6)', () => {
  it('low-confidence evidence stays an exception; draft unchanged', () => {
    const s = applyAiEvidence(seed({}), [ev('preferred_area', { min: 200 }, HI - 1)], { savedData: {}, now: NOW });
    expect(s.draft.preferred_area).toBeUndefined();
    expect(s.exceptions[0]).toMatchObject({ slug: 'preferred_area', kind: 'low_confidence', confidence: HI - 1 });
  });

  it('confidence exactly at threshold applies', () => {
    const s = applyAiEvidence(seed({}), [ev('preferred_area', { min: 200 }, HI)], { savedData: {}, now: NOW });
    expect(s.draft.preferred_area).toEqual({ min: 200 });
  });
});

describe('multi-value semantics (gate 7) + op extensibility', () => {
  it('adds (unions) new unit types onto an AI-filled set, never removing', () => {
    let s = applyAiEvidence(seed({}), [ev('preferred_unit_type', ['شقة'], 90)], { savedData: {}, now: NOW });
    s = applyAiEvidence(s, [ev('preferred_unit_type', ['دور'], 90)], { savedData: {}, now: NOW });
    expect(s.draft.preferred_unit_type).toEqual(['شقة', 'دور']);
    expect(s.meta.preferred_unit_type.provenance).toBe('ai_filled'); // sticky green
  });

  it('unioning onto a SAVED set flags amber (broadening a known preference)', () => {
    const saved = { preferred_unit_type: ['شقة'] };
    const s = applyAiEvidence(seed(saved), [ev('preferred_unit_type', ['دور'], 90)], { savedData: saved, now: NOW });
    expect(s.draft.preferred_unit_type).toEqual(['شقة', 'دور']);
    expect(s.meta.preferred_unit_type.provenance).toBe('ai_changed');
  });

  it('ranges replace rather than union', () => {
    let s = applyAiEvidence(seed({}), [ev('budget', { max: 2_000_000 }, 90)], { savedData: {}, now: NOW });
    s = applyAiEvidence(s, [ev('budget', { max: 1_500_000 }, 90)], { savedData: {}, now: NOW });
    expect(s.draft.budget).toEqual({ max: 1_500_000 });
  });

  it('op:"replace" replaces a multi set (reserved correction semantics work today)', () => {
    let s = applyAiEvidence(seed({}), [ev('preferred_unit_type', ['شقة', 'دور'], 90)], { savedData: {}, now: NOW });
    s = applyAiEvidence(s, [ev('preferred_unit_type', ['فيلا'], 90, { op: 'replace' })], { savedData: {}, now: NOW });
    expect(s.draft.preferred_unit_type).toEqual(['فيلا']);
  });

  it('op:"remove" subtracts from a multi set', () => {
    expect(applyOp(['شقة', 'دور'], ['دور'], 'remove', 'multi')).toEqual(['شقة']);
  });

  it('unmanaged fields (preferred_direction) are never applied', () => {
    const s = applyAiEvidence(seed({}), [ev('preferred_direction', ['شمال'], 99)], { savedData: {}, now: NOW });
    expect(s.draft.preferred_direction).toBeUndefined();
    expect(s.exceptions).toHaveLength(0);
  });

  it('a value equal to what is already there is a no-op (no spurious amber)', () => {
    const saved = { preferred_unit_type: ['شقة'] };
    const s = applyAiEvidence(seed(saved), [ev('preferred_unit_type', ['شقة'], 90)], { savedData: saved, now: NOW });
    expect(s.meta.preferred_unit_type).toBeUndefined(); // stayed 'saved'
    expect(s.draft.preferred_unit_type).toEqual(['شقة']); // unchanged
  });
});

describe('district resolution + adapter', () => {
  const index: DistrictIndex = {
    // normalizeForSearch folds ة→ه, أإآ→ا, etc.; keys are already-folded here for clarity
    'النرجس': [{ id: 'd-narjis', label: 'النرجس', cityId: 'riyadh' }],
    'الخالديه': [
      { id: 'd-khalidiya-riyadh', label: 'الخالدية', cityId: 'riyadh' },
      { id: 'd-khalidiya-jeddah', label: 'الخالدية', cityId: 'jeddah' },
    ],
  };

  it('resolves a globally-unique district', () => {
    expect(resolveDistrictInIndex('النرجس', index)).toMatchObject({ id: 'd-narjis' });
  });

  it('is ambiguous across cities with no scope', () => {
    expect(resolveDistrictInIndex('الخالدية', index)).toBe('ambiguous');
  });

  it('resolves ambiguity within the selected city', () => {
    expect(resolveDistrictInIndex('الخالدية', index, 'jeddah')).toMatchObject({ id: 'd-khalidiya-jeddah' });
  });

  it('unknown district → not_found', () => {
    expect(resolveDistrictInIndex('حي غير موجود', index)).toBe('not_found');
  });

  it('adapter: resolved districts become a location_items add-evidence; unresolved become exceptions', () => {
    const extraction: ExtractionInput = {
      suggestions: { preferred_unit_type: { value: ['شقة'], confidence: 90, quote: null } },
      districts: ['النرجس', 'الخالدية', 'حي مجهول'],
    };
    const resolveDistrict = (n: string) => resolveDistrictInIndex(n, index);
    const s = applyExtraction(seed({}), extraction, { savedData: {}, resolveDistrict, now: NOW });
    // النرجس applied as an include-rule
    expect(s.draft.location_items).toEqual([{ kind: 'district', district_id: 'd-narjis', district_label: 'النرجس', polarity: 'include' }]);
    expect(s.draft.preferred_unit_type).toEqual(['شقة']);
    // الخالدية (ambiguous) + حي مجهول (not_found) → two district exceptions, none in the draft
    const dex = s.exceptions.filter((e) => e.kind === 'district_ambiguous');
    expect(dex).toHaveLength(2);
  });

  it('adapter excludes preferred_direction from evidence', () => {
    const { evidence } = extractionToEvidence(
      { suggestions: { preferred_direction: { value: ['شمال'], confidence: 99 }, budget: { value: { max: 1 }, confidence: 90 } } },
      {},
    );
    expect(evidence.map((e) => e.slug)).toEqual(['budget']);
  });
});

describe('computeDiff groups by provenance', () => {
  it('reports ai_filled, ai_changed and rep_edited changes; skips unchanged', () => {
    const saved = { budget: { max: 2_000_000 }, preferred_area: { min: 150 } };
    let s = seed(saved);
    s = applyAiEvidence(s, [ev('preferred_unit_type', ['شقة'], 90)], { savedData: saved, now: NOW }); // new → ai_filled
    s = applyAiEvidence(s, [ev('budget', { max: 1_500_000 }, 90)], { savedData: saved, now: NOW });    // changed → ai_changed
    s = applyRepEdit(s, 'preferred_area', { min: 200 });                                               // rep_edited
    const diff = computeDiff(s, saved);
    const bySlug = Object.fromEntries(diff.map((d) => [d.slug, d.provenance]));
    expect(bySlug).toEqual({ preferred_unit_type: 'ai_filled', budget: 'ai_changed', preferred_area: 'rep_edited' });
  });
});

describe('valueEqual normalization', () => {
  it('treats empties as equal and is order-insensitive for multi', () => {
    expect(valueEqual(undefined, [])).toBe(true);
    expect(valueEqual(['شقة', 'دور'], ['دور', 'شقة'])).toBe(true);
    expect(valueEqual({ min: null, max: null }, undefined)).toBe(true);
  });
});
