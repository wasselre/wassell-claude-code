/**
 * Content operations — the canonical content module's service layer.
 *
 *   brief → deliverables → artifacts (versioned) → publications → results
 *
 * ONE source of truth. The older content surface reads mkt_content_items'
 * platform-shaped columns directly (one caption, one language, one publish
 * time, platforms as a multi-select); everything here goes through the
 * deliverable, which is what makes "the same reel for Instagram and TikTok"
 * two schedulable things instead of one row that can only be one of them.
 *
 * Readiness is never computed here. `missing`, `blockers`, `next_action` and
 * `progress` all come from the database functions that also ENFORCE them
 * (mkt_content_missing_requirements, mkt_deliverable_schedule_blockers,
 * mkt_content_state), so a disabled button and the reason it gives cannot
 * drift apart from what a save would actually do.
 *
 * Design record: docs/marketing-management-v2.md
 */
import { call } from './client';

// ── the brief ──────────────────────────────────────────────────────────────
export interface ContentBrief {
  id: string; content_number: string; title: string;
  content_type: string; status: string; priority: string;
  /** project | brand | market | developer | campaign_only | other */
  scope_kind: string | null; scope_note: string | null;
  project_id: string | null; campaign_id: string | null;
  /** The exact immutable version this was written against. Never auto-migrates. */
  strategy_version_id: string | null;
  plan_id: string | null; primary_goal_id: string | null; primary_pillar_id: string | null;
  always_on_reason: string | null;
  owner_user_id: string | null;
  target_audience: string | null; audience_insight: string | null;
  hook: string | null; main_idea: string | null; core_promise: string | null;
  content_angle: string | null; evidence: string | null;
  desired_action: string | null; cta: string | null;
  mandatory_info: string | null; prohibited_claims: string | null;
  strategic_purpose: string | null;
  due_date: string | null;
  brief_due_date: string | null; production_due_date: string | null;
  review_due_date: string | null;
  window_start: string | null; window_end: string | null;
  parent_content_item_id: string | null; reuse_kind: string | null;
  origin_kind: string | null;
  needs_classification: boolean; legacy_shape: string | null;
  created_at: string;
  mkt_content_deliverables?: Deliverable[];
  state?: ContentState | null;
}

/** mkt_content_state(). Everything on it is derived from real rows. */
export interface ContentState {
  status: string;
  missing: string[];
  is_activatable: boolean;
  deliverables: number;
  tasks_done: number; tasks_total: number;
  /** null when there are no tasks — not 0%. */
  progress_pct: number | null;
  next_action: { id: string; title: string; task_type: string;
                 deliverable_id: string | null; assigned_user_id: string | null;
                 due_date: string | null } | null;
  blockers: Array<{ kind: string; id: string; label: string; reason: string | null }>;
  is_overdue: boolean;
}

// ── the deliverable ────────────────────────────────────────────────────────
export interface Deliverable {
  id: string; content_item_id: string; deliverable_number: number;
  label: string | null;
  /** NULL on anything carried over from the single-platform shape. Flagged by
   *  needs_classification rather than guessed. */
  platform: string | null;
  social_account_id: string | null;
  distribution: 'organic' | 'paid' | 'both';
  format: string; language: 'ar' | 'en' | 'both';
  aspect_ratio: string | null; target_seconds: number | null;
  owner_user_id: string | null;
  due_date: string | null; planned_publish_at: string | null;
  status: string;
  primary_kpi: string | null; kpi_unit: string | null; kpi_target: number | null;
  workflow_template_key: string | null;
  caption: string | null; hashtags: string[]; first_comment: string | null;
  cta_destination: string | null; destination_url: string | null;
  notes: string | null; needs_classification: boolean;
  /** From mkt_deliverable_schedule_blockers(). Empty = schedulable. */
  blockers?: string[];
  attainment?: Attainment | null;
}

