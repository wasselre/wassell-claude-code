/**
 * runCleanTextJob — cleans ONE market-listing photo (removes all text/writing
 * while preserving the rest of the image) and fills one entry in a chat_templates
 * draft's records.data.cleaning[] array. One generation_jobs row (kind='clean-text')
 * per photo; the /api/templates/clean-listing-images endpoint fans them out across
 * all of a listing's photos so they clean in parallel.
 *
 * Pipeline (mirrors runImageJob, single-image variant):
 *   1. Resolve the input URL: params.fetch_url (this photo's scan-time mirror in
 *      the listing-photos bucket) when present, else the slow path — download
 *      from Aqar and re-host to marketing-assets.
 *   2. Cancel pre-check.
 *   3. fal text-removal (imageGenTextRemoval → pollImageGen). No per-request cap;
 *      the 15-min generation_jobs_watchdog is the backstop.
 *   4. Cancel post-check.
 *   5. Re-host the cleaned output to marketing-assets/listing-clean/... .
 *   6. Insert one media_assets row (first-class library asset) + fill the entry
 *      (status='completed', output_url, asset_id).
 *
 * Since 2026-07-29 step 1 normally touches NOTHING outside our own storage:
 * listing photos are mirrored into the listing-photos bucket at scan time (see
 * runListingMirrorJob.ts), because Aqar's Cloudflare 403s Fly's egress and a
 * user-facing clean must not depend on that. The Aqar download survives only as
 * a fallback for photos with no mirror yet, and it self-heals by enqueueing one.
 *
 * On any fal/network/storage error we write status='failed' + a humanized error
 * onto the SAME cleaning entry FIRST so its spinner exits (siblings stay live),
 * then rethrow so index.ts marks the job failed.
 *
 * Concurrency (CRITICAL): one draft record has a SHARED data.cleaning[] array and
 * every photo's job writes into it concurrently. Since 2026-07-19 each terminal
 * write goes through the clean_text_entry_patch SQL RPC (single UPDATE that
 * jsonb_set-merges the patch into ONE cleaning[] element under the row lock —
 * migration 2026-07-19_clean_text_entry_patch.sql). No whole-data read-modify-
 * write, no version check, no 40001 retry loop — so a same-second burst of
 * finishing photos (FLUX.2 klein, ~3 s each) can no longer convoy on the draft
 * row and saturate the PostgREST pool (live incident 2026-07-18). The retry
 * wrapper below only rides out TRANSIENT REST/pool brownouts. The browser MUST
 * still NOT write the draft during the cleaning window (echo-dedup rule); it
 * only reads via Realtime and writes once on Approve — that Approve save stays
 * optimistic and still works because records_bump_version fires per patch.
 *
 * Auth: service-role client (bypasses RLS). Ownership was validated by
 * api/templates/clean-listing-images.ts before enqueue; job.userId scopes the
 * output storage path + the media_assets row.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from './env.js';
import { retryRecordSave, type SaveError } from './lib/recordSaveRetry.js';
import { fetchListingImage } from './lib/aqarFetch.js';
import { imageGenTextRemoval, pollImageGen } from './imageGen.js';

/** Shape of a claimed generation_jobs row (kind='clean-text'). */
export interface CleanTextJob {
  /** generation_jobs.id */
  id: string;
  /** records.id — the chat_templates draft this job's cleaned photo belongs to. */
  recordId: string;
  /** records.data.cleaning[*].id this job fills (carried in generation_jobs.message_id). */
  entryId: string;
  /** auth.users.id of the submitter (scopes the output storage path + asset). */
  userId: string;
  /**
   * Frozen request snapshot — { source_url, image_index, listing_id?, fetch_url? }.
   * `source_url` stays the canonical Aqar URL (the photo's identity, used for
   * the cleaning entry and for re-sourcing); `fetch_url` is where the bytes are
   * actually read from when a scan-time mirror exists.
   */
  params: Record<string, unknown>;
  attempts: number;
}

