/**
 * GET / POST /api/cron/portal-status-sync — the daily portal status check.
 *
 * Runs once a day at 12:00 Riyadh (09:00 UTC, vercel.json). For every active
 * lead portal whose `status_sync_enabled` is on and that has a
 * `status_recipe`, and that has at least one client registered with it, it
 * enqueues ONE status-check job (portal_status_check_enqueue — a second call
 * while one is live returns the same job). The Fly worker signs in, reads the
 * portal's client list and portal_status_sync_apply() refreshes every
 * registration, alerting the client's rep on a status change.
 *
 * A portal that signs in with an SMS code asks for it on the operations
 * WhatsApp (the same relay as registrations). Unanswered → the job PARKS and
 * restarts when the phone owner next messages the ops line; it does not nag.
 * Riva-style portals (no code) complete on their own.
 *
 * Enqueue-only, like every worker queue here. Auth: Bearer $CRON_SECRET or
 * ?secret= for smoke tests. Always 200 once authorised; the body carries every
 * outcome and failures are console.error-ed.
 */
import { makeServiceClient } from '../_lib/serviceClient.js';
import { type Rec, str, LEAD_PORTALS_MODEL_ID } from '../_lib/leadPortals.js';
import { requestStatusCheck, portalCanCheckStatus } from '../_lib/portalRegistrations.js';

export const config = { runtime: 'edge' };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export default async function handler(req: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET;
  if (!expected) return json({ error: 'CRON_SECRET is not set; refusing to run' }, 500);
  const url = new URL(req.url);
  const authHeader = req.headers.get('authorization') ?? '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const sent = bearer || url.searchParams.get('secret') || '';
  if (sent !== expected) return json({ error: 'unauthorized' }, 401);

  const svc = makeServiceClient('api:cron:portal-status-sync');
  if (!svc) return json({ error: 'server env missing: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY' }, 500);

  const results: { portal_id: string; portal: string; outcome: string; job_id?: string; reason?: string }[] = [];
  try {
    const { data: portalRows, error } = await svc
      .from('unified_records')
      .select('id, data')
      .eq('model_id', LEAD_PORTALS_MODEL_ID);
    if (error) throw new Error(`portals load failed: ${error.message}`);

    for (const portal of (portalRows ?? []) as Rec[]) {
      const name = str(portal.data?.name) || portal.id;
      if (!portalCanCheckStatus(portal)) continue;

      // Don't spend a code on a portal we have nobody in.
      const { count, error: cntErr } = await svc
        .from('client_portal_registrations')
        .select('id', { count: 'exact', head: true })
        .eq('portal_record_id', portal.id)
        .eq('our_status', 'registered');
      if (cntErr) {
        console.error(`[portal-status-sync] count failed for ${name}: ${cntErr.message}`);
        results.push({ portal_id: portal.id, portal: name, outcome: 'failed', reason: cntErr.message });
        continue;
      }
      // Inventory-only portals have no client registrations. Their explicit
      // opt-in allows the same daily sign-in to refresh the unit snapshot.
      if (!count && portal.data?.inventory_capture_enabled !== true) {
        results.push({ portal_id: portal.id, portal: name, outcome: 'skipped', reason: 'no registered clients' });
        continue;
      }

      try {
        const jobId = await requestStatusCheck(svc, portal, null);
        results.push({ portal_id: portal.id, portal: name, outcome: 'queued', job_id: jobId });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[portal-status-sync] enqueue failed for ${name}: ${reason}`);
        results.push({ portal_id: portal.id, portal: name, outcome: 'failed', reason });
      }
    }
    return json({ ok: true, results }, 200);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[portal-status-sync] ${reason}`);
    return json({ ok: false, error: reason, results }, 200);
  }
}
