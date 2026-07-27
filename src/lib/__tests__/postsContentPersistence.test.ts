import { describe, it, expect } from 'vitest';
import {
  applyEdit, applyReview, batchToRecord, postToRecord, recordToPostState,
  type BatchContext, type PostState,
} from '@/pages/PostsContent/lib/persistence';
import type { GeneratedPost } from '@/lib/postsContent/facts';
import type { AppRecord } from '@/types';

const CTX: BatchContext = {
  batchRecordId: 'batch-rec-1',
  batchId: 'batch-1',
  tone: 'short',
  language: 'both',
  actorName: 'Rayan',
};

function generated(overrides: Partial<GeneratedPost> = {}): GeneratedPost {
  return {
    key: 'op-1:1',
    ourProjectId: 'op-1',
    angle: 'smart_home',
    variationIndex: 0,
    postNumber: 1,
    headline_ar: 'بيت المستقبل',
    headline_en: 'The home of tomorrow',
    prose_ar: 'نص عربي',
    prose_en: 'English prose',
    spec_ar: 'نوع العقار: شقة',
    spec_en: 'Property type: Apartment',
    body_ar: 'بيت المستقبل\n\nنص عربي\n\nنوع العقار: شقة',
    body_en: 'The home of tomorrow\n\nEnglish prose\n\nProperty type: Apartment',
    tone: 'short',
    language: 'both',
    used_fact_ids: ['feature:4', 'unit_type:0'],
    evidence: ['ذكي'],
    grounded: true,
    generated_by: 'cloudflare:qwen',
    ...overrides,
  };
}

function state(overrides: Partial<PostState> = {}): PostState {
  return {
    key: 'op-1:1',
    ourProjectId: 'op-1',
    allProjectId: 'ap-1',
    projectName: 'ستون الندى',
    angle: 'smart_home',
    variationIndex: 0,
    postNumber: 1,
    cardStatus: 'ready',
    post: generated(),
    recordId: 'rec-1',
    review: 'draft',
    ...overrides,
  };
}

describe('postToRecord', () => {
  it('stores headline, prose, spec and the full body separately', () => {
    const rec = postToRecord('model-1', state(), CTX);
    expect(rec.data.headline_ar).toBe('بيت المستقبل');
    expect(rec.data.prose_ar).toBe('نص عربي');
    expect(rec.data.spec_ar).toBe('نوع العقار: شقة');
    expect(rec.data.body_ar).toContain('نوع العقار: شقة');
    expect(rec.data.headline_en).toBe('The home of tomorrow');
  });

  it('carries the batch, project and provenance links', () => {
    const rec = postToRecord('model-1', state(), CTX);
    expect(rec.model_id).toBe('model-1');
    expect(rec.data.project).toBe('ap-1');
    expect(rec.data.source_project_id).toBe('op-1');
    expect(rec.data.batch).toBe('batch-rec-1');
    expect(rec.data.batch_id).toBe('batch-1');
    expect(rec.data.angle).toBe('smart_home');
    expect(rec.data.language).toBe('both');
    expect(rec.data.post_number).toBe(1);
    expect(rec.data.used_fact_ids).toBe('feature:4,unit_type:0');
    expect(rec.data.grounded).toBe(true);
  });

  it('reuses the existing record id so a rewrite updates in place', () => {
    const existing: AppRecord = {
      id: 'rec-1', model_id: 'model-1', data: { status: 'approved' },
      created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z',
    };
    const rec = postToRecord('model-1', state(), CTX, existing);
    expect(rec.id).toBe('rec-1');
    expect(rec.created_at).toBe('2026-07-01T00:00:00.000Z');
  });

  it('never resets an approval stamp on regeneration', () => {
    const existing: AppRecord = {
      id: 'rec-1', model_id: 'model-1',
      data: { approved_at: '2026-07-02T00:00:00.000Z', approved_by: 'Rayan' },
      created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z',
    };
    const rec = postToRecord('model-1', state(), CTX, existing);
    expect(rec.data.approved_at).toBe('2026-07-02T00:00:00.000Z');
    expect(rec.data.approved_by).toBe('Rayan');
  });
});

