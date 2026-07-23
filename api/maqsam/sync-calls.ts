/**
 * POST /api/maqsam/sync-calls?secret=<MAQSAM_WEBHOOK_SECRET>[&pages=N]
 *
 * Pull-based reconcile: sweeps Maqsam's Calls API v3 (newest pages first) and
 * upserts every call through the same shared ingest the webhook uses. This is
 * the GUARANTEED ingest path — the Calls API is publicly documented, while the
 * webhook payload shape is not — so even if the webhook is misconfigured or
 * Maqsam never fires it, calls land here.
 *
 * Idempotent: both paths derive the same deterministic UUID per Maqsam call,
 * so re-sweeping already-ingested calls is a no-op upsert.
 *
 * Invocation: manual (curl / admin), or scheduled later (Vercel cron or a Fly
 * worker poll loop — decide once call volume justifies it). Sweeps up to
 * `pages` pages of 100 calls (default 3, max 20) per run.
 */

import { listCalls } from '../_lib/maqsam.js';
import { ingestMaqsamCall } from '../_lib/maqsamIngest.js';

export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    return json({ ok: true, hint: 'POST with ?secret= to sweep recent Maqsam calls' });
  }
  if (req.method !== 'POST') {
    return json({ error: `Method ${req.method} not allowed` }, 405);
  }

  const secret = process.env.MAQSAM_WEBHOOK_SECRET;
  if (!secret) {
    return json({ error: 'MAQSAM_WEBHOOK_SECRET not configured' }, 500);
  }
  const url = new URL(req.url);
  if (!constantTimeEqual(url.searchParams.get('secret') ?? '', secret)) {
    return json({ error: 'unauthorized' }, 401);
  }

  const pages = Math.min(Math.max(Number(url.searchParams.get('pages')) || 3, 1), 20);

  let ingested = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (let page = 1; page <= pages; page++) {
    let calls;
    try {
      calls = await listCalls({ page });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[maqsam-sync] listCalls page ${page} failed:`, msg);
      errors.push(`page ${page}: ${msg}`);
      break;
    }
    if (calls.length === 0) break;

    for (const call of calls) {
      try {
        const result = await ingestMaqsamCall(call, { source: 'sync-calls', page });
        if (result.skipped) skipped++;
        else ingested++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[maqsam-sync] ingest failed for call ${String(call.id)}:`, msg);
        errors.push(`call ${String(call.id)}: ${msg}`);
      }
    }
  }

  return json({ ok: errors.length === 0, ingested, skipped, errors });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
