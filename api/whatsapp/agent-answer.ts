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
 * Officer questions and visit checks (asked_to='officer' or visit_day set —
 * api/_lib/salesAgent/officerQuestions.ts) are the rep's tracked tasks:
 *   answer = the OFFICER's answer as the rep recorded it; the agent relays it.
 *   A visit check also needs `visit_outcome`:
 *     'confirmed'     → the visit is BOOKED now (appointment + confirmation call),
 *                       optionally at `visit_time` (HH:MM) the project gave;
 *     'not_available' → nothing is booked; the agent offers another day.
 *   'dismiss' on these = the officer never answered / the check is cancelled:
 *   the agent tells the customer it could not be confirmed.
 *   An answer is saved even when the AI is stopped in the chat (the booking
 *   must not depend on the AI) — then nothing is relayed and the rep is told
 *   to inform the customer.
 *
 * Gate: the caller must be able to SEE the question (RLS mirrors the chat).
 * Only an OPEN question can be resolved — two reps answering at once produce
 * one answer, not two messages.
 */
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonOk, jsonError } from '../_lib/auth.js';
import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { activeAgentConversation, enqueueAgentTurn, startAgentConversation } from '../_lib/salesAgent/conversation.js';
import { bookVisit, type VisitSlot } from '../_lib/salesAgent/escalation.js';

