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
  is_migration_holder: boolean; created_at: string; archived_at: string | null;
}

/** The identity slice of a strategy version — exactly what plan_strategy_context
 *  selects. Typed narrowly so nothing reads a field the endpoint never sent. */
export interface StrategyVersionRef {
  id: string; version_number: number;
  name_ar: string; name_en: string | null;
  status: string; effective_date: string | null; approved_at: string | null;
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
  goal_class: 'outcome' | 'kpi' | 'output_commitment';
  /** Thematic grouping — what the goal is ABOUT. Separate from the class, optional. */
  goal_category: string | null;
  name_ar: string; name_en: string | null; description: string | null;
  metric: string | null; unit: string | null;
  baseline_value: number | null; target_value: number | null;
  baseline_date: string | null;
  /** known | unknown | not_applicable — a missing baseline is never zero. */
  baseline_state: 'known' | 'unknown' | 'not_applicable' | null;
  start_date: string | null; end_date: string | null; owner_user_id: string | null;
  measurement_frequency: string | null; source_of_truth: string | null; scope: string | null;
  /** Free text kept apart from the structured key, so prose is never mistaken for a wired source. */
  source_of_truth_note: string | null;
  /** Decides how measurements combine. Only 'sum' makes period allocation additive. */
  aggregation_method: 'sum' | 'latest' | 'average' | 'rate' | 'min' | 'max' | 'custom' | null;
  status: string;
  /** Read-only cache of mkt_goal_actual(); only a recorded measurement moves it. */
  actual_value: number | null; forecast_value: number | null;
  result: 'on_track' | 'at_risk' | 'off_track' | null; notes: string | null;
  needs_classification: boolean;
  linked_initiative_id: string | null;
  linked_program_id: string | null;
  linked_campaign_id: string | null;
  mkt_goal_target_periods?: GoalTargetPeriod[];
  mkt_goal_measurements?: GoalMeasurement[];
}

/** Append-only evidence. The database refuses UPDATE and DELETE on this table. */
export interface GoalMeasurement {
  id: string; goal_id: string; value: number;
  measured_at: string; period_start: string | null; period_end: string | null;
  source_key: string | null; evidence: string | null;
  entered_by_user_id: string | null; created_at: string;
}

/** mkt_goal_actual(). `value` is null and `is_measured` false when nothing has
 *  been recorded — a goal with no evidence is unmeasured, not at zero. */
export interface GoalActual {
  value: number | null;
  measurements: number;
  is_measured: boolean;
  method: string | null;
  last_measured_at: string | null;
}

/** mkt_goal_allocation_status(). `difference` and `consistent` are null when the
 *  metric is not additive — periods of a rate goal are independent targets. */
export interface GoalAllocation {
  goal_id: string;
  periods: number;
  has_allocation: boolean;
  is_additive: boolean;
  target: number | null;
  allocated: number | null;
  difference: number | null;
  consistent: boolean | null;
  note: string | null;
}

/** mkt_goal_effective_dates(): a goal inherits the plan's window unless it overrides it. */
export interface GoalEffectiveDates {
  start: string | null; end: string | null;
  start_overridden: boolean; end_overridden: boolean;
  plan_start: string | null; plan_end: string | null;
}

/** One row per rebase. Append-only, so the trail of what a plan was written
 *  against survives every later change. */
export interface PlanStrategyLink {
  id: string; plan_id: string;
  from_strategy_version_id: string | null;
  to_strategy_version_id: string | null;
  plan_status_at_change: string | null;
  reason: string | null;
  changed_by_user_id: string | null;
  changed_at: string;
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
  /** No end date by design — a program must never be a permanent campaign.
   *  The recurring commitment is four fields: how many (commitment_count) of
   *  what (output_type) every how many (every_n_periods) of which period
   *  (commitment_unit). `cadence` is the legacy free-text summary. */
  cadence: string | null;
  commitment_count: number | null;
  commitment_unit: 'day' | 'week' | 'month' | 'quarter' | null;
  output_type: string | null;
  every_n_periods: number | null;
  content_pillars?: unknown[]; accounts?: unknown[]; formats?: unknown[];
  kpi_targets?: unknown[]; lessons?: string | null;
  needs_classification?: boolean;
  platforms: unknown[]; owner_user_id: string | null; review_frequency: string | null;
  status: string; start_date: string | null; decision: string | null;
}

