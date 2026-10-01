/**
 * The Instagram grid only grows by whole rows of three (operator rule, 2026-10-01).
 *
 * On 29–30 Sep the publisher sent releases one at a time and knew nothing about
 * rows: eight older ربوة الرمز posts that belonged to no row went out as 1 + 7,
 * the one was later removed, and the seven left — two rows plus one — shifted
 * every tile below them, splitting both يمام rows. These tests pin the rule that
 * stops it: what lands on the grid, when a row may go, in what order and at
 * what times, and that a handoff failing part-way leaves nothing behind.
 */
import { describe, expect, it } from 'vitest';
import {
  type GridRelease, INSTAGRAM_GRID_COLUMNS, ROW_LEAD_MS, ROW_MIN_GAP_MS,
  handOffRow, isAlreadyOut, judgeRow, landsOnInstagramGrid, rowPostDates, rowTiming,
} from '../instagramGrid.js';

const at = (iso: string): number => Date.parse(iso);

/** A row exactly as the month plan makes it: 18:00 / 18:05 / 18:10 Riyadh,
 *  the writer's third post first, so the first-read post lands newest. */
function plannedRow(overrides: Partial<Record<0 | 1 | 2, Partial<GridRelease>>> = {}): GridRelease[] {
  const base: GridRelease[] = [
    { releaseId: 'r2', contentId: 'c2', ref: 'P-417', rowOrder: 2, status: 'planned', bundlePostId: null, bundleStatus: null, dueAt: '2026-10-01T15:00:00.000Z' },
    { releaseId: 'r1', contentId: 'c1', ref: 'P-418', rowOrder: 1, status: 'planned', bundlePostId: null, bundleStatus: null, dueAt: '2026-10-01T15:05:00.000Z' },
    { releaseId: 'r0', contentId: 'c0', ref: 'P-419', rowOrder: 0, status: 'planned', bundlePostId: null, bundleStatus: null, dueAt: '2026-10-01T15:10:00.000Z' },
  ];
  return base.map((r) => ({ ...r, ...(overrides[r.rowOrder as 0 | 1 | 2] ?? {}) }));
}

describe('what lands on the grid', () => {
  it('an Instagram feed post does; a story does not', () => {
    expect(landsOnInstagramGrid('instagram', 'feed')).toBe(true);
    expect(landsOnInstagramGrid('instagram', 'story')).toBe(false);
  });

  it('a legacy Instagram release (no destination) goes out as a POST or Reel, so it does', () => {
    expect(landsOnInstagramGrid('instagram', null)).toBe(true);
    expect(landsOnInstagramGrid('instagram', undefined)).toBe(true);
  });

  it('other platforms are not the Instagram grid', () => {
    expect(landsOnInstagramGrid('tiktok', 'feed')).toBe(false);
    expect(landsOnInstagramGrid('snapchat', null)).toBe(false);
  });

  it('a row is three tiles — the width of the profile grid', () => {
    expect(INSTAGRAM_GRID_COLUMNS).toBe(3);
  });
});