/** mkt_deliverable_attainment(). `actual` null + is_measured false = nothing
 *  recorded, which is a different claim from zero. */
export interface Attainment {
  kpi: string | null; unit: string | null;
  target: number | null; actual: number | null;
  measured_at: string | null; is_measured: boolean;
  attainment_pct: number | null;
}

// ── artifacts ──────────────────────────────────────────────────────────────
export interface ArtifactType {
  key: string; label_ar: string; label_en: string;
  /** Decides which editor renders. A design file behind a textarea was the bug. */
  editor_kind: 'text' | 'rich_text' | 'list' | 'file' | 'link' | 'media';
  hint_ar: string | null; hint_en: string | null;
  sort_order: number; is_active: boolean; is_legacy: boolean;
}

export interface Artifact {
  id: string; content_item_id: string; deliverable_id: string | null;
  version_type: string; version_number: number;
  payload: Record<string, unknown>; file_id: string | null;
  change_summary: string | null; review_comment: string | null;
  approval_state: 'draft' | 'pending' | 'approved' | 'changes_requested' | 'rejected' | 'superseded';
  approved_by_user_id: string | null; approved_at: string | null;
  superseded_by: string | null; parent_version_id: string | null;
  owner_user_id: string | null;
  /** An upstream artifact changed after this was approved. */
  is_stale: boolean; stale_reason: string | null; stale_since: string | null;
  created_at: string;
}

export interface ContentTask {
  id: string; title: string; task_type: string;
  content_item_id: string | null; deliverable_id: string | null;
  assigned_user_id: string | null; reviewer_user_id: string | null;
  due_date: string | null; status: string; priority: string;
  depends_on_task_id: string | null; blocked_reason: string | null;
  skipped_reason: string | null; notes: string | null;
  attachment_file_id: string | null;
  /** 'legacy_fixed_12' marks a task carried over from the old fixed checklist. */
  template_key: string | null; step_key: string | null;
  artifact_type: string | null;
  sort_order: number; completed_at: string | null;
}

export interface Publication {
  id: string; content_item_id: string; deliverable_id: string | null;
  platform: string; social_account_id: string | null; channel: 'organic' | 'paid';
  scheduled_for: string | null; scheduled_timezone: string;
  published_at: string | null; status: string;
  publish_method: 'manual' | 'api' | 'scheduled_api';
  destination_url: string | null; utm: Record<string, unknown>;
  first_comment: string | null; ad_id: string | null;
  published_url: string | null; platform_post_id: string | null;
  error_message: string | null; retry_count: number;
  locked_copy_version_id: string | null; locked_media_version_id: string | null;
  published_by_user_id: string | null;
}

export interface ContentResult {
  id: string; content_item_id: string; deliverable_id: string | null;
  goal_id: string | null;
  kpi_actual: number | null; measured_at: string | null;
  metrics: Record<string, unknown>;
  leads: number | null; qualified_leads: number | null;
  clicks: number | null; conversions: number | null;
  spend: number | null; cost_per_lead: number | null;
  attribution_source: string | null;
  learning: string | null;
  recommendation: 'repeat' | 'improve' | 'stop' | 'reuse' | null;
  recorded_by_user_id: string | null; created_at: string;
}

export interface ContentRole {
  id: string; content_item_id: string; deliverable_id: string | null;
  user_id: string; role_key: string;
  is_reviewer: boolean; is_final_approver: boolean; note: string | null;
}

export interface VideoScene {
  id: string; content_item_id: string; deliverable_id: string | null;
  scene_number: number; scene_type: string;
  planned_seconds: number | null; actual_seconds: number | null;
  visual_description: string | null; on_screen_text: string | null;
  voice_over: string | null; dialogue: string | null;
  camera_angle: string | null; shot_instructions: string | null;
  location: string | null; raw_asset_id: string | null; reference_url: string | null;
  assigned_user_id: string | null; status: string; notes: string | null;
}

