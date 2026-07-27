/**
 * POST /api/whatsapp/ai-handover
 *
 * TAKEOVER TOGGLE for one conversation — not a one-shot reply.
 *
 * `{ chat_record_id, enabled: true }`  → the agent owns this chat from now on:
 *   every inbound message gets an AI reply until a human turns it back off.
 *   While a chat is AI-managed the global policy does NOT apply (schedule,
 *   automatic-reply switch, don't-talk-over-a-rep, reply cap) — a human
 *   explicitly assigned this conversation, and that outranks the policy.
 *
 * `{ enabled: false }` → hand it back to the humans.
 *
 * Enabling also enqueues one job immediately, so the agent answers whatever is
 * already waiting instead of idling until the customer writes again.
 *
 * Auth: the caller's JWT, gated on being able to SEE the chat under RLS.
 */

import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonOk, jsonError } from '../_lib/auth.js';
import { getServiceSupabase } from '../_lib/supabaseServer.js';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async (user) => {
    let body: { chat_wid?: string; chat_record_id?: string; enabled?: boolean };
    try { body = (await req.json()) as typeof body; }
    catch { return jsonError(400, 'invalid JSON body'); }

    const enabled = body.enabled !== false;   // default true (turning it on)

    const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !anon) return jsonError(500, 'Supabase env missing');
    const scoped = createClient(url, anon, {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });

    // Resolve + authorize together: RLS hiding the chat yields null.
    let q = scoped.from('records').select('id, data');
    q = body.chat_record_id ? q.eq('id', body.chat_record_id) : q.eq('data->>wid', body.chat_wid ?? '');
    const { data: chat, error } = await q.maybeSingle();
    if (error) return jsonError(500, `chat lookup failed: ${error.message}`);
    if (!chat) return jsonError(403, 'chat not found or not permitted');

    const d = (chat.data ?? {}) as Record<string, unknown>;
    const chatWid = (d.wid as string) ?? body.chat_wid ?? '';
    if (!chatWid) return jsonError(400, 'chat has no wid');
    const digits = chatWid.split('@')[0] ?? '';

    const svc = getServiceSupabase();
    const { error: modeErr } = await svc.rpc('whatsapp_ai_set_chat_mode', {
      p_chat_record_id: chat.id,
      p_enabled: enabled,
      p_user_id: user.userId,
    });
    if (modeErr) return jsonError(500, `could not set chat mode: ${modeErr.message}`);

    if (!enabled) return jsonOk({ ai_managed: false });

    // Answer what's already waiting. Forced, so it runs regardless of policy.
    const { data: jobId, error: rpcErr } = await svc.rpc('whatsapp_ai_enqueue', {
      p_chat_wid: chatWid,
      p_chat_record_id: chat.id,
      p_phone: (d.phone as string) ?? `+${digits}`,
      p_device_id: (d.device_id as string) ?? 'sales',
      p_trigger_message: 'تسليم المحادثة للمساعد الذكي',
      p_force: true,
    });
    if (rpcErr) return jsonError(500, `enqueue failed: ${rpcErr.message}`);
    // No job id means one is already running for this chat — the takeover is
    // still on, which is what the rep asked for.
    return jsonOk({ ai_managed: true, job_id: jobId ?? null, already_running: !jobId });
  });
}
