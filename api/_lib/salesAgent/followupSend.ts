/**
 * Send one AI follow-up message (ai_actions kind='followup_message') — the ONE
 * path, used by the cron (no approval — operator, 2026-10-07: «remove the
 * approval… the agent is good now») and by /api/ai-actions when a person still
 * approves one by hand.
 *
 *   1. Claim pending → sending, once (a conditional update — two senders queue
 *      one message).
 *   2. Re-check it is still right to send: the follow-up is open and unsent,
 *      the client is not closed, the assistant is not paused in the chat.
 *   3. Queue it on the line the client last wrote from (never an internal
 *      line), PACED by ai_send_next_slot: one message 60–180 s after the
 *      previous one inside the sending window. Old-lead (campaign) messages
 *      start at the campaign's send time (12:00 Riyadh) and skip non-working
 *      days.
 *
 * A message that should not go is closed (`expired`) with the reason; a failure
 * to queue is `failed` with the error. Nothing is ever left silently «sending».
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { enqueueAiReply } from '../aiSend.js';

/** PURE — the hour of day in Riyadh. */
function riyadhHour(at: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Riyadh' }).format(at)) % 24;
}

/**
 * PURE — make the opening greeting match the time the message is DELIVERED.
 * Drafts are written hours before they go out (old-lead drafts at ~08:00 go out
 * from 12:00; a draft can wait overnight), so «صباح الخير» landed at 5 pm in 55
 * of 137 follow-ups (review 2026-10-07). Only a greeting at the very start is
 * touched; a message without one is returned as is.
 */
export function retimeGreeting(message: string, at: Date): string {
  const h = riyadhHour(at);
  const morning = h >= 4 && h < 12;
  const ar = /^(\s*)(صباح الخير|صباح النور|مساك الله بالخير|مساكم الله بالخير|مسيتي بالخير|مسيت بالخير|مساء الخير|مسا الخير)/;
  const m = message.match(ar);
  if (m) {
    const was = m[2]!;
    const isMorning = was.startsWith('صباح');
    if (isMorning === morning) return message;
    // Gender-neutral either way: the send step does not know the client's gender.
    const want = morning ? 'صباح الخير' : 'مساء الخير';
    return `${m[1]}${want}${message.slice(m[0].length)}`;
  }
  const en = message.match(/^(\s*)Good (morning|afternoon|evening)/i);
  if (en) {
    const want = morning ? 'morning' : h < 17 ? 'afternoon' : 'evening';
    return `${en[1]}Good ${want}${message.slice(en[0].length)}`;
  }
  return message;
}

const TERMINAL_STAGES = new Set(['خاسر', 'مغلق ناجح', 'غير مؤهل', 'يريد إيجار', 'طلب غير مجاب']);

export type FollowupSendResult =
  | { ok: true; job_id: string | null; send_at: string }
  | { ok: false; code: 'already_decided' | 'followup_moved' | 'client_closed' | 'ai_paused' | 'incomplete' | 'queue_failed'; message: string };

interface ActionRow {
  id: string; kind: string; status: string; client_id: string; chat_wid: string | null;
  followup_id: string | null; body: string; reference: string | null; context: Record<string, unknown> | null;
  created_at: string;
}

