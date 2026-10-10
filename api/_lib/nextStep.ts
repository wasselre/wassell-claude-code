/**
 * The agent owns the next step; the AI proposes it (operator, 2026-10-10:
 * "we are using AI but still we are giving the human full ownership").
 *
 * Review cards (`next_step_reviews`, migration 2026-10-10_01):
 *   after_call   — opened by tg_records_next_step_review when a PERSON records a
 *                  result that leads to another contact. The process has already
 *                  planned the next task (server workflow, a few seconds later);
 *                  the agent agrees or changes how and when.
 *   conversation — made here, from the chat outcome reader's reading, once the
 *                  chat has been quiet `review_quiet_minutes`. The follow-up it
 *                  reads stays OPEN (on hold: the AI writer skips the client) until
 *                  the agent agrees (`applySuggestion`, the AI's own write) or sets
 *                  another result in the chat popup (the trigger settles the card
 *                  and opens an after_call card for the next step).
 *   visit_booked — made by bookVisit; acknowledged by the owner.
 * At `next_step_default_hour` (21:00 Riyadh) everything still pending is applied
 * as suggested (`auto_applied`); the agent can still change it afterwards.
 *
 * A decision changes the PLANNED TASK in place (type / time / who writes it) and
 * stamps it `next_step_decision` = agent | default. A planned task that does not
 * exist yet (the workflow runs a few seconds after the save) is finished later
 * by `finalizeWaiting` (apply_state = waiting_task).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { recordSaveWithRetry } from './recordSaveRetry.js';
import { applySuggestion, type SuggestionRow } from './outcomeAutoApply.js';
import type { AutomationSettings } from './clientPrefs/autoSave.js';

export type NextChannel = 'call' | 'ai_whatsapp' | 'agent_whatsapp';
export interface NextPlan { channel: NextChannel; at: string }

export interface ReviewRow {
  id: string;
  client_id: string;
  owner_user_id: string | null;
  kind: 'after_call' | 'conversation' | 'visit_booked';
  status: 'pending' | 'decided' | 'auto_applied' | 'dismissed';
  source_followup_id: string | null;
  followup_id: string | null;
  suggestion_id: string | null;
  appointment_id: string | null;
  call_result: string | null;
  summary: string | null;
  client_quote: string | null;
  suggested_result: string | null;
  suggested_confidence: number | null;
  suggested_next: NextPlan | null;
  decision: Record<string, unknown> | null;
  decided_by: string | null;
  decided_at: string | null;
  apply_state: 'none' | 'waiting_task' | 'done' | 'failed';
  apply_error: string | null;
  last_message_at: string | null;
  created_at: string;
}

const CALL_TYPE = 'appointment_booking_call';
const OPEN = new Set(['open', 'in_progress']);
const CLOSED = new Set(['completed', 'cancelled', 'skipped']);
/** How long to wait for the workflow to create the planned task before making one. */
const WAIT_FOR_TASK_MS = 10 * 60_000;
/** A chat older than this does not become a card. */
const MAX_CARD_AGE_MS = 3 * 86_400_000;

const readType = (v: unknown): string | null => (Array.isArray(v) ? (v.length ? String(v[0]) : null) : v ? String(v) : null);
const DAY = 86_400_000;

/** PURE — how a task will reach the client, read from its data. */
export function planOfTask(data: Record<string, unknown>): NextPlan | null {
  const at = typeof data.scheduled_datetime === 'string' ? data.scheduled_datetime : null;
  if (!at) return null;
  const type = readType(data.followup_type);
  if (type === 'whatsapp_follow_up') return { channel: data.writer === 'agent' ? 'agent_whatsapp' : 'ai_whatsapp', at };
  return { channel: 'call', at };
}

/**
 * PURE — the next step the process takes after a WhatsApp follow-up result,
 * mirroring the «WhatsApp Response Completed» workflow (interested → WhatsApp in
 * 5 days; call back later → WhatsApp on the client's date). Other results end the
 * path or hand over to another flow (offer, request) — no next contact.
 */
export function defaultNextAfterResult(result: string | null, fields: Record<string, unknown> | null, now: Date): NextPlan | null {
  if (result === 'interested') return { channel: 'ai_whatsapp', at: new Date(now.getTime() + 5 * DAY).toISOString() };
  if (result === 'recontact_later') {
    const d = fields && typeof fields.reschedule_contact_date === 'string' ? fields.reschedule_contact_date : null;
    return d ? { channel: 'ai_whatsapp', at: d } : null;
  }
  return null;
}

