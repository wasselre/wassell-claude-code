/**
 * GET / POST /api/cron/bundle-status — every 10 min: reconcile in-flight
 * bundle.social posts with reality.
 *
 * Flips POSTED → published (+permalink), records ERROR (+ a `publish_failed`
 * notification to the publishing roles), and returns DELETED posts to draft.
 * See api/_lib/marketing/bundleStatusSync.ts — the same runBundleStatusSweep()
 * backs the Publishing Board's `publication_sync_all` action (one
 * implementation, two triggers, same posture as bundle-metrics).
 *
 * Why a cron and not just the webhook: bundle's webhook fires post.published
 * ONLY — a post that FAILS at its scheduled slot emits nothing. Without this
 * sweep, a failed scheduled post stays green-«مجدول» forever and nobody knows
 * nothing went out. 10 minutes bounds how long a failure can stay invisible.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET` (Vercel Cron) or `?secret=` for a
 * manual smoke test. Refuses to run without CRON_SECRET. Self-disabling when
 * bundle env is absent ({ skipped:'not_configured' }).
 */
import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { runBundleStatusSweep } from '../_lib/marketing/bundleStatusSync.js';

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
  const summary = await runBundleStatusSweep(sb);
  // Always 200 — a bundle hiccup must not make Vercel mark the cron failed;
  // the structured result carries the counts for inspection.
  return json({ ...summary, duration_ms: Date.now() - startedAt }, 200);
}
