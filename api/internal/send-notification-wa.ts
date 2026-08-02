/**
 * POST /api/internal/send-notification-wa  — internal, worker-only.
 *
 * Sends ONE claimed notification_deliveries row over WhatsApp. Auth is the
 * shared WORKFLOW_RUNNER_SECRET (bearer), NOT a user JWT — the caller is the
 * Fly worker draining notification_deliveries, not a browser. The worker never
 * talks to WAHA directly: api/_lib/whatsappGateway.ts is the ONLY WhatsApp
 * send path, and it lives here in the API runtime.
 *
 * QUEUE LIFECYCLE IS SHARED, DELIBERATELY:
 *   - no-phone / notification-missing: THIS endpoint marks the delivery via
 *     notification_delivery_fail and returns 200 { ok:false, reason } — the
 *     worker's own _fail call afterwards is a no-op (the row already left
 *     'running'), so there is no double accounting.
 *   - external_effects off: the delivery is stamped 'skipped' directly (a
 *     visible no-op, NOT a failure — same posture as notify_emit's own
 *     'skipped' rows) and the endpoint returns 200 { ok:true, skipped:true }.
 *     The worker's _complete then no-ops because the row is no longer
 *     'running' — 'skipped' survives.
 *   - WAHA send failure (HaberchatError): 200 { ok:false, error } — the
 *     endpoint records NOTHING; the worker calls notification_delivery_fail,
 *     whose attempts counter guards the retries (requeue until 5, then
 *     'failed').
 *
 * Contract:
 *   missing secret        → 503 (misconfigured — fail closed, no bypass)
 *   wrong secret          → 401
 *   non-POST              → 405
 *   bad body              → 400
 *   delivery not found    → 404
 *   ok                    → 200 { ok:true, wid? } | { ok:true, skipped:true }
 *   handled failure       → 200 { ok:false, reason|error }
 */
import type { IncomingMessage, ServerResponse } from 'http';
import crypto from 'node:crypto';
import { makeServiceClient } from '../_lib/serviceClient.js';
import { sendMessage, resolveDefaultDeviceId, HaberchatError } from '../_lib/whatsappGateway.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (status: number, body: unknown): void => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };

  if (req.method !== 'POST') return send(405, { error: 'method not allowed' });

  // Fail closed: a missing secret is a misconfiguration, NOT an open door.
  // Same shared secret as /api/internal/run-workflow-job — one secret for the
  // worker→app internal surface.
  const secret = process.env.WORKFLOW_RUNNER_SECRET;
  if (!secret) return send(503, { error: 'WORKFLOW_RUNNER_SECRET not configured' });
  const auth = (req.headers['authorization'] as string | undefined) ?? '';
  const provided = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!provided || !timingSafeEqual(provided, secret)) return send(401, { error: 'unauthorized' });

  let deliveryId: string | undefined;
  try {
    const body = JSON.parse((await readBody(req)) || '{}') as { delivery_id?: string };
    deliveryId = body.delivery_id;
  } catch {
    return send(400, { error: 'invalid JSON body' });
  }
  if (!deliveryId) return send(400, { error: 'delivery_id is required' });

  const supabase = makeServiceClient('api:send-notification-wa');
  if (!supabase) return send(503, { error: 'Supabase service env not configured' });

  // Load EVERYTHING fresh from the DB — the request body is never trusted
  // beyond naming the delivery (same posture as run-workflow-job).
  const { data: delivery, error: delErr } = await supabase
    .from('notification_deliveries')
    .select('id, notification_id, channel, status')
    .eq('id', deliveryId)
    .maybeSingle();
  if (delErr) return send(500, { error: `load delivery failed: ${delErr.message}` });
  if (!delivery) return send(404, { error: 'delivery not found' });

  const failDelivery = async (reason: string): Promise<void> => {
    const { error } = await supabase.rpc('notification_delivery_fail', { p_id: delivery.id, p_error: reason });
    if (error) console.error(`[send-notification-wa] could not fail delivery ${delivery.id}: ${error.message}`);
  };

  const { data: notification, error: ntfErr } = await supabase
    .from('notifications')
    .select('id, user_id, kind, title_ar, body_ar, url')
    .eq('id', delivery.notification_id as string)
    .maybeSingle();
  if (ntfErr) return send(500, { error: `load notification failed: ${ntfErr.message}` });
  if (!notification) {
    // The notification was deleted after the delivery was queued — nothing to
    // send, and retrying cannot fix it. Still recorded through the RPC (which
    // applies its own attempts discipline) so the outcome is visible.
    await failDelivery('notification-missing');
    return send(200, { ok: false, reason: 'notification-missing' });
  }

  // The kill switch: a delivery that reached the queue while external effects
  // were on but is sent while they are off must not go out. 'skipped' is a
  // visible no-op, not a failure — stamped directly because
  // notification_delivery_fail only knows pending/failed.
  const { data: extRow } = await supabase
    .from('mos_settings')
    .select('value')
    .eq('key', 'external_effects')
    .maybeSingle();
  const externalOn = ((extRow?.value as { enabled?: boolean } | null)?.enabled) ?? true;
  if (!externalOn) {
    const { error } = await supabase
      .from('notification_deliveries')
      .update({ status: 'skipped', last_error: 'external-effects-off' })
      .eq('id', delivery.id)
      .eq('status', 'running');
    if (error) console.error(`[send-notification-wa] could not skip delivery ${delivery.id}: ${error.message}`);
    console.log(`[send-notification-wa] delivery ${delivery.id} skipped — external_effects off`);
    return send(200, { ok: true, skipped: true });
  }

  const { data: recipient, error: usrErr } = await supabase
    .from('users')
    .select('id, name_ar, name_en, phone')
    .eq('id', notification.user_id as string)
    .maybeSingle();
  if (usrErr) return send(500, { error: `load recipient failed: ${usrErr.message}` });
  const phone = (recipient?.phone as string | null | undefined)?.trim() ?? '';
  if (!recipient || !phone) {
    await failDelivery('no-phone');
    return send(200, { ok: false, reason: 'no-phone' });
  }

  const appBase = (process.env.APP_URL ?? 'https://app.wassel.re').replace(/\/+$/, '');
  const url = notification.url as string | null;
  const absoluteUrl = url ? (/^https?:\/\//.test(url) ? url : `${appBase}${url}`) : '';
  const message =
    (notification.title_ar as string) +
    '\n' +
    ((notification.body_ar as string | null) ?? '') +
    (absoluteUrl ? `\n${absoluteUrl}` : '');

  const deviceId = await resolveDefaultDeviceId();
  if (!deviceId) {
    // No active default number configured — transient (a number can be
    // re-paired at any time), so let the worker fail + retry.
    return send(200, { ok: false, error: 'no-default-device' });
  }

  try {
    const result = await sendMessage({ deviceId, phone, body: message });
    return send(200, { ok: true, wid: result.wid });
  } catch (err) {
    if (err instanceof HaberchatError) {
      // WAHA failure translated at the gateway. Record NOTHING here — the
      // worker calls notification_delivery_fail, whose attempts counter
      // guards the retries (requeue until 5 attempts, then terminal).
      return send(200, { ok: false, error: `whatsapp send failed (${err.status}): ${err.message}` });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return send(500, { error: msg });
  }
}
