/**
 * The routing contract, pinned.
 *
 * These tests exist because every bug they cover shipped: a step UUID fed into
 * a key-matching resolver (so the content page's auto-tab never fired), a
 * `?tab=publish` that no tab renders (so notification links opened a summary),
 * and two surfaces disagreeing about where a FINISHED item lives.
 */
import { describe, expect, it } from 'vitest';
import {
  actionOfTask,
  contentHref,
  normalizeContentHref,
  normalizeTab,
  previewTargetOfTask,
  DONE_SECTION,
  sectionForStep,
  stepKeyOfRow,
  tabForSection,
  taskHref,
  type RouteStep,
} from '../contentRoute';
import { phaseOfStep, tabForPhase } from '../stagePhase';

/**
 * The POST path: the writer writes, the manager reviews the copy, the editor
 * designs, the writer checks the design, the manager gives the final approval,
 * then it is scheduled and published.
 */
const POST_STEPS: RouteStep[] = [
  { key: 'write_copy',      role: 'writer',            is_approval: false },
  { key: 'review_copy',     role: 'marketing_manager', is_approval: true },
  { key: 'design_slides',   role: 'montage',           is_approval: false },
  { key: 'writer_check',    role: 'writer',            is_approval: true },
  { key: 'approve_final',   role: 'marketing_manager', is_approval: true },
  { key: 'schedule_post',   role: 'ops_supervisor',    is_approval: false },
  { key: 'publish_confirm', role: 'ops_supervisor',    is_approval: false },
];

/** The VIDEO path: a brief, a script and its approval, then editing and cuts. */
const VIDEO_STEPS: RouteStep[] = [
  { key: 'write_brief',      role_key: 'writer',            is_approval: false },
  { key: 'write_script',     role_key: 'writer',            is_approval: false },
  { key: 'approve_script',   role_key: 'marketing_manager', is_approval: true },
  { key: 'prepare_assets',   role_key: 'ops_supervisor',    is_approval: false },
  { key: 'edit_video',       role_key: 'montage',           is_approval: false },
  { key: 'review_video',     role_key: 'writer',            is_approval: true },
  { key: 'approve_final_v',  role_key: 'marketing_manager', is_approval: true },
  { key: 'schedule_publication', role_key: 'ops_supervisor', is_approval: false },
];

describe('sectionForStep — the post path', () => {
  it('maps every step key to its own section', () => {
    expect(sectionForStep(POST_STEPS, 'write_copy')).toBe('writing');
    expect(sectionForStep(POST_STEPS, 'review_copy')).toBe('writing_review');
    expect(sectionForStep(POST_STEPS, 'design_slides')).toBe('design_upload');
    expect(sectionForStep(POST_STEPS, 'writer_check')).toBe('design_review_writer');
    expect(sectionForStep(POST_STEPS, 'approve_final')).toBe('final_review');
    expect(sectionForStep(POST_STEPS, 'schedule_post')).toBe('schedule');
    expect(sectionForStep(POST_STEPS, 'publish_confirm')).toBe('publish_check');
  });

  it('lands each section on the tab that holds its work', () => {
    expect(tabForSection(sectionForStep(POST_STEPS, 'write_copy'))).toBe('content');
    expect(tabForSection(sectionForStep(POST_STEPS, 'review_copy'))).toBe('content');
    expect(tabForSection(sectionForStep(POST_STEPS, 'design_slides'))).toBe('materials');
    expect(tabForSection(sectionForStep(POST_STEPS, 'writer_check'))).toBe('materials');
    expect(tabForSection(sectionForStep(POST_STEPS, 'approve_final'))).toBe('materials');
    expect(tabForSection(sectionForStep(POST_STEPS, 'schedule_post'))).toBe('placements');
  });
});

