/**
 * Shared Maqsam → CRM ingest: one function that takes a Maqsam call object and
 * upserts it into BOTH `call_logs` and the `phone_calls` records model — the
 * exact same two-surface pipeline the Hatif webhook feeds, so Call History
 * panels, workflows, dashboards, and the follow-up evidence link all work on
 * Maqsam calls with zero UI changes.
 *
 * Two callers:
 *   - api/webhook/maqsam-call.ts  (push — whatever Maqsam's webhook sends)
 *   - api/maqsam/sync-calls.ts    (pull — reconcile sweep over Calls API v3)
 *
 * Both paths hash the Maqsam integer id to the same deterministic UUID
 * (`maqsamCallUuid`), so double-delivery is a harmless idempotent upsert.
 */

import { getServiceSupabase } from './supabaseServer.js';
import { normalizePhoneE164 } from './hatif.js';
import {
  MaqsamCall,
  MAQSAM_CHANNEL_ID,
  fetchRecording,
  mapMaqsamDirection,
  mapMaqsamSentiment,
  mapMaqsamStatus,
  maqsamCallUuid,
} from './maqsam.js';

const RECORDINGS_BUCKET = 'call-recordings';

export interface MaqsamIngestResult {
  id: string;                 // our derived UUID
  maqsamId: string;
  skipped?: 'internal';
}

