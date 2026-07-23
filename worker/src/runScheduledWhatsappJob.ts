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

export async function runScheduledWhatsappJob(cfg: WahaSendConfig, job: ScheduledWhatsappJob): Promise<Record<string, unknown>> {
  const chatId = job.chatWid;
  const sentIds: string[] = [];

  // A failure after ANY part was delivered must not be retried (a requeue would
  // re-send the delivered part), so it is re-thrown with a marker the poll
  // loop's transient-error matcher can never match.
  try {
    if (job.body && job.body.trim()) {
      sentIds.push(await sendText(cfg, job.deviceId, chatId, job.body));
    }
    for (const item of job.media ?? []) {
      sentIds.push(await sendMedia(cfg, job.deviceId, chatId, item));
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
