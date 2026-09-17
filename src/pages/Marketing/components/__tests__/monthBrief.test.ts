/**
 * The resolved brief (F2b) and the row's pre-send state (F3).
 *
 * The test that earns its place here is **D7's separation**: a paid creative's
 * task must never read an organic project-column note, and vice versa. That is
 * not a rendering detail — it is the whole reason `mos_month_notes.lane` exists,
 * and a leak would be invisible on screen (a plausible note in the wrong place
 * reads exactly like a correct one).
 */
import { describe, it, expect } from 'vitest';
import type { MosMonthNote } from '@/lib/marketingOS/client';
import { resolveMonthBrief, type MonthNote } from '../MonthBriefPanel';
import { postWritingState } from '../WritingFields';

/**
 * Compile-time proof that what `month_get` returns is what the panel resolves
 * over. If `MosMonthNote` gains a required field or renames a coordinate, this
 * line fails at `tsc` rather than the brief silently matching nothing.
 */
const _apiNoteFits: MonthNote = {} as MosMonthNote;
void _apiNoteFits;

const PROJ = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

const note = (n: Partial<MonthNote> & Pick<MonthNote, 'kind' | 'body'>): MonthNote => ({
  id: `${n.kind}-${n.lane ?? 'both'}-${n.project_id ?? 'none'}-${n.batch_date ?? 'none'}`,
  month: '2026-10-01',
  lane: null,
  project_id: null,
  batch_date: null,
  ...n,
});

const MONTH = note({ kind: 'month', body: 'نركّز على قرب التسليم.' });
const ORG_COL = note({ kind: 'project', lane: 'organic', project_id: PROJ, body: 'تجنّبوا لغة الاستثمار.' });
const PAID_COL = note({ kind: 'project', lane: 'paid', project_id: PROJ, body: 'اذكروا الدفعة الأولى.' });
const ROW_CELL = note({ kind: 'row', lane: 'organic', project_id: PROJ, batch_date: '2026-10-25', body: 'آخر صف للمشروع.' });
const PAID_CELL = note({ kind: 'paid_batch', lane: 'paid', project_id: PROJ, batch_date: '2026-10-04', body: 'جرّبوا زاوية الموقع.' });

const ALL = [MONTH, ORG_COL, PAID_COL, ROW_CELL, PAID_CELL];

describe('resolveMonthBrief — D7, one lane only', () => {
  it('an organic row reads month → organic column → row cell, in that order', () => {
    const lines = resolveMonthBrief(ALL, {
      lane: 'organic', projectId: PROJ, batchDate: '2026-10-25', projectName: 'أكنان ٢٥',
    });
    expect(lines.map((l) => l.kind)).toEqual(['month', 'project', 'row']);
    expect(lines.map((l) => l.body)).toEqual([MONTH.body, ORG_COL.body, ROW_CELL.body]);
    expect(lines[1]?.source_ar).toContain('أكنان ٢٥');
  });

  it('a paid creative reads month → PAID column → paid batch cell', () => {
    const lines = resolveMonthBrief(ALL, {
      lane: 'paid', projectId: PROJ, batchDate: '2026-10-04',
    });
    expect(lines.map((l) => l.kind)).toEqual(['month', 'project', 'paid_batch']);
    expect(lines.map((l) => l.body)).toEqual([MONTH.body, PAID_COL.body, PAID_CELL.body]);
  });

  it('a paid task never shows the organic column note, even with no paid column written', () => {
    const withoutPaidColumn = ALL.filter((n) => n !== PAID_COL);
    const lines = resolveMonthBrief(withoutPaidColumn, {
      lane: 'paid', projectId: PROJ, batchDate: '2026-10-04',
    });
    expect(lines.map((l) => l.body)).not.toContain(ORG_COL.body);
    expect(lines.map((l) => l.kind)).toEqual(['month', 'paid_batch']);
  });

  it('an organic task never shows the paid column note', () => {
    const withoutOrgColumn = ALL.filter((n) => n !== ORG_COL);
    const lines = resolveMonthBrief(withoutOrgColumn, {
      lane: 'organic', projectId: PROJ, batchDate: '2026-10-25',
    });
    expect(lines.map((l) => l.body)).not.toContain(PAID_COL.body);
  });

  it('the month note reaches BOTH lanes — it is the one level that does', () => {
    const org = resolveMonthBrief([MONTH], { lane: 'organic', projectId: PROJ, batchDate: '2026-10-25' });
    const paid = resolveMonthBrief([MONTH], { lane: 'paid', projectId: PROJ, batchDate: '2026-10-04' });
    expect(org).toHaveLength(1);
    expect(paid).toHaveLength(1);
  });
});