/** Pick the first plausible timestamp field the live API populates. */
function callTimestamp(call: MaqsamCall): string {
  const cand =
    call.startTime ?? call.start_time ?? call.createdAt ?? call.created_at ??
    call.time ?? call.timestamp ?? null;
  if (typeof cand === 'number') {
    // Epoch seconds vs millis — anything before ~2001-09 in millis is seconds.
    const ms = cand > 1_000_000_000_000 ? cand : cand * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof cand === 'string' && cand.trim()) {
    const d = new Date(cand);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function transcriptionText(call: MaqsamCall): string | null {
  const t = call.transcription;
  if (typeof t === 'string' && t.trim()) return t;
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    const text = (t as { text?: unknown }).text;
    if (typeof text === 'string' && text.trim()) return text;
  }
  return null;
}

/**
 * Download the call's MP3 from Maqsam (auth'd) and re-host it in the public
 * `call-recordings` Storage bucket so the record form's <audio> player can
 * play it without Maqsam credentials. Idempotent per call (fixed path +
 * upsert). Returns the public URL, or null when Maqsam has no recording.
 * Failures are logged and surfaced as null — the call row still lands.
 */
async function rehostRecording(maqsamId: string): Promise<string | null> {
  try {
    const bytes = await fetchRecording(maqsamId);
    if (!bytes) return null;
    const supa = getServiceSupabase();
    const path = `maqsam/${maqsamId}.mp3`;
    const { error } = await supa.storage
      .from(RECORDINGS_BUCKET)
      .upload(path, bytes, { contentType: 'audio/mpeg', upsert: true });
    if (error) {
      console.error(`[maqsam-ingest] recording upload failed for call ${maqsamId}:`, error.message);
      return null;
    }
    const { data } = supa.storage.from(RECORDINGS_BUCKET).getPublicUrl(path);
    return data.publicUrl ?? null;
  } catch (err) {
    console.error(`[maqsam-ingest] recording re-host failed for call ${maqsamId}:`, err);
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
    console.error('[maqsam-ingest] client phone lookup failed:', error.message);
    return null;
  }
  return (data as string | null) ?? null;
}

/**
 * Maqsam sends the handling agent's EMAIL (unlike Hatif, which only sends a
 * name) — so the agent→app-user match is a straight email compare against the
 * active roster, with a normalized-name fallback.
 */
async function findAgentUserId(agents: MaqsamCall['agents']): Promise<string | null> {
  const first = (agents ?? []).find((a) => a && (a.email || a.name));
  if (!first) return null;
  const supa = getServiceSupabase();
  const { data, error } = await supa
    .from('users')
    .select('id,email,name_en,name_ar')
    .eq('is_active', true);
  if (error || !data) {
    if (error) console.error('[maqsam-ingest] active-users load failed:', error.message);
    return null;
  }
  const norm = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (first.email) {
    const e = norm(first.email);
    const byEmail = data.find((u) => norm(u.email as string | null) === e);
    if (byEmail) return byEmail.id as string;
  }
  if (first.name) {
    const n = norm(first.name);
    const byName = data.find(
      (u) => norm(u.name_en as string | null) === n || norm(u.name_ar as string | null) === n,
    );
    if (byName) return byName.id as string;
  }
  return null;
}

/**
 * Upsert one Maqsam call into call_logs + phone_calls. `rawEvent` is whatever
 * triggered the ingest (webhook body or API object) — kept for forensics.
 */
export async function ingestMaqsamCall(
  call: MaqsamCall,
  rawEvent: unknown,
): Promise<MaqsamIngestResult> {
  const maqsamId = String(call.id);
  const id = await maqsamCallUuid(maqsamId);

  // Internal agent↔agent calls are not customer calls — skip them entirely so
  // they don't pollute Call History / workflows.
  if ((call.type ?? '').toLowerCase() === 'internal') {
    return { id, maqsamId, skipped: 'internal' };
  }

  const direction = mapMaqsamDirection(call.type);
  const status = mapMaqsamStatus(call.state);
  const sentiment = mapMaqsamSentiment(call.sentiment);

  const customerRaw =
    (direction === 'inbound' ? call.callerNumber : call.calleeNumber) ??
    call.callerNumber ?? call.calleeNumber ?? null;
  const contactPhone = normalizePhoneE164(customerRaw);

  const creationTime = callTimestamp(call);
  const text = transcriptionText(call);
  const agentName = (call.agents ?? []).map((a) => a?.name).find((n) => n) ?? null;

  // Recording: only completed/serviced calls can have one; skip the round-trip otherwise.
  const recordingUrl = status === 'completed' ? await rehostRecording(maqsamId) : null;

  const supa = getServiceSupabase();
  const logRow = {
    id,
    workspace_id: null,
    channel_id: MAQSAM_CHANNEL_ID,
    provider: 'maqsam',
    direction,
    status,
    caller_number: call.callerNumber ?? null,
    callee_number: call.calleeNumber ?? null,
    contact_phone: contactPhone,
    contact_id: null,
    agent_user_id: null,               // Maqsam ids are not UUIDs; email match handles attribution
    agent_name: agentName,
    ai_agent_id: null,
    pickup_time: null,
    hangup_time: null,
    duration_seconds: typeof call.duration === 'number' ? call.duration : null,
    recording_url: recordingUrl,
    summary: call.summary ?? null,
    sentiment,
    transcription: text ? { text } : null,
    evaluation_criteria_result: null,
    dtmf_digit: null,
    dtmf_label: null,
    raw_event: (rawEvent ?? { maqsamId }) as Record<string, unknown>,
    creation_time: creationTime,
  };
  const { error: logError } = await supa.from('call_logs').upsert(logRow, { onConflict: 'id' });
  if (logError) throw new Error(`call_logs upsert: ${logError.message}`);

  // phone_calls record mirror — isolated failure domain, same as the Hatif path.
  try {
    const modelId = await findPhoneCallsModelId();
    if (!modelId) {
      console.warn('[maqsam-ingest] phone_calls model not found; skipping record mirror');
      return { id, maqsamId };
    }
    const clientRecordId = contactPhone ? await findClientRecordIdByPhone(contactPhone) : null;
    const agentUserId = await findAgentUserId(call.agents);

    const data: Record<string, unknown> = {
      call_id: id,
      provider: 'maqsam',
      maqsam_call_id: maqsamId,
      direction,
      status,
      customer_phone: contactPhone,
      duration_seconds: typeof call.duration === 'number' ? call.duration : null,
      call_time: creationTime,
      agent_name: agentUserId,
      sentiment,
      ai_summary: call.summary ?? null,
      transcription_text: text,
      recording_url: recordingUrl,
      ...(clientRecordId ? { client_link: clientRecordId } : {}),
    };
    // Last-writer-wins like the Hatif webhook (see its Audit C3 note) — every
    // ingest carries the provider's latest authoritative state of the call.
    const { error } = await supa.rpc('record_save', {
      p_model_id: modelId,
      p_id: id,
      p_data: data,
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error('[maqsam-ingest] phone_calls record upsert failed:', err);
  }

  return { id, maqsamId };
}
