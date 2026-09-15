/**
 * The row's pure rules.
 *
 * Three of them are load-bearing and all three are easy to get subtly wrong:
 *
 *  - `missingForStep` must agree with `workflow_advance_role_path` EXACTLY, or
 *    the submit button lies in one direction (blocking work the engine would
 *    accept) or the other (offering a send the engine will refuse).
 *  - `rowFaceOf` decides which pane a person sees, structurally rather than by
 *    step name, so a workflow rename cannot silently change behaviour.
 *  - `publishPosition` is the "first-read publishes last" rule, stated once.
 */
import { describe, expect, it } from 'vitest';
import type { MosStep } from '../client';
import {
  missingForStep, publishPosition, rowFaceOf,
  type MosRowMember,
} from '../rowClient';

const step = (over: Partial<MosStep> & { key: string }): MosStep => ({
  id: over.key,
  workflow_id: 'wf',
  position: 1,
  label_ar: '',
  label_en: '',
  role: 'writer',
  due_days: 1,
  is_approval: false,
  approval_kind: null,
  required_fields: [],
  required_files: [],
  ...over,
});

const member = (id: string, data: Record<string, unknown>): MosRowMember => ({
  id,
  ref: `P-${id}`,
  title: `post ${id}`,
  content_type_key: 'post',
  content_type_label_ar: '',
  content_type_label_en: '',
  project_id: null,
  project_ids: [],
  campaign_id: null,
  purpose: 'organic',
  organic_platforms: [],
  status_key: 'writing',
  current_step_label_ar: null,
  current_step_label_en: null,
  owner_role: 'writer',
  current_assignee_user_id: null,
  current_task_due_at: null,
  current_round: 1,
  due_at: null,
  target_publish_at: null,
  updated_at: '2026-10-01T00:00:00Z',
  row_id: 'row-1',
  row_order: 0,
  data,
  caption: null,
  caption_confirmed: null,
});

const link = (contentId: string, role: string) => ({
  asset_id: `a-${contentId}-${role}`,
  content_id: contentId,
  role: role as 'final_square' | 'final_vertical',
});

describe('missingForStep — the engine\'s rule, locally', () => {
  it('a step that requires nothing blocks nothing', () => {
    const detail = { members: [member('1', {})], links: [] };
    expect(missingForStep(detail, step({ key: 'writing_review', is_approval: true }))).toEqual([]);
  });

  it('names the member AND the slot for every empty design slot', () => {
    const detail = {
      members: [member('1', {}), member('2', {})],
      links: [link('1', 'final_square'), link('1', 'final_vertical'), link('2', 'final_square')],
    };
    const gaps = missingForStep(detail, step({
      key: 'design', required_files: ['final_square', 'final_vertical'],
    }));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.member.id).toBe('2');
    expect(gaps[0]?.key).toBe('final_vertical');
  });

  it('an absent field is missing; an empty string is missing', () => {
    const detail = {
      members: [member('1', { headlines: ['a'] }), member('2', { headlines: '   ' })],
      links: [],
    };
    const gaps = missingForStep(detail, step({ key: 'writing', required_fields: ['headlines'] }));
    expect(gaps.map((g) => g.member.id)).toEqual(['2']);
  });

  it('an EMPTY ARRAY counts as present — the same looseness `data ->> key` has', () => {
    // `data ->> 'headlines'` on `[]` is the text '[]', which is not empty, so
    // the engine accepts it. Disagreeing here would block a send the server
    // would have allowed.
    const detail = { members: [member('1', { headlines: [] })], links: [] };
    expect(missingForStep(detail, step({ key: 'writing', required_fields: ['headlines'] }))).toEqual([]);
  });

  it('requiring `caption` also requires the writer to have confirmed THAT text', () => {
    const drafted = member('1', { caption: 'نص', caption_confirmed_text: '' });
    const stale = member('2', { caption: 'نص جديد', caption_confirmed_text: 'نص قديم' });
    const done = member('3', { caption: 'نص', caption_confirmed_text: 'نص' });
    const gaps = missingForStep(
      { members: [drafted, stale, done], links: [] },
      step({ key: 'writing', required_fields: ['caption'] }),
    );
    expect(gaps.filter((g) => g.key === 'caption_confirmed').map((g) => g.member.id))
      .toEqual(['1', '2']);
    // The draft ones are not ALSO reported as an empty caption — they have text.
    expect(gaps.filter((g) => g.key === 'caption')).toEqual([]);
  });

  it('no step means no opinion', () => {
    expect(missingForStep({ members: [member('1', {})], links: [] }, null)).toEqual([]);
  });
});

describe('rowFaceOf — structural, never by step name', () => {
  const path: MosStep[] = [
    step({ key: 'writing', position: 1, required_fields: ['caption', 'headlines'] }),
    step({ key: 'writing_review', position: 2, is_approval: true }),
    step({ key: 'design', position: 3, required_files: ['final_square', 'final_vertical'] }),
    step({ key: 'design_review', position: 4, is_approval: true }),
  ];

  it('an approval BEFORE any file-bearing step is the writing review', () => {
    expect(rowFaceOf(path, 'writing_review')).toBe('writing_review');
  });

  it('an approval AFTER a file-bearing step is the final approval', () => {
    expect(rowFaceOf(path, 'design_review')).toBe('final_approval');
  });

  it('the file-bearing making step is the design face whatever it is called', () => {
    const renamed = path.map((s) => (s.key === 'design' ? { ...s, key: 'first_version' } : s));
    expect(rowFaceOf(renamed, 'first_version')).toBe('design');
  });

  it('the field-bearing making step is the writing face', () => {
    expect(rowFaceOf(path, 'writing')).toBe('writing');
  });

  it('an unknown or absent step has no face', () => {
    expect(rowFaceOf(path, 'nonsense')).toBe('other');
    expect(rowFaceOf(path, null)).toBe('other');
  });

  it('reads the path in POSITION order, not array order', () => {
    const shuffled = [...path].reverse();
    expect(rowFaceOf(shuffled, 'design_review')).toBe('final_approval');
    expect(rowFaceOf(shuffled, 'writing_review')).toBe('writing_review');
  });
});

describe('publishPosition — the first-read post publishes last', () => {
  it('reverses the reading order', () => {
    expect(publishPosition(0, 3)).toBe(3);
    expect(publishPosition(1, 3)).toBe(2);
    expect(publishPosition(2, 3)).toBe(1);
  });
});
