// Client for /api/marketing — thin, bearer-attached, one wrapper per action.
import { supabase } from '@/lib/supabase';

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch('/api/marketing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b?.error ?? `marketing ${action} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export interface ProviderRow {
  provider_key: string; display_name: string; is_enabled: boolean;
  health_status: string; health_detail: string | null; last_checked_at: string | null;
}
export interface OverviewData {
  developer: { posts: number; videos: number; images: number; this_month: number };
  competitors: { marketers: number; posts: number };
  our_library: { total: number; ready: number; drafts: number };
  review_queue: number;
}
export interface ContentRow {
  id: string; review_status: string; confidence: number; attribution_method: string;
  evidence?: { matched?: string; snippet?: string } | null;
  mkt_content_posts: {
    id: string; platform: string; external_id: string; post_url: string | null;
    post_type: string | null; caption: string | null; published_at: string | null;
    thumbnail_ref: string | null; engagement: Record<string, number>; last_seen_at: string | null;
    providers: string[]; first_provider: string | null;
    mkt_organizations: { name_ar: string | null; name_en: string | null; org_type: string } | null;
  };
}
export interface MarketerRow {
  org: { id: string; name_ar: string | null; name_en: string | null; org_type: string; website: string | null };
  posts: number; videos: number; images: number; last: string | null;
}

export const fetchProviderHealth = () => call<{ providers: ProviderRow[] }>('provider_health');
export const fetchProjectOverview = (project_id: string) => call<OverviewData>('project_overview', { project_id });
export const fetchProjectContent = (project_id: string, source: 'all' | 'developer' | 'marketer', page = 1) =>
  call<{ rows: ContentRow[]; total: number; page: number; page_size: number }>('project_content', { project_id, source, page });
export const fetchProjectMarketers = (project_id: string) =>
  call<{ marketers: MarketerRow[] }>('project_marketers', { project_id });
export const fetchAttributionReview = (project_id: string) =>
  call<{ candidates: unknown[] }>('attribution_review', { project_id });
export const fetchMarketingAccounts = (project_id: string) =>
  call<{ links: unknown[] }>('accounts', { project_id });
export const decideAttribution = (attribution_id: string, decision: 'confirm' | 'reject' | 'reassign', new_project_id?: string) =>
  call<{ ok: boolean }>('attribution_decide', { attribution_id, decision, new_project_id });

export interface CollectionStatusData {
  links: Array<{
    organization_id: string;
    mkt_organizations: {
      name_ar: string | null; name_en: string | null;
      mkt_social_accounts: Array<{
        id: string; platform: string; handle: string; provider: string | null;
        scrape_status: string; collection_enabled: boolean;
        last_synced_at: string | null; last_incremental_at: string | null; last_metrics_at: string | null; followers: number | null;
      }>;
    };
  }>;
  runs: Array<{
    source_account_id: string | null; provider: string; status: string;
    started_at: string; finished_at: string | null;
    items_received: number; items_inserted: number; items_updated: number; items_skipped: number; errors: unknown[];
  }>;
  jobs: Array<{
    id: string; social_account_id: string | null; kind: string; status: string; attempts: number;
    next_run_at: string | null; error_message: string | null; updated_at: string;
  }>;
}
export const fetchCollectionStatus = (project_id: string) => call<CollectionStatusData>('collection_status', { project_id });
export const runCollection = (account_id: string, provider: string, kind = 'incremental') =>
  call<{ job_id: string }>('run_collection', { account_id, provider, kind });
export const retryJob = (job_id: string) => call<{ ok: boolean }>('retry_job', { job_id });
export const setAccountCollection = (account_id: string, collection_enabled: boolean) =>
  call<{ ok: boolean }>('set_account_collection', { account_id, collection_enabled });
export const setCollectionPaused = (paused: boolean) => call<{ ok: boolean; paused: boolean }>('set_collection_paused', { paused });
export const refreshProviderHealthNow = () => call<{ providers: ProviderRow[] }>('refresh_provider_health');

