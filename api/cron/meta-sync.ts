/**
 * GET / POST /api/cron/meta-sync — scheduled Meta Marketing API → MOS sync.
 *
 * Pulls OUR ad account's campaign/ad-set/ad tree + insights and upserts them
 * into the MOS spine (see api/_lib/marketing/metaSync.ts), refreshing spend/
 * lead metrics and self-healing Click-to-WhatsApp lead attribution. The same
 * runMetaSync() also backs the on-demand `meta_sync` action in marketing-os.ts
 * (the "Sync now" button) — one implementation, two triggers.
 *
 * Auth: same as the other crons — `Authorization: Bearer $CRON_SECRET` (sent by
 * Vercel Cron) OR `?secret=<CRON_SECRET>` for manual smoke tests. Refuses to run
 * without a configured CRON_SECRET.
 *
 * Self-disabling: runMetaSync returns { skipped:'not_configured' } when the Meta
 * env is absent and { skipped:'disabled' } when mos_meta_sync_state.is_enabled
 * is false — so this endpoint is a harmless no-op until Meta is wired + enabled.
 * Idempotent (upsert by external id), so overlapping runs are safe.
 */
import { getServiceSupabase } from '../_lib/supabaseServer.js';
import { runMetaSync } from '../_lib/marketing/metaSync.js';

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

  const result = await runMetaSync(getServiceSupabase());
  // Always 200 — a Graph hiccup must not make Vercel mark the cron failed; the
  // structured result carries ok/skipped/error for inspection.
  return json({ ...result, duration_ms: Date.now() - startedAt }, 200);
}
