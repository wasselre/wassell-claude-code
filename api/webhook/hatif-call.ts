/**
 * POST /api/webhook/hatif-call
 *
 * Receives post-call events from Hatif. Registered out-of-band by the Hatif
 * team (they set `postCallWebhookUrl` on each channel — there is no
 * self-service endpoint). Example URL to give them:
 *
 *   https://<prod-domain>/api/webhook/hatif-call?secret=<HATIF_WEBHOOK_SECRET>
 *
 * On every event:
 *  1. Verify either the HMAC-SHA256 header (`X-Voxa-Signature`) or the
 *     `?secret=` URL param matches `HATIF_WEBHOOK_SECRET`. Fail 401 otherwise.
 *  2. Normalize status/direction/sentiment ints to strings and the contact
 *     phone to E.164 so the client-record query at UI render time is trivial.
 *  3. Upsert one row into `call_logs` keyed by `callId` (Hatif retries; we
 *     tolerate them).
 *  4. Return 200 quickly. Errors inside handling are logged + swallowed so
 *     Hatif's retry window doesn't get wasted on our bugs.
 *
 * The live SPA subscribes to `call_logs` via Supabase Realtime, so an open
 * client record shows the new call + transcript the moment the row lands.
 */

import { getServiceSupabase } from '../_lib/supabaseServer.js';
import {
  mapCallDirection,
  mapCallStatus,
  mapCallSentiment,
  parseCallLengthSeconds,
  normalizePhoneE164,
  verifyHatifSignature,
} from '../_lib/hatif.js';
import { logWebhookReceipt } from '../_lib/activityLogger.js';

export const config = {
  runtime: 'edge',
};

interface HatifCallEvent {
  callId: string;
  workspaceId?: string;
  channelId: string;
  creationTime: string;
  status: number;
  type: number;                                   // 1=Inbound, 2=Outbound
  callerNumber?: string | null;
  calleeNumber?: string | null;
  pickupTime?: string | null;
  hangupTime?: string | null;
  callLength?: string | null;
  userId?: string | null;
  userName?: string | null;
  // Agent email is NOT part of Hatif's current post-call payload, but we accept
  // several plausible field names so the agent→app-user match (findAgentUserId)
  // lights up automatically the day Hatif starts sending one — no code change
  // needed. Until then we fall back to a name match on `userName`.
  userEmail?: string | null;
  agentEmail?: string | null;
  userPrincipalName?: string | null;
  user?: { email?: string | null; userName?: string | null } | null;
  contactId?: string | null;
  contactNumber?: string | null;
  aiAgentId?: string | null;
  recordingUrl?: string | null;
  transcription?: unknown;
  summary?: string | null;
  sentiment?: number | null;
  evaluationCriteriaResult?: unknown;
  // IVR-result fields (present only when the webhook was fired by an
  // outbound-IVR call completing). Hatif's doc names aren't fully pinned, so
  // we accept the common variants and pick whichever is set.
  selectedDigit?: string | null;
  digit?: string | null;
  selectedOption?: { digit?: string; label?: string } | null;
  optionDigit?: string | null;
  optionLabel?: string | null;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    // Sanity-check endpoint the admin can hit without auth to prove it's reachable.
    return json({ ok: true, hint: 'POST Hatif post-call events here' });
  }
  if (req.method !== 'POST') {
    return json({ error: `Method ${req.method} not allowed` }, 405);
  }

  const secret = process.env.HATIF_WEBHOOK_SECRET;
  if (!secret) {
    return json({ error: 'HATIF_WEBHOOK_SECRET not configured' }, 500);
  }

  // Read the raw body ONCE — HMAC verification needs the exact bytes as sent.
  const rawBody = await req.text();

  // Two accepted auth modes:
  //   (a) HMAC: `X-Voxa-Signature: <lowercase-hex HMAC-SHA256(secret, rawBody)>`
  //   (b) URL param fallback: `?secret=<HATIF_WEBHOOK_SECRET>` — useful during
  //       initial setup before Hatif's team has finished signing config.
  const url = new URL(req.url);
  const urlSecret = url.searchParams.get('secret') ?? '';
  const sig = req.headers.get('x-voxa-signature') ?? '';

  let authed = false;
  if (sig) {
    try {
      authed = await verifyHatifSignature(rawBody, sig, secret);
    } catch (err) {
      console.error('[hatif-webhook] signature verification threw:', err);
    }
  } else if (urlSecret) {
    authed = constantTimeEqual(urlSecret, secret);
  }
  if (!authed) {
    return json({ error: 'unauthorized' }, 401);
  }

  // Parse AFTER auth passes — avoid wasting cycles on unauthenticated payloads.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    console.error('[hatif-webhook] 400 invalid JSON body; preview:', bodyPreview(rawBody));
    return json({ error: 'invalid JSON body' }, 400);
  }

  // Hatif changed its post-call payload shape (calls silently dropped since
  // 2026-07-09 — every event 400'd here). `coerceHatifEvent` is now
  // shape-tolerant: it unwraps a wrapping envelope ({data}/{payload}/{event}/…)
  // and reads each field from camelCase, snake_case, or a known alias, so both
  // the legacy flat shape and the current one map to the same HatifCallEvent.
  // The full untouched payload is still stored in `call_logs.raw_event`, so any
  // field this mapping misses can be recovered without re-plumbing the webhook.
  const event = coerceHatifEvent(parsed);
  if (!event) {
    console.error(
      '[hatif-webhook] 400 unrecognized payload shape (no callId/channelId found); preview:',
      bodyPreview(rawBody),
    );
    return json({ error: 'missing required fields callId/channelId' }, 400);
  }

  let handlerError: string | undefined;
  try {
    await upsertCallLog(event, rawBody);
  } catch (err) {
    // Log + swallow — returning 500 makes Hatif retry 5 times, but if the row
    // is malformed every retry will fail the same way. Better to alert via
    // the Vercel function log than burn the retry budget.
    console.error('[hatif-webhook] upsert failed:', err);
    handlerError = err instanceof Error ? err.message : String(err);
  }

  // Mirror a lightweight "header" into the phone_calls records table so the
  // Builder, workflows, views, and dashboards see every call as a first-class
  // CRM record. Failures are isolated from the call_logs write above.
  try {
    await upsertPhoneCallRecord(event);
  } catch (err) {
    console.error('[hatif-webhook] phone_calls record upsert failed:', err);
  }

  // Audit log — every Hatif post-call event lands on /logs.
  void logWebhookReceipt({
    source: 'hatif-call',
    eventType: `${mapCallDirection(event.type)}/${mapCallStatus(event.status)}`,
    payload: event,
    status: handlerError ? 'error' : 'success',
    error: handlerError,
  });

  return json({ ok: true });
}

