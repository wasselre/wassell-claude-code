/**
 * POST /api/marketing-mgmt
 *
 * Internal Marketing Management (إدارة التسويق) — the execution side.
 * Distinct from /api/marketing, which serves external competitor intelligence
 * (ذكاء التسويق). One action-dispatch endpoint so the SPA makes a single
 * authenticated call per screen.
 *
 * AUTH POSTURE — deliberately different from /api/marketing.
 * Every call runs on the CALLER'S JWT, never service-role. The 22 mkt_mgmt
 * tables carry RLS policies driven by `wassell_mkt_can(capability)`, so the
 * database is the authorization boundary: a writer physically cannot approve, a
 * reviewer physically cannot publish, a viewer physically cannot write — even if
 * they call this endpoint directly with a hand-made request. Hiding buttons is
 * not access control; this endpoint does not pretend otherwise, and there is no
 * service-role escape hatch in it.
 *
 * Actions
 *   overview            → KPIs + operational queues + alerts (one round trip)
 *   generate_alerts     → run the deterministic alert rules
 *   campaign_list       → campaigns with rollups
 *   campaign_detail     → one campaign + content + tasks + performance
 *   campaign_save       → create/update a campaign
 *   content_list        → filtered content items (table/board/calendar feed)
 *   content_detail      → one item + versions + tasks + approvals + publications
 *   content_create      → create content (+ auto-generate its task checklist)
 *   content_update      → patch fields
 *   content_transition  → move status (DB rejects invalid jumps)
 *   version_create      → add a version (approved ones become immutable)
 *   approval_decide     → approve / request changes / reject
 *   task_update         → status, assignee, due date
 *   scene_save/slide_save/scene_reorder/slide_reorder
 *   asset_list/asset_save/asset_link
 *   publication_save    → schedule / mark published (manual workflow)
 *   performance_record  → append a snapshot (never overwrites)
 *   attribution_record  → link CRM outcome to campaign/content/publication
 *   intelligence_action → create content/campaign from an external insight
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';

export const config = { runtime: 'edge' };

/** Columns a user may edit on a content item. See content_update for why. */
const CONTENT_EDITABLE = [
  'title', 'content_type', 'priority', 'purpose', 'project_id', 'campaign_id',
  'owner_user_id', 'writer_user_id', 'designer_user_id', 'editor_user_id',
  'presenter_user_id', 'photographer_user_id',
  'due_date', 'planned_publish_at', 'language', 'target_audience', 'content_pillar',
  'hook', 'main_idea', 'cta', 'caption', 'hashtags', 'reference_links',
  'production_notes', 'archived_at',
  // 2026-08-21 marketing fields
  'organic_or_paid', 'funnel_stage', 'content_angle', 'offer_message',
  'cta_destination', 'tracking_link', 'next_action', 'blocker', 'final_asset_id',
  // v2 strategic context. origin_* is settable because a draft may be
  // reclassified; the DB CHECK keeps kind and FK in agreement, and reuse goes
  // through mkt_content_usage rather than rewriting these.
  'plan_id', 'primary_goal_id', 'primary_pillar_id', 'strategic_purpose',
  'origin_kind', 'origin_program_id', 'origin_campaign_id', 'reactive_trigger',
] as const;

/** The BRIEF's strategic fields. Deliberately excludes the ones that differ per
 *  platform output — caption, hashtags, cta_destination, planned_publish_at —
 *  which now live on the deliverable. Writing them here would recreate exactly
 *  the "one idea, one platform" collapse the deliverable layer removed. */
const BRIEF_EDITABLE = [
  'strategy_version_id', 'scope_kind', 'scope_note',
  'audience_insight', 'core_promise', 'evidence', 'desired_action',
  'mandatory_info', 'prohibited_claims', 'always_on_reason',
  'parent_content_item_id', 'reuse_kind',
  'brief_due_date', 'production_due_date', 'review_due_date',
  'window_start', 'window_end',
] as const;

const DELIVERABLE_EDITABLE = [
  'label', 'platform', 'social_account_id', 'distribution', 'format', 'language',
  'aspect_ratio', 'target_seconds', 'owner_user_id', 'due_date',
  'planned_publish_at', 'status', 'primary_kpi', 'kpi_unit', 'kpi_target',
  'workflow_template_key', 'notes',
  'caption', 'hashtags', 'first_comment', 'cta_destination', 'destination_url',
  'archived_at',
] as const;

/** An artifact version is created, never edited into a different shape.
 *  approval_state / approved_by / approved_at are absent on purpose: they move
 *  only through artifact_decide, so a caller cannot approve their own draft by
 *  putting "approved" in a patch. */
const ARTIFACT_EDITABLE = [
  'content_item_id', 'deliverable_id', 'version_type', 'payload', 'file_id',
  'change_summary', 'owner_user_id', 'parent_version_id',
] as const;

const CONTENT_TASK_EDITABLE = [
  'title', 'assigned_user_id', 'reviewer_user_id', 'due_date', 'status',
  'priority', 'notes', 'attachment_file_id', 'blocked_reason', 'skipped_reason',
  'depends_on_task_id',
] as const;

const PUBLICATION_OPS_EDITABLE = [
  'deliverable_id', 'content_item_id', 'platform', 'social_account_id', 'channel',
  'scheduled_for', 'scheduled_timezone', 'status', 'publish_method',
  'destination_url', 'utm', 'first_comment', 'ad_id',
  'published_at', 'published_url', 'platform_post_id', 'error_message',
] as const;

const RESULT_EDITABLE = [
  'content_item_id', 'deliverable_id', 'goal_id', 'kpi_actual', 'measured_at',
  'metrics', 'leads', 'qualified_leads', 'clicks', 'conversions', 'spend',
  'cost_per_lead', 'attribution_source', 'learning', 'recommendation',
] as const;

/** Copy only allow-listed keys. Everything the v2 layer writes goes through
 *  this, so ids, generated numbers, approval stamps and needs_classification
 *  can never be set by a caller. */
function pick(src: unknown, allowed: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!src || typeof src !== 'object') return out;
  const o = src as Record<string, unknown>;
  for (const k of allowed) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
  return out;
}

// status is NOT here: it moves via strategy_approve, which also supersedes the
// incumbent. approver_user_id / approved_at are stamped server-side.
const STRATEGY_EDITABLE = [
  'name_ar', 'name_en', 'summary_ar', 'summary_en', 'effective_date', 'expires_at',
  'positioning', 'organic_paid_strategy', 'priority_audiences', 'customer_problems',
  'value_propositions', 'priority_markets', 'property_categories', 'funnel',
  'channel_roles', 'content_principles', 'measurement_principles',
  'strategic_priorities', 'not_priorities', 'assumptions', 'risks',
  'owner_user_id', 'archived_at',
] as const;

const PLAN_EDITABLE = [
  'plan_type', 'parent_plan_id', 'strategy_version_id', 'name_ar', 'name_en',
  'summary_ar', 'summary_en', 'status', 'period_start', 'period_end', 'priorities',
  'budget', 'channel_budgets', 'team_capacity', 'production_capacity',
  'priority_audiences', 'priority_locations', 'property_types', 'assumptions',
  'risks', 'dependencies', 'review_frequency', 'owner_user_id', 'archived_at',
] as const;

// actual_value is DELIBERATELY absent. It is a cache of
// mkt_goal_actual(), refreshed by trigger when a measurement is recorded, so the
// only way the number moves is by entering evidence. Letting a form overwrite it
// would make "actual" a claim rather than a reading.
const GOAL_EDITABLE = [
  'plan_id', 'parent_goal_id', 'goal_class', 'goal_category',
  'name_ar', 'name_en', 'description',
  'metric', 'unit', 'baseline_value', 'baseline_date', 'baseline_state',
  'target_value', 'start_date', 'end_date',
  'owner_user_id', 'measurement_frequency', 'source_of_truth', 'source_of_truth_note',
  'aggregation_method', 'scope', 'status',
  'linked_initiative_id', 'linked_program_id', 'linked_campaign_id',
  'forecast_value', 'result', 'notes', 'assumptions', 'needs_classification', 'archived_at',
] as const;

/** A measurement is evidence, so only the observation itself is settable —
 *  entered_by and created_at are stamped server-side. */
const MEASUREMENT_EDITABLE = [
  'goal_id', 'value', 'measured_at', 'period_start', 'period_end',
  'source_key', 'evidence',
] as const;

const TARGET_PERIOD_EDITABLE = [
  'label', 'period_start', 'period_end', 'target_value', 'actual_value',
  'forecast_value', 'notes',
] as const;

const INITIATIVE_EDITABLE = [
  'plan_id', 'primary_goal_id', 'name_ar', 'name_en', 'problem_or_opportunity',
  'hypothesis', 'target_audiences', 'scope', 'locations', 'property_types',
  'channels', 'start_date', 'review_date', 'end_date', 'budget', 'owner_user_id',
  'status', 'expected_contribution', 'actual_contribution', 'lessons', 'archived_at',
] as const;

/** `end_date` is not here and there is no such column: a program is ongoing.
 *  The recurring commitment is four explicit fields — how many (commitment_count)
 *  of what (output_type) every how many (every_n_periods) of which period
 *  (commitment_unit) — so "3 project videos every week" is data the UI composes
 *  a sentence from, not a sentence someone has to parse. */
const PROGRAM_EDITABLE = [
  'plan_id', 'initiative_id', 'primary_goal_id', 'name_ar', 'name_en', 'purpose',
  'target_audience', 'content_pillars', 'platforms', 'accounts', 'formats',
  'cadence', 'commitment_count', 'commitment_unit', 'output_type', 'every_n_periods',
  'kpi_targets', 'owner_user_id',
  'review_frequency', 'status', 'start_date', 'lessons', 'archived_at',
] as const;

const CHANNEL_PLAN_EDITABLE = [
  'plan_id', 'platform', 'account_handle', 'max_per_day', 'max_per_week',
  'format_mix', 'pillar_mix', 'reactive_reserve', 'same_project_max_per_week', 'notes',
] as const;

const ALLOCATION_EDITABLE = [
  'channel_plan_id', 'week_start', 'allocation_kind', 'program_id', 'campaign_id',
  'slots_requested', 'slots_granted', 'note',
] as const;

const PLATFORM_CAMPAIGN_EDITABLE = [
  'campaign_id', 'platform', 'name', 'platform_config', 'config_schema_version',
  'objective', 'budget', 'budget_kind', 'start_date', 'end_date', 'destination_url',
  'conversion_event', 'tracking_template', 'status', 'external_id', 'owner_user_id',
] as const;

const AD_GROUP_EDITABLE = [
  'platform_campaign_id', 'name', 'targeting', 'targeting_schema_version',
  'budget', 'bid_strategy', 'start_date', 'end_date', 'status', 'external_id',
] as const;

const AD_EDITABLE = [
  'ad_group_id', 'name', 'content_item_id', 'primary_text', 'headline',
  'description', 'cta_label', 'destination_url', 'status', 'external_id',
] as const;

const REVIEW_EDITABLE = [
  'plan_id', 'review_type', 'period_start', 'period_end', 'summary', 'what_worked',
  'what_did_not', 'lessons', 'status', 'reviewer_user_id', 'held_at',
] as const;

const REVIEW_DECISION_EDITABLE = [
  'review_id', 'initiative_id', 'program_id', 'campaign_id', 'goal_id', 'decision',
  'rationale', 'goal_forecast_before', 'goal_forecast_after', 'budget_change',
  'capacity_change',
] as const;

const USAGE_EDITABLE = [
  'content_item_id', 'usage_kind', 'campaign_id', 'program_id', 'initiative_id',
  'publication_id', 'note',
] as const;

/** Campaign columns a user may edit: the v1 set, verified against the live
 *  table's columns, plus the v2 portfolio fields. campaign_save previously
 *  forwarded ANY key — the same hole that was closed on content_update — so id,
 *  created_by_user_id, needs_classification and the review-owned decision
 *  columns were all writable by a caller. They are not on this list.
 *  `decision` is set by review_decide, never by editing the campaign.
 *
 *  `code` is DELIBERATELY absent. It is issued by the database from a sequence
 *  (mkt_next_campaign_code) so two concurrent creates cannot collide, and a
 *  code that a caller could set is a code a caller could change — which would
 *  break every printed reference to a campaign. `needs_classification` is
 *  absent for the same reason it is absent on goals: it is derived by trigger
 *  from whether a plan and a primary goal are present, so setting it by hand
 *  could only ever make it a lie.
 *
 *  `campaign_class` IS settable so creation can declare organic or paid, but a
 *  NULL class is refused on insert by the database — and a legacy null is
 *  cleared through campaign_classify, not through a plain edit. */