/** PURE — a planned task after a decision. `plan` undefined = keep how/when, only record who decided. */
export function applyPlanToTask(
  data: Record<string, unknown>, plan: NextPlan | undefined, decidedBy: string | null, how: 'agent' | 'default',
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data, next_step_decision: how, next_step_decided_by: decidedBy };
  if (!plan) return out;
  const wasWhatsapp = readType(data.followup_type) === 'whatsapp_follow_up';
  out.scheduled_datetime = plan.at;
  if (plan.channel === 'call') {
    out.followup_type = [CALL_TYPE];
    delete out.writer;
    if (wasWhatsapp) { delete out.whatsapp_state; delete out.whatsapp_attempt_number; }
  } else {
    out.followup_type = ['whatsapp_follow_up'];
    if (plan.channel === 'agent_whatsapp') out.writer = 'agent'; else delete out.writer;
    if (!wasWhatsapp) out.whatsapp_attempt_number = 1;
  }
  return out;
}

/** PURE — Riyadh calendar day and hour for `now` (no daylight saving). */
export function riyadhClock(now: Date): { day: string; hour: number } {
  const local = new Date(now.getTime() + 3 * 3_600_000);
  return { day: local.toISOString().slice(0, 10), hour: local.getUTCHours() };
}

async function modelId(sb: SupabaseClient, name: string): Promise<string> {
  const { data, error } = await sb.from('models').select('id').eq('name', name).maybeSingle();
  if (error || !data) throw new Error(`model ${name} not found${error ? `: ${error.message}` : ''}`);
  return (data as { id: string }).id;
}

/** The newest open task of the client created since `sinceIso` (minus 2 min), other than `excludeId`. */
export async function plannedTask(
  sb: SupabaseClient, clientId: string, sinceIso: string, excludeId: string | null,
): Promise<{ id: string; data: Record<string, unknown> } | null> {
  const since = new Date(Date.parse(sinceIso) - 2 * 60_000).toISOString();
  const { data, error } = await sb.from('records').select('id, data, created_at')
    .eq('model_id', await modelId(sb, 'followups')).eq('data->>client_id', clientId)
    .gte('created_at', since).order('created_at', { ascending: false }).limit(10);
  if (error) throw new Error(`planned task read failed: ${error.message}`);
  const row = ((data ?? []) as Array<{ id: string; data: Record<string, unknown> | null }>)
    .find((r) => r.id !== excludeId && OPEN.has(String(r.data?.followup_status ?? 'open') || 'open'));
  return row ? { id: row.id, data: row.data ?? {} } : null;
}

async function patchReview(sb: SupabaseClient, id: string, patch: Partial<ReviewRow>): Promise<void> {
  const { error } = await sb.from('next_step_reviews').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(`review ${id} update failed: ${error.message}`);
}

/**
 * Put the decision on the planned task. Returns the apply_state to store:
 * done, or waiting_task when the task does not exist yet (finalizeWaiting retries).
 */
export async function applyPlan(
  sb: SupabaseClient, review: ReviewRow, plan: NextPlan | undefined, decidedBy: string | null, how: 'agent' | 'default', sinceIso: string,
): Promise<'done' | 'waiting_task'> {
  let task: { id: string; data: Record<string, unknown> } | null = null;
  if (review.kind === 'after_call' && review.followup_id) {
    const { data, error } = await sb.from('records').select('id, data').eq('id', review.followup_id).maybeSingle();
    if (error) throw new Error(`task read failed: ${error.message}`);
    const d = (data as { id: string; data: Record<string, unknown> } | null);
    if (d && !CLOSED.has(String(d.data?.followup_status ?? ''))) task = { id: d.id, data: d.data ?? {} };
  }
  if (!task) task = await plannedTask(sb, review.client_id, sinceIso, review.source_followup_id ?? review.followup_id);

  if (!task) {
    if (!plan) return Date.now() - Date.parse(sinceIso) < WAIT_FOR_TASK_MS ? 'waiting_task' : 'done';
    if (Date.now() - Date.parse(sinceIso) < WAIT_FOR_TASK_MS) return 'waiting_task';
    // The process planned nothing (or it never arrived): make the agent's task.
    const id = crypto.randomUUID();
    const base: Record<string, unknown> = {
      client_id: review.client_id, followup_status: 'open', followup_number: 1,
      ...(review.owner_user_id ? { sales_rep: review.owner_user_id } : {}), creation_source: 'next_step_decision',
    };
    const { error } = await sb.rpc('record_save', {
      p_model_id: await modelId(sb, 'followups'), p_id: id,
      p_data: applyPlanToTask(base, plan, decidedBy, how), p_expected_version: null,
    });
    if (error) throw new Error(`next task create failed: ${error.message}`);
    await patchReview(sb, review.id, { followup_id: review.kind === 'after_call' ? id : review.followup_id });
    return 'done';
  }

  await recordSaveWithRetry(sb, {
    recordId: task.id,
    build: (fresh) => (CLOSED.has(String(fresh.followup_status ?? '')) ? null : applyPlanToTask(fresh, plan, decidedBy, how)),
  });
  if (review.kind === 'after_call') await patchReview(sb, review.id, { followup_id: task.id });
  return 'done';
}

