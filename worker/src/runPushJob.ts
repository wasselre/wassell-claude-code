/**
 * Deliver queued push notifications to a rep's devices.
 *
 * Eighth queue on this worker. `push_outbox` is filled by the
 * records_enqueue_push trigger (see supabase/migrations/2026-07-29_web_push.sql)
 * the moment a hot lead lands or a customer replies. Delivery has to happen
 * here rather than in Postgres because neither pg_net nor pg_cron is installed
 * on this project — the database cannot make an outbound HTTP call.
 *
 * Encryption is delegated to `web-push`. Web Push payloads are aes128gcm with
 * an ECDH key agreement per subscription and a VAPID JWT per request; that is
 * not something to hand-roll.
 */
import webpush from 'web-push';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface PushOutboxRow {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  url: string | null;
  tag: string | null;
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

let configured = false;

/** Returns false when VAPID isn't configured, which keeps the loop inert. */
export function configurePush(
  publicKey: string | null,
  privateKey: string | null,
  subject: string | null,
): boolean {
  if (!publicKey || !privateKey) return false;
  // `subject` must be a mailto: or https: URL identifying us to the push
  // service; Apple rejects the request outright without a valid one.
  webpush.setVapidDetails(subject || 'mailto:support@wassel.re', publicKey, privateKey);
  configured = true;
  return true;
}

/**
 * Send one queued notification to every device the target user has registered.
 *
 * Returns the number of devices that accepted it. Throws only when something
 * is wrong with the JOB (no subscriptions is not an error — it just means the
 * rep hasn't enabled notifications, which we record and move on from).
 */
export async function runPushJob(
  supabase: SupabaseClient,
  job: PushOutboxRow,
): Promise<{ delivered: number; pruned: number; note?: string }> {
  if (!configured) throw new Error('VAPID not configured');

  const { data: subs, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', job.user_id);

  if (error) throw new Error(`subscription lookup failed: ${error.message}`);

  const subscriptions = (subs ?? []) as SubscriptionRow[];
  if (subscriptions.length === 0) {
    // Not a failure: this rep simply has no device registered. Recorded on the
    // row so "why didn't I get a notification" has an answer in the data.
    return { delivered: 0, pruned: 0, note: 'no registered devices' };
  }

  const payload = JSON.stringify({
    title: job.title,
    body: job.body,
    url: job.url ?? '/',
    tag: job.tag ?? undefined,
  });

  let delivered = 0;
  let pruned = 0;
  const failures: string[] = [];

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        {
          // A hot lead is worthless an hour later; don't let a push service
          // sit on it. Matches push_outbox_expire_stale on the DB side.
          TTL: 3600,
          urgency: 'high',
        },
      );
      delivered++;
      await supabase
        .from('push_subscriptions')
        .update({ last_success_at: new Date().toISOString(), failure_count: 0 })
        .eq('id', sub.id);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      const message = err instanceof Error ? err.message : String(err);

      // 404/410 mean the endpoint is permanently gone — the rep deleted the
      // app or the push service rotated it. Keeping the row would make every
      // future notification report a failure forever.
      if (status === 404 || status === 410) {
        await supabase.from('push_subscriptions').delete().eq('id', sub.id);
        pruned++;
        console.log(`[push] pruned dead subscription ${sub.id} (${status})`);
        continue;
      }

      failures.push(`${status ?? 'ERR'}: ${message}`);
      console.error(`[push] send failed for subscription ${sub.id}:`, status, message);
      await supabase.rpc('increment_push_failure', { p_id: sub.id }).then(
        () => undefined,
        // The counter is diagnostic only — never let it mask the send result.
        (e: unknown) => console.error('[push] failure-count update failed:', e),
      );
    }
  }

  // Every device failed for a reason that wasn't "gone" → let the job retry.
  if (delivered === 0 && failures.length > 0) {
    throw new Error(`all ${failures.length} device(s) failed: ${failures.join(' | ')}`);
  }

  return {
    delivered,
    pruned,
    note: failures.length ? `${failures.length} device(s) failed: ${failures.join(' | ')}` : undefined,
  };
}