async function upsertCallLog(event: HatifCallEvent, rawBody: string) {
  const supa = getServiceSupabase();

  const direction = mapCallDirection(event.type);
  const status = mapCallStatus(event.status);
  const sentiment = mapCallSentiment(event.sentiment);

  // Customer phone = the "other side" of the call. For inbound calls, the
  // customer is the caller; for outbound, the callee. Fall back to whichever
  // is non-null.
  const customerRaw =
    event.contactNumber ??
    (direction === 'inbound' ? event.callerNumber : event.calleeNumber) ??
    null;
  const contactPhone = normalizePhoneE164(customerRaw);

  const transcription = isPlainObject(event.transcription) ? event.transcription : null;
  const evaluation = Array.isArray(event.evaluationCriteriaResult)
    ? event.evaluationCriteriaResult
    : null;

  // DTMF (IVR result). Pulled from whichever field variant Hatif populates —
  // we've seen `selectedDigit`, `digit`, and a nested `selectedOption`. When
  // none are set the call wasn't IVR-triggered and these stay null.
  const dtmfDigit =
    event.selectedDigit ??
    event.digit ??
    event.selectedOption?.digit ??
    event.optionDigit ??
    null;
  const dtmfLabel =
    event.selectedOption?.label ??
    event.optionLabel ??
    null;

  const row = {
    id: event.callId,
    workspace_id: event.workspaceId ?? null,
    channel_id: event.channelId,
    direction,
    status,
    caller_number: event.callerNumber ?? null,
    callee_number: event.calleeNumber ?? null,
    contact_phone: contactPhone,
    contact_id: event.contactId ?? null,
    agent_user_id: event.userId ?? null,
    agent_name: event.userName ?? null,
    ai_agent_id: event.aiAgentId ?? null,
    pickup_time: event.pickupTime ?? null,
    hangup_time: event.hangupTime ?? null,
    duration_seconds: parseCallLengthSeconds(event.callLength),
    recording_url: event.recordingUrl ?? null,
    summary: event.summary ?? null,
    sentiment,
    transcription,
    evaluation_criteria_result: evaluation,
    dtmf_digit: dtmfDigit,
    dtmf_label: dtmfLabel,
    raw_event: safeJsonParse(rawBody),
    creation_time: event.creationTime,
  };

  const { error } = await supa.from('call_logs').upsert(row, { onConflict: 'id' });
  if (error) {
    throw new Error(`call_logs upsert: ${error.message}`);
  }
}

