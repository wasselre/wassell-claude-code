/**
 * POST /api/webhook/retell-call?secret=<RETELL_WEBHOOK_SECRET>
 *
 * Receives Retell AI webhook events (call_started / call_ended /
 * call_analyzed) for the AI voice agent riding on the Hatif SIP trunk.
 * Configure in the Retell dashboard (agent-level or account-level webhook):
 *
 *   https://<prod-domain>/api/webhook/retell-call?secret=<RETELL_WEBHOOK_SECRET>
 *
 * Auth: either the `x-retell-signature` HMAC header (verified with
 * RETELL_API_KEY — see the UNVERIFIED note in api/_lib/retell.ts) or the
 * `?secret=` URL param. Same dual posture as the Hatif webhook.
 *
 * Every event upserts the call into `call_logs` + `phone_calls` keyed by a
 * deterministic UUID derived from Retell's call_id — so the three lifecycle
 * events for one call collapse into one row that progresses
 * active → completed → (+analysis). Retell retries up to 3 times on non-2xx;
 * ingest errors are logged + swallowed like the Hatif handler so a malformed
 * payload can't burn the retry budget.
 *
 * Outbound wiring note: when our workflow action later places calls via
 * Retell's create-phone-call API, pass `metadata.client_record_id` — this
 * handler prefers it over the phone-number match for client linking.
 */

import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { normalizePhoneE164 } from '../_lib/hatif.js';
import { deterministicUuid } from '../_lib/maqsam.js';
import {
  RetellCall,
  RetellWebhookBody,
  constantTimeEqual,
  durationSeconds,
  mapRetellDirection,
  mapRetellSentiment,
  mapRetellStatus,
  verifyRetellSignature,
} from '../_lib/retell.js';
import { logWebhookReceipt } from '../_lib/activityLogger.js';

export const config = {
  runtime: 'edge',
};

/** Synthetic channel id for provider='retell' rows (call_logs.channel_id is NOT NULL). */
const RETELL_CHANNEL_ID = '7c3e9b21-4d5f-4a86-9e0a-2f8b6c1d3a54';

const RECORDINGS_BUCKET = 'call-recordings';

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    return json({ ok: true, hint: 'POST Retell webhook events here' });
  }
  if (req.method !== 'POST') {
    return json({ error: `Method ${req.method} not allowed` }, 405);
  }

  const urlSecret = process.env.RETELL_WEBHOOK_SECRET;
  const apiKey = process.env.RETELL_API_KEY;
  if (!urlSecret && !apiKey) {
    return json({ error: 'RETELL_WEBHOOK_SECRET or RETELL_API_KEY must be configured' }, 500);
  }

  const rawBody = await req.text();
  const url = new URL(req.url);
  const sig = req.headers.get('x-retell-signature') ?? '';

  let authed = false;
  if (sig && apiKey) {
    try {
      authed = await verifyRetellSignature(rawBody, sig, apiKey);
    } catch (err) {
      console.error('[retell-webhook] signature verification threw:', err);
    }
  }
  if (!authed && urlSecret) {
    authed = constantTimeEqual(url.searchParams.get('secret') ?? '', urlSecret);
  }
  if (!authed) {
    return json({ error: 'unauthorized' }, 401);
  }

  let body: RetellWebhookBody;
  try {
    body = JSON.parse(rawBody) as RetellWebhookBody;
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  if (!body.call?.call_id) {
    return json({ error: 'missing call.call_id' }, 400);
  }

  let handlerError: string | undefined;
  try {
    await ingestRetellCall(body.call, body);
  } catch (err) {
    console.error('[retell-webhook] ingest failed:', err);
    handlerError = err instanceof Error ? err.message : String(err);
  }

  void logWebhookReceipt({
    source: 'retell-call',
    eventType: `${body.event}/${body.call.call_status ?? '?'}`,
    payload: body,
    status: handlerError ? 'error' : 'success',
    error: handlerError,
  });

  return json({ ok: !handlerError });
}

// ─── Ingest (same two-surface pipeline as Hatif/Maqsam) ────────────

