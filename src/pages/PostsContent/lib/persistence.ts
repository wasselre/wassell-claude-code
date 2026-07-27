/**
 * Mapping between the writer page's in-memory posts and `posts_content` /
 * `posts_batches` records.
 *
 * Kept out of the page component so the record shape lives in one place — the
 * page, the batch-reopen path and the tests all go through these functions.
 */

import { v4 as uuid } from 'uuid';
import type { AppRecord } from '@/types';
import type { GeneratedPost } from '@/lib/postsContent/facts';
import type { PostLanguage, QuantityMode } from '@/lib/postsContent/planning';
import type { PostTone } from '@/lib/postsContent/templates';

export type ReviewStatus = 'draft' | 'approved' | 'rejected';
export type CardStatus = 'pending' | 'generating' | 'ready' | 'error';

export interface RejectionInfo {
  reason: string;
  note: string;
}

export interface PostState {
  /** `${ourProjectId}:${postNumber}` — stable across retries and reorders. */
  key: string;
  ourProjectId: string;
  /** all_projects id, for the record's `project` lookup. */
  allProjectId: string | null;
  projectName: string;
  angle: string;
  variationIndex: number;
  postNumber: number;
  cardStatus: CardStatus;
  post: GeneratedPost | null;
  error?: string;
  recordId: string | null;
  review: ReviewStatus;
  rejection?: RejectionInfo;
}

export interface BatchContext {
  batchRecordId: string;
  batchId: string;
  tone: PostTone;
  language: PostLanguage;
  actorName: string;
}

