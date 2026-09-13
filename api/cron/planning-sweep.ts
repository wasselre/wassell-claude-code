/**
 * GET / POST /api/cron/planning-sweep — the campaign-planning clock.
 *
 * Every 10 minutes (vercel.json):
 *   1. `mos_plan_start_due()` — opens the FIRST workflow task for planned
 *      content whose `production_start` has arrived. This is why the commit
 *      does not open tasks: a campaign approved three weeks early should not
 *      dump twenty tasks into the queue today. Paid replacement slots get their
 *      content shells created here too, at each cycle's `production_start_on`.
 *   2. `mos_plan_repair()` — marks reservations whose window has passed but
 *      whose step never opened as `stale`, re-dates them forward, and flags any
 *      publishing batch that can no longer make its required-ready date. A
 *      batch at risk raises ONE `plan_conflict` task for the manager with the
 *      options; publishing dates are never moved silently.
 *
 * The refresh-cycle clock lives in the Fly worker (it has to talk to Meta);
 * this endpoint is the database-only half.
 *
 * Auth: Bearer $CRON_SECRET or ?secret= for smoke tests. Always 200 so Vercel
 * never marks the cron failed; the structured body carries each step's outcome
 * and any error is ALSO console.error-ed (repo rule: fail loudly, never
 * silently).
 */
import { getServiceSupabase } from '../_lib/supabaseServer.js';

export const config = { runtime: 'edge' };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export default async function handler(req: Request): Promise<Response> {
  const startedAt = Date.now();

  const expected = process.env.CRON_SECRET;
  if (!expected) return json({ error: 'CRON_SECRET is not set; refusing to run' }, 500);
  const url = new URL(req.url);
  const authHeader = req.headers.get('authorization') ?? '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const sent = bearer || url.searchParams.get('secret') || '';
  if (sent !== expected) return json({ error: 'unauthorized' }, 401);

  const sb = getServiceSupabase();
  const out: Record<string, unknown> = {};

  // 1 — open what is due to start.
  const started = await sb.rpc('mos_plan_start_due');
  if (started.error) {
    console.error('[planning-sweep] mos_plan_start_due failed', started.error.code, started.error.message);
    out.start_due = { error: started.error.message };
  } else {
    out.start_due = started.data;
  }

  // 2 — repair drift and flag batches at risk.
  const repaired = await sb.rpc('mos_plan_repair', { p_campaign_id: null });
  if (repaired.error) {
    console.error('[planning-sweep] mos_plan_repair failed', repaired.error.code, repaired.error.message);
    out.repair = { error: repaired.error.message };
  } else {
    out.repair = repaired.data;
  }

  out.ms = Date.now() - startedAt;
  return json(out, 200);
}