export interface AssetLink {
  asset_id: string; target_type: string; target_id: string; role: string | null;
  mkt_raw_assets: Record<string, unknown> | null;
}

export interface ContentOpsDetail {
  item: ContentBrief;
  deliverables: Deliverable[];
  artifacts: Artifact[];
  tasks: ContentTask[];
  publications: Publication[];
  results: ContentResult[];
  roles: ContentRole[];
  history: Array<{ id: string; from_status: string | null; to_status: string;
                   changed_by_user_id: string | null; changed_at: string; reason: string | null }>;
  scenes: VideoScene[];
  slides: Array<Record<string, unknown>>;
  assets: AssetLink[];
  state: ContentState | null;
  missing: string[];
}

// ── actions ────────────────────────────────────────────────────────────────
export const fetchContentBoard = (project_id?: string) =>
  call<{ items: ContentBrief[] }>('content_board', { project_id });

export const fetchContentDetail = (id: string) =>
  call<ContentOpsDetail>('content_ops_detail', { id });

export const saveBrief = (id: string, patch: Record<string, unknown>) =>
  call<{ item: ContentBrief }>('brief_save', { id, patch });

/** Creating one also generates the tasks its FORMAT calls for — a text post
 *  gets five steps, a raw asset four and no publishing step at all. */
export const saveDeliverable = (patch: Record<string, unknown>, id?: string, content_item_id?: string) =>
  call<{ deliverable: Deliverable; tasks_generated: number | null }>(
    'deliverable_save', { id, content_item_id, patch });

export const generateDeliverableTasks = (deliverable_id: string, replace = false) =>
  call<{ created: number }>('deliverable_generate_tasks', { deliverable_id, replace });

export const fetchDeliverableBlockers = (deliverable_id: string) =>
  call<{ blockers: string[]; attainment: Attainment | null }>('deliverable_blockers', { deliverable_id });

/** `expected` is the ordered list this deliverable's workflow actually calls
 *  for; `types` is everything else available. */
export const fetchArtifactTypes = (deliverable_id?: string) =>
  call<{ types: ArtifactType[]; expected: string[] }>('artifact_types', { deliverable_id });

/** Always creates a NEW version. There is no update path: an approved artifact
 *  is immutable in the database, so editing one means writing v+1. */
export const saveArtifact = (patch: Record<string, unknown>) =>
  call<{ artifact: Artifact }>('artifact_save', { patch });

export const decideArtifact = (
  id: string,
  decision: 'approved' | 'changes_requested' | 'rejected' | 'pending',
  review_comment?: string,
) => call<{ artifact: Artifact; stale: Array<{ id: string; version_type: string;
             version_number: number; stale_reason: string | null }> }>(
  'artifact_decide', { id, decision, review_comment });

export const saveContentTask = (id: string, patch: Record<string, unknown>) =>
  call<{ task: ContentTask }>('content_task_save', { id, patch });

export const savePublication = (patch: Record<string, unknown>, id?: string) =>
  call<{ publication: Publication }>('deliverable_publication_save', { id, patch });

/** The honest manual path — no platform API is wired, so a human posts it and
 *  records what came back. */
export const markPublished = (id: string, patch: Record<string, unknown>) =>
  call<{ publication: Publication }>('deliverable_mark_published', { id, patch });

export const recordResult = (patch: Record<string, unknown>, id?: string) =>
  call<{ result: ContentResult; attainment: Attainment | null }>('result_record', { id, patch });

export const linkAsset = (asset_id: string, target_id: string,
                          target_type = 'deliverable', role?: string) =>
  call<{ link: AssetLink }>('content_asset_link', { asset_id, target_id, target_type, patch: { role } });

export const unlinkAsset = (asset_id: string, target_id: string, target_type = 'deliverable') =>
  call<{ ok: boolean }>('content_asset_unlink', { asset_id, target_id, target_type });

