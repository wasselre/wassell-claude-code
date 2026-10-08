/**
 * Questions to a project's OFFICER as tracked tasks (operator, 2026-10-08:
 * "I need a more structured way for these kinds of things, especially
 * questions. I don't like the dependence on AI — make it something like a task
 * we could track").
 *
 * Incident that started it: a customer asked to visit «ربوة الرمز» on Friday
 * "if someone is there". The agent booked the visit at once, promised three
 * times «بتأكد لك وأرد عليك», and its question to the officer waited 7 hours
 * for approval, went out in a batch, was read and never answered — nobody owned
 * it, nobody chased it, and the customer never heard back.
 *
 * Now:
 *   1. A question to an officer is a `wa_agent_questions` row (asked_to =
 *      'officer') owned by the client's rep — it shows in My Tasks next to the
 *      questions the agent asks the rep, with the same answer box and the same
 *      relay (the agent passes the recorded answer on to the customer).
 *   2. The officer gets a FIXED-wording message built from fields (no model
 *      writes it), sent at once on the operations line inside the officer's
 *      hours (09:00–21:00 Riyadh) — no approval step. It is logged in
 *      `ai_actions` (kind officer_notice), which is what the client's Portals
 *      tab lists.
 *   3. A VISIT is a visit check: the agent can no longer book a visit itself.
 *      The visit is booked only when the rep records the officer's
 *      confirmation (api/whatsapp/agent-answer.ts). A project with no officer
 *      gets the same check as a task for the rep.
 *   4. Deadlines (remindOfficerQuestions, run by the automation cron): no
 *      answer by `due_at` (2 working hours) → one fixed reminder to the
 *      officer; still nothing 2 working hours later → the rep is alerted to
 *      call him; a visit check still open the day before the visit → the rep is
 *      alerted.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveProjectOfficers, type CoveringOfficer } from '../projectOfficers.js';
import { localPhone, officerChatWid } from '../officerNoticeDraft.js';
import { officerDeliverAt } from '../officerRegistrationNotice.js';
import { alertRep, ensureClient, loadChatContext, riyadhToday, SLOT_TIME, type ChatContext, type VisitSlot } from './escalation.js';
import { genderFromName } from './nameGender.js';
import { clip } from './clip.js';

const AR_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const HOUR = 3_600_000;
/** How long an officer has to answer, in working hours. */
const ANSWER_WINDOW_MS = 2 * HOUR;

export interface VisitWish { day: string; slot: VisitSlot | null; time: string | null }

// ── PURE wording ─────────────────────────────────────────────────────────────

/** «اليوم» / «بكرة الجمعة» / «يوم الأحد 11 أكتوبر» — `day` and `today` are YYYY-MM-DD. */
export function dayPhrase(day: string, today: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const date = Date.UTC(y, m - 1, d);
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  const diff = Math.round((date - Date.UTC(ty, tm - 1, td)) / (24 * HOUR));
  const weekday = AR_DAYS[new Date(date).getUTCDay()]!;
  if (diff === 0) return 'اليوم';
  if (diff === 1) return `بكرة ${weekday}`;
  return `يوم ${weekday} ${d} ${AR_MONTHS[m - 1]}`;
}

/** «الساعة 4:30 مساءً» for an exact time, «العصر» for a rough one, '' for none. */
export function timePhrase(slot: VisitSlot | null, time: string | null): string {
  const t = time && /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (t) {
    const h = Number(t[1]);
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `الساعة ${h12}:${t[2]} ${h < 12 ? 'صباحاً' : h === 12 ? 'ظهراً' : 'مساءً'}`;
  }
  return slot ? SLOT_TIME[slot]?.ar ?? '' : '';
}

function greeting(officerName: string): string {
  const first = officerName.trim().split(/\s+/)[0] ?? '';
  const sib = genderFromName(officerName) === 'f' ? 'أختي' : 'أخوي';
  return first ? `السلام عليكم ${sib} ${first}،` : 'السلام عليكم،';
}

export interface OfficerMessageInput {
  officerName: string;
  projectName: string;
  clientName: string;
  clientPhone: string;
  question: string | null;
  visit: VisitWish | null;
  today: string;
}

