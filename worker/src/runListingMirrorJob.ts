/**
 * runListingMirrorJob — mirror ONE market listing's photos into a bucket we own
 * so that nothing downstream ever has to fetch from images.aqar.fm.
 *
 * Aqar's Cloudflare blocklists datacenter egress by ASN and began 403-ing Fly's
 * ranges around 2026-07-24, which broke the photo-cleaning lane at the point
 * where it downloaded each source photo (see worker/src/lib/aqarFetch.ts for the
 * per-region measurements). The 2026-07-29 stopgap routed those refusals through
 * the me-central1 proxy; this is the durable fix — do the download ONCE, at
 * scan/import time, and keep our own copy.
 *
 * Enqueued by:
 *   * the records trigger `records_enqueue_listing_mirror` when a market_listings
 *     row is inserted or its image_urls change (the scan-time hook);
 *   * scripts/backfill-listing-mirrors.mjs for the historical set;
 *   * runCleanTextJob's lazy self-heal when it meets an un-mirrored photo.
 * All three go through the idempotent `listing_mirror_enqueue` RPC.
 *
 * Writes  records.data.image_mirror_map = { "<aqar url>": "<our public url>" }
 * via the row-locked `listing_mirror_map_patch` RPC — never a whole-data
 * record_save. A mirror job only ADDS keys to one sub-object, so it needs no
 * version check and can never convoy against the scanner's merge, the REGA
 * lookup worker, or the video-convert cache write on the same listing row.
 *
 * Idempotent by construction:
 *   * the map is keyed by SOURCE URL, so a re-scan returning the same photos
 *     finds them present and does no work;
 *   * the storage path is a deterministic hash of the source URL with
 *     upsert:true, so a retry after a crashed job overwrites its own partial
 *     object instead of leaking a duplicate.
 *
 * PARTIAL SUCCESS IS A SUCCESS. Photos are mirrored independently and the map is
 * patched with whatever landed; a photo Aqar refuses (both directly and through
 * the proxy) is reported and left un-mirrored, so the clean lane simply falls
 * back for that one. Failing the whole job over one dead photo would strand the
 * other seven. The job only FAILS when every photo failed — that is a real
 * signal (blocked egress / proxy down) and should surface loudly.
 */

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.js';
import { fetchListingImage, imageExtFor } from './lib/aqarFetch.js';

export interface ListingMirrorJob {
  /** generation_jobs.id */
  id: string;
  /** records.id — the market_listings record whose photos we mirror. */
  recordId: string;
  /** Frozen request snapshot — { listing_id, reason, missing_at_enqueue }. */
  params: Record<string, unknown>;
  attempts: number;
}

const BUCKET = 'listing-photos';

/**
 * How many photos we download at once for ONE listing. Every refused fetch is
 * retried through the me-central1 proxy, which shares a small VM with the
 * WhatsApp gateway — so this is deliberately gentle. Listings are already
 * mirrored in parallel across the worker's machines; the throughput lever that
 * matters for a bulk backfill is the script's listing rate, not this.
 */
const PHOTO_CONCURRENCY = 3;

/** Skip absurd payloads rather than filling the bucket with them. */
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;

interface RunArgs {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: ListingMirrorJob;
}

