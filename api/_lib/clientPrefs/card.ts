/**
 * The preference half of the in-chat card: the newest preference proposal for
 * this (chat, client), the auto-read state, what is still unread, the client's
 * current preference values, and the CALL AUDIT's proposals for the client
 * (pending, plus the ones decided in the last 24 h so the rep sees the result
 * once). Every read error THROWS — the card must never show "nothing here"
 * because a query failed.
 *
 * The chat `proposal` is filtered by chat_wid = this chat's wid, which a call
 * proposal (chat_wid = 'call:<id>') can never match — so it stays chat-only.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { readReadState, readInboundSince, summarizeUnread, scanSince, type ReadStateRow } from './readState.js';
import { pickPrefValues } from './extractChatPrefs.js';
import type { PrefSuggestion } from '../prefExtract.js';

export interface PrefsCardProposal {
  id: string;
  version: number;
  status: 'pending' | 'saved' | 'dismissed' | 'superseded';
  suggestions: Record<string, PrefSuggestion>;
  current_values: Record<string, unknown>;
  model: string;
  created_at: string;
  decided_at: string | null;
  saved_fields: string[] | null;
}

/** A call-audit proposal as the card shows it. */
export interface PrefsCardCallProposal {
  id: string;
  version: number;
  status: 'pending' | 'saved' | 'dismissed' | 'superseded';
  call_id: string | null;
  call_at: string | null;
  suggestions: Record<string, PrefSuggestion>;
  /** FRESH from the client now, only this proposal's slugs — a non-empty one was logged since the call. */
  current_values: Record<string, unknown>;
  created_at: string;
  decided_at: string | null;
  saved_fields: string[] | null;
}

/** How long a decided call proposal stays on the card (so saved / dismissed shows once). */
export const CALL_PROPOSAL_DECIDED_VISIBLE_MS = 24 * 60 * 60 * 1000;
const MAX_CALL_PROPOSALS = 20;

export interface PrefsCard {
  proposal: PrefsCardProposal | null;
  /** The call audit's proposals for this client, newest first. */
  call_proposals: PrefsCardCallProposal[];
  read_state: Pick<ReadStateRow, 'last_read_at' | 'last_trigger' | 'last_outcome' | 'last_error' | 'geo_read_through' | 'pref_read_through'> | null;
  /** Customer text messages (incl. transcribed voice notes) not read yet. */
  unread_customer_messages: number;
  /** Voice notes whose transcript is still on its way. */
  pending_transcripts: number;
  /** Voice notes since the last read that could NOT be transcribed — a rep must listen. */
  unread_voice_notes: number;
  /** The client's saved preference values right now. */
  current_values: Record<string, unknown>;
}

export async function loadPrefsCard(
  sb: SupabaseClient, clientId: string, chatWid: string, opts: { now?: () => Date } = {},
): Promise<PrefsCard> {
  const now = (opts.now ?? (() => new Date()))();
  const decidedSince = new Date(now.getTime() - CALL_PROPOSAL_DECIDED_VISIBLE_MS).toISOString();
  const [propRes, callRes, state, clientRes] = await Promise.all([
    sb.from('client_pref_proposals')
      .select('id, version, status, suggestions, current_values, model, created_at, decided_at, saved_fields')
      .eq('chat_wid', chatWid).eq('client_id', clientId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    sb.from('client_pref_proposals')
      .select('id, version, status, call_id, call_at, suggestions, created_at, decided_at, saved_fields')
      .eq('client_id', clientId).eq('source', 'call')
      .or(`status.eq.pending,and(status.in.(saved,dismissed),decided_at.gte."${decidedSince}")`)
      .order('created_at', { ascending: false }).limit(MAX_CALL_PROPOSALS),
    readReadState(sb, chatWid, clientId),
    sb.from('records').select('data').eq('id', clientId).maybeSingle(),
  ]);
  if (propRes.error) throw new Error(`prefs card: proposal read failed: ${propRes.error.message}`);
  if (callRes.error) throw new Error(`prefs card: call proposals read failed: ${callRes.error.message}`);
  if (clientRes.error) throw new Error(`prefs card: client read failed: ${clientRes.error.message}`);
  // A missing client (deleted after the chat was linked) shows "nothing saved", not an error:
  // the geography half of the card must still load.
  const current_values = pickPrefValues((clientRes.data?.data as Record<string, unknown> | null) ?? null);
  const summary = summarizeUnread(await readInboundSince(sb, chatWid, scanSince(state)), state, now);
  return {
    proposal: (propRes.data as PrefsCardProposal | null) ?? null,
    call_proposals: shapeCallProposals(
      (callRes.data ?? []) as Array<Omit<PrefsCardCallProposal, 'current_values'>>, current_values,
    ),
    read_state: state
      ? {
          last_read_at: state.last_read_at, last_trigger: state.last_trigger, last_outcome: state.last_outcome,
          last_error: state.last_error, geo_read_through: state.geo_read_through, pref_read_through: state.pref_read_through,
        }
      : null,
    unread_customer_messages: summary.unread.length,
    pending_transcripts: summary.pendingTranscripts,
    unread_voice_notes: summary.unreadVoiceUntranscribed,
    current_values,
  };
}

/** PURE: attach each call proposal's FRESH current values (its own slugs only). */
export function shapeCallProposals(
  rows: ReadonlyArray<Omit<PrefsCardCallProposal, 'current_values'>>,
  current: Record<string, unknown>,
): PrefsCardCallProposal[] {
  return rows.map((r) => ({
    ...r,
    current_values: Object.fromEntries(Object.keys(r.suggestions ?? {}).map((slug) => [slug, current[slug] ?? null])),
  }));
}