const BUCKET = 'marketing-assets';
const POLL_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 2500;

// Larger retry budget than the default (3 attempts / 5s), for TRANSIENT errors
// only. Since 2026-07-19 the terminal write is a clean_text_entry_patch RPC
// (single row-locked UPDATE of one cleaning[] element) — version races are
// structurally impossible, so retries here only cover REST-gateway/pool
// brownouts. A real incident (2026-07-18) saw the Supabase REST gateway answer
// 'upstream request timeout' for ~2 straight minutes — 6 attempts / 20 s
// exhausted mid-brownout and stranded two entries. 10 attempts / 4 min rides
// out a multi-minute brownout; safe because each job writes the draft exactly
// ONCE (its terminal status) and the 15-min generation_jobs watchdog remains
// the backstop above it.
const CLEAN_RETRY_OPTS = { maxAttempts: 10, budgetMs: 240_000, capMs: 8_000 } as const;

interface RunArgs {
  supabase: SupabaseClient;
  env: WorkerEnv;
  job: CleanTextJob;
}

export async function runCleanTextJob({ supabase, env, job }: RunArgs): Promise<Record<string, unknown>> {
  const sourceUrl = typeof job.params?.source_url === 'string' ? (job.params.source_url as string) : '';
  const imageIndex = Number(job.params?.image_index) || 0;
  if (!sourceUrl) {
    throw new Error(`clean-text job ${job.id} missing params.source_url — cannot run`);
  }

  // ── Patch ONE entry in records.data.cleaning (targeted SQL merge) ──────
  // clean_text_entry_patch does the whole read-modify-write inside one UPDATE
  // (row-locked, index found by entry id) — no version check, no whole-data
  // rebuild, so concurrent per-photo fills can't convoy on the shared draft row
  // (2026-07-18 incident). It RAISEs if the draft/entry is gone; that surfaces
  // here as a terminal error and aborts loudly, same as the old build() throw.
  // recordSaveWithRetry stays in use elsewhere (image_chats etc.) — this RPC is
  // clean-text-only.
  const patchEntry = async (patch: Record<string, unknown>): Promise<void> => {
    const step = async (): Promise<SaveError | null> => {
      const { error } = await supabase.rpc('clean_text_entry_patch', {
        p_record_id: job.recordId,
        p_entry_id: job.entryId,
        p_patch: patch,
      });
      return (error as SaveError | null) ?? null;
    };
    const result = await retryRecordSave(step, CLEAN_RETRY_OPTS);
    if (!result.ok) {
      throw new Error(
        `clean_text_entry_patch failed after ${result.attempts} attempt(s) (record=${job.recordId} entry=${job.entryId}): ${result.error?.message ?? 'unknown'}`,
      );
    }
  };

  const isCancelled = async (): Promise<boolean> => {
    const { data } = await supabase
      .from('generation_jobs')
      .select('status')
      .eq('id', job.id)
      .single();
    return (data?.status as string | undefined) === 'cancelled';
  };

  // No "cleaning" start-stamp: the endpoint already seeded the entry as 'queued'
  // (the UI shows a spinner for queued too), and writing it here just DOUBLES the
  // per-job writes to the SHARED draft row. Under the ~5-way concurrency (one per
  // worker machine) that extra write is what exhausted the record_save retry
  // budget and stranded an entry at 'queued' (live 2026-06-30). Each job now
  // writes the draft exactly ONCE — its terminal status (completed/failed).
  console.log(
    `[run-clean] start job=${job.id} record=${job.recordId} entry=${job.entryId} idx=${imageIndex}`,
  );

  // ── Cancel pre-check ─────────────────────────────────────────────────
  if (await isCancelled()) {
    await patchEntry({ status: 'cancelled' });
    console.log(`[run-clean] cancelled-before-start job=${job.id}`);
    return { cancelled: true };
  }

  // ── Get fal an input URL it can actually fetch ────────────────────────
  // fal pulls the input bytes from the URL server-side, and the Aqar CDN
  // (images.aqar.fm) blocks fal's fetcher (file_download_error / IP rate-limit
  // — see CLAUDE.md memory on Aqar), so the URL we hand fal must be ours.
  //
  // FAST PATH (since 2026-07-29): the photo was already mirrored into the
  // listing-photos bucket at scan time, and the endpoint resolved that mirror
  // into params.fetch_url. It is already a public URL of ours, so we hand it
  // straight to fal — no Aqar download, no re-upload. This is the durable fix
  // for the 403s: the user-facing clean no longer depends on Aqar serving us.
  //
  // SLOW PATH: no mirror yet (a listing imported before the mirror lane, or a
  // photo whose mirror failed). Fall back to downloading it ourselves —
  // direct, then through the me-central1 proxy — and re-host to
  // marketing-assets exactly as before, so behaviour never regresses. We also
  // enqueue a mirror job so the NEXT clean of this listing takes the fast path.
  const mirrorUrl = typeof job.params?.fetch_url === 'string' ? (job.params.fetch_url as string) : '';
  let falInputUrl: string;
  if (mirrorUrl) {
    falInputUrl = mirrorUrl;
    console.log(`[run-clean] using mirrored source job=${job.id}`);
  } else {
    try {
      falInputUrl = await rehostSource(supabase, env, sourceUrl, job.userId, job.recordId);
    } catch (err) {
      const msg = `source re-host failed: ${err instanceof Error ? err.message : String(err)}`;
      await patchEntry({ status: 'failed', error: msg }).catch(() => undefined);
      throw new Error(msg);
    }
    void selfHealMirror(supabase, job.params?.listing_id);
  }

  // ── fal text-removal ─────────────────────────────────────────────────
  let outputUrl: string;
  try {
    const start = await imageGenTextRemoval({ imageUrl: falInputUrl });
    const result = await pollImageGen(start, {
      intervalMs: POLL_INTERVAL_MS,
      timeoutMs: POLL_TIMEOUT_MS,
    });
    if (result.status !== 'completed' || !result.imageUrls || result.imageUrls.length === 0) {
      const detail = result.rawError ? `: ${result.rawError}` : '';
      throw new Error(`text removal ${result.status}${detail}`);
    }
    outputUrl = result.imageUrls[0]!;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    await patchEntry({ status: 'failed', error: humanizeCleanError(raw) }).catch((e) =>
      console.error(`[run-clean] could not mark entry failed: ${(e as Error).message}`),
    );
    throw err;
  }

  // ── Cancel post-check ────────────────────────────────────────────────
  if (await isCancelled()) {
    await patchEntry({ status: 'cancelled' });
    console.log(`[run-clean] cancelled-after-generate job=${job.id}`);
    return { cancelled: true };
  }

  // ── Re-host the cleaned output to marketing-assets (service-role, public) ─
  let bytes: Uint8Array;
  let contentType: string;
  try {
    const srcRes = await fetch(outputUrl);
    if (!srcRes.ok) throw new Error(`fetch ${srcRes.status}`);
    bytes = new Uint8Array(await srcRes.arrayBuffer());
    contentType = srcRes.headers.get('content-type') ?? 'image/png';
  } catch (err) {
    const msg = `cleaned fetch failed: ${err instanceof Error ? err.message : String(err)}`;
    await patchEntry({ status: 'failed', error: msg }).catch(() => undefined);
    throw new Error(msg);
  }
  const ext = contentType.includes('jpeg') ? 'jpg' : contentType.includes('webp') ? 'webp' : 'png';
  const storagePath = `listing-clean/${job.userId}/${job.recordId}/${crypto.randomUUID()}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, bytes, { contentType, upsert: false });
  if (upErr) {
    const msg = `cleaned upload failed: ${upErr.message}`;
    await patchEntry({ status: 'failed', error: msg }).catch(() => undefined);
    throw new Error(msg);
  }
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  const publicUrl = pub?.publicUrl;
  if (!publicUrl) {
    const msg = 'cleaned uploaded but public URL not resolved';
    await patchEntry({ status: 'failed', error: msg }).catch(() => undefined);
    throw new Error(msg);
  }

  // ── media_assets row (first-class library asset) + fill the entry ────
  const { data: inserted, error: assetErr } = await supabase
    .from('media_assets')
    .insert({
      kind: 'image',
      storage_bucket: BUCKET,
      storage_path: storagePath,
      public_url: publicUrl,
      mime_type: contentType,
      prompt: null,
      model_id: 'text-removal',
      settings: { source: 'listing-clean', source_url: sourceUrl, image_index: imageIndex },
      source_session_id: job.recordId,
      source_generation_id: null,
      created_by_user_id: job.userId,
    })
    .select('id')
    .single();
  if (assetErr || !inserted) {
    const msg = `media_assets insert failed: ${assetErr?.message ?? 'unknown'}`;
    await patchEntry({ status: 'failed', error: msg }).catch(() => undefined);
    throw new Error(msg);
  }
  const assetId = inserted.id as string;

  await patchEntry({ status: 'completed', output_url: publicUrl, asset_id: assetId, error: null });
  console.log(`[run-clean] completed job=${job.id} entry=${job.entryId} asset=${assetId}`);
  return { asset_id: assetId, output_url: publicUrl };
}

/**
 * SLOW-PATH fallback: fetch a source photo straight from the Aqar CDN (direct,
 * then through the me-central1 proxy — see lib/aqarFetch.ts) and re-host it to
 * the public marketing-assets bucket so fal can fetch it. Only reached for a
 * photo with no scan-time mirror. Throws loudly on any failure (CLAUDE.md).
 */
async function rehostSource(
  supabase: SupabaseClient,
  env: WorkerEnv,
  sourceUrl: string,
  userId: string,
  recordId: string,
): Promise<string> {
  const { bytes, contentType } = await fetchListingImage(env, sourceUrl);
  const ext = contentType.includes('png')
    ? 'png'
    : contentType.includes('webp')
      ? 'webp'
      : contentType.includes('jpeg') || contentType.includes('jpg')
        ? 'jpg'
        : 'jpg';
  const path = `listing-clean/sources/${userId}/${recordId}/${crypto.randomUUID()}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, bytes, { contentType, upsert: false });
  if (upErr) throw new Error(`source upload failed: ${upErr.message}`);
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
  if (!pub?.publicUrl) throw new Error('source uploaded but public URL not resolved');
  return pub.publicUrl;
}