describe('resolveMonthBrief — empty levels and wrong coordinates', () => {
  it('hides a level that was never written rather than rendering an empty heading', () => {
    const lines = resolveMonthBrief([MONTH], {
      lane: 'organic', projectId: PROJ, batchDate: '2026-10-25',
    });
    expect(lines.map((l) => l.kind)).toEqual(['month']);
  });

  it('treats a whitespace-only note as not written', () => {
    const blank = note({ kind: 'project', lane: 'organic', project_id: PROJ, body: '   ' });
    const lines = resolveMonthBrief([MONTH, blank], {
      lane: 'organic', projectId: PROJ, batchDate: '2026-10-25',
    });
    expect(lines.map((l) => l.kind)).toEqual(['month']);
  });

  it('does not read another project’s column note', () => {
    const lines = resolveMonthBrief(ALL, {
      lane: 'organic', projectId: OTHER, batchDate: '2026-10-25',
    });
    expect(lines.map((l) => l.body)).toEqual([MONTH.body]);
  });

  it('does not read another day’s cell note', () => {
    const lines = resolveMonthBrief(ALL, {
      lane: 'organic', projectId: PROJ, batchDate: '2026-10-18',
    });
    expect(lines.map((l) => l.kind)).toEqual(['month', 'project']);
  });

  it('matches a cell note written with a timestamped date', () => {
    const stamped = note({
      kind: 'row', lane: 'organic', project_id: PROJ,
      batch_date: '2026-10-25T00:00:00.000Z', body: 'مكتوبة بطابع زمني',
    });
    const lines = resolveMonthBrief([stamped], {
      lane: 'organic', projectId: PROJ, batchDate: '2026-10-25',
    });
    expect(lines.map((l) => l.kind)).toEqual(['row']);
  });
});

describe('resolveMonthBrief — the Saturday general row', () => {
  const coord = { lane: 'organic' as const, projectId: null, batchDate: '2026-10-24' };

  it('is like any other day — only notes someone wrote, never a standing topic list', () => {
    const lines = resolveMonthBrief(ALL, coord);
    expect(lines.map((l) => l.kind)).toEqual(['month']);
  });

  it('shows its own cell note when one was written', () => {
    const cell = note({
      kind: 'row', lane: 'organic', project_id: null,
      batch_date: '2026-10-24', body: 'موضوع السبت: مقارنة أحياء.',
    });
    const lines = resolveMonthBrief([MONTH, cell], coord);
    expect(lines.map((l) => l.kind)).toEqual(['month', 'row']);
  });

  it('does not borrow a project row’s cell note that falls on the same day', () => {
    const projectCell = note({
      kind: 'row', lane: 'organic', project_id: PROJ,
      batch_date: '2026-10-24', body: 'ملاحظة صف أكنان.',
    });
    const lines = resolveMonthBrief([projectCell], coord);
    expect(lines.map((l) => l.body)).not.toContain(projectCell.body);
  });

  it('is empty when nothing was written', () => {
    expect(resolveMonthBrief([], coord)).toEqual([]);
  });
});

describe('postWritingState — what the row check reads', () => {
  it('counts only lines with text, and keeps their order', () => {
    const s = postWritingState({ headlines: ['بيت يبدأ صغيرًا', '  ', '٤٤ وحدة متاحة'] });
    expect(s.hasLines).toBe(true);
    expect(s.lines).toEqual(['بيت يبدأ صغيرًا', '٤٤ وحدة متاحة']);
  });

  it('is not confirmed when the caption was edited after confirmation', () => {
    const s = postWritingState({
      caption: 'النص بعد التعديل',
      caption_confirmed_text: 'النص قبل التعديل',
      caption_confirmed_at: '2026-10-01T00:00:00.000Z',
    });
    expect(s.hasCaption).toBe(true);
    expect(s.captionConfirmed).toBe(false);
  });

  it('compares the caption RAW — a stray trailing space breaks the confirmation', () => {
    expect(postWritingState({ caption: 'نص ', caption_confirmed_text: 'نص' }).captionConfirmed).toBe(false);
    expect(postWritingState({ caption: 'نص', caption_confirmed_text: 'نص' }).captionConfirmed).toBe(true);
  });

  it('an empty caption is never confirmed, whatever the companion keys say', () => {
    expect(postWritingState({ caption: '', caption_confirmed_text: '' }).captionConfirmed).toBe(false);
  });

  it('reads caption_source from DATA, so it survives a reload', () => {
    expect(postWritingState({ caption_source: 'ai' }).captionSource).toBe('ai');
    expect(postWritingState({ caption_source: 'fallback' }).captionSource).toBe('fallback');
    expect(postWritingState({}).captionSource).toBeNull();
    expect(postWritingState({ caption_source: 'nonsense' }).captionSource).toBeNull();
  });

  it('survives junk in the data without throwing', () => {
    const s = postWritingState({ headlines: 'not an array', caption: 42 });
    expect(s.hasLines).toBe(false);
    expect(s.hasCaption).toBe(false);
  });
});
