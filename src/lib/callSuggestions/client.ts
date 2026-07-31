// callSuggestions — the rep-facing half of the AI call-result lane.
//
// A rep finishes a call and moves on WITHOUT completing the task. Seconds later
// the Fly worker reads the transcript, proposes an outcome, and flips a
// `call_result_suggestions` row to 'ready'. This module is how the SPA learns
// about that row and records what the rep decided.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO
//   It never writes `call_result` on the follow-up. `confirmSuggestion` only
//   records the rep's decision on the suggestion row; the follow-up itself is
//   completed through the app's existing completion path so the outcome
//   workflows fire exactly once, from one place. Two write paths is how a
//   client gets moved through the pipeline twice.
//
// RLS scopes every read to `rep_user_id = wassell_app_user_id(auth.uid())`, so
// a rep can only ever see their own suggestions — the filters below are for
// efficiency and correctness of the UI, not for security.

import { supabase } from '@/lib/supabase';

/** Fields the model prefills for the rep to edit before confirming. */
export interface SuggestedFields {
  outcome_notes?: string;
  reschedule_contact_date?: string;
  new_appointment_datetime?: string;
  lost_reason?: string;
}

export interface CallResultSuggestion {
  id: string;
  call_record_id: string;
  call_log_id: string | null;
  client_id: string | null;
  rep_user_id: string | null;
  followup_id: string | null;
  followup_type: string | null;
  kind: 'confirm_followup' | 'log_interaction';
  status: 'queued' | 'running' | 'ready' | 'confirmed' | 'failed' | 'cancelled';
  suggested_outcome: string | null;
  confidence: number | null;
  reasoning: string | null;
  summary: string | null;
  suggested_fields: SuggestedFields;
  /** The customer's own words a proposed date was resolved from. */
  quoted_phrase: string | null;
  model: string | null;
  source: 'deepseek' | 'deterministic' | null;
  created_at: string;
}

const COLUMNS =
  'id, call_record_id, call_log_id, client_id, rep_user_id, followup_id, followup_type, ' +
  'kind, status, suggested_outcome, confidence, reasoning, summary, suggested_fields, ' +
  'quoted_phrase, model, source, created_at';

/**
 * How far back a suggestion stays worth surfacing.
 *
 * The popup is a memory aid — "you just called this person, what happened?".
 * A suggestion from three days ago has lost the thing that makes it useful, and
 * showing a backlog of them on the first load after a deploy would ambush the
 * rep with a stack of popups for calls they can no longer remember. Anything
 * older is left in `ready` for reporting and simply never shown.
 */
export const SUGGESTION_FRESHNESS_HOURS = 12;

function freshnessCutoffIso(): string {
  return new Date(Date.now() - SUGGESTION_FRESHNESS_HOURS * 3600_000).toISOString();
}

function normalize(row: Record<string, unknown>): CallResultSuggestion {
  const fields = row.suggested_fields;
  return {
    ...(row as unknown as CallResultSuggestion),
    suggested_fields:
      fields && typeof fields === 'object' && !Array.isArray(fields)
        ? (fields as SuggestedFields)
        : {},
  };
}

/** This rep's pending confirmations, oldest first (they queue one at a time). */
export async function listPendingSuggestions(): Promise<CallResultSuggestion[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('call_result_suggestions')
    .select(COLUMNS)
    .eq('status', 'ready')
    .gte('created_at', freshnessCutoffIso())
    .order('created_at', { ascending: true })
    .limit(20);
  if (error) {
    // Loud, not silent: if the rep's pending confirmations can't be read they
    // will silently stop completing tasks, and nobody would know why.
    console.error('[callSuggestions] failed to load pending suggestions:', error.message);
    throw new Error(error.message);
  }
  return (data ?? []).map((r) => normalize(r as unknown as Record<string, unknown>));
}

/**
 * Live updates for this rep. RLS already restricts rows to them, so no filter
 * is needed on the channel — and adding one keyed on rep_user_id would silently
 * deliver nothing if the id ever drifted from `wassell_app_user_id`.
 */
export function subscribeToSuggestions(onChange: () => void): () => void {
  const client = supabase;
  if (!client) return () => { /* offline mode — nothing to subscribe to */ };
  const channel = client
    .channel('call_result_suggestions:mine')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'call_result_suggestions' },
      () => onChange(),
    )
    .subscribe();
  return () => { void client.removeChannel(channel); };
}

/**
 * Record what the rep chose. Returns false when the row was already confirmed,
 * cancelled, or belongs to someone else — the RPC checks ownership server-side.
 */
export async function confirmSuggestion(
  id: string,
  outcome: string,
  fields: Record<string, unknown>,
): Promise<boolean> {
  if (!supabase) return false;
  const { data, error } = await supabase.rpc('call_result_suggestion_confirm', {
    p_id: id,
    p_outcome: outcome,
    p_fields: fields ?? {},
  });
  if (error) {
    console.error('[callSuggestions] confirm failed:', error.message);
    throw new Error(error.message);
  }
  return data === true;
}

/**
 * Retire pending suggestions for a follow-up the rep completed by hand.
 *
 * Without this, completing a task in the Workspace would leave its AI
 * suggestion sitting in `ready` and pop it up afterwards, asking the rep to
 * confirm an outcome they had already recorded themselves.
 */
export async function cancelSuggestionsForFollowup(followupId: string): Promise<number> {
  if (!supabase || !followupId) return 0;
  const { data, error } = await supabase.rpc('call_result_suggestion_cancel_for_followup', {
    p_followup_id: followupId,
  });
  if (error) {
    console.error('[callSuggestions] cancel failed:', error.message);
    return 0;
  }
  return typeof data === 'number' ? data : 0;
}

/**
 * Best-effort "is this rep on a call right now?".
 *
 * MEASURED CAVEAT (2026-07-30): `call_logs.status='active'` is NOT a clean live
 * signal. Hatif does not reliably send a terminal update, so the table holds
 * stale corpses — 73 `ringing` rows averaging 807 hours old, 66 of them older
 * than a week, and zero of any age created in the last 10 minutes. A bare
 * status check would therefore hold the popup forever.
 *
 * Hence the tight recency bound, and hence FAIL-OPEN: any error, or any doubt,
 * returns false and the popup shows. Holding a confirmation the rep never sees
 * is worse than showing one a moment too early.
 *
 * The rep is matched through the client (contact_phone → client → client_owner)
 * because `call_logs.agent_user_id` carries HATIF's user id and joins to zero
 * rows in public.users — see 2026-07-30_call_result_suggestions_route_by_task_owner.
 */
export async function isRepOnLiveCall(repUserId: string | null): Promise<boolean> {
  if (!supabase || !repUserId) return false;
  try {
    const since = new Date(Date.now() - 20 * 60_000).toISOString();
    const { data, error } = await supabase
      .from('call_logs')
      .select('id, contact_phone')
      .in('status', ['active', 'ringing'])
      .gte('creation_time', since)
      .limit(5);
    if (error || !data || data.length === 0) return false;
    // A live call exists somewhere in the company; only hold if it belongs to
    // one of THIS rep's clients.
    const phones = data.map((r) => r.contact_phone).filter(Boolean) as string[];
    if (phones.length === 0) return false;
    const { data: owned, error: ownErr } = await supabase.rpc('wassell_rep_owns_any_phone', {
      p_rep: repUserId,
      p_phones: phones,
    });
    if (ownErr) return false;          // helper absent or errored → fail open
    return owned === true;
  } catch {
    // Fail open — see the note above. Never trap a confirmation behind a
    // signal we already know to be unreliable.
    return false;
  }
}