/** The first message to the officer — every word fixed except the fields. */
export function officerQuestionMessage(a: OfficerMessageInput): string {
  const lines = [greeting(a.officerName)];
  if (a.visit) {
    const when = [dayPhrase(a.visit.day, a.today), timePhrase(a.visit.slot, a.visit.time)].filter(Boolean).join(' ');
    lines.push(`عندنا عميل يبي يزور مشروع «${a.projectName}» ${when}${a.visit.time ? '' : '، والوقت مرن'}.`);
    lines.push('فيه أحد بالموقع يستقبله ويوريه المشروع؟ ولين متى الدوام؟');
    if (a.question) lines.push(`وسؤاله كمان: ${a.question}`);
  } else {
    lines.push(`عندنا عميل مهتم بمشروع «${a.projectName}» وعنده سؤال:`);
    lines.push(a.question ?? '');
  }
  lines.push(`العميل: ${a.clientName} — رقمه: ${a.clientPhone}`);
  lines.push('ننتظر ردّك، ويعطيك العافية.');
  return lines.join('\n');
}

/** The one reminder, when the officer has not answered by the deadline. */
export function officerReminderMessage(a: OfficerMessageInput): string {
  const what = a.visit
    ? `يبي يزور مشروع «${a.projectName}» ${[dayPhrase(a.visit.day, a.today), timePhrase(a.visit.slot, a.visit.time)].filter(Boolean).join(' ')} — فيه أحد يستقبله؟`
    : `سؤاله عن مشروع «${a.projectName}»: ${a.question ?? ''}`;
  return `${greeting(a.officerName)}\nنذكّرك بخصوص العميل ${a.clientName} (${a.clientPhone}): ${what}\nننتظر ردّك، ويعطيك العافية.`;
}

/** What the rep's task card says (the `question` column). */
export function taskSummary(a: { projectName: string; question: string | null; visit: VisitWish | null; today: string }): string {
  if (!a.visit) return a.question ?? '';
  const when = [dayPhrase(a.visit.day, a.today), timePhrase(a.visit.slot, a.visit.time)].filter(Boolean).join(' ');
  return `تأكيد زيارة «${a.projectName}» ${when}${a.question ? ` — ${a.question}` : ''}`;
}

/**
 * PURE — the answer deadline: `from` + 2 hours, counted inside the officer's
 * day (09:00–21:00 Riyadh). Past 21:00 it moves to 11:00 the next morning.
 */
export function dueAfter(fromIso: string): string {
  const from = new Date(fromIso).getTime();
  const due = from + ANSWER_WINDOW_MS;
  const localHour = new Date(due + 3 * HOUR).getUTCHours();
  if (localHour >= 9 && localHour < 21) return new Date(due).toISOString();
  const local = new Date(due + 3 * HOUR);
  if (localHour >= 21) local.setUTCDate(local.getUTCDate() + 1);
  local.setUTCHours(11, 0, 0, 0);
  return new Date(local.getTime() - 3 * HOUR).toISOString();
}

function riyadhHour(now: Date): number {
  return new Date(now.getTime() + 3 * HOUR).getUTCHours();
}

// ── Sending + logging ────────────────────────────────────────────────────────

/**
 * Log one officer message in `ai_actions` (status «sending») and queue it on the
 * operations line. `tg_ai_actions_job_sync` flips the row to sent / failed when
 * the job finishes. A queueing failure marks the row failed and THROWS — an
 * officer message is never silently lost.
 */
