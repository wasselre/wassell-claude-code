/**
 * POST /api/whatsapp/ai-send
 *
 * The one send path for the WhatsApp AI agent (the headless session, the basic
 * responder's manual/testing callers). Thin wrapper over the shared
 * `enqueueAiReply` (gate re-check + device resolve + scheduled-send enqueue +
 * audit). Auth: `x-wassel-ai-secret` === WHATSAPP_AI_SECRET.
 *
 * Body: { chat_wid, body, device_id?, job_id?, force? }
 *   - `force: true` skips the gate. ONLY for operator smoke tests; never from the skill.
 *
 * The outbound chat_messages row is NOT written here — WhatsApp echoes our own
 * send back through the webhook (fromMe:true), which writes it.
 */

import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { enqueueAiReply } from '../_lib/aiSend.js';

export const config = { runtime: 'edge' };

interface Body { chat_wid?: string; body?: string; device_id?: string; job_id?: string; force?: boolean }

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'GET') return json({ ok: true, hint: 'POST { chat_wid, body } with x-wassel-ai-secret' });
  if (req.method !== 'POST') return json({ error: `Method ${req.method} not allowed` }, 405);

  const secret = process.env.WHATSAPP_AI_SECRET;
  if (!secret) return json({ error: 'WHATSAPP_AI_SECRET not configured' }, 500);
  if (!constantTimeEqual(req.headers.get('x-wassel-ai-secret') ?? '', secret)) return json({ error: 'unauthorized' }, 401);

  let input: Body;
  try { input = (await req.json()) as Body; } catch { return json({ error: 'invalid JSON body' }, 400); }

  const res = await enqueueAiReply(getServiceSupabase(), {
    chatWid: input.chat_wid ?? '',
    text: input.body ?? '',
    deviceId: input.device_id,
    jobId: input.job_id,
    force: input.force,
  });

  if (res.blocked) return json({ sent: false, blocked: true, reason: res.reason });
  if (res.error) {
    // Validation-shaped errors → 400; device/config → 500; enqueue → 502.
    const status = /required|too long|unsupported/.test(res.error) ? 400
      : res.error.includes('no active') ? 500 : 502;
    return json({ error: res.error }, status);
  }
  return json({ queued: res.queued, sent: res.sent, delivery: 'queued', wid: res.wid, chat_wid: input.chat_wid, audit_ok: res.audit_ok });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
