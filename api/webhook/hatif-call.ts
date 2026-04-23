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
  contactId?: string | null;
  contactNumber?: string | null;
  aiAgentId?: string | null;
  recordingUrl?: string | null;
  transcription?: unknown;
  summary?: string | null;
  sentiment?: number | null;
  evaluationCriteriaResult?: unknown;
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
  let event: HatifCallEvent;
  try {
    event = JSON.parse(rawBody) as HatifCallEvent;
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  if (!event.callId || !event.channelId) {
    return json({ error: 'missing required fields callId/channelId' }, 400);
  }

  try {
    await upsertCallLog(event, rawBody);
  } catch (err) {
    // Log + swallow — returning 500 makes Hatif retry 5 times, but if the row
    // is malformed every retry will fail the same way. Better to alert via
    // the Vercel function log than burn the retry budget.
    console.error('[hatif-webhook] upsert failed:', err);
  }

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
    raw_event: safeJsonParse(rawBody),
    creation_time: event.creationTime,
  };

  const { error } = await supa.from('call_logs').upsert(row, { onConflict: 'id' });
  if (error) {
    throw new Error(`call_logs upsert: ${error.message}`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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