describe('sectionForStep — the video path', () => {
  it('keeps the whole script half in writing, whichever role owns it', () => {
    expect(sectionForStep(VIDEO_STEPS, 'write_brief')).toBe('writing');
    expect(sectionForStep(VIDEO_STEPS, 'write_script')).toBe('writing');
    expect(sectionForStep(VIDEO_STEPS, 'approve_script')).toBe('writing_review');
  });

  it('flips to design at the first production step and stays there', () => {
    // `prepare_assets` is owned by ops — a production role — so the design
    // half starts there, not at the editor's own step.
    expect(sectionForStep(VIDEO_STEPS, 'prepare_assets')).toBe('design_upload');
    expect(sectionForStep(VIDEO_STEPS, 'edit_video')).toBe('design_upload');
    expect(sectionForStep(VIDEO_STEPS, 'review_video')).toBe('design_review_writer');
    expect(sectionForStep(VIDEO_STEPS, 'approve_final_v')).toBe('final_review');
  });

  it('ends on scheduling', () => {
    expect(sectionForStep(VIDEO_STEPS, 'schedule_publication')).toBe('schedule');
  });
});

describe('sectionForStep — keys the pinned list no longer contains', () => {
  it('falls back to a keyword guess rather than nowhere', () => {
    expect(sectionForStep(POST_STEPS, 'some_ancient_design_step')).toBe('design_upload');
    expect(sectionForStep(POST_STEPS, 'legacy_schedule')).toBe('schedule');
    expect(sectionForStep(POST_STEPS, 'write_the_caption')).toBe('caption');
    expect(sectionForStep(POST_STEPS, 'مراجعة النص')).toBe('writing_review');
    expect(sectionForStep(POST_STEPS, 'totally_unknown')).toBe('writing');
  });

  it('treats a missing / empty step as no stage at all', () => {
    expect(sectionForStep(POST_STEPS, null)).toBe('overview');
    expect(sectionForStep(POST_STEPS, undefined)).toBe('overview');
    expect(sectionForStep(POST_STEPS, '')).toBe('overview');
  });

  it('works with no pinned list at all', () => {
    expect(sectionForStep(undefined, 'design_slides')).toBe('design_upload');
    expect(sectionForStep(null, 'write_copy')).toBe('writing');
  });
});

describe('the finished-item rule', () => {
  it('always resolves to the final materials, whatever the last step was', () => {
    expect(contentHref({ id: 'c1', status_key: 'done' }, POST_STEPS))
      .toBe('/m/content/c1?tab=materials&step=materials_final');
    // Same answer with no step list, and same answer when a stale step key is
    // still hanging off the row — the two surfaces that used to disagree
    // (the preview said materials, the detail page said placements).
    expect(contentHref({ id: 'c1', status_key: 'done', current_step_key: 'schedule_post' }))
      .toBe('/m/content/c1?tab=materials&step=materials_final');
  });

  it('resolves the same way from a task', () => {
    expect(taskHref({ content_id: 'c1', status: 'open', content_status_key: 'done' }, POST_STEPS))
      .toBe('/m/content/c1?tab=materials&step=materials_final');
  });

  it('reads `done` as a step key too', () => {
    expect(sectionForStep(POST_STEPS, 'done')).toBe('materials_final');
  });
});

describe('contentHref', () => {
  it('carries the step KEY, never a UUID', () => {
    expect(contentHref({ id: 'c2', status_key: 'design_slides' }, POST_STEPS))
      .toBe('/m/content/c2?tab=materials&step=design_slides');
  });

  it('never invents a step key out of a synthetic status', () => {
    // `draft` / `unassigned` are statuses `mos_content_v` invents when there is
    // no open step. Nothing has started, so the overview — not a working tab —
    // is the honest destination, and `?step=` stays off the URL entirely.
    expect(stepKeyOfRow({ id: 'c3', status_key: 'draft' })).toBeNull();
    expect(contentHref({ id: 'c3', status_key: 'draft' }, POST_STEPS))
      .toBe('/m/content/c3?tab=overview');
    expect(contentHref({ id: 'c3', status_key: 'unassigned' }, POST_STEPS))
      .toBe('/m/content/c3?tab=overview');
  });

  it('honours an explicit section over the row\'s own step', () => {
    expect(contentHref({ id: 'c4', status_key: 'write_copy' }, POST_STEPS, { section: 'caption' }))
      .toBe('/m/content/c4?tab=content&step=write_copy');
    expect(contentHref({ id: 'c4' }, POST_STEPS, { section: 'schedule' }))
      .toBe('/m/content/c4?tab=placements&step=schedule');
  });
});

