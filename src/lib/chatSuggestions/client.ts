// chatSuggestions — the rep-facing half of the AI chat-outcome lane.
//
// A client writes on WhatsApp; the Fly worker reads the conversation and
// proposes the outcome of the client's open follow-up, flipping a
// `chat_outcome_suggestions` row to 'ready'. The chat's task bar shows it; the
// rep confirms (the follow-up is then completed through the normal completion
// path, so the outcome workflows fire once, from one place) or dismisses it.
//
// Like callSuggestions, this module never writes `call_result` on a follow-up.
// It only reads proposals and records the rep's decision on them.
//
// RLS: anyone who can see the client can see its proposals (records-table
// policies decide), and may flip a READY row to confirmed/dismissed.

import { supabase } from '@/lib/supabase';

export interface ChatOutcomeSuggestion {
  id: string;
  client_id: string;
  chat_wid: string | null;
  followup_id: string | null;
  followup_type: string | null;
  status: string;
  suggested_outcome: string | null;
  confidence: number | null;
  reasoning: string | null;
  summary: string | null;
  suggested_fields: Record<string, string>;
  quoted_phrase: string | null;
  created_at: string;
  /** The chat the reading came from (`/model/chats/<id>`). */
  chat_record_id: string | null;
  /** The client's main project the AI chose (a positive outcome only). */
  suggested_main_project_id: string | null;
  suggested_main_project_name: string | null;
}

const COLUMNS =
  'id, client_id, chat_wid, followup_id, followup_type, status, suggested_outcome, ' +
  'confidence, reasoning, summary, suggested_fields, quoted_phrase, created_at, ' +
  'chat_record_id, suggested_main_project_id, suggested_main_project_name';

function normalize(row: Record<string, unknown>): ChatOutcomeSuggestion {
  const f = row.suggested_fields;
  return {
    ...(row as unknown as ChatOutcomeSuggestion),
    suggested_fields: f && typeof f === 'object' && !Array.isArray(f) ? (f as Record<string, string>) : {},
  };
}

/** The client's newest live proposal, or null. */
export async function fetchReadyChatSuggestion(clientId: string): Promise<ChatOutcomeSuggestion | null> {
  if (!supabase || !clientId) return null;
  const { data, error } = await supabase
    .from('chat_outcome_suggestions')
    .select(COLUMNS)
    .eq('client_id', clientId)
    .eq('status', 'ready')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    // Loud: a silent failure here means reps quietly stop seeing suggestions.
    console.error('[chatSuggestions] failed to load suggestion:', error.message);
    throw new Error(error.message);
  }
  return data ? normalize(data as unknown as Record<string, unknown>) : null;
}

/**
 * Every live proposal the caller can see, oldest first — the Work Queue's AI
 * tab lists them for approval. Pages past PostgREST's 1,000-row cap.
 */
export async function fetchAllReadyChatSuggestions(): Promise<ChatOutcomeSuggestion[]> {
  if (!supabase) return [];
  const out: ChatOutcomeSuggestion[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('chat_outcome_suggestions')
      .select(COLUMNS)
      .eq('status', 'ready')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) {
      console.error('[chatSuggestions] failed to load suggestions:', error.message);
      throw new Error(error.message);
    }
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    out.push(...rows.map(normalize));
    if (rows.length < 1000) return out;
  }
}

/** Live updates for one client's proposals. */
export function subscribeChatSuggestions(clientId: string, onChange: () => void): () => void {
  const client = supabase;
  if (!client || !clientId) return () => { /* offline mode — nothing to subscribe to */ };
  const channel = client
    .channel(`chat_outcome_suggestions:${clientId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'chat_outcome_suggestions', filter: `client_id=eq.${clientId}` },
      () => onChange(),
    )
    .subscribe();
  return () => { void client.removeChannel(channel); };
}

/**
 * Record the rep's decision. Returns false when the row is no longer 'ready'
 * (someone else acted on it, or a newer reading superseded it).
 */
export async function resolveChatSuggestion(
  id: string,
  action: 'confirmed' | 'dismissed',
  outcome?: string | null,
  fields?: Record<string, unknown>,
): Promise<boolean> {
  if (!supabase) return false;
  const { data, error } = await supabase.rpc('chat_outcome_suggestion_resolve', {
    p_id: id,
    p_action: action,
    p_outcome: outcome ?? null,
    p_fields: fields ?? null,
  });
  if (error) {
    console.error('[chatSuggestions] resolve failed:', error.message);
    throw new Error(error.message);
  }
  return data === true;
}
