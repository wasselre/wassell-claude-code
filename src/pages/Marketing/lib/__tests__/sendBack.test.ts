import { describe, it, expect } from 'vitest';
import { latestSendBack, redesignedSince } from '../sendBack';
import type { MosRowMember, MosSubjectTask } from '@/lib/marketingOS/rowClient';

/**
 * The 22 Sep يمام 17 batch, as it stood on 27 Sep: written, approved,
 * designed, then sent back from the design check with «المربع مكتوب فيه النرجس
 * بدال النزهة» on post 1's lines — and the round-2 design task still open.
 */
const POST1 = '04c6daae-506a-4707-b406-e84b1bcc883e';
const members = [POST1, 'post-2', 'post-3']
  .map((id) => ({ id, title: id }) as unknown as MosRowMember);

const task = (over: Partial<MosSubjectTask>): MosSubjectTask => ({
  id: 't', content_id: null, subject_table: 'mos_content_rows', subject_id: 'row-22', row_id: 'row-22',
  step_id: 'design', role: 'montage', assignee_user_id: null, status: 'done', result: null, note: null,
  round: 1, opened_at: '2026-09-20T10:54:00+00:00', due_at: null, closed_at: null, revision_targets: [],
  ...over,
});

const writing = task({ id: 'w', step_id: 'writing', role: 'writer', result: 'submitted', closed_at: '2026-09-20T15:10:00+00:00' });
const approve = task({ id: 'a', step_id: 'writing_review', role: 'marketing_manager', result: 'approved', closed_at: '2026-09-20T15:40:00+00:00' });
const design1 = task({ id: 'd1', result: 'submitted', closed_at: '2026-09-21T08:06:00+00:00' });
const check = task({
  id: 'c', step_id: 'design_writer_review', role: 'writer', result: 'changes_requested',
  note: 'المربع مكتوب فيه النرجس بدال النزهة', closed_at: '2026-09-21T09:05:36+00:00',
  closed_by_user_id: 'admin', revision_targets: [`post:${POST1}:headlines`],
});
const design2 = task({ id: 'd2', status: 'open', round: 2, opened_at: '2026-09-21T09:05:36+00:00' });

describe('the send-back a row is answering', () => {
  it('reads the note and the named post off the CLOSED review — the 22 Sep batch', () => {
    const sb = latestSendBack({ task: design2, row_tasks: [design2, check, design1, approve, writing], members });
    expect(sb?.note).toBe('المربع مكتوب فيه النرجس بدال النزهة');
    expect(sb?.review.id).toBe('c');
    expect(sb?.posts).toEqual([{ memberId: POST1, index: 0, fields: ['headlines'] }]);
    expect(sb?.otherTargets).toEqual([]);
  });

  it('goes away once the fixed work is submitted', () => {
    const resubmitted = task({ id: 'd2', result: 'submitted', round: 2, closed_at: '2026-09-28T07:00:00+00:00' });
    const final = task({ id: 'f', step_id: 'design_review', status: 'open', round: 2 });
    expect(latestSendBack({ task: final, row_tasks: [final, resubmitted, check, design1], members })).toBeNull();
  });

  it('is null with no open task, and for a first round nobody sent back', () => {
    expect(latestSendBack({ task: null, row_tasks: [check], members })).toBeNull();
    const firstRound = task({ id: 'd1', status: 'open' });
    expect(latestSendBack({ task: firstRound, row_tasks: [firstRound, approve, writing], members })).toBeNull();
  });

  it('reads a whole-post target, keeps posts in reading order, and keeps targets that name no post', () => {
    const multi = task({
      ...check,
      revision_targets: ['post:post-3', `post:${POST1}:caption`, `post:${POST1}:headlines`, 'post:gone:caption', 'scene:s1'],
    });
    const sb = latestSendBack({ task: design2, row_tasks: [design2, multi], members });
    expect(sb?.posts).toEqual([
      { memberId: POST1, index: 0, fields: ['caption', 'headlines'] },
      { memberId: 'post-3', index: 2, fields: [] },
      { memberId: 'gone', index: -1, fields: ['caption'] },
    ]);
    expect(sb?.otherTargets).toEqual(['scene:s1']);
  });

  it('treats a blank note as no note', () => {
    const blank = task({ ...check, note: '   ' });
    expect(latestSendBack({ task: design2, row_tasks: [design2, blank], members })?.note).toBeNull();
  });
});

describe('has the named post been redesigned since the note?', () => {
  const since = check.closed_at;
  it('not while its slots still hold round 1’s files', () => {
    const links = [
      { content_id: POST1, role: 'final_vertical', created_at: '2026-09-20T23:08:00+00:00' },
      { content_id: POST1, role: 'final_square', created_at: '2026-09-20T23:57:00+00:00' },
    ];
    expect(redesignedSince(links, POST1, since)).toBe(false);
  });

  it('yes once a final slot gets a file after the note — a source file does not count', () => {
    expect(redesignedSince([{ content_id: POST1, role: 'source', created_at: '2026-09-28T06:00:00+00:00' }], POST1, since)).toBe(false);
    expect(redesignedSince([{ content_id: POST1, role: 'final_square', created_at: '2026-09-28T06:00:00+00:00' }], POST1, since)).toBe(true);
    expect(redesignedSince([{ content_id: 'post-2', role: 'final_square', created_at: '2026-09-28T06:00:00+00:00' }], POST1, since)).toBe(false);
  });
});
