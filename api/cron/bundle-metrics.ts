/**
 * GET / POST /api/cron/bundle-metrics — daily bundle.social analytics → MOS.
 *
 * Pulls normalized performance numbers (views, likes, comments, saves,
 * engagement) for every published post we made through bundle.social in the
 * last 30 days and appends an `api` metric snapshot when the reading changed
 * (see api/_lib/marketing/bundleMetrics.ts). The same runBundleMetricsSync()
 * also backs the on-demand `metrics_pull` action in marketing-os.ts — one
 * implementation, two triggers (same posture as meta-sync).
 *
 * bundle refreshes analytics every 24h, so a daily pull keeps the Numbers
 * screen current without anyone hand-entering a figure.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET` (Vercel Cron) or `?secret=` for a
 * manual smoke test. Refuses to run without CRON_SECRET.
 *
 * Self-disabling: returns { skipped:'not_configured' } when the bundle env is
 * absent, so this endpoint is a harmless no-op until bundle is wired.
 */
import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { runBundleMetricsSync } from '../_lib/marketing/bundleMetrics.js';
import { runBundleAccountMetricsSync } from '../_lib/marketing/bundleAccountMetrics.js';

export const config = { runtime: 'edge' };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
  // Two independent pulls: per-POST numbers (Numbers screen) and per-ACCOUNT
  // profile numbers (Platform Pulse growth history). Settled separately so one
  // failing never blocks the other; both are self-disabling when bundle is unset.
  const [posts, accounts] = await Promise.all([
    runBundleMetricsSync(sb),
    runBundleAccountMetricsSync(sb),
  ]);
  // Always 200 — a bundle hiccup must not make Vercel mark the cron failed; the
  // structured result carries the counts/skip for inspection.
  return json({ ...posts, accounts, duration_ms: Date.now() - startedAt }, 200);
}