export async function sendLoggedOfficerMessage(
  svc: SupabaseClient,
  a: {
    clientId: string; projectId: string | null; officer: { id: string | null; name: string; phone: string }; wid: string;
    body: string; reference: string; deliverAt: string; opsDevice: string; context: Record<string, unknown>; decidedBy?: string | null;
  },
): Promise<string> {
  const stamp = new Date().toISOString();
  const { data: ins, error: insErr } = await svc.from('ai_actions').insert({
    kind: 'officer_notice', status: 'sending', client_id: a.clientId, chat_wid: a.wid, project_id: a.projectId,
    officer_id: a.officer.id, phone: `+${a.wid.split('@')[0]}`, device_id: a.opsDevice, body: a.body, original_body: a.body,
    reference: a.reference, decided_at: stamp, decided_by: a.decidedBy ?? null,
    context: { officer_name: a.officer.name, deliver_at: a.deliverAt, ...a.context },
  }).select('id').single();
  if (insErr) throw new Error(`officer message log failed: ${insErr.message}`);
  const actionId = (ins as { id: string }).id;
  const { data: jobId, error: qErr } = await svc.rpc('scheduled_whatsapp_enqueue', {
    p_device_id: a.opsDevice, p_chat_wid: a.wid, p_phone: `+${a.wid.split('@')[0]}`, p_body: a.body,
    p_media: null, p_reference: a.reference, p_deliver_at: a.deliverAt, p_user_id: null,
  });
  if (qErr) {
    const { error: fErr } = await svc.from('ai_actions')
      .update({ status: 'failed', error: `could not queue: ${qErr.message}`, updated_at: new Date().toISOString() }).eq('id', actionId);
    if (fErr) console.error(`[officer-question] could not mark ${actionId} failed: ${fErr.message}`);
    throw new Error(`queueing the officer message failed: ${qErr.message}`);
  }
  if (jobId) {
    const { error: uErr } = await svc.from('ai_actions').update({ scheduled_job_id: jobId as string }).eq('id', actionId);
    if (uErr) console.error(`[officer-question] queued ${actionId} but could not store its job id: ${uErr.message}`);
  }
  return actionId;
}

// ── Asking ───────────────────────────────────────────────────────────────────

export type AskOfficerResult =
  | { ok: true; via: 'officer' | 'rep'; questionId: string; duplicate?: boolean }
  | { ok: false; noOfficer: true }
  | { ok: false; error: string };

interface OpenRow { id: string; visit_day: string | null; question: string; asked_to: string }

/**
 * The agent needs the project: a visit check (`visit` set) or a question about
 * visiting (`question` only). Creates the rep's task, sends the officer the
 * fixed message, alerts the rep. A project with no officer: a visit check
 * becomes the rep's task; a plain question returns `noOfficer` (the agent asks
 * the rep instead).
 */
