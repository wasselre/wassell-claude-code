/**
 * The preference half of the in-chat card: the newest preference proposal for
 * this (chat, client), the auto-read state, what is still unread, the client's
 * current preference values, and the CALL AUDIT's proposals for the client —
 * preferences (`call_proposals`) and places (`call_geo`) — pending, plus the
 * ones decided in the last 24 h so the rep sees the result once. Every read
 * error THROWS — the card must never show "nothing here" because a query failed.
 *
 * The chat `proposal` is filtered by chat_wid = this chat's wid, which a call
 * proposal (chat_wid = 'call:<id>') can never match — so it stays chat-only.
 *
 * `call_geo` lists ONLY geo proposals the call audit minted
 * (`call_pref_audit.geo_proposal_id`) — never the older calibration proposals
 * that exist on some calls and that nobody asked for.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { readReadState, readInboundSince, summarizeUnread, scanSince, type ReadStateRow } from './readState.js';
import { pickPrefValues } from './extractChatPrefs.js';
import type { PrefSuggestion } from '../prefExtract.js';
import { loadChatCard, type ChatCard } from '../geoPreference/chatCard.js';
import { clientHasPlaces } from './callAudit.js';

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

/** The places the call audit proposed from ONE call. */
export interface PrefsCardCallGeo {
  call_id: string;
  /** call_logs.hangup_time (null when the log row is gone). */
  call_at: string | null;
  /** The geo proposal the audit minted — `card.proposal` is shown only when it IS this one. */
  proposal_id: string;
  /** The geography card for the call (loadChatCard with the call id as the conversation). */
  card: ChatCard;
  /** FRESH: the client has places now ⇒ the save is refused (fill-empty-only), so confirm is disabled. */
  has_places: boolean;
}

/** How long a decided call proposal stays on the card (so saved / dismissed shows once). */
export const CALL_PROPOSAL_DECIDED_VISIBLE_MS = 24 * 60 * 60 * 1000;
const MAX_CALL_PROPOSALS = 20;

