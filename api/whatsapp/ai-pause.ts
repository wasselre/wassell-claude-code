/**
 * POST /api/whatsapp/ai-pause — the per-chat STOP / RESUME switch for the AI.
 *
 * The sales agent answers every customer chat by default. `{ chat_record_id,
 * paused: true }` = a rep pressed «إيقاف المساعد»: the agent (and the basic bot)
 * stay silent in this chat until someone presses «تشغيل المساعد»
 * (`paused: false`). A rep merely typing in the chat does NOT stop the agent —
 * only this switch does (operator rule, 2026-09-30).
 *
 * Resuming answers what is already waiting: if the customer's message is the
 * last thing in the chat, the agent picks it up now instead of idling until
 * they write again.
 *
 * Auth: the caller's JWT, gated on being able to SEE the chat under RLS.
 */
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonOk, jsonError } from '../_lib/auth.js';
import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { agentAllowedFor, loadAgentSettings, startAgentConversation } from '../_lib/salesAgent/conversation.js';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async (user) => {
    let body: { chat_record_id?: string; paused?: boolean };
    try { body = (await req.json()) as typeof body; }
    catch { return jsonError(400, 'invalid JSON body'); }
    if (!body.chat_record_id || typeof body.paused !== 'boolean') return jsonError(400, 'chat_record_id and paused are required');

    const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !anon) return jsonError(500, 'Supabase env missing');
    const scoped = createClient(url, anon, {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    // Resolve + authorize together: RLS hiding the chat yields null.
    const { data: chat, error } = await scoped.from('records').select('id, data').eq('id', body.chat_record_id).maybeSingle();
    if (error) return jsonError(500, `chat lookup failed: ${error.message}`);
    if (!chat) return jsonError(403, 'chat not found or not permitted');
    const d = (chat.data ?? {}) as Record<string, unknown>;
    const chatWid = typeof d.wid === 'string' ? d.wid : '';
    if (!chatWid) return jsonError(400, 'chat has no wid');
    if (chatWid.endsWith('@g.us')) return jsonError(400, 'the AI never answers group chats');

    const svc = getServiceSupabase();
    const { data: appUser } = await svc.from('users').select('id').eq('auth_uid', user.userId).maybeSingle();
    const { error: setErr } = await svc.rpc('whatsapp_ai_set_chat_paused', {
      p_chat_record_id: chat.id, p_paused: body.paused,
      p_user_id: (appUser as { id?: string } | null)?.id ?? null, p_reason: 'rep',
    });
    if (setErr) return jsonError(500, `could not change the AI state: ${setErr.message}`);
    if (body.paused) return jsonOk({ ai_paused: true });

    // Resumed: answer a customer message that is already waiting.
    let answering = false;
    try {
      const settings = await loadAgentSettings(svc);
      const phone = typeof d.phone === 'string' ? d.phone : `+${chatWid.split('@')[0]}`;
      if (agentAllowedFor(settings, phone)) {
        const { data: last, error: lErr } = await svc.from('chat_messages')
          .select('flow, body, transcript').eq('chat_wid', chatWid).order('date', { ascending: false }).limit(1).maybeSingle();
        if (lErr) throw new Error(lErr.message);
        const m = last as { flow: string; body: string | null; transcript: string | null } | null;
        if (m?.flow === 'in') {
          const text = m.body ?? m.transcript ?? '';
          await startAgentConversation(svc, {
            chatWid, source: settings?.agent_mode === 'test' ? 'test' : 'inbound', adProjectId: null,
            text, lang: /[؀-ۿ]/.test(text) || !/[A-Za-z]{2,}/.test(text) ? 'ar' : 'en',
          });
          answering = true;
        }
      }
    } catch (e) {
      // The switch itself succeeded; the agent simply picks up on the next message.
      console.error('[ai-pause] resume pickup failed:', e instanceof Error ? e.message : String(e));
    }
    return jsonOk({ ai_paused: false, answering });
  });
}