describe('when a row may go', () => {
  it('29–30 Sep: a post that belongs to no row is never sent on its own', () => {
    // P-150…P-157 had no row; each one alone is refused.
    expect(judgeRow(null, [])).toEqual({ kind: 'not_in_row' });
  });

  it('a planned row sends all three, in the row\'s order (writer\'s third post first)', () => {
    const v = judgeRow('row-1', plannedRow());
    expect(v.kind).toBe('send');
    if (v.kind !== 'send') return;
    expect(v.toSend.map((r) => r.ref)).toEqual(['P-417', 'P-418', 'P-419']);
    expect(v.alreadyOut).toEqual([]);
  });

  it('the order comes from the row, not from times someone changed', () => {
    // P-419 (read first) was moved earlier by hand; it must still go LAST.
    const v = judgeRow('row-1', plannedRow({ 0: { dueAt: '2026-10-01T14:00:00.000Z' } }));
    if (v.kind !== 'send') throw new Error(v.kind);
    expect(v.toSend.map((r) => r.ref)).toEqual(['P-417', 'P-418', 'P-419']);
  });

  it('a row with a cancelled post is short — it never goes', () => {
    const v = judgeRow('row-1', plannedRow({ 1: { status: 'cancelled' } }));
    expect(v.kind).toBe('malformed');
    if (v.kind === 'malformed') expect(v.live).toHaveLength(2);
  });

  it('a post with two feed releases makes the row malformed, not four tiles', () => {
    const rows = [...plannedRow(), { ...plannedRow()[0], releaseId: 'r2-dup' }];
    expect(judgeRow('row-1', rows).kind).toBe('malformed');
  });

  it('a row already partly out is completed by the rest — never left short', () => {
    const v = judgeRow('row-1', plannedRow({ 2: { status: 'published', bundlePostId: 'b2', bundleStatus: 'POSTED' } }));
    if (v.kind !== 'send') throw new Error(v.kind);
    expect(v.toSend.map((r) => r.ref)).toEqual(['P-418', 'P-419']);
    expect(v.alreadyOut.map((r) => r.ref)).toEqual(['P-417']);
  });

  it('a dead bundle post (ERROR / DELETED) is not out — it is sent again with its row', () => {
    expect(isAlreadyOut({ ...plannedRow()[0], bundlePostId: 'b', bundleStatus: 'ERROR' })).toBe(false);
    expect(isAlreadyOut({ ...plannedRow()[0], bundlePostId: 'b', bundleStatus: 'DELETED' })).toBe(false);
    expect(isAlreadyOut({ ...plannedRow()[0], bundlePostId: 'b', bundleStatus: 'SCHEDULED' })).toBe(true);
    expect(isAlreadyOut({ ...plannedRow()[0], status: 'published' })).toBe(true);
  });

  it('a row whose three posts are all out has nothing left to send', () => {
    const out = { status: 'scheduled', bundlePostId: 'b', bundleStatus: 'SCHEDULED' };
    expect(judgeRow('row-1', plannedRow({ 0: out, 1: out, 2: out })).kind).toBe('complete');
  });
});

describe('the times a row goes at', () => {
  it('handed off 15 minutes early by the sweep, the planned times are kept', () => {
    const now = at('2026-10-01T14:45:00.000Z'); // 17:45 Riyadh
    const v = judgeRow('row-1', plannedRow());
    if (v.kind !== 'send') throw new Error(v.kind);
    const dates = rowPostDates(v.toSend, now);
    expect([...dates.values()]).toEqual([
      '2026-10-01T15:00:00.000Z', '2026-10-01T15:05:00.000Z', '2026-10-01T15:10:00.000Z',
    ]);
  });

  it('approved at the last minute, the first post moves only as far as it must', () => {
    const now = at('2026-10-01T14:57:00.000Z'); // 17:57 — 18:00 is too close to hand off safely
    const v = judgeRow('row-1', plannedRow());
    if (v.kind !== 'send') throw new Error(v.kind);
    const dates = [...rowPostDates(v.toSend, now).values()].map(at);
    expect(dates[0]).toBe(now + ROW_LEAD_MS);
    expect(dates[1]).toBe(at('2026-10-01T15:05:00.000Z'));
    expect(dates[2]).toBe(at('2026-10-01T15:10:00.000Z'));
  });

  it('a held row sent the next day goes as one burst, in order, spaced apart', () => {
    const now = at('2026-10-02T09:00:00.000Z');
    const v = judgeRow('row-1', plannedRow());
    if (v.kind !== 'send') throw new Error(v.kind);
    const timing = rowTiming(v.toSend, now);
    if (!timing.ok) throw new Error('expected the row to go');
    const dates = [...timing.dates.values()].map(at);
    expect(dates).toEqual([now + ROW_LEAD_MS, now + ROW_LEAD_MS + ROW_MIN_GAP_MS, now + ROW_LEAD_MS + 2 * ROW_MIN_GAP_MS]);
  });

  it('one post moved a day later on its own: the rest wait instead of leaving the grid short', () => {
    const now = at('2026-10-01T14:45:00.000Z');
    const v = judgeRow('row-1', plannedRow({ 0: { dueAt: '2026-10-02T15:10:00.000Z' } }));
    if (v.kind !== 'send') throw new Error(v.kind);
    const timing = rowTiming(v.toSend, now);
    expect(timing.ok).toBe(false);
    if (!timing.ok) {
      expect(timing.latest).toBe('2026-10-02T15:10:00.000Z');
      expect(timing.en).toMatch(/not scheduled together/);
    }
  });

  it('…and when the moved post comes due, the others close up behind it', () => {
    const now = at('2026-10-02T14:55:00.000Z'); // the next evening, 15 min before the moved post
    const v = judgeRow('row-1', plannedRow({ 0: { dueAt: '2026-10-02T15:10:00.000Z' } }));
    if (v.kind !== 'send') throw new Error(v.kind);
    const timing = rowTiming(v.toSend, now);
    if (!timing.ok) throw new Error('expected the row to go');
    const dates = [...timing.dates.values()].map(at);
    expect(dates[0]).toBe(now + ROW_LEAD_MS);
    expect(dates[1]).toBe(now + ROW_LEAD_MS + ROW_MIN_GAP_MS);
    expect(dates[2]).toBe(at('2026-10-02T15:10:00.000Z'));
  });
});

