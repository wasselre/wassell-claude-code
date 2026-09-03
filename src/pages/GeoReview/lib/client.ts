/**
 * Browser-side client for the Geography-preference review surface.
 *
 *   fetchProposals()        → GET  /api/geo-preference/proposals  (open review queue)
 *   submitReview(input)     → POST /api/geo-preference/review     (confirm|edit|reject|must_confirm)
 *
 * The confirm/edit path is the only sanctioned write to a client's location
 * preferences and it is server-side + audited; this module just relays the
 * reviewer's decision with their Supabase JWT attached.
 */
import { supabase } from '@/lib/supabase';
import type { GeoPreferenceDTO, ProposalView, ReviewAction, ReviewOutcome } from './types';

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchProposals(): Promise<ProposalView[]> {
  const res = await fetch('/api/geo-preference/proposals', {
    method: 'GET',
    headers: { ...(await authHeader()) },
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(b?.error ?? `failed to load review queue (${res.status})`);
  }
  const j = (await res.json()) as { proposals?: ProposalView[] };
  return j.proposals ?? [];
}

export interface SubmitReviewInput {
  proposalId: string;
  action: ReviewAction;
  note?: string | null;
  finalExpression?: GeoPreferenceDTO | null;
  expectedVersion?: number | null;
}

export async function submitReview(input: SubmitReviewInput): Promise<ReviewOutcome> {
  const res = await fetch('/api/geo-preference/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(b?.error ?? `review action failed (${res.status})`);
  }
  return (await res.json()) as ReviewOutcome;
}