// ─── Phone calls (user-facing records) ─────────────────────────────
// Seed-model lookup cached per Edge isolate so the "find model id by name"
// round-trip doesn't happen on every webhook event.
let phoneCallsModelIdCache: string | null = null;
async function findPhoneCallsModelId(): Promise<string | null> {
  if (phoneCallsModelIdCache) return phoneCallsModelIdCache;
  const supa = getServiceSupabase();
  const { data } = await supa
    .from('models')
    .select('id')
    .eq('name', 'phone_calls')
    .maybeSingle();
  phoneCallsModelIdCache = (data?.id as string | undefined) ?? null;
  return phoneCallsModelIdCache;
}

/**
 * Look up the client record whose phone matches `contactPhone`, via the
 * `find_client_id_by_phone` SQL RPC. The RPC canonicalizes BOTH sides to KSA
 * E.164 (`ksa_phone_canon`: strips separators / "00" prefix; reconciles a
 * leading 966 / leading 0 / bare 9-digit subscriber), so the match is
 * FORMAT-AGNOSTIC — a client phone stored as "+966…", "05…", bare "5XXXXXXXX",
 * or with spaces/dashes all match the same call. This is the single source of
 * truth for phone→client matching, shared with the migration backfill, so the
 * webhook and any backfill can never drift. The RPC resolves the clients model
 * id itself and goes through `unified_records` (frozen-safe). Returns null on
 * no match; errors are surfaced to the function log rather than swallowed.
 *
 * See supabase/migrations/2026-06-10_phone_canon_rpc.sql.
 */
async function findClientRecordIdByPhone(contactPhone: string): Promise<string | null> {
  const supa = getServiceSupabase();
  const { data, error } = await supa.rpc('find_client_id_by_phone', { p_phone: contactPhone });
  if (error) {
    console.error('[hatif-webhook] client phone lookup failed:', error.message);
    return null;
  }
  return (data as string | null) ?? null;
}

// ─── Agent → app-user matching ─────────────────────────────────────
// The phone_calls `agent_name` field is an `assignee` field: it stores an app
// user's id (public.users.id), not a name string. We resolve the Hatif agent
// to an app user by email first (when Hatif sends one), then by a normalized
// full-name match against the active roster. No match → null (the call is
// still logged, the agent is just left unassigned). The raw Hatif name is
// still kept verbatim in call_logs.agent_name for the Call History panel.

interface AppUserLite {
  id: string;
  email: string | null;
  name_en: string | null;
  name_ar: string | null;
}

async function loadActiveUsers(): Promise<AppUserLite[]> {
  // Deliberately NOT cached across events: the roster changes rarely but we
  // want a newly-added agent to link without waiting for the Edge isolate to
  // recycle. The table is a single-company roster (tiny), so a read per
  // webhook is negligible.
  const supa = getServiceSupabase();
  const { data, error } = await supa
    .from('users')
    .select('id,email,name_en,name_ar')
    .eq('is_active', true);
  if (error) {
    console.error('[hatif-webhook] active-users load for agent match failed:', error.message);
    return [];
  }
  return (data as AppUserLite[] | null) ?? [];
}