/** "3 project videos every 2 weeks" — composed from the four fields so the
 *  sentence is a rendering of data, never a second place the data is stored.
 *  Returns null when there is no commitment, so the card can say so instead of
 *  printing a plausible-looking zero. */
export function commitmentSentence(p: {
  commitment_count: number | null; commitment_unit: string | null;
  output_type: string | null; every_n_periods: number | null;
}, isAr: boolean): string | null {
  if (p.commitment_count == null || !p.commitment_unit) return null;
  const every = p.every_n_periods && p.every_n_periods > 1 ? p.every_n_periods : 1;
  const what = p.output_type?.trim();
  if (isAr) {
    const unit = { day: 'يوم', week: 'أسبوع', month: 'شهر', quarter: 'ربع' }[p.commitment_unit] ?? p.commitment_unit;
    const period = every > 1 ? `كل ${every} ${unit}` : `كل ${unit}`;
    return `${p.commitment_count} ${what || 'مخرج'} ${period}`;
  }
  const unit = every > 1 ? `${every} ${p.commitment_unit}s` : p.commitment_unit;
  return `${p.commitment_count} ${what || 'output'}${p.commitment_count === 1 ? '' : 's'} every ${unit}`;
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

/** Which strategy version this plan is written against, which versions exist,
 *  and the full rebase history. `id` is optional so a NEW plan form can still
 *  offer the current approved version as its default. */
export const fetchPlanStrategyContext = (id?: string) => call<{
  current_approved: StrategyVersionRef | null;
  versions: StrategyVersionRef[];
  history: PlanStrategyLink[];
  missing: string[] | null;
}>('plan_strategy_context', { id });
/** Explicit, never automatic. A plan does not follow the strategy forward on its own. */
export const rebasePlanStrategy = (id: string, strategy_version_id: string, reason?: string) =>
  call<{ result: Record<string, unknown> }>('plan_rebase_strategy', { id, strategy_version_id, reason });
export const fetchPlanMissing = (id: string) =>
  call<{ missing: string[] }>('plan_missing_requirements', { id });

export const saveGoal = (patch: Record<string, unknown>, id?: string) =>
  call<{ goal: MktGoal }>('goal_save', { id, patch });
/** Replaces the WHOLE allocation: seasonality is only meaningful as a set, and a
 *  per-period upsert would strand months when someone re-plans the year. */
export const setGoalTargets = (goal_id: string, periods: Array<Record<string, unknown>>) =>
  call<{ periods: GoalTargetPeriod[] }>('goal_targets_set', { goal_id, periods });
export const fetchGoalPacing = (id: string) =>
  call<{
    pacing: GoalPacing | null; rollup: Record<string, unknown> | null;
    allocation: GoalAllocation | null; actual: GoalActual | null;
  }>('goal_pacing', { id });
/** Everything one goal needs to render its own class-specific card. */
export const fetchGoalDetail = (id: string) => call<{
  goal: MktGoal; periods: GoalTargetPeriod[]; measurements: GoalMeasurement[];
  missing: string[]; actual: GoalActual | null; allocation: GoalAllocation | null;
  dates: GoalEffectiveDates | null;
}>('goal_detail', { id });
/** The ONLY way an actual value moves — append a measurement, never edit a number. */
export const recordGoalMeasurement = (patch: Record<string, unknown>) =>
  call<{ measurement: GoalMeasurement; actual: GoalActual | null }>('goal_measure', { patch });
export const fetchGoalMissing = (id: string) =>
  call<{ missing: string[] }>('goal_missing_requirements', { id });

export const fetchPortfolio = (plan_id?: string) => call<{
  initiatives: Initiative[]; programs: Program[]; campaigns: Campaign[];
}>('portfolio_list', { plan_id });
export const saveInitiative = (patch: Record<string, unknown>, id?: string) =>
  call<{ initiative: Initiative }>('initiative_save', { id, patch });
export const saveProgram = (patch: Record<string, unknown>, id?: string) =>
  call<{ program: Program }>('program_save', { id, patch });

// ── portfolio (2026-08-26) ─────────────────────────────────────────────────
export type PortfolioKind = 'initiative' | 'program' | 'campaign';

/** Everything the portfolio screen renders, in one round trip. Split across
 *  calls, the plan header could describe a different plan from the tree under
 *  it — which is how a "0 campaigns" heading ends up above a list of them. */
export const fetchPortfolioMap = (plan_id?: string) => call<{
  plans: PlanRef[]; strategies: StrategyVersionRef[]; goals: MktGoal[];
  initiatives: Initiative[]; programs: Program[]; campaigns: Campaign[];
  /** Content each program originated — the evidence behind its delivery
   *  progress. Empty means nothing produced, which the card says out loud. */
  program_output: Array<{
    id: string; status: string; origin_program_id: string | null;
    created_at: string; planned_publish_at: string | null;
  }>;
}>('portfolio_map', { plan_id });

/** The identity + period slice of a plan, exactly what portfolio_map selects. */
export interface PlanRef {
  id: string; name_ar: string; name_en: string | null;
  plan_type: string; status: string;
  period_start: string; period_end: string;
  strategy_version_id: string | null; owner_user_id: string | null;
  needs_classification: boolean;
}

export interface SecondaryGoalLink {
  id: string; goal_id: string; relation: string;
  initiative_id: string | null; program_id: string | null; campaign_id: string | null;
}

export interface PortfolioDetail {
  kind: PortfolioKind;
  row: Record<string, unknown>;
  programs?: Program[];
  campaigns?: Campaign[];
  content?: Array<Record<string, unknown>>;
  performance?: Array<Record<string, unknown>>;
  projects?: string[];
  secondary_goals: SecondaryGoalLink[];
  decisions: ReviewDecision[];
  /** What the DATABASE will refuse to activate without. The same list the
   *  CHECK constraints enforce, so the checklist can never promise something
   *  the save will then reject. */
  missing: string[];
}

export const fetchPortfolioDetail = (target_type: PortfolioKind, id: string) =>
  call<PortfolioDetail>('portfolio_detail', { target_type, id });

/** The ONLY way a legacy null campaign_class becomes organic or paid. */
export const classifyCampaign = (
  id: string, campaign_class: 'organic' | 'paid',
  ctx: { plan_id?: string; goal_id?: string; initiative_id?: string } = {},
) => call<{ result: { class_before: string | null; class_after: string;
  needs_classification: boolean; missing: string[] } }>('campaign_classify',
  { id, campaign_class, ...ctx });

export const setSecondaryGoals = (target_type: PortfolioKind, id: string, goal_ids: string[]) =>
  call<{ goal_ids: string[] }>('portfolio_secondary_goals_set', { target_type, id, asset_ids: goal_ids });

export const setCampaignProjects = (id: string, project_ids: string[]) =>
  call<{ project_ids: string[] }>('campaign_projects_set', { id, asset_ids: project_ids });

export const fetchPortfolioMissing = (target_type: PortfolioKind, id: string) =>
  call<{ missing: string[] }>('portfolio_missing_requirements', { target_type, id });

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

export const GOAL_CLASS_LABEL: Record<string, { ar: string; en: string }> = {
  outcome:           { ar: 'هدف نتيجة', en: 'Outcome goal' },
  kpi:               { ar: 'مؤشر أداء', en: 'KPI target' },
  output_commitment: { ar: 'التزام تنفيذي', en: 'Output commitment' },
};

/** One line telling the user which of the three they are actually creating. */
export const GOAL_CLASS_HINT: Record<string, { ar: string; en: string }> = {
  outcome: {
    ar: 'نتيجة أعمال نسعى إليها — تُقاس بالمحصلة، لا بحجم العمل.',
    en: 'A business result we are aiming at — judged by the outcome, not by effort.',
  },
  kpi: {
    ar: 'مؤشر نراقبه باستمرار — له قراءة حالية واتجاه، وليس بالضرورة إنجازاً ينتهي.',
    en: 'A number we watch continuously — it has a current reading and a trend, not a finish line.',
  },
  output_commitment: {
    ar: 'كمية عمل التزمنا بتنفيذها خلال الفترة — تُقاس بالإنجاز مقابل المطلوب.',
    en: 'An amount of work we committed to deliver in the period — completed vs required.',
  },
};

/** Thematic grouping — what the goal is ABOUT, not what kind of record it is. */
export const GOAL_CATEGORY_LABEL: Record<string, { ar: string; en: string }> = {
  acquisition: { ar: 'استقطاب', en: 'Acquisition' },
  conversion:  { ar: 'تحويل', en: 'Conversion' },
  brand:       { ar: 'علامة', en: 'Brand' },
  reach:       { ar: 'وصول', en: 'Reach' },
  engagement:  { ar: 'تفاعل', en: 'Engagement' },
  retention:   { ar: 'ولاء', en: 'Retention' },
  efficiency:  { ar: 'كفاءة', en: 'Efficiency' },
  revenue:     { ar: 'إيراد', en: 'Revenue' },
  other:       { ar: 'أخرى', en: 'Other' },
};

export const BASELINE_STATE_LABEL: Record<string, { ar: string; en: string }> = {
  known:          { ar: 'معروف', en: 'Known' },
  unknown:        { ar: 'غير معروف', en: 'Unknown' },
  not_applicable: { ar: 'لا ينطبق', en: 'Not applicable' },
};

export const AGGREGATION_LABEL: Record<string, { ar: string; en: string }> = {
  sum:     { ar: 'مجموع الفترات', en: 'Sum of periods' },
  latest:  { ar: 'آخر قراءة', en: 'Latest reading' },
  average: { ar: 'المتوسط', en: 'Average' },
  rate:    { ar: 'معدل (آخر قراءة)', en: 'Rate (latest)' },
  min:     { ar: 'الأدنى', en: 'Minimum' },
  max:     { ar: 'الأعلى', en: 'Maximum' },
  custom:  { ar: 'حساب مخصص', en: 'Custom' },
};

/** Only 'sum' makes period targets add up to the goal target. Say so in the form. */
export const AGGREGATION_HINT: Record<string, { ar: string; en: string }> = {
  sum:     { ar: 'مستهدفات الفترات يجب أن تساوي المستهدف الكلي.', en: 'Period targets must add up to the overall target.' },
  latest:  { ar: 'القيمة الحالية هي آخر قراءة مسجّلة — لا تُجمع.', en: 'The current value is the last reading — periods do not add up.' },
  average: { ar: 'القيمة هي متوسط القراءات — لا تُجمع.', en: 'The value is the average of readings — periods do not add up.' },
  rate:    { ar: 'نسبة أو معدل — جمع الفترات بلا معنى.', en: 'A rate or percentage — summing periods is meaningless.' },
  min:     { ar: 'أدنى قراءة مسجّلة.', en: 'The lowest recorded reading.' },
  max:     { ar: 'أعلى قراءة مسجّلة.', en: 'The highest recorded reading.' },
  custom:  { ar: 'حساب خارج النظام — تُدخل القراءة يدوياً.', en: 'Computed outside the system — readings entered manually.' },
};

export const MEASUREMENT_FREQUENCY_LABEL: Record<string, { ar: string; en: string }> = {
  daily:         { ar: 'يومي', en: 'Daily' },
  weekly:        { ar: 'أسبوعي', en: 'Weekly' },
  monthly:       { ar: 'شهري', en: 'Monthly' },
  quarterly:     { ar: 'ربع سنوي', en: 'Quarterly' },
  on_completion: { ar: 'عند اكتمال الحملة', en: 'At campaign completion' },
  manual:        { ar: 'يدوي عند الحاجة', en: 'Manual / ad hoc' },
};

/** Where a number actually comes from. Prose stays in source_of_truth_note so it
 *  is never mistaken for a wired source. */
export const SOURCE_OF_TRUTH_LABEL: Record<string, { ar: string; en: string }> = {
  crm_leads:             { ar: 'عملاء محتملون (CRM)', en: 'CRM leads' },
  crm_appointments:      { ar: 'مواعيد (CRM)', en: 'CRM appointments' },
  crm_sales:             { ar: 'مبيعات (CRM)', en: 'CRM sales' },
  meta_ads:              { ar: 'إعلانات ميتا', en: 'Meta Ads' },
  tiktok_ads:            { ar: 'إعلانات تيك توك', en: 'TikTok Ads' },
  snapchat_ads:          { ar: 'إعلانات سناب', en: 'Snapchat Ads' },
  google_ads:            { ar: 'إعلانات جوجل', en: 'Google Ads' },
  instagram_organic:     { ar: 'إنستغرام عضوي', en: 'Instagram organic' },
  tiktok_organic:        { ar: 'تيك توك عضوي', en: 'TikTok organic' },
  publication_snapshots: { ar: 'قراءات أداء المنشورات', en: 'Publication snapshots' },
  google_analytics:      { ar: 'جوجل أناليتكس', en: 'Google Analytics' },
  manual_verified:       { ar: 'إدخال يدوي موثّق', en: 'Manual verified entry' },
  other:                 { ar: 'مصدر آخر', en: 'Other source' },
};

/** What a goal still needs before it can be activated, in the user's language. */
export const GOAL_MISSING_LABEL: Record<string, { ar: string; en: string }> = {
  plan:                  { ar: 'الخطة', en: 'Plan' },
  goal_class:            { ar: 'تصنيف الهدف', en: 'Goal classification' },
  metric:                { ar: 'المقياس', en: 'Metric' },
  unit:                  { ar: 'الوحدة', en: 'Unit' },
  target:                { ar: 'المستهدف', en: 'Target' },
  owner:                 { ar: 'المسؤول', en: 'Owner' },
  measurement_frequency: { ar: 'دورية القياس', en: 'Measurement frequency' },
  source_of_truth:       { ar: 'مصدر القياس', en: 'Source of truth' },
  aggregation_method:    { ar: 'طريقة التجميع', en: 'Aggregation method' },
  baseline_state:        { ar: 'حالة خط الأساس', en: 'Baseline state' },
  start_date:            { ar: 'تاريخ البداية', en: 'Start date' },
  end_date:              { ar: 'تاريخ النهاية', en: 'End date' },
};

/** What a plan still needs before it can be approved or activated. */
export const PLAN_MISSING_LABEL: Record<string, { ar: string; en: string }> = {
  strategy_version:          { ar: 'نسخة الاستراتيجية', en: 'Strategy version' },
  approved_strategy_version: { ar: 'نسخة استراتيجية معتمدة', en: 'An approved strategy version' },
  owner:                     { ar: 'المسؤول', en: 'Owner' },
  at_least_one_goal:         { ar: 'هدف واحد على الأقل', en: 'At least one goal' },
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

// ── portfolio vocabulary (2026-08-26) ──────────────────────────────────────

export const CAMPAIGN_STATUS_LABEL: Record<string, { ar: string; en: string }> = {
  draft:     { ar: 'مسودة', en: 'Draft' },
  planned:   { ar: 'مخططة', en: 'Planned' },
  active:    { ar: 'نشطة', en: 'Active' },
  paused:    { ar: 'متوقفة مؤقتاً', en: 'Paused' },
  completed: { ar: 'مكتملة', en: 'Completed' },
  cancelled: { ar: 'ملغاة', en: 'Cancelled' },
  archived:  { ar: 'مؤرشفة', en: 'Archived' },
};

/** organic | paid — WHAT KIND of campaign this is. A null here means the record
 *  predates the rule and nobody has said; it is NOT the same as an incomplete
 *  strategic context, and the two must never share a label. */
export const CAMPAIGN_CLASS_LABEL: Record<string, { ar: string; en: string }> = {
  organic: { ar: 'عضوية', en: 'Organic' },
  paid:    { ar: 'مدفوعة', en: 'Paid' },
};

/** The two incompleteness states, in the words the brief settled on. */
export const CLASS_MISSING_LABEL = { ar: 'النوع غير محدد', en: 'Type not set' };
export const CONTEXT_MISSING_LABEL = { ar: 'السياق الاستراتيجي ناقص', en: 'Strategic context incomplete' };

export const FUNNEL_STAGE_LABEL: Record<string, { ar: string; en: string }> = {
  awareness:     { ar: 'وعي', en: 'Awareness' },
  consideration: { ar: 'تفكير', en: 'Consideration' },
  decision:      { ar: 'قرار', en: 'Decision' },
  retention:     { ar: 'ولاء', en: 'Retention' },
};

export const BUDGET_KIND_LABEL: Record<string, { ar: string; en: string }> = {
  daily:    { ar: 'يومية', en: 'Daily' },
  lifetime: { ar: 'إجمالية', en: 'Lifetime' },
};

/** What a portfolio record still needs before it can be activated. The keys are
 *  exactly what mkt_*_missing_requirements returns. */
export const PORTFOLIO_MISSING_LABEL: Record<string, { ar: string; en: string }> = {
  not_found:             { ar: 'السجل غير موجود', en: 'Record not found' },
  campaign_class:        { ar: 'نوع الحملة (عضوية أو مدفوعة)', en: 'Campaign type (organic or paid)' },
  plan:                  { ar: 'الخطة', en: 'Plan' },
  primary_goal:          { ar: 'الهدف الرئيسي', en: 'Primary goal' },
  owner:                 { ar: 'المسؤول', en: 'Owner' },
  start_date:            { ar: 'تاريخ البداية', en: 'Start date' },
  end_date:              { ar: 'تاريخ النهاية', en: 'End date' },
  objective:             { ar: 'الهدف من الحملة', en: 'Objective' },
  deliverables:          { ar: 'المخرجات المطلوبة', en: 'Deliverables' },
  commitment:            { ar: 'الالتزام المتكرر', en: 'Recurring commitment' },
  output_type:           { ar: 'نوع المخرج', en: 'Output type' },
  purpose:               { ar: 'الغرض', en: 'Purpose' },
  hypothesis:            { ar: 'الفرضية', en: 'Hypothesis' },
  expected_contribution: { ar: 'المساهمة المتوقعة', en: 'Expected contribution' },
  execution:             { ar: 'برنامج أو حملة واحدة على الأقل', en: 'At least one program or campaign' },
};

/** The Needs-Attention filters. Each is a question with a yes/no answer on a
 *  record, so a count next to it is a real count and not an impression. */
export const ATTENTION_FILTER_LABEL: Record<string, { ar: string; en: string }> = {
  class_missing:      { ar: 'النوع غير محدد', en: 'Type missing' },
  plan_missing:       { ar: 'بلا خطة', en: 'Plan missing' },
  goal_missing:       { ar: 'بلا هدف رئيسي', en: 'Primary goal missing' },
  owner_missing:      { ar: 'بلا مسؤول', en: 'Owner missing' },
  dates_missing:      { ar: 'بلا تواريخ', en: 'Dates missing' },
  commitment_missing: { ar: 'برنامج بلا التزام متكرر', en: 'Program commitment missing' },
  deliverables_missing: { ar: 'حملة بلا مخرجات', en: 'Campaign deliverables missing' },
  no_execution:       { ar: 'مبادرة بلا تنفيذ', en: 'Initiative with no execution' },
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
