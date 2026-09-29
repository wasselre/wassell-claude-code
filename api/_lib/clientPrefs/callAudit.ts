/**
 * CALL AUDIT — "the customer said it on a call, the profile doesn't have it".
 *
 * Operator decision 2026-09-29: calls are NOT read for a live card (the rep
 * logs during / after the call). The only call feature is this audit: once per
 * finished Hatif call (≥ 1 h after hang-up, > 20 s, diarized), read the call
 * and propose ONLY what is EMPTY on the client. A value that differs from what
 * the rep saved is never shown and never written — the rep's record wins.
 *
 * TWO PASSES over ONE gathered conversation, under ONE ledger row
 * (`call_pref_audit`):
 *
 *   PREFERENCES (the six fields) — extract (channel 'call') → keep only what
 *   the customer provably said (`customerSaidIt`) → read the client (gone ⇒
 *   `skipped/client_missing`) → `emptyOnlySuggestions` → nothing kept ⇒ `done`,
 *   no proposal → else supersede + insert ONE pending `client_pref_proposals`
 *   row (source 'call', chat_wid `call:<id>`) → `call_audit_finish`.
 *
 *   PLACES (geography, added 2026-09-29 "do places from calls") — only when the
 *   client has NO places (`location_items` empty, `parseLocationItems`; else
 *   `skipped/has_places`) → `analyzeChatConversation` on the call id (the SAME
 *   geography pipeline the chat card uses: extract on a first read, review-only
 *   over graded / already-read evidence — never a fork) with the CALL SPEAKER
 *   GUARD (companyRules.ts RULE 3) → the minted geo proposal id →
 *   `call_audit_geo_finish`. Saving it is fill-empty-only too
 *   (api/geo-preference/review.ts refuses when places appeared since).
 *
 *   Both passes: no transcript ⇒ `skipped/no_transcript`; unlabelled speakers
 *   ⇒ `skipped/unlabelled` (we can't tell who said what).
 *
 * WHICH passes run comes from `call_audit_candidates` (`needs_prefs`,
 * `needs_geo`):
 *   • a fresh (or failed) preference audit claims with `call_audit_claim` and
 *     runs the geo pass inside the same lease when `needs_geo`; the geo result
 *     is recorded (`call_audit_geo_finish`) BEFORE `call_audit_finish` clears
 *     the lease;
 *   • a call whose preference audit is already terminal but whose geo pass
 *     never ran (the calls audited before geography existed) or failed claims
 *     with `call_audit_geo_claim` and runs the geo pass ONLY — the preference
 *     extractor is never re-run and the preference result is never touched.
 *
 * Every claimed attempt is finished, a failure included (the error is recorded
 * and the ledger retries up to 3 attempts per pass). A crash that kills the
 * process mid-audit leaves a lease that simply expires.
 *
 * NEVER writes the client record. The rep's tick + save in the chat card does
 * (POST /api/client-prefs/review, POST /api/geo-preference/review), and both
 * saves are fill-empty-only for a call.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { renderConversation, type Conversation } from '../geoPreference/extractor.js';
import { gatherCallConversation } from '../geoPreference/backfillPorts.js';
import { analyzeChatConversation, type AnalyzeOutcome, type AnalyzeOptions } from '../geoPreference/chatCard.js';
import { extractPreferences, PREF_EXTRACTOR_VERSION, type PrefSuggestion } from '../prefExtract.js';
import { isEmptyValue } from '../../../src/lib/salesProcess/valueEqual.js';
import { parseLocationItems } from '../../../src/lib/geo/locationItems.js';
import { pickPrefValues, insertPendingProposal, type NewPrefProposalRow } from './extractChatPrefs.js';
import { customerSaidIt } from './quoteMatch.js';

/**
 * Lease on one call's audit (seconds). Above the worst case of BOTH passes: the
 * preference extractor (two DeepSeek attempts + the Claude fallback) plus one
 * geography read (extraction + resolver + the advisory verifier).
 */