export async function askProjectOfficer(
  svc: SupabaseClient, chatWid: string,
  a: { projectId: string; projectName: string; question: string | null; visit: VisitWish | null },
  operationsDeviceId: () => Promise<string | null>,
  now = new Date(),
): Promise<AskOfficerResult> {
  const question = a.question ? clip(a.question.replace(/\s+/g, ' ').trim(), 400) : null;
  if (!question && !a.visit) return { ok: false, error: 'a question or a visit is required' };
  const today = riyadhToday(now);
  if (a.visit && a.visit.day < today) return { ok: false, error: 'that day is in the past' };
  const ctx = await loadChatContext(svc, chatWid);

  // One open check per chat × project: a repeat is a no-op; a NEW day replaces
  // the old check (closed without telling the customer — the new one supersedes it).
  const { data: open, error: oErr } = await svc.from('wa_agent_questions')
    .select('id, visit_day, question, asked_to').eq('chat_wid', chatWid).eq('project_id', a.projectId).eq('status', 'open');
  if (oErr) throw new Error(`open questions read failed: ${oErr.message}`);
  const rows = (open ?? []) as OpenRow[];
  if (a.visit) {
    const same = rows.find((r) => r.visit_day === a.visit!.day);
    if (same) return { ok: true, via: same.asked_to === 'officer' ? 'officer' : 'rep', questionId: same.id, duplicate: true };
    const stale = rows.filter((r) => r.visit_day && r.visit_day !== a.visit!.day).map((r) => r.id);
    if (stale.length) {
      const stamp = now.toISOString();
      const { error: sErr } = await svc.from('wa_agent_questions')
        .update({ status: 'dismissed', answered_at: stamp, relayed_at: stamp, note: 'استبدلها طلب زيارة بيوم آخر' }).in('id', stale).eq('status', 'open');
      if (sErr) throw new Error(`replacing the old visit check failed: ${sErr.message}`);
    }
  } else if (question) {
    const same = rows.find((r) => !r.visit_day && r.asked_to === 'officer' && r.question === question);
    if (same) return { ok: true, via: 'officer', questionId: same.id, duplicate: true };
  }

  const officer: CoveringOfficer | undefined = (await resolveProjectOfficers(svc, a.projectId))[0];
  const wid = officer ? officerChatWid(officer.phone) : null;
  const summary = taskSummary({ projectName: a.projectName, question, visit: a.visit, today });
  const visitCols = a.visit ? { visit_day: a.visit.day, visit_slot: a.visit.slot, visit_time: a.visit.time } : {};

  if (!officer || !wid) {
    if (!a.visit) return { ok: false, noOfficer: true };
    // No officer on record: the rep confirms the visit with the project.
    const { data, error } = await svc.from('wa_agent_questions').insert({
      chat_wid: chatWid, conversation_record_id: ctx.chatRecordId, client_id: ctx.clientId, project_id: a.projectId,
      rep_user_id: ctx.repUserId, asked_to: 'rep', question: summary,
      note: 'لا يوجد مسؤول مسجّل لهذا المشروع — أكّد الزيارة مع المشروع وسجّل النتيجة هنا.',
      due_at: dueAfter(officerDeliverAt(now)), ...visitCols,
    }).select('id').single();
    if (error) throw new Error(`visit check save failed: ${error.message}`);
    const id = (data as { id: string }).id;
    await alertRep(svc, ctx, {
      title: 'تأكيد زيارة مطلوب منك',
      body: `${summary}\nما لقينا مسؤولاً مسجّلاً للمشروع. تواصل مع المشروع وسجّل النتيجة في «مهامي» — المساعد يبلّغ العميل، والزيارة تنحجز إذا تأكدت.`,
      kind: 'visit_check', dedupe: `visit-check:${id}`, meta: { question_id: id, project_id: a.projectId },
    });
    return { ok: true, via: 'rep', questionId: id };
  }

  const ops = await operationsDeviceId();
  if (!ops) return { ok: false, error: 'no operations WhatsApp line is configured' };
  const clientId = await ensureClient(svc, ctx);
  const clientName = ctx.clientName ?? ctx.name ?? (ctx.phone ? localPhone(ctx.phone) : 'عميل');
  const clientPhone = ctx.phone ? localPhone(ctx.phone) : '—';
  const msgInput: OfficerMessageInput = { officerName: officer.name, projectName: a.projectName, clientName, clientPhone, question, visit: a.visit, today };
  const body = officerQuestionMessage(msgInput);
  const deliverAt = officerDeliverAt(now);

  const { data: qrow, error: qErr } = await svc.from('wa_agent_questions').insert({
    chat_wid: chatWid, conversation_record_id: ctx.chatRecordId, client_id: clientId, project_id: a.projectId,
    rep_user_id: ctx.repUserId, asked_to: 'officer', question: summary,
    officer_id: officer.id, officer_name: officer.name, officer_phone: officer.phone, officer_message: body,
    sent_at: deliverAt, due_at: dueAfter(deliverAt), ...visitCols,
  }).select('id').single();
  if (qErr) throw new Error(`officer question save failed: ${qErr.message}`);
  const questionId = (qrow as { id: string }).id;

  let actionId: string;
  try {
    actionId = await sendLoggedOfficerMessage(svc, {
      clientId, projectId: a.projectId, officer: { id: officer.id, name: officer.name, phone: officer.phone }, wid, body,
      reference: `officer_question:${questionId}`, deliverAt, opsDevice: ops,
      context: {
        trigger: a.visit ? 'visit_check' : 'visit_question', question_id: questionId, client_name: clientName,
        client_chat_wid: chatWid, project_name: a.projectName, officer_coverage: officer.coverage,
      },
    });
  } catch (err) {
    // The message never left: close the task without telling the customer, so
    // the agent falls back (the caller asks the rep) instead of waiting forever.
    const stamp = new Date().toISOString();
    const { error: cErr } = await svc.from('wa_agent_questions')
      .update({ status: 'dismissed', answered_at: stamp, relayed_at: stamp, note: `لم تُرسل الرسالة للمسؤول: ${err instanceof Error ? err.message : String(err)}` })
      .eq('id', questionId);
    if (cErr) console.error(`[officer-question] could not close unsent question ${questionId}: ${cErr.message}`);
    throw err;
  }
  const { error: lErr } = await svc.from('wa_agent_questions').update({ officer_action_id: actionId }).eq('id', questionId);
  if (lErr) console.error(`[officer-question] could not link message ${actionId} to question ${questionId}: ${lErr.message}`);

  await alertRep(svc, ctx, {
    title: a.visit ? 'تأكيد زيارة بانتظار المسؤول' : 'سؤال للمسؤول بانتظار رده',
    body: `${summary}\nأرسلنا للمسؤول ${officer.name}. أول ما يرد، سجّل جوابه في «مهامي» والمساعد يبلّغ العميل${a.visit ? '، والزيارة تنحجز إذا أكّدها' : ''}.`,
    kind: a.visit ? 'visit_check' : 'officer_question', dedupe: `officer-q:${questionId}`, meta: { question_id: questionId, project_id: a.projectId },
  });
  return { ok: true, via: 'officer', questionId };
}

