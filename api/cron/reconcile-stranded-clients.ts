/**
 * GET / POST /api/cron/reconcile-stranded-clients — the Next-Action Backstop.
 *
 * Runs ONCE DAILY at 08:00 Asia/Riyadh (05:00 UTC; see vercel.json crons) to
 * enforce the invariant NO other layer owns: "every active client has exactly
 * one open next-action". The sales-task lifecycle DESTROYS tasks deterministically
 * (the reconcile_/supersede/retire SQL bridges) but only CREATES the next task
 * best-effort (the workflow engine, on a matching branch), so a task cancelled by
 * a bridge or completed with no create-branch can leave an active client stranded
 * — and the only self-heal (reconcile_inbound_whatsapp) fires only when the
 * CUSTOMER messages again. This backstop fills that gap on a clock instead.
 *
 * All the logic (predicate, 60-min grace, no-show-reopen vs whatsapp-fallback
 * branch, owner resolution → System Admin default queue, once-per-Riyadh-day
 * guard, creation_source='next_action_backstop' stamp) lives in the SQL RPC
 * `reconcile_stranded_clients(p_default_owner, p_grace_minutes, p_dry_run)`, so
 * this endpoint is a thin runner — same posture as api/sweep-appointment-noshows.ts.
 *
 * Idempotent: the RPC's own once-a-day state guard means extra ticks (a manual
 * smoke test, a Vercel retry) are no-ops; the "zero open tasks" predicate means a
 * client with a fresh task no longer qualifies.
 *
 * SECOND LANE (2026-09-20): the same tick also runs `reconcile_open_searches()`,
 * which enforces "an open unanswered request always has one open search task".
 * Clients parked at «طلب غير مجاب» are deliberately excluded from the backstop
 * above — that stage SUSPENDS ordinary follow-up — so without this second call
 * nothing at all would notice a stalled search. The two results are reported
 * under separate keys (`stranded_clients` / `open_searches`) so a failure in one
 * lane can never be hidden by success in the other.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET` (Vercel Cron) OR `?secret=` for a
 * manual smoke test; `?dry=1` previews (writes nothing, bypasses the daily guard).
 *
 * @see supabase/migrations/2026-09-03_next_action_backstop.sql
 * @see docs/next-action-backstop-spec.md
 */

import { getServiceSupabase } from '../_lib/supabaseServer.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request): Promise<Response> {
  const startedAt = Date.now();

  // 1. Auth — refuse to run unauthenticated (a public writer is a DoS vector).
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return json({ error: 'CRON_SECRET is not set; refusing to run an unauthenticated backstop' }, 500);
  }
  const url = new URL(req.url);
  const authHeader = req.headers.get('authorization') ?? '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const sent = bearer || url.searchParams.get('secret') || '';
  if (sent !== expected) {
    return json({ error: 'unauthorized' }, 401);
  }

  // 2. Service-role client (the RPC is granted to service_role only).
  const supabase = getServiceSupabase();

  // 3. Run the reconciler. p_default_owner=null → the RPC resolves the System
  //    Admin queue itself; grace 60 min; dry-run when ?dry=1.
  const dry = url.searchParams.get('dry') === '1';
  const { data, error } = await supabase.rpc('reconcile_stranded_clients', {
    p_default_owner: null,
    p_grace_minutes: 60,
    p_dry_run: dry,
  });
  if (error) {
    return json({ ok: false, error: `reconcile_stranded_clients failed: ${error.message}` }, 500);
  }

  // 4. The SEARCH lane's equivalent invariant: "an open unanswered request
  //    always has one open search task". Those clients are deliberately OUTSIDE
  //    the backstop above (stage «طلب غير مجاب» suspends ordinary follow-up), so
  //    nothing else would notice a stalled search. Recurrence there is
  //    completion-driven, which does not self-stop — it STALLS if nobody ever
  //    completes the task, and a stalled search is a client quietly forgotten.
  //
  //    Runs even if the first reconciler was a no-op; reported separately so a
  //    failure in one lane is never hidden by success in the other.
  const { data: searchData, error: searchError } = await supabase.rpc('reconcile_open_searches', {
    p_dry_run: dry,
  });
  if (searchError) {
    return json({
      ok: false,
      stranded_clients: data,
      error: `reconcile_open_searches failed: ${searchError.message}`,
    }, 500);
  }

  return json({
    ok: true,
    stranded_clients: data,
    open_searches: searchData,
    duration_ms: Date.now() - startedAt,
  }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
