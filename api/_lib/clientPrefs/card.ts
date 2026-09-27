/**
 * The preference half of the in-chat card: the newest preference proposal for
 * this (chat, client), the auto-read state, what is still unread, and the
 * client's current preference values. Every read error THROWS — the card must
 * never show "nothing here" because a query failed.
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

export interface PrefsCard {
  proposal: PrefsCardProposal | null;
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
  const [propRes, state, clientRes] = await Promise.all([
    sb.from('client_pref_proposals')
      .select('id, version, status, suggestions, current_values, model, created_at, decided_at, saved_fields')
      .eq('chat_wid', chatWid).eq('client_id', clientId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    readReadState(sb, chatWid, clientId),
    sb.from('records').select('data').eq('id', clientId).maybeSingle(),
  ]);
  if (propRes.error) throw new Error(`prefs card: proposal read failed: ${propRes.error.message}`);
  if (clientRes.error) throw new Error(`prefs card: client read failed: ${clientRes.error.message}`);
  // A missing client (deleted after the chat was linked) shows "nothing saved", not an error:
  // the geography half of the card must still load.
  const current_values = pickPrefValues((clientRes.data?.data as Record<string, unknown> | null) ?? null);
  const summary = summarizeUnread(await readInboundSince(sb, chatWid, scanSince(state)), state, now);
  return {
    proposal: (propRes.data as PrefsCardProposal | null) ?? null,
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
