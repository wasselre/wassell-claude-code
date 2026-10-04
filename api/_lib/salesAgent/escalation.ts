/**
 * What the sales agent does when the conversation needs the BUSINESS, not just
 * an answer: ask the client's rep a question it cannot answer, book a visit,
 * record a visit the customer mentions, and alert the rep.
 *
 * Everything here is silent to the customer. In particular a visit is booked as
 * an ordinary `appointments` record WITHOUT the "appointment booked" WhatsApp:
 * that message belongs to the browser-side workflow, and `appointments` is not
 * enrolled in the server workflow runner, so a server-created appointment fires
 * nothing (verified 2026-09-30). The agent confirms the visit in its own words.
 *
 * The rep is the client's own rep: chat `client_owner` mirror → the client's
 * `client_owner` → the designated WhatsApp inbox user.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { uuidV5FromWidSync } from '../chatIngest.js';
import { clip } from './clip.js';

const APP_URL = () => (process.env.APP_URL || 'https://app.wassel.re').replace(/\/+$/, '');
const OPS_DEVICE = 'wassel_ops';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ChatContext {
  chatWid: string;
  chatRecordId: string;
  phone: string | null;
  name: string | null;
  paused: boolean;
  clientId: string | null;
  clientName: string | null;
  repUserId: string | null;
}

function firstId(v: unknown): string | null {
  const s = typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null;
  return s && UUID_RE.test(s) ? s : null;
}

async function modelId(svc: SupabaseClient, name: string): Promise<string> {
  const { data, error } = await svc.from('models').select('id').eq('name', name).maybeSingle();
  if (error) throw new Error(`${name} model read failed: ${error.message}`);
  if (!data?.id) throw new Error(`${name} model not found`);
  return data.id as string;
}

/** The chat, its client and the rep who owns that client. */
export async function loadChatContext(svc: SupabaseClient, chatWid: string): Promise<ChatContext> {
  const chatRecordId = uuidV5FromWidSync(chatWid);
  const { data: chat, error } = await svc.from('records').select('data').eq('id', chatRecordId).maybeSingle();
  if (error) throw new Error(`chat read failed: ${error.message}`);
  const d = ((chat as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
  const digits = chatWid.split('@')[0] ?? '';
  const phone = typeof d.phone === 'string' && d.phone ? d.phone : /^\d{8,15}$/.test(digits) ? `+${digits}` : null;

  let clientId = firstId(d.client_link);
  if (!clientId && phone) {
    const { data: found, error: fErr } = await svc.rpc('find_client_id_by_phone', { p_phone: phone });
    if (fErr) console.error('[salesAgent] find_client_id_by_phone failed:', fErr.message);
    else clientId = firstId(found);
  }
  let clientName: string | null = null;
  let repUserId = firstId(d.client_owner);
  if (clientId) {
    const { data: cl, error: cErr } = await svc.from('records').select('data').eq('id', clientId).maybeSingle();
    if (cErr) console.error('[salesAgent] client read failed:', cErr.message);
    const cd = ((cl as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
    clientName = typeof cd.client_name === 'string' && cd.client_name.trim() ? cd.client_name.trim() : null;
    repUserId = repUserId ?? firstId(cd.client_owner);
  }
  if (repUserId) {
    // A departed rep never receives alerts.
    const { data: u } = await svc.from('users').select('id, is_active').eq('id', repUserId).maybeSingle();
    if (!u || (u as { is_active?: boolean }).is_active === false) repUserId = null;
  }
  if (!repUserId) {
    const { data: s, error: sErr } = await svc.from('push_builtin_settings').select('whatsapp_inbox_user_id').eq('id', 1).maybeSingle();
    if (sErr) console.error('[salesAgent] inbox user read failed:', sErr.message);
    repUserId = firstId((s as { whatsapp_inbox_user_id?: unknown } | null)?.whatsapp_inbox_user_id);
  }
  return {
    chatWid, chatRecordId, phone,
    name: typeof d.name === 'string' && d.name.trim() ? d.name.trim() : null,
    paused: d.ai_paused === true,
    clientId, clientName, repUserId,
  };
}

/**
 * Alert the rep: the in-app AI notifications feed (targeted), a phone push, and
 * — when the rep has a phone on their user — a WhatsApp from the ops line.
 * Best-effort per channel: one failing never stops the others, each is logged.
 */
export async function alertRep(
  svc: SupabaseClient, ctx: ChatContext,
  a: { title: string; body: string; kind: string; dedupe: string; meta?: Record<string, unknown> },
): Promise<void> {
  const who = ctx.clientName ?? ctx.name ?? ctx.phone ?? ctx.chatWid;
  const body = clip(a.body, 1500);
  const { error: nErr } = await svc.from('ai_notifications').insert({
    source: 'whatsapp', severity: 'action', title: clip(`${a.title} — ${who}`, 200), body,
    chat_wid: ctx.chatWid, chat_record_id: ctx.chatRecordId, client_record_id: ctx.clientId,
    target_user_id: ctx.repUserId, meta: { kind: a.kind, ...(a.meta ?? {}) },
  });
  if (nErr) console.error('[salesAgent] rep notification failed:', nErr.message);
  if (!ctx.repUserId) return;

  const { error: pErr } = await svc.from('push_outbox').insert({
    user_id: ctx.repUserId, kind: 'ai_agent', title: clip(`${a.title} — ${who}`, 120), body: clip(body, 180),
    url: `/model/chats/${ctx.chatRecordId}`, tag: `chat-${ctx.chatRecordId}`, dedupe_key: a.dedupe,
  });
  // A duplicate dedupe key means this alert was already pushed — not a failure.
  if (pErr && !/duplicate key/i.test(pErr.message)) console.error('[salesAgent] rep push failed:', pErr.message);

  const { data: u, error: uErr } = await svc.from('users').select('phone').eq('id', ctx.repUserId).maybeSingle();
  if (uErr) { console.error('[salesAgent] rep phone read failed:', uErr.message); return; }
  const digits = String((u as { phone?: string | null } | null)?.phone ?? '').replace(/\D/g, '');
  if (digits.length < 9) return;   // no phone on the rep's user — app + push only
  const intl = digits.startsWith('966') ? digits : `966${digits.replace(/^0/, '')}`;
  const text = `${a.title} — ${who}\n${body}\n${APP_URL()}/model/chats/${ctx.chatRecordId}`;
  const { error: wErr } = await svc.rpc('scheduled_whatsapp_enqueue', {
    p_device_id: OPS_DEVICE, p_chat_wid: `${intl}@c.us`, p_phone: `+${intl}`, p_body: text, p_media: null,
    p_reference: `agent-alert:${a.dedupe}`, p_deliver_at: new Date().toISOString(), p_user_id: null,
  });
  if (wErr) console.error('[salesAgent] rep WhatsApp alert failed:', wErr.message);
}

/** The agent cannot answer: ask the rep. Returns the question id. */
export async function askRep(
  svc: SupabaseClient, chatWid: string,
  a: { question: string; note: string; projectId: string | null; projectName: string | null },
): Promise<string> {
  const ctx = await loadChatContext(svc, chatWid);
  const { data, error } = await svc.from('wa_agent_questions').insert({
    chat_wid: chatWid, conversation_record_id: ctx.chatRecordId, client_id: ctx.clientId,
    project_id: a.projectId, rep_user_id: ctx.repUserId,
    question: clip(a.question, 600), note: clip(a.note, 600) || null,
  }).select('id').single();
  if (error) throw new Error(`question save failed: ${error.message}`);
  const id = (data as { id: string }).id;
  await alertRep(svc, ctx, {
    title: 'سؤال من المساعد الآلي',
    body: `العميل يسأل${a.projectName ? ` عن ${a.projectName}` : ''}: ${a.question}${a.note ? `\n${a.note}` : ''}\nاكتب الجواب في المحادثة (بطاقة السؤال) أو ردّ على العميل مباشرة.`,
    kind: 'question', dedupe: `agent-q:${id}`, meta: { question_id: id, project_id: a.projectId },
  });
  return id;
}

/** The client record for this chat, created from the phone when there is none. */
async function ensureClient(svc: SupabaseClient, ctx: ChatContext): Promise<string> {
  if (ctx.clientId) return ctx.clientId;
  if (!ctx.phone) throw new Error('no phone on this chat — cannot create the client');
  const id = crypto.randomUUID();
  const { error } = await svc.rpc('record_save', {
    p_model_id: await modelId(svc, 'clients'), p_id: id,
    p_data: { client_name: ctx.name ?? ctx.phone, phone_number: ctx.phone, client_sources: ['واتساب'] },
    p_expected_version: null,
  });
  if (error) throw new Error(`client create failed: ${error.message}`);
  ctx.clientId = id;
  return id;
}

const SLOT_TIME: Record<string, { hhmm: string; ar: string }> = {
  morning: { hhmm: '10:00', ar: 'الصباح' },
  noon: { hhmm: '13:00', ar: 'الظهر' },
  afternoon: { hhmm: '16:30', ar: 'العصر' },
  evening: { hhmm: '19:00', ar: 'المغرب' },
  night: { hhmm: '20:30', ar: 'المساء' },
};

export type VisitSlot = keyof typeof SLOT_TIME;

/** `YYYY-MM-DD` that is a real calendar day. */
export function isIsoDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Today in Riyadh as `YYYY-MM-DD`. */
export function riyadhToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(now);
}

/**
 * Book the visit the customer agreed to: an ordinary appointment (status
 * «مجدول») for the client, the project and the day, at a rough time. Refuses a
 * day in the past, and the same project + day twice. The rep is alerted; the
 * customer is told nothing by the system.
 */
export async function bookVisit(
  svc: SupabaseClient, chatWid: string,
  a: { projectId: string; projectName: string; day: string; slot: VisitSlot | null; time: string | null },
): Promise<{ ok: true; when: string } | { ok: false; error: string }> {
  if (!isIsoDay(a.day)) return { ok: false, error: 'day must be a real date YYYY-MM-DD' };
  if (a.day < riyadhToday()) return { ok: false, error: 'that day is in the past' };
  const hhmm = a.time && /^([01]\d|2[0-3]):[0-5]\d$/.test(a.time) ? a.time : SLOT_TIME[a.slot ?? 'afternoon']?.hhmm ?? '16:30';
  const approx = a.time ? a.time : `${SLOT_TIME[a.slot ?? 'afternoon']?.ar ?? 'العصر'} (تقريبي)`;
  const ctx = await loadChatContext(svc, chatWid);
  const clientId = await ensureClient(svc, ctx);
  const apptModel = await modelId(svc, 'appointments');
  // Appointments point at OUR projects (since 2026-10-04, like visits); map the
  // master project to its Our Projects entry.
  const { data: ours, error: oErr } = await svc.from('records').select('id')
    .eq('model_id', await modelId(svc, 'our_projects')).eq('data->>project', a.projectId).limit(1);
  if (oErr) throw new Error(`our-project lookup failed: ${oErr.message}`);
  const ourProjectId = (ours as Array<{ id: string }> | null)?.[0]?.id ?? null;

  const { data: dup, error: dErr } = await svc.from('records').select('id')
    .eq('model_id', apptModel).eq('data->>client_id', clientId).eq('data->>project_id', ourProjectId ?? '')
    .like('data->>appointment_date', `${a.day}%`).in('data->>appointment_status', ['scheduled', 'confirmed', 'rescheduled']).limit(1);
  if (dErr) throw new Error(`appointment check failed: ${dErr.message}`);
  const when = `${a.day}T${hhmm}`;
  if (dup && dup.length) return { ok: true, when };   // already booked for that day — nothing to add

  // The «م ع###» number a rep-created appointment gets in the browser.
  const { data: appId, error: idErr } = await svc.rpc('record_assign_auto_id_system', { p_model_name: 'appointments', p_field_name: 'app_id' });
  if (idErr) console.error('[salesAgent] appointment number failed (saving without one):', idErr.message);

  const { error } = await svc.rpc('record_save', {
    p_model_id: apptModel, p_id: crypto.randomUUID(),
    p_data: {
      ...(typeof appId === 'string' && appId ? { app_id: appId } : {}),
      client_id: clientId, phone_number: ctx.phone, client_name: ctx.clientName ?? ctx.name ?? ctx.phone,
      appointment_date: when, ...(ourProjectId ? { project_id: ourProjectId } : {}), sales_rep: ctx.repUserId, appointment_status: 'scheduled',
      notes: `حجزه المساعد الآلي من محادثة واتساب — الوقت: ${approx}. لم تُرسل للعميل رسالة تأكيد آلية.`,
    },
    p_expected_version: null,
  });
  if (error) throw new Error(`appointment save failed: ${error.message}`);
  await alertRep(svc, ctx, {
    title: 'موعد زيارة حجزه المساعد الآلي',
    body: `${a.projectName} — ${a.day} — ${approx}.\nالعميل وافق في المحادثة. أكّد الموعد معه قبلها.${ourProjectId ? '' : '\nالمشروع ليس ضمن مشاريعنا المعتمدة، فسُجّل الموعد بلا مشروع.'}`,
    kind: 'visit_booked', dedupe: `agent-visit:${chatWid}:${a.projectId}:${a.day}`,
    meta: { project_id: a.projectId, day: a.day },
  });
  return { ok: true, when };
}

/**
 * The customer said they already visited a project: record the visit (once per
 * project per day). `day` null = they did not say when → today.
 */
export async function recordVisit(
  svc: SupabaseClient, chatWid: string, a: { projectId: string; projectName: string; day: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const day = a.day && isIsoDay(a.day) ? a.day : riyadhToday();
  if (day > riyadhToday()) return { ok: false, error: 'a visit that already happened cannot be in the future — use book_visit' };
  const ctx = await loadChatContext(svc, chatWid);
  const clientId = await ensureClient(svc, ctx);
  const visitsModel = await modelId(svc, 'visits');
  // Visits point at OUR projects (the curated set); map the master project to it.
  const { data: ours, error: oErr } = await svc.from('records').select('id')
    .eq('model_id', await modelId(svc, 'our_projects')).eq('data->>project', a.projectId).limit(1);
  if (oErr) throw new Error(`our-project lookup failed: ${oErr.message}`);
  const ourProjectId = (ours as Array<{ id: string }> | null)?.[0]?.id ?? null;

  const { data: dup, error: dErr } = await svc.from('records').select('id, data')
    .eq('model_id', visitsModel).eq('data->>client_id', clientId).like('data->>scheduled_datetime', `${day}%`).limit(5);
  if (dErr) throw new Error(`visit check failed: ${dErr.message}`);
  if ((dup ?? []).some((v) => ((v as { data: Record<string, unknown> }).data.project_id ?? null) === ourProjectId)) return { ok: true };

  const { error } = await svc.rpc('record_save', {
    p_model_id: visitsModel, p_id: crypto.randomUUID(),
    p_data: {
      client_id: clientId, phone: ctx.phone, name: ctx.clientName ?? ctx.name ?? ctx.phone,
      scheduled_datetime: `${day}T12:00`, ...(ourProjectId ? { project_id: ourProjectId } : {}),
      sales_representative: ctx.repUserId,
    },
    p_expected_version: null,
  });
  if (error) throw new Error(`visit save failed: ${error.message}`);
  await alertRep(svc, ctx, {
    title: 'زيارة سجّلها المساعد الآلي',
    body: `العميل ذكر في المحادثة أنه زار ${a.projectName} (${day}).${ourProjectId ? '' : ' المشروع ليس ضمن مشاريعنا المعتمدة، فسُجّلت الزيارة بلا مشروع.'}`,
    kind: 'visit_recorded', dedupe: `agent-visited:${chatWid}:${a.projectId}:${day}`,
    meta: { project_id: a.projectId, day },
  });
  return { ok: true };
}

/** Rep answers the agent saved as facts for a project (newest first). */
export async function projectRepAnswers(svc: SupabaseClient, projectId: string): Promise<Array<{ q: string; a: string }>> {
  const { data, error } = await svc.from('wa_agent_questions').select('question, answer')
    .eq('project_id', projectId).eq('status', 'answered').eq('save_as_fact', true)
    .order('answered_at', { ascending: false }).limit(8);
  if (error) { console.error('[salesAgent] saved answers read failed:', error.message); return []; }
  return ((data ?? []) as Array<{ question: string; answer: string | null }>)
    .filter((r) => r.answer).map((r) => ({ q: r.question, a: r.answer as string }));
}