export interface AdRow {
  id: string; review_status: string; confidence: number; evidence?: { matched?: string } | null;
  mkt_paid_ads: {
    id: string; platform: string; external_ad_id: string; advertiser_name: string | null;
    creative_media_ref: string | null; creative_type: string | null; headline: string | null;
    body: string | null; description: string | null; cta: string | null; landing_url: string | null;
    languages: string[] | null; is_active: boolean; first_seen_at: string | null; last_seen_at: string | null;
    platform_started_at: string | null; platform_ended_at: string | null; providers: string[];
    organization_id: string | null; mkt_organizations: { name_ar: string | null; name_en: string | null; org_type: string } | null;
  };
}
export interface AdTimelineEvent {
  change_type: string; observed_at: string; field: string | null; old_value: unknown; new_value: unknown;
  mkt_paid_ads: { external_ad_id: string; advertiser_name: string | null };
}
export const fetchProjectAds = (project_id: string, active?: boolean) => call<{ rows: AdRow[]; total: number }>('project_ads', { project_id, active });
export const fetchAdTimeline = (project_id: string) => call<{ events: AdTimelineEvent[] }>('ad_timeline', { project_id });
export const runAdsCollection = (organization_id: string, advertiser: string, limit = 25) =>
  call<{ job_id: string }>('run_ads_collection', { organization_id, advertiser, limit });

export interface InsightRow { id: string; kind: string; severity: string; title: string; body: string | null; evidence: unknown; generated_at: string; campaign_id: string | null }
export interface CampaignRow { id: string; advertiser_name: string | null; primary_cta: string | null; primary_headline: string | null; ad_count: number; active_ad_count: number; is_active: boolean; first_seen_at: string | null; last_seen_at: string | null; ended_at: string | null }
export interface CostDashboard { total_usd: number; total_runs: number; failed_runs: number; avg_usd_per_run: number; by_provider: Record<string, { runs: number; usd: number; compute: number; failed: number }>; by_day: Record<string, number> }
export const fetchProjectInsights = (project_id: string) => call<{ insights: InsightRow[] }>('project_insights', { project_id });
export const fetchProjectCampaigns = (project_id: string) => call<{ campaigns: CampaignRow[] }>('project_campaigns', { project_id });
export const fetchCostDashboard = () => call<CostDashboard>('cost_dashboard');

// ── Operations & Monitoring ────────────────────────────────────────────────
export interface OpsProviderHealth {
  provider: string; display_name: string | null; is_enabled: boolean;
  health_status: string | null; health_detail: string | null; last_checked_at: string | null;
  last_success: string | null; last_failure: string | null; consecutive_failures: number;
  avg_run_duration_ms: number | null; avg_response_ms: number | null; runs_14d: number;
  success_rate: number | null; error_rate: number | null; cost_today: number; cost_month: number;
}
export interface OpsQueueHealth {
  queued: number; running: number; retrying: number; succeeded_24h: number; failed_24h: number;
  retried_total: number; oldest_queued_at: string | null; longest_running_at: string | null;
}
export interface OpsOrgHealth {
  organization_id: string; name_ar: string | null; name_en: string | null; org_type: string;
  accounts: number; last_success_collection: string | null; last_metrics_update: string | null;
  last_new_content: string | null; last_paid_ad: string | null; cadence: unknown;
  next_scheduled_run: string | null; consecutive_failures: number; is_stale: boolean;
}
export interface OpsCost {
  today_usd: number; month_usd: number; total_usd: number; runs_month: number; items_month: number;
  avg_per_run: number; avg_per_item: number;
  by_provider: Record<string, { usd: number; runs: number; items: number }>;
  by_kind: Record<string, { usd: number; runs: number }>;
  by_org: Array<{ organization_id: string; name: string | null; usd: number; runs: number }>;
  spike: { is_spike: boolean; today_usd: number; avg7_usd: number };
}
export interface OpsAlert {
  id: string; kind: string; severity: 'info' | 'warning' | 'critical'; subject_type: string | null;
  subject_id: string | null; title: string; body: string | null; evidence: unknown; status: 'open' | 'acknowledged' | 'resolved';
  occurrences: number; first_seen_at: string; last_seen_at: string; acknowledged_at?: string | null; resolved_at?: string | null;
}
export interface OpsDiagnostic { check_name: string; status: 'ok' | 'degraded' | 'down'; detail: string | null; latency_ms: number | null; checked_at: string }
export interface OpsDashboard {
  generated_at: string;
  providers: OpsProviderHealth[];
  provider_counts: { healthy: number; degraded: number; offline: number; total: number };
  queue: OpsQueueHealth;
  diagnostics: Record<string, { status: string; detail: string | null; checked_at: string }>;
  heartbeats: Record<string, string>;
  cost: OpsCost;
  open_alerts: number; critical_alerts: number;
  last_success_collection: string | null; last_failed_collection: string | null;
  jobs_running: number; avg_collection_duration_ms: number | null;
  collections_today: number; failures_today: number; collection_paused: boolean;
}
export interface OpsMetricRow { day: string; metric: string; provider: string; value: number }

