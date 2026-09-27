/**
 * The chat auto-read's PREFERENCE agent: one WhatsApp conversation → at most
 * one pending `client_pref_proposals` row.
 *
 *   renderConversation → extractPreferences(channel 'chat') → drop districts
 *   (geography is the geo pipeline's) → nothing found? return null (the read
 *   still counts) → snapshot the client's current pref values → supersede the
 *   older pending proposal of this (chat, client) → insert the new one → link
 *   the superseded rows to it.
 *
 * NEVER writes the client record — the rep's tick + save in the card does
 * (POST /api/client-prefs/review). Every read/write error THROWS; a failed
 * insert puts the proposals it just superseded back to pending first.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Conversation } from '../geoPreference/extractor.js';
import { renderConversation } from '../geoPreference/extractor.js';
import { extractPreferences, PREF_EXTRACTOR_VERSION, type PreferenceExtraction } from '../prefExtract.js';
import { PREF_FIELD_KINDS } from '../../../src/lib/clientPrefs/mergePrefs.js';
import type { ReadTrigger } from './readChat.js';

export interface ExtractChatPrefsInput {
  clientId: string;
  chatWid: string;
  conversation: Conversation;
  trigger: ReadTrigger;
  /** Newest unread customer message the read covers (null ⇒ the conversation's newest customer turn). */
  watermark: string | null;
  log?: (msg: string) => void;
  /** Injected extractor (tests). */
  extract?: typeof extractPreferences;
}

export interface ExtractChatPrefsResult {
  proposalId: string | null;
  fieldCount: number;
  model: string;
  isFallback: boolean;
}

/** The pref slugs of a client's data (absent ⇒ null), for the proposal's before-snapshot. */
export function pickPrefValues(data: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const slug of Object.keys(PREF_FIELD_KINDS)) out[slug] = data?.[slug] ?? null;
  return out;
}

/** The client's current pref values (records row). Throws on a read error or a missing client. */
export async function readClientPrefValues(sb: SupabaseClient, clientId: string): Promise<Record<string, unknown>> {
  const { data, error } = await sb.from('records').select('data').eq('id', clientId).maybeSingle();
  if (error) throw new Error(`client prefs: client read failed: ${error.message}`);
  if (!data) throw new Error(`client prefs: client ${clientId} not found`);
  return pickPrefValues(data.data as Record<string, unknown> | null);
}

function newestClientTurnAt(conversation: Conversation): string | null {
  const stamps = conversation.turns.filter((t) => t.speaker === 'client' && t.timestamp).map((t) => t.timestamp!).sort();
  return stamps.length ? stamps[stamps.length - 1]! : null;
}

export async function extractChatPrefs(sb: SupabaseClient, input: ExtractChatPrefsInput): Promise<ExtractChatPrefsResult> {
  const log = input.log ?? (() => {});
  const extract = input.extract ?? extractPreferences;
  const rendered = renderConversation(input.conversation);
  const res: PreferenceExtraction = await extract({
    channel: 'chat',
    transcript: rendered,
    entity: { kind: 'client', id: input.clientId },
  });
  // Geography belongs to the geo pipeline — districts are parsed but dropped here.
  const suggestions = res.output.suggestions;
  const fieldCount = Object.keys(suggestions).length;
  if (fieldCount === 0) {
    log(`[chat-prefs] client=${input.clientId} chat=${input.chatWid} model=${res.model} — no preferences mentioned`);
    return { proposalId: null, fieldCount: 0, model: res.model, isFallback: res.isFallback };
  }

  const currentValues = await readClientPrefValues(sb, input.clientId);

  const { data: open, error: openErr } = await sb
    .from('client_pref_proposals').select('id')
    .eq('chat_wid', input.chatWid).eq('client_id', input.clientId).eq('status', 'pending');
  if (openErr) throw new Error(`client prefs: pending proposals read failed: ${openErr.message}`);
  const older = ((open ?? []) as Array<{ id: string }>).map((r) => r.id);

  if (older.length) {
    const { error } = await sb
      .from('client_pref_proposals').update({ status: 'superseded' })
      .in('id', older).eq('status', 'pending');
    if (error) throw new Error(`client prefs: superseding older proposals failed: ${error.message}`);
  }

  const watermark = input.watermark ?? newestClientTurnAt(input.conversation) ?? new Date().toISOString();
  const { data: inserted, error: insErr } = await sb
    .from('client_pref_proposals')
    .insert({
      client_id: input.clientId,
      chat_wid: input.chatWid,
      suggestions,
      current_values: currentValues,
      status: 'pending',
      source_watermark: watermark,
      source_message_count: input.conversation.turns.length,
      extractor_version: PREF_EXTRACTOR_VERSION,
      model: res.model,
      is_fallback: res.isFallback,
      trigger: input.trigger,
    })
    .select('id').single();
  if (insErr || !inserted) {
    const msg = insErr?.message ?? 'no row returned';
    if (older.length) {
      const { error: restoreErr } = await sb
        .from('client_pref_proposals').update({ status: 'pending', superseded_by: null })
        .in('id', older).eq('status', 'superseded');
      if (restoreErr) {
        console.error('[chat-prefs] restoring superseded proposals after a failed insert also failed:', restoreErr.message);
        throw new Error(`client prefs: insert failed: ${msg} (and restoring ${older.join(', ')} to pending failed: ${restoreErr.message})`);
      }
    }
    throw new Error(`client prefs: insert failed: ${msg}`);
  }
  const proposalId = inserted.id as string;

  if (older.length) {
    const { error } = await sb
      .from('client_pref_proposals').update({ superseded_by: proposalId })
      .in('id', older).eq('status', 'superseded');
    if (error) throw new Error(`client prefs: linking superseded proposals failed: ${error.message}`);
  }

  log(`[chat-prefs] client=${input.clientId} chat=${input.chatWid} model=${res.model}${res.isFallback ? ' (fallback)' : ''} fields=${fieldCount} proposal=${proposalId} superseded=${older.length}`);
  return { proposalId, fieldCount, model: res.model, isFallback: res.isFallback };
}