describe('applyReview transitions', () => {
  const base: AppRecord = {
    id: 'rec-1', model_id: 'model-1', data: { status: 'draft' },
    created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z',
  };

  it('approve stamps who and when', () => {
    const r = applyReview(base, 'approved', 'Rayan');
    expect(r.data.status).toBe('approved');
    expect(r.data.approved_by).toBe('Rayan');
    expect(r.data.approved_at).toBeTruthy();
    expect(r.data.rejected_at).toBeNull();
  });

  it('unapprove returns to draft and is NOT a rejection', () => {
    const approved = applyReview(base, 'approved', 'Rayan');
    const back = applyReview(approved, 'draft', 'Rayan');
    expect(back.data.status).toBe('draft');
    expect(back.data.approved_at).toBeNull();
    expect(back.data.approved_by).toBeNull();
    // The critical assertion: unapproving must never write a rejection verdict.
    expect(back.data.rejected_at).toBeNull();
    expect(back.data.rejected_by).toBeNull();
    expect(back.data.rejection_reason).toBeFalsy();
    expect(back.data.rejection_feedback).toBeFalsy();
  });

  it('reject stores the reason and the note', () => {
    const r = applyReview(base, 'rejected', 'Rayan', { reason: 'weak_headline', note: 'too generic' });
    expect(r.data.status).toBe('rejected');
    expect(r.data.rejection_reason).toBe('weak_headline');
    expect(r.data.rejection_feedback).toBe('too generic');
    expect(r.data.rejected_by).toBe('Rayan');
    expect(r.data.rejected_at).toBeTruthy();
    expect(r.data.approved_at).toBeNull();
  });

  it('rejecting an approved post clears the approval', () => {
    const approved = applyReview(base, 'approved', 'Rayan');
    const rejected = applyReview(approved, 'rejected', 'Rayan', { reason: 'incorrect_facts', note: '' });
    expect(rejected.data.approved_at).toBeNull();
    expect(rejected.data.approved_by).toBeNull();
  });

  it('restoring a rejected post clears both verdicts', () => {
    const rejected = applyReview(base, 'rejected', 'Rayan', { reason: 'too_long', note: 'trim it' });
    const restored = applyReview(rejected, 'draft', 'Rayan');
    expect(restored.data.status).toBe('draft');
    expect(restored.data.rejected_at).toBeNull();
    expect(restored.data.rejected_by).toBeNull();
  });
});

describe('applyEdit', () => {
  it('writes the edited body and stamps edited_at without touching review state', () => {
    const rec: AppRecord = {
      id: 'rec-1', model_id: 'm', data: { status: 'approved', body_ar: 'old', body_en: 'old-en' },
      created_at: 'x', updated_at: 'x',
    };
    const out = applyEdit(rec, 'ar', 'new body');
    expect(out.data.body_ar).toBe('new body');
    expect(out.data.body_en).toBe('old-en');
    expect(out.data.status).toBe('approved');
    expect(out.data.edited_at).toBeTruthy();
  });
});

describe('recordToPostState — reopening a batch', () => {
  it('round-trips content, status and rejection feedback', () => {
    const rec = postToRecord('model-1', state({ review: 'draft' }), CTX);
    const rejected = applyReview(rec, 'rejected', 'Rayan', { reason: 'repetitive', note: 'same as #2' });
    const back = recordToPostState(rejected, 'ستون الندى');

    expect(back.key).toBe('op-1:1');
    expect(back.review).toBe('rejected');
    expect(back.rejection).toEqual({ reason: 'repetitive', note: 'same as #2' });
    expect(back.cardStatus).toBe('ready');
    expect(back.projectName).toBe('ستون الندى');
    expect(back.post?.body_ar).toContain('نوع العقار: شقة');
    expect(back.post?.headline_en).toBe('The home of tomorrow');
    expect(back.post?.used_fact_ids).toEqual(['feature:4', 'unit_type:0']);
    expect(back.post?.language).toBe('both');
  });

  it('keeps an approved post approved after a reload', () => {
    const rec = applyReview(postToRecord('model-1', state(), CTX), 'approved', 'Rayan');
    expect(recordToPostState(rec, 'p').review).toBe('approved');
  });

  it('carries a manual edit through the reopen', () => {
    const rec = applyEdit(postToRecord('model-1', state(), CTX), 'ar', 'نص معدّل يدويًا');
    expect(recordToPostState(rec, 'p').post?.body_ar).toBe('نص معدّل يدويًا');
  });
});

describe('batchToRecord', () => {
  it('stores the request metadata that cannot be derived from the posts', () => {
    const rec = batchToRecord('batches-model', 'batch-rec-1', {
      label: 'ستون الندى — 10',
      status: 'partial',
      language: 'both',
      tone: 'short',
      quantityMode: 'total',
      requestedCount: 10,
      failedCount: 2,
      allProjectIds: ['ap-1', 'ap-2'],
      ourProjectIds: ['op-1', 'op-2'],
      perProjectCounts: { 'op-1': 5, 'op-2': 5 },
      actorName: 'Rayan',
    });
    expect(rec.id).toBe('batch-rec-1');
    expect(rec.data.requested_count).toBe(10);
    expect(rec.data.failed_count).toBe(2);
    expect(rec.data.status).toBe('partial');
    expect(rec.data.quantity_mode).toBe('total');
    expect(rec.data.projects).toEqual(['ap-1', 'ap-2']);
    expect(rec.data.source_project_ids).toBe('op-1,op-2');
    expect(JSON.parse(String(rec.data.per_project_counts))).toEqual({ 'op-1': 5, 'op-2': 5 });
  });

  it('keeps the original generated_at when the run is finalized', () => {
    const first = batchToRecord('m', 'b1', {
      label: 'x', status: 'running', language: 'ar', tone: 'short', quantityMode: 'total',
      requestedCount: 3, failedCount: 0, allProjectIds: [], ourProjectIds: [], perProjectCounts: {},
      actorName: 'Rayan',
    });
    const second = batchToRecord('m', 'b1', {
      label: 'x', status: 'completed', language: 'ar', tone: 'short', quantityMode: 'total',
      requestedCount: 3, failedCount: 0, allProjectIds: [], ourProjectIds: [], perProjectCounts: {},
      actorName: 'Rayan',
    }, first);
    expect(second.data.generated_at).toBe(first.data.generated_at);
    expect(second.data.status).toBe('completed');
  });
});
