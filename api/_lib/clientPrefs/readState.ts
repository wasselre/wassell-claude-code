/**
 * Chat auto-read state: the `chat_read_state` row + the unread inbound
 * messages after its watermarks. Shared by the reader (readChat.ts) and the
 * card (card.ts) so both count "unread" the same way — and the same way the
 * SQL candidate scan does (chat_read_candidates in
 * supabase/migrations/2026-09-27_05_chat_read_state.sql):
 *
 *   text-ish      inbound with a non-empty body OR a non-empty transcript
 *   unread        text-ish with date > least(geo_read_through, pref_read_through)
 *                 (a NULL watermark counts as -infinity)
 *   pending       an inbound voice note after the watermarks, < 10 min old, with
 *                 no transcript yet and transcript_status 'pending' (or NULL while
 *                 the media is not known lost)
 *   voice unread  an inbound voice note after last_read_at that has NO usable
 *                 transcript (status none/failed, or the media was lost)
 *
 * Every read error THROWS.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { MAX_WAIT_MS } from './dueSelection.js';

export interface ReadStateRow {
  chat_wid: string;
  client_id: string;
  geo_read_through: string | null;
  pref_read_through: string | null;
  last_read_at: string | null;
  last_trigger: string | null;
  last_outcome: string | null;
  last_error: string | null;
  consecutive_failures: number;
  lease_owner: string | null;
  lease_until: string | null;
  updated_at: string;
}

export interface InboundMsg {
  id: string;
  kind: string | null;
  date: string;
  body: string | null;
  transcript: string | null;
  transcript_status: string | null;
  media_saved: boolean | null;
}

export interface UnreadSummary {
  /** Unread text-ish messages, oldest first (text = body, else the transcript). */
  unread: Array<{ id: string; date: string; text: string }>;
  newestUnreadAt: string | null;
  oldestUnreadAt: string | null;
  pendingTranscripts: number;
  unreadVoiceUntranscribed: number;
}

/** How many inbound messages one read looks at (newest first). A never-read chat's backlog beyond this is still covered by the full-conversation read. */
export const MAX_INBOUND_SCAN = 500;

const trimmed = (v: string | null | undefined): string => (typeof v === 'string' ? v.trim() : '');
const t = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : Number.NEGATIVE_INFINITY);

/** The lower of the two watermarks (a NULL one is -infinity); null ⇒ never read at all. */
export function leastWatermark(state: Pick<ReadStateRow, 'geo_read_through' | 'pref_read_through'> | null): string | null {
  if (!state || !state.geo_read_through || !state.pref_read_through) return null;
  return t(state.geo_read_through) <= t(state.pref_read_through) ? state.geo_read_through : state.pref_read_through;
}

export function isTextIsh(m: Pick<InboundMsg, 'body' | 'transcript'>): boolean {
  return trimmed(m.body) !== '' || trimmed(m.transcript) !== '';
}

/** PURE: summarise the inbound messages against the read state. */
export function summarizeUnread(msgs: readonly InboundMsg[], state: ReadStateRow | null, now: Date): UnreadSummary {
  const wm = t(leastWatermark(state));
  const lastRead = t(state?.last_read_at ?? null);
  const nowMs = now.getTime();
  const sorted = [...msgs].sort((a, b) => t(a.date) - t(b.date));
  const unread: UnreadSummary['unread'] = [];
  let pendingTranscripts = 0;
  let unreadVoiceUntranscribed = 0;
  for (const m of sorted) {
    const at = t(m.date);
    if (isTextIsh(m)) {
      if (at > wm) unread.push({ id: m.id, date: m.date, text: trimmed(m.body) || trimmed(m.transcript) });
      continue;
    }
    if (m.kind !== 'audio') continue;
    if (at > wm && nowMs - at < MAX_WAIT_MS
      && (m.transcript_status === 'pending' || (m.transcript_status == null && m.media_saved !== false))) {
      pendingTranscripts += 1;
    }
    if (at > lastRead && (m.transcript_status === 'none' || m.transcript_status === 'failed' || m.media_saved === false)) {
      unreadVoiceUntranscribed += 1;
    }
  }
  return {
    unread,
    newestUnreadAt: unread.length ? unread[unread.length - 1]!.date : null,
    oldestUnreadAt: unread.length ? unread[0]!.date : null,
    pendingTranscripts,
    unreadVoiceUntranscribed,
  };
}

const STATE_COLS =
  'chat_wid, client_id, geo_read_through, pref_read_through, last_read_at, last_trigger, last_outcome, last_error, consecutive_failures, lease_owner, lease_until, updated_at';

export async function readReadState(sb: SupabaseClient, chatWid: string, clientId: string): Promise<ReadStateRow | null> {
  const { data, error } = await sb
    .from('chat_read_state').select(STATE_COLS)
    .eq('chat_wid', chatWid).eq('client_id', clientId).maybeSingle();
  if (error) throw new Error(`chat read state: read failed: ${error.message}`);
  return (data as ReadStateRow | null) ?? null;
}

/** Inbound messages after `since` (null = all), newest {@link MAX_INBOUND_SCAN}, returned oldest first. */
export async function readInboundSince(sb: SupabaseClient, chatWid: string, since: string | null): Promise<InboundMsg[]> {
  let q = sb
    .from('chat_messages')
    .select('id, kind, date, body, transcript, transcript_status, media_saved')
    .eq('chat_wid', chatWid).eq('flow', 'in');
  if (since) q = q.gt('date', since);
  const { data, error } = await q.order('date', { ascending: false }).limit(MAX_INBOUND_SCAN);
  if (error) throw new Error(`chat read state: chat_messages read failed: ${error.message}`);
  return [...((data ?? []) as InboundMsg[])].reverse();
}

/** The scan start: the earlier of the least watermark and last_read_at (either may be null ⇒ everything). */
export function scanSince(state: ReadStateRow | null): string | null {
  const wm = leastWatermark(state);
  const lr = state?.last_read_at ?? null;
  if (!wm || !lr) return null;
  return t(wm) <= t(lr) ? wm : lr;
}
