/**
 * Phase 3 · B6 — what the record panel is allowed to edit.
 *
 * `classifyEdge` decides, from source keys alone, whether the panel offers an
 * Unlink button. It is the most consequential rule in the batch and it fails in
 * two directions, both silent:
 *
 *   too permissive  → the panel offers Unlink on a FIELD-derived edge. Clicking
 *                     it deletes nothing (there is no document_links row), so
 *                     the user is told it worked and the row stays. That is the
 *                     Files UI silently disagreeing with the record form two
 *                     inches above it — exactly what the spec forbids.
 *   too restrictive → a manual link becomes impossible to undo from the only
 *                     screen that shows it.
 *
 * The real production key shapes, from the Phase 1 design:
 *   field:<model>:<record>:<field>:<index>:<file>
 *   attachment:<file>:<model>:<record>
 *   manual:<file>:<model>:<record>
 *   marketing:<asset>:<file>:<model>:<record>
 */
import { describe, it, expect } from 'vitest';
import { classifyEdge, groupByRole, originOf, type RecordFileEntry } from '../recordFiles';

const FIELD = 'field:units:3cb3b31d-0000-0000-0000-000000000001:unit_plan:0:cf37d76f-0000-0000-0000-000000000002';
const ATTACH = 'attachment:cf37d76f-0000-0000-0000-000000000002:units:3cb3b31d-0000-0000-0000-000000000001';
const MANUAL = 'manual:cf37d76f-0000-0000-0000-000000000002:units:3cb3b31d-0000-0000-0000-000000000001';
const MARKETING = 'marketing:a1:cf37d76f-0000-0000-0000-000000000002:units:3cb3b31d-0000-0000-0000-000000000001';

describe('originOf — the four real key shapes', () => {
  it('reads the mechanism from the prefix', () => {
    expect(originOf(FIELD)).toBe('field');
    expect(originOf(ATTACH)).toBe('attachment');
    expect(originOf(MANUAL)).toBe('manual');
    expect(originOf(MARKETING)).toBe('marketing');
  });

  it('does not mistake a uuid containing the word for a prefix', () => {
    // A file id could contain "manual" as a substring; only the segment before
    // the FIRST colon decides.
    expect(originOf('field:units:r1:manual_notes:0:f1')).toBe('field');
  });

  it('calls an unrecognised prefix unknown rather than guessing', () => {
    // A future mechanism must NOT default to removable.
    expect(originOf('something_new:x:y')).toBe('unknown');
    expect(originOf('')).toBe('unknown');
  });
});

describe('classifyEdge — Unlink is offered only for a manual link', () => {
  it('a field-derived edge is READ-ONLY', () => {
    const c = classifyEdge([FIELD]);
    expect(c.removable).toBe(false);
    expect(c.survivesRemoval).toBe(false);
  });

  it('the legacy attachment column is READ-ONLY', () => {
    expect(classifyEdge([ATTACH]).removable).toBe(false);
  });

  it('a marketing asset is READ-ONLY', () => {
    expect(classifyEdge([MARKETING]).removable).toBe(false);
  });

  it('an unknown mechanism is READ-ONLY — never removable by default', () => {
    expect(classifyEdge(['brand_new:1:2']).removable).toBe(false);
  });

  it('a manual link IS removable, and removing it clears the row', () => {
    const c = classifyEdge([MANUAL]);
    expect(c.removable).toBe(true);
    expect(c.survivesRemoval).toBe(false);
  });

  it('manual + field: removable, but the row SURVIVES the removal', () => {
    // Measured on production: 787 unit edges are proven by two mechanisms at
    // once. Telling the user "removed" and leaving the row is the lie this
    // flag exists to prevent.
    const c = classifyEdge([MANUAL, FIELD]);
    expect(c.removable).toBe(true);
    expect(c.survivesRemoval).toBe(true);
    expect(c.origins).toEqual(expect.arrayContaining(['manual', 'field']));
  });

  it('manual + attachment also survives', () => {
    expect(classifyEdge([ATTACH, MANUAL]).survivesRemoval).toBe(true);
  });

  it('duplicate sources of the same mechanism do not fake a second proof', () => {
    // Two field occurrences (index 0 and 1) are ONE mechanism. Counting them
    // as two would make a manual-only edge look like it survives removal.
    const c = classifyEdge([MANUAL, MANUAL]);
    expect(c.origins).toEqual(['manual']);
    expect(c.survivesRemoval).toBe(false);
  });

  it('an edge with NO sources is read-only, not removable', () => {
    // Should not occur under Phase 2, but the panel must not offer an action
    // that cannot possibly succeed.
    const c = classifyEdge([]);
    expect(c.removable).toBe(false);
    expect(c.survivesRemoval).toBe(false);
  });
});

describe('groupByRole — the panel sections', () => {
  const entry = (role: string, id: string): RecordFileEntry => ({
    link_id: id,
    // Only the fields groupByRole touches; the rest is irrelevant here.
    file: { id, title: id } as RecordFileEntry['file'],
    role,
    origins: ['manual'],
    removable: true,
    survivesRemoval: false,
    sourceField: null,
  });

  it('groups by role, biggest group first', () => {
    const g = groupByRole([
      entry('gallery_image', 'a'),
      entry('floor_plan', 'b'),
      entry('gallery_image', 'c'),
      entry('gallery_image', 'd'),
    ]);
    expect(g.map((x) => x.role)).toEqual(['gallery_image', 'floor_plan']);
    expect(g[0].entries).toHaveLength(3);
  });

  it('breaks a size tie alphabetically, so section order is stable', () => {
    const g = groupByRole([entry('zeta', 'a'), entry('alpha', 'b')]);
    expect(g.map((x) => x.role)).toEqual(['alpha', 'zeta']);
  });

  it('returns nothing for no entries', () => {
    expect(groupByRole([])).toEqual([]);
  });
});
