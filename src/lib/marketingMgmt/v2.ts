/**
 * Marketing Management v2 — the planning layer.
 *
 *   Strategy version → Plan → Goals (+ target periods) → Portfolio → Reviews
 *
 * A separate module from client.ts because it is a distinct layer with its own
 * vocabulary, but it shares the same `call` transport so there is one auth
 * header and one error-mapping path, not two.
 *
 * Every save takes a patch. The API allow-lists the fields it will accept, so an
 * id, a generated number or an approval stamp sent in a patch is ignored rather
 * than honoured — the client cannot grant itself something the server refuses.
 *
 * Design record: docs/marketing-management-v2.md
 */
import { call, type Campaign } from './client';

export interface StrategyVersion {
  id: string; version_number: number; name_ar: string; name_en: string | null;
  summary_ar: string | null; summary_en: string | null; status: string;
  effective_date: string | null; expires_at: string | null;
  supersedes_version_id: string | null;
  positioning: string | null; organic_paid_strategy: string | null;
  priority_audiences: unknown[]; customer_problems: unknown[]; value_propositions: unknown[];
  priority_markets: unknown[]; property_categories: unknown[]; funnel: unknown[];
  channel_roles: unknown[]; content_principles: unknown[]; measurement_principles: unknown[];
  strategic_priorities: unknown[]; not_priorities: unknown[];
  assumptions: unknown[]; risks: unknown[];
  owner_user_id: string | null; approver_user_id: string | null; approved_at: string | null;
  is_migration_holder: boolean; created_at: string;
}

export interface MktPlan {
  id: string; plan_type: 'annual' | 'quarterly' | 'monthly' | 'project' | 'custom';
  parent_plan_id: string | null; strategy_version_id: string | null;
  name_ar: string; name_en: string | null; summary_ar: string | null; status: string;
  period_start: string; period_end: string; budget: number | null;
  channel_budgets: Record<string, unknown>; review_frequency: string | null;
  owner_user_id: string | null; approved_at: string | null;
  needs_classification: boolean; is_migration_holder: boolean;
  mkt_goals?: MktGoal[];
}

export interface MktGoal {
  id: string; plan_id: string; parent_goal_id: string | null;
  /** The mandatory three-way split. An output commitment is never an outcome. */
  goal_category: 'outcome' | 'kpi' | 'output';
  name_ar: string; name_en: string | null; description: string | null;
  metric: string | null; unit: string | null;
  baseline_value: number | null; target_value: number | null;
  start_date: string | null; end_date: string | null; owner_user_id: string | null;
  measurement_frequency: string | null; source_of_truth: string | null; scope: string | null;
  status: string; actual_value: number | null; forecast_value: number | null;
  result: 'on_track' | 'at_risk' | 'off_track' | null; notes: string | null;
  mkt_goal_target_periods?: GoalTargetPeriod[];
}

export interface GoalTargetPeriod {
  id: string; goal_id: string; label: string | null;
  period_start: string; period_end: string;
  target_value: number; actual_value: number | null; forecast_value: number | null;
}

export interface Initiative {
  id: string; plan_id: string | null; primary_goal_id: string | null;
  name_ar: string; name_en: string | null;
  problem_or_opportunity: string | null; hypothesis: string | null; scope: string | null;
  start_date: string | null; review_date: string | null; end_date: string | null;
  budget: number | null; owner_user_id: string | null; status: string;
  expected_contribution: string | null; actual_contribution: string | null;
  decision: string | null; decision_note: string | null; needs_classification: boolean;
  mkt_programs?: Array<{ id: string; name_ar: string; status: string }>;
  mkt_internal_campaigns?: Array<{
    id: string; code: string; name_ar: string; campaign_class: string | null; status: string;
  }>;
}

export interface Program {
  id: string; plan_id: string | null; initiative_id: string | null;
  primary_goal_id: string | null; name_ar: string; name_en: string | null;
  purpose: string | null; target_audience: string | null;
  /** No end date by design — a program must never be a permanent campaign. */
  cadence: string | null; commitment_count: number | null; commitment_unit: string | null;
  platforms: unknown[]; owner_user_id: string | null; review_frequency: string | null;
  status: string; start_date: string | null; decision: string | null;
}