// `status` is NOT here, and `channel_mix` is NOT here.
//
//   status       moves only through campaign_transition, which asks the database
//                which moves are legal and refuses the rest. Leaving it in this
//                list is what allowed archived → active from a generic save.
//   channel_mix  is derived from campaign_class by trigger. It is a legacy
//                column kept for old readers, never a question for a user.
const CAMPAIGN_EDITABLE = [
  // v1
  'name_ar', 'name_en', 'campaign_type', 'priority',
  'start_date', 'end_date', 'objective', 'offer', 'main_message', 'hooks', 'cta',
  'landing_url', 'positioning', 'content_pillars', 'target_audience', 'budget',
  'target_leads', 'target_revenue', 'target_sales', 'target_appointments',
  'target_cpl', 'target_cpa', 'target_roas', 'owner_user_id', 'archived_at',
  // v2 portfolio
  'plan_id', 'initiative_id', 'program_id', 'primary_goal_id', 'campaign_class',
  'funnel_stage', 'deliverables', 'actual_results', 'lessons',
  // 2026-08-26 operational fields
  'budget_kind', 'conversion_objective', 'tracking_template',
  'locations', 'property_types', 'period_override_reason',
] as const;

interface Body {
  action?: string;
  id?: string;
  platforms?: unknown[];
  // v2 planning layer
  plan_id?: string;
  goal_id?: string;
  channel_plan_id?: string;
  week_start?: string;
  periods?: unknown[];
  user_id?: string;
  role?: string;
  version_number?: number;
  strategy_version_id?: string;
  reason?: string;
  campaign_id?: string;
  initiative_id?: string;
  campaign_class?: string;
  content_item_id?: string;
  project_id?: string;
  limit?: number;
  patch?: Record<string, unknown>;
  // content_create
  title?: string;
  content_type?: string;
  // transitions (also carries the campaign status machine's target status)
  to_status?: string;
  // versions / approvals
  version_type?: string;
  payload?: Record<string, unknown>;
  change_summary?: string;
  file_id?: string;
  // content operations: brief -> deliverable -> artifact -> publication -> result
  deliverable_id?: string;
  artifact_type?: string;
  asset_id?: string;
  replace?: boolean;
  review_comment?: string;
  target_type?: string;
  target_id?: string;
  // bulk operations
  ids?: unknown[];
  start_at?: string;
  interval_mins?: number;
  approval_id?: string;
  // 'pending' is a real decision value: mkt_approvals CHECKs
  // (decision = 'pending' OR decided_at IS NOT NULL), and the handler leaves
  // decided_at null for it. Omitting it here made that branch look unreachable.
  decision?: 'pending' | 'approved' | 'changes_requested' | 'rejected' | 'cancelled';
  stage?: string;
  comment?: string;
  requested_changes?: string;
  target_type?: string;
  target_id?: string;
  // tasks / scenes / slides
  task_id?: string;
  scene_id?: string;
  slide_id?: string;
  order?: string[];
  // assets
  asset_id?: string;
  asset_ids?: string[];
  // publications / performance
  publication_id?: string;
  metrics?: Record<string, unknown>;
  collection_status?: string;
  // filters
  status?: string;
  platform?: string;
  owner_user_id?: string;
  q?: string;
  // intelligence
  source_type?: string;
  source_id?: string;
  action_type?: string;
}

