/**
 * GET / POST /api/cron/watchdogs — watchdog backstop OUTSIDE the Fly worker (T6).
 *
 * Every queue's stuck-job sweep + the conflict-storm detector run from the Fly
 * worker's own tick. If ALL worker machines are down, nothing sweeps and stuck
 * records (e.g. a migration frozen at status='extracting') never self-heal. This
 * Vercel cron is an independent backstop: it invokes the SAME idempotent
 * watchdog/sweep RPCs on a schedule, so recovery happens even with the worker
 * down. (pg_cron is not enabled on this project; CLAUDE.md.)
 *
 * Auth: same as the other crons — `Authorization: Bearer $CRON_SECRET` (sent by
 * Vercel Cron) OR `?secret=<CRON_SECRET>` for manual smoke tests. Without a
 * configured CRON_SECRET it refuses to run (a public watchdog endpoint would be
 * a DoS vector).
 *
 * Idempotency: every RPC here only acts on STALE/ORPHAN state behind a WHERE
 * guard, so running it alongside the worker's own ticks is harmless (both are
 * idempotent UPDATEs). A failure of one RPC NEVER stops the rest — each runs in
 * its own try/catch and the response carries a per-RPC result/error summary.
 *
 * Does NOT change worker behavior — it calls the same RPCs the worker calls.
 */

import { getServiceSupabase } from '../_lib/supabaseServer.js';

export const config = {
  // Web Request/Response → edge runtime, matching the other cron sweepers.
  runtime: 'edge',
};

// The watchdog/sweep RPCs the Fly worker ticks. Kept in sync with the loops in
// worker/src/index.ts. All are SECURITY DEFINER, granted to service_role, and
// idempotent (guarded WHERE on stale/orphan state).
const WATCHDOG_RPCS = [
  'deck_jobs_watchdog',
  'generation_jobs_watchdog',
  'file_preview_watchdog',
  'pdf_compress_watchdog',
  'document_jobs_watchdog',
  'data_migration_jobs_watchdog',
  'scheduled_reports_watchdog',
  'conflict_storm_sweep',
] as const;

interface RpcOutcome {
  rpc: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export default async function handler(req: Request): Promise<Response> {
  const startedAt = Date.now();

  // 1. Auth — refuse to run unauthenticated.
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return json({ error: 'CRON_SECRET is not set; refusing to run an unauthenticated watchdog' }, 500);
  }
  const url = new URL(req.url);
  const authHeader = req.headers.get('authorization') ?? '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const sent = bearer || url.searchParams.get('secret') || '';
  if (sent !== expected) {
    return json({ error: 'unauthorized' }, 401);
  }

  // 2. Service-role client (the RPCs are granted to service_role only).
  const supabase = getServiceSupabase();

  // 3. Run each watchdog independently — one failing RPC must not stop the rest.
  const results: RpcOutcome[] = [];
  for (const rpc of WATCHDOG_RPCS) {
    try {
      const { data, error } = await supabase.rpc(rpc);
      if (error) results.push({ rpc, ok: false, error: error.message });
      else results.push({ rpc, ok: true, result: data });
    } catch (err) {
      results.push({ rpc, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const failed = results.filter((r) => !r.ok).length;
  // Always 200 (watchdogs are best-effort and idempotent — a single RPC hiccup
  // must not make Vercel mark the whole cron failed); the structured summary
  // carries the per-RPC outcome for inspection/alerting.
  return json({ ok: failed === 0, ran: results.length, failed, results, duration_ms: Date.now() - startedAt }, 200);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
