/**
 * GET /api/officer-messages — what we sent project officers, for people.
 *
 *   ?client_id=<uuid>   → every message sent to an officer about this client
 *                         (the client's Portals tab, «رسائل المسؤولين»): interest
 *                         notices, registration notices, questions and visit
 *                         checks with their task status + answer, reminders, and
 *                         messages sent by hand from a chat. Source: ai_actions
 *                         (kind officer_notice) — every officer message is logged
 *                         there (officerQuestions.ts, notify-officer.ts, the
 *                         automation cron).
 *   ?question_id=<uuid> → an officer question's thread: our message and
 *                         everything in that officer's chat since, so the rep
 *                         sees his reply inside the task without opening the
 *                         operations line.
 *
 * Gate: the caller must be able to SEE the client (records RLS) or the question
 * (wa_agent_questions RLS mirrors the chat). Rows are then read with the
 * service role — officer chats live on the operations line, which reps cannot
 * browse directly.
 */
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonOk, jsonError } from './_lib/auth.js';
import { getServiceSupabase } from './_lib/supabaseServer.js';

export const config = { runtime: 'edge' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What kind of officer message a log row is. */
export type OfficerMessageKind = 'interest' | 'registration' | 'visit_check' | 'question' | 'negotiation' | 'reminder' | 'manual';

function kindOf(reference: string | null, trigger: unknown): OfficerMessageKind {
  if (trigger === 'manual') return 'manual';
  if (trigger === 'reminder') return 'reminder';
  if (trigger === 'visit_check') return 'visit_check';
  if (trigger === 'visit_question') return 'question';
  if (trigger === 'negotiation_handoff') return 'negotiation';
  if (trigger === 'portal_registered' || (reference ?? '').startsWith('officer_notice:portal_job:')) return 'registration';
  return 'interest';
}

interface ActionRow {
  id: string; status: string; created_at: string; sent_at: string | null; decided_at: string | null; error: string | null;
  body: string; reference: string | null; project_id: string | null; officer_id: string | null; scheduled_job_id: string | null;
  chat_wid: string | null; context: Record<string, unknown> | null;
}
interface QuestionRow {
  id: string; status: string; answer: string | null; answered_at: string | null; question: string; due_at: string | null;
  reminded_at: string | null; visit_day: string | null; visit_slot: string | null; visit_time: string | null; visit_confirmed: boolean | null;
  booked_appointment_id: string | null; officer_action_id: string | null;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return jsonError(405, `Method ${req.method} not allowed`);
  return withAuth(req, async () => {
    const params = new URL(req.url).searchParams;
    const clientId = params.get('client_id') ?? '';
    const questionId = params.get('question_id') ?? '';
    if (!UUID_RE.test(clientId) && !UUID_RE.test(questionId)) return jsonError(400, 'client_id or question_id is required');

    const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anon = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !anon) return jsonError(500, 'Supabase env missing');
    const scoped = createClient(url, anon, {
      auth: { persistSession: false },
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const svc = getServiceSupabase();

    // ── One question's thread ─────────────────────────────────────────────
    if (UUID_RE.test(questionId)) {
      const { data: q, error: qErr } = await scoped.from('wa_agent_questions')
        .select('id, officer_phone, officer_action_id, sent_at, created_at').eq('id', questionId).maybeSingle();
      if (qErr) return jsonError(500, `question lookup failed: ${qErr.message}`);
      if (!q) return jsonError(403, 'question not found or not permitted');
      const row = q as { officer_phone: string | null; officer_action_id: string | null; sent_at: string | null; created_at: string };
      let wid: string | null = null;
      if (row.officer_action_id) {
        const { data: act, error: aErr } = await svc.from('ai_actions').select('chat_wid').eq('id', row.officer_action_id).maybeSingle();
        if (aErr) return jsonError(500, `message lookup failed: ${aErr.message}`);
        wid = (act as { chat_wid?: string | null } | null)?.chat_wid ?? null;
      }
      if (!wid) return jsonOk({ thread: [] });
      const since = new Date(new Date(row.sent_at ?? row.created_at).getTime() - 60_000).toISOString();
      const { data: msgs, error: mErr } = await svc.from('chat_messages')
        .select('id, date, flow, kind, body, media_caption, transcript, ack').eq('chat_wid', wid).gte('date', since)
        .order('date', { ascending: true }).limit(40);
      if (mErr) return jsonError(500, `officer chat read failed: ${mErr.message}`);
      return jsonOk({
        thread: ((msgs ?? []) as Array<{ id: string; date: string; flow: string; kind: string; body: string | null; media_caption: string | null; transcript: string | null; ack: string | null }>)
          .map((m) => ({ id: m.id, at: m.date, from_officer: m.flow === 'in', text: m.body || m.media_caption || m.transcript || (m.kind !== 'text' ? `[${m.kind}]` : ''), ack: m.ack })),
      });
    }

    // ── A client's officer messages ───────────────────────────────────────
    const { data: visible, error: vErr } = await scoped.from('unified_records').select('id').eq('id', clientId).maybeSingle();
    if (vErr) return jsonError(500, `client lookup failed: ${vErr.message}`);
    if (!visible) return jsonError(403, 'client not found or not permitted');

    const { data: acts, error: aErr } = await svc.from('ai_actions')
      .select('id, status, created_at, sent_at, decided_at, error, body, reference, project_id, officer_id, scheduled_job_id, chat_wid, context')
      .eq('kind', 'officer_notice').eq('client_id', clientId).order('created_at', { ascending: false }).limit(200);
    if (aErr) return jsonError(500, `officer messages read failed: ${aErr.message}`);
    const rows = (acts ?? []) as ActionRow[];
    const ids = rows.map((r) => r.id);

    // The task each question message belongs to (the question row links its first message;
    // a reminder carries the question id in its context).
    const questionIds = new Set<string>();
    for (const r of rows) { const qid = r.context?.question_id; if (typeof qid === 'string' && UUID_RE.test(qid)) questionIds.add(qid); }
    const [qByAction, qById] = [new Map<string, QuestionRow>(), new Map<string, QuestionRow>()];
    if (ids.length || questionIds.size) {
      const cols = 'id, status, answer, answered_at, question, due_at, reminded_at, visit_day, visit_slot, visit_time, visit_confirmed, booked_appointment_id, officer_action_id';
      const [byAction, byId] = await Promise.all([
        ids.length ? svc.from('wa_agent_questions').select(cols).in('officer_action_id', ids) : Promise.resolve({ data: [], error: null }),
        questionIds.size ? svc.from('wa_agent_questions').select(cols).in('id', [...questionIds]) : Promise.resolve({ data: [], error: null }),
      ]);
      if (byAction.error) return jsonError(500, `questions read failed: ${byAction.error.message}`);
      if (byId.error) return jsonError(500, `questions read failed: ${byId.error.message}`);
      for (const q of (byAction.data ?? []) as QuestionRow[]) if (q.officer_action_id) qByAction.set(q.officer_action_id, q);
      for (const q of (byId.data ?? []) as QuestionRow[]) qById.set(q.id, q);
    }

    // Project names.
    const projectIds = [...new Set(rows.map((r) => r.project_id).filter((x): x is string => !!x))];
    const names = new Map<string, string>();
    if (projectIds.length) {
      const { data: ps, error: pErr } = await svc.from('unified_records').select('id, data').in('id', projectIds);
      if (pErr) return jsonError(500, `projects read failed: ${pErr.message}`);
      for (const p of (ps ?? []) as Array<{ id: string; data: Record<string, unknown> }>) {
        names.set(p.id, String(p.data?.project_name ?? p.data?.name ?? ''));
      }
    }

    // Delivery: the queued job's WhatsApp message id → that message's ack.
    const jobIds = rows.map((r) => r.scheduled_job_id).filter((x): x is string => !!x);
    const ackByJob = new Map<string, string>();
    if (jobIds.length) {
      const { data: jobs, error: jErr } = await svc.from('scheduled_whatsapp_jobs').select('id, status, result').in('id', jobIds);
      if (jErr) return jsonError(500, `delivery read failed: ${jErr.message}`);
      const msgToJob = new Map<string, string>();
      for (const j of (jobs ?? []) as Array<{ id: string; status: string; result: { ids?: unknown } | null }>) {
        const first = Array.isArray(j.result?.ids) ? j.result!.ids[0] : null;
        if (typeof first === 'string') msgToJob.set(first, j.id);
        else ackByJob.set(j.id, j.status);
      }
      if (msgToJob.size) {
        const { data: ms, error: mErr } = await svc.from('chat_messages').select('id, ack').in('id', [...msgToJob.keys()]);
        if (mErr) return jsonError(500, `delivery read failed: ${mErr.message}`);
        for (const m of (ms ?? []) as Array<{ id: string; ack: string | null }>) {
          const job = msgToJob.get(m.id);
          if (job && m.ack) ackByJob.set(job, m.ack);
        }
      }
    }

    return jsonOk({
      messages: rows.map((r) => {
        const qid = typeof r.context?.question_id === 'string' ? (r.context.question_id as string) : null;
        const q = qByAction.get(r.id) ?? (qid ? qById.get(qid) : undefined) ?? null;
        return {
          id: r.id,
          kind: kindOf(r.reference, r.context?.trigger),
          status: r.status,
          error: r.error,
          created_at: r.created_at,
          sent_at: r.sent_at,
          officer_name: typeof r.context?.officer_name === 'string' ? r.context.officer_name : null,
          officer_phone: r.chat_wid ? `+${r.chat_wid.split('@')[0]}` : null,
          project_name: r.project_id ? names.get(r.project_id) || null : (typeof r.context?.project_name === 'string' ? r.context.project_name : null),
          body: r.body,
          delivery: r.scheduled_job_id ? ackByJob.get(r.scheduled_job_id) ?? null : null,
          question: q ? {
            id: q.id, status: q.status, answer: q.answer, answered_at: q.answered_at, due_at: q.due_at, reminded_at: q.reminded_at,
            visit_day: q.visit_day, visit_confirmed: q.visit_confirmed, booked_appointment_id: q.booked_appointment_id,
          } : null,
        };
      }),
    });
  });
}