async function ingestRetellCall(call: RetellCall, rawEvent: RetellWebhookBody): Promise<void> {
  const id = await deterministicUuid(`retell-call:${call.call_id}`);
  const direction = mapRetellDirection(call.direction);
  const status = mapRetellStatus(call.call_status, call.disconnection_reason);
  const sentiment = mapRetellSentiment(call.call_analysis?.user_sentiment);

  // Customer = the non-agent side. Inbound: the caller; outbound: the callee.
  const customerRaw = direction === 'inbound' ? call.from_number : call.to_number;
  const contactPhone = normalizePhoneE164(customerRaw);

  const creationTime =
    typeof call.start_timestamp === 'number'
      ? new Date(call.start_timestamp).toISOString()
      : new Date().toISOString();
  const hangupTime =
    typeof call.end_timestamp === 'number' ? new Date(call.end_timestamp).toISOString() : null;

  // Retell recording URLs are time-limited — re-host into our public bucket
  // so the record's audio player keeps working. Only once the call has ended.
  const recordingUrl = call.recording_url ? await rehostRecording(call.call_id, call.recording_url) : null;

  const aiAgentUuid = call.agent_id ? await deterministicUuid(`retell-agent:${call.agent_id}`) : null;
  const summary = call.call_analysis?.call_summary ?? null;
  const transcript = typeof call.transcript === 'string' && call.transcript.trim() ? call.transcript : null;

  const supa = getServiceSupabase();
  const logRow = {
    id,
    workspace_id: null,
    channel_id: RETELL_CHANNEL_ID,
    provider: 'retell',
    direction,
    status,
    caller_number: call.from_number ?? null,
    callee_number: call.to_number ?? null,
    contact_phone: contactPhone,
    contact_id: null,
    agent_user_id: null,
    agent_name: 'Retell AI Agent',
    ai_agent_id: aiAgentUuid,
    pickup_time: null,
    hangup_time: hangupTime,
    duration_seconds: durationSeconds(call),
    recording_url: recordingUrl,
    summary,
    sentiment,
    transcription: transcript ? { text: transcript, words: call.transcript_object ?? null } : null,
    evaluation_criteria_result: null,
    dtmf_digit: null,
    dtmf_label: null,
    raw_event: rawEvent as unknown as Record<string, unknown>,
    creation_time: creationTime,
  };
  const { error: logError } = await supa.from('call_logs').upsert(logRow, { onConflict: 'id' });
  if (logError) throw new Error(`call_logs upsert: ${logError.message}`);

  // phone_calls record mirror — isolated failure domain.
  try {
    const modelId = await findPhoneCallsModelId();
    if (!modelId) {
      console.warn('[retell-webhook] phone_calls model not found; skipping record mirror');
      return;
    }

    // Client link: explicit metadata from our outbound trigger wins; fall back
    // to the canonicalized phone match shared with the Hatif/Maqsam ingests.
    const metaClientId =
      typeof call.metadata?.client_record_id === 'string' ? call.metadata.client_record_id : null;
    const clientRecordId =
      metaClientId ?? (contactPhone ? await findClientRecordIdByPhone(contactPhone) : null);

    const data: Record<string, unknown> = {
      call_id: id,
      provider: 'retell',
      retell_call_id: call.call_id,
      retell_agent_id: call.agent_id ?? null,
      direction,
      status,
      customer_phone: contactPhone,
      duration_seconds: durationSeconds(call),
      call_time: creationTime,
      hangup_time: hangupTime,
      // No human agent on AI calls — the assignee field stays empty on purpose.
      agent_name: null,
      sentiment,
      ai_summary: summary,
      transcription_text: transcript,
      recording_url: recordingUrl,
      ...(clientRecordId ? { client_link: clientRecordId } : {}),
    };
    // Last-writer-wins across the three lifecycle events (same posture as the
    // Hatif webhook's Audit C3 note) — call_analyzed carries the fullest state.
    const { error } = await supa.rpc('record_save', {
      p_model_id: modelId,
      p_id: id,
      p_data: data,
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error('[retell-webhook] phone_calls record upsert failed:', err);
  }
}

/**
 * Download the (time-limited) Retell recording and re-host it in the public
 * call-recordings bucket. Idempotent per call (fixed path + upsert). Returns
 * null on any failure — the call row still lands, loudly logged.
 */
async function rehostRecording(retellCallId: string, sourceUrl: string): Promise<string | null> {
  try {
    const res = await fetch(sourceUrl);
    if (!res.ok) {
      console.error(`[retell-webhook] recording fetch failed for ${retellCallId}: ${res.status}`);
      return null;
    }
    const bytes = await res.arrayBuffer();
    const supa = getServiceSupabase();
    const path = `retell/${retellCallId}.wav`;
    const contentType = res.headers.get('content-type') ?? 'audio/wav';
    const { error } = await supa.storage
      .from(RECORDINGS_BUCKET)
      .upload(path, bytes, { contentType, upsert: true });
    if (error) {
      console.error(`[retell-webhook] recording upload failed for ${retellCallId}:`, error.message);
      return null;
    }
    const { data } = supa.storage.from(RECORDINGS_BUCKET).getPublicUrl(path);
    return data.publicUrl ?? null;
  } catch (err) {
    console.error(`[retell-webhook] recording re-host failed for ${retellCallId}:`, err);
    return null;
  }
}

// phone_calls model id — cached per isolate (same pattern as the Hatif webhook).
let phoneCallsModelIdCache: string | null = null;
async function findPhoneCallsModelId(): Promise<string | null> {
  if (phoneCallsModelIdCache) return phoneCallsModelIdCache;
  const supa = getServiceSupabase();
  const { data } = await supa.from('models').select('id').eq('name', 'phone_calls').maybeSingle();
  phoneCallsModelIdCache = (data?.id as string | undefined) ?? null;
  return phoneCallsModelIdCache;
}

async function findClientRecordIdByPhone(contactPhone: string): Promise<string | null> {
  const supa = getServiceSupabase();
  const { data, error } = await supa.rpc('find_client_id_by_phone', { p_phone: contactPhone });
  if (error) {
    console.error('[retell-webhook] client phone lookup failed:', error.message);
    return null;
  }
  return (data as string | null) ?? null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
