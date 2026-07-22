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