// ── bilingual labels ───────────────────────────────────────────────────────
export const SCOPE_LABEL: Record<string, { ar: string; en: string }> = {
  project:       { ar: 'مشروع', en: 'Project' },
  brand:         { ar: 'علامة وصل', en: 'Wassel brand' },
  market:        { ar: 'السوق', en: 'Market' },
  developer:     { ar: 'مطوّر', en: 'Developer' },
  campaign_only: { ar: 'حملة فقط', en: 'Campaign only' },
  other:         { ar: 'أخرى', en: 'Other' },
};

export const DELIVERABLE_STATUS_LABEL: Record<string, { ar: string; en: string }> = {
  planned:            { ar: 'مخطّط', en: 'Planned' },
  in_production:      { ar: 'قيد الإنتاج', en: 'In production' },
  internal_review:    { ar: 'مراجعة داخلية', en: 'Internal review' },
  changes_requested:  { ar: 'مطلوب تعديل', en: 'Changes requested' },
  approved:           { ar: 'معتمد', en: 'Approved' },
  scheduled:          { ar: 'مجدول', en: 'Scheduled' },
  published:          { ar: 'منشور', en: 'Published' },
  cancelled:          { ar: 'ملغى', en: 'Cancelled' },
  on_hold:            { ar: 'معلّق', en: 'On hold' },
};

export const FORMAT_LABEL: Record<string, { ar: string; en: string }> = {
  reel:            { ar: 'ريلز', en: 'Reel' },
  short_video:     { ar: 'فيديو قصير', en: 'Short video' },
  long_form_video: { ar: 'فيديو طويل', en: 'Long-form video' },
  story:           { ar: 'ستوري', en: 'Story' },
  carousel:        { ar: 'كاروسيل', en: 'Carousel' },
  static_image:    { ar: 'صورة ثابتة', en: 'Static image' },
  infographic:     { ar: 'إنفوجرافيك', en: 'Infographic' },
  text_post:       { ar: 'منشور نصّي', en: 'Text post' },
  article:         { ar: 'مقال', en: 'Article' },
  newsletter:      { ar: 'نشرة', en: 'Newsletter' },
  landing_page:    { ar: 'صفحة هبوط', en: 'Landing page' },
  paid_video_ad:   { ar: 'إعلان فيديو', en: 'Paid video ad' },
  paid_image_ad:   { ar: 'إعلان صورة', en: 'Paid image ad' },
  raw_asset_only:  { ar: 'مادة خام فقط', en: 'Raw asset only' },
  other:           { ar: 'أخرى', en: 'Other' },
};

export const PLATFORM_LABEL: Record<string, { ar: string; en: string }> = {
  instagram: { ar: 'إنستغرام', en: 'Instagram' },
  tiktok:    { ar: 'تيك توك', en: 'TikTok' },
  youtube:   { ar: 'يوتيوب', en: 'YouTube' },
  snapchat:  { ar: 'سناب شات', en: 'Snapchat' },
  x:         { ar: 'إكس', en: 'X' },
  facebook:  { ar: 'فيسبوك', en: 'Facebook' },
  linkedin:  { ar: 'لينكدإن', en: 'LinkedIn' },
  whatsapp:  { ar: 'واتساب', en: 'WhatsApp' },
  website:   { ar: 'الموقع', en: 'Website' },
  email:     { ar: 'بريد', en: 'Email' },
  offline:   { ar: 'خارج المنصات', en: 'Offline' },
  other:     { ar: 'أخرى', en: 'Other' },
};

export const DISTRIBUTION_LABEL: Record<string, { ar: string; en: string }> = {
  organic: { ar: 'عضوي', en: 'Organic' },
  paid:    { ar: 'مدفوع', en: 'Paid' },
  both:    { ar: 'الاثنان', en: 'Both' },
};