export const fetchOpsDashboard = () => call<{ dashboard: OpsDashboard }>('ops_dashboard');
export const fetchOpsProviderHealth = () => call<{ providers: OpsProviderHealth[] }>('ops_provider_health');
export const fetchOpsOrgHealth = () => call<{ organizations: OpsOrgHealth[] }>('ops_org_health');
export const fetchOpsQueueHealth = () => call<{ queue: OpsQueueHealth }>('ops_queue_health');
export const fetchOpsCost = () => call<{ cost: OpsCost }>('ops_cost');
export const fetchOpsAlerts = (status: 'open' | 'acknowledged' | 'resolved' | 'all' = 'open') => call<{ alerts: OpsAlert[] }>('ops_alerts', { status });
export const fetchOpsDiagnostics = () => call<{ checks: OpsDiagnostic[] }>('ops_diagnostics');
export const fetchOpsMetricsHistory = (days = 30, metric?: string) => call<{ rows: OpsMetricRow[] }>('ops_metrics_history', { days, metric });
export const setOpsAlertStatus = (alert_id: string, alert_status: 'open' | 'acknowledged' | 'resolved') => call<{ ok: boolean }>('ops_alert_status', { alert_id, alert_status });
export const runOpsEvaluate = () => call<{ result: unknown }>('ops_evaluate');

export interface OpsFailedJob {
  id: string; kind: string; provider: string; status: string; attempts: number; max_attempts: number;
  error_message: string | null; next_run_at: string | null; updated_at: string; social_account_id: string | null;
}
export const fetchOpsFailedJobs = () => call<{ jobs: OpsFailedJob[] }>('ops_failed_jobs');

// ── Claude Code runner health (Fly app "wassel-claude-runner") ──────────────
// Shape mirrors the claude_runner_health() RPC. Identifiers/states/counts only —
// no OAuth token, credentials, job payloads or customer evidence cross this API.
export interface RunnerLease {
  name: string; owner_id: string; host: string | null; pid: number | null;
  acquired_at: string; heartbeat_at: string; expires_at: string; released_at: string | null;
  is_live: boolean; heartbeat_age_seconds: number;
}
export interface RunnerCurrentJob {
  id: string; kind: string; started_at: string; claimed_by: string | null;
  attempts: number; running_seconds: number;
}
export interface RunnerFailureGroup { kind: string; n: number; last_error: string }
export interface RunnerHealth {
  checked_at: string;
  lease: RunnerLease | null;
  queue: Partial<Record<'pending' | 'running' | 'ready' | 'failed' | 'cancelled', number>>;
  oldest_pending_age_seconds: number | null;
  current_job: RunnerCurrentJob | null;
  failures_24h: RunnerFailureGroup[];
  blocked_count: number;
  last_completed_at: string | null;
  awaiting_intelligence_posts: number;
}
export const fetchOpsRunnerHealth = () => call<{ runner: RunnerHealth }>('ops_runner_health');