function normalizeName(s: string | null | undefined): string {
  return (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function firstNonEmpty(...vals: (string | null | undefined)[]): string | null {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Resolve the Hatif call's human agent to an app user id (the value an
 * `assignee` field stores). Email match first, normalized-name fallback
 * second. Returns null when nothing matches — caller stores an empty agent.
 */
async function findAgentUserId(event: HatifCallEvent): Promise<string | null> {
  const email = firstNonEmpty(
    event.userEmail, event.agentEmail, event.userPrincipalName, event.user?.email,
  );
  const name = firstNonEmpty(event.userName, event.user?.userName);
  if (!email && !name) return null;

  const users = await loadActiveUsers();
  if (users.length === 0) return null;

  if (email) {
    const e = email.toLowerCase();
    const byEmail = users.find((u) => (u.email ?? '').trim().toLowerCase() === e);
    if (byEmail) return byEmail.id;
  }
  if (name) {
    const n = normalizeName(name);
    const byName = users.find(
      (u) => normalizeName(u.name_en) === n || normalizeName(u.name_ar) === n,
    );
    if (byName) return byName.id;
  }
  return null;
}

/**
 * Upsert the lightweight phone_calls record. Keyed by Hatif's callId (which
 * is already a UUID), so retries are idempotent and the records.id equals
 * the call_logs.id — useful for any future cross-reference UI.
 */
async function upsertPhoneCallRecord(event: HatifCallEvent) {
  const modelId = await findPhoneCallsModelId();
  if (!modelId) {
    // Seed hasn't run in this Supabase — fall through gracefully.
    console.warn('[hatif-webhook] phone_calls model not found; skipping record mirror');
    return;
  }

  const direction = mapCallDirection(event.type);
  const status = mapCallStatus(event.status);
  const sentiment = mapCallSentiment(event.sentiment);

  const customerRaw =
    event.contactNumber ??
    (direction === 'inbound' ? event.callerNumber : event.calleeNumber) ??
    null;
  const contactPhone = normalizePhoneE164(customerRaw);

  const dtmfDigit =
    event.selectedDigit ??
    event.digit ??
    event.selectedOption?.digit ??
    event.optionDigit ??
    null;
  const dtmfLabel =
    event.selectedOption?.label ??
    event.optionLabel ??
    null;

  const clientRecordId = contactPhone ? await findClientRecordIdByPhone(contactPhone) : null;
  const agentUserId = await findAgentUserId(event);

  // Full transcription text (plain string, no word-level timings) — the
  // rich JSONB `words` array stays in call_logs.transcription. This text
  // view is what users filter/search on in the Builder.
  const transcriptionText =
    isPlainObject(event.transcription) && typeof (event.transcription as { text?: unknown }).text === 'string'
      ? ((event.transcription as { text: string }).text)
      : null;

  // Lookup fields store a single target-record id (string) when `is_multi`
  // is unset on the field definition (phone_calls.client_link is not multi).
  const data: Record<string, unknown> = {
    call_id: event.callId,
    direction,
    status,
    // `customer_phone` is the single, normalized customer-side number used for
    // matching, display, workflows, and client lookup. The raw caller/callee
    // legs are intentionally NOT mirrored onto the record — they duplicated
    // this value and live on in call_logs for forensics.
    customer_phone: contactPhone,
    duration_seconds: parseCallLengthSeconds(event.callLength),
    call_time: event.creationTime,
    pickup_time: event.pickupTime ?? null,
    hangup_time: event.hangupTime ?? null,
    // `agent_name` is an `assignee` field — stores the matched app-user id (or
    // null). The raw Hatif agent name stays in call_logs.agent_name.
    agent_name: agentUserId,
    dtmf_digit: dtmfDigit,
    dtmf_label: dtmfLabel,
    sentiment,
    ai_summary: event.summary ?? null,
    transcription_text: transcriptionText,
    recording_url: event.recordingUrl ?? null,
    ...(clientRecordId ? { client_link: clientRecordId } : {}),
  };

  const supa = getServiceSupabase();
  // record_save dispatches to the dedicated `phone_calls` table when the
  // model is frozen, falls through to .from('records') when it isn't.
  //
  // Audit C3 note: this path INTENTIONALLY does NOT pass p_expected_version.
  // Hatif webhooks are last-writer-wins by design — every webhook carries
  // the latest authoritative state of the call from the telephony provider,
  // and we want the most recent payload to win. The fields stored here are
  // all webhook-sourced (status, transcription, sentiment); the only
  // user-editable field is `client_link`, and overwriting it on a re-derive
  // is the documented behavior. If we ever expose user-editable call notes,
  // switch to optimistic concurrency here and merge against the freshly
  // re-read row.
  const { error } = await supa.rpc('record_save', {
    p_model_id: modelId,
    p_id: event.callId,
    p_data: data,
  });
  if (error) {
    throw new Error(`phone_calls record_save: ${error.message}`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** First non-null value read from `obj` under any of `keys`. */
function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}
function pickStr(obj: Record<string, unknown>, ...keys: string[]): string | null {
  const v = pick(obj, ...keys);
  return typeof v === 'string' ? v : v == null ? null : String(v);
}
function pickNum(obj: Record<string, unknown>, ...keys: string[]): number | null {
  const v = pick(obj, ...keys);
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

/** Truncated, single-line preview of a webhook body for the function log. */
function bodyPreview(raw: string): string {
  const s = raw.replace(/\s+/g, ' ').trim();
  return s.length > 1500 ? `${s.slice(0, 1500)}… (${s.length} bytes)` : s;
}

/**
 * Locate the object that actually carries the call fields. Hatif (or any
 * webhook provider) commonly wraps the event in an envelope, so we probe the
 * payload itself first, then the usual wrapper keys, returning the first object
 * that has both a call id and a channel id (under any known alias).
 */
function locateEventObject(parsed: unknown): Record<string, unknown> | null {
  if (!isPlainObject(parsed)) return null;
  const candidates: unknown[] = [
    parsed,
    parsed.data,
    parsed.payload,
    parsed.event,
    parsed.call,
    parsed.callData,
    parsed.result,
    parsed.body,
    isPlainObject(parsed.data) ? (parsed.data as Record<string, unknown>).call : undefined,
    isPlainObject(parsed.payload) ? (parsed.payload as Record<string, unknown>).call : undefined,
  ];
  for (const c of candidates) {
    if (
      isPlainObject(c) &&
      pick(c, 'callId', 'call_id', 'callID', 'id') != null &&
      pick(c, 'channelId', 'channel_id', 'channelID') != null
    ) {
      return c;
    }
  }
  return null;
}

/**
 * Map an arbitrary Hatif payload (any envelope, camelCase or snake_case field
 * names) onto the canonical HatifCallEvent shape the rest of the handler uses.
 * Returns null when no call id / channel id can be found at all — the one hard
 * requirement, since callId is the call_logs primary key. Every field falls
 * back through its known aliases; unknown fields survive verbatim in
 * `call_logs.raw_event`.
 */
function coerceHatifEvent(parsed: unknown): HatifCallEvent | null {
  const o = locateEventObject(parsed);
  if (!o) return null;

  const callId = pickStr(o, 'callId', 'call_id', 'callID', 'id');
  const channelId = pickStr(o, 'channelId', 'channel_id', 'channelID');
  if (!callId || !channelId) return null;

  const selectedOptionRaw = pick(o, 'selectedOption', 'selected_option');
  const selectedOption = isPlainObject(selectedOptionRaw)
    ? {
        digit: pickStr(selectedOptionRaw, 'digit') ?? undefined,
        label: pickStr(selectedOptionRaw, 'label') ?? undefined,
      }
    : null;
  const userRaw = pick(o, 'user');
  const user = isPlainObject(userRaw)
    ? {
        email: pickStr(userRaw, 'email'),
        userName: pickStr(userRaw, 'userName', 'user_name', 'name'),
      }
    : null;

  return {
    callId,
    channelId,
    workspaceId: pickStr(o, 'workspaceId', 'workspace_id') ?? undefined,
    creationTime:
      pickStr(o, 'creationTime', 'creation_time', 'createdAt', 'created_at', 'startTime', 'start_time', 'timestamp') ??
      new Date().toISOString(),
    status: pickNum(o, 'status') ?? 0,
    type: pickNum(o, 'type', 'callType', 'call_type') ?? 0,
    callerNumber: pickStr(o, 'callerNumber', 'caller_number', 'from', 'fromNumber', 'from_number'),
    calleeNumber: pickStr(o, 'calleeNumber', 'callee_number', 'to', 'toNumber', 'to_number'),
    pickupTime: pickStr(o, 'pickupTime', 'pickup_time', 'answeredAt', 'answered_at'),
    hangupTime: pickStr(o, 'hangupTime', 'hangup_time', 'endedAt', 'ended_at'),
    callLength: pickStr(o, 'callLength', 'call_length', 'duration', 'durationSeconds', 'duration_seconds', 'length'),
    userId: pickStr(o, 'userId', 'user_id', 'agentId', 'agent_id'),
    userName: pickStr(o, 'userName', 'user_name', 'agentName', 'agent_name'),
    userEmail: pickStr(o, 'userEmail', 'user_email'),
    agentEmail: pickStr(o, 'agentEmail', 'agent_email'),
    userPrincipalName: pickStr(o, 'userPrincipalName', 'user_principal_name', 'upn'),
    user,
    contactId: pickStr(o, 'contactId', 'contact_id'),
    contactNumber: pickStr(o, 'contactNumber', 'contact_number', 'contactPhone', 'contact_phone'),
    aiAgentId: pickStr(o, 'aiAgentId', 'ai_agent_id'),
    recordingUrl: pickStr(o, 'recordingUrl', 'recording_url', 'recording'),
    transcription: pick(o, 'transcription', 'transcript'),
    summary: pickStr(o, 'summary', 'aiSummary', 'ai_summary'),
    sentiment: pickNum(o, 'sentiment'),
    evaluationCriteriaResult: pick(o, 'evaluationCriteriaResult', 'evaluation_criteria_result'),
    selectedDigit: pickStr(o, 'selectedDigit', 'selected_digit'),
    digit: pickStr(o, 'digit'),
    selectedOption,
    optionDigit: pickStr(o, 'optionDigit', 'option_digit'),
    optionLabel: pickStr(o, 'optionLabel', 'option_label'),
  };
}

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return { _raw: s }; }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