/** Build (or refresh) the `posts_content` record for one generated post. */
export function postToRecord(
  modelId: string,
  state: PostState,
  ctx: BatchContext,
  existing?: AppRecord | null,
): AppRecord {
  const now = new Date().toISOString();
  const p = state.post;
  const prevData = existing?.data ?? {};
  return {
    id: existing?.id ?? state.recordId ?? uuid(),
    model_id: modelId,
    data: {
      ...prevData,
      headline_ar: p?.headline_ar ?? '',
      headline_en: p?.headline_en ?? '',
      body_ar: p?.body_ar ?? '',
      body_en: p?.body_en ?? '',
      prose_ar: p?.prose_ar ?? '',
      prose_en: p?.prose_en ?? '',
      spec_ar: p?.spec_ar ?? '',
      spec_en: p?.spec_en ?? '',
      project: state.allProjectId,
      angle: state.angle,
      tone: ctx.tone,
      language: ctx.language,
      status: state.review,
      post_number: state.postNumber,
      batch: ctx.batchRecordId,
      batch_id: ctx.batchId,
      source_project_id: state.ourProjectId,
      grounded: p?.grounded ?? false,
      evidence: (p?.evidence ?? []).join('، '),
      used_fact_ids: (p?.used_fact_ids ?? []).join(','),
      generated_at: now,
      generated_by: p?.generated_by ?? '',
      // Approval/rejection provenance is only ever written by the actions that
      // cause it (see applyReview) — never reset by a regeneration.
      approved_at: prevData.approved_at ?? null,
      approved_by: prevData.approved_by ?? null,
      rejected_at: prevData.rejected_at ?? null,
      rejected_by: prevData.rejected_by ?? null,
      rejection_reason: prevData.rejection_reason ?? null,
      rejection_feedback: prevData.rejection_feedback ?? null,
    },
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}

/**
 * Apply an approve / unapprove / reject / restore transition to a record.
 *
 * Unapprove returns a post to `draft` — it is explicitly NOT a rejection, so it
 * clears the approval stamp without writing a rejection stamp.
 */
export function applyReview(
  record: AppRecord,
  next: ReviewStatus,
  actorName: string,
  rejection?: RejectionInfo,
): AppRecord {
  const now = new Date().toISOString();
  const data: Record<string, unknown> = { ...record.data, status: next };
  if (next === 'approved') {
    data.approved_at = now;
    data.approved_by = actorName;
    data.rejected_at = null;
    data.rejected_by = null;
    data.rejection_reason = null;
    data.rejection_feedback = null;
  } else if (next === 'rejected') {
    data.rejected_at = now;
    data.rejected_by = actorName;
    data.rejection_reason = rejection?.reason ?? 'other';
    data.rejection_feedback = rejection?.note ?? '';
    data.approved_at = null;
    data.approved_by = null;
  } else {
    // draft — clear both stamps; a draft carries no review verdict.
    data.approved_at = null;
    data.approved_by = null;
    data.rejected_at = null;
    data.rejected_by = null;
  }
  return { ...record, data, updated_at: now };
}

/** Persist a body edit without touching review state. */
export function applyEdit(record: AppRecord, lang: 'ar' | 'en', body: string): AppRecord {
  const now = new Date().toISOString();
  return {
    ...record,
    data: { ...record.data, [lang === 'ar' ? 'body_ar' : 'body_en']: body, edited_at: now },
    updated_at: now,
  };
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Rebuild a page-level post from a stored record (reopening a batch). */
export function recordToPostState(record: AppRecord, projectName: string): PostState {
  const d = record.data ?? {};
  const ourProjectId = asStr(d.source_project_id);
  const postNumber = typeof d.post_number === 'number' ? d.post_number : 0;
  const language: PostLanguage =
    d.language === 'en' ? 'en' : d.language === 'both' ? 'both' : 'ar';
  const review: ReviewStatus =
    d.status === 'approved' ? 'approved' : d.status === 'rejected' ? 'rejected' : 'draft';
  return {
    key: `${ourProjectId}:${postNumber}`,
    ourProjectId,
    allProjectId: typeof d.project === 'string' ? d.project : null,
    projectName,
    angle: asStr(d.angle),
    variationIndex: 0,
    postNumber,
    cardStatus: 'ready',
    recordId: record.id,
    review,
    rejection: review === 'rejected'
      ? { reason: asStr(d.rejection_reason), note: asStr(d.rejection_feedback) }
      : undefined,
    post: {
      key: `${ourProjectId}:${postNumber}`,
      ourProjectId,
      angle: asStr(d.angle),
      variationIndex: 0,
      postNumber,
      headline_ar: asStr(d.headline_ar),
      headline_en: asStr(d.headline_en),
      body_ar: asStr(d.body_ar),
      body_en: asStr(d.body_en),
      prose_ar: asStr(d.prose_ar),
      prose_en: asStr(d.prose_en),
      spec_ar: asStr(d.spec_ar),
      spec_en: asStr(d.spec_en),
      tone: d.tone === 'long' ? 'long' : 'short',
      language,
      used_fact_ids: asStr(d.used_fact_ids).split(',').filter(Boolean),
      evidence: asStr(d.evidence).split('، ').filter(Boolean),
      grounded: d.grounded === true,
      generated_by: asStr(d.generated_by),
    },
  };
}

export interface BatchMeta {
  label: string;
  status: 'running' | 'completed' | 'partial' | 'failed';
  language: PostLanguage;
  tone: PostTone;
  quantityMode: QuantityMode;
  requestedCount: number;
  failedCount: number;
  allProjectIds: string[];
  ourProjectIds: string[];
  perProjectCounts: Record<string, number>;
  actorName: string;
}

/** Build (or refresh) the `posts_batches` record for one generation run. */
export function batchToRecord(
  modelId: string,
  batchRecordId: string,
  meta: BatchMeta,
  existing?: AppRecord | null,
): AppRecord {
  const now = new Date().toISOString();
  return {
    id: batchRecordId,
    model_id: modelId,
    data: {
      ...(existing?.data ?? {}),
      label: meta.label,
      status: meta.status,
      language: meta.language,
      tone: meta.tone,
      quantity_mode: meta.quantityMode,
      requested_count: meta.requestedCount,
      failed_count: meta.failedCount,
      projects: meta.allProjectIds,
      source_project_ids: meta.ourProjectIds.join(','),
      per_project_counts: JSON.stringify(meta.perProjectCounts),
      generated_by: meta.actorName,
      generated_at: existing?.data?.generated_at ?? now,
    },
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}
