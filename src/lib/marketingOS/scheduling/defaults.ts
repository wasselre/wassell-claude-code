/**
 * Default workflow shapes + step EFFORT estimates.
 *
 * Effort is an explicit estimate of how long the work takes, in working days.
 * It is deliberately NOT the step's `due_days` — that is a deadline allowance
 * ("you have two days to get to it"), and using it as effort was the v2 mistake
 * the second review caught. These are seeds for `mos_step_effort`; the manager
 * edits them in Settings → Capacity, and §19's accuracy view re-seeds them from
 * measured medians after the first campaign.
 *
 * PURE.
 */
import type { StepSpec, WorkflowSpec } from './types';

const s = (
  key: string, roleKey: StepSpec['roleKey'], isApproval: boolean, workingDays: number,
  labelAr: string, labelEn: string, afterReady = false,
): StepSpec => ({ key, roleKey, isApproval, workingDays, labelAr, labelEn, afterReady });

/**
 * «مسار المنشور القياسي» — the live post/carousel/story path.
 *
 * It ENDS at the manager's final approval. `scheduling` and `publish_check`
 * were removed on 2026-09-14: putting a creative out is a RELEASE, modelled in
 * `releases.ts` as one job per destination per date, not a tail on the
 * production chain. One pair of steps could never describe N destinations, and
 * every paid creative was booking them for work its path never reaches.
 */
export const POST_WORKFLOW: WorkflowSpec = {
  workflowKey: 'post_std',
  bucket: 'post',
  steps: [
    s('writing', 'writer', false, 1, 'كتابة', 'Writing'),
    s('writing_review', 'marketing_manager', true, 1, 'مراجعة الكتابة', 'Writing review'),
    s('design', 'montage', false, 2, 'تصميم', 'Design'),
    s('design_writer_review', 'writer', true, 1, 'مراجعة الكاتب', 'Writer review'),
    s('design_review', 'marketing_manager', true, 1, 'الاعتماد النهائي', 'Final approval'),
  ],
};

/** «مسار الفيديو القياسي». Ends at final approval — see the note on POST_WORKFLOW. */
export const VIDEO_WORKFLOW: WorkflowSpec = {
  workflowKey: 'video_std',
  bucket: 'video',
  steps: [
    s('idea', 'writer', false, 1, 'الفكرة', 'Idea'),
    s('idea_review', 'marketing_manager', true, 1, 'مراجعة الفكرة', 'Idea review'),
    s('script', 'writer', false, 2, 'النص', 'Script'),
    s('script_review', 'marketing_manager', true, 1, 'مراجعة النص', 'Script review'),
    s('assets', 'ops_supervisor', false, 2, 'جمع المواد', 'Asset collection'),
    s('editing', 'montage', false, 3, 'المونتاج والتعليق', 'Editing + VO'),
    s('first_version', 'montage', false, 1, 'النسخة الأولى', 'First version'),
    s('writer_review', 'writer', true, 1, 'مراجعة الكاتب', 'Writer review'),
    s('review', 'marketing_manager', true, 1, 'الاعتماد النهائي', 'Final approval'),
  ],
};

export const DEFAULT_WORKFLOWS: Record<string, WorkflowSpec> = {
  post_std: POST_WORKFLOW,
  video_std: VIDEO_WORKFLOW,
};

/** Content-type key → the workflow that drives it (mirrors `mos_content_types`). */
export const CONTENT_TYPE_WORKFLOW: Record<string, string> = {
  post: 'post_std',
  carousel: 'post_std',
  story: 'post_std',
  video: 'video_std',
};

/** Content-type key → capacity bucket (mirrors `mos_load_buckets`). */
export const CONTENT_TYPE_BUCKET: Record<string, 'post' | 'video'> = {
  post: 'post',
  carousel: 'post',
  story: 'post',
  video: 'video',
};

/**
 * Sum of a workflow's production effort — the natural lead time for a creative.
 *
 * The `afterReady` filter is kept although the shipped workflows no longer have
 * such steps: content pinned to an OLDER version still carries them, and they
 * must never be counted as production effort.
 */
export function productionLeadWorkingDays(wf: WorkflowSpec): number {
  return wf.steps.filter((x) => !x.afterReady).reduce((a, b) => a + b.workingDays, 0);
}