describe('handing a row off — all of it, or none of it', () => {
  type Item = { id: string };
  const items = ['a', 'b', 'c'].map((id, i) => ({ item: { id }, postDate: `2026-10-01T15:0${i * 5}:00.000Z` }));

  function steps(opts: { failCreateAt?: number; failRecordAt?: number; stuck?: string[] } = {}) {
    const log: string[] = [];
    let n = 0;
    let r = 0;
    return {
      log,
      steps: {
        create: async (item: Item) => {
          if (n++ === opts.failCreateAt) throw new Error('Daily post limit reached');
          log.push(`create ${item.id}`);
          return { id: `post-${item.id}` };
        },
        record: async (item: Item) => {
          if (r++ === opts.failRecordAt) return 'update failed';
          log.push(`record ${item.id}`);
          return null;
        },
        takeBack: async (ids: string[]) => {
          log.push(`takeBack ${ids.join(',')}`);
          return ids.filter((id) => (opts.stuck ?? []).includes(id));
        },
        restore: async (ps: Item[]) => {
          log.push(`restore ${ps.map((p) => p.id).join(',')}`);
          return [];
        },
      },
    };
  }

  it('three ready posts are all handed off, in order', async () => {
    const s = steps();
    const res = await handOffRow(items, s.steps);
    expect(res.ok).toBe(true);
    expect(s.log).toEqual(['create a', 'create b', 'create c', 'record a', 'record b', 'record c']);
  });

  it('the platform refusing the second post takes the first one back', async () => {
    const s = steps({ failCreateAt: 1 });
    const res = await handOffRow(items, s.steps);
    expect(res).toMatchObject({ ok: false, stage: 'create', failedAt: 1, leftLive: [] });
    expect(s.log).toEqual(['create a', 'takeBack post-a']);
  });

  it('a failed save takes every scheduled post back and restores the rows already saved', async () => {
    const s = steps({ failRecordAt: 2 });
    const res = await handOffRow(items, s.steps);
    expect(res).toMatchObject({ ok: false, stage: 'record', failedAt: 2, leftLive: [], unrestored: [] });
    expect(s.log).toEqual([
      'create a', 'create b', 'create c', 'record a', 'record b',
      'takeBack post-a,post-b,post-c', 'restore a,b',
    ]);
  });

  it('a post that could not be taken back is reported — never assumed gone', async () => {
    const s = steps({ failCreateAt: 2, stuck: ['post-b'] });
    const res = await handOffRow(items, s.steps);
    expect(res).toMatchObject({ ok: false, stage: 'create', leftLive: ['post-b'] });
  });
});