export async function sendFollowupAction(
  svc: SupabaseClient, id: string,
  opts: { decidedBy: string | null; editedBody?: string | null; auto: boolean },
): Promise<FollowupSendResult> {
  const now = new Date().toISOString();
  const { data: cur, error: rErr } = await svc.from('ai_actions').select('context').eq('id', id).maybeSingle();
  if (rErr) throw new Error(`action read failed: ${rErr.message}`);
  const ctx = ((cur as { context?: Record<string, unknown> | null } | null)?.context) ?? {};

  const patch: Record<string, unknown> = {
    status: 'sending', decided_by: opts.decidedBy, decided_at: now, updated_at: now, error: null,
    ...(opts.auto ? { context: { ...ctx, auto_sent: true } } : {}),
  };
  if (opts.editedBody) patch.body = opts.editedBody;
  const { data: claimed, error: cErr } = await svc.from('ai_actions').update(patch)
    .eq('id', id).eq('kind', 'followup_message').eq('status', 'pending').select('*');
  if (cErr) throw new Error(`claim failed: ${cErr.message}`);
  const a = (claimed?.[0] ?? null) as ActionRow | null;
  if (!a) return { ok: false, code: 'already_decided', message: 'not pending' };

  const close = async (status: 'pending' | 'expired' | 'failed', error: string) => {
    const { error: gErr } = await svc.from('ai_actions')
      .update({ status, error, updated_at: new Date().toISOString(), ...(status === 'pending' ? { decided_by: null, decided_at: null } : {}) })
      .eq('id', id).eq('status', 'sending');
    if (gErr) console.error(`[followup-send] could not move ${id} to ${status}: ${gErr.message}`);
  };

  try {
    if (!a.reference || !a.chat_wid) { await close('failed', 'the action has no reference or chat'); return { ok: false, code: 'incomplete', message: 'action incomplete' }; }
    const context = a.context ?? {};

    const [fRes, cRes, chRes] = await Promise.all([
      a.followup_id ? svc.from('records').select('data').eq('id', a.followup_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
      svc.from('records').select('data').eq('id', a.client_id).maybeSingle(),
      typeof context.chat_record_id === 'string'
        ? svc.from('records').select('data').eq('id', context.chat_record_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    for (const r of [fRes, cRes, chRes]) if (r.error) throw new Error(r.error.message);
    const f = (fRes.data as { data?: Record<string, unknown> } | null)?.data ?? null;
    const stillOpen = !!f && (String(f.followup_status ?? '') || 'open') === 'open' && !f.whatsapp_state && !f.sent_at;
    if (!stillOpen) { await close('expired', 'the follow-up is no longer open and unsent'); return { ok: false, code: 'followup_moved', message: 'followup_moved' }; }
    const stage = String(((cRes.data as { data?: Record<string, unknown> } | null)?.data ?? {}).client_stage ?? '');
    if (TERMINAL_STAGES.has(stage)) { await close('expired', `the client is now «${stage}»`); return { ok: false, code: 'client_closed', message: 'client_closed' }; }
    if (((chRes.data as { data?: Record<string, unknown> } | null)?.data ?? {}).ai_paused === true) {
      // A person paused the assistant in this chat. Sent by hand → give it back
      // so they can resume or write it themselves; sent automatically → closed,
      // never retried behind their back.
      const why = 'the assistant is paused in this chat — resume it, or send the message yourself';
      await close(opts.auto ? 'expired' : 'pending', why);
      return { ok: false, code: 'ai_paused', message: why };
    }

    // The chat moved on after the draft was written: the client wrote (the agent
    // or a rep answers them — a follow-up on top would ignore what they said), or
    // a rep wrote (they took it). Review 2026-10-07: a draft went out 5 minutes
    // after a rep sent the client three other projects.
    const { data: since, error: sinceErr } = await svc.from('chat_messages').select('flow, send_source')
      .eq('chat_wid', a.chat_wid).gt('date', a.created_at).limit(50);
    if (sinceErr) throw new Error(`chat re-check failed: ${sinceErr.message}`);
    const moved = (since ?? []) as { flow: string; send_source: string | null }[];
    if (moved.some((m) => m.flow === 'in')) { await close('expired', 'the client wrote after this draft was written'); return { ok: false, code: 'followup_moved', message: 'client_wrote' }; }
    if (moved.some((m) => m.flow === 'out' && m.send_source !== 'ai')) { await close('expired', 'a colleague wrote in the chat after this draft was written'); return { ok: false, code: 'followup_moved', message: 'rep_wrote' }; }

    // The line the client last wrote from — never an INTERNAL line (operations,
    // office outreach): a client follow-up from the office line is exactly the
    // unsolicited traffic that gets that line restricted.
    const internal = await internalDeviceIds(svc);
    let lastInQ = svc.from('chat_messages').select('device_id').eq('chat_wid', a.chat_wid).eq('flow', 'in');
    if (internal.length > 0) lastInQ = lastInQ.not('device_id', 'in', `(${internal.join(',')})`);
    const { data: lastIn } = await lastInQ.order('date', { ascending: false }).limit(1).maybeSingle();

    // PACED, never a burst (operator 2026-10-05).
    const { data: slot, error: slotErr } = await svc.rpc('ai_send_next_slot', { p_old_lead: typeof context.campaign === 'string' });
    if (slotErr) throw new Error(`send slot failed: ${slotErr.message}`);
    const delaySeconds = Math.max(0, Math.round((Date.parse(String(slot)) - Date.now()) / 1000));
    const text = retimeGreeting(a.body, new Date(Date.now() + delaySeconds * 1000));
    if (text !== a.body) {
      const { error: tErr } = await svc.from('ai_actions').update({ body: text }).eq('id', id);
      if (tErr) console.error(`[followup-send] could not store the re-timed greeting for ${id}: ${tErr.message}`);
    }
    const r = await enqueueAiReply(svc, {
      chatWid: a.chat_wid, text, deviceId: (lastIn as { device_id?: string | null } | null)?.device_id ?? null,
      jobId: 'followup', force: true, reference: a.reference, delaySeconds,
    });
    if (!r.queued) {
      const msg = r.error ?? r.reason ?? 'could not queue';
      await close('failed', msg);
      return { ok: false, code: 'queue_failed', message: msg };
    }
    const jobId = r.wid?.startsWith('sched:') ? r.wid.slice(6) : null;
    const { error: sErr } = await svc.from('ai_actions').update({ scheduled_job_id: jobId, updated_at: new Date().toISOString() }).eq('id', id);
    if (sErr) console.error(`[followup-send] queued ${id} but could not store its job id: ${sErr.message}`);
    return { ok: true, job_id: jobId, send_at: String(slot) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await close('failed', msg);
    throw err;
  }
}

/**
 * Device ids of the lines that must never carry a client follow-up: every
 * operations line and the office-outreach line. A failed lookup returns what it
 * could read and logs.
 */
async function internalDeviceIds(svc: SupabaseClient): Promise<string[]> {
  const ids = new Set<string>();
  const [ops, office] = await Promise.all([
    svc.from('whatsapp_numbers').select('device_id').eq('is_operations', true),
    svc.from('office_outreach_settings').select('device_id').eq('id', 1).maybeSingle(),
  ]);
  if (ops.error) console.error('[followup-send] could not read operations lines', ops.error);
  if (office.error) console.error('[followup-send] could not read the office-outreach line', office.error);
  for (const r of (ops.data ?? []) as { device_id?: string | null }[]) if (r.device_id) ids.add(r.device_id);
  const officeId = (office.data as { device_id?: string | null } | null)?.device_id;
  if (officeId) ids.add(officeId);
  return [...ids];
}