describe('the ?tab=publish remap', () => {
  it('accepts `publish` and lands it on the placements tab', () => {
    expect(normalizeTab('publish')).toBe('placements');
    expect(normalizeTab('publishing')).toBe('placements');
  });

  it('leaves every real tab alone', () => {
    for (const t of ['overview', 'content', 'placements', 'materials', 'tasks', 'performance', 'creative']) {
      expect(normalizeTab(t)).toBe(t);
    }
  });

  it('falls back to overview for a tab nobody renders', () => {
    expect(normalizeTab('nonsense')).toBe('overview');
    expect(normalizeTab(null)).toBe('overview');
  });

  it('repairs an old notification URL in place', () => {
    expect(normalizeContentHref('/m/content/abc?tab=publish'))
      .toBe('/m/content/abc?tab=placements');
    expect(normalizeContentHref('/m/content/abc?tab=publish&step=schedule_post'))
      .toBe('/m/content/abc?tab=placements&step=schedule_post');
  });

  it('drops a step UUID — it can never match a key', () => {
    expect(normalizeContentHref('/m/content/abc?tab=materials&step=6f9619ff-8b86-d011-b42d-00cf4fc964ff'))
      .toBe('/m/content/abc?tab=materials');
  });

  it('passes anything else through untouched', () => {
    expect(normalizeContentHref('/m/campaigns/xyz?tab=publish')).toBe('/m/campaigns/xyz?tab=publish');
    expect(normalizeContentHref('/m/content/abc')).toBe('/m/content/abc');
    expect(normalizeContentHref('/m/content/abc?tab=materials&step=design_slides'))
      .toBe('/m/content/abc?tab=materials&step=design_slides');
  });
});

