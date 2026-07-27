/**
 * POST /api/whatsapp/ai-handover
 *
 * "Let the AI handle this chat" — the button in the chat header. A rep is
 * explicitly inviting the agent in, so this enqueues with `force`, which skips
 * the working-hours and human-active gates (those exist to stop the AI acting
 * UNINVITED). The kill switch and the per-chat reply cap still apply.
 *
 * Body: { chat_wid }  — or { chat_record_id }.
 *
 * Auth: the caller's JWT. We gate on being able to SEE the chat record under
 * RLS before using service role to enqueue.
 */

import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonOk, jsonError } from '../_lib/auth.js';
import { getServiceSupabase } from '../_lib/supabaseServer.js';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async () => {
    let body: { chat_wid?: string; chat_record_id?: string };
    try { body = (await req.json()) as typeof body; }
    catch { return jsonError(400, 'invalid JSON body'); }

    const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !anon) return jsonError(500, 'Supabase env missing');
    const scoped = createClient(url, anon, {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });

    // Resolve + authorize in one step: if RLS hides the chat, this returns null.
    let q = scoped.from('records').select('id, data');
    q = body.chat_record_id ? q.eq('id', body.chat_record_id) : q.eq('data->>wid', body.chat_wid ?? '');
    const { data: chat, error } = await q.maybeSingle();
    if (error) return jsonError(500, `chat lookup failed: ${error.message}`);
    if (!chat) return jsonError(403, 'chat not found or not permitted');

    const d = (chat.data ?? {}) as Record<string, unknown>;
    const chatWid = (d.wid as string) ?? body.chat_wid ?? '';
    if (!chatWid) return jsonError(400, 'chat has no wid');
    const digits = chatWid.split('@')[0] ?? '';

    const { data: jobId, error: rpcErr } = await getServiceSupabase().rpc('whatsapp_ai_enqueue', {
      p_chat_wid: chatWid,
      p_chat_record_id: chat.id,
      p_phone: (d.phone as string) ?? `+${digits}`,
      p_device_id: (d.device_id as string) ?? 'sales',
      p_trigger_message: 'تحويل يدوي من المندوب',
      p_force: true,
    });
    if (rpcErr) return jsonError(500, `enqueue failed: ${rpcErr.message}`);
    if (!jobId) {
      // Null means the kill switch is off or the chat hit its reply cap — both
      // are normal states the rep needs told, not errors.
      return jsonOk({
        queued: false,
        reason: 'المساعد الذكي متوقف أو وصل الحد الأقصى للردود في هذه المحادثة',
      });
    }
    return jsonOk({ queued: true, job_id: jobId });
  });
}
