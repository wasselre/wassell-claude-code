/**
 * runCleanTextJob — cleans ONE market-listing photo (removes all text/writing
 * while preserving the rest of the image) and fills one entry in a chat_templates
 * draft's records.data.cleaning[] array. One generation_jobs row (kind='clean-text')
 * per photo; the /api/templates/clean-listing-images endpoint fans them out across
 * all of a listing's photos so they clean in parallel.
 *
 * Pipeline (mirrors runImageJob, single-image variant):
 *   1. Stamp the cleaning entry status='cleaning' (Realtime → per-photo spinner).
 *   2. Cancel pre-check.
 *   3. fal text-removal (imageGenTextRemoval → pollImageGen). No per-request cap;
 *      the 15-min generation_jobs_watchdog is the backstop.
 *   4. Cancel post-check.
 *   5. Re-host the cleaned output to marketing-assets/listing-clean/... .
 *   6. Insert one media_assets row (first-class library asset) + fill the entry
 *      (status='completed', output_url, asset_id).
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
  /** Frozen request snapshot — { source_url, image_index }. */
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

export async function runCleanTextJob({ supabase, job }: RunArgs): Promise<Record<string, unknown>> {
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

  // ── Re-host the source into our public bucket BEFORE calling fal ──────
  // fal pulls the input bytes from the URL server-side, and the Aqar CDN
  // (images.aqar.fm) blocks fal's fetcher (file_download_error / IP rate-limit
  // — see CLAUDE.md memory on Aqar). So we fetch the photo ourselves (with a
  // browser-like UA) and upload it to marketing-assets, which fal CAN fetch
  // (every other fal flow sources images from this bucket), then hand fal that
  // URL. Verified live 2026-06-30: passing the raw Aqar URL 422'd here.
  let falInputUrl: string;
  try {
    falInputUrl = await rehostSource(supabase, sourceUrl, job.userId, job.recordId);
  } catch (err) {
    const msg = `source re-host failed: ${err instanceof Error ? err.message : String(err)}`;
    await patchEntry({ status: 'failed', error: msg }).catch(() => undefined);
    throw new Error(msg);
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
 * Fetch a source photo (e.g. an Aqar CDN URL the listing carries) and re-host it
 * to the public marketing-assets bucket so fal can fetch it. Sends a browser-like
 * User-Agent + Referer because some CDNs (Aqar) hotlink-block datacenter/bot
 * fetchers. Throws loudly on any failure (CLAUDE.md — never silent).
 */
async function rehostSource(
  supabase: SupabaseClient,
  sourceUrl: string,
  userId: string,
  recordId: string,
): Promise<string> {
  const res = await fetch(sourceUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Referer: 'https://sa.aqar.fm/',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`source fetch ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') ?? 'image/jpeg';
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