describe('tasks', () => {
  it('resolves a workflow task by its step UUID when the pinned list is passed', () => {
    const steps = POST_STEPS.map((s, i) => ({ ...s, id: `id-${i}` }));
    const task = { content_id: 'c5', step_id: 'id-2', status: 'open' };
    expect(taskHref(task, steps)).toBe('/m/content/c5?tab=materials&step=design_slides');
    expect(previewTargetOfTask(task, steps)).toEqual({ contentId: 'c5', section: 'design_upload' });
  });

  it('routes a task whose step key is unknown to a keyword guess, never nowhere', () => {
    const task = { content_id: 'c6', step_key: 'ancient_montage_step', status: 'open' };
    expect(previewTargetOfTask(task, POST_STEPS)).toEqual({ contentId: 'c6', section: 'design_upload' });
    expect(taskHref(task, POST_STEPS)).toBe('/m/content/c6?tab=materials&step=ancient_montage_step');
    expect(actionOfTask(task, POST_STEPS)).toBe('work');
  });

  it('opens a COMPLETED task on the final materials', () => {
    const task = { content_id: 'c7', step_key: 'review_copy', status: 'done' };
    expect(previewTargetOfTask(task, POST_STEPS)).toEqual({ contentId: 'c7', section: 'materials_final' });
    expect(taskHref(task, POST_STEPS)).toBe('/m/content/c7?tab=materials&step=materials_final');
    expect(actionOfTask(task, POST_STEPS)).toBe('view');
  });

  it('names the action from the step, the kind, or an explicit stamp', () => {
    expect(actionOfTask({ content_id: 'c', step_key: 'write_copy', status: 'open' }, POST_STEPS)).toBe('work');
    expect(actionOfTask({ content_id: 'c', step_key: 'review_copy', status: 'open' }, POST_STEPS)).toBe('review');
    expect(actionOfTask({ content_id: 'c', kind: 'caption_review', status: 'open' })).toBe('caption_review');
    expect(actionOfTask({ kind: 'manual', status: 'open' })).toBe('complete');
    expect(actionOfTask({ content_id: 'c', kind: 'manual', action: 'review', status: 'open' })).toBe('review');
  });

  it('routes the new planning task kinds sensibly', () => {
    expect(actionOfTask({ kind: 'refresh_decision', entity_kind: 'refresh_cycle', entity_id: 'r1', status: 'open' }))
      .toBe('refresh_decision');
    expect(taskHref({ kind: 'refresh_decision', entity_kind: 'refresh_cycle', entity_id: 'r1', status: 'open' }))
      .toBe('/m/my-work?task=r1');
    expect(taskHref({ kind: 'plan_conflict', entity_kind: 'campaign', entity_id: 'k1', status: 'open' }))
      .toBe('/m/month');
    expect(taskHref({ kind: 'ad_failed', entity_kind: 'content', entity_id: 'c8', status: 'open' }))
      .toBe('/m/content/c8?tab=placements&step=publish_check');
    expect(previewTargetOfTask({ kind: 'ad_failed', entity_kind: 'content', entity_id: 'c8', status: 'open' }))
      .toEqual({ contentId: 'c8', section: 'publish_check' });
  });

  it('a publication task opens its own screen, one per destination', () => {
    // One release, one destination, one screen. It must NOT land on the content
    // record: the publisher needs the finished material, the destination and
    // the platform rules, not the brief that produced it.
    expect(taskHref({
      kind: 'publish', entity_kind: 'publication', entity_id: 'pub-1', status: 'open',
      content_id: 'c9',
    })).toBe('/m/releases/pub-1');

    // Two destinations for the SAME creative are two different screens — the
    // defect this split exists to fix was both sharing one task.
    expect(taskHref({
      kind: 'publish', entity_kind: 'publication', entity_id: 'pub-2', status: 'open',
      content_id: 'c9',
    })).toBe('/m/releases/pub-2');
  });

  it('a publication task asks you to publish, and previews the FINISHED material', () => {
    const task = {
      kind: 'publish', entity_kind: 'publication', entity_id: 'pub-1',
      content_id: 'c9', status: 'open',
    } as const;
    expect(actionOfTask(task)).toBe('publish');
    // The creative is already approved by the time a release exists, so the
    // preview shows what is going out rather than a production step.
    expect(previewTargetOfTask(task)).toEqual({ contentId: 'c9', section: DONE_SECTION });
  });

  it('a closed publication task reads as view, like every other closed task', () => {
    expect(actionOfTask({
      kind: 'publish', entity_kind: 'publication', entity_id: 'pub-1', status: 'done',
    })).toBe('view');
  });

  it('never dead-ends: a task pointing at nothing goes to my work', () => {
    expect(taskHref({ kind: 'manual', status: 'open' })).toBe('/m/my-work');
    expect(previewTargetOfTask({ kind: 'manual', status: 'open' })).toBeNull();
  });
});

describe('stagePhase back-compat', () => {
  it('still answers the three-bucket question through the new resolver', () => {
    expect(phaseOfStep(POST_STEPS as never, 'write_copy')).toBe('writing');
    expect(phaseOfStep(POST_STEPS as never, 'review_copy')).toBe('writing');
    expect(phaseOfStep(POST_STEPS as never, 'design_slides')).toBe('design');
    expect(phaseOfStep(POST_STEPS as never, 'writer_check')).toBe('design');
    expect(phaseOfStep(POST_STEPS as never, 'schedule_post')).toBe('publish');
    expect(phaseOfStep(POST_STEPS as never, 'unknown_key')).toBe('writing');
  });

  it('keeps the phase → tab mapping it always had', () => {
    expect(tabForPhase('writing')).toBe('content');
    expect(tabForPhase('design')).toBe('materials');
    expect(tabForPhase('publish')).toBe('placements');
  });
});