export type DecideInput =
  | { action: 'agree'; next?: NextPlan }   // keep the suggestion (optionally another next step)
  | { action: 'change'; next: NextPlan }   // after_call: a different next step
  | { action: 'ack' };                     // visit_booked: seen

export class DecideError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** The agent decides one card. */
export async function decideReview(sb: SupabaseClient, review: ReviewRow, input: DecideInput, me: string | null): Promise<ReviewRow['status']> {
  if (review.status !== 'pending' && !(review.status === 'auto_applied' && review.kind === 'after_call')) {
    throw new DecideError(409, 'already_decided');
  }
  const nowIso = new Date().toISOString();

  if (review.kind === 'visit_booked') {
    await patchReview(sb, review.id, { status: 'decided', decided_by: me, decided_at: nowIso, decision: { ack: true } });
    return 'decided';
  }

  if (review.kind === 'after_call') {
    const plan = input.action === 'change' ? input.next : input.action === 'agree' ? input.next : undefined;
    const state = await applyPlan(sb, review, plan, me, 'agent', review.created_at);
    await patchReview(sb, review.id, {
      status: 'decided', decided_by: me, decided_at: nowIso, apply_state: state,
      decision: { action: input.action, ...(plan ? { next: plan } : {}) },
    });
    return 'decided';
  }

  // conversation — «Agree»: the AI's reading becomes the result, decided by the agent.
  if (input.action !== 'agree') throw new DecideError(400, 'a conversation card is agreed here; another result is set in the chat popup');
  const s = await loadSuggestion(sb, review.suggestion_id);
  if (!s) throw new DecideError(409, 'the AI reading is gone — set the result in the chat');
  const res = await applySuggestion(sb, s, { userId: me, reviewed: true });
  if (!res.applied) throw new DecideError(409, res.reason ?? 'could not apply');
  const plan = input.next;
  const state = await applyPlan(sb, review, plan, me, 'agent', nowIso);
  await patchReview(sb, review.id, {
    status: 'decided', decided_by: me, decided_at: nowIso, apply_state: state,
    decision: { action: 'agree', result: s.suggested_outcome, ...(plan ? { next: plan } : {}) },
  });
  return 'decided';
}

async function loadSuggestion(sb: SupabaseClient, id: string | null): Promise<SuggestionRow | null> {
  if (!id) return null;
  const { data, error } = await sb.from('chat_outcome_suggestions')
    .select('id, client_id, chat_record_id, chat_wid, followup_id, followup_type, suggested_outcome, confidence, summary, suggested_fields, quoted_phrase, last_message_at, suggested_main_project_id, suggested_main_project_name, status')
    .eq('id', id).maybeSingle();
  if (error) throw new Error(`reading lookup failed: ${error.message}`);
  const row = data as (SuggestionRow & { status: string }) | null;
  return row && row.status === 'ready' ? row : null;
}

