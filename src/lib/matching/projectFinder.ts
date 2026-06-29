/**
 * Browser-side client for /api/project-finder — the DETERMINISTIC, geography
 * boundary-verified Project Finder (Phase 2). Feeds the Follow-up "Suggested
 * Projects" modal's 4 ranked groups. NO LLM is invoked from this path: the modal
 * sends explain:false + parse:false, so selection, scoring, ranking, AND the
 * per-card explanation are all deterministic server code.
 *
 * The Follow-up flow opts into all three sources (our_projects + all_projects +
 * market_listings) so salespeople see the full picture; each card is labelled by
 * source and unverified sources carry a "verify before offering" banner.
 *
 * Types MIRROR api/_lib/projectFinder.ts — keep them in sync.
 */

import { supabase } from '@/lib/supabase';
import type { MatchRequirementsInput } from './requirements';

export type FinderGroupKey =
  | 'exact_district_matches'
  | 'nearby_district_matches'
  | 'same_city_matches'
  | 'broader_fallback';

export const FINDER_GROUP_KEYS: FinderGroupKey[] = [
  'exact_district_matches',
  'nearby_district_matches',
  'same_city_matches',
  'broader_fallback',
];

export type FinderBand = 'strong' | 'good' | 'partial' | 'weak';
export type FinderMatchType = 'exact' | 'nearby' | 'same_city' | 'fallback';
export type FinderSource = 'our_projects' | 'all_projects' | 'market_listings';
export type GeoStatus =
  | 'verified_match'
  | 'verified_derived'
  | 'mismatch'
  | 'outside_known_districts'
  | 'unverified_no_coords'
  | 'no_geography';

export interface FinderMatch {
  project_id: string;
  project_name: string;
  source: FinderSource;
  score: number;
  match_band: FinderBand;
  match_type: FinderMatchType;
  group: FinderGroupKey;
  distance_km: number | null;
  geo_confidence: string | null;
  geo_status: GeoStatus | null;
  data_gaps: string[];
  mismatch_warnings: string[];
  facts: Record<string, unknown>;
  score_breakdown: Record<string, number | null>;
  explanation: string;
}

export interface FinderResponse {
  requirements: MatchRequirementsInput;
  groups: Record<FinderGroupKey, FinderMatch[]>;
  metadata: {
    total_candidates: number;
    req_district_resolved?: boolean;
    district_requested?: boolean;
    counts?: Record<FinderGroupKey, number>;
    source_counts?: Record<FinderSource, number>;
    geo_counts?: Record<string, number>;
    missing_required_preferences: string[];
    /** Market-source status. 'ok' = full filtered set scored; 'needs_district' = pick a
     *  district; 'too_many' = too dense, ask for `suggest`ed criteria (never truncated). */
    market?: { status: 'ok' | 'needs_district' | 'too_many'; count?: number; suggest?: string[] };
    /** True on the no-criteria short-circuit (the UI asks for preferences). */
    needs_preferences?: boolean;
    used_ai_parse?: boolean;
    used_ai_explain?: boolean;
    generated_at: string;
  };
}

export interface FetchFinderArgs {
  requirements: MatchRequirementsInput;
  clientId?: string | null;
  followupId?: string | null;
  perGroup?: number;
  /** Source set. Omit for the default (our_projects + all_projects). market_listings
   *  is opt-in (external/unverified). The Follow-up flow now opts into all three. */
  sources?: FinderSource[];
  /** Language for the deterministic per-card explanation string. */
  locale?: 'ar' | 'en';
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchProjectFinder(
  args: FetchFinderArgs,
  signal?: AbortSignal,
): Promise<FinderResponse> {
  const res = await fetch('/api/project-finder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({
      requirements: args.requirements,
      client_id: args.clientId ?? undefined,
      followup_id: args.followupId ?? undefined,
      perGroup: args.perGroup,
      ...(args.sources ? { sources: args.sources } : {}),
      ...(args.locale ? { locale: args.locale } : {}),
      // Deterministic-only from the Follow-up flow: no LLM parse, no LLM explanation.
      parse: false,
      explain: false,
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `POST /api/project-finder failed (${res.status})`);
  }
  return (await res.json()) as FinderResponse;
}

/** Total matches across all four groups (empty-state check). */
export function totalFinderMatches(resp: FinderResponse | null): number {
  if (!resp) return 0;
  return FINDER_GROUP_KEYS.reduce((n, k) => n + (resp.groups[k]?.length ?? 0), 0);
}
