// Client for /api/marketing-mgmt — internal marketing execution (إدارة التسويق).
// Separate from src/lib/marketing/client.ts, which serves external competitor
// intelligence (ذكاء التسويق). Same bearer-attached, one-wrapper-per-action shape.
import { supabase } from '@/lib/supabase';
import { useAppStore } from '@/stores/appStore';

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Exported so the v2 planning module can share one transport, one auth header
 *  and one error-mapping path rather than growing a second copy. */
export async function call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch('/api/marketing-mgmt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string; error_ar?: string };
    // 403 = the DB refused on capability, 409 = a rule rejected it (invalid
    // status jump, locked version, unfinished dependency). Both are meaningful
    // to the user, so surface the server's own words rather than a generic.
    //
    // The endpoint translates database rejections into a sentence in BOTH
    // languages — a raw Postgres message names internal tables and tells the
    // reader nothing to do. Pick the side that matches the interface. Reading
    // the store rather than taking a parameter keeps every existing call site
    // unchanged; `getState` is a plain read, so this is not a subscription.
    const isAr = useAppStore.getState().language === 'ar';
    const msg = (isAr ? b?.error_ar || b?.error : b?.error);
    throw new Error(msg ?? `marketing-mgmt ${action} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

// ── shared vocabulary (mirrors the DB CHECK constraints) ───────────────────
export const CONTENT_STATUSES = ['idea','brief','writing','awaiting_script_approval',
  'approved_for_production','raw_assets_required','recording','designing','editing',
  'internal_review','revision_requested','awaiting_final_approval','approved',
  'ready_to_publish','scheduled','published','cancelled','archived'] as const;
export type ContentStatus = typeof CONTENT_STATUSES[number];

export const STATUS_LABEL: Record<ContentStatus, { ar: string; en: string }> = {
  idea:{ar:'فكرة',en:'Idea'}, brief:{ar:'موجز',en:'Brief'}, writing:{ar:'كتابة',en:'Writing'},
  awaiting_script_approval:{ar:'بانتظار اعتماد النص',en:'Awaiting script approval'},
  approved_for_production:{ar:'معتمد للإنتاج',en:'Approved for production'},
  raw_assets_required:{ar:'يحتاج مواد خام',en:'Raw assets required'},
  recording:{ar:'تصوير',en:'Recording'}, designing:{ar:'تصميم',en:'Designing'},
  editing:{ar:'مونتاج',en:'Editing'}, internal_review:{ar:'مراجعة داخلية',en:'Internal review'},
  revision_requested:{ar:'مطلوب تعديل',en:'Revision requested'},
  awaiting_final_approval:{ar:'بانتظار الاعتماد النهائي',en:'Awaiting final approval'},
  approved:{ar:'معتمد',en:'Approved'}, ready_to_publish:{ar:'جاهز للنشر',en:'Ready to publish'},
  scheduled:{ar:'مجدول',en:'Scheduled'}, published:{ar:'منشور',en:'Published'},
  cancelled:{ar:'ملغي',en:'Cancelled'}, archived:{ar:'مؤرشف',en:'Archived'},
};

export const CONTENT_TYPES = ['reel','tiktok_video','snapchat_video','snapchat_story',
  'instagram_story','static_image','carousel','infographic','long_form_video',
  'paid_video_ad','paid_image_ad','project_announcement','testimonial','construction_update',
  'educational','floor_plan','property_tour','drone_video','presenter_video','ai_video',
  'motion_graphics','custom'] as const;
export type ContentType = typeof CONTENT_TYPES[number];

export const PLATFORMS = ['instagram','tiktok','youtube','snapchat','x','facebook','linkedin','whatsapp','website'] as const;

// ── shapes ─────────────────────────────────────────────────────────────────
export interface ContentItem {
  id: string; content_number: string; title: string; content_type: ContentType;
  status: ContentStatus; priority: string; purpose: string | null;
  project_id: string | null; campaign_id: string | null;
  owner_user_id: string | null; due_date: string | null; planned_publish_at: string | null;
  writer_user_id: string | null; designer_user_id: string | null;
  editor_user_id: string | null; presenter_user_id: string | null;
  photographer_user_id: string | null;
  language: string; hook: string | null; main_idea: string | null; cta: string | null;
  caption: string | null; hashtags: string[]; created_at: string;
  target_audience: string | null; content_pillar: string | null;
  reference_links: string[]; production_notes: string | null;
  // 2026-08-21 marketing fields. Optional on the type because a deployment
  // whose migration has not run yet simply will not return them.
  organic_or_paid?: string | null; funnel_stage?: string | null;
  content_angle?: string | null; offer_message?: string | null;
  cta_destination?: string | null; tracking_link?: string | null;
  next_action?: string | null; blocker?: string | null;
  final_asset_id?: string | null;
  source_insight_id: string | null; source_url: string | null;
  mkt_content_platforms?: Array<{ platform: string }>;
}
export interface Campaign {
  id: string;
  /** Issued by the database from a sequence. Never typed, never editable. */
  code: string;
  name_ar: string; name_en: string | null;
  campaign_type: string; status: string; channel_mix: string; priority: string;
  start_date: string | null; end_date: string | null; owner_user_id: string | null;
  objective: string | null; target_leads: number | null; target_revenue: number | null;
  budget: number | null; created_at: string;
  /** organic | paid, or null on a legacy row nobody has classified yet. NULL
   *  means "we were never told", which is a different statement from
   *  needs_classification — see that field. */
  campaign_class?: 'organic' | 'paid' | null;
  /** Derived by trigger: this record has no plan or no primary goal. It says
   *  nothing about whether the campaign is organic or paid. */
  needs_classification?: boolean;
  plan_id?: string | null; initiative_id?: string | null; program_id?: string | null;
  primary_goal_id?: string | null;
  funnel_stage?: string | null;
  target_audience?: string | null; main_message?: string | null; offer?: string | null;
  cta?: string | null; landing_url?: string | null; positioning?: string | null;
  hooks?: string[]; content_pillars?: string[];
  deliverables?: unknown[]; actual_results?: Record<string, unknown>;
  lessons?: string | null; decision?: string | null;
  target_sales?: number | null; target_appointments?: number | null;
  target_cpl?: number | null; target_cpa?: number | null; target_roas?: number | null;
  // 2026-08-26 operational fields
  budget_kind?: 'daily' | 'lifetime' | null;
  conversion_objective?: string | null; tracking_template?: string | null;
  locations?: unknown[]; property_types?: unknown[];
  period_override_reason?: string | null; period_override_at?: string | null;
  mkt_internal_campaign_projects?: Array<{ project_id: string }>;
  mkt_content_items?: Array<{ id: string; status: string }>;
}
export interface ContentTask {
  id: string; title: string; task_type: string; status: string; priority: string;
  due_date: string | null; assigned_user_id: string | null;
  depends_on_task_id: string | null; blocked_reason: string | null; sort_order: number;
}
export interface ContentVersion {
  id: string; version_number: number; version_type: string;
  payload: Record<string, unknown>; file_id: string | null; change_summary: string | null;
  approval_state: string; approved_at: string | null; is_locked: boolean; created_at: string;
}
export interface Publication {
  id: string; platform: string; channel: string; status: string;
  scheduled_for: string | null; published_at: string | null; published_url: string | null;
  publish_method: string; error_message: string | null;
}
export interface Approval {
  id: string; stage: string; decision: string; comment: string | null;
  requested_changes: string | null; created_at: string; decided_at: string | null;
}
export interface StatusHistoryRow {
  id: string; from_status: string | null; to_status: string; changed_at: string; reason: string | null;
}
export interface MgmtAlert {
  id: string; kind: string; severity: 'info'|'warning'|'critical';
  title_ar: string; title_en: string; target_type: string; target_id: string;
  evidence: Record<string, unknown>; generated_at: string;
}
/** Every count is a SQL COUNT. A null here means NOT RECORDED, never zero. */
export interface MgmtOverview {
  generated_at: string;
  kpis: {
    planned_this_month: number; in_production: number; awaiting_approval: number;
    ready_to_publish: number; scheduled: number; published_this_month: number;
    late: number; blocked: number; active_organic_campaigns: number;
    active_paid_campaigns: number; raw_assets_available: number;
    leads_attributed: number; revenue_attributed: number | null;
    appointments_attributed: number; sales_attributed: number;
  };
  due_today: Array<{ id: string; content_number: string; title: string; status: string; due_date: string }>;
  overdue: Array<{ id: string; content_number: string; title: string; status: string; due_date: string; days_late: number }>;
  approval_queue: Array<{ id: string; stage: string; target_id: string; title: string | null; content_number: string | null; hours_waiting: number }>;
  publishing_queue: Array<{ id: string; platform: string; scheduled_for: string | null; status: string; title: string; content_number: string; has_approved_version: boolean }>;
  recently_published: Array<{ id: string; platform: string; published_at: string; published_url: string | null; title: string; content_number: string; has_performance: boolean }>;
  alerts: MgmtAlert[];
  workload: Array<{ assigned_user_id: string; open_tasks: number; overdue_tasks: number }>;
  coverage: {
    campaigns_total: number; content_total: number; publications_total: number; assets_total: number;
    /** The caveat travels with the data because it is the denominator for every
     *  number beside it. `note` is English; `note_ar` may be absent on an
     *  older deployment, so callers fall back to `note`. */
    note: string; note_ar?: string;
  };
}
export interface ContentDetail {
  item: ContentItem; versions: ContentVersion[]; tasks: ContentTask[];
  approvals: Approval[]; publications: Publication[]; history: StatusHistoryRow[];
  scenes: Array<Record<string, unknown>>; slides: Array<Record<string, unknown>>;
  video: Record<string, unknown> | null; post: Record<string, unknown> | null;
  assets: Array<{ asset_id: string; mkt_raw_assets: Record<string, unknown> | null }>;
  performance: Array<Record<string, unknown>>;
  attributions: Array<Record<string, unknown>>;
  /** Legal next statuses, computed by the database from the same rule the
   *  trigger enforces. `null` means the deployment is missing the RPC — the UI
   *  must say so rather than silently offering nothing or everything. */
  allowed_transitions: string[] | null;
}

// ── actions ────────────────────────────────────────────────────────────────
export const fetchOverview = (limit = 12) => call<{ overview: MgmtOverview }>('overview', { limit });
export const generateAlerts = () => call<{ rules: Array<{ kind: string; emitted: number }> }>('generate_alerts');

export const fetchCampaigns = (limit = 100) => call<{ campaigns: Campaign[] }>('campaign_list', { limit });

/** One progress measure. The three states are deliberately distinct:
 *
 *   no_target      nobody has said what "done" means — not 0%
 *   awaiting_data  a target exists but nothing has been measured yet — not 0%
 *   measured       a real reading, which may legitimately be zero
 *
 * Collapsing these into one percentage is what made every campaign read 0%. */
export type ProgressState =
  | { state: 'no_target' }
  | { state: 'awaiting_data'; total: number }
  | { state: 'measured'; done: number; total: number };

/** The four ways a content item can belong to a campaign, counted separately
 *  and then deduplicated — the same item reached three ways is one item. */
export interface CampaignCounts {
  produced_content_count: number;
  reused_content_count: number;
  legacy_content_count: number;
  paid_creative_count: number;
  unique_content_count: number;
  approved_content_count: number;
  published_content_count: number;
}

export interface CampaignProgress {
  deliverables: ProgressState;
  publication: ProgressState;
  outcome: ProgressState;
  metric: string;
  counts: CampaignCounts;
}

/** A legal next status, and — when it is not currently reachable — exactly what
 *  is missing. Offering the action greyed out with its reason beats hiding it. */
export interface NextStatus {
  status: string;
  allowed: boolean;
  blockers: string[];
}

export interface CampaignStatusEvent {
  id: string; campaign_id: string;
  from_status: string | null; to_status: string;
  reason: string | null; changed_by_user_id: string | null; changed_at: string;
}

export type CampaignContentRow = ContentItem & {
  origin_campaign_id?: string | null;
  usage_kind?: string; usage_id?: string;
};

export const fetchCampaign = (id: string) => call<{
  campaign: Campaign;
  /** The deduplicated union, for readers that just want "the content". */
  content: CampaignContentRow[];
  produced_content: CampaignContentRow[];
  reused_content: CampaignContentRow[];
  legacy_content: CampaignContentRow[];
  counts: CampaignCounts | null;
  progress: CampaignProgress | null;
  status_history: CampaignStatusEvent[];
  next_statuses: NextStatus[];
  tasks: ContentTask[]; performance: unknown[];
}>('campaign_detail', { id });

export const saveCampaign = (patch: Record<string, unknown>, id?: string) => call<{ campaign: Campaign }>('campaign_save', { id, patch });

/** The ONLY way a campaign's status moves. `status` is not in the save
 *  allow-list, so a generic save cannot jump a campaign from archived to active. */
export const transitionCampaign = (id: string, to_status: string) =>
  call<{ campaign: Campaign; next_statuses: NextStatus[] }>('campaign_transition', { id, to_status });

export const fetchCampaignNextStatuses = (id: string) =>
  call<{ next_statuses: NextStatus[]; blockers: string[] }>('campaign_next_statuses', { id });

export const fetchContentList = (filters: Record<string, unknown> = {}) => call<{ content: ContentItem[] }>('content_list', filters);
export const fetchContentDetail = (id: string) => call<ContentDetail>('content_detail', { id });
export const createContent = (title: string, content_type: ContentType, patch: Record<string, unknown> = {}) =>
  call<{ item: ContentItem; tasks_generated: number }>('content_create', { title, content_type, patch });
export const updateContent = (id: string, patch: Record<string, unknown>) => call<{ item: ContentItem }>('content_update', { id, patch });
export const transitionContent = (id: string, to_status: ContentStatus) => call<{ item: ContentItem }>('content_transition', { id, to_status });
/** Replace the target-platform set for a content item. */
export const setPlatforms = (content_item_id: string, platforms: string[]) =>
  call<{ platforms: string[] }>('platform_set', { content_item_id, platforms });

export const createVersion = (content_item_id: string, version_type: string, payload: Record<string, unknown>, change_summary?: string, file_id?: string) =>
  call<{ version: ContentVersion }>('version_create', { content_item_id, version_type, payload, change_summary, file_id });
export const decideApproval = (p: { approval_id?: string; target_id?: string; target_type?: string; stage?: string; id?: string; decision: 'approved'|'changes_requested'|'rejected'|'cancelled'; comment?: string; requested_changes?: string }) =>
  call<{ approval: Approval }>('approval_decide', p as unknown as Record<string, unknown>);

export const updateTask = (task_id: string, patch: Record<string, unknown>) => call<{ task: ContentTask }>('task_update', { task_id, patch });
export const saveScene = (patch: Record<string, unknown>, id?: string) => call<{ row: Record<string, unknown> }>('scene_save', { id, patch });
export const saveSlide = (patch: Record<string, unknown>, id?: string) => call<{ row: Record<string, unknown> }>('slide_save', { id, patch });
export const reorderScenes = (order: string[]) => call<{ reordered: number }>('scene_reorder', { order });
export const reorderSlides = (order: string[]) => call<{ reordered: number }>('slide_reorder', { order });

export interface PublicationRow extends Publication {
  content_item_id: string; campaign_id: string | null; caption: string | null;
  mkt_content_items?: { id: string; content_number: string; title: string; content_type: string; status: string } | null;
}
export interface PerfSnapshot {
  id: string; publication_id: string | null; campaign_id: string | null; platform: string | null;
  captured_at: string; source: string; metrics: Record<string, number | string>;
  collection_status: string; error: string | null;
}
export const fetchPublications = (f: Record<string, unknown> = {}) => call<{ publications: PublicationRow[] }>('publication_list', f);
export const fetchApprovals = (f: Record<string, unknown> = {}) => call<{ approvals: Approval[] }>('approval_list', f);
export const fetchPerformance = (f: Record<string, unknown> = {}) => call<{ snapshots: PerfSnapshot[] }>('performance_list', f);

export const fetchAssets = (filters: Record<string, unknown> = {}) => call<{ assets: Array<Record<string, unknown>> }>('asset_list', filters);
export const saveAsset = (patch: Record<string, unknown>, id?: string) => call<{ asset: Record<string, unknown> }>('asset_save', { id, patch });
/** Queue analysis. Omit ids to sweep every un-analysed asset that has a file. */
export const processAssets = (asset_ids?: string[], limit = 50) =>
  call<{ queued: number }>('asset_process', { asset_ids, limit });
export const linkAsset = (asset_id: string, target_type: string, target_id: string) => call<{ link: unknown }>('asset_link', { asset_id, target_type, target_id });

export const savePublication = (patch: Record<string, unknown>, id?: string) => call<{ publication: Publication }>('publication_save', { id, patch });
export const recordPerformance = (p: { publication_id?: string; campaign_id?: string; platform?: string; metrics: Record<string, unknown>; collection_status?: string }) =>
  call<{ snapshot: unknown }>('performance_record', p as unknown as Record<string, unknown>);
export const recordAttribution = (patch: Record<string, unknown>) => call<{ attribution: unknown }>('attribution_record', { patch });

export const createFromIntelligence = (p: { source_type: string; source_id: string; action_type: string; title?: string; content_type?: string; patch?: Record<string, unknown> }) =>
  call<{ action: unknown; content_item_id: string | null; tasks_generated: number }>('intelligence_action', p as unknown as Record<string, unknown>);
export const fetchIntelligenceResponses = (source_id: string) => call<{ responses: Array<Record<string, unknown>> }>('intelligence_responses', { source_id });