// ── Deadlines ────────────────────────────────────────────────────────────────

interface DueRow {
  id: string; chat_wid: string; client_id: string | null; project_id: string | null; asked_to: string; question: string;
  officer_id: string | null; officer_name: string | null; officer_phone: string | null;
  visit_day: string | null; visit_slot: string | null; visit_time: string | null;
  reminded_at: string | null; escalated_at: string | null; day_before_alerted_at: string | null; due_at: string | null;
}

const DUE_COLS = 'id, chat_wid, client_id, project_id, asked_to, question, officer_id, officer_name, officer_phone, visit_day, visit_slot, visit_time, reminded_at, escalated_at, day_before_alerted_at, due_at';

async function projectNameOf(svc: SupabaseClient, id: string | null): Promise<string> {
  if (!id) return '—';
  const { data, error } = await svc.from('unified_records').select('data').eq('id', id).maybeSingle();
  if (error) { console.error(`[officer-question] project read failed: ${error.message}`); return '—'; }
  const d = ((data as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
  const n = typeof d.project_name === 'string' ? d.project_name : typeof d.name === 'string' ? d.name : '';
  return n.trim() || '—';
}

export interface DeadlineReport { reminded: number; escalated: number; day_before: number; errors: string[] }

/**
 * Walk the deadline chain for open officer questions and visit checks. Only
 * 09:00–21:00 Riyadh, so nobody is messaged at night. Every step CLAIMS its row
 * first (a conditional update on the step's null column), so two cron runs
 * never send the same reminder twice; a failed send releases the claim.
 */
export async function remindOfficerQuestions(
  svc: SupabaseClient, operationsDeviceId: () => Promise<string | null>, now = new Date(),
): Promise<DeadlineReport> {
  const report: DeadlineReport = { reminded: 0, escalated: 0, day_before: 0, errors: [] };
  const hour = riyadhHour(now);
  if (hour < 9 || hour >= 21) return report;
  const stamp = now.toISOString();
  const today = riyadhToday(now);

  // 1 + 2. Past the deadline: remind the officer once, then alert the rep once.
  const { data: due, error: dErr } = await svc.from('wa_agent_questions').select(DUE_COLS)
    .eq('status', 'open').not('due_at', 'is', null).lte('due_at', stamp).order('due_at', { ascending: true }).limit(50);
  if (dErr) throw new Error(`due questions read failed: ${dErr.message}`);
  for (const q of (due ?? []) as DueRow[]) {
    try {
      const ctx: ChatContext = await loadChatContext(svc, q.chat_wid);
      if (q.asked_to === 'officer' && !q.reminded_at && q.officer_phone && q.client_id) {
        const { data: claimed, error: cErr } = await svc.from('wa_agent_questions')
          .update({ reminded_at: stamp, due_at: dueAfter(stamp) }).eq('id', q.id).eq('status', 'open').is('reminded_at', null).select('id');
        if (cErr) throw new Error(`reminder claim failed: ${cErr.message}`);
        if (!claimed?.length) continue;
        const wid = officerChatWid(q.officer_phone);
        const ops = await operationsDeviceId();
        try {
          if (!wid) throw new Error(`officer phone ${q.officer_phone} is not a WhatsApp number`);
          if (!ops) throw new Error('no operations WhatsApp line is configured');
          const projectName = await projectNameOf(svc, q.project_id);
          const body = officerReminderMessage({
            officerName: q.officer_name ?? '', projectName,
            clientName: ctx.clientName ?? ctx.name ?? (ctx.phone ? localPhone(ctx.phone) : 'عميل'),
            clientPhone: ctx.phone ? localPhone(ctx.phone) : '—',
            question: q.visit_day ? null : q.question,
            visit: q.visit_day ? { day: q.visit_day, slot: (q.visit_slot as VisitSlot | null) ?? null, time: q.visit_time } : null,
            today,
          });
          await sendLoggedOfficerMessage(svc, {
            clientId: q.client_id, projectId: q.project_id, officer: { id: q.officer_id, name: q.officer_name ?? '', phone: q.officer_phone }, wid, body,
            reference: `officer_question_reminder:${q.id}`, deliverAt: stamp, opsDevice: ops,
            context: { trigger: 'reminder', question_id: q.id, project_name: projectName, client_chat_wid: q.chat_wid },
          });
          report.reminded += 1;
        } catch (err) {
          const { error: rErr } = await svc.from('wa_agent_questions').update({ reminded_at: null, due_at: q.due_at }).eq('id', q.id);
          if (rErr) console.error(`[officer-question] could not release the reminder claim on ${q.id}: ${rErr.message}`);
          throw err;
        }
        continue;
      }
      if (!q.escalated_at) {
        const { data: claimed, error: cErr } = await svc.from('wa_agent_questions')
          .update({ escalated_at: stamp }).eq('id', q.id).eq('status', 'open').is('escalated_at', null).select('id');
        if (cErr) throw new Error(`escalation claim failed: ${cErr.message}`);
        if (!claimed?.length) continue;
        await alertRep(svc, ctx, {
          title: q.asked_to === 'officer' ? 'المسؤول ما رد — كلّمه' : 'تأكيد زيارة متأخر',
          body: q.asked_to === 'officer'
            ? `${q.question}\nسألنا المسؤول ${q.officer_name ?? ''} وذكّرناه ولم يرد. اتصل عليه وسجّل جوابه في «مهامي» — العميل ينتظر.`
            : `${q.question}\nما زالت بانتظارك. أكّدها مع المشروع وسجّل النتيجة في «مهامي» — العميل ينتظر.`,
          kind: 'officer_question_overdue', dedupe: `officer-q-overdue:${q.id}`, meta: { question_id: q.id },
        });
        report.escalated += 1;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[officer-question] deadline step failed for ${q.id}: ${msg}`);
      report.errors.push(`${q.id}: ${msg}`);
    }
  }

  // 3. A visit check still open the day before the visit (from 10:00) or on the day.
  if (hour >= 10) {
    const [y, m, d] = today.split('-').map(Number) as [number, number, number];
    const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    const { data: soon, error: sErr } = await svc.from('wa_agent_questions').select(DUE_COLS)
      .eq('status', 'open').not('visit_day', 'is', null).lte('visit_day', tomorrow).is('day_before_alerted_at', null).limit(50);
    if (sErr) throw new Error(`upcoming visit checks read failed: ${sErr.message}`);
    for (const q of (soon ?? []) as DueRow[]) {
      try {
        const { data: claimed, error: cErr } = await svc.from('wa_agent_questions')
          .update({ day_before_alerted_at: stamp }).eq('id', q.id).eq('status', 'open').is('day_before_alerted_at', null).select('id');
        if (cErr) throw new Error(`day-before claim failed: ${cErr.message}`);
        if (!claimed?.length) continue;
        const ctx = await loadChatContext(svc, q.chat_wid);
        const when = q.visit_day === today ? 'اليوم' : 'بكرة';
        await alertRep(svc, ctx, {
          title: `زيارة ${when} وما تأكدت`,
          body: `${q.question}\nالعميل جاي ${when} والمشروع ما أكّد. كلّم ${q.asked_to === 'officer' ? `المسؤول ${q.officer_name ?? ''}` : 'المشروع'} الآن وسجّل النتيجة في «مهامي».`,
          kind: 'visit_check_day_before', dedupe: `visit-check-soon:${q.id}`, meta: { question_id: q.id },
        });
        report.day_before += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[officer-question] day-before alert failed for ${q.id}: ${msg}`);
        report.errors.push(`${q.id}: ${msg}`);
      }
    }
  }
  return report;
}