export const APPROVAL_LABEL: Record<string, { ar: string; en: string }> = {
  draft:             { ar: 'مسودة', en: 'Draft' },
  pending:           { ar: 'قيد المراجعة', en: 'In review' },
  approved:          { ar: 'معتمد', en: 'Approved' },
  changes_requested: { ar: 'مطلوب تعديل', en: 'Changes requested' },
  rejected:          { ar: 'مرفوض', en: 'Rejected' },
  superseded:        { ar: 'مُستبدل', en: 'Superseded' },
};

export const TASK_STATUS_LABEL: Record<string, { ar: string; en: string }> = {
  not_started:       { ar: 'لم تبدأ', en: 'Not started' },
  in_progress:       { ar: 'قيد التنفيذ', en: 'In progress' },
  blocked:           { ar: 'متوقفة', en: 'Blocked' },
  waiting_review:    { ar: 'بانتظار المراجعة', en: 'Waiting review' },
  in_review:         { ar: 'قيد المراجعة', en: 'In review' },
  changes_requested: { ar: 'مطلوب تعديل', en: 'Changes requested' },
  completed:         { ar: 'مكتملة', en: 'Completed' },
  skipped:           { ar: 'متجاوَزة', en: 'Skipped' },
  cancelled:         { ar: 'ملغاة', en: 'Cancelled' },
};

export const RECOMMENDATION_LABEL: Record<string, { ar: string; en: string }> = {
  repeat:  { ar: 'كرّرها', en: 'Repeat' },
  improve: { ar: 'حسّنها', en: 'Improve' },
  stop:    { ar: 'أوقفها', en: 'Stop' },
  reuse:   { ar: 'أعد استخدامها', en: 'Reuse' },
};

/** What a brief still needs, in the user's language. Keys come from
 *  mkt_content_missing_requirements() — the same function the gate uses. */
export const BRIEF_MISSING_LABEL: Record<string, { ar: string; en: string }> = {
  scope:                     { ar: 'النطاق', en: 'Scope' },
  owner:                     { ar: 'المسؤول', en: 'Owner' },
  strategy_version:          { ar: 'نسخة الاستراتيجية', en: 'Strategy version' },
  approved_strategy_version: { ar: 'نسخة استراتيجية معتمدة', en: 'An approved strategy version' },
  plan:                      { ar: 'الخطة', en: 'Plan' },
  goal_or_always_on_reason:  { ar: 'هدف أو سبب استمراري', en: 'A goal, or an always-on reason' },
  audience:                  { ar: 'الجمهور', en: 'Audience' },
  message:                   { ar: 'الرسالة', en: 'Message' },
  desired_action:            { ar: 'الإجراء المطلوب', en: 'Desired action' },
  at_least_one_deliverable:  { ar: 'مخرَج واحد على الأقل', en: 'At least one deliverable' },
  not_found:                 { ar: 'غير موجود', en: 'Not found' },
};

/** What one output still needs before it can be scheduled. `approved_*` keys
 *  are generated from the workflow, so they are resolved dynamically. */
export const BLOCKER_LABEL: Record<string, { ar: string; en: string }> = {
  platform:         { ar: 'المنصة', en: 'Platform' },
  platform_account: { ar: 'الحساب', en: 'Account' },
  publish_time:     { ar: 'وقت النشر', en: 'Publish time' },
  paid_ad_link:     { ar: 'الربط بالإعلان', en: 'Ad link' },
  not_found:        { ar: 'غير موجود', en: 'Not found' },
};

/** `approved_final_media` → "المادة النهائية معتمدة". Falls back to the raw key
 *  rather than inventing a translation for something new. */
export function blockerLabel(key: string, isAr: boolean, types: ArtifactType[]): string {
  const known = BLOCKER_LABEL[key];
  if (known) return isAr ? known.ar : known.en;
  if (key.startsWith('approved_')) {
    const t = types.find((x) => x.key === key.slice('approved_'.length));
    const name = t ? (isAr ? t.label_ar : t.label_en) : key.slice('approved_'.length);
    return isAr ? `${name} (معتمد)` : `${name} (approved)`;
  }
  return key;
}