// ── Advertiser discovery / confirmation ─────────────────────────────────────
export interface ScoreReason { code: string; label_en: string; label_ar: string; delta: number }
export interface AdvertiserCandidate {
  pageId: string; pageName: string | null; pageUrl: string; adCount?: number;
  landingDomains?: string[]; sampleHeadlines?: string[];
  score: number; confidence: 'high' | 'medium' | 'low'; isMarketplace: boolean; reasons: ScoreReason[];
}
export interface AdvertiserAuditRow { event: string; old_page_id: string | null; new_page_id: string | null; created_at: string }
export interface AdvertiserOrg {
  id: string; name_ar: string | null; name_en: string | null; org_type: string; website: string | null;
  meta_page_id: string | null; meta_page_url: string | null; meta_display_name: string | null;
  meta_confirmed: boolean; meta_confirmed_at: string | null; meta_discovery_confidence: string | null;
  meta_confirmation_evidence: { evidence?: ScoreReason[]; source?: string; score?: number } | null;
  meta_candidates: AdvertiserCandidate[] | null;
  ad_count: number; audit: AdvertiserAuditRow[];
}
export const fetchAdvertisers = () => call<{ organizations: AdvertiserOrg[] }>('advertiser_list');

// ── Automated identity discovery (Browserbase engine) ───────────────────────
export interface DiscoveryRun {
  id: string; organization_id: string; status: string; trigger: string;
  sources_used: string[]; queries_count: number; evidence_count: number;
  candidates_count: number; confirmed_count: number; cost_usd: number | string;
  error: string | null; summary: { confirm_decisions?: Record<string, string>; platforms?: string[] } | null;
  started_at: string; finished_at: string | null;
}
export interface IdentityCandidate {
  id: string; platform: string; handle: string; account_id: string | null; url: string | null;
  account_class: string; score: number | string; confidence: 'high' | 'medium' | 'low';
  is_marketplace: boolean; reasons: ScoreReason[]; evidence: { sources?: string[] } | null;
  status: 'candidate' | 'confirmed' | 'rejected' | 'stale'; rejection_reason: string | null;
  verification_method: string | null; discovery_run_id: string | null; updated_at: string;
}
// ── Content intelligence ────────────────────────────────────────────────────
export interface ContentMetrics {
  total: number; videos: number; images: number; carousels: number;
  processed: number; partial: number; failed: number;
  media_stored: number; media_failed: number; media_success_rate: number | null;
  transcribed: number; transcribe_failed: number;
  enriched: number; attributed: number; unattributed: number; cost_usd: number;
}
export interface ContentMediaRow { id: string; carousel_index: number; media_kind: string; stored_url: string | null; download_status: string; duration_ms: number | null; bytes: number | null; failure_reason: string | null }
export interface TranscriptRow { id: string; language: string | null; status: string; text: string | null; segments: Array<{ start_ms: number; end_ms: number; text: string }>; duration_ms: number | null }
export interface VisualTextRow { id: string; source: string; frame_ts_ms: number | null; text: string | null; structured: Record<string, unknown> }
export interface ContentEnrichmentRow { primary_project_id: string | null; result: Record<string, unknown>; status: string; candidate_projects: Array<{ projectId: string; nameAr: string | null; nameEn: string | null; confidence: number }> }
export interface ContentAttributionRow { project_id: string; confidence: number; review_status: string; evidence: Record<string, unknown> }
export interface ContentItem {
  id: string; platform: string; external_id: string; post_url: string | null; post_type: string | null;
  caption: string | null; published_at: string | null; thumbnail_ref: string | null;
  processing_status: string; media_count: number; processed_at: string | null; hashtags: string[] | null; engagement: Record<string, number>;
  mkt_content_media: ContentMediaRow[]; mkt_transcripts: TranscriptRow[]; mkt_content_enrichment: ContentEnrichmentRow[];
  mkt_content_attributions: ContentAttributionRow[]; mkt_visual_text: VisualTextRow[];
}
export const fetchContentMetrics = (organization_id?: string) => call<ContentMetrics>('content_metrics', organization_id ? { organization_id } : {});
export const fetchContentItems = (organization_id: string, opts: { page?: number; platform?: string; post_type?: string; processing_status?: string } = {}) =>
  call<{ items: ContentItem[]; total: number; page: number; page_size: number }>('content_items', { organization_id, ...opts });