export interface ChannelPlan {
  id: string; plan_id: string; platform: string; account_handle: string | null;
  max_per_day: number | null; max_per_week: number | null;
  format_mix: Record<string, unknown>; pillar_mix: Record<string, unknown>;
  reactive_reserve: number; same_project_max_per_week: number | null;
  mkt_capacity_allocations?: CapacityAllocation[];
}

export interface CapacityAllocation {
  id: string; channel_plan_id: string; week_start: string;
  allocation_kind: 'program_reservation' | 'campaign_allocation' | 'reactive_reserve';
  program_id: string | null; campaign_id: string | null;
  slots_requested: number; slots_granted: number | null; note: string | null;
}

/** What mkt_capacity_status returns. Nulls mean "not configured" — the rule that
 *  missing data is never zero applies to capacity too. */
export interface CapacityStatus {
  channel_plan_id: string; platform: string; account_handle: string | null;
  week_start: string; capacity_configured: boolean;
  week_capacity: number | null; program_reserved: number; reactive_reserved: number;
  campaign_available: number | null; campaign_requested: number;
  over_allocated_by: number | null; is_over_allocated: boolean | null;
  campaign_requests: Array<{
    /** Added to the RPC on 2026-08-24. The UI needs it to grant a different
     *  amount without re-deriving the row from its own copy of the allocations —
     *  which is how the conflict banner and the editable list could end up
     *  describing different weeks. Optional so an older database still types. */
    allocation_id?: string;
    campaign_id: string; code: string; name_ar: string;
    requested: number; granted: number | null;
  }>;
}

export interface MktReview {
  id: string; plan_id: string; review_type: string;
  period_start: string; period_end: string;
  summary: string | null; what_worked: string | null; what_did_not: string | null;
  lessons: string | null; status: string; reviewer_user_id: string | null;
  mkt_review_decisions?: ReviewDecision[];
}

export interface ReviewDecision {
  id: string; review_id: string;
  initiative_id: string | null; program_id: string | null;
  campaign_id: string | null; goal_id: string | null;
  decision: string; rationale: string | null;
  goal_forecast_before: number | null; goal_forecast_after: number | null;
}

export interface ContentPillar {
  id: string; slug: string; name_ar: string; name_en: string;
  sort_order: number; is_active: boolean;
}

export interface GoalPacing {
  goal_id: string; target: number | null;
  has_periods: boolean; periods_total: number; periods_measured: number;
  expected_to_date: number | null; actual_to_date: number | null;
  forecast: number | null; forecast_is_estimate: boolean;
  result: string | null; source_of_truth: string | null;
  coverage: { measured: number; total: number } | null;
}

// ── actions ────────────────────────────────────────────────────────────────
export const fetchPlanningOverview = () => call<{
  current_strategy: StrategyVersion | null; strategies: StrategyVersion[]; plans: MktPlan[];
}>('planning_overview');

export const saveStrategy = (patch: Record<string, unknown>, id?: string) =>
  call<{ strategy: StrategyVersion }>('strategy_save', { id, patch });
/** Supersedes the incumbent in the same call — only one approved strategy may exist. */
export const approveStrategy = (id: string) =>
  call<{ strategy: StrategyVersion; superseded: string | null }>('strategy_approve', { id });

export const fetchPlanDetail = (id: string) => call<{
  plan: MktPlan; goals: MktGoal[]; initiatives: Initiative[]; programs: Program[];
  campaigns: Campaign[]; channels: ChannelPlan[]; reviews: MktReview[];
}>('plan_detail', { id });
export const savePlan = (patch: Record<string, unknown>, id?: string) =>
  call<{ plan: MktPlan }>('plan_save', { id, patch });
export const approvePlan = (id: string) => call<{ plan: MktPlan }>('plan_approve', { id });

