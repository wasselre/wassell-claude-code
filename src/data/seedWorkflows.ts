// Seed workflows for the marketing-operations pipeline.
//
// The pipeline is 100% workflow-driven: all record writes flow through the
// workflow engine; the 5 Deno edge functions are pure compute (read the
// records table, run Claude, POST webhooks). These 11 workflows stitch
// the pieces together:
//
//   1. on_create marketing_operations   → http_request marketing-research
//   2. on_update research_questions     → http_request marketing-research-resume
//                                         (agent self-gates on "all answered")
//   3. webhook research-complete        → update operation + http_request marketing-content
//   4. webhook research-contradictions  → update operation status
//   5. webhook research-question        → create research_questions record
//   6. webhook reel-generated           → create reels record
//   7. webhook post-generated           → create posts record
//   8. webhook reels-ready              → update operation.reels_batch_done
//   9. webhook posts-ready              → update operation.posts_batch_done
//  10. webhook content-done             → update operation.status = ready_for_review
//  11. webhook operation-failed         → update operation.status = failed
//
// Each workflow has a stable, deterministic id so the seed can re-upsert
// idempotently. Model UUIDs are per-install, so they're looked up from
// the loaded models by slug. Webhook slug UUIDs are looked up similarly.

import type {
  AppModel,
  FieldMapping,
  WebhookSlug,
  Workflow,
  WorkflowAction,
  WorkflowBranch,
  WorkflowCondition,
} from '@/types';

const now = () => new Date().toISOString();

// Deterministic IDs for the 11 pipeline workflows. Editing these while
// keeping the content the same is a no-op; changing them orphans any
// existing rows so DON'T.
export const WF_MARKETING_OP_CREATED = '00000000-0000-4000-a000-000000000001';
export const WF_RESEARCH_QUESTION_ANSWERED = '00000000-0000-4000-a000-000000000002';
export const WF_ON_RESEARCH_COMPLETE = '00000000-0000-4000-a000-000000000003';
export const WF_ON_RESEARCH_CONTRADICTIONS = '00000000-0000-4000-a000-000000000004';
export const WF_ON_RESEARCH_QUESTION = '00000000-0000-4000-a000-000000000005';
export const WF_ON_REEL_GENERATED = '00000000-0000-4000-a000-000000000006';
export const WF_ON_POST_GENERATED = '00000000-0000-4000-a000-000000000007';
export const WF_ON_REELS_READY = '00000000-0000-4000-a000-000000000008';
export const WF_ON_POSTS_READY = '00000000-0000-4000-a000-000000000009';
export const WF_ON_CONTENT_DONE = '00000000-0000-4000-a000-00000000000a';
export const WF_ON_OPERATION_FAILED = '00000000-0000-4000-a000-00000000000b';

export const MARKETING_SEED_WORKFLOW_IDS = new Set<string>([
  WF_MARKETING_OP_CREATED,
  WF_RESEARCH_QUESTION_ANSWERED,
  WF_ON_RESEARCH_COMPLETE,
  WF_ON_RESEARCH_CONTRADICTIONS,
  WF_ON_RESEARCH_QUESTION,
  WF_ON_REEL_GENERATED,
  WF_ON_POST_GENERATED,
  WF_ON_REELS_READY,
  WF_ON_POSTS_READY,
  WF_ON_CONTENT_DONE,
  WF_ON_OPERATION_FAILED,
]);

// Short helper for mappings — every mapping needs a unique id inside the
// action but the content is all that matters for engine behavior.
function mapTrigger(id: string, target: string, triggerField: string): FieldMapping {
  return { id, target_field_id: target, source_type: 'trigger_field', trigger_field_id: triggerField };
}
function mapStatic(id: string, target: string, value: unknown): FieldMapping {
  return { id, target_field_id: target, source_type: 'static', static_value: value };
}
function mapRecordId(id: string, target: string): FieldMapping {
  return { id, target_field_id: target, source_type: 'record_id' };
}