export const CALL_AUDIT_LEASE_SECONDS = 600;

/** The chat_wid a call proposal is stored under — one pending proposal per call. */
export const callProposalKey = (callId: string): string => `call:${callId}`;

export type CallAuditStatus = 'done' | 'skipped' | 'failed';

/** The geography pass's result, as recorded on the ledger. */
export interface CallGeoResult {
  status: CallAuditStatus;
  /** Why it was skipped / failed, or why a `done` produced nothing (`no_places`). */
  reason: string | null;
  /** The geo_pref_proposals row this pass minted (null = none). */
  proposalId: string | null;
  /** What the geography pipeline ran (extract / re_review), when it ran. */
  mode: string | null;
}

export interface CallAuditResult {
  /** The PREFERENCE pass (only meaningful when `prefsRan`). A lost claim is `skipped/not_claimed`. */
  status: CallAuditStatus;
  /** Why it was skipped / failed, or why a `done` produced nothing (no_preferences / all_filled). */
  reason: string | null;
  proposalId: string | null;
  /** Slugs proposed (empty on the client, said on the call). */
  missed: string[];
  /** Slugs the call mentioned that the client already has — never proposed. */
  droppedFilled: string[];
  /** Did the preference pass run in this attempt? (false for a geo-only pass or a lost claim) */
  prefsRan: boolean;
  /** The geography pass; null when it did not run in this attempt. */
  geo: CallGeoResult | null;
}

/**
 * PURE: keep a suggestion only when the client's current value is EMPTY
 * (`isEmptyValue`). A field the client already has — same value or not — is
 * dropped and reported, never proposed.
 */
export function emptyOnlySuggestions(
  suggestions: Record<string, PrefSuggestion>,
  current: Record<string, unknown>,
): { kept: Record<string, PrefSuggestion>; droppedFilled: string[] } {
  const kept: Record<string, PrefSuggestion> = {};
  const droppedFilled: string[] = [];
  for (const [slug, s] of Object.entries(suggestions)) {
    if (isEmptyValue(current[slug])) kept[slug] = s;
    else droppedFilled.push(slug);
  }
  return { kept, droppedFilled };
}

/** PURE: does the client already have places? (`location_items` parsed the same way the geo save reads it.) */
export function clientHasPlaces(clientData: Record<string, unknown>): boolean {
  return parseLocationItems(clientData.location_items).length > 0;
}

// Quote matching lives in quoteMatch.ts (shared with the geography call speaker
// guard); re-exported here so existing importers keep working.
export { normalizeForQuote, customerSaidIt } from './quoteMatch.js';

export interface CallAuditFinish {
  status: CallAuditStatus;
  reason: string | null;
  proposalId: string | null;
  missed: string[];
}

export interface CallGeoFinish {
  status: CallAuditStatus;
  reason: string | null;
  proposalId: string | null;
}

/** Everything that touches the outside world — injectable for tests. */
export interface CallAuditDeps {
  /** The preference claim (a fresh / failed / crashed audit). */
  claim(callId: string, clientId: string, leaseSeconds: number): Promise<boolean>;
  /** Returns false when the row was no longer `running` (another runner finished it). */
  finish(callId: string, f: CallAuditFinish): Promise<boolean>;
  /** The geo-only claim: the preference audit is terminal, the geo pass is due. */
  geoClaim(callId: string, leaseSeconds: number): Promise<boolean>;
  /** Record the geo pass. Returns false when this runner no longer held the call. */
  geoFinish(callId: string, f: CallGeoFinish): Promise<boolean>;
  gather(callId: string): Promise<Conversation | null>;
  /** The client's data, or null when the client record no longer exists. THROWS on a read error. */
  readClient(clientId: string): Promise<Record<string, unknown> | null>;
  extract: typeof extractPreferences;
  insertProposal(row: NewPrefProposalRow): Promise<{ proposalId: string; superseded: number }>;
  /** The geography pipeline on ONE conversation (analyzeChatConversation). */
  analyzeGeo(clientId: string, callId: string, opts: Pick<AnalyzeOptions, 'conversation' | 'workerId' | 'log'>): Promise<AnalyzeOutcome>;
}