export const saveGoal = (patch: Record<string, unknown>, id?: string) =>
  call<{ goal: MktGoal }>('goal_save', { id, patch });
/** Replaces the WHOLE allocation: seasonality is only meaningful as a set, and a
 *  per-period upsert would strand months when someone re-plans the year. */
export const setGoalTargets = (goal_id: string, periods: Array<Record<string, unknown>>) =>
  call<{ periods: GoalTargetPeriod[] }>('goal_targets_set', { goal_id, periods });
export const fetchGoalPacing = (id: string) =>
  call<{ pacing: GoalPacing | null; rollup: Record<string, unknown> | null }>('goal_pacing', { id });

export const fetchPortfolio = (plan_id?: string) => call<{
  initiatives: Initiative[]; programs: Program[]; campaigns: Campaign[];
}>('portfolio_list', { plan_id });
export const saveInitiative = (patch: Record<string, unknown>, id?: string) =>
  call<{ initiative: Initiative }>('initiative_save', { id, patch });
export const saveProgram = (patch: Record<string, unknown>, id?: string) =>
  call<{ program: Program }>('program_save', { id, patch });

export const saveChannelPlan = (patch: Record<string, unknown>, id?: string) =>
  call<{ channel_plan: ChannelPlan }>('channel_plan_save', { id, patch });
export const allocateCapacity = (patch: Record<string, unknown>, id?: string) =>
  call<{ allocation: CapacityAllocation }>('capacity_allocate', { id, patch });
export const fetchCapacityStatus = (channel_plan_id: string, week_start: string) =>
  call<{ status: CapacityStatus | null }>('capacity_status', { channel_plan_id, week_start });

export const savePlatformCampaign = (patch: Record<string, unknown>, id?: string) =>
  call<{ platform_campaign: Record<string, unknown> }>('platform_campaign_save', { id, patch });
export const saveAdGroup = (patch: Record<string, unknown>, id?: string) =>
  call<{ ad_group: Record<string, unknown> }>('ad_group_save', { id, patch });
export const saveAd = (patch: Record<string, unknown>, id?: string) =>
  call<{ ad: Record<string, unknown> }>('ad_save', { id, patch });
export const fetchPaidTree = (campaign_id: string) =>
  call<{ platform_campaigns: Array<Record<string, unknown>> }>('paid_tree', { campaign_id });

export const saveReview = (patch: Record<string, unknown>, id?: string) =>
  call<{ review: MktReview }>('review_save', { id, patch });
export const decideReview = (patch: Record<string, unknown>) =>
  call<{ decision: ReviewDecision }>('review_decide', { patch });

export const fetchPillars = () => call<{ pillars: ContentPillar[] }>('pillar_list');
export const addContentUsage = (patch: Record<string, unknown>) =>
  call<{ usage: Record<string, unknown> }>('content_usage_add', { patch });
export const fetchMissingContext = (id: string) =>
  call<{ missing: string[] }>('content_missing_context', { id });
export const generateV2Alerts = () =>
  call<{ rules: Array<{ kind: string; emitted: number }> }>('generate_v2_alerts');
export const setMarketingRole = (user_id: string, role: string | null) =>
  call<{ ok: boolean }>('set_marketing_role', { user_id, role });

// ── bilingual labels for the v2 vocabularies ───────────────────────────────
export const PLAN_TYPE_LABEL: Record<string, { ar: string; en: string }> = {
  annual:    { ar: 'سنوية', en: 'Annual' },
  quarterly: { ar: 'ربعية', en: 'Quarterly' },
  monthly:   { ar: 'شهرية', en: 'Monthly' },
  project:   { ar: 'مشروع', en: 'Project' },
  custom:    { ar: 'مخصصة', en: 'Custom' },
};

export const GOAL_CATEGORY_LABEL: Record<string, { ar: string; en: string }> = {
  outcome: { ar: 'نتيجة أعمال', en: 'Business outcome' },
  kpi:     { ar: 'مؤشر أداء', en: 'KPI target' },
  output:  { ar: 'التزام إنتاج', en: 'Output commitment' },
};