/** Cron: turn quiet chat readings into conversation cards (one pending per client). */
export async function createConversationCards(
  sb: SupabaseClient, settings: AutomationSettings, opts: { dryRun?: boolean; deadline?: number } = {},
): Promise<Array<{ suggestion: string; card?: string; skipped?: string }>> {
  if (!settings.owner_decides_next_step) return [];
  const { data, error } = await sb.rpc('next_step_conversation_candidates', { p_quiet_minutes: settings.review_quiet_minutes, p_limit: 30 });
  if (error) throw new Error(`conversation candidates failed: ${error.message}`);
  const out: Array<{ suggestion: string; card?: string; skipped?: string }> = [];
  for (const s of (data ?? []) as Array<SuggestionRow & { confidence: number | null }>) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    try {
      const { data: fu, error: fErr } = await sb.from('records').select('id, data').eq('id', s.followup_id!).maybeSingle();
      if (fErr) throw new Error(fErr.message);
      const fdata = ((fu as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
      // A reading that can never become a card is retired (as outcomeAutoApply
      // does), or it is re-read every tick and crowds out the live ones.
      const retire = async (why: string) => {
        if (!opts.dryRun) {
          const { error: rErr } = await sb.from('chat_outcome_suggestions').update({ status: 'superseded' }).eq('id', s.id).eq('status', 'ready');
          if (rErr) console.error(`[next-step] suggestion=${s.id} could not be retired: ${rErr.message}`);
        }
        out.push({ suggestion: s.id, skipped: `${why} (retired)` });
      };
      if (!fu || CLOSED.has(String(fdata.followup_status ?? ''))) { await retire('follow-up closed'); continue; }
      if (readType(fdata.followup_type) !== 'whatsapp_follow_up') { await retire('not a WhatsApp follow-up'); continue; }
      // Only recent chats become cards: an old reading is not a decision to put
      // in front of the agent today (it stays in the AI results list).
      if (s.last_message_at && Date.now() - Date.parse(s.last_message_at) > MAX_CARD_AGE_MS) { out.push({ suggestion: s.id, skipped: 'older than 3 days' }); continue; }
      const { data: cl, error: cErr } = await sb.from('records').select('data').eq('id', s.client_id).maybeSingle();
      if (cErr) throw new Error(cErr.message);
      const cdata = ((cl as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
      const owner = (typeof cdata.client_owner === 'string' && cdata.client_owner) || (typeof fdata.sales_rep === 'string' && fdata.sales_rep) || null;
      const card = {
        client_id: s.client_id, owner_user_id: owner, kind: 'conversation' as const, followup_id: s.followup_id,
        suggestion_id: s.id, summary: s.summary, client_quote: s.quoted_phrase, suggested_result: s.suggested_outcome,
        suggested_confidence: s.confidence, suggested_next: defaultNextAfterResult(s.suggested_outcome, s.suggested_fields, new Date()),
        last_message_at: s.last_message_at, updated_at: new Date().toISOString(),
      };
      if (opts.dryRun) { out.push({ suggestion: s.id, skipped: 'dry run (would make a card)' }); continue; }
      // One pending card per client: a newer reading refreshes it.
      const { data: existing, error: eErr } = await sb.from('next_step_reviews').select('id')
        .eq('client_id', s.client_id).eq('kind', 'conversation').eq('status', 'pending').maybeSingle();
      if (eErr) throw new Error(eErr.message);
      if (existing) {
        await patchReview(sb, (existing as { id: string }).id, card as Partial<ReviewRow>);
        out.push({ suggestion: s.id, card: (existing as { id: string }).id });
      } else {
        const { data: ins, error: iErr } = await sb.from('next_step_reviews').insert(card).select('id').single();
        if (iErr) throw new Error(iErr.message);
        out.push({ suggestion: s.id, card: (ins as { id: string }).id });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[next-step] card for suggestion=${s.id} failed: ${msg}`);
      out.push({ suggestion: s.id, skipped: `error: ${msg}` });
    }
  }
  return out;
}

/** Cron: finish decisions whose planned task did not exist yet. */
export async function finalizeWaiting(sb: SupabaseClient): Promise<number> {
  const { data, error } = await sb.from('next_step_reviews').select('*').eq('apply_state', 'waiting_task').limit(50);
  if (error) throw new Error(`waiting reviews read failed: ${error.message}`);
  let done = 0;
  for (const r of (data ?? []) as ReviewRow[]) {
    try {
      const plan = (r.decision?.next as NextPlan | undefined) ?? undefined;
      const how = r.status === 'auto_applied' ? 'default' : 'agent';
      const since = r.kind === 'after_call' ? r.created_at : (r.decided_at ?? r.created_at);
      const state = await applyPlan(sb, r, plan, r.decided_by, how, since);
      if (state === 'done') { await patchReview(sb, r.id, { apply_state: 'done' }); done += 1; }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[next-step] finalize review=${r.id} failed: ${msg}`);
      await patchReview(sb, r.id, { apply_state: 'failed', apply_error: msg });
    }
  }
  return done;
}

/**
 * Cron: at the end of the day (Riyadh hour ≥ next_step_default_hour), once per
 * day, apply every pending card as suggested. A conversation whose reading is
 * not confident enough or does not pass validation stays pending — a person
 * must decide it — with the reason in apply_error.
 */
export async function applyDefaults(
  sb: SupabaseClient, settings: AutomationSettings, opts: { now?: Date; dryRun?: boolean; deadline?: number } = {},
): Promise<{ ran: boolean; applied?: number; left?: number }> {
  if (!settings.owner_decides_next_step) return { ran: false };
  const now = opts.now ?? new Date();
  const { day, hour } = riyadhClock(now);
  if (hour < settings.next_step_default_hour || settings.next_step_default_ran_on === day) return { ran: false };
  if (opts.dryRun) return { ran: false };
  // Claim the day (one run, even if two cron ticks overlap).
  const { data: claimed, error: clErr } = await sb.from('ai_automation_settings')
    .update({ next_step_default_ran_on: day }).eq('id', 1)
    .or(`next_step_default_ran_on.is.null,next_step_default_ran_on.neq.${day}`).select('id');
  if (clErr) throw new Error(`default claim failed: ${clErr.message}`);
  if (!claimed?.length) return { ran: false };

  const { data, error } = await sb.from('next_step_reviews').select('*').eq('status', 'pending').order('created_at').limit(500);
  if (error) throw new Error(`pending reviews read failed: ${error.message}`);
  let applied = 0;
  let left = 0;
  const nowIso = now.toISOString();
  for (const r of (data ?? []) as ReviewRow[]) {
    if (opts.deadline && Date.now() > opts.deadline) { left += 1; continue; }
    try {
      if (r.kind === 'visit_booked') {
        await patchReview(sb, r.id, { status: 'auto_applied', decided_at: nowIso, decision: { default: true } });
        applied += 1;
      } else if (r.kind === 'after_call') {
        const state = await applyPlan(sb, r, undefined, null, 'default', r.created_at);
        await patchReview(sb, r.id, { status: 'auto_applied', decided_at: nowIso, apply_state: state, decision: { default: true } });
        applied += 1;
      } else {
        const s = await loadSuggestion(sb, r.suggestion_id);
        if (!s || (s.confidence ?? 0) < settings.outcome_auto_min_confidence) {
          await patchReview(sb, r.id, { apply_error: s ? `AI not sure enough (${s.confidence ?? 0}%) — needs the agent` : 'AI reading gone — needs the agent' });
          left += 1; continue;
        }
        const res = await applySuggestion(sb, s, { userId: null, reviewed: true });
        if (!res.applied) { await patchReview(sb, r.id, { apply_error: res.reason ?? 'could not apply' }); left += 1; continue; }
        await patchReview(sb, r.id, {
          status: 'auto_applied', decided_at: nowIso, apply_state: 'waiting_task',
          decision: { default: true, result: s.suggested_outcome },
        });
        applied += 1;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[next-step] default for review=${r.id} failed: ${msg}`);
      left += 1;
    }
  }
  return { ran: true, applied, left };
}

/** bookVisit: show the owner the visit the AI's question led to. Never throws. */
export async function addVisitCard(
  sb: SupabaseClient, a: { clientId: string; ownerUserId: string | null; appointmentId: string; summary: string },
): Promise<void> {
  try {
    const { data: s, error: sErr } = await sb.from('ai_automation_settings').select('owner_decides_next_step').eq('id', 1).maybeSingle();
    if (sErr) throw new Error(sErr.message);
    if (!(s as { owner_decides_next_step?: boolean } | null)?.owner_decides_next_step) return;
    const { error } = await sb.from('next_step_reviews').insert({
      client_id: a.clientId, owner_user_id: a.ownerUserId, kind: 'visit_booked', appointment_id: a.appointmentId, summary: a.summary,
    });
    if (error && error.code !== '23505') throw new Error(error.message);
  } catch (err) {
    console.error(`[next-step] visit card for appointment=${a.appointmentId} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
