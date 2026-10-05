import { describe, it, expect } from 'vitest';
import { decideAnalyzeMode, computeStale, pruneExpression, laterOf, readingAsOf } from '../chatCard.js';
import type { GeoPreference, GeometryRecipe } from '../ontology.js';

/**
 * The chat confirm card's pure logic: which reading mode runs, when a reading
 * is stale, and how an unticked line is removed from the expression.
 */

const recipe: GeometryRecipe = {
  operation: 'district_polygon', source_anchors: [], resolved_element_ids: ['11111111-1111-4111-8111-111111111111'],
  geo_data_version: 'v1', resolver_version: 'r1', compiled_at: '2026-09-27T00:00:00Z',
};
const ref = (eid: string) => ({ geometry_id: `geo:${eid}`, recipe });

/** group 1: (A OR B) AND (NOT C) ; group 2: (D) */
function sample(): GeoPreference {
  return {
    schema_version: 'v1',
    groups: [
      {
        id: 'g1', role: 'primary', strength: 'soft', priority: 1,
        clauses: [
          { op: 'include', anyOf: [ref('A'), ref('B')] },
          { op: 'exclude', anyOf: [ref('C')] },
        ],
      },
      { id: 'g2', role: 'alternative', strength: 'soft', priority: 2, clauses: [{ op: 'include', anyOf: [ref('D')] }] },
    ],
  };
}
const ids = (e: GeoPreference) => e.groups.map((g) => g.clauses.map((c) => c.anyOf.map((r) => r.geometry_id)));

describe('decideAnalyzeMode', () => {
  it('never read → full extraction', () => {
    expect(decideAnalyzeMode({ hasCheckpoint: false, hasNewerMessage: false, hasProtectedEvidence: false })).toBe('extract');
    expect(decideAnalyzeMode({ hasCheckpoint: false, hasNewerMessage: true, hasProtectedEvidence: false })).toBe('extract');
  });
  it('read, nothing new since → review-only rerun (no LLM extraction)', () => {
    expect(decideAnalyzeMode({ hasCheckpoint: true, hasNewerMessage: false, hasProtectedEvidence: false })).toBe('re_review');
  });
  it('read, customer wrote since, not graded → full extraction', () => {
    expect(decideAnalyzeMode({ hasCheckpoint: true, hasNewerMessage: true, hasProtectedEvidence: false })).toBe('extract');
  });
  it('read, customer wrote since, but GRADED → review-only (re-extraction would delete the graded rows)', () => {
    expect(decideAnalyzeMode({ hasCheckpoint: true, hasNewerMessage: true, hasProtectedEvidence: true })).toBe('re_review');
    expect(decideAnalyzeMode({ hasCheckpoint: true, hasNewerMessage: false, hasProtectedEvidence: true })).toBe('re_review');
  });
});

describe('readingAsOf — a message that lands mid-read is NOT read', () => {
  // Live 2026-10-04: district list at 14:42:22 (whole seconds), reading saved
  // 14:42:22.82 but covering messages up to 14:40:43 only.
  const cp = { created_at: '2026-10-04T14:42:22.820Z', as_of_timestamp: '2026-10-04T14:40:43.161Z' };
  it('compares to the newest message the reading covered, so the next read extracts', () => {
    expect(computeStale(readingAsOf(cp), '2026-10-04T14:42:22Z')).toBe(true);
    expect(computeStale(cp.created_at, '2026-10-04T14:42:22Z')).toBe(false); // the old comparison
  });
  it('falls back to the save time when as_of is missing', () => {
    expect(readingAsOf({ created_at: cp.created_at, as_of_timestamp: null })).toBe(cp.created_at);
    expect(readingAsOf(null)).toBeNull();
  });
});

