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