export interface PrefsCard {
  proposal: PrefsCardProposal | null;
  /** The call audit's preference proposals for this client, newest first. */
  call_proposals: PrefsCardCallProposal[];
  /** The call audit's place proposals for this client, newest call first. */
  call_geo: PrefsCardCallGeo[];
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
  const [propRes, callRes, auditRes, state, clientRes] = await Promise.all([
    sb.from('client_pref_proposals')
      .select('id, version, status, suggestions, current_values, model, created_at, decided_at, saved_fields')
      .eq('chat_wid', chatWid).eq('client_id', clientId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    sb.from('client_pref_proposals')
      .select('id, version, status, call_id, call_at, suggestions, created_at, decided_at, saved_fields')
      .eq('client_id', clientId).eq('source', 'call')
      .or(`status.eq.pending,and(status.in.(saved,dismissed),decided_at.gte."${decidedSince}")`)
      .order('created_at', { ascending: false }).limit(MAX_CALL_PROPOSALS),
    sb.from('call_pref_audit')
      .select('call_id, geo_proposal_id')
      .eq('client_id', clientId).not('geo_proposal_id', 'is', null)
      .order('updated_at', { ascending: false }).limit(MAX_CALL_PROPOSALS),
    readReadState(sb, chatWid, clientId),
    sb.from('records').select('data').eq('id', clientId).maybeSingle(),
  ]);
  if (propRes.error) throw new Error(`prefs card: proposal read failed: ${propRes.error.message}`);
  if (callRes.error) throw new Error(`prefs card: call proposals read failed: ${callRes.error.message}`);
  if (auditRes.error) throw new Error(`prefs card: call audit read failed: ${auditRes.error.message}`);
  if (clientRes.error) throw new Error(`prefs card: client read failed: ${clientRes.error.message}`);
  // A missing client (deleted after the chat was linked) shows "nothing saved", not an error:
  // the geography half of the card must still load.
  const clientData = (clientRes.data?.data as Record<string, unknown> | null) ?? null;
  const current_values = pickPrefValues(clientData);
  const summary = summarizeUnread(await readInboundSince(sb, chatWid, scanSince(state)), state, now);
  const call_geo = await loadCallGeo(
    sb, clientId, (auditRes.data ?? []) as AuditGeoRow[], clientData ? clientHasPlaces(clientData) : false, decidedSince,
  );
  return {
    proposal: (propRes.data as PrefsCardProposal | null) ?? null,
    call_proposals: shapeCallProposals(
      (callRes.data ?? []) as Array<Omit<PrefsCardCallProposal, 'current_values'>>, current_values,
    ),
    call_geo,
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

export interface AuditGeoRow { call_id: string; geo_proposal_id: string }
export interface GeoProposalStateRow { id: string; status: string; reviewed_at: string | null }

const GEO_OPEN = new Set(['pending', 'must_confirm']);
const GEO_DECIDED = new Set(['applied', 'confirmed', 'edited', 'rejected']);

/**
 * PURE: which audit-minted geo proposals the card shows — open ones, plus the
 * ones decided since `decidedSince` (so the rep sees the result once).
 * Superseded / unknown / older-decided ones are dropped. Keeps `audit` order.
 */
export function selectVisibleCallGeo(
  audit: readonly AuditGeoRow[], proposals: readonly GeoProposalStateRow[], decidedSince: string,
): AuditGeoRow[] {
  const byId = new Map(proposals.map((p) => [p.id, p]));
  const since = Date.parse(decidedSince);
  return audit.filter((a) => {
    const p = byId.get(a.geo_proposal_id);
    if (!p) return false;
    if (GEO_OPEN.has(p.status)) return true;
    return GEO_DECIDED.has(p.status) && !!p.reviewed_at && Date.parse(p.reviewed_at) >= since;
  });
}

/**
 * PURE: keep a call's geo card only when it shows the audit's own proposal and
 * has at least one line on the map (a proposal whose mentions were all demoted
 * draws nothing — nothing to tick, nothing to show).
 */
export function isShowableCallGeoCard(card: ChatCard, proposalId: string): boolean {
  const p = card.proposal;
  if (!p || p.id !== proposalId) return false;
  return Object.keys(p.by_evidence).length > 0;
}

/** The audit-minted place proposals for this client, each with its call's geography card. Read errors throw. */
async function loadCallGeo(
  sb: SupabaseClient, clientId: string, audit: AuditGeoRow[], hasPlaces: boolean, decidedSince: string,
): Promise<PrefsCardCallGeo[]> {
  if (audit.length === 0) return [];
  const [propRes, logRes] = await Promise.all([
    sb.from('geo_pref_proposals').select('id, status, reviewed_at').in('id', audit.map((a) => a.geo_proposal_id)),
    sb.from('call_logs').select('id, hangup_time').in('id', audit.map((a) => a.call_id)),
  ]);
  if (propRes.error) throw new Error(`prefs card: call geo proposals read failed: ${propRes.error.message}`);
  if (logRes.error) throw new Error(`prefs card: call logs read failed: ${logRes.error.message}`);
  const visible = selectVisibleCallGeo(audit, (propRes.data ?? []) as GeoProposalStateRow[], decidedSince);
  if (visible.length === 0) return [];
  const hangup = new Map(((logRes.data ?? []) as Array<{ id: string; hangup_time: string | null }>).map((l) => [l.id, l.hangup_time]));
  const cards = await Promise.all(visible.map((a) => loadChatCard(sb, clientId, a.call_id)));
  const out: PrefsCardCallGeo[] = [];
  visible.forEach((a, i) => {
    const card = cards[i]!;
    if (!isShowableCallGeoCard(card, a.geo_proposal_id)) return;
    out.push({ call_id: a.call_id, call_at: hangup.get(a.call_id) ?? null, proposal_id: a.geo_proposal_id, card, has_places: hasPlaces });
  });
  return out;
}
