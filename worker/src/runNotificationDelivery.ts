/**
 * Deliver claimed notification_deliveries rows via the app's internal send
 * endpoint.
 *
 * The worker NEVER talks to WAHA directly — api/_lib/whatsappGateway.ts is the
 * only WhatsApp send path and it lives in the Vercel API runtime (it reads
 * whatsapp_numbers for the default device and mos_settings for the kill
 * switch). So this queue is worker-claims → app-sends, the same pattern as the
 * server-authoritative workflow runner (run-workflow-job).
 *
 * Outcome contract with the endpoint (see api/internal/send-notification-wa.ts):
 *   200 { ok:true }            sent (or skipped — the endpoint already stamped
 *                              the terminal row, and the worker's _complete
 *                              no-ops on it because it left 'running')
 *   200 { ok:false, reason }   handled failure the ENDPOINT already recorded
 *                              (no-phone, notification-missing). We still
 *                              throw here — the worker's _fail then no-ops on
 *                              the row (already out of 'running'), so there is
 *                              no double accounting — and throwing keeps the
 *                              failure visible in the worker log.
 *   200 { ok:false, error }    WAHA failure recorded NOWHERE yet — the
 *                              worker's _fail is the one that records it;
 *                              notification_delivery_fail guards the retries
 *                              (requeue until 5 attempts, then 'failed').
 *   non-200 / timeout          transport-class — throw; worker fails + retries.
 */
import type { WorkerEnv } from './env.js';

export interface NotificationDeliveryRow {
  id: string;
  notification_id: string;
  channel: string;
}

const ENDPOINT_TIMEOUT_MS = 30_000;

export async function runNotificationDelivery(job: NotificationDeliveryRow, env: WorkerEnv): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENDPOINT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${env.APP_URL}/api/internal/send-notification-wa`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Caller is only reached when WORKFLOW_RUNNER_SECRET is set (the loop
        // self-disables otherwise) — non-null here.
        authorization: `Bearer ${env.WORKFLOW_RUNNER_SECRET!}`,
      },
      body: JSON.stringify({ delivery_id: job.id }),
      signal: controller.signal,
    });
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.name === 'AbortError'
          ? `timeout after ${ENDPOINT_TIMEOUT_MS / 1000}s`
          : err.message
        : String(err);
    throw new Error(`transport: ${msg}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);

  let body: { ok?: boolean; skipped?: boolean; reason?: string; error?: string };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(`malformed body: ${text.slice(0, 300)}`);
  }
  if (body.ok === false) throw new Error(body.error ?? body.reason ?? 'endpoint reported failure');
}
