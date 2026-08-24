/**
 * POST /api/whatsapp/ai-notify
 *
 * The WhatsApp AI agent posts an operator-facing notification here — it shows up
 * in the Tasks page "AI notifications" tab. Used when the agent hands a chat off
 * to a human, or wants a person's attention on something it can't handle.
 *
 * Same auth posture as /api/whatsapp/ai-send: a shared secret, because the
 * headless Claude session has no user JWT. Insert goes through service role.
 *
 * Auth: `x-wassel-ai-secret` header === WHATSAPP_AI_SECRET.
 * Body: { body (required), title?, severity?, source?, chat_wid?,
 *         chat_record_id?, client_record_id?, target_user_id?, meta? }
 */

import { getServiceSupabase } from '../_lib/supabaseServer.js';

export const config = { runtime: 'edge' };

interface Body {
  body?: string;
  title?: string;
  severity?: 'info' | 'action' | 'warning';
  source?: string;
  chat_wid?: string;
  chat_record_id?: string;
  client_record_id?: string;
  target_user_id?: string;
  meta?: Record<string, unknown>;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    return json({ ok: true, hint: 'POST { body, title?, severity? } with x-wassel-ai-secret' });
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

  const body = (input.body ?? '').trim();
  if (!body) return json({ error: 'body is required' }, 400);
  if (body.length > 4000) return json({ error: 'body too long (max 4000 chars)' }, 400);
  const severity = input.severity === 'action' || input.severity === 'warning' ? input.severity : 'info';

  const supa = getServiceSupabase();
  const { data, error } = await supa
    .from('ai_notifications')
    .insert({
      source: (input.source ?? 'whatsapp').slice(0, 40),
      severity,
      title: input.title ? input.title.slice(0, 200) : null,
      body: body.slice(0, 4000),
      chat_wid: input.chat_wid ?? null,
      chat_record_id: input.chat_record_id ?? null,
      client_record_id: input.client_record_id ?? null,
      target_user_id: input.target_user_id ?? null,
      meta: input.meta ?? {},
    })
    .select('id')
    .single();

  if (error) {
    console.error('[whatsapp-ai-notify] insert failed:', error.message);
    return json({ error: `insert failed: ${error.message}` }, 502);
  }
  return json({ ok: true, id: data?.id ?? null });
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
