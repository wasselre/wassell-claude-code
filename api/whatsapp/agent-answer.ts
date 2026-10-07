/**
 * POST /api/whatsapp/agent-answer — a rep resolves a question the sales agent
 * asked (wa_agent_questions).
 *
 * Body: { question_id, action, answer?, save_as_fact? }
 *   action 'answer'   → store the rep's answer; the agent passes it on to the
 *                       customer in its own voice (a turn is queued now).
 *                       `save_as_fact` keeps the answer as a fact of that
 *                       project, so the agent knows it next time.
 *   action 'direct'   → the rep answered the customer themselves; close it.
 *   action 'dismiss'  → not a real question; close it, nothing is sent.
 *
 * Gate: the caller must be able to SEE the question (RLS mirrors the chat).
 * Only an OPEN question can be resolved — two reps answering at once produce
 * one answer, not two messages.
 */
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonOk, jsonError } from '../_lib/auth.js';
import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { activeAgentConversation, enqueueAgentTurn, startAgentConversation } from '../_lib/salesAgent/conversation.js';

export const config = { runtime: 'edge' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async (user) => {
    let body: { question_id?: string; action?: string; answer?: string; save_as_fact?: boolean };
    try { body = (await req.json()) as typeof body; }
    catch { return jsonError(400, 'invalid JSON body'); }
    const id = body.question_id ?? '';
    const action = body.action ?? '';
    if (!UUID_RE.test(id)) return jsonError(400, 'question_id is required');
    if (!['answer', 'direct', 'dismiss'].includes(action)) return jsonError(400, 'action must be answer, direct or dismiss');
    const answer = (body.answer ?? '').trim();
    if (action === 'answer' && !answer) return jsonError(400, 'answer is required');
    if (answer.length > 1500) return jsonError(400, 'answer too long (max 1500 characters)');

    const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !anon) return jsonError(500, 'Supabase env missing');
    const scoped = createClient(url, anon, {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: q, error: qErr } = await scoped.from('wa_agent_questions').select('id, chat_wid, status, project_id').eq('id', id).maybeSingle();
    if (qErr) return jsonError(500, `question lookup failed: ${qErr.message}`);
    if (!q) return jsonError(403, 'question not found or not permitted');
    const question = q as { id: string; chat_wid: string; status: string; project_id: string | null };

    const svc = getServiceSupabase();
    const { data: appUser } = await svc.from('users').select('id').eq('auth_uid', user.userId).maybeSingle();
    const me = (appUser as { id?: string } | null)?.id ?? null;
    const now = new Date().toISOString();

    if (action === 'answer') {
      // The agent must be allowed to speak in this chat to pass the answer on.
      const { data: gate, error: gErr } = await svc.rpc('whatsapp_ai_should_reply', { p_chat_wid: question.chat_wid });
      if (gErr) return jsonError(500, `gate check failed: ${gErr.message}`);
      const g = (Array.isArray(gate) ? gate[0] : gate) as { reason?: string } | null;
      if (g?.reason === 'paused_by_rep') return jsonError(409, 'ai_paused');
      if (g?.reason === 'disabled' || g?.reason === 'disabled_globally_despite_takeover') return jsonError(409, 'ai_disabled');
    }

    const patch = action === 'answer'
      ? { status: 'answered', answer, answered_by_user_id: me, answered_at: now, save_as_fact: body.save_as_fact === true && !!question.project_id }
      : action === 'direct'
        ? { status: 'answered_directly', answered_by_user_id: me, answered_at: now }
        : { status: 'dismissed', answered_by_user_id: me, answered_at: now };
    // Only an OPEN question: the second of two simultaneous answers changes nothing.
    const { data: upd, error: uErr } = await svc.from('wa_agent_questions').update(patch).eq('id', id).eq('status', 'open').select('id');
    if (uErr) return jsonError(500, `could not save: ${uErr.message}`);
    if (!upd || upd.length === 0) return jsonError(409, 'already_resolved');
    if (action === 'direct') return jsonOk({ status: patch.status });
    // Dismissed: the agent may have told the customer «بتأكد لك وأرد عليك» — queue
    // a turn so it tells them it couldn't confirm (turn.ts closed questions).
    // Only while the agent is running the chat; never reopen an ended one for it.
    if (action === 'dismiss') {
      try {
        if (await activeAgentConversation(svc, question.chat_wid)) await enqueueAgentTurn(svc, question.chat_wid);
      } catch (e) {
        console.error('[agent-answer] dismiss follow-up enqueue failed:', e instanceof Error ? e.message : String(e));
      }
      return jsonOk({ status: patch.status });
    }

    // Queue the turn that passes the answer on.
    try {
      if (await activeAgentConversation(svc, question.chat_wid)) {
        await enqueueAgentTurn(svc, question.chat_wid);
      } else {
        // The conversation had ended: reopen it without re-answering old messages,
        // then run the relay turn.
        await startAgentConversation(svc, { chatWid: question.chat_wid, source: 'inbound', adProjectId: null, text: '', lang: 'ar', answerNow: false });
        await enqueueAgentTurn(svc, question.chat_wid);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[agent-answer] relay enqueue failed:', msg);
      return jsonError(500, `answer saved but the relay could not be queued: ${msg}`);
    }
    return jsonOk({ status: 'answered', relaying: true });
  });
}