function modelIdBySlug(models: AppModel[], slug: string): string | null {
  return models.find((m) => m.name === slug)?.id ?? null;
}
function slugIdBySlug(slugs: WebhookSlug[], slug: string): string | null {
  return slugs.find((s) => s.slug === slug)?.id ?? null;
}

// Wrap a single branch with the legacy mirror fields populated so old
// readers (list page action counters, etc.) still see a consistent view.
function wrap(
  id: string,
  label_ar: string,
  label_en: string,
  triggerModelId: string | null,
  triggerEvent: 'create' | 'update' | 'webhook',
  conditions: WorkflowCondition[],
  actions: WorkflowAction[],
  triggerWebhookSlugId?: string | null,
): Workflow {
  const branch: WorkflowBranch = {
    id: `${id}__b0`,
    conditions,
    actions,
  };
  return {
    id,
    label_ar,
    label_en,
    trigger_model_id: triggerModelId ?? '',
    trigger_event: triggerEvent,
    trigger_webhook_slug_id: triggerWebhookSlugId ?? null,
    branches: [branch],
    conditions,
    actions,
    is_active: true,
    created_at: now(),
    updated_at: now(),
  };
}

/**
 * Build the full list of marketing-pipeline workflow rows. Returns `[]`
 * if any of the required models aren't seeded yet — the caller should
 * just skip the seed call and retry on the next init cycle.
 *
 * `supabaseUrl` is the base URL the edge functions are served from. It
 * gets baked into each http_request action's URL — the engine doesn't
 * support runtime URL substitution beyond `{trigger_field}` tokens.
 */
