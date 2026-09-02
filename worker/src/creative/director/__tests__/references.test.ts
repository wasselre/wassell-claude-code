import { describe, expect, it } from 'vitest';
import type { RefKind, RefLevel } from '../../contracts.js';
import { selectReferences, type CreativeReferenceRow, type ModelReferencePick } from '../references.js';

function mkRow(id: string, over: Partial<CreativeReferenceRow> = {}): CreativeReferenceRow {
  return {
    ref_kind: 'competitor_post' as RefKind,
    ref_id: id,
    post_id: `post-${id}`,
    slide_index: null,
    level: 'post' as RefLevel,
    preview_url: `https://example.test/${id}.jpg`,
    org_name: 'شركة المنافس',
    platform: 'instagram',
    published_at: '2026-08-01T00:00:00Z',
    post_url: null,
    score: 1,
    why: { purpose: 'عرض' },
    read: null,
    ...over,
  };
}

function mkPick(ref_id: string): ModelReferencePick {
  return { ref_id, aspect: 'composition', why: 'w', study: 's', adapt: 'a', do_not_copy: 'd', differ: 'f' };
}

describe('selectReferences', () => {
  it('drops hallucinated ids (not among the candidates)', () => {
    const rows = [mkRow('r1')];
    const sel = selectReferences(rows, { format: 'single' }, { picks: [mkPick('r1'), mkPick('ghost-999')] });
    expect(sel.references).toHaveLength(1);
    expect(sel.references[0]!.ref_id).toBe('r1');
    expect(sel.dropped).toEqual([{ ref_id: 'ghost-999', reason: 'unknown_id' }]);
  });

  it('maps row fields (preview_url, level, post_id) from the ROW, not the model', () => {
    const sel = selectReferences([mkRow('r1', { slide_index: 2, level: 'slide' })], { format: 'single' }, { picks: [mkPick('r1')] });
    expect(sel.references[0]).toMatchObject({
      ref_id: 'r1', preview_url: 'https://example.test/r1.jpg', level: 'slide', slide_index: 2, post_id: 'post-r1',
      aspect: 'composition', study: 's',
    });
  });

  it('enforces org diversity — at most 2 per organisation', () => {
    const rows = [
      mkRow('a1', { org_name: 'منافس أ' }),
      mkRow('a2', { org_name: 'منافس أ' }),
      mkRow('a3', { org_name: 'منافس أ' }),
      mkRow('b1', { org_name: 'منافس ب' }),
    ];
    const sel = selectReferences(rows, { format: 'single' }, { picks: rows.map((r) => mkPick(r.ref_id)), max: 4 });
    expect(sel.references.map((r) => r.ref_id)).toEqual(['a1', 'a2', 'b1']);
    expect(sel.dropped).toEqual([{ ref_id: 'a3', reason: 'org_diversity' }]);
  });

  it('caps at max (default 4)', () => {
    const rows = ['o1', 'o2', 'o3', 'o4', 'o5'].map((id, i) => mkRow(id, { org_name: `منافس ${i}` }));
    const sel = selectReferences(rows, { format: 'single' });
    expect(sel.references).toHaveLength(4);
    expect(sel.dropped).toEqual([{ ref_id: 'o5', reason: 'over_max' }]);
  });

  it('carousels get ≥1 post-level reference — promotes one when the picks were all slide-level', () => {
    const rows = [
      mkRow('s1', { level: 'slide', slide_index: 1 }),
      mkRow('s2', { level: 'slide', slide_index: 2 }),
      mkRow('p1', { level: 'post', org_name: 'منافس ب' }),
    ];
    const sel = selectReferences(rows, { format: 'carousel' }, { picks: [mkPick('s1'), mkPick('s2')] });
    expect(sel.references.some((r) => r.level === 'post')).toBe(true);
    expect(sel.references.find((r) => r.level === 'post')!.ref_id).toBe('p1');
  });

  it('warns when a carousel has no post-level candidate at all', () => {
    const rows = [mkRow('s1', { level: 'slide', slide_index: 1 })];
    const sel = selectReferences(rows, { format: 'carousel' }, { picks: [mkPick('s1')] });
    expect(sel.warnings.some((w) => w.startsWith('no_post_level_reference'))).toBe(true);
  });

  it('deterministic fallback (no picks) selects the top rows with generic study text', () => {
    const rows = [mkRow('r1'), mkRow('r2', { org_name: 'منافس ب' })];
    const sel = selectReferences(rows, { format: 'single' });
    expect(sel.references).toHaveLength(2);
    expect(sel.references[0]!.study.length).toBeGreaterThan(0);
    expect(sel.references[0]!.do_not_copy).toContain('لا تنسخ');
  });
});
