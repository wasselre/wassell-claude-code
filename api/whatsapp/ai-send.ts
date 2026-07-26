/**
 * POST /api/whatsapp/ai-send
 *
 * The ONE send path for the WhatsApp AI agent — i.e. for the headless Claude
 * Code session that the runner spawns for a `whatsapp_reply` job. The session
 * has no WAHA credentials and no user JWT; it authenticates with a shared
 * secret and this endpoint does the rest.
 *
 * Why an endpoint instead of letting the session call WAHA directly:
 *   1. WAHA_URL / WAHA_API_KEY stay server-side (the session runs on a laptop).
 *   2. The gate is re-checked HERE, immediately before sending. A session can
 *      take a minute to think; if a human replied in the meantime, or someone
 *      flipped the kill switch, the message must NOT go out.
 *   3. Every AI-sent message is recorded in `whatsapp_ai_replies`, which is
 *      also what makes "a human replied" detectable (an outbound message NOT
 *      in that table).
 *
 * Auth: `x-wassel-ai-secret` header === WHATSAPP_AI_SECRET.
 *
 * Body: { chat_wid, body, device_id?, job_id?, force? }
 *   - `force: true` skips the gate. ONLY for the operator's own smoke tests;
 *     never set it from the agent skill.
 *
 * The outbound `chat_messages` row is NOT written here — WhatsApp echoes our
 * own send back through the `message.any` webhook with fromMe:true, which
 * writes it. Writing it here too would duplicate the row.
 */

import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { sendMessage, resolveDefaultDeviceId } from '../_lib/whatsappGateway.js';

// EDGE, not nodejs: this handler is Web-API shaped (Request in, Response out).
// Vercel's nodejs runtime hands the function (IncomingMessage, ServerResponse)
// and ignores a returned Response — the request then hangs until the gateway
// times out (verified live 2026-07-26: 20s, no response). Either adapt like
// api/whatsapp/send-media-batch.ts, or run on edge. Edge is right here — the
// work is one gate check + one fetch, no Node APIs.
export const config = {
  runtime: 'edge',
};

interface Body {
  chat_wid?: string;
  body?: string;
  device_id?: string;
  job_id?: string;
  force?: boolean;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    return json({ ok: true, hint: 'POST { chat_wid, body } with x-wassel-ai-secret' });
  }
  if (req.method !== 'POST') return json({ error: `Method ${req.method} not allowed` }, 405);

  const secret = process.env.WHATSAPP_AI_SECRET;
  if (!secret) return json({ error: 'WHATSAPP_AI_SECRET not configured' }, 500);
  if (!constantTimeEqual(req.headers.get('x-wassel-ai-secret') ?? '', secret)) {
    return json({ error: 'unauthorized' }, 401);
  }

  let input: Body;
  try {
    input = (await req.json()) as Body;
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const chatWid = (input.chat_wid ?? '').trim();
  const text = (input.body ?? '').trim();
  if (!chatWid) return json({ error: 'chat_wid is required' }, 400);
  if (!text) return json({ error: 'body is required' }, 400);
  if (text.length > 4000) return json({ error: 'body too long (max 4000 chars)' }, 400);

  const supa = getServiceSupabase();

  // Re-check the gate at send time (see header comment #2).
  if (input.force !== true) {
    const { data, error } = await supa.rpc('whatsapp_ai_should_reply', { p_chat_wid: chatWid });
    if (error) return json({ error: `gate check failed: ${error.message}` }, 500);
    const row = Array.isArray(data) ? data[0] : data;
    const allowed = (row as { should_reply?: boolean } | null)?.should_reply === true;
    if (!allowed) {
      const reason = (row as { reason?: string } | null)?.reason ?? 'blocked';
      // 200, not an error: "a human took over" is a normal outcome the session
      // should accept and stop on, not retry.
      return json({ sent: false, blocked: true, reason });
    }
  }

  // chat_wid is "<digits>@c.us" → phone.
  const digits = chatWid.split('@')[0] ?? '';
  if (!/^\d{8,15}$/.test(digits)) return json({ error: `unsupported chat_wid: ${chatWid}` }, 400);

  const deviceId = input.device_id || (await resolveDefaultDeviceId());
  if (!deviceId) return json({ error: 'no WhatsApp device configured' }, 500);

  // Send via the SCHEDULED QUEUE, not a direct WAHA call.
  //
  // WAHA refuses Vercel's egress with 403 while accepting the Fly worker and
  // operator machines (verified live 2026-07-26: identical API key, direct call
  // 200, from a Vercel function 403 — it is network-level, not credentials).
  // The worker drains this queue every few seconds and owns the only working
  // path to WAHA, so an AI reply lands within ~5s instead of failing outright.
  // If the firewall is ever opened to Vercel, this can go back to a direct
  // sendMessage() — the import is kept for that day.
  void sendMessage;
  const { data: schedId, error: schedErr } = await supa.rpc('scheduled_whatsapp_enqueue', {
    p_device_id: deviceId,
    p_chat_wid: chatWid,
    p_phone: `+${digits}`,
    p_body: text,
    p_media: null,
    p_reference: `ai:${input.job_id ?? 'manual'}:${Date.now()}`,
    p_deliver_at: new Date().toISOString(),
    p_user_id: null,
  });
  if (schedErr) {
    console.error('[whatsapp-ai-send] enqueue failed:', schedErr.message);
    return json({ error: `enqueue failed: ${schedErr.message}` }, 502);
  }
  // The real message id only exists once the worker sends; the audit row is
  // keyed by the queue job and matched to the outbound echo on (chat, body).
  const wid = `sched:${String(schedId)}`;

  // Audit + the human-vs-AI discriminator. Best-effort: a failed insert must
  // not make the session think the message never went out (it did) — but it
  // MUST be loud, because a missing row makes this message look human-sent and
  // would suppress future AI replies in that chat.
  const { error: auditErr } = await supa.from('whatsapp_ai_replies').insert({
    message_wid: wid,
    chat_wid: chatWid,
    job_id: input.job_id ?? null,
    body: text.slice(0, 2000),
  });
  if (auditErr) {
    console.error('[whatsapp-ai-send] AUDIT INSERT FAILED — this message will look human-sent:', auditErr.message, wid);
  }

  return json({ sent: true, wid, chat_wid: chatWid, audit_ok: !auditErr });
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