export const PLAN_STATUS_LABEL: Record<string, { ar: string; en: string }> = {
  draft:     { ar: 'مسودة', en: 'Draft' },
  in_review: { ar: 'قيد المراجعة', en: 'In review' },
  approved:  { ar: 'معتمدة', en: 'Approved' },
  active:    { ar: 'نشطة', en: 'Active' },
  completed: { ar: 'مكتملة', en: 'Completed' },
  cancelled: { ar: 'ملغاة', en: 'Cancelled' },
  archived:  { ar: 'مؤرشفة', en: 'Archived' },
};

export const STRATEGY_STATUS_LABEL: Record<string, { ar: string; en: string }> = {
  draft:      { ar: 'مسودة', en: 'Draft' },
  in_review:  { ar: 'قيد المراجعة', en: 'In review' },
  approved:   { ar: 'معتمدة', en: 'Approved' },
  superseded: { ar: 'مُستبدلة', en: 'Superseded' },
  archived:   { ar: 'مؤرشفة', en: 'Archived' },
};

export const INITIATIVE_STATUS_LABEL: Record<string, { ar: string; en: string }> = {
  proposed:  { ar: 'مقترحة', en: 'Proposed' },
  active:    { ar: 'نشطة', en: 'Active' },
  paused:    { ar: 'متوقفة مؤقتاً', en: 'Paused' },
  completed: { ar: 'مكتملة', en: 'Completed' },
  cancelled: { ar: 'ملغاة', en: 'Cancelled' },
  archived:  { ar: 'مؤرشفة', en: 'Archived' },
};

export const PROGRAM_STATUS_LABEL: Record<string, { ar: string; en: string }> = {
  draft:    { ar: 'مسودة', en: 'Draft' },
  active:   { ar: 'نشط', en: 'Active' },
  paused:   { ar: 'متوقف', en: 'Paused' },
  retired:  { ar: 'متقاعد', en: 'Retired' },
  archived: { ar: 'مؤرشف', en: 'Archived' },
};

export const DECISION_LABEL: Record<string, { ar: string; en: string }> = {
  continue: { ar: 'استمرار', en: 'Continue' },
  change:   { ar: 'تعديل', en: 'Change' },
  scale:    { ar: 'توسيع', en: 'Scale' },
  pause:    { ar: 'إيقاف مؤقت', en: 'Pause' },
  stop:     { ar: 'إيقاف', en: 'Stop' },
  revise_forecast: { ar: 'تعديل التوقع', en: 'Revise forecast' },
};

export const CADENCE_UNIT_LABEL: Record<string, { ar: string; en: string }> = {
  day:     { ar: 'يومياً', en: 'per day' },
  week:    { ar: 'أسبوعياً', en: 'per week' },
  month:   { ar: 'شهرياً', en: 'per month' },
  quarter: { ar: 'ربع سنوي', en: 'per quarter' },
};

/** What the approval gate can report missing, in the user's language. */
export const MISSING_CONTEXT_LABEL: Record<string, { ar: string; en: string }> = {
  strategic_purpose:     { ar: 'الغرض الاستراتيجي', en: 'Strategic purpose' },
  plan:                  { ar: 'الخطة', en: 'Plan' },
  primary_goal:          { ar: 'الهدف الرئيسي', en: 'Primary goal' },
  origin:                { ar: 'مصدر الإنتاج', en: 'Production origin' },
  primary_pillar:        { ar: 'المحور الرئيسي', en: 'Primary pillar' },
  audience:              { ar: 'الجمهور', en: 'Audience' },
  intended_result_or_cta:{ ar: 'النتيجة المقصودة أو دعوة الإجراء', en: 'Intended result or CTA' },
};

export const ORIGIN_KIND_LABEL: Record<string, { ar: string; en: string }> = {
  program:    { ar: 'برنامج', en: 'Program' },
  campaign:   { ar: 'حملة', en: 'Campaign' },
  reactive:   { ar: 'محتوى تفاعلي', en: 'Reactive' },
  standalone: { ar: 'مستقل', en: 'Standalone' },
};