describe('computeStale', () => {
  it('a customer message after the reading → stale', () => {
    expect(computeStale('2026-09-27T10:00:00Z', '2026-09-27T10:05:00Z')).toBe(true);
  });
  it('the newest customer message is older than (or equal to) the reading → not stale', () => {
    expect(computeStale('2026-09-27T10:00:00Z', '2026-09-27T09:59:59Z')).toBe(false);
    expect(computeStale('2026-09-27T10:00:00Z', '2026-09-27T10:00:00Z')).toBe(false);
  });
  it('compares instants, not strings (offsets)', () => {
    expect(computeStale('2026-09-27T10:00:00+00:00', '2026-09-27T12:30:00+03:00')).toBe(false);
    expect(computeStale('2026-09-27T10:00:00+00:00', '2026-09-27T13:30:00+03:00')).toBe(true);
  });
  it('never read, or no customer message, or unparseable → not stale', () => {
    expect(computeStale(null, '2026-09-27T10:05:00Z')).toBe(false);
    expect(computeStale('2026-09-27T10:00:00Z', null)).toBe(false);
    expect(computeStale('garbage', '2026-09-27T10:05:00Z')).toBe(false);
  });
});

describe('pruneExpression', () => {
  it('drops one alternative of an OR, keeps the rest', () => {
    const out = pruneExpression(sample(), ['A']);
    expect(ids(out)).toEqual([[['geo:B'], ['geo:C']], [['geo:D']]]);
  });
  it('drops a whole clause when its only ref goes', () => {
    const out = pruneExpression(sample(), ['C']);
    expect(ids(out)).toEqual([[['geo:A', 'geo:B']], [['geo:D']]]);
    expect(out.groups[0]!.clauses[0]!.op).toBe('include');
  });
  it('drops a group when its last clause goes', () => {
    const out = pruneExpression(sample(), ['D']);
    expect(out.groups.map((g) => g.id)).toEqual(['g1']);
    const all = pruneExpression(sample(), ['A', 'B', 'C', 'D']);
    expect(all.groups).toEqual([]);
    expect(all.schema_version).toBe('v1');
  });
  it('no-op when nothing (or an unknown id) is dropped — and never mutates the input', () => {
    const input = sample();
    const snapshot = JSON.stringify(input);
    expect(pruneExpression(input, [])).toEqual(input);
    expect(pruneExpression(input, ['nope'])).toEqual(input);
    pruneExpression(input, ['A', 'C', 'D']);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
  it('matches the full `geo:<id>` ref, not a prefix', () => {
    const e: GeoPreference = { schema_version: 'v1', groups: [{ id: 'g', role: 'primary', strength: 'soft', priority: 1, clauses: [{ op: 'include', anyOf: [ref('AB'), ref('A')] }] }] };
    expect(ids(pruneExpression(e, ['A']))).toEqual([[['geo:AB']]]);
  });
  it('round 3 #24: a mention\'s sub-ref `geo:<id>:admin` goes with it — unticking never leaves part of it behind', () => {
    const e: GeoPreference = { schema_version: 'v1', groups: [{ id: 'g', role: 'primary', strength: 'soft', priority: 1, clauses: [
      { op: 'include', anyOf: [ref('A')] },
      { op: 'include', anyOf: [ref('A:admin')] },
      { op: 'include', anyOf: [ref('AB:admin'), ref('B')] },
    ] }] };
    expect(ids(pruneExpression(e, ['A']))).toEqual([[['geo:AB:admin', 'geo:B']]]);
    expect(ids(pruneExpression(e, ['AB']))).toEqual([[['geo:A'], ['geo:A:admin'], ['geo:B']]]);
  });
});

describe('laterOf', () => {
  it('picks the later timestamp, tolerating nulls', () => {
    expect(laterOf('2026-09-27T10:00:00Z', '2026-09-27T11:00:00Z')).toBe('2026-09-27T11:00:00Z');
    expect(laterOf('2026-09-27T12:00:00Z', '2026-09-27T11:00:00Z')).toBe('2026-09-27T12:00:00Z');
    expect(laterOf(null, '2026-09-27T11:00:00Z')).toBe('2026-09-27T11:00:00Z');
    expect(laterOf('2026-09-27T10:00:00Z', null)).toBe('2026-09-27T10:00:00Z');
    expect(laterOf(null, null)).toBeNull();
  });
});
