/**
 * CALL AUDIT — "the customer said it on a call, the profile doesn't have it".
 *
 * Operator decision 2026-09-29: calls are NOT read for a live card (the rep
 * logs during / after the call). The only call feature is this audit: once per
 * finished Hatif call (≥ 1 h after hang-up, > 20 s, diarized), read the call
 * with the preference extractor (channel 'call') and propose ONLY the fields
 * that are EMPTY on the client. A value that differs from what the rep saved is
 * never shown and never written — the rep's record wins.
 *
 *   claim the call (`call_audit_claim`; false ⇒ someone else has it — return
 *   `skipped/not_claimed` WITHOUT finishing) → gather the call conversation
 *   (`gatherCallConversation`; none ⇒ `skipped/no_transcript`; unlabelled
 *   speakers ⇒ `skipped/unlabelled` — we can't tell who said what) →
 *   extract → drop districts (no geography from calls in this version) → read
 *   the client (gone ⇒ `skipped/client_missing`) → `emptyOnlySuggestions` →
 *   nothing kept ⇒ `done`, no proposal → else supersede + insert ONE pending
 *   `client_pref_proposals` row (source 'call', chat_wid `call:<id>`) →
 *   `call_audit_finish`.
 *
 * `call_audit_finish` runs after EVERY claimed attempt, including a failed one
 * (the error message is recorded and the ledger retries it up to 3 attempts).
 * A crash that kills the process mid-audit leaves a `running` row whose lease
 * simply expires.
 *
 * NEVER writes the client record. The rep's tick + save in the chat card does
 * (POST /api/client-prefs/review), and that save is fill-empty-only too.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { renderConversation, type Conversation } from '../geoPreference/extractor.js';
import { gatherCallConversation } from '../geoPreference/backfillPorts.js';
import { extractPreferences, PREF_EXTRACTOR_VERSION, type PrefSuggestion } from '../prefExtract.js';
import { isEmptyValue } from '../../../src/lib/salesProcess/valueEqual.js';
import { pickPrefValues, insertPendingProposal, type NewPrefProposalRow } from './extractChatPrefs.js';

/** Lease on one call's audit (seconds). Above the worst-case extractor time (two DeepSeek attempts + the Claude fallback). */
export const CALL_AUDIT_LEASE_SECONDS = 300;

/** The chat_wid a call proposal is stored under — one pending proposal per call. */
export const callProposalKey = (callId: string): string => `call:${callId}`;

export type CallAuditStatus = 'done' | 'skipped' | 'failed';

export interface CallAuditResult {
  status: CallAuditStatus;
  /** Why it was skipped / failed, or why a `done` produced nothing (no_preferences / all_filled). */
  reason: string | null;
  proposalId: string | null;
  /** Slugs proposed (empty on the client, said on the call). */
  missed: string[];
  /** Slugs the call mentioned that the client already has — never proposed. */
  droppedFilled: string[];
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

/** Fold a quote / transcript for matching: diacritics, tatweel, alef forms,
 *  ta marbuta, alef maqsura, punctuation and hesitation dashes all drop out. */
export function normalizeForQuote(s: string): string {
  return s
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * PURE — was this quote said by the CUSTOMER? Every fragment of the quote
 * (split on «...» / «…»; bracketed editor notes like «[العميل لم ينفِ]»
 * removed) must appear in the customer's own turns. The prompt already asks for
 * the customer's words, but measured 2026-09-29 the model still quoted the
 * salesperson in 3 of 14 audit suggestions («أنتِ تبحثين عن شقة…», «أبديت
 * اهتمامك تملك وحدة…») — this deterministic check is what makes "the customer
 * said it" true. A suggestion with no quote fails (nothing to verify).
 */
export function customerSaidIt(conversation: Conversation, quote: string | null): boolean {
  if (!quote) return false;
  const customerText = ` ${normalizeForQuote(conversation.turns.filter((t) => t.speaker === 'client').map((t) => t.text).join(' '))} `;
  const fragments = quote
    .replace(/\[[^\]]*\]/g, ' ')
    .split(/\.{2,}|…/)
    .map(normalizeForQuote)
    .filter((f) => f.length >= 2);
  if (fragments.length === 0) return false;
  return fragments.every((f) => customerText.includes(` ${f} `) || customerText.includes(f));
}

export interface CallAuditFinish {
  status: CallAuditStatus;
  reason: string | null;
  proposalId: string | null;
  missed: string[];
}

/** Everything that touches the outside world — injectable for tests. */
export interface CallAuditDeps {
  claim(callId: string, clientId: string, leaseSeconds: number): Promise<boolean>;
  /** Returns false when the row was no longer `running` (another runner finished it). */
  finish(callId: string, f: CallAuditFinish): Promise<boolean>;
  gather(callId: string): Promise<Conversation | null>;
  /** The client's data, or null when the client record no longer exists. THROWS on a read error. */
  readClient(clientId: string): Promise<Record<string, unknown> | null>;
  extract: typeof extractPreferences;
  insertProposal(row: NewPrefProposalRow): Promise<{ proposalId: string; superseded: number }>;
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
    gather: (callId) => gatherCallConversation(sb, callId),
    async readClient(clientId) {
      const { data, error } = await sb.from('records').select('data').eq('id', clientId).maybeSingle();
      if (error) throw new Error(`call audit: client read failed: ${error.message}`);
      if (!data) return null;
      return (data.data as Record<string, unknown> | null) ?? {};
    },
    extract: extractPreferences,
    insertProposal: (row) => insertPendingProposal(sb, row),
  };
}

