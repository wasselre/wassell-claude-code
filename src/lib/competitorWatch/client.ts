// Client for the Competitor Watch workspace.
// Thin, bearer-attached; talks to the shared /api/marketing dispatch endpoint
// (the data layer is reused; the UI is a separate, new module).
import { supabase } from '@/lib/supabase';

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** One assembled Content Library entry — the labels the enrichment AI already
 *  computed, gathered from mkt_content_posts + mkt_content_enrichment + transcripts. */
export interface LibraryRow {
  id: string;
  org_name: string | null;
  organization_id: string | null;
  platform: string | null;
  format: string | null;        // post_type: image / video / reel / carousel
  shelf: string | null;         // content_type (the "purpose" shelf)
  summary: string | null;       // campaign message, else caption head
  caption: string | null;
  selling_points: string[] | null;
  unit_types: string[] | null;
  amenities: string[] | null;
  ctas: string[] | null;
  offer: string | null;
  price: string | null;
  payment_plan: string | null;
  district: string | null;
  engagement: Record<string, number> | null;
  published_at: string | null;
  post_url: string | null;
  is_video: boolean;
  has_transcript: boolean;
  project_name: string | null;
  developer_record_id: string | null;              // publisher org's `developers` record (null for marketers)
  thumb_url: string | null;                         // best poster / first image
  media: Array<{ kind: string; url: string }> | null; // every stored image/video
}

export interface LibraryResult {
  total: number;
  shelves: Record<string, number>;   // purpose facet counts
  rows: LibraryRow[];
}

export interface LibraryFilters {
  shelf?: string | null;
  org?: string | null;
  format?: string | null;
  platform?: string | null;
  has_offer?: boolean | null;
  q?: string | null;
  limit?: number;
  offset?: number;
}

export async function fetchContentLibrary(f: LibraryFilters = {}): Promise<LibraryResult> {
  const res = await fetch('/api/marketing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action: 'content_library', ...f }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b?.error ?? `content_library failed (${res.status})`);
  }
  const j = (await res.json()) as { library: LibraryResult };
  return j.library;
}

// ── Monitoring surfaces (Agents / Pipeline / Storage / Companies) ──────────
async function callAction<T>(action: string, field: string): Promise<T> {
  const res = await fetch('/api/marketing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b?.error ?? `${action} failed (${res.status})`);
  }
  const j = (await res.json()) as Record<string, unknown>;
  return j[field] as T;
}

export interface AgentActivity {
  collection: {
    paused: boolean; enabled_accounts: number; total_accounts: number;
    runs_today: number; received_today: number; inserted_today: number;
    last_activity: string | null; daily: Array<{ day: string; inserted: number }>;
  };
  understanding: { processed_24h: number; queued: number; all_time: number };
  discovery: { last_run: string | null; runs: number; confirmed: number };
  runs: Array<{ provider: string | null; platform: string | null; handle: string | null; received: number | null; inserted: number | null; started_at: string; status: string }>;
}
export interface PipelineHealth {
  collected: number; media_stored: number; media_failed: number; ocr_done: number;
  transcribed: number; enriched: number; facts: number; attributed: number;
  by_status: Record<string, number>;
}
export interface StorageUsage {
  media_bytes: number; media_rows: number; raw_asset_bytes: number;
  by_kind: Record<string, { count: number; bytes: number }>;
  by_company: Array<{ org: string | null; files: number; bytes: number }>;
}
export interface CompanyAccount {
  platform: string | null; handle: string | null; followers: number | null;
  enabled: boolean; last_pull: string | null; posts: number | null;
}
export interface CompanyRow {
  id: string; name: string | null; org_type: string | null; facts: number;
  accounts: number; posts: number; followers: number; last_pull: string | null;
  account_list: CompanyAccount[];
}
export interface CompanyRoster { companies: CompanyRow[]; }

export const fetchAgentActivity = () => callAction<AgentActivity>('agent_activity', 'activity');
export const fetchPipelineHealth = () => callAction<PipelineHealth>('pipeline_health', 'pipeline');
export const fetchStorageUsage = () => callAction<StorageUsage>('storage_usage', 'storage');
export const fetchCompanyRoster = () => callAction<CompanyRoster>('company_roster', 'roster');