export function buildMarketingSeedWorkflows(
  models: AppModel[],
  webhookSlugs: WebhookSlug[],
  supabaseUrl: string,
): Workflow[] {
  const opId = modelIdBySlug(models, 'marketing_operations');
  const questionsId = modelIdBySlug(models, 'research_questions');
  const reelsId = modelIdBySlug(models, 'reels');
  const postsId = modelIdBySlug(models, 'posts');

  const slugResearchComplete = slugIdBySlug(webhookSlugs, 'research-complete');
  const slugResearchContradictions = slugIdBySlug(webhookSlugs, 'research-contradictions');
  const slugResearchQuestion = slugIdBySlug(webhookSlugs, 'research-question');
  const slugReelGenerated = slugIdBySlug(webhookSlugs, 'reel-generated');
  const slugPostGenerated = slugIdBySlug(webhookSlugs, 'post-generated');
  const slugReelsReady = slugIdBySlug(webhookSlugs, 'reels-ready');
  const slugPostsReady = slugIdBySlug(webhookSlugs, 'posts-ready');
  const slugContentDone = slugIdBySlug(webhookSlugs, 'content-done');
  const slugOperationFailed = slugIdBySlug(webhookSlugs, 'operation-failed');

  if (
    !opId ||
    !questionsId ||
    !reelsId ||
    !postsId ||
    !slugResearchComplete ||
    !slugResearchContradictions ||
    !slugResearchQuestion ||
    !slugReelGenerated ||
    !slugPostGenerated ||
    !slugReelsReady ||
    !slugPostsReady ||
    !slugContentDone ||
    !slugOperationFailed
  ) {
    return [];
  }

  const base = supabaseUrl.replace(/\/$/, '');
  const FN_RESEARCH = `${base}/functions/v1/marketing-research`;
  const FN_RESEARCH_RESUME = `${base}/functions/v1/marketing-research-resume`;
  const FN_CONTENT = `${base}/functions/v1/marketing-content`;

  const list: Workflow[] = [];

  // ── WF1: op created → kick off research ──────────────────────────
  list.push(wrap(
    WF_MARKETING_OP_CREATED,
    'بدء البحث عند إنشاء العملية',
    'Start research on op create',
    opId,
    'create',
    [],
    [{
      id: `${WF_MARKETING_OP_CREATED}__a0`,
      type: 'http_request',
      method: 'POST',
      url: FN_RESEARCH,
      body_mode: 'form_mappings',
      body_mappings: [mapRecordId(`${WF_MARKETING_OP_CREATED}__m0`, 'record_id')],
      timeout_ms: 60000,
    }],
  ));

  // ── WF2: all research_questions answered → resume ────────────────
  list.push(wrap(
    WF_RESEARCH_QUESTION_ANSWERED,
    'استئناف البحث عند الإجابة على السؤال',
    'Resume research on answer',
    questionsId,
    'update',
    [{
      id: `${WF_RESEARCH_QUESTION_ANSWERED}__c0`,
      field_id: 'status',
      operator: 'equals',
      value: 'answered',
      only_on_change: true,
    }],
    [{
      id: `${WF_RESEARCH_QUESTION_ANSWERED}__a0`,
      type: 'http_request',
      method: 'POST',
      url: FN_RESEARCH_RESUME,
      body_mode: 'form_mappings',
      body_mappings: [mapTrigger(`${WF_RESEARCH_QUESTION_ANSWERED}__m0`, 'record_id', 'operation')],
      timeout_ms: 60000,
    }],
  ));

  // ── WF3: webhook research-complete → update op + fire content ───
  list.push(wrap(
    WF_ON_RESEARCH_COMPLETE,
    'تحديث البحث وبدء توليد المحتوى',
    'Save research + start content',
    null,
    'webhook',
    [],
    [
      {
        id: `${WF_ON_RESEARCH_COMPLETE}__a0`,
        type: 'update_record',
        target_model_id: opId,
        filter_field_id: 'id',
        filter_value_source: 'trigger_field',
        filter_trigger_field_id: 'record_id',
        filter_value: null,
        field_mappings: [
          mapStatic(`${WF_ON_RESEARCH_COMPLETE}__m0`, 'status', 'research_complete'),
          mapTrigger(`${WF_ON_RESEARCH_COMPLETE}__m1`, 'facts', 'facts'),
          mapTrigger(`${WF_ON_RESEARCH_COMPLETE}__m2`, 'sources', 'sources'),
          mapTrigger(`${WF_ON_RESEARCH_COMPLETE}__m3`, 'not_found', 'not_found'),
          mapTrigger(`${WF_ON_RESEARCH_COMPLETE}__m4`, 'confidence', 'confidence'),
          mapTrigger(`${WF_ON_RESEARCH_COMPLETE}__m5`, 'research_notes', 'research_notes'),
        ],
      },
      {
        id: `${WF_ON_RESEARCH_COMPLETE}__a1`,
        type: 'http_request',
        method: 'POST',
        url: FN_CONTENT,
        body_mode: 'form_mappings',
        body_mappings: [mapTrigger(`${WF_ON_RESEARCH_COMPLETE}__m6`, 'record_id', 'record_id')],
        timeout_ms: 60000,
      },
    ],
    slugResearchComplete,
  ));

  // ── WF4: webhook research-contradictions → update op status ─────
  list.push(wrap(
    WF_ON_RESEARCH_CONTRADICTIONS,
    'تحديث العملية عند وجود تعارضات',
    'Pause op on contradictions',
    null,
    'webhook',
    [],
    [{
      id: `${WF_ON_RESEARCH_CONTRADICTIONS}__a0`,
      type: 'update_record',
      target_model_id: opId,
      filter_field_id: 'id',
      filter_value_source: 'trigger_field',
      filter_trigger_field_id: 'record_id',
      filter_value: null,
      field_mappings: [
        mapStatic(`${WF_ON_RESEARCH_CONTRADICTIONS}__m0`, 'status', 'research_waiting_answers'),
        mapTrigger(`${WF_ON_RESEARCH_CONTRADICTIONS}__m1`, 'facts', 'facts'),
        mapTrigger(`${WF_ON_RESEARCH_CONTRADICTIONS}__m2`, 'sources', 'sources'),
        mapTrigger(`${WF_ON_RESEARCH_CONTRADICTIONS}__m3`, 'not_found', 'not_found'),
        mapTrigger(`${WF_ON_RESEARCH_CONTRADICTIONS}__m4`, 'confidence', 'confidence'),
        mapTrigger(`${WF_ON_RESEARCH_CONTRADICTIONS}__m5`, 'research_notes', 'research_notes'),
      ],
    }],
    slugResearchContradictions,
  ));

  // ── WF5: webhook research-question → create question record ─────
  list.push(wrap(
    WF_ON_RESEARCH_QUESTION,
    'إنشاء سؤال بحث جديد',
    'Create research question',
    null,
    'webhook',
    [],
    [{
      id: `${WF_ON_RESEARCH_QUESTION}__a0`,
      type: 'create_record',
      target_model_id: questionsId,
      field_mappings: [
        mapTrigger(`${WF_ON_RESEARCH_QUESTION}__m0`, 'operation', 'record_id'),
        mapTrigger(`${WF_ON_RESEARCH_QUESTION}__m1`, 'question_number', 'question_number'),
        mapTrigger(`${WF_ON_RESEARCH_QUESTION}__m2`, 'question', 'question'),
        mapTrigger(`${WF_ON_RESEARCH_QUESTION}__m3`, 'source_conflict', 'source_conflict'),
        mapStatic(`${WF_ON_RESEARCH_QUESTION}__m4`, 'status', 'waiting'),
      ],
    }],
    slugResearchQuestion,
  ));

  // ── WF6: webhook reel-generated → create reel record ────────────
  list.push(wrap(
    WF_ON_REEL_GENERATED,
    'إنشاء ريل جديد',
    'Create reel record',
    null,
    'webhook',
    [],
    [{
      id: `${WF_ON_REEL_GENERATED}__a0`,
      type: 'create_record',
      target_model_id: reelsId,
      field_mappings: [
        mapTrigger(`${WF_ON_REEL_GENERATED}__m0`, 'operation', 'record_id'),
        mapTrigger(`${WF_ON_REEL_GENERATED}__m1`, 'reel_number', 'reel_number'),
        mapStatic(`${WF_ON_REEL_GENERATED}__m2`, 'status', 'draft_ready'),
        mapTrigger(`${WF_ON_REEL_GENERATED}__m3`, 'type', 'type'),
        mapTrigger(`${WF_ON_REEL_GENERATED}__m4`, 'duration', 'duration'),
        mapTrigger(`${WF_ON_REEL_GENERATED}__m5`, 'platform', 'platform'),
        mapTrigger(`${WF_ON_REEL_GENERATED}__m6`, 'voiceover', 'voiceover'),
        mapTrigger(`${WF_ON_REEL_GENERATED}__m7`, 'goal', 'goal'),
        mapTrigger(`${WF_ON_REEL_GENERATED}__m8`, 'scenes', 'scenes'),
      ],
    }],
    slugReelGenerated,
  ));

  // ── WF7: webhook post-generated → create post record ────────────
  list.push(wrap(
    WF_ON_POST_GENERATED,
    'إنشاء منشور جديد',
    'Create post record',
    null,
    'webhook',
    [],
    [{
      id: `${WF_ON_POST_GENERATED}__a0`,
      type: 'create_record',
      target_model_id: postsId,
      field_mappings: [
        mapTrigger(`${WF_ON_POST_GENERATED}__m0`, 'operation', 'record_id'),
        mapTrigger(`${WF_ON_POST_GENERATED}__m1`, 'post_number', 'post_number'),
        mapStatic(`${WF_ON_POST_GENERATED}__m2`, 'status', 'draft_ready'),
        mapTrigger(`${WF_ON_POST_GENERATED}__m3`, 'type', 'type'),
        mapTrigger(`${WF_ON_POST_GENERATED}__m4`, 'components', 'components'),
        mapTrigger(`${WF_ON_POST_GENERATED}__m5`, 'visual', 'visual'),
        mapTrigger(`${WF_ON_POST_GENERATED}__m6`, 'usage', 'usage'),
        mapTrigger(`${WF_ON_POST_GENERATED}__m7`, 'title', 'title'),
        mapTrigger(`${WF_ON_POST_GENERATED}__m8`, 'design_text_1', 'design_text_1'),
        mapTrigger(`${WF_ON_POST_GENERATED}__m9`, 'design_text_2', 'design_text_2'),
        mapTrigger(`${WF_ON_POST_GENERATED}__ma`, 'design_text_3', 'design_text_3'),
        mapTrigger(`${WF_ON_POST_GENERATED}__mb`, 'caption', 'caption'),
      ],
    }],
    slugPostGenerated,
  ));

  // ── WF8: webhook reels-ready → flag op.reels_batch_done ─────────
  list.push(wrap(
    WF_ON_REELS_READY,
    'تمييز اكتمال الريلز',
    'Flag reels batch done',
    null,
    'webhook',
    [],
    [{
      id: `${WF_ON_REELS_READY}__a0`,
      type: 'update_record',
      target_model_id: opId,
      filter_field_id: 'id',
      filter_value_source: 'trigger_field',
      filter_trigger_field_id: 'record_id',
      filter_value: null,
      field_mappings: [mapStatic(`${WF_ON_REELS_READY}__m0`, 'reels_batch_done', true)],
    }],
    slugReelsReady,
  ));

  // ── WF9: webhook posts-ready → flag op.posts_batch_done ─────────
  list.push(wrap(
    WF_ON_POSTS_READY,
    'تمييز اكتمال المنشورات',
    'Flag posts batch done',
    null,
    'webhook',
    [],
    [{
      id: `${WF_ON_POSTS_READY}__a0`,
      type: 'update_record',
      target_model_id: opId,
      filter_field_id: 'id',
      filter_value_source: 'trigger_field',
      filter_trigger_field_id: 'record_id',
      filter_value: null,
      field_mappings: [mapStatic(`${WF_ON_POSTS_READY}__m0`, 'posts_batch_done', true)],
    }],
    slugPostsReady,
  ));

  // ── WF10: webhook content-done → status = ready_for_review ──────
  list.push(wrap(
    WF_ON_CONTENT_DONE,
    'المحتوى جاهز للمراجعة',
    'Content ready for review',
    null,
    'webhook',
    [],
    [{
      id: `${WF_ON_CONTENT_DONE}__a0`,
      type: 'update_record',
      target_model_id: opId,
      filter_field_id: 'id',
      filter_value_source: 'trigger_field',
      filter_trigger_field_id: 'record_id',
      filter_value: null,
      field_mappings: [mapStatic(`${WF_ON_CONTENT_DONE}__m0`, 'status', 'ready_for_review')],
    }],
    slugContentDone,
  ));

  // ── WF11: webhook operation-failed → status = failed ────────────
  list.push(wrap(
    WF_ON_OPERATION_FAILED,
    'فشل العملية',
    'Operation failed',
    null,
    'webhook',
    [],
    [{
      id: `${WF_ON_OPERATION_FAILED}__a0`,
      type: 'update_record',
      target_model_id: opId,
      filter_field_id: 'id',
      filter_value_source: 'trigger_field',
      filter_trigger_field_id: 'record_id',
      filter_value: null,
      field_mappings: [
        mapStatic(`${WF_ON_OPERATION_FAILED}__m0`, 'status', 'failed'),
        mapTrigger(`${WF_ON_OPERATION_FAILED}__m1`, 'research_error', 'error'),
      ],
    }],
    slugOperationFailed,
  ));

  return list;
}
