/**
 * backfill-listing-mirrors.mjs — mirror the HISTORICAL market_listings photos
 * into the listing-photos bucket, at a rate you choose.
 * ----------------------------------------------------------------------------
 * WHY THIS IS A SCRIPT AND NOT AUTOMATIC
 *
 * From 2026-07-29 new and changed listings mirror themselves: a trigger on
 * `records` enqueues one listing-mirror job per listing whose image_urls change
 * (migration 2026-07-29_listing_photo_mirror.sql). That covers everything the
 * scanner brings in from now on.
 *
 * The listings imported BEFORE that are a different problem of scale: 51,333
 * listings carrying 408,399 photos. The bytes are cheap (~36 KB each, ~14 GB
 * total), but every one of those downloads currently has to traverse the
 * me-central1 image proxy, because Aqar's Cloudflare 403s Fly's egress in every
 * region we run in (sin, fra, sjc all measured blocked on 2026-07-29). That
 * proxy shares a small GCP VM with the WhatsApp gateway. Enqueueing 51k jobs at
 * once would point the full width of the worker fleet at that VM for hours and
 * put live WhatsApp at risk to prefill a cache for a feature used on 82
 * listings so far.
 *
 * So the backfill is deliberately operator-driven, throttled, and resumable.
 * Run it when you want it, as fast as you're willing to push the proxy, and
 * stop it at any time — nothing is lost, because progress lives in the data
 * (each listing's image_mirror_map), not in a cursor file.
 *
 * ----------------------------------------------------------------------------
 * USAGE
 *
 *   node scripts/backfill-listing-mirrors.mjs --dry-run
 *       Report the backlog (listings + photos + estimated GB) and exit. Always
 *       start here.
 *
 *   node scripts/backfill-listing-mirrors.mjs --limit 500
 *       Mirror at most 500 listings, then stop. Good first real run.
 *
 *   node scripts/backfill-listing-mirrors.mjs --limit 50000 --rate 20
 *       Full backfill at 20 listings/minute (~150 photos/min through the proxy).
 *
 * OPTIONS
 *   --dry-run          Report only; enqueue nothing.
 *   --limit N          Max listings to enqueue this run (default 500).
 *   --rate N           Listings enqueued per minute (default 20). The real
 *                      ceiling is the worker fleet, but this keeps the queue
 *                      shallow so a user-facing clean-text or video-convert job
 *                      is never stuck behind thousands of mirror jobs. It also
 *                      keeps Realtime quiet: every mirrored listing is one
 *                      UPDATE on `records`, which fans out to every open SPA
 *                      tab (slimmed by slimSummaryData — image_mirror_map is
 *                      not a summary key — but still a message per listing).
 *                      20/min is invisible; do not crank this to thousands.
 *   --include-sold     Also mirror inactive/sold listings (default: skip them —
 *                      a sold listing is never sent to a client, so it is not
 *                      worth the storage).
 *   --batch N          Listings fetched per backlog query (default 200).
 *
 * SAFE TO RE-RUN. listing_mirror_enqueue is idempotent: it skips listings that
 * are fully mirrored and listings that already have a job in flight, so a second
 * run simply picks up where the first stopped. Ctrl-C is safe.
 *
 * IT WILL STOP EARLY ON PURPOSE. listing_mirror_enqueue also refuses to queue
 * past `listing_mirror_settings.max_queue_depth` (default 200), so on a big
 * --limit this script fills the queue, sees a whole page turned away, reports
 * "the queue is ahead of the workers" and exits. That is the backpressure
 * working, not a failure — re-run it (or loop it from a shell) to keep going.
 * Nothing is lost: the backlog is derived from the data, not from the queue.
 *
 * REQUIRED ENV (read from process.env, or auto-loaded from .env.local / .env):
 *   SUPABASE_URL (or VITE_SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY   — required; the queue RPCs are service-role only
 */

import { makeIdentifiedClient } from './_lib/serviceClient.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Reads .env.local then .env; a real shell env always wins. CRLF-safe. */
function loadEnvFile(p) {
  if (!existsSync(p)) return;
  let txt;
  try {
    txt = readFileSync(p, 'utf8');
  } catch {
    return; // unreadable — the env-presence check below reports the miss
  }
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnvFile(resolve(ROOT, '.env.local'));
loadEnvFile(resolve(ROOT, '.env'));

/* ── args ─────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1 || i === argv.length - 1) return dflt;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

const DRY_RUN = flag('dry-run');
const LIMIT = opt('limit', 500);
const RATE_PER_MIN = opt('rate', 20);
const BATCH = Math.min(opt('batch', 200), 500);
const ACTIVE_ONLY = !flag('include-sold');
/** Measured 2026-07-29 over an 80-photo sample: Aqar serves 750px webp. */
const AVG_PHOTO_BYTES = 36 * 1024;

const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error(
    'FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (the mirror queue RPCs are service-role only).',
  );
  process.exit(1);
}
const supabase = makeIdentifiedClient('script:backfill-listing-mirrors', url, key);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── run ──────────────────────────────────────────────────────────────── */
console.log(
  `[backfill] ${DRY_RUN ? 'DRY RUN — ' : ''}active_only=${ACTIVE_ONLY} limit=${LIMIT} rate=${RATE_PER_MIN}/min batch=${BATCH}`,
);

