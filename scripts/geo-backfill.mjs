#!/usr/bin/env node
/**
 * Operator driver for the Geography Understanding review-first BACKFILL.
 *
 * This is a thin, resumable HTTP driver over /api/geo-preference/backfill — the
 * ACTUAL work (claim → gather history → extract → runReviewFirst → proposal)
 * happens server-side inside that admin-only endpoint, which reuses the ability
 * TypeScript directly (see api/_lib/geoPreference/backfillPorts.ts). Running the
 * processing here in a plain .mjs would mean copying the whole ability tree
 * (extractor + orchestrator + resolver + matchAgent, ~3k lines) — so the endpoint
 * hosts the compute and this script just enqueues a run and drains it.
 *
 * It NEVER contacts a customer: the whole path only reads history and writes
 * `pending` rows to geo_pref_proposals. auto_write stays off.
 *
 * Idempotent + resumable: one job per (run_id, client_id). Re-running with the
 * same --run resumes only pending/failed jobs; done jobs are skipped.
 *
 * Usage:
 *   WASSEL_ADMIN_JWT=<admin supabase access_token> \
 *   node scripts/geo-backfill.mjs [--url https://app.wassel.re] [--run <uuid>] \
 *        [--clients id1,id2,...]   # omit --clients ⇒ the DEV gold split
 *
 * Flags:
 *   --url      App base URL (default $APP_URL or https://app.wassel.re)
 *   --run      Resume an existing run_id (default: a fresh run)
 *   --clients  Comma-separated client uuids (default: geo_pref_gold_split dev)
 *   --max      Jobs per process call (default 25)
 *   --dry-run  Enqueue + print progress only; do NOT process.
 */

const args = process.argv.slice(2);
function flag(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < args.length && !args[i + 1].startsWith('--')) return args[i + 1];
  return fallback;
}
const has = (name) => args.includes(`--${name}`);

const APP_URL = (flag('url') ?? process.env.APP_URL ?? 'https://app.wassel.re').replace(/\/+$/, '');
const TOKEN = process.env.WASSEL_ADMIN_JWT ?? flag('token');
const RUN = flag('run');
const CLIENTS = flag('clients');
const MAX = Number(flag('max') ?? '25');
const DRY = has('dry-run');

if (!TOKEN) {
  console.error('FATAL: set WASSEL_ADMIN_JWT to an admin Supabase access_token (or pass --token).');
  process.exit(1);
}

const base = `${APP_URL}/api/geo-preference/backfill`;
const authHeaders = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

async function post(bodyObj) {
  const res = await fetch(base, { method: 'POST', headers: authHeaders, body: JSON.stringify(bodyObj) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${bodyObj.action} ${res.status}: ${json.error ?? res.statusText}`);
  return json;
}
async function getProgress(runId) {
  const res = await fetch(`${base}?runId=${encodeURIComponent(runId)}`, { headers: authHeaders });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`progress ${res.status}: ${json.error ?? res.statusText}`);
  return json.progress;
}

(async () => {
  // 1. Enqueue (idempotent — resumes an existing run when --run is given).
  const enqueueBody = { action: 'enqueue' };
  if (RUN) enqueueBody.runId = RUN;
  if (CLIENTS) enqueueBody.clientIds = CLIENTS.split(',').map((s) => s.trim()).filter(Boolean);
  const enq = await post(enqueueBody);
  const runId = enq.run_id;
  console.log(`run_id=${runId}  inserted=${enq.inserted} skipped=${enq.skipped} total=${enq.total}`);

  if (DRY) {
    console.log('progress', await getProgress(runId));
    console.log('(--dry-run) not processing. Re-run without --dry-run, or with --run', runId);
    return;
  }

  // 2. Drain: process bounded batches until the queue is drained.
  let round = 0;
  for (;;) {
    round += 1;
    const r = await post({ action: 'process', runId, max: MAX });
    console.log(
      `round ${round}: processed=${r.processed} done=${r.done} failed=${r.failed} ` +
        `proposals=${r.proposals} drained=${r.drained} progress=${JSON.stringify(r.progress)}`,
    );
    if (r.drained) break;
    if (r.processed === 0) {
      // Nothing claimable but not drained ⇒ only failed-at-cap remain. Stop.
      console.log('no more claimable jobs (remaining are failed at the attempts cap).');
      break;
    }
  }
  console.log('final progress', await getProgress(runId));
})().catch((err) => {
  console.error('geo-backfill FAILED:', err.message);
  process.exit(1);
});