export function makeCallAuditDeps(sb: SupabaseClient): CallAuditDeps {
  return {
    async claim(callId, clientId, leaseSeconds) {
      const { data, error } = await sb.rpc('call_audit_claim', {
        p_call_id: callId, p_client_id: clientId, p_lease_seconds: leaseSeconds,
      });
      if (error) throw new Error(`call_audit_claim failed: ${error.message}`);
      return data === true;
    },
    async finish(callId, f) {
      const { data, error } = await sb.rpc('call_audit_finish', {
        p_call_id: callId, p_status: f.status, p_reason: f.reason,
        p_proposal_id: f.proposalId, p_missed: f.missed,
      });
      if (error) throw new Error(`call_audit_finish failed: ${error.message}`);
      return data === true;
    },
    async geoClaim(callId, leaseSeconds) {
      const { data, error } = await sb.rpc('call_audit_geo_claim', { p_call_id: callId, p_lease_seconds: leaseSeconds });
      if (error) throw new Error(`call_audit_geo_claim failed: ${error.message}`);
      return data === true;
    },
    async geoFinish(callId, f) {
      const { data, error } = await sb.rpc('call_audit_geo_finish', {
        p_call_id: callId, p_status: f.status, p_reason: f.reason, p_proposal_id: f.proposalId,
      });
      if (error) throw new Error(`call_audit_geo_finish failed: ${error.message}`);
      return data === true;
    },
    gather: (callId) => gatherCallConversation(sb, callId),
    async readClient(clientId) {
      const { data, error } = await sb.from('records').select('data').eq('id', clientId).maybeSingle();
      if (error) throw new Error(`call audit: client read failed: ${error.message}`);
      if (!data) return null;
      return (data.data as Record<string, unknown> | null) ?? {};
    },
    extract: extractPreferences,
    insertProposal: (row) => insertPendingProposal(sb, row),
    analyzeGeo: (clientId, callId, opts) => analyzeChatConversation(sb, clientId, callId, opts),
  };
}

export interface AuditCallInput {
  callId: string;
  clientId: string;
  /** call_logs.hangup_time — stored as the proposal's call_at + watermark. Falls back to the last turn's time. */
  hangupAt?: string | null;
  /** Run the preference pass (call_audit_candidates.needs_prefs). Default true. */
  needsPrefs?: boolean;
  /** Run the geography pass (call_audit_candidates.needs_geo). Default true. */
  needsGeo?: boolean;
  log?: (msg: string) => void;
  deps?: Partial<CallAuditDeps>;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Memoise one async read so both passes share it (and a failure is shared too). */
function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= fn());
}

interface Shared {
  conversation: () => Promise<Conversation | null>;
  client: () => Promise<Record<string, unknown> | null>;
}