export async function runListingMirrorJob({
  supabase,
  env,
  job,
}: RunArgs): Promise<Record<string, unknown>> {
  const listingId = job.recordId;

  // ── Read the listing (service role; full row, not the slim summary view) ──
  const { data: row, error: readErr } = await supabase
    .from('records')
    .select('data')
    .eq('id', listingId)
    .single();
  if (readErr || !row) {
    throw new Error(`listing ${listingId} not readable: ${readErr?.message ?? 'not found'}`);
  }
  const data = (row.data ?? {}) as Record<string, unknown>;

  // Mirror the TRUE originals. If a prior "apply cleaned photos to listing"
  // replaced image_urls with cleaned versions, original_image_urls holds the
  // Aqar sources — those are what the clean lane re-sources from, so those are
  // what must exist in our bucket.
  const sources = collectSourceUrls(data);
  const existing = (data.image_mirror_map ?? {}) as Record<string, unknown>;
  let missing = sources.filter((u) => typeof existing[u] !== 'string' || !existing[u]);

  // Optional cost lever (listing_mirror_settings.max_photos_per_listing).
  const cap = await readPhotoCap(supabase);
  let capped = 0;
  if (cap != null && cap > 0) {
    const alreadyMirrored = sources.filter((u) => typeof existing[u] === 'string' && existing[u]).length;
    const room = Math.max(0, cap - alreadyMirrored);
    if (missing.length > room) {
      capped = missing.length - room;
      missing = missing.slice(0, room);
    }
  }

  if (missing.length === 0) {
    console.log(`[run-mirror] nothing to do job=${job.id} listing=${listingId} (all ${sources.length} mirrored)`);
    return { listing_id: listingId, mirrored: 0, already: sources.length, failed: 0 };
  }

  console.log(
    `[run-mirror] start job=${job.id} listing=${listingId} photos=${sources.length} missing=${missing.length}${capped ? ` capped=${capped}` : ''}`,
  );

  // ── Mirror each missing photo (bounded concurrency) ───────────────────
  const patch: Record<string, string> = {};
  const failures: string[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(PHOTO_CONCURRENCY, missing.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= missing.length) return;
      const sourceUrl = missing[i]!;
      try {
        patch[sourceUrl] = await mirrorOne(supabase, env, listingId, sourceUrl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${sourceUrl}: ${msg}`);
        console.error(`[run-mirror] photo failed listing=${listingId} url=${sourceUrl} — ${msg}`);
      }
    }
  });
  await Promise.all(workers);

  // ── Persist whatever landed (row-locked merge) ────────────────────────
  if (Object.keys(patch).length > 0) {
    const { error: patchErr } = await supabase.rpc('listing_mirror_map_patch', {
      p_listing_id: listingId,
      p_patch: patch,
    });
    if (patchErr) {
      // The bytes are in the bucket but unreferenced. Deterministic paths mean a
      // re-run overwrites them rather than leaking, so this is safe to retry —
      // but it must be loud, not swallowed.
      throw new Error(
        `listing_mirror_map_patch failed (listing=${listingId}, ${Object.keys(patch).length} photo(s) uploaded but unreferenced): ${patchErr.message}`,
      );
    }
  }

  const mirrored = Object.keys(patch).length;
  console.log(
    `[run-mirror] done job=${job.id} listing=${listingId} mirrored=${mirrored} failed=${failures.length}`,
  );

  // Every photo failed → the egress itself is broken (Aqar blocking us AND the
  // proxy unreachable/unset). Surface it as a job failure so it is visible in
  // generation_jobs.error instead of looking like a quiet no-op.
  if (mirrored === 0 && failures.length > 0) {
    throw new Error(
      `all ${failures.length} photo(s) failed for listing ${listingId} — first: ${failures[0]}`,
    );
  }

  return {
    listing_id: listingId,
    mirrored,
    failed: failures.length,
    capped,
    ...(failures.length > 0 ? { errors: failures.slice(0, 5) } : {}),
  };
}

/**
 * The listing's Aqar photo URLs, de-duplicated and in order.
 *
 * Prefers original_image_urls when present: once "apply cleaned photos" has run,
 * image_urls holds OUR cleaned outputs (already in marketing-assets) and the
 * originals are the Aqar sources the clean lane re-sources from. main_image_url
 * is folded in for the rare listing that carries only a cover photo.
 */
function collectSourceUrls(data: Record<string, unknown>): string[] {
  const originals = Array.isArray(data.original_image_urls) ? data.original_image_urls : null;
  const current = Array.isArray(data.image_urls) ? data.image_urls : [];
  const list = originals && originals.length > 0 ? originals : current;

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (u: unknown): void => {
    if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) return;
    if (seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };
  for (const u of list) push(u);
  if (out.length === 0) {
    push(data.original_main_image_url);
    push(data.main_image_url);
  }
  return out;
}

/** Read the optional per-listing photo cap; null when unset or unreadable. */
async function readPhotoCap(supabase: SupabaseClient): Promise<number | null> {
  const { data, error } = await supabase
    .from('listing_mirror_settings')
    .select('max_photos_per_listing')
    .maybeSingle();
  if (error) {
    // Not fatal: the cap is a cost lever, not a correctness gate. Log it —
    // never swallow silently (CLAUDE.md).
    console.error(`[run-mirror] could not read listing_mirror_settings: ${error.message}`);
    return null;
  }
  const v = data?.max_photos_per_listing;
  return typeof v === 'number' && v > 0 ? v : null;
}

/**
 * Download one photo and put it in our bucket. Returns the public URL.
 *
 * The storage path is a deterministic sha256 of the source URL under the
 * listing's id, so the same photo always lands at the same key: retries and
 * re-runs overwrite (upsert) rather than accumulating orphans, and a listing's
 * whole mirror can be pruned by removing one prefix.
 */
async function mirrorOne(
  supabase: SupabaseClient,
  env: WorkerEnv,
  listingId: string,
  sourceUrl: string,
): Promise<string> {
  const { bytes, contentType } = await fetchListingImage(env, sourceUrl);
  if (bytes.byteLength === 0) throw new Error('empty response body');
  if (bytes.byteLength > MAX_PHOTO_BYTES) {
    throw new Error(`photo too large (${bytes.byteLength} bytes)`);
  }

  const digest = createHash('sha256').update(sourceUrl).digest('hex').slice(0, 32);
  const path = `${listingId}/${digest}.${imageExtFor(contentType)}`;

  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType, upsert: true });
  if (upErr) throw new Error(`upload failed: ${upErr.message}`);

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
  if (!pub?.publicUrl) throw new Error('uploaded but public URL not resolved');
  return pub.publicUrl;
}
