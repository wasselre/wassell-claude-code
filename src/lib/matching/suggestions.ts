/**
 * Browser-side client for /api/suggest-projects — the DETERMINISTIC grouped
 * recommendation endpoint (no LLM). Feeds the "Suggested Projects" modal's
 * grouped cards. The modal's chat pane still uses streamMatchTurn (/api/match)
 * for narration/pitch/compare.
 *
 * The types below MIRROR api/_lib/suggestGroups.ts — keep them in sync (same
 * convention as recommendation.ts mirroring the emit_recommendation shape).
 */

import { supabase } from '@/lib/supabase';
import type { MatchRequirementsInput } from './requirements';

export type SuggestionGroupKey =
  | 'exact_matches'
  | 'nearby_alternatives'
  | 'budget_matches'
  | 'location_matches'
  | 'fallback_matches';

export const SUGGESTION_GROUP_KEYS: SuggestionGroupKey[] = [
  'exact_matches',
  'nearby_alternatives',
  'budget_matches',
  'location_matches',
  'fallback_matches',
];

export type DataConfidence = 'high' | 'medium' | 'low';
export type BudgetFit = 'within' | 'above' | 'below' | 'unknown';
export type MatchBand = 'strong' | 'good' | 'partial';
export type MatchType = 'exact' | 'nearby' | 'same_city' | 'stretch' | 'partial';

export type DataGapCode =
  | 'missing_price_range'
  | 'missing_unit_types'
  | 'missing_area_range'
  | 'missing_bedroom_range'
  | 'missing_unit_inventory'
  | 'missing_project_coordinates'
  | 'legacy_text_match_only'
  | 'requires_verification';

export type ReasonCode =
  | 'exact_district'
  | 'exact_within_budget'
  | 'nearby_distance'
  | 'budget_fit'
  | 'strong_location_no_price'
  | 'strong_location_over_budget'
  | 'fallback_verify'
  | 'fallback_weak'
  | 'no_criteria';

export type MatchSource = 'our_projects' | 'all_projects' | 'market_listings';

export interface SuggestionItem {
  project_id: string;
  project_name: string;
  data_source: MatchSource;
  requires_verification: boolean;
  score: number;
  match_band: MatchBand;
  match_type: MatchType;
  group: SuggestionGroupKey;
  data_confidence: DataConfidence;
  data_gaps: DataGapCode[];
  distance_km: number | null;
  distance_basis: 'district_centroid' | null;
  budget_fit: BudgetFit;
  reason_code: ReasonCode;
  sales_reason: string;
  facts: Record<string, unknown>;
  score_breakdown: Record<string, number | null>;
  verification_warning?: string;
}

export interface SuggestionsResponse {
  client_preferences_summary: {
    requirements: MatchRequirementsInput;
    missing_required_preferences: string[];
  };
  groups: Record<SuggestionGroupKey, SuggestionItem[]>;
  metadata: {
    total_candidates: number;
    used_fallback: boolean;
    used_legacy_fallback: boolean;
    used_draft_values: boolean;
    req_district_resolved: boolean;
    /** Present on the criteria path; absent on the no-criteria short-circuit. */
    has_criteria?: boolean;
    /** True on the no-criteria short-circuit (the UI asks for preferences). */
    needs_preferences?: boolean;
    counts: Record<SuggestionGroupKey, number>;
    /** How many SHOWN results came from each source (drives the source filter). */
    source_counts?: Record<MatchSource, number>;
    generated_at: string;
  };
}

export interface FetchSuggestionsArgs {
  requirements: MatchRequirementsInput;
  clientId?: string | null;
  followupId?: string | null;
  usedDraftValues?: boolean;
  perGroup?: number;
  /** Bilingual W6: UI language → geography names on the result cards. */
  locale?: 'ar' | 'en';
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchSuggestedProjects(
  args: FetchSuggestionsArgs,
  signal?: AbortSignal,
): Promise<SuggestionsResponse> {
  const res = await fetch('/api/suggest-projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({
      requirements: args.requirements,
      client_id: args.clientId ?? undefined,
      followup_id: args.followupId ?? undefined,
      used_draft_values: args.usedDraftValues ?? false,
      perGroup: args.perGroup,
      locale: args.locale,
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `POST /api/suggest-projects failed (${res.status})`);
  }
  return (await res.json()) as SuggestionsResponse;
}

/** Total count across all groups (for the empty-state check). */
export function totalSuggestions(resp: SuggestionsResponse | null): number {
  if (!resp) return 0;
  return SUGGESTION_GROUP_KEYS.reduce((n, k) => n + (resp.groups[k]?.length ?? 0), 0);
}