export interface AuditCallInput {
  callId: string;
  clientId: string;
  /** call_logs.hangup_time — stored as the proposal's call_at + watermark. Falls back to the last turn's time. */
  hangupAt?: string | null;
  log?: (msg: string) => void;
  deps?: Partial<CallAuditDeps>;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function auditCall(sb: SupabaseClient, input: AuditCallInput): Promise<CallAuditResult> {
  const log = input.log ?? (() => {});
  const deps: CallAuditDeps = { ...makeCallAuditDeps(sb), ...(input.deps ?? {}) };
  const { callId, clientId } = input;
  const tag = `[call-audit] call=${callId} client=${clientId}`;

  if (!(await deps.claim(callId, clientId, CALL_AUDIT_LEASE_SECONDS))) {
    return { status: 'skipped', reason: 'not_claimed', proposalId: null, missed: [], droppedFilled: [] };
  }

  let result: CallAuditResult;
  try {
    result = await runAudit(deps, input, log, tag);
  } catch (err) {
    const msg = errMsg(err);
    console.error(`${tag} failed:`, msg);
    result = { status: 'failed', reason: msg, proposalId: null, missed: [], droppedFilled: [] };
  }

  // Always finish a claimed attempt — a failure is recorded (and retried by the
  // ledger, max 3 attempts), never left as a live lease.
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
  log(`${tag} status=${result.status}${result.reason ? ` reason=${result.reason}` : ''} missed=${result.missed.join(',') || '-'} already_filled=${result.droppedFilled.join(',') || '-'} proposal=${result.proposalId ?? '-'}`);
  return result;
}

async function runAudit(
  deps: CallAuditDeps, input: AuditCallInput, log: (m: string) => void, tag: string,
): Promise<CallAuditResult> {
  const skipped = (reason: string): CallAuditResult =>
    ({ status: 'skipped', reason, proposalId: null, missed: [], droppedFilled: [] });

  const conversation = await deps.gather(input.callId);
  if (!conversation || conversation.turns.length === 0) return skipped('no_transcript');
  // Without speaker labels the salesperson's restatement cannot be told apart
  // from the customer's own words — the exact error the audit must not make.
  if (!conversation.speaker_labels || conversation.speaker_labels === 'none') return skipped('unlabelled');

  const res = await deps.extract({
    channel: 'call',
    transcript: renderConversation(conversation),
    entity: { kind: 'call', id: input.callId },
  });
  // Geography is out of scope for calls in this version — districts are dropped.
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

  const clientData = await deps.readClient(input.clientId);
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
