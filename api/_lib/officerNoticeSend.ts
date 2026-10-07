/**
 * Send an officer notice WITHOUT the operator's approval (operator,
 * 2026-10-07: «I want them to be sent without approval» — once the interest
 * rules in officerInterestGate.ts decide). Switch:
 * ai_automation_settings.officer_notice_auto_send.
 *
 * Same path as an approval in /api/ai-actions — claim pending → sending once,
 * queue on the OPERATIONS line through scheduled_whatsapp_enqueue — except it
 * waits for the officer's hours (09:00–21:00 Riyadh, officerDeliverAt) and
 * marks the action `context.auto_sent`. A failure to queue marks the action
 * failed and throws; it never leaves it silently pending or «sending».
 */
import type { Svc } from './leadPortals.js';
import { officerDeliverAt } from './officerRegistrationNotice.js';

export async function sendOfficerNotice(
  svc: Svc, actionId: string, operationsDeviceId: () => Promise<string | null>, now = new Date(),
): Promise<{ status: 'queued'; job_id: string | null; deliver_at: string } | { status: 'not_pending' }> {
  const ops = await operationsDeviceId();
  if (!ops) throw new Error('no operations WhatsApp line is configured — the notice stays pending');

  const { data: a, error: rErr } = await svc.from('ai_actions')
    .select('id, status, chat_wid, phone, body, reference, context').eq('id', actionId).maybeSingle();
  if (rErr) throw new Error(`notice read failed: ${rErr.message}`);
  const act = a as { id: string; status: string; chat_wid: string; phone: string | null; body: string; reference: string | null; context: Record<string, unknown> | null } | null;
  if (!act || act.status !== 'pending') return { status: 'not_pending' };

  const deliverAt = officerDeliverAt(now);
  const stamp = new Date().toISOString();
  const { data: claimed, error: cErr } = await svc.from('ai_actions')
    .update({ status: 'sending', decided_at: stamp, updated_at: stamp, device_id: ops, context: { ...(act.context ?? {}), auto_sent: true, deliver_at: deliverAt } })
    .eq('id', actionId).eq('status', 'pending').select('id');
  if (cErr) throw new Error(`notice claim failed: ${cErr.message}`);
  if (!claimed?.length) return { status: 'not_pending' };

  const { data: jobId, error: qErr } = await svc.rpc('scheduled_whatsapp_enqueue', {
    p_device_id: ops, p_chat_wid: act.chat_wid, p_phone: act.phone ?? `+${act.chat_wid.split('@')[0]}`, p_body: act.body,
    p_media: null, p_reference: act.reference ?? `officer_notice:${actionId}`, p_deliver_at: deliverAt, p_user_id: null,
  });
  // 23505 = already queued under this reference (a race with a manual approve).
  if (qErr && qErr.code !== '23505') {
    const { error: fErr } = await svc.from('ai_actions')
      .update({ status: 'failed', error: `could not queue: ${qErr.message}`, updated_at: new Date().toISOString() })
      .eq('id', actionId).eq('status', 'sending');
    if (fErr) console.error(`[officer-notice-send] could not mark ${actionId} failed: ${fErr.message}`);
    throw new Error(`queueing the officer notice failed: ${qErr.message}`);
  }
  if (jobId) {
    const { error: uErr } = await svc.from('ai_actions').update({ scheduled_job_id: jobId as string, updated_at: new Date().toISOString() }).eq('id', actionId);
    if (uErr) console.error(`[officer-notice-send] queued ${actionId} but could not store its job id: ${uErr.message}`);
  }
  return { status: 'queued', job_id: (jobId as string | null) ?? null, deliver_at: deliverAt };
}