let enqueued = 0;
let skipped = 0;
let scanned = 0;
let photosQueued = 0;
// Set instead of calling process.exit() mid-run: an abrupt exit while a fetch
// keep-alive socket is open makes Node abort with a libuv assertion on Windows,
// which looks far scarier than the actual error being reported.
let fatal = false;
const startedAt = Date.now();
const gapMs = Math.max(0, Math.round(60_000 / RATE_PER_MIN));

// The backlog query is a fresh "what still needs work" read each round, not a
// paged cursor. That is what makes the script resumable and re-runnable: a
// listing drops out of the backlog as soon as the worker mirrors it, so we
// never re-hand the same listing to the queue, and an interrupted run leaves no
// state to reconcile.
for (;;) {
  if (enqueued >= LIMIT) break;

  const { data, error } = await supabase.rpc('listing_mirror_backlog', {
    p_limit: BATCH,
    p_active_only: ACTIVE_ONLY,
  });
  if (error) {
    console.error(`FATAL: listing_mirror_backlog failed: ${error.message}`);
    process.exitCode = 1;
    fatal = true;
    break;
  }
  const rows = data ?? [];
  if (rows.length === 0) {
    console.log('[backfill] backlog empty — nothing left to mirror.');
    break;
  }
  const enqueuedBefore = enqueued;

  if (DRY_RUN) {
    // One representative page is enough to describe the shape; the totals below
    // come from a separate count so the estimate covers the WHOLE backlog.
    const sample = rows.slice(0, 5);
    console.log(`[backfill] sample of the backlog (${rows.length} in this page):`);
    for (const r of sample) {
      console.log(`   listing=${r.listing_id} @${r.external_id ?? '?'} missing=${r.missing}/${r.total}`);
    }
    break;
  }

  for (const row of rows) {
    if (enqueued >= LIMIT) break;
    scanned += 1;
    const { data: jobId, error: enqErr } = await supabase.rpc('listing_mirror_enqueue', {
      p_listing_id: row.listing_id,
      p_reason: 'backfill',
    });
    if (enqErr) {
      // Loud, but keep going — one bad listing must not end a multi-hour run.
      console.error(`[backfill] enqueue failed listing=${row.listing_id}: ${enqErr.message}`);
      continue;
    }
    if (!jobId) {
      // Already in flight or already mirrored (a concurrent run, or the trigger
      // beat us to it). Expected — not an error.
      skipped += 1;
      continue;
    }
    enqueued += 1;
    photosQueued += Number(row.missing) || 0;
    if (enqueued % 25 === 0) {
      const mins = (Date.now() - startedAt) / 60_000;
      console.log(
        `[backfill] enqueued=${enqueued} skipped=${skipped} photos≈${photosQueued} (${(enqueued / Math.max(mins, 0.01)).toFixed(1)}/min)`,
      );
    }
    if (gapMs) await sleep(gapMs);
  }

  // The backlog query returns listings that still need photos, INCLUDING ones
  // whose mirror job is already queued/running — so if the whole page was
  // skipped we would fetch the identical page forever. That happens naturally
  // when the queue is deeper than the worker fleet can drain (or a second copy
  // of this script is running). Stop and let the workers catch up; re-running
  // later resumes exactly where this left off.
  if (enqueued === enqueuedBefore) {
    console.log(
      `[backfill] every listing in this page already has a mirror job in flight (${skipped} skipped) — the queue is ahead of the workers. Stopping; re-run later to continue.`,
    );
    break;
  }
}

/* ── totals ───────────────────────────────────────────────────────────── */
// One aggregate over the whole model, so --dry-run stays instant on 51k rows.
const { data: totals, error: totErr } = fatal
  ? { data: null, error: null }
  : await supabase.rpc('listing_mirror_stats', { p_active_only: ACTIVE_ONLY });
if (fatal) {
  console.error('[backfill] aborted — see the error above. Nothing was left in a bad state.');
} else if (totErr) {
  console.warn(`[backfill] could not compute backlog totals: ${totErr.message}`);
} else {
  const t = Array.isArray(totals) ? totals[0] : totals;
  const pending = Number(t?.photos_pending) || 0;
  const done = Number(t?.photos_mirrored) || 0;
  const all = Number(t?.photos_total) || 0;
  const pct = all > 0 ? ((done / all) * 100).toFixed(1) : '0.0';
  console.log(
    `[backfill] mirror coverage${ACTIVE_ONLY ? ' (active listings)' : ''}: ` +
      `${done}/${all} photos (${pct}%) across ${t?.listings_total ?? '?'} listings.`,
  );
  console.log(
    `[backfill] REMAINING: ${t?.listings_pending ?? '?'} listings / ${pending} photos ` +
      `(~${((pending * AVG_PHOTO_BYTES) / 1024 ** 3).toFixed(1)} GB to store, ~${pending} downloads through the me-central1 proxy).`,
  );
}

if (!fatal) {
  console.log(
    DRY_RUN
      ? '[backfill] dry run complete — nothing enqueued.'
      : `[backfill] done: enqueued=${enqueued} skipped=${skipped} scanned=${scanned} photos≈${photosQueued}. Watch progress with: fly logs --app wassel-deck-worker | grep run-mirror`,
  );
}
