/**
 * runScheduledWhatsappJob — fire a due WAHA scheduled message.
 *
 * WAHA has no server-side deliverAt (eval §4b), so scheduled_whatsapp_jobs holds
 * the message until its deliver_at passes; the worker's time-gated claim
 * (scheduled_whatsapp_claim_due) hands it here to actually send via WAHA.
 *
 * A row is one logical send: an optional text body, then its media items in
 * order (usually 0-1; a gallery is enqueued as multiple staggered rows upstream,
 * so ordering across rows comes from their deliver_at, not from this function).
 */

import type { WahaSendConfig, ScheduledMediaItem } from './waha.js';
import { sendText, sendMedia } from './waha.js';

export interface ScheduledWhatsappJob {
  id: string;
  deviceId: string;   // WAHA session name
  chatWid: string;    // "<digits>@c.us"
  phone: string | null;
  body: string | null;
  media: ScheduledMediaItem[];
  reference: string | null;
  attempts: number;
}

/**
 * The session to deliver on. `job.deviceId` is whatever the chat was last seen
 * on, and a job can sit in the queue across a re-pair — after the 2026-07-24
 * cutover, jobs stamped `wassel_main` failed with WAHA 422 `Session
 * "wassel_main" does not exist` (a real dropped send). If the stamped device is
 * not an active row, deliver on the active default instead. Mirrors
 * api/_lib/whatsappGateway.ts#sendDeviceId — keep both in step.
 */
async function deliverySession(cfg: WahaSendConfig, deviceId: string): Promise<string> {
  try {
    const { data } = await cfg.supabase
      .from('whatsapp_numbers').select('is_active').eq('device_id', deviceId).maybeSingle();
    if ((data as { is_active?: boolean } | null)?.is_active) return deviceId;
    const { data: def } = await cfg.supabase
      .from('whatsapp_numbers').select('device_id')
      .eq('is_active', true).eq('is_default', true).maybeSingle();
    const fallback = (def as { device_id?: string } | null)?.device_id;
    if (fallback && fallback !== deviceId) {
      console.warn(`[scheduled-whatsapp] device "${deviceId}" is retired — delivering on "${fallback}"`);
      return fallback;
    }
  } catch (err) {
    // Resolution must never be the reason a queued message fails to go out.
    console.error('[scheduled-whatsapp] device resolution failed:', err instanceof Error ? err.message : String(err));
  }
  return deviceId;
}

export async function runScheduledWhatsappJob(cfg: WahaSendConfig, job: ScheduledWhatsappJob): Promise<Record<string, unknown>> {
  const chatId = job.chatWid;
  const sentIds: string[] = [];
  const session = await deliverySession(cfg, job.deviceId);

  // A failure after ANY part was delivered must not be retried (a requeue would
  // re-send the delivered part), so it is re-thrown with a marker the poll
  // loop's transient-error matcher can never match.
  try {
    if (job.body && job.body.trim()) {
      sentIds.push(await sendText(cfg, session, chatId, job.body));
    }
    for (const item of job.media ?? []) {
      sentIds.push(await sendMedia(cfg, session, chatId, item));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (sentIds.length > 0) throw new Error(`partial send (${sentIds.length} part(s) already delivered, not retryable): ${msg}`);
    throw err;
  }

  if (sentIds.length === 0) {
    // Nothing to send — treat as a no-op success rather than a hard failure.
    return { sent: 0, note: 'empty scheduled message' };
  }
  return { sent: sentIds.length, ids: sentIds };
}