/**
 * Ask for this listing's photos to be mirrored, so the next clean takes the
 * fast path instead of downloading from Aqar again.
 *
 * Fire-and-forget on purpose: the clean this job is running has ALREADY got its
 * bytes by the time we get here, so a failure to enqueue must not fail the
 * photo. listing_mirror_enqueue is idempotent (it no-ops when a job is already
 * in flight or nothing is missing), so calling it once per un-mirrored photo of
 * the same listing costs one cheap RPC each and enqueues at most one job.
 * Errors are logged, never swallowed silently (CLAUDE.md).
 */
function selfHealMirror(supabase: SupabaseClient, listingId: unknown): void {
  if (typeof listingId !== 'string' || !listingId) return;
  void supabase
    .rpc('listing_mirror_enqueue', { p_listing_id: listingId, p_reason: 'clean-miss' })
    .then(({ error }) => {
      if (error) {
        console.error(`[run-clean] mirror self-heal enqueue failed (non-fatal): ${error.message}`);
      }
    });
}

/** Translate raw fal.ai / network errors into plain text for the per-photo error box. */
function humanizeCleanError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('poll timed out')) {
    return 'Cleaning this image took too long and timed out. Press redo to try again.';
  }
  if (lower.includes('start failed (4') || lower.includes('start failed (5') || lower.includes('poll failed')) {
    return `The image service returned an error. Please redo in a moment.\n\n(${raw})`;
  }
  return `Text removal failed: ${raw}`;
}