export async function auditCall(sb: SupabaseClient, input: AuditCallInput): Promise<CallAuditResult> {
  const log = input.log ?? (() => {});
  const deps: CallAuditDeps = { ...makeCallAuditDeps(sb), ...(input.deps ?? {}) };
  const { callId, clientId } = input;
  const needsPrefs = input.needsPrefs ?? true;
  const needsGeo = input.needsGeo ?? true;
  const tag = `[call-audit] call=${callId} client=${clientId}`;
  const idle = (reason: string): CallAuditResult =>
    ({ status: 'skipped', reason, proposalId: null, missed: [], droppedFilled: [], prefsRan: false, geo: null });

  if (!needsPrefs && !needsGeo) return idle('nothing_due');
  const claimed = needsPrefs
    ? await deps.claim(callId, clientId, CALL_AUDIT_LEASE_SECONDS)
    : await deps.geoClaim(callId, CALL_AUDIT_LEASE_SECONDS);
  if (!claimed) return idle('not_claimed');

  const shared: Shared = {
    conversation: once(() => deps.gather(callId)),
    client: once(() => deps.readClient(clientId)),
  };

  // ── Preference pass ──
  // A geo-only pass never touches the preference result — it stays as recorded.
  let result: CallAuditResult = idle('prefs_already_audited');
  if (needsPrefs) {
    try {
      result = { ...(await runPrefAudit(deps, input, shared, log, tag)), prefsRan: true, geo: null };
    } catch (err) {
      const msg = errMsg(err);
      console.error(`${tag} preference pass failed:`, msg);
      result = { status: 'failed', reason: msg, proposalId: null, missed: [], droppedFilled: [], prefsRan: true, geo: null };
    }
  }

  // ── Geography pass (recorded BEFORE the preference finish clears the lease) ──
  if (needsGeo) {
    let geo: CallGeoResult;
    try {
      geo = await runGeoAudit(deps, input, shared, log);
    } catch (err) {
      const msg = errMsg(err);
      console.error(`${tag} geography pass failed:`, msg);
      geo = { status: 'failed', reason: msg, proposalId: null, mode: null };
    }
    try {
      const ok = await deps.geoFinish(callId, { status: geo.status, reason: geo.reason, proposalId: geo.proposalId });
      if (!ok) {
        console.error(`${tag} geo finish matched no row this runner holds — the lease expired and another runner took the call; this geo result is not recorded (proposal=${geo.proposalId ?? '-'})`);
      }
    } catch (err) {
      const msg = errMsg(err);
      console.error(`${tag} recording the geo result failed (the call's geo pass is retried):`, msg);
      geo = { ...geo, status: 'failed', reason: `geo finish failed: ${msg}${geo.reason ? ` (after: ${geo.reason})` : ''}` };
    }
    result = { ...result, geo };
  }

  // Always finish a claimed preference attempt — a failure is recorded (and
  // retried by the ledger, max 3 attempts), never left as a live lease.
  if (needsPrefs) {
    try {
      const ok = await deps.finish(callId, {
        status: result.status, reason: result.reason, proposalId: result.proposalId, missed: result.missed,
      });
      if (!ok) {
        console.error(`${tag} finish matched no running row — the lease expired and another runner took the call; this attempt's result is not recorded (proposal=${result.proposalId ?? '-'})`);
      }
    } catch (err) {
      const msg = errMsg(err);
      console.error(`${tag} recording the result failed (the lease will expire and the call is retried):`, msg);
      return { ...result, status: 'failed', reason: `finish failed: ${msg}${result.reason ? ` (after: ${result.reason})` : ''}` };
    }
  }

  const prefPart = needsPrefs
    ? `status=${result.status}${result.reason ? ` reason=${result.reason}` : ''} missed=${result.missed.join(',') || '-'} already_filled=${result.droppedFilled.join(',') || '-'} proposal=${result.proposalId ?? '-'}`
    : 'prefs=already-audited';
  const geoPart = result.geo
    ? `geo=${result.geo.status}${result.geo.reason ? `/${result.geo.reason}` : ''}${result.geo.mode ? ` geo_mode=${result.geo.mode}` : ''} geo_proposal=${result.geo.proposalId ?? '-'}`
    : 'geo=not-due';
  log(`${tag} ${prefPart} ${geoPart}`);
  return result;
}

type PrefPass = Omit<CallAuditResult, 'prefsRan' | 'geo'>;

