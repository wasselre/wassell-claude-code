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
