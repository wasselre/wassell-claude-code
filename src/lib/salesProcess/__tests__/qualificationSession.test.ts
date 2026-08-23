import { describe, it, expect, beforeEach } from 'vitest';
import * as session from '../qualificationSession';
import type { DistrictIndexEntry } from '../qualificationDraft';

beforeEach(() => session.__resetSession());

const ctx = (savedData: Record<string, unknown> | null = {}) => ({ savedData });
const extraction = (slug: string, value: unknown, confidence: number) =>
  ({ suggestions: { [slug]: { value, confidence } } });

describe('follow-up scoping (lifecycle rule)', () => {
  it('seeds from saved and preserves state within the same mission (navigation survival)', () => {
    const saved = { budget: { max: 2_000_000 } };
    session.ensureSession({ followupId: 'A', clientId: 'c1', ctx: ctx(saved) });
    session.applyExtractionEvent(extraction('preferred_unit_type', ['شقة'], 90));
    // "Navigate away and back": ensureSession for the SAME follow-up must NOT reset.
    session.ensureSession({ followupId: 'A', clientId: 'c1', ctx: ctx(saved) });
    expect(session.getSnapshot().qual.draft.preferred_unit_type).toEqual(['شقة']);
  });

  it('switching missions RESETS — B cannot inherit A draft/exceptions/provenance', () => {
    session.ensureSession({ followupId: 'A', clientId: 'c1', ctx: ctx({}) });
    session.applyExtractionEvent(extraction('preferred_unit_type', ['فيلا'], 95));
    session.setRepEdit('budget', { max: 3_000_000 });
    session.ensureSession({ followupId: 'B', clientId: 'c2', ctx: ctx({}) });
    const s = session.getSnapshot();
    expect(s.followupId).toBe('B');
    expect(s.qual.draft.preferred_unit_type).toBeUndefined();
    expect(s.qual.draft.budget).toBeUndefined();
    expect(Object.keys(s.qual.meta)).toHaveLength(0);
  });

  it('resetSession clears; a mismatched followupId is a no-op', () => {
    session.ensureSession({ followupId: 'A', clientId: 'c1', ctx: ctx({}) });
    session.applyExtractionEvent(extraction('budget', { max: 1_000_000 }, 90));
    session.resetSession('other'); // different mission → no-op
    expect(session.getSnapshot().qual.draft.budget).toEqual({ max: 1_000_000 });
    session.resetSession('A');
    expect(session.getSnapshot().followupId).toBeNull();
  });
});

describe('AI evidence flows through the Phase 3 reducer', () => {
  it('high-confidence fills an empty field (ai_filled) and moves the draft', () => {
    session.ensureSession({ followupId: 'A', clientId: 'c1', ctx: ctx({}) });
    session.applyExtractionEvent(extraction('budget', { max: 1_500_000 }, 90));
    const s = session.getSnapshot();
    expect(s.qual.draft.budget).toEqual({ max: 1_500_000 });
    expect(s.qual.meta.budget.provenance).toBe('ai_filled');
  });

  it('a rep edit LOCKS the field against later live evidence (queued as a conflict)', () => {
    session.ensureSession({ followupId: 'A', clientId: 'c1', ctx: ctx({}) });
    session.setRepEdit('preferred_unit_type', ['فيلا']);
    session.applyExtractionEvent(extraction('preferred_unit_type', ['شقة'], 95));
    const s = session.getSnapshot();
    expect(s.qual.draft.preferred_unit_type).toEqual(['فيلا']); // rep wins
    expect(s.qual.exceptions.some((e) => e.kind === 'conflict_rep_edit')).toBe(true);
  });

  it('uses the ctx resolveDistrict for districts (unambiguous → applied)', () => {
    const resolveDistrict = (name: string): DistrictIndexEntry | 'ambiguous' | 'not_found' =>
      name === 'النرجس' ? { id: 'd-narjis', label: 'النرجس', cityId: 'riyadh' } : 'not_found';
    session.ensureSession({ followupId: 'A', clientId: 'c1', ctx: { savedData: {}, resolveDistrict } });
    session.applyExtractionEvent({ suggestions: {}, districts: ['النرجس', 'مجهول'] });
    const s = session.getSnapshot();
    expect(s.qual.draft.location_items).toEqual([{ kind: 'district', district_id: 'd-narjis', district_label: 'النرجس', polarity: 'include' }]);
    expect(s.qual.exceptions.some((e) => e.kind === 'district_ambiguous')).toBe(true);
  });
});

describe('subscription', () => {
  it('notifies subscribers on change and returns a stable snapshot between changes', () => {
    let hits = 0;
    const unsub = session.subscribe(() => { hits += 1; });
    const before = session.getSnapshot();
    expect(session.getSnapshot()).toBe(before); // stable ref
    session.ensureSession({ followupId: 'A', clientId: 'c1', ctx: ctx({}) });
    expect(hits).toBeGreaterThan(0);
    expect(session.getSnapshot()).not.toBe(before);
    unsub();
  });
});