export const config = { runtime: 'edge' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async (user) => {
    let body: { question_id?: string; action?: string; answer?: string; save_as_fact?: boolean; visit_outcome?: string; visit_time?: string };
    try { body = (await req.json()) as typeof body; }
    catch { return jsonError(400, 'invalid JSON body'); }
    const id = body.question_id ?? '';
    const action = body.action ?? '';
    if (!UUID_RE.test(id)) return jsonError(400, 'question_id is required');
    if (!['answer', 'direct', 'dismiss'].includes(action)) return jsonError(400, 'action must be answer, direct or dismiss');
    const answer = (body.answer ?? '').trim();
    if (action === 'answer' && !answer) return jsonError(400, 'answer is required');
    if (answer.length > 1500) return jsonError(400, 'answer too long (max 1500 characters)');
    const visitOutcome = body.visit_outcome === 'confirmed' || body.visit_outcome === 'not_available' ? body.visit_outcome : null;
    const visitTime = typeof body.visit_time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(body.visit_time) ? body.visit_time : null;

    const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !anon) return jsonError(500, 'Supabase env missing');
    const scoped = createClient(url, anon, {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: q, error: qErr } = await scoped.from('wa_agent_questions')
      .select('id, chat_wid, status, project_id, asked_to, officer_name, visit_day, visit_slot, visit_time').eq('id', id).maybeSingle();
    if (qErr) return jsonError(500, `question lookup failed: ${qErr.message}`);
    if (!q) return jsonError(403, 'question not found or not permitted');
    const question = q as {
      id: string; chat_wid: string; status: string; project_id: string | null; asked_to: string | null; officer_name: string | null;
      visit_day: string | null; visit_slot: string | null; visit_time: string | null;
    };
    const isVisit = !!question.visit_day;
    // A task the rep tracks for the PROJECT (officer question / visit check):
    // its answer is saved even when the AI is stopped.
    const isProjectTask = isVisit || question.asked_to === 'officer';
    if (isVisit && action !== 'dismiss' && !visitOutcome) return jsonError(400, 'visit_outcome is required (confirmed or not_available)');

    const svc = getServiceSupabase();
    const { data: appUser } = await svc.from('users').select('id').eq('auth_uid', user.userId).maybeSingle();
    const me = (appUser as { id?: string } | null)?.id ?? null;
    const now = new Date().toISOString();

    // The agent must be allowed to speak in this chat to pass the answer on.
    let aiBlocked: 'ai_paused' | 'ai_disabled' | null = null;
    if (action === 'answer') {
      const { data: gate, error: gErr } = await svc.rpc('whatsapp_ai_should_reply', { p_chat_wid: question.chat_wid });
      if (gErr) return jsonError(500, `gate check failed: ${gErr.message}`);
      const g = (Array.isArray(gate) ? gate[0] : gate) as { reason?: string } | null;
      if (g?.reason === 'paused_by_rep') aiBlocked = 'ai_paused';
      else if (g?.reason === 'disabled' || g?.reason === 'disabled_globally_despite_takeover') aiBlocked = 'ai_disabled';
      if (aiBlocked && !isProjectTask) return jsonError(409, aiBlocked);
    }

    const visitCols = isVisit && action !== 'dismiss' ? { visit_confirmed: visitOutcome === 'confirmed', ...(visitTime ? { visit_time: visitTime } : {}) } : {};
    const patch = action === 'answer'
      ? {
        status: 'answered', answer, answered_by_user_id: me, answered_at: now, save_as_fact: body.save_as_fact === true && !!question.project_id,
        // Nothing to relay while the AI is stopped — the rep tells the customer.
        ...(aiBlocked ? { relayed_at: now } : {}), ...visitCols,
      }
      : action === 'direct'
        ? { status: 'answered_directly', answered_by_user_id: me, answered_at: now, ...(answer ? { answer } : {}), ...visitCols }
        : { status: 'dismissed', answered_by_user_id: me, answered_at: now };
    // Only an OPEN question: the second of two simultaneous answers changes nothing.
    const { data: upd, error: uErr } = await svc.from('wa_agent_questions').update(patch).eq('id', id).eq('status', 'open').select('id');
    if (uErr) return jsonError(500, `could not save: ${uErr.message}`);
    if (!upd || upd.length === 0) return jsonError(409, 'already_resolved');

    // A confirmed visit is booked NOW — the one place an agent-arranged visit
    // becomes an appointment. A failed booking reopens the task and says why.
    let appointmentId: string | null = null;
    if (isVisit && action !== 'dismiss' && visitOutcome === 'confirmed' && question.project_id && question.visit_day) {
      try {
        const { data: pr, error: pErr } = await svc.from('unified_records').select('data').eq('id', question.project_id).maybeSingle();
        if (pErr) throw new Error(`project read failed: ${pErr.message}`);
        const pd = ((pr as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
        const projectName = String(pd.project_name ?? pd.name ?? '');
        const r = await bookVisit(svc, question.chat_wid, {
          projectId: question.project_id, projectName, day: question.visit_day,
          slot: (question.visit_slot as VisitSlot | null) ?? null, time: visitTime ?? question.visit_time,
          confirmation: { by: question.officer_name ? `المسؤول ${question.officer_name}` : 'المشروع', answer: answer || 'أكّد الزيارة' },
        });
        if (!r.ok) throw new Error(r.error);
        appointmentId = r.appointmentId;
        const { error: aErr } = await svc.from('wa_agent_questions').update({ booked_appointment_id: appointmentId }).eq('id', id);
        if (aErr) console.error(`[agent-answer] booked ${appointmentId} but could not link it to question ${id}: ${aErr.message}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[agent-answer] visit booking failed for question ${id}:`, msg);
        const { error: rErr } = await svc.from('wa_agent_questions')
          .update({ status: 'open', answer: null, answered_by_user_id: null, answered_at: null, relayed_at: null, visit_confirmed: null }).eq('id', id);
        if (rErr) console.error(`[agent-answer] could not reopen question ${id} after the failed booking: ${rErr.message}`);
        return jsonError(409, `visit_not_booked: ${msg}`);
      }
    }

    if (action === 'direct') return jsonOk({ status: patch.status, appointment_id: appointmentId });
    if (aiBlocked) return jsonOk({ status: 'answered', relaying: false, reason: aiBlocked, appointment_id: appointmentId });
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
    return jsonOk({ status: 'answered', relaying: true, appointment_id: appointmentId });
  });
}