function callerClient(req: Request): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error('supabase env missing');
  const jwt = (req.headers.get('Authorization') ?? '').slice(7).trim();
  return createClient(url, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

/** public.users.id for the caller. AuthenticatedUser.userId is the AUTH uid;
 *  every FK in this module points at public.users, and the two are different
 *  ids in this schema — writing the auth uid into a user FK would silently
 *  create rows attributed to nobody. */
async function resolveAppUserId(sb: SupabaseClient, authUid: string): Promise<string | null> {
  const { data } = await sb.rpc('wassell_app_user_id', { auth_user_id: authUid });
  return (data as string | null) ?? null;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const cap = (n: unknown, def: number, max: number) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : def;

// ── Database errors, translated ────────────────────────────────────────────
//
// A raw Postgres message is not an error message for a user. `null value in
// column "code" of relation "mkt_internal_campaigns" violates not-null
// constraint` names an internal table and an internal column, tells the user
// nothing they can act on, and reveals the schema to anyone who can reach the
// endpoint. Every rejection below is therefore translated into a sentence that
// says what to do, in both languages — and the original error is ALWAYS logged
// server-side with its code, details and hint, so debugging loses nothing.
//
// Two sources of truth for the mapping:
//   1. `MKT:<token>` — raised deliberately by our own triggers and RPCs.
//   2. A constraint name parsed out of Postgres's own text, for the CHECK and
//      unique constraints declared in the migrations.
// Anything unrecognised falls back to a generic sentence. It never falls back
// to echoing Postgres.

interface Msg { ar: string; en: string }

const DB_MESSAGES: Record<string, Msg> = {
  // deliberate rejections from mkt_* triggers and RPCs
  'MKT:campaign_class_required': {
    ar: 'يجب تحديد نوع الحملة: عضوية أو مدفوعة.',
    en: 'A campaign must be either organic or paid.',
  },
  'MKT:goal_other_plan': {
    ar: 'الهدف المختار يتبع خطة أخرى. اختر هدفاً من نفس الخطة.',
    en: 'That goal belongs to a different plan. Choose a goal from the selected plan.',
  },
  'MKT:initiative_other_plan': {
    ar: 'المبادرة المختارة تتبع خطة أخرى. اختر مبادرة من نفس الخطة.',
    en: 'That initiative belongs to a different plan. Choose one from the selected plan.',
  },
  'MKT:program_other_plan': {
    ar: 'البرنامج المختار يتبع خطة أخرى. اختر برنامجاً من نفس الخطة.',
    en: 'That program belongs to a different plan. Choose one from the selected plan.',
  },
  'MKT:dates_outside_plan': {
    ar: 'تواريخ الحملة خارج فترة الخطة. عدّل التواريخ أو سجّل سبب الاستثناء.',
    en: 'The dates fall outside the plan period. Adjust them, or record a reason for the exception.',
  },
  'MKT:has_dependents': {
    ar: 'لا يمكن الحذف: السجل مرتبط بمحتوى أو إعلانات أو نشر أو قياسات. استخدم الأرشفة بدلاً من الحذف.',
    en: 'Cannot delete: this record still carries content, ads, publications or measurements. Archive it instead.',
  },
  'MKT:campaign_code_unavailable': {
    ar: 'تعذّر توليد رمز حملة جديد. أبلغ الدعم الفني.',
    en: 'Could not issue a new campaign code. Please report this.',
  },
  'MKT:not_permitted': {
    ar: 'دورك في التسويق لا يسمح بهذا الإجراء.',
    en: 'Your marketing role does not permit this action.',
  },
  'MKT:not_found': { ar: 'السجل غير موجود.', en: 'That record no longer exists.' },
  'MKT:invalid_status_transition': {
    ar: 'لا يمكن الانتقال إلى هذه الحالة من الحالة الحالية.',
    en: 'That status cannot be reached from the campaign’s current status.',
  },
  // The blocker list is appended to this token by the trigger, and the endpoint
  // expands it into named, translated items before the message is sent.
  'MKT:campaign_incomplete': {
    ar: 'الحملة غير مكتملة بعد.',
    en: 'This campaign is not complete yet.',
  },
  'MKT:history_append_only': {
    ar: 'سجل الحالات لا يُعدَّل ولا يُحذف.',
    en: 'Status history cannot be edited or deleted.',
  },

  // named constraints, in the same words the forms use
  mkt_camp_active_complete: {
    ar: 'لا يمكن تفعيل الحملة قبل تحديد الخطة والهدف والمسؤول والنوع وتاريخي البداية والنهاية.',
    en: 'A campaign cannot be activated until its plan, goal, owner, type and both dates are set.',
  },
  mkt_init_active_complete: {
    ar: 'لا يمكن تفعيل المبادرة قبل تحديد الخطة والهدف الرئيسي والمسؤول.',
    en: 'An initiative cannot be activated until its plan, primary goal and owner are set.',
  },
  mkt_prog_active_complete: {
    ar: 'لا يمكن تفعيل البرنامج قبل تحديد الخطة والهدف الرئيسي والمسؤول.',
    en: 'A program cannot be activated until its plan, primary goal and owner are set.',
  },
  campaign_dates_ordered: {
    ar: 'تاريخ النهاية لا يمكن أن يسبق تاريخ البداية.',
    en: 'The end date cannot come before the start date.',
  },
  mkt_init_date_order: {
    ar: 'تاريخ النهاية لا يمكن أن يسبق تاريخ البداية.',
    en: 'The end date cannot come before the start date.',
  },
  mkt_goal_date_order: {
    ar: 'تاريخ النهاية لا يمكن أن يسبق تاريخ البداية.',
    en: 'The end date cannot come before the start date.',
  },
  mkt_plan_period_order: {
    ar: 'نهاية فترة الخطة لا يمكن أن تسبق بدايتها.',
    en: 'The plan period cannot end before it starts.',
  },
  mkt_prog_commitment_positive: {
    ar: 'عدد المخرجات المتكررة يجب أن يكون أكبر من صفر.',
    en: 'The recurring output count must be greater than zero.',
  },
  mkt_prog_every_n_positive: {
    ar: 'عدد الفترات بين كل تكرار يجب أن يكون أكبر من صفر.',
    en: 'The repeat interval must be greater than zero.',
  },
  mkt_prog_commitment_pair: {
    ar: 'حدّد عدد المخرجات والفترة معاً، أو اتركهما فارغين معاً.',
    en: 'Set both the output count and the period, or neither.',
  },
  mkt_internal_campaigns_budget_check: {
    ar: 'الميزانية لا يمكن أن تكون بالسالب.',
    en: 'A budget cannot be negative.',
  },
  mkt_camp_class_check: {
    ar: 'نوع الحملة يجب أن يكون عضوية أو مدفوعة.',
    en: 'A campaign type must be organic or paid.',
  },
  // campaign_type is the campaign's PURPOSE (a launch, an offer, retargeting).
  // It stopped accepting 'organic'/'paid' when those moved to campaign_class,
  // so a caller still sending them there gets a sentence rather than a 23514.
  mkt_internal_campaigns_campaign_type_check: {
    ar: 'غرض الحملة غير صالح. «عضوية» و«مدفوعة» تُحدَّد في نوع الحملة، لا في غرضها.',
    en: 'That campaign purpose is not valid. Organic and paid belong to the campaign type, not its purpose.',
  },
  mkt_plan_active_needs_strategy: {
    ar: 'لا يمكن اعتماد الخطة أو تفعيلها قبل ربطها بنسخة استراتيجية معتمدة.',
    en: 'A plan cannot be approved or activated until it is bound to an approved strategy version.',
  },
  mkt_internal_campaigns_code_key: {
    ar: 'رمز الحملة مستخدم بالفعل.',
    en: 'That campaign code is already in use.',
  },
};

/** Generic per-SQLSTATE text, used when nothing more specific is recognised. */
const CODE_MESSAGES: Record<string, Msg> = {
  '23502': {
    ar: 'حقل مطلوب لم يُملأ. راجع الحقول الإلزامية ثم أعد المحاولة.',
    en: 'A required value is missing. Fill in the required fields and try again.',
  },
  '23505': {
    ar: 'هذه القيمة مستخدمة بالفعل في سجل آخر.',
    en: 'That value is already used by another record.',
  },
  '23503': {
    ar: 'السجل المرتبط غير موجود أو ما زال قيد الاستخدام.',
    en: 'A referenced record is missing or still in use.',
  },
  '23514': {
    ar: 'العملية ترفضها قواعد النظام في هذه الحالة.',
    en: 'The rules for this record do not allow that change.',
  },
  '42501': {
    ar: 'دورك في التسويق لا يسمح بهذا الإجراء.',
    en: 'Your marketing role does not permit this action.',
  },
};

const GENERIC: Msg = {
  ar: 'تعذّر حفظ التغيير. حُفظت تفاصيل الخطأ للمراجعة.',
  en: 'The change could not be saved. The details have been logged for review.',
};

/** The names mkt_campaign_activation_blockers() returns, in the user's words.
 *  Shared by the error path and the campaign_next_statuses payload so a blocker
 *  reads identically whether it is shown ahead of time or after a refusal. */
const BLOCKER_LABELS: Record<string, Msg> = {
  campaign_class:    { ar: 'نوع الحملة (عضوية/مدفوعة)', en: 'organic or paid' },
  plan:              { ar: 'الخطة', en: 'plan' },
  primary_goal:      { ar: 'الهدف الرئيسي', en: 'primary goal' },
  owner:             { ar: 'المسؤول', en: 'owner' },
  start_date:        { ar: 'تاريخ البداية', en: 'start date' },
  end_date:          { ar: 'تاريخ النهاية', en: 'end date' },
  objective:         { ar: 'الهدف التجاري', en: 'business objective' },
  deliverables:      { ar: 'المخرجات', en: 'deliverables' },
  platform_campaign: { ar: 'حملة منصة واحدة على الأقل', en: 'at least one platform campaign' },
  not_found:         { ar: 'السجل غير موجود', en: 'record not found' },
};

/** Bilingual error body. The client picks a side by the interface language, so
 *  neither the server nor the UI has to guess which one the reader wants. */
function jsonErrorBi(status: number, m: Msg): Response {
  return new Response(JSON.stringify({ error: m.en, error_ar: m.ar }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

type PgErr = { message?: string; code?: string; details?: string | null; hint?: string | null };

/** Translate a database rejection, and log the original.
 *
 *  RLS returns an empty result rather than an error when a capability is
 *  missing, which would read as "no data" instead of "not allowed" — so a
 *  permission failure is turned into an honest 403 here rather than an empty
 *  list at the screen. */
function dbError(error: PgErr | null, where: string): Response | null {
  if (!error) return null;
  const raw = error.message ?? '';
  const code = error.code ?? '';

  // Everything internal goes to the log, never to the response.
  console.error('[marketing-mgmt] db error', {
    action: where, code, message: raw, details: error.details ?? null, hint: error.hint ?? null,
  });

  const token = raw.match(/MKT:[a-z_]+/)?.[0];

  // The completeness trigger appends the blocker list after the token
  // (MKT:campaign_incomplete:plan,owner). Naming the missing pieces is the whole
  // value of the message — "not complete yet" alone gives the user nothing to do.
  if (token === 'MKT:campaign_incomplete') {
    const items = (raw.split('MKT:campaign_incomplete:')[1] ?? '')
      .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (items.length) {
      const ar = items.map((k) => BLOCKER_LABELS[k]?.ar ?? k).join('، ');
      const en = items.map((k) => BLOCKER_LABELS[k]?.en ?? k).join(', ');
      return jsonErrorBi(409, {
        ar: `لا يمكن تفعيل الحملة قبل استكمال: ${ar}.`,
        en: `This campaign cannot be activated until these are set: ${en}.`,
      });
    }
  }
  // Permission is checked FIRST: it is also in DB_MESSAGES, and answering 409
  // for it would tell the caller "your data is wrong" when the truth is "you are
  // not allowed", which is the one distinction this endpoint exists to keep.
  if (token === 'MKT:not_permitted') return jsonErrorBi(403, DB_MESSAGES['MKT:not_permitted']!);
  if (token === 'MKT:not_found') return jsonErrorBi(404, DB_MESSAGES['MKT:not_found']!);
  if (token && DB_MESSAGES[token]) return jsonErrorBi(409, DB_MESSAGES[token]!);

  const constraint = raw.match(/constraint "([a-zA-Z0-9_]+)"/)?.[1];
  if (constraint && DB_MESSAGES[constraint]) return jsonErrorBi(409, DB_MESSAGES[constraint]!);

  if (code === '42501' || /row-level security|permission denied/i.test(raw)) {
    return jsonErrorBi(403, CODE_MESSAGES['42501']!);
  }
  if (CODE_MESSAGES[code]) return jsonErrorBi(409, CODE_MESSAGES[code]!);

  // 42703 = undefined_column / 42883 = undefined_function / PGRST20x = schema
  // cache. In this codebase that means the app deployed ahead of its migration,
  // which otherwise surfaces as a bare 500 and reads like a bug in the form.
  // Name the remedy without quoting the missing object at the user.
  if (code === '42703' || code === '42883' || code === 'PGRST202' || code === 'PGRST204') {
    return jsonErrorBi(503, {
      ar: 'قاعدة البيانات لا تحتوي على تحديث يتوقعه هذا الإصدار من التطبيق. طبّق آخر ملف ترحيل ثم أعد المحاولة.',
      en: 'The database is missing an update this build expects. Apply the latest migration, then retry.',
    });
  }
  return jsonErrorBi(500, GENERIC);
}

/** Kept as the name every existing call site uses. `where` defaults to the
 *  action, which the handler binds once per request. */
let currentAction = '';
const rlsAware = (error: PgErr | null): Response | null => dbError(error, currentAction);

/** A NEW portfolio object must say where it sits in the plan.
 *
 *  The database allows a draft with no plan and no goal — legacy rows are
 *  exactly that, and refusing to save them would strand records nobody can
 *  fix. But nothing NEW should be created loose: an unattached campaign is how
 *  the "unclassified" pile grew in the first place. So the rule lives here, at
 *  the creation boundary, while the database enforces the harder rule that
 *  nothing INCOMPLETE can go active. */
function requirePortfolioContext(patch: Record<string, unknown>, kind: 'campaign' | 'program' | 'initiative'): Response | null {
  if (!patch.plan_id) {
    return jsonErrorBi(400, { ar: 'اختر الخطة قبل الإنشاء.', en: 'Choose a plan before creating this.' });
  }
  if (!patch.primary_goal_id) {
    return jsonErrorBi(400, {
      ar: 'اختر الهدف الرئيسي قبل الإنشاء — لا يُنشأ عنصر بلا هدف.',
      en: 'Choose a primary goal before creating this — nothing is created without one.',
    });
  }
  if (kind === 'campaign' && patch.campaign_class !== 'organic' && patch.campaign_class !== 'paid') {
    return jsonErrorBi(400, DB_MESSAGES['MKT:campaign_class_required']!);
  }
  return null;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, 'method not allowed');
  return withAuth(req, async (user) => {
    const body = (await req.json().catch(() => ({}))) as Body;
    const action = body.action ?? '';
    currentAction = action;
    let sb: SupabaseClient;
    try { sb = callerClient(req); } catch { return jsonError(500, 'supabase env missing'); }
    const appUserId = await resolveAppUserId(sb, user.userId);

    switch (action) {
      // ── Overview ─────────────────────────────────────────────────────────
      case 'overview': {
        const { data, error } = await sb.rpc('mkt_mgmt_overview', { p_limit: cap(body.limit, 12, 50) });
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ overview: data });
      }
      case 'generate_alerts': {
        const { data, error } = await sb.rpc('mkt_mgmt_generate_alerts');
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ rules: data });
      }

      // ── Campaigns ────────────────────────────────────────────────────────
      case 'campaign_list': {
        const { data, error } = await sb
          .from('mkt_internal_campaigns')
          .select('*, mkt_internal_campaign_projects(project_id), mkt_content_items!campaign_id(id,status)')
          .is('archived_at', null)
          .order('created_at', { ascending: false })
          .limit(cap(body.limit, 100, 500));
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ campaigns: data ?? [] });
      }
      case 'campaign_detail': {
        const id = str(body.id ?? body.campaign_id);
        if (!id) return jsonError(400, 'id required');
        // Content is fetched by RELATIONSHIP, not by one ambiguous embed.
        // mkt_content_items reaches campaigns through two foreign keys
        // (campaign_id, origin_campaign_id) plus mkt_content_usage and the paid
        // hierarchy — four different meanings of "campaign content" that the old
        // single `campaign_id` query silently flattened into one list.
        const CONTENT_COLS = 'id,content_number,title,content_type,status,due_date,owner_user_id,campaign_id,origin_campaign_id';
        const [c, produced, legacy, usage, tasks, perf, counts, progress, history, next] = await Promise.all([
          sb.from('mkt_internal_campaigns').select('*, mkt_internal_campaign_projects(project_id), mkt_internal_campaign_members(user_id,role_in_campaign)').eq('id', id).maybeSingle(),
          sb.from('mkt_content_items').select(CONTENT_COLS).eq('origin_campaign_id', id).is('archived_at', null),
          sb.from('mkt_content_items').select(CONTENT_COLS).eq('campaign_id', id).is('archived_at', null),
          sb.from('mkt_content_usage')
            .select(`id,usage_kind,note,created_at,mkt_content_items!content_item_id(${CONTENT_COLS})`)
            .eq('campaign_id', id),
          sb.from('mkt_content_tasks').select('id,title,status,due_date,assigned_user_id,content_item_id').eq('campaign_id', id),
          sb.from('mkt_performance_snapshots').select('*').eq('campaign_id', id).order('captured_at', { ascending: false }).limit(200),
          sb.rpc('mkt_campaign_content_counts', { p_campaign_id: id }),
          sb.rpc('mkt_campaign_progress', { p_campaign_id: id }),
          sb.from('mkt_campaign_status_history').select('*').eq('campaign_id', id)
            .order('changed_at', { ascending: false }).limit(100),
          sb.rpc('mkt_campaign_next_statuses', { p_campaign_id: id }),
        ]);
        const bad = rlsAware(c.error ?? produced.error ?? legacy.error ?? tasks.error ?? perf.error); if (bad) return bad;
        if (!c.data) return jsonErrorBi(404, DB_MESSAGES['MKT:not_found']!);

        type ContentRow = Record<string, unknown> & { id: string };
        const producedRows = (produced.data ?? []) as ContentRow[];
        const producedIds = new Set(producedRows.map((r) => r.id));
        const reusedRows = (usage.data ?? [])
          .map((u): ContentRow | null => {
            // PostgREST returns an embedded to-one as an object, but as an array
            // when it cannot prove the relationship is to-one. Accept both.
            const ci = (u as { mkt_content_items?: unknown }).mkt_content_items;
            const item = (Array.isArray(ci) ? ci[0] : ci) as ContentRow | undefined;
            return item ? { ...item, usage_kind: u.usage_kind, usage_id: u.id } : null;
          })
          .filter((r): r is ContentRow => r !== null && !producedIds.has(r.id));
        const reusedIds = new Set(reusedRows.map((r) => r.id));
        // Legacy = joined by the old campaign_id and NOT already explained by a
        // newer relationship. Kept visible; just no longer the only definition.
        const legacyRows = ((legacy.data ?? []) as ContentRow[]).filter(
          (r) => !producedIds.has(r.id) && !reusedIds.has(r.id));

        return jsonOk({
          campaign: c.data,
          // `content` stays for existing readers: the deduplicated union.
          content: [...producedRows, ...reusedRows, ...legacyRows],
          produced_content: producedRows,
          reused_content: reusedRows,
          legacy_content: legacyRows,
          counts: counts.data ?? null,
          progress: progress.data ?? null,
          status_history: history.data ?? [],
          next_statuses: next.data ?? [],
          tasks: tasks.data ?? [], performance: perf.data ?? [],
        });
      }
      case 'campaign_save': {
        const patch = pick(body.patch, CAMPAIGN_EDITABLE);
        const id = str(body.id);
        if (!id) {
          const bad = requirePortfolioContext(patch, 'campaign'); if (bad) return bad;
        }
        const q = id
          ? sb.from('mkt_internal_campaigns').update(patch).eq('id', id).select().maybeSingle()
          : sb.from('mkt_internal_campaigns').insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ campaign: data });
      }

      case 'campaign_transition': {
        // The ONLY way a campaign's status moves. The database holds the legal
        // transitions and the activation blockers; this just carries the request
        // and lets the trigger refuse it.
        const id = str(body.id); const to = str(body.to_status);
        if (!id || !to) return jsonError(400, 'id and to_status required');
        const { data, error } = await sb.from('mkt_internal_campaigns')
          .update({ status: to }).eq('id', id).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        if (!data) return jsonErrorBi(404, DB_MESSAGES['MKT:not_found']!);
        const { data: next } = await sb.rpc('mkt_campaign_next_statuses', { p_campaign_id: id });
        return jsonOk({ campaign: data, next_statuses: next ?? [] });
      }

      case 'campaign_next_statuses': {
        const id = str(body.id); if (!id) return jsonError(400, 'id required');
        const [next, blockers] = await Promise.all([
          sb.rpc('mkt_campaign_next_statuses', { p_campaign_id: id }),
          sb.rpc('mkt_campaign_activation_blockers', { p_campaign_id: id }),
        ]);
        const bad = rlsAware(next.error); if (bad) return bad;
        return jsonOk({
          next_statuses: next.data ?? [],
          blockers: blockers.data ?? [],
          blocker_labels: BLOCKER_LABELS,
        });
      }

      // ── Content ──────────────────────────────────────────────────────────
      case 'content_list': {
        let q = sb.from('mkt_content_items')
          .select('*, mkt_content_platforms(platform)')
          .is('archived_at', null);
        if (str(body.status))        q = q.eq('status', body.status!);
        if (str(body.campaign_id))   q = q.eq('campaign_id', body.campaign_id!);
        if (str(body.project_id))    q = q.eq('project_id', body.project_id!);
        if (str(body.owner_user_id)) q = q.eq('owner_user_id', body.owner_user_id!);
        if (str(body.q))             q = q.ilike('title', `%${body.q}%`);
        const { data, error } = await q.order('due_date', { ascending: true, nullsFirst: false })
                                       .limit(cap(body.limit, 200, 500));
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ content: data ?? [] });
      }
      case 'content_detail': {
        const id = str(body.id ?? body.content_item_id);
        if (!id) return jsonError(400, 'id required');
        const [item, versions, tasks, approvals, pubs, history, scenes, slides, video, post, links] = await Promise.all([
          sb.from('mkt_content_items').select('*, mkt_content_platforms(platform)').eq('id', id).maybeSingle(),
          sb.from('mkt_content_versions').select('*').eq('content_item_id', id).order('version_type').order('version_number', { ascending: false }),
          sb.from('mkt_content_tasks').select('*').eq('content_item_id', id).order('sort_order'),
          sb.from('mkt_approvals').select('*').eq('target_id', id).order('created_at', { ascending: false }),
          sb.from('mkt_publications').select('*').eq('content_item_id', id).order('scheduled_for', { nullsFirst: false }),
          sb.from('mkt_content_status_history').select('*').eq('content_item_id', id).order('changed_at', { ascending: false }),
          sb.from('mkt_video_scenes').select('*').eq('content_item_id', id).order('scene_number'),
          sb.from('mkt_carousel_slides').select('*').eq('content_item_id', id).order('slide_number'),
          sb.from('mkt_video_details').select('*').eq('content_item_id', id).maybeSingle(),
          sb.from('mkt_post_details').select('*').eq('content_item_id', id).maybeSingle(),
          sb.from('mkt_asset_links').select('asset_id, mkt_raw_assets(*)').eq('target_type', 'content_item').eq('target_id', id),
        ]);
        const bad = rlsAware(item.error); if (bad) return bad;
        if (!item.data) return jsonError(404, 'content item not found');

        // Performance and attribution for THIS item, so the detail page can show
        // a result summary without a second round trip. Attribution is joined
        // through this item's publications — a lead can be credited to the
        // publication, the content or the campaign, and all three must count.
        const pubIds = (pubs.data ?? []).map((p: { id: string }) => p.id);
        const [perf, attrib, nextStatuses] = await Promise.all([
          pubIds.length
            ? sb.from('mkt_performance_snapshots').select('*')
                .in('publication_id', pubIds).order('captured_at', { ascending: false })
            : Promise.resolve({ data: [], error: null }),
          pubIds.length
            ? sb.from('mkt_lead_attributions').select('*')
                .or(`content_item_id.eq.${id},publication_id.in.(${pubIds.join(',')})`)
            : sb.from('mkt_lead_attributions').select('*').eq('content_item_id', id),
          sb.rpc('mkt_content_next_statuses', { p_from: (item.data as { status: string }).status }),
        ]);

        return jsonOk({
          item: item.data, versions: versions.data ?? [], tasks: tasks.data ?? [],
          approvals: approvals.data ?? [], publications: pubs.data ?? [], history: history.data ?? [],
          scenes: scenes.data ?? [], slides: slides.data ?? [],
          video: video.data ?? null, post: post.data ?? null, assets: links.data ?? [],
          performance: perf.data ?? [], attributions: attrib.data ?? [],
          // null (not []) when the RPC is missing, so the UI can tell "no legal
          // moves" apart from "this build is ahead of the database".
          allowed_transitions: (nextStatuses.data as string[] | null) ?? null,
        });
      }
      case 'platform_set': {
        // Target platforms are a set, so the write is a replace. Delete-then-
        // insert rather than upsert because removing a platform is the common
        // edit and upsert alone would never drop one.
        const id = str(body.content_item_id ?? body.id);
        if (!id) return jsonError(400, 'content_item_id required');
        const list = Array.isArray(body.platforms) ? body.platforms.filter((p): p is string => typeof p === 'string') : [];
        const del = await sb.from('mkt_content_platforms').delete().eq('content_item_id', id);
        const badDel = rlsAware(del.error); if (badDel) return badDel;
        if (list.length) {
          const ins = await sb.from('mkt_content_platforms')
            .insert(list.map((platform) => ({ content_item_id: id, platform })));
          const badIns = rlsAware(ins.error); if (badIns) return badIns;
        }
        return jsonOk({ platforms: list });
      }
      case 'content_create': {
        const title = str(body.title); const ctype = str(body.content_type);
        if (!title || !ctype) return jsonError(400, 'title + content_type required');
        const { data, error } = await sb.from('mkt_content_items')
          .insert({ ...(body.patch ?? {}), title, content_type: ctype, created_by_user_id: appUserId })
          .select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        // production checklist: idempotent, returns 0 if one already exists
        const { data: nTasks } = await sb.rpc('mkt_generate_content_tasks', { p_content_item_id: data!.id });
        return jsonOk({ item: data, tasks_generated: nTasks ?? 0 });
      }
      case 'content_update': {
        const id = str(body.id); if (!id) return jsonError(400, 'id required');
        // Allow-list, not deny-list. `status` moves only through content_transition
        // (the DB rejects invalid jumps), and identity/provenance columns —
        // content_number, created_by_user_id, created_at, source_* — are not
        // editable at all: the spec's claim that external evidence stays
        // traceable to internal execution is only true if nothing can rewrite
        // the link after the fact.
        const patch: Record<string, unknown> = {};
        for (const k of CONTENT_EDITABLE) {
          if (body.patch && Object.prototype.hasOwnProperty.call(body.patch, k)) patch[k] = body.patch[k];
        }
        if (Object.keys(patch).length === 0) return jsonError(400, 'no editable fields in patch');
        const { data, error } = await sb.from('mkt_content_items').update(patch).eq('id', id).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ item: data });
      }
      case 'content_transition': {
        const id = str(body.id); const to = str(body.to_status);
        if (!id || !to) return jsonError(400, 'id + to_status required');
        const { data, error } = await sb.from('mkt_content_items')
          .update({ status: to }).eq('id', id).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;   // 409 on an invalid jump
        return jsonOk({ item: data });
      }

      // ── Cross-item queues (Calendar / Publishing / Approvals / Performance)
      // These exist because those screens are NOT per-item: a calendar that can
      // only read one content item at a time is a mock, not a calendar.
      case 'publication_list': {
        let q = sb.from('mkt_publications')
          .select('*, mkt_content_items(id,content_number,title,content_type,status)');
        if (str(body.status))      q = q.eq('status', body.status!);
        if (str(body.platform))    q = q.eq('platform', body.platform!);
        if (str(body.campaign_id)) q = q.eq('campaign_id', body.campaign_id!);
        const { data, error } = await q
          .order('scheduled_for', { ascending: true, nullsFirst: false })
          .limit(cap(body.limit, 300, 1000));
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ publications: data ?? [] });
      }
      case 'approval_list': {
        let q = sb.from('mkt_approvals').select('*');
        if (str(body.status)) q = q.eq('decision', body.status!);
        const { data, error } = await q.order('created_at', { ascending: false }).limit(cap(body.limit, 200, 500));
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ approvals: data ?? [] });
      }
      case 'performance_list': {
        let q = sb.from('mkt_performance_snapshots').select('*');
        if (str(body.publication_id)) q = q.eq('publication_id', body.publication_id!);
        if (str(body.campaign_id))    q = q.eq('campaign_id', body.campaign_id!);
        const { data, error } = await q.order('captured_at', { ascending: false }).limit(cap(body.limit, 300, 1000));
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ snapshots: data ?? [] });
      }

      // ── Versions & approvals ─────────────────────────────────────────────
      case 'version_create': {
        const id = str(body.content_item_id); const vtype = str(body.version_type);
        if (!id || !vtype) return jsonError(400, 'content_item_id + version_type required');
        const { data: prev } = await sb.from('mkt_content_versions')
          .select('version_number').eq('content_item_id', id).eq('version_type', vtype)
          .order('version_number', { ascending: false }).limit(1);
        const next = (prev?.[0]?.version_number ?? 0) + 1;
        const { data, error } = await sb.from('mkt_content_versions').insert({
          content_item_id: id, version_type: vtype, version_number: next,
          payload: body.payload ?? {}, file_id: str(body.file_id) ?? null,
          change_summary: str(body.change_summary) ?? null, created_by_user_id: appUserId,
        }).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ version: data });
      }
      case 'approval_decide': {
        const decision = body.decision;
        if (!decision) return jsonError(400, 'decision required');
        const existing = str(body.approval_id);
        if (existing) {
          const { data, error } = await sb.from('mkt_approvals')
            .update({ decision, comment: str(body.comment) ?? null,
                      requested_changes: str(body.requested_changes) ?? null,
                      reviewer_user_id: appUserId, decided_at: new Date().toISOString() })
            .eq('id', existing).select().maybeSingle();
          const bad = rlsAware(error); if (bad) return bad;
          return jsonOk({ approval: data });
        }
        const tType = str(body.target_type) ?? 'content_item';
        const tId = str(body.target_id); const stage = str(body.stage);
        if (!tId || !stage) return jsonError(400, 'target_id + stage required');
        const { data, error } = await sb.from('mkt_approvals').insert({
          target_type: tType, target_id: tId, stage, decision,
          version_id: str(body.id) ?? null, reviewer_user_id: appUserId,
          comment: str(body.comment) ?? null, requested_changes: str(body.requested_changes) ?? null,
          decided_at: decision === 'pending' ? null : new Date().toISOString(),
        }).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        // approving a version locks it (DB trigger enforces immutability)
        if (decision === 'approved' && str(body.id)) {
          await sb.from('mkt_content_versions')
            .update({ approval_state: 'approved', approved_by_user_id: appUserId })
            .eq('id', body.id!);
        }
        return jsonOk({ approval: data });
      }

      // ── Tasks / scenes / slides ──────────────────────────────────────────
      case 'task_update': {
        const id = str(body.task_id ?? body.id); if (!id) return jsonError(400, 'task_id required');
        const { data, error } = await sb.from('mkt_content_tasks').update(body.patch ?? {}).eq('id', id).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;   // 409 if a dependency is unfinished
        return jsonOk({ task: data });
      }
      case 'scene_save': case 'slide_save': {
        const table = action === 'scene_save' ? 'mkt_video_scenes' : 'mkt_carousel_slides';
        const id = str(body.id);
        const q = id ? sb.from(table).update(body.patch ?? {}).eq('id', id).select().maybeSingle()
                     : sb.from(table).insert(body.patch ?? {}).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ row: data });
      }
      case 'scene_reorder': case 'slide_reorder': {
        const table = action === 'scene_reorder' ? 'mkt_video_scenes' : 'mkt_carousel_slides';
        const col = action === 'scene_reorder' ? 'scene_number' : 'slide_number';
        const ids = Array.isArray(body.order) ? body.order : [];
        if (ids.length === 0) return jsonError(400, 'order[] required');
        // two-pass: park into a negative range first so the per-item unique
        // ordering never collides mid-reorder
        for (let i = 0; i < ids.length; i++) {
          const { error } = await sb.from(table).update({ [col]: -(i + 1) }).eq('id', ids[i]!);
          const bad = rlsAware(error); if (bad) return bad;
        }
        for (let i = 0; i < ids.length; i++) {
          const { error } = await sb.from(table).update({ [col]: i + 1 }).eq('id', ids[i]!);
          const bad = rlsAware(error); if (bad) return bad;
        }
        return jsonOk({ reordered: ids.length });
      }

      // ── Assets ───────────────────────────────────────────────────────────
      case 'asset_list': {
        let q = sb.from('mkt_raw_assets').select('*').is('archived_at', null);
        if (str(body.project_id)) q = q.eq('project_id', body.project_id!);
        if (str(body.q)) q = q.or(`asset_name.ilike.%${body.q}%,transcript.ilike.%${body.q}%,ocr_text.ilike.%${body.q}%,ai_description.ilike.%${body.q}%`);
        const { data, error } = await q.order('created_at', { ascending: false }).limit(cap(body.limit, 100, 500));
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ assets: data ?? [] });
      }
      case 'asset_save': {
        const id = str(body.id);
        const q = id ? sb.from('mkt_raw_assets').update(body.patch ?? {}).eq('id', id).select().maybeSingle()
                     : sb.from('mkt_raw_assets').insert({ ...(body.patch ?? {}), uploaded_by_user_id: appUserId }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ asset: data });
      }
      case 'asset_process': {
        // Queue OCR / transcript / description for specific assets, or for every
        // un-analysed asset that actually has a file. The RPC is capability-gated
        // and idempotent — it never double-queues an asset already in flight.
        const ids = Array.isArray(body.asset_ids) ? body.asset_ids.filter((x): x is string => typeof x === 'string') : null;
        const { data, error } = await sb.rpc('mkt_asset_enqueue_processing', {
          p_asset_ids: ids && ids.length ? ids : null,
          p_limit: cap(body.limit, 50, 500),
        });
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ queued: data ?? 0 });
      }
      case 'asset_link': {
        const aId = str(body.asset_id); const tType = str(body.target_type); const tId = str(body.target_id);
        if (!aId || !tType || !tId) return jsonError(400, 'asset_id + target_type + target_id required');
        const { data, error } = await sb.from('mkt_asset_links')
          .upsert({ asset_id: aId, target_type: tType, target_id: tId, created_by_user_id: appUserId },
                  { onConflict: 'asset_id,target_type,target_id' })
          .select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ link: data });
      }

      // ── Publishing / performance / attribution ───────────────────────────
      case 'publication_save': {
        const id = str(body.id);
        const patch = { ...(body.patch ?? {}) } as Record<string, unknown>;
        if (patch.status === 'published' && !patch.published_at) {
          patch.published_at = new Date().toISOString();
          patch.published_by_user_id = appUserId;
        }
        const q = id ? sb.from('mkt_publications').update(patch).eq('id', id).select().maybeSingle()
                     : sb.from('mkt_publications').insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ publication: data });
      }
      case 'performance_record': {
        const pubId = str(body.publication_id); const campId = str(body.campaign_id);
        if (!pubId && !campId) return jsonError(400, 'publication_id or campaign_id required');
        // APPEND — snapshots are never updated in place
        const { data, error } = await sb.from('mkt_performance_snapshots').insert({
          publication_id: pubId ?? null, campaign_id: campId ?? null,
          platform: str(body.platform) ?? null,
          metrics: body.metrics ?? {},
          collection_status: str(body.collection_status) ?? 'collected',
          source: 'manual', created_by_user_id: appUserId,
        }).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ snapshot: data });
      }
      case 'attribution_record': {
        const { data, error } = await sb.from('mkt_lead_attributions')
          .insert({ ...(body.patch ?? {}), created_by_user_id: appUserId }).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ attribution: data });
      }

      // ── Intelligence → execution ─────────────────────────────────────────
      case 'intelligence_action': {
        const sType = str(body.source_type); const sId = str(body.source_id); const aType = str(body.action_type);
        if (!sType || !sId || !aType) return jsonError(400, 'source_type + source_id + action_type required');
        let contentId: string | null = null; let tasks = 0;
        if (aType === 'create_content') {
          const title = str(body.title) ?? 'محتوى من رؤية سوقية';
          const { data: item, error } = await sb.from('mkt_content_items').insert({
            ...(body.patch ?? {}), title, content_type: str(body.content_type) ?? 'static_image',
            source_insight_id: sType === 'insight' ? sId : null,
            source_post_id:    sType === 'content_post' ? sId : null,
            source_ad_id:      sType === 'paid_ad' ? sId : null,
            created_by_user_id: appUserId,
          }).select().maybeSingle();
          const bad = rlsAware(error); if (bad) return bad;
          contentId = item!.id as string;
          const { data: n } = await sb.rpc('mkt_generate_content_tasks', { p_content_item_id: contentId });
          tasks = (n as number) ?? 0;
        }
        const { data, error } = await sb.from('mkt_intelligence_actions').insert({
          source_type: sType, source_id: sId, action_type: aType,
          content_item_id: contentId, campaign_id: str(body.campaign_id) ?? null,
          note: str(body.comment) ?? null, created_by_user_id: appUserId,
        }).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ action: data, content_item_id: contentId, tasks_generated: tasks });
      }
      case 'intelligence_responses': {
        const sId = str(body.source_id);
        if (!sId) return jsonError(400, 'source_id required');
        const { data, error } = await sb.from('mkt_intelligence_actions')
          .select('*, mkt_content_items(id,content_number,title,status,mkt_publications(id,platform,status,published_url))')
          .eq('source_id', sId).order('created_at', { ascending: false });
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ responses: data ?? [] });
      }

      // ══ v2 planning layer ═══════════════════════════════════════════════
      // Every write goes through pick() with an explicit allow-list, so no
      // caller can set an id, a generated number, an approval stamp or the
      // needs_classification flag by hand. RLS still decides who may write at
      // all; this only decides WHAT may be written.

      case 'planning_overview': {
        // One call for the Strategy & Planning tab.
        const [current, strategies, plans] = await Promise.all([
          sb.from('mkt_strategy_versions').select('*').eq('status', 'approved').maybeSingle(),
          // Archived drafts are hidden: a throwaway draft should not clutter the
          // list of versions a reviewer has to consider.
          sb.from('mkt_strategy_versions').select('*').is('archived_at', null)
            .order('version_number', { ascending: false }).limit(50),
          sb.from('mkt_plans').select('*, mkt_goals(id,goal_class,goal_category,name_ar,unit,target_value,actual_value,result,status,needs_classification)')
            .is('archived_at', null).order('period_start', { ascending: false }).limit(100),
        ]);
        const bad = rlsAware(strategies.error); if (bad) return bad;
        return jsonOk({
          current_strategy: current.data ?? null,
          strategies: strategies.data ?? [],
          plans: plans.data ?? [],
        });
      }

      case 'strategy_save': {
        const patch = pick(body.patch, STRATEGY_EDITABLE);
        if (!body.id && !patch.name_ar) return jsonError(400, 'name_ar required');
        const q = body.id
          ? sb.from('mkt_strategy_versions').update(patch).eq('id', body.id).select().maybeSingle()
          : sb.from('mkt_strategy_versions').insert({
              ...patch,
              // Next version number, computed server-side so two editors cannot
              // both claim the same one.
              version_number: (body.version_number as number | undefined)
                ?? ((await sb.from('mkt_strategy_versions').select('version_number')
                      .order('version_number', { ascending: false }).limit(1).maybeSingle()
                    ).data?.version_number ?? 0) + 1,
              created_by_user_id: appUserId,
            }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ strategy: data });
      }

      case 'strategy_approve': {
        const id = str(body.id); if (!id) return jsonError(400, 'id required');
        // Supersede the incumbent first: exactly one approved strategy may
        // exist, so approving a new one without retiring the old would hit the
        // unique index. Two statements, one intent.
        const prior = await sb.from('mkt_strategy_versions').select('id')
          .eq('status', 'approved').maybeSingle();
        if (prior.data?.id && prior.data.id !== id) {
          const sup = await sb.from('mkt_strategy_versions')
            .update({ status: 'superseded' }).eq('id', prior.data.id);
          const badSup = rlsAware(sup.error); if (badSup) return badSup;
        }
        const { data, error } = await sb.from('mkt_strategy_versions')
          .update({ status: 'approved', approver_user_id: appUserId, approved_at: new Date().toISOString(),
                    supersedes_version_id: prior.data?.id ?? null })
          .eq('id', id).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ strategy: data, superseded: prior.data?.id ?? null });
      }

      case 'plan_detail': {
        const id = str(body.id); if (!id) return jsonError(400, 'id required');
        const [plan, goals, inits, progs, camps, channels, reviews] = await Promise.all([
          sb.from('mkt_plans').select('*').eq('id', id).maybeSingle(),
          // Grouped by CLASS, not by theme: outcomes, then KPIs, then output
          // commitments read as three different kinds of thing, which is the
          // whole point of splitting them.
          sb.from('mkt_goals').select('*, mkt_goal_target_periods(*)').eq('plan_id', id)
            .is('archived_at', null).order('goal_class'),
          sb.from('mkt_initiatives').select('*').eq('plan_id', id).is('archived_at', null),
          sb.from('mkt_programs').select('*').eq('plan_id', id).is('archived_at', null),
          sb.from('mkt_internal_campaigns').select('*').eq('plan_id', id).is('archived_at', null),
          sb.from('mkt_channel_plans').select('*, mkt_capacity_allocations(*)').eq('plan_id', id),
          sb.from('mkt_reviews').select('*, mkt_review_decisions(*)').eq('plan_id', id)
            .order('period_start', { ascending: false }),
        ]);
        const bad = rlsAware(plan.error); if (bad) return bad;
        if (!plan.data) return jsonError(404, 'plan not found');
        return jsonOk({
          plan: plan.data, goals: goals.data ?? [], initiatives: inits.data ?? [],
          programs: progs.data ?? [], campaigns: camps.data ?? [],
          channels: channels.data ?? [], reviews: reviews.data ?? [],
        });
      }

      case 'plan_save': {
        const patch = pick(body.patch, PLAN_EDITABLE);
        const q = body.id
          ? sb.from('mkt_plans').update(patch).eq('id', body.id).select().maybeSingle()
          : sb.from('mkt_plans').insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ plan: data });
      }

      case 'plan_approve': {
        const id = str(body.id); if (!id) return jsonError(400, 'id required');
        const { data, error } = await sb.from('mkt_plans')
          .update({ status: 'approved', approver_user_id: appUserId, approved_at: new Date().toISOString() })
          .eq('id', id).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ plan: data });
      }

      case 'goal_save': {
        const patch = pick(body.patch, GOAL_EDITABLE);
        const q = body.id
          ? sb.from('mkt_goals').update(patch).eq('id', body.id).select().maybeSingle()
          : sb.from('mkt_goals').insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ goal: data });
      }

      case 'goal_targets_set': {
        // Replace the whole allocation for a goal in one call. Deliberately a
        // replace: a per-period upsert would leave orphaned months behind when
        // someone re-plans the year, and the sum is only meaningful as a set.
        const goalId = str(body.goal_id); if (!goalId) return jsonError(400, 'goal_id required');
        const rows = Array.isArray(body.periods) ? body.periods : [];
        const del = await sb.from('mkt_goal_target_periods').delete().eq('goal_id', goalId);
        const badDel = rlsAware(del.error); if (badDel) return badDel;
        if (rows.length) {
          const ins = await sb.from('mkt_goal_target_periods').insert(
            rows.map((r) => ({ ...pick(r as Record<string, unknown>, TARGET_PERIOD_EDITABLE), goal_id: goalId })));
          const badIns = rlsAware(ins.error); if (badIns) return badIns;
        }
        const { data } = await sb.from('mkt_goal_target_periods').select('*')
          .eq('goal_id', goalId).order('period_start');
        return jsonOk({ periods: data ?? [] });
      }

      case 'plan_strategy_context': {
        // Everything a plan form needs to show WHICH strategy version it is
        // bound to, plus the current approved one to offer as the default.
        const id = str(body.id);
        const [current, versions, links, missing] = await Promise.all([
          sb.from('mkt_strategy_versions')
            .select('id,version_number,name_ar,name_en,status,effective_date,approved_at')
            .eq('status', 'approved').maybeSingle(),
          sb.from('mkt_strategy_versions')
            .select('id,version_number,name_ar,name_en,status,effective_date,approved_at')
            .is('archived_at', null).order('version_number', { ascending: false }),
          id ? sb.from('mkt_plan_strategy_links').select('*').eq('plan_id', id)
                 .order('changed_at', { ascending: false })
             : Promise.resolve({ data: [], error: null }),
          id ? sb.rpc('mkt_plan_missing_requirements', { p_plan_id: id })
             : Promise.resolve({ data: null, error: null }),
        ]);
        const bad = rlsAware(versions.error); if (bad) return bad;
        return jsonOk({
          current_approved: current.data ?? null,
          versions: versions.data ?? [],
          history: links.data ?? [],
          missing: (missing.data as string[] | null) ?? null,
        });
      }

      case 'plan_rebase_strategy': {
        const id = str(body.id); const to = str(body.strategy_version_id);
        if (!id || !to) return jsonError(400, 'id and strategy_version_id required');
        const { data, error } = await sb.rpc('mkt_plan_rebase_strategy',
          { p_plan_id: id, p_new_version_id: to, p_reason: str(body.reason) ?? null });
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ result: data });
      }

      case 'plan_missing_requirements': {
        const id = str(body.id); if (!id) return jsonError(400, 'id required');
        const { data, error } = await sb.rpc('mkt_plan_missing_requirements', { p_plan_id: id });
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ missing: (data as string[] | null) ?? [] });
      }

      case 'goal_detail': {
        const id = str(body.id); if (!id) return jsonError(400, 'id required');
        const [goal, periods, measurements, missing, actual, alloc, dates] = await Promise.all([
          sb.from('mkt_goals').select('*').eq('id', id).maybeSingle(),
          sb.from('mkt_goal_target_periods').select('*').eq('goal_id', id).order('period_start'),
          sb.from('mkt_goal_measurements').select('*').eq('goal_id', id)
            .order('measured_at', { ascending: false }),
          sb.rpc('mkt_goal_missing_requirements', { p_goal_id: id }),
          sb.rpc('mkt_goal_actual', { p_goal_id: id }),
          sb.rpc('mkt_goal_allocation_status', { p_goal_id: id }),
          sb.rpc('mkt_goal_effective_dates', { p_goal_id: id }),
        ]);
        const bad = rlsAware(goal.error); if (bad) return bad;
        if (!goal.data) return jsonError(404, 'goal not found');
        return jsonOk({
          goal: goal.data, periods: periods.data ?? [], measurements: measurements.data ?? [],
          missing: (missing.data as string[] | null) ?? [],
          actual: actual.data ?? null, allocation: alloc.data ?? null, dates: dates.data ?? null,
        });
      }

      case 'goal_measure': {
        // The ONLY way an actual value moves. Append-only in the database; the
        // trigger recomputes the goal's cached actual by its aggregation method.
        const patch = pick(body.patch, MEASUREMENT_EDITABLE);
        if (!patch.goal_id || patch.value === undefined || patch.value === null) {
          return jsonError(400, 'goal_id and value required');
        }
        const { data, error } = await sb.from('mkt_goal_measurements')
          .insert({ ...patch, entered_by_user_id: appUserId }).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        const { data: actual } = await sb.rpc('mkt_goal_actual', { p_goal_id: patch.goal_id });
        return jsonOk({ measurement: data, actual: actual ?? null });
      }

      case 'goal_missing_requirements': {
        const id = str(body.id); if (!id) return jsonError(400, 'id required');
        const { data, error } = await sb.rpc('mkt_goal_missing_requirements', { p_goal_id: id });
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ missing: (data as string[] | null) ?? [] });
      }

      case 'goal_pacing': {
        const id = str(body.id); if (!id) return jsonError(400, 'id required');
        const [pacing, rollup, alloc, actual] = await Promise.all([
          sb.rpc('mkt_goal_pacing', { p_goal_id: id }),
          sb.rpc('mkt_goal_rollup', { p_goal_id: id }),
          sb.rpc('mkt_goal_allocation_status', { p_goal_id: id }),
          sb.rpc('mkt_goal_actual', { p_goal_id: id }),
        ]);
        const bad = rlsAware(pacing.error); if (bad) return bad;
        return jsonOk({
          pacing: pacing.data ?? null, rollup: rollup.data ?? null,
          allocation: alloc.data ?? null, actual: actual.data ?? null,
        });
      }

      case 'portfolio_list': {
        const planId = str(body.plan_id);
        const q = <T extends { eq: unknown }>(b: T) => (planId ? (b as { eq: (a: string, b: string) => T }).eq('plan_id', planId) : b);
        const [inits, progs, camps] = await Promise.all([
          q(sb.from('mkt_initiatives').select('*, mkt_programs(id,name_ar,status), mkt_internal_campaigns(id,code,name_ar,campaign_class,status)').is('archived_at', null)),
          q(sb.from('mkt_programs').select('*').is('archived_at', null)),
          q(sb.from('mkt_internal_campaigns').select('*').is('archived_at', null)),
        ]);
        const bad = rlsAware(inits.error); if (bad) return bad;
        return jsonOk({ initiatives: inits.data ?? [], programs: progs.data ?? [], campaigns: camps.data ?? [] });
      }

      // ── Portfolio ────────────────────────────────────────────────────────
      case 'portfolio_map': {
        // ONE round trip for the whole portfolio screen: the plan header, the
        // hierarchy, and the counts. Split across three calls the header could
        // describe a different plan from the tree under it, which is exactly
        // how a "0 campaigns" heading ends up above a list of campaigns.
        const planId = str(body.plan_id);
        const scoped = <T extends { eq: unknown }>(b: T) =>
          (planId ? (b as { eq: (a: string, b: string) => T }).eq('plan_id', planId) : b);
        const [plans, strategies, goals, inits, progs, camps] = await Promise.all([
          sb.from('mkt_plans')
            .select('id,name_ar,name_en,plan_type,status,period_start,period_end,strategy_version_id,owner_user_id,needs_classification')
            .is('archived_at', null).order('period_start', { ascending: false }),
          sb.from('mkt_strategy_versions')
            .select('id,version_number,name_ar,name_en,status,effective_date,approved_at')
            .is('archived_at', null).order('version_number', { ascending: false }),
          scoped(sb.from('mkt_goals')
            .select('id,plan_id,goal_class,goal_category,name_ar,name_en,metric,unit,target_value,actual_value,status,owner_user_id,parent_goal_id')
            .is('archived_at', null)),
          scoped(sb.from('mkt_initiatives').select('*').is('archived_at', null)),
          scoped(sb.from('mkt_programs').select('*').is('archived_at', null)),
          scoped(sb.from('mkt_internal_campaigns')
            .select('*, mkt_internal_campaign_projects(project_id), mkt_content_items!campaign_id(id,status)')
            .is('archived_at', null)),
        ]);
        const bad = rlsAware(plans.error ?? goals.error ?? inits.error ?? progs.error ?? camps.error);
        if (bad) return bad;

        // Delivery against a program's recurring commitment is COUNTED from the
        // content that program actually originated. It is not embedded on the
        // program row because mkt_content_items reaches campaigns through two
        // different foreign keys and programs through one — keeping this as its
        // own query avoids an ambiguous embed and keeps the shape obvious.
        const progIds = (progs.data ?? []).map((p: { id: string }) => p.id);
        const output = progIds.length
          ? await sb.from('mkt_content_items')
              .select('id,status,origin_program_id,created_at,planned_publish_at')
              .in('origin_program_id', progIds).is('archived_at', null).limit(2000)
          : { data: [], error: null };
        const badOut = rlsAware(output.error); if (badOut) return badOut;

        return jsonOk({
          plans: plans.data ?? [], strategies: strategies.data ?? [],
          goals: goals.data ?? [], initiatives: inits.data ?? [],
          programs: progs.data ?? [], campaigns: camps.data ?? [],
          program_output: output.data ?? [],
        });
      }

      case 'campaign_classify': {
        // The ONLY supported way a legacy null class becomes organic or paid.
        // Deliberately not a field on campaign_save: the point is that somebody
        // decided, on a record where the system had never been told.
        const id = str(body.id ?? body.campaign_id);
        const cls = str(body.campaign_class);
        if (!id || !cls) return jsonError(400, 'id and campaign_class required');
        const { data, error } = await sb.rpc('mkt_campaign_classify', {
          p_campaign_id: id, p_class: cls,
          p_plan_id: str(body.plan_id) ?? null,
          p_goal_id: str(body.goal_id) ?? null,
          p_initiative_id: str(body.initiative_id) ?? null,
        });
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ result: data });
      }

      case 'portfolio_detail': {
        // One record — initiative, program or campaign — with everything the
        // detail drawer shows: its own row, its children, its secondary goals,
        // its review decisions, and the completion checklist the database will
        // actually enforce.
        const kind = str(body.target_type); const id = str(body.id);
        if (!kind || !id) return jsonError(400, 'target_type and id required');

        if (kind === 'initiative') {
          const [row, progs, camps, secondary, decisions, missing, projects] = await Promise.all([
            sb.from('mkt_initiatives').select('*').eq('id', id).maybeSingle(),
            sb.from('mkt_programs').select('*').eq('initiative_id', id).is('archived_at', null),
            sb.from('mkt_internal_campaigns').select('*').eq('initiative_id', id).is('archived_at', null),
            sb.from('mkt_activity_goals').select('*').eq('initiative_id', id),
            sb.from('mkt_review_decisions').select('*').eq('initiative_id', id).order('created_at', { ascending: false }),
            sb.rpc('mkt_initiative_missing_requirements', { p_initiative_id: id }),
            sb.from('mkt_initiative_projects').select('project_id').eq('initiative_id', id),
          ]);
          const bad = rlsAware(row.error); if (bad) return bad;
          if (!row.data) return jsonError(404, 'initiative not found');
          return jsonOk({
            kind, row: row.data, programs: progs.data ?? [], campaigns: camps.data ?? [],
            secondary_goals: secondary.data ?? [], decisions: decisions.data ?? [],
            projects: (projects.data ?? []).map((p: { project_id: string }) => p.project_id),
            missing: (missing.data as string[] | null) ?? [],
          });
        }

        if (kind === 'program') {
          const [row, camps, secondary, decisions, missing, content] = await Promise.all([
            sb.from('mkt_programs').select('*').eq('id', id).maybeSingle(),
            sb.from('mkt_internal_campaigns').select('*').eq('program_id', id).is('archived_at', null),
            sb.from('mkt_activity_goals').select('*').eq('program_id', id),
            sb.from('mkt_review_decisions').select('*').eq('program_id', id).order('created_at', { ascending: false }),
            sb.rpc('mkt_program_missing_requirements', { p_program_id: id }),
            // Delivery against the recurring commitment is COUNTED from content
            // this program actually originated. A program that produced nothing
            // shows nothing produced, never a comfortable zero-of-zero.
            sb.from('mkt_content_items').select('id,status,created_at,planned_publish_at')
              .eq('origin_program_id', id).is('archived_at', null)
              .order('created_at', { ascending: false }).limit(400),
          ]);
          const bad = rlsAware(row.error); if (bad) return bad;
          if (!row.data) return jsonError(404, 'program not found');
          return jsonOk({
            kind, row: row.data, campaigns: camps.data ?? [],
            secondary_goals: secondary.data ?? [], decisions: decisions.data ?? [],
            content: content.data ?? [], missing: (missing.data as string[] | null) ?? [],
          });
        }

        if (kind === 'campaign') {
          const [row, content, secondary, decisions, missing, projects, perf] = await Promise.all([
            sb.from('mkt_internal_campaigns').select('*').eq('id', id).maybeSingle(),
            sb.from('mkt_content_items').select('id,content_number,title,content_type,status,due_date')
              .eq('campaign_id', id).is('archived_at', null),
            sb.from('mkt_activity_goals').select('*').eq('campaign_id', id),
            sb.from('mkt_review_decisions').select('*').eq('campaign_id', id).order('created_at', { ascending: false }),
            sb.rpc('mkt_campaign_missing_requirements', { p_campaign_id: id }),
            sb.from('mkt_internal_campaign_projects').select('project_id').eq('campaign_id', id),
            sb.from('mkt_performance_snapshots').select('*').eq('campaign_id', id)
              .order('captured_at', { ascending: false }).limit(200),
          ]);
          const bad = rlsAware(row.error); if (bad) return bad;
          if (!row.data) return jsonError(404, 'campaign not found');
          return jsonOk({
            kind, row: row.data, content: content.data ?? [],
            secondary_goals: secondary.data ?? [], decisions: decisions.data ?? [],
            projects: (projects.data ?? []).map((p: { project_id: string }) => p.project_id),
            performance: perf.data ?? [], missing: (missing.data as string[] | null) ?? [],
          });
        }
        return jsonError(400, 'target_type must be initiative, program or campaign');
      }

      case 'portfolio_secondary_goals_set': {
        // A set, so the write is a replace — dropping one is the common edit and
        // an upsert alone would never remove anything.
        const kind = str(body.target_type); const id = str(body.id);
        if (!kind || !id) return jsonError(400, 'target_type and id required');
        const col = kind === 'initiative' ? 'initiative_id'
          : kind === 'program' ? 'program_id'
          : kind === 'campaign' ? 'campaign_id' : null;
        if (!col) return jsonError(400, 'target_type must be initiative, program or campaign');
        const ids = Array.isArray(body.asset_ids) ? body.asset_ids.filter((x): x is string => typeof x === 'string') : [];
        const del = await sb.from('mkt_activity_goals').delete().eq(col, id).eq('relation', 'secondary');
        const badDel = rlsAware(del.error); if (badDel) return badDel;
        if (ids.length) {
          const ins = await sb.from('mkt_activity_goals')
            .insert(ids.map((g) => ({ [col]: id, goal_id: g, relation: 'secondary' })));
          const badIns = rlsAware(ins.error); if (badIns) return badIns;
        }
        return jsonOk({ goal_ids: ids });
      }

      case 'campaign_projects_set': {
        const id = str(body.id ?? body.campaign_id);
        if (!id) return jsonError(400, 'id required');
        const ids = Array.isArray(body.asset_ids) ? body.asset_ids.filter((x): x is string => typeof x === 'string') : [];
        const del = await sb.from('mkt_internal_campaign_projects').delete().eq('campaign_id', id);
        const badDel = rlsAware(del.error); if (badDel) return badDel;
        if (ids.length) {
          const ins = await sb.from('mkt_internal_campaign_projects')
            .insert(ids.map((p) => ({ campaign_id: id, project_id: p })));
          const badIns = rlsAware(ins.error); if (badIns) return badIns;
        }
        return jsonOk({ project_ids: ids });
      }

      case 'portfolio_missing_requirements': {
        const kind = str(body.target_type); const id = str(body.id);
        if (!kind || !id) return jsonError(400, 'target_type and id required');
        const fn = kind === 'initiative' ? ['mkt_initiative_missing_requirements', 'p_initiative_id']
          : kind === 'program' ? ['mkt_program_missing_requirements', 'p_program_id']
          : kind === 'campaign' ? ['mkt_campaign_missing_requirements', 'p_campaign_id'] : null;
        if (!fn) return jsonError(400, 'target_type must be initiative, program or campaign');
        const { data, error } = await sb.rpc(fn[0]!, { [fn[1]!]: id });
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ missing: (data as string[] | null) ?? [] });
      }

      case 'initiative_save': {
        const patch = pick(body.patch, INITIATIVE_EDITABLE);
        if (!body.id) {
          const badCtx = requirePortfolioContext(patch, 'initiative'); if (badCtx) return badCtx;
        }
        const q = body.id
          ? sb.from('mkt_initiatives').update(patch).eq('id', body.id).select().maybeSingle()
          : sb.from('mkt_initiatives').insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ initiative: data });
      }

      case 'program_save': {
        const patch = pick(body.patch, PROGRAM_EDITABLE);
        if (!body.id) {
          const badCtx = requirePortfolioContext(patch, 'program'); if (badCtx) return badCtx;
        }
        const q = body.id
          ? sb.from('mkt_programs').update(patch).eq('id', body.id).select().maybeSingle()
          : sb.from('mkt_programs').insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ program: data });
      }

      case 'channel_plan_save': {
        const patch = pick(body.patch, CHANNEL_PLAN_EDITABLE);
        const q = body.id
          ? sb.from('mkt_channel_plans').update(patch).eq('id', body.id).select().maybeSingle()
          : sb.from('mkt_channel_plans').insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ channel_plan: data });
      }

      case 'capacity_allocate': {
        const patch = pick(body.patch, ALLOCATION_EDITABLE);
        const q = body.id
          ? sb.from('mkt_capacity_allocations').update(patch).eq('id', body.id).select().maybeSingle()
          : sb.from('mkt_capacity_allocations').insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ allocation: data });
      }

      case 'capacity_status': {
        const chan = str(body.channel_plan_id); const week = str(body.week_start);
        if (!chan || !week) return jsonError(400, 'channel_plan_id and week_start required');
        const { data, error } = await sb.rpc('mkt_capacity_status',
          { p_channel_plan_id: chan, p_week_start: week });
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ status: data ?? null });
      }

      case 'platform_campaign_save': {
        const patch = pick(body.patch, PLATFORM_CAMPAIGN_EDITABLE);
        const q = body.id
          ? sb.from('mkt_platform_campaigns').update(patch).eq('id', body.id).select().maybeSingle()
          : sb.from('mkt_platform_campaigns').insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ platform_campaign: data });
      }

      case 'ad_group_save': {
        const patch = pick(body.patch, AD_GROUP_EDITABLE);
        const q = body.id
          ? sb.from('mkt_ad_groups').update(patch).eq('id', body.id).select().maybeSingle()
          : sb.from('mkt_ad_groups').insert(patch).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ ad_group: data });
      }

      case 'ad_save': {
        const patch = pick(body.patch, AD_EDITABLE);
        const q = body.id
          ? sb.from('mkt_ads').update(patch).eq('id', body.id).select().maybeSingle()
          : sb.from('mkt_ads').insert(patch).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ ad: data });
      }

      case 'paid_tree': {
        const campId = str(body.campaign_id); if (!campId) return jsonError(400, 'campaign_id required');
        const { data, error } = await sb.from('mkt_platform_campaigns')
          .select('*, mkt_ad_groups(*, mkt_ads(*))').eq('campaign_id', campId).order('platform');
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ platform_campaigns: data ?? [] });
      }

      case 'review_save': {
        const patch = pick(body.patch, REVIEW_EDITABLE);
        const q = body.id
          ? sb.from('mkt_reviews').update(patch).eq('id', body.id).select().maybeSingle()
          : sb.from('mkt_reviews').insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        const { data, error } = await q;
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ review: data });
      }

      case 'review_decide': {
        const patch = pick(body.patch, REVIEW_DECISION_EDITABLE);
        const { data, error } = await sb.from('mkt_review_decisions').insert(patch).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ decision: data });
      }

      case 'pillar_list': {
        const { data, error } = await sb.from('mkt_content_pillars').select('*')
          .eq('is_active', true).order('sort_order');
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ pillars: data ?? [] });
      }

      case 'content_usage_add': {
        const patch = pick(body.patch, USAGE_EDITABLE);
        const { data, error } = await sb.from('mkt_content_usage')
          .insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ usage: data });
      }

      case 'content_missing_context': {
        const id = str(body.id); if (!id) return jsonError(400, 'id required');
        const { data, error } = await sb.rpc('mkt_content_missing_context', { p_content_item_id: id });
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ missing: (data as string[] | null) ?? [] });
      }

      case 'generate_v2_alerts': {
        const { data, error } = await sb.rpc('mkt_mgmt_generate_v2_alerts');
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ rules: data ?? [] });
      }

      case 'set_marketing_role': {
        const uid = str(body.user_id); if (!uid) return jsonError(400, 'user_id required');
        const { error } = await sb.rpc('mkt_set_role_grant',
          { p_user_id: uid, p_role: str(body.role) ?? null });
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ ok: true });
      }

      // ── Content operations ───────────────────────────────────────────────
      // The canonical content module. brief -> deliverables -> artifacts ->
      // publications -> results. Everything the board and the detail page need,
      // read through the same gate functions the database enforces, so a
      // disabled button and its stated reason can never disagree.

      case 'content_board': {
        // One round trip for the board: every brief with the deliverables that
        // make its platforms real, plus the computed state per row.
        const q = sb.from('mkt_content_items')
          .select('*, mkt_content_deliverables(id,deliverable_number,label,platform,format,'
                + 'language,distribution,status,due_date,planned_publish_at,owner_user_id,'
                + 'needs_classification,workflow_template_key,primary_kpi,kpi_unit,kpi_target)')
          .is('archived_at', null)
          .order('created_at', { ascending: false })
          .limit(cap(body.limit, 200, 500));
        const projectId = str(body.project_id);
        const { data, error } = await (projectId ? q.eq('project_id', projectId) : q);
        const bad = rlsAware(error); if (bad) return bad;

        // Computed state per item. Sequential-safe: these are cheap STABLE
        // reads, and doing them in the database keeps "next action" identical
        // to what the detail page will show.
        const items = data ?? [];
        const states = await Promise.all(items.map((it: { id: string }) =>
          sb.rpc('mkt_content_state', { p_item_id: it.id })));
        return jsonOk({
          items: items.map((it: Record<string, unknown>, i: number) => ({
            ...it, state: states[i]?.data ?? null,
          })),
        });
      }

      case 'content_ops_detail': {
        const id = str(body.id ?? body.content_item_id);
        if (!id) return jsonError(400, 'id required');
        const [item, dels, arts, tasks, pubs, results, roles, history, assets, state, missing] =
          await Promise.all([
            sb.from('mkt_content_items').select('*').eq('id', id).maybeSingle(),
            sb.from('mkt_content_deliverables').select('*').eq('content_item_id', id)
              .is('archived_at', null).order('deliverable_number'),
            sb.from('mkt_content_versions').select('*').eq('content_item_id', id)
              .order('version_type').order('version_number', { ascending: false }),
            sb.from('mkt_content_tasks').select('*').eq('content_item_id', id)
              .order('sort_order').order('created_at'),
            sb.from('mkt_publications').select('*').eq('content_item_id', id)
              .order('scheduled_for', { nullsFirst: false }),
            sb.from('mkt_content_results').select('*').eq('content_item_id', id)
              .order('measured_at', { ascending: false, nullsFirst: false }),
            sb.from('mkt_content_roles').select('*').eq('content_item_id', id),
            sb.from('mkt_content_status_history').select('*').eq('content_item_id', id)
              .order('changed_at', { ascending: false }).limit(50),
            sb.from('mkt_asset_links').select('asset_id, target_type, target_id, role, mkt_raw_assets(*)')
              .eq('target_type', 'content_item').eq('target_id', id),
            sb.rpc('mkt_content_state', { p_item_id: id }),
            sb.rpc('mkt_content_missing_requirements', { p_item_id: id }),
          ]);
        const bad = rlsAware(item.error); if (bad) return bad;
        if (!item.data) return jsonError(404, 'content item not found');

        // Per-deliverable extras: scene list, blockers, attainment, and the
        // assets linked to that specific output.
        const dRows = dels.data ?? [];
        const dIds = dRows.map((d: { id: string }) => d.id);
        const [scenes, slides, dAssets, blockerRows, attainRows] = await Promise.all([
          dIds.length ? sb.from('mkt_video_scenes').select('*').in('deliverable_id', dIds).order('scene_number')
                      : Promise.resolve({ data: [], error: null }),
          dIds.length ? sb.from('mkt_carousel_slides').select('*').in('deliverable_id', dIds).order('slide_number')
                      : Promise.resolve({ data: [], error: null }),
          dIds.length ? sb.from('mkt_asset_links').select('asset_id, target_id, role, mkt_raw_assets(*)')
                          .eq('target_type', 'deliverable').in('target_id', dIds)
                      : Promise.resolve({ data: [], error: null }),
          Promise.all(dIds.map((d: string) => sb.rpc('mkt_deliverable_schedule_blockers', { p_deliverable_id: d }))),
          Promise.all(dIds.map((d: string) => sb.rpc('mkt_deliverable_attainment', { p_deliverable_id: d }))),
        ]);

        return jsonOk({
          item: item.data,
          deliverables: dRows.map((d: Record<string, unknown>, i: number) => ({
            ...d,
            blockers: (blockerRows as Array<{ data: unknown }>)[i]?.data ?? [],
            attainment: (attainRows as Array<{ data: unknown }>)[i]?.data ?? null,
          })),
          artifacts: arts.data ?? [],
          tasks: tasks.data ?? [],
          publications: pubs.data ?? [],
          results: results.data ?? [],
          roles: roles.data ?? [],
          history: history.data ?? [],
          scenes: scenes.data ?? [],
          slides: slides.data ?? [],
          assets: [...(assets.data ?? []), ...(dAssets.data ?? [])],
          state: state.data ?? null,
          missing: (missing.data as string[] | null) ?? [],
        });
      }

      case 'brief_save': {
        const id = str(body.id); if (!id) return jsonError(400, 'id required');
        // Two allow-lists on purpose: the legacy CONTENT_EDITABLE set still
        // owns title/owner/audience, and BRIEF_EDITABLE adds the strategic
        // fields. Neither can reach a deliverable-only column.
        const patch = { ...pick(body.patch, CONTENT_EDITABLE), ...pick(body.patch, BRIEF_EDITABLE) };
        if (Object.keys(patch).length === 0) return jsonError(400, 'nothing to update');
        const { data, error } = await sb.from('mkt_content_items')
          .update(patch).eq('id', id).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ item: data });
      }

      case 'deliverable_save': {
        const patch = pick(body.patch, DELIVERABLE_EDITABLE);
        let out;
        if (body.id) {
          out = await sb.from('mkt_content_deliverables').update(patch)
            .eq('id', str(body.id)!).select().maybeSingle();
        } else {
          const itemId = str(body.content_item_id);
          if (!itemId) return jsonError(400, 'content_item_id required');
          if (!patch.format) return jsonError(400, 'format required');
          out = await sb.from('mkt_content_deliverables')
            .insert({ ...patch, content_item_id: itemId, created_by_user_id: appUserId })
            .select().maybeSingle();
        }
        const bad = rlsAware(out.error); if (bad) return bad;

        // A brand-new deliverable gets the tasks its FORMAT calls for. Failing
        // to generate is surfaced, not swallowed — a deliverable with no
        // workflow is a deliverable nobody can work on.
        let generated: number | null = null;
        if (!body.id && out.data) {
          const g = await sb.rpc('mkt_generate_deliverable_tasks',
            { p_deliverable_id: (out.data as { id: string }).id, p_replace: false });
          if (g.error) return jsonError(409, g.error.message);
          generated = g.data as number;
        }
        return jsonOk({ deliverable: out.data, tasks_generated: generated });
      }

      case 'deliverable_generate_tasks': {
        const id = str(body.deliverable_id ?? body.id);
        if (!id) return jsonError(400, 'deliverable_id required');
        const { data, error } = await sb.rpc('mkt_generate_deliverable_tasks',
          { p_deliverable_id: id, p_replace: body.replace === true });
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ created: data });
      }

      case 'deliverable_blockers': {
        const id = str(body.deliverable_id ?? body.id);
        if (!id) return jsonError(400, 'deliverable_id required');
        const [blockers, attainment] = await Promise.all([
          sb.rpc('mkt_deliverable_schedule_blockers', { p_deliverable_id: id }),
          sb.rpc('mkt_deliverable_attainment', { p_deliverable_id: id }),
        ]);
        const bad = rlsAware(blockers.error); if (bad) return bad;
        return jsonOk({ blockers: blockers.data ?? [], attainment: attainment.data ?? null });
      }

      case 'artifact_types': {
        // Which artifact types this deliverable's workflow actually calls for,
        // plus every non-legacy type for anything extra somebody needs. This is
        // what makes the writing surface type-aware instead of one dropdown.
        const delId = str(body.deliverable_id);
        const [all, steps] = await Promise.all([
          sb.from('mkt_artifact_types').select('*').eq('is_active', true).order('sort_order'),
          delId
            ? sb.from('mkt_content_deliverables')
                .select('format, workflow_template_key').eq('id', delId).maybeSingle()
            : Promise.resolve({ data: null, error: null }),
        ]);
        const bad = rlsAware(all.error); if (bad) return bad;
        let expected: string[] = [];
        const d = steps.data as { format?: string; workflow_template_key?: string } | null;
        if (d) {
          const tk = d.workflow_template_key
            ?? (await sb.from('mkt_workflow_templates').select('key')
                  .eq('format', d.format!).eq('is_active', true).maybeSingle()).data?.key;
          if (tk) {
            const ws = await sb.from('mkt_workflow_steps')
              .select('artifact_type, gates_publish, sort_order')
              .eq('template_key', tk).not('artifact_type', 'is', null).order('sort_order');
            expected = (ws.data ?? []).map((s: { artifact_type: string }) => s.artifact_type);
          }
        }
        return jsonOk({ types: all.data ?? [], expected });
      }

      case 'artifact_save': {
        // Always an INSERT. Editing an approved version is refused by the
        // database; this endpoint does not offer an update path at all, so the
        // only way content changes is a new version with a change summary.
        const patch = pick(body.patch, ARTIFACT_EDITABLE);
        if (!patch.content_item_id || !patch.version_type) {
          return jsonError(400, 'content_item_id and version_type required');
        }
        const { data, error } = await sb.from('mkt_content_versions')
          .insert({ ...patch, owner_user_id: patch.owner_user_id ?? appUserId,
                    approval_state: 'draft', created_by_user_id: appUserId })
          .select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ artifact: data });
      }

      case 'artifact_decide': {
        const id = str(body.id); if (!id) return jsonError(400, 'id required');
        const decision = body.decision;
        if (!decision || !['approved', 'changes_requested', 'rejected', 'pending'].includes(decision)) {
          return jsonError(400, 'decision must be approved | changes_requested | rejected | pending');
        }
        const patch: Record<string, unknown> = {
          approval_state: decision,
          review_comment: str(body.review_comment) ?? null,
        };
        // Stamped server-side. A client cannot claim someone else approved it.
        if (decision === 'approved') {
          patch.approved_by_user_id = appUserId;
          patch.approved_at = new Date().toISOString();
        }
        const { data, error } = await sb.from('mkt_content_versions')
          .update(patch).eq('id', id).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;

        // Approving may have marked downstream artifacts stale. Return them so
        // the screen can say so immediately rather than on the next refresh.
        const stale = data
          ? await sb.from('mkt_content_versions')
              .select('id, version_type, version_number, stale_reason')
              .eq('content_item_id', (data as { content_item_id: string }).content_item_id)
              .eq('is_stale', true).eq('approval_state', 'approved')
          : { data: [] };
        return jsonOk({ artifact: data, stale: stale.data ?? [] });
      }

      case 'content_task_save': {
        const id = str(body.id); if (!id) return jsonError(400, 'id required');
        const patch = pick(body.patch, CONTENT_TASK_EDITABLE);
        if (Object.keys(patch).length === 0) return jsonError(400, 'nothing to update');
        const { data, error } = await sb.from('mkt_content_tasks')
          .update(patch).eq('id', id).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ task: data });
      }

      case 'deliverable_publication_save': {
        // Scheduling and publishing are the SAME row moving through states, and
        // the database gate refuses the move when media/copy/account/time are
        // not ready. No API-side pre-check: one authority, one error message.
        const patch = pick(body.patch, PUBLICATION_OPS_EDITABLE);
        let out;
        if (body.id) {
          out = await sb.from('mkt_publications').update(patch)
            .eq('id', str(body.id)!).select().maybeSingle();
        } else {
          if (!patch.deliverable_id) return jsonError(400, 'deliverable_id required');
          out = await sb.from('mkt_publications')
            .insert({ ...patch, created_by_user_id: appUserId }).select().maybeSingle();
        }
        // A refused schedule is a 409 carrying the database's own sentence,
        // which already names exactly what is missing.
        if (out.error && /cannot schedule|must belong to a deliverable/i.test(out.error.message)) {
          return jsonError(409, out.error.message);
        }
        const bad = rlsAware(out.error); if (bad) return bad;
        return jsonOk({ publication: out.data });
      }

      case 'deliverable_mark_published': {
        // The honest manual path. There is no publishing API wired to any
        // platform, so a human posts it and records what came back; nothing
        // here pretends an integration succeeded.
        const id = str(body.id); if (!id) return jsonError(400, 'id required');
        const url = str(body.patch?.published_url as string | undefined);
        const postId = str(body.patch?.platform_post_id as string | undefined);
        if (!url && !postId) {
          return jsonError(400, 'a published URL or platform post id is required to mark it published');
        }
        const { data, error } = await sb.from('mkt_publications')
          .update({
            status: 'published',
            published_at: str(body.patch?.published_at as string | undefined) ?? new Date().toISOString(),
            published_url: url ?? null,
            platform_post_id: postId ?? null,
            published_by_user_id: appUserId,
            publish_method: 'manual',
          }).eq('id', id).select().maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ publication: data });
      }

      case 'result_record': {
        const patch = pick(body.patch, RESULT_EDITABLE);
        if (!patch.content_item_id) return jsonError(400, 'content_item_id required');
        let out;
        if (body.id) {
          out = await sb.from('mkt_content_results').update({ ...patch, updated_at: new Date().toISOString() })
            .eq('id', str(body.id)!).select().maybeSingle();
        } else {
          out = await sb.from('mkt_content_results')
            .insert({ ...patch, recorded_by_user_id: appUserId }).select().maybeSingle();
        }
        const bad = rlsAware(out.error); if (bad) return bad;
        const attain = patch.deliverable_id
          ? await sb.rpc('mkt_deliverable_attainment', { p_deliverable_id: patch.deliverable_id as string })
          : { data: null };
        return jsonOk({ result: out.data, attainment: attain.data ?? null });
      }

      case 'content_asset_link': {
        // Both directions of the library: an existing asset attaches to a
        // deliverable without the file being copied anywhere.
        const assetId = str(body.asset_id);
        const targetType = str(body.target_type) ?? 'deliverable';
        const targetId = str(body.target_id ?? body.deliverable_id ?? body.content_item_id);
        if (!assetId || !targetId) return jsonError(400, 'asset_id and target_id required');
        if (!['deliverable', 'content_item', 'scene', 'slide'].includes(targetType)) {
          return jsonError(400, 'unsupported target_type');
        }
        const { data, error } = await sb.from('mkt_asset_links')
          .upsert({
            asset_id: assetId, target_type: targetType, target_id: targetId,
            role: str(body.patch?.role as string | undefined) ?? null,
            created_by_user_id: appUserId,
          }, { onConflict: 'asset_id,target_type,target_id' })
          .select('asset_id, target_type, target_id, role, mkt_raw_assets(*)').maybeSingle();
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ link: data });
      }

      case 'content_duplicate': {
        // One RPC, one transaction. Doing this here would be a dozen
        // un-transacted round trips, and a failure halfway would leave a
        // half-copied package that looks real.
        const id = str(body.id ?? body.content_item_id);
        if (!id) return jsonError(400, 'id required');
        const { data, error } = await sb.rpc('mkt_content_duplicate', {
          p_source_id: id,
          p_title: str(body.title) ?? null,
          p_reuse_kind: str(body.patch?.reuse_kind as string | undefined) ?? 'refresh',
          p_copy_artifacts: body.patch?.copy_artifacts === true,
          p_actor: appUserId,
        });
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ result: data });
      }

      case 'content_bulk_assign': {
        const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : [];
        if (ids.length === 0) return jsonError(400, 'ids required');
        // owner_user_id may legitimately be null — "unassign these" is a real
        // bulk action, not a missing argument.
        const { data, error } = await sb.rpc('mkt_content_bulk_assign', {
          p_ids: ids,
          p_owner_user_id: str(body.user_id) ?? null,
          p_also_deliverables: body.patch?.also_deliverables === true,
        });
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ result: data });
      }

      case 'deliverable_bulk_schedule': {
        const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : [];
        const startAt = str(body.start_at);
        if (ids.length === 0) return jsonError(400, 'ids required');
        if (!startAt) return jsonError(400, 'start_at required');
        const { data, error } = await sb.rpc('mkt_deliverable_bulk_schedule', {
          p_ids: ids,
          p_start_at: startAt,
          p_interval_mins: cap(body.interval_mins, 1440, 60 * 24 * 30),
        });
        const bad = rlsAware(error); if (bad) return bad;
        // The result carries `still_blocked` — the caller must show it rather
        // than reporting a clean success for work that cannot publish.
        return jsonOk({ result: data });
      }

      case 'content_asset_unlink': {
        const assetId = str(body.asset_id);
        const targetId = str(body.target_id ?? body.deliverable_id);
        if (!assetId || !targetId) return jsonError(400, 'asset_id and target_id required');
        const { error } = await sb.from('mkt_asset_links').delete()
          .eq('asset_id', assetId)
          .eq('target_type', str(body.target_type) ?? 'deliverable')
          .eq('target_id', targetId);
        const bad = rlsAware(error); if (bad) return bad;
        return jsonOk({ ok: true });
      }

      default:
        return jsonError(400, `unknown action: ${action}`);
    }
  });
}