async function runPrefAudit(
  deps: CallAuditDeps, input: AuditCallInput, shared: Shared, log: (m: string) => void, tag: string,
): Promise<PrefPass> {
  const skipped = (reason: string): PrefPass =>
    ({ status: 'skipped', reason, proposalId: null, missed: [], droppedFilled: [] });

  const conversation = await shared.conversation();
  if (!conversation || conversation.turns.length === 0) return skipped('no_transcript');
  // Without speaker labels the salesperson's restatement cannot be told apart
  // from the customer's own words — the exact error the audit must not make.
  if (!conversation.speaker_labels || conversation.speaker_labels === 'none') return skipped('unlabelled');

  const res = await deps.extract({
    channel: 'call',
    transcript: renderConversation(conversation),
    entity: { kind: 'call', id: input.callId },
  });
  // The preference extractor's districts are dropped here — geography has its
  // own pass (runGeoAudit) through the geography pipeline.
  // Only what the CUSTOMER provably said survives (customerSaidIt).
  const said: Record<string, PrefSuggestion> = {};
  const notCustomer: string[] = [];
  for (const [slug, s] of Object.entries(res.output.suggestions)) {
    if (customerSaidIt(conversation, s.quote)) said[slug] = s;
    else notCustomer.push(slug);
  }
  if (notCustomer.length) {
    log(`[call-audit] call=${input.callId} dropped (quote not in the customer's words): ${notCustomer.join(',')}`);
  }

  const clientData = await shared.client();
  if (clientData === null) return skipped('client_missing');
  const current = pickPrefValues(clientData);

  if (Object.keys(said).length === 0) {
    return { status: 'done', reason: 'no_preferences', proposalId: null, missed: [], droppedFilled: [] };
  }
  const { kept, droppedFilled } = emptyOnlySuggestions(said, current);
  const missed = Object.keys(kept);
  if (missed.length === 0) {
    return { status: 'done', reason: 'all_filled', proposalId: null, missed: [], droppedFilled };
  }

  const lastTurnAt = conversation.turns.map((t) => t.timestamp ?? '').filter(Boolean).sort().pop() ?? null;
  const callAt = input.hangupAt ?? lastTurnAt;
  const { proposalId, superseded } = await deps.insertProposal({
    client_id: input.clientId,
    chat_wid: callProposalKey(input.callId),
    suggestions: kept,
    current_values: current,
    source_watermark: callAt ?? new Date().toISOString(),
    source_message_count: conversation.turns.length,
    extractor_version: PREF_EXTRACTOR_VERSION,
    model: res.model,
    is_fallback: res.isFallback,
    trigger: 'call_audit',
    source: 'call',
    call_id: input.callId,
    call_at: callAt,
  });
  if (superseded > 0) log(`${tag} superseded ${superseded} older pending call proposal(s)`);
  return { status: 'done', reason: null, proposalId, missed, droppedFilled };
}

/**
 * The geography pass. Places are proposed ONLY for a client with none — the
 * save re-checks the same thing on the fresh row. Throws on a read / pipeline
 * error (the caller records `failed`).
 */
async function runGeoAudit(
  deps: CallAuditDeps, input: AuditCallInput, shared: Shared, log: (m: string) => void,
): Promise<CallGeoResult> {
  const skipped = (reason: string): CallGeoResult => ({ status: 'skipped', reason, proposalId: null, mode: null });

  const conversation = await shared.conversation();
  if (!conversation || conversation.turns.length === 0) return skipped('no_transcript');
  if (!conversation.speaker_labels || conversation.speaker_labels === 'none') return skipped('unlabelled');

  const clientData = await shared.client();
  if (clientData === null) return skipped('client_missing');
  if (clientHasPlaces(clientData)) return skipped('has_places');

  const out = await deps.analyzeGeo(input.clientId, input.callId, {
    conversation, workerId: `call-audit:${input.callId.slice(0, 8)}`, log,
  });
  // Read within the last minute (someone ran it by hand) — nothing ran; retry later.
  if (out.mode === 'skipped_recent') return { status: 'failed', reason: 'cooldown', proposalId: null, mode: out.mode };
  if (!out.minted_proposal_id) return { status: 'done', reason: 'no_places', proposalId: null, mode: out.mode };
  return { status: 'done', reason: null, proposalId: out.minted_proposal_id, mode: out.mode };
}