export const runContentProcessing = (organization_id: string, limit = 50, force = false) =>
  call<{ enqueued: number }>('run_content_processing', { organization_id, limit, force });

// ── Cross-platform campaigns ────────────────────────────────────────────────
export interface Campaign {
  id: string; signature: string; project_id: string | null; label: string | null; manual_label: string | null;
  objective: string | null; platforms: string[]; is_active: boolean; first_seen_at: string | null; last_seen_at: string | null;
  member_count: number; organic_count: number; paid_count: number; offers: string[]; payment_plans: string[]; ctas: string[];
  key_message: string | null; reused_creatives: number; confidence: number; evidence: Record<string, unknown>;
}
export interface CampaignMember {
  id: string; member_type: 'content' | 'ad'; content_post_id: string | null; paid_ad_id: string | null;
  signals: Record<string, unknown>; status: string;
  mkt_content_posts: { platform: string; post_type: string | null; caption: string | null; post_url: string | null; thumbnail_ref: string | null; published_at: string | null } | null;
  mkt_paid_ads: { external_ad_id: string; headline: string | null; cta: string | null; creative_stored_url: string | null; landing_url: string | null } | null;
}
export interface CampaignEvent { kind: string; payload: Record<string, unknown>; at: string }
export const fetchCampaigns = (organization_id: string) => call<{ campaigns: Campaign[] }>('campaigns', { organization_id });
export const fetchCampaignDetail = (campaign_id: string) => call<{ members: CampaignMember[]; events: CampaignEvent[] }>('campaign_detail', { campaign_id });
export const runCampaignGrouping = (organization_id: string) => call<{ job_id: string }>('run_campaign_grouping', { organization_id });
export const campaignCorrect = (op: 'move' | 'status' | 'rename' | 'merge', payload: Record<string, unknown>) => call<{ ok: boolean }>('campaign_correct', { op, ...payload });

export const fetchDiscoveryRuns = (organization_id?: string) => call<{ runs: DiscoveryRun[] }>('discovery_runs', organization_id ? { organization_id } : {});
export const fetchDiscoveryCandidates = (organization_id: string) => call<{ candidates: IdentityCandidate[] }>('discovery_candidates', { organization_id });
export const runOrganizationDiscovery = (organization_id: string) => call<{ job_id: string }>('run_discovery', { organization_id });
export const runAdvertiserDiscovery = (organization_id: string, advertiser: string) => call<{ job_id: string }>('discover_advertiser', { organization_id, advertiser });
export const confirmAdvertiser = (organization_id: string, page_id: string, advertiser?: string) => call<{ ok: boolean }>('confirm_advertiser', { organization_id, page_id, advertiser });
export const rejectCandidate = (organization_id: string, page_id: string) => call<{ ok: boolean; remaining: number }>('reject_candidate', { organization_id, page_id });
export const runAdsPage = (organization_id: string, limit = 25) => call<{ job_id: string }>('run_ads_page', { organization_id, limit });
