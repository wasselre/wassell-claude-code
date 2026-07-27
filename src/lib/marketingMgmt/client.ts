// Client for /api/marketing-mgmt — internal marketing execution (إدارة التسويق).
// Separate from src/lib/marketing/client.ts, which serves external competitor
// intelligence (ذكاء التسويق). Same bearer-attached, one-wrapper-per-action shape.
import { supabase } from '@/lib/supabase';

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch('/api/marketing-mgmt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    // 403 = the DB refused on capability, 409 = a rule rejected it (invalid
    // status jump, locked version, unfinished dependency). Both are meaningful
    // to the user, so surface the server's own words rather than a generic.
    throw new Error(b?.error ?? `marketing-mgmt ${action} failed (${res.status})`);
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
  language: string; hook: string | null; main_idea: string | null; cta: string | null;
  caption: string | null; hashtags: string[]; created_at: string;
  source_insight_id: string | null; source_url: string | null;
  mkt_content_platforms?: Array<{ platform: string }>;
}
export interface Campaign {
  id: string; code: string; name_ar: string; name_en: string | null;
  campaign_type: string; status: string; channel_mix: string; priority: string;
  start_date: string | null; end_date: string | null; owner_user_id: string | null;
  objective: string | null; target_leads: number | null; target_revenue: number | null;
  budget: number | null; created_at: string;
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
  coverage: { campaigns_total: number; content_total: number; publications_total: number; assets_total: number; note: string };
}
export interface ContentDetail {
  item: ContentItem; versions: ContentVersion[]; tasks: ContentTask[];
  approvals: Approval[]; publications: Publication[]; history: StatusHistoryRow[];
  scenes: Array<Record<string, unknown>>; slides: Array<Record<string, unknown>>;
  video: Record<string, unknown> | null; post: Record<string, unknown> | null;
  assets: Array<{ asset_id: string; mkt_raw_assets: Record<string, unknown> | null }>;
}

// ── actions ────────────────────────────────────────────────────────────────
export const fetchOverview = (limit = 12) => call<{ overview: MgmtOverview }>('overview', { limit });
export const generateAlerts = () => call<{ rules: Array<{ kind: string; emitted: number }> }>('generate_alerts');

export const fetchCampaigns = (limit = 100) => call<{ campaigns: Campaign[] }>('campaign_list', { limit });
export const fetchCampaign = (id: string) => call<{ campaign: Campaign; content: ContentItem[]; tasks: ContentTask[]; performance: unknown[] }>('campaign_detail', { id });
export const saveCampaign = (patch: Record<string, unknown>, id?: string) => call<{ campaign: Campaign }>('campaign_save', { id, patch });

export const fetchContentList = (filters: Record<string, unknown> = {}) => call<{ content: ContentItem[] }>('content_list', filters);
export const fetchContentDetail = (id: string) => call<ContentDetail>('content_detail', { id });
export const createContent = (title: string, content_type: ContentType, patch: Record<string, unknown> = {}) =>
  call<{ item: ContentItem; tasks_generated: number }>('content_create', { title, content_type, patch });
export const updateContent = (id: string, patch: Record<string, unknown>) => call<{ item: ContentItem }>('content_update', { id, patch });
export const transitionContent = (id: string, to_status: ContentStatus) => call<{ item: ContentItem }>('content_transition', { id, to_status });

export const createVersion = (content_item_id: string, version_type: string, payload: Record<string, unknown>, change_summary?: string, file_id?: string) =>
  call<{ version: ContentVersion }>('version_create', { content_item_id, version_type, payload, change_summary, file_id });
export const decideApproval = (p: { approval_id?: string; target_id?: string; target_type?: string; stage?: string; id?: string; decision: 'approved'|'changes_requested'|'rejected'|'cancelled'; comment?: string; requested_changes?: string }) =>
  call<{ approval: Approval }>('approval_decide', p as unknown as Record<string, unknown>);

export const updateTask = (task_id: string, patch: Record<string, unknown>) => call<{ task: ContentTask }>('task_update', { task_id, patch });
export const saveScene = (patch: Record<string, unknown>, id?: string) => call<{ row: Record<string, unknown> }>('scene_save', { id, patch });
export const saveSlide = (patch: Record<string, unknown>, id?: string) => call<{ row: Record<string, unknown> }>('slide_save', { id, patch });
export const reorderScenes = (order: string[]) => call<{ reordered: number }>('scene_reorder', { order });
export const reorderSlides = (order: string[]) => call<{ reordered: number }>('slide_reorder', { order });

export const fetchAssets = (filters: Record<string, unknown> = {}) => call<{ assets: Array<Record<string, unknown>> }>('asset_list', filters);
export const saveAsset = (patch: Record<string, unknown>, id?: string) => call<{ asset: Record<string, unknown> }>('asset_save', { id, patch });
export const linkAsset = (asset_id: string, target_type: string, target_id: string) => call<{ link: unknown }>('asset_link', { asset_id, target_type, target_id });

export const savePublication = (patch: Record<string, unknown>, id?: string) => call<{ publication: Publication }>('publication_save', { id, patch });
export const recordPerformance = (p: { publication_id?: string; campaign_id?: string; platform?: string; metrics: Record<string, unknown>; collection_status?: string }) =>
  call<{ snapshot: unknown }>('performance_record', p as unknown as Record<string, unknown>);
export const recordAttribution = (patch: Record<string, unknown>) => call<{ attribution: unknown }>('attribution_record', { patch });

export const createFromIntelligence = (p: { source_type: string; source_id: string; action_type: string; title?: string; content_type?: string; patch?: Record<string, unknown> }) =>
  call<{ action: unknown; content_item_id: string | null; tasks_generated: number }>('intelligence_action', p as unknown as Record<string, unknown>);
export const fetchIntelligenceResponses = (source_id: string) => call<{ responses: Array<Record<string, unknown>> }>('intelligence_responses', { source_id });
