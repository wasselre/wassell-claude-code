/**
 * Wassell deck worker — entry point.
 *
 * Long-running Node process that:
 *   1. Polls `public.deck_jobs` via the `deck_job_claim_next` RPC every
 *      ~3 seconds. Postgres FOR UPDATE SKIP LOCKED guarantees no two
 *      worker instances ever claim the same job.
 *   2. Runs the Claude Skills + code_execution pipeline (runDeckJob.ts)
 *      with the service-role Supabase client. Writes phase updates to
 *      the deck record as it goes — the SPA gets them via Realtime.
 *   3. Marks the job as `done` or `failed` when it finishes.
 *   4. Every ~5 minutes, calls `deck_jobs_watchdog()` to sweep any
 *      `running` jobs older than 20 minutes (covers crashes, OOMs,
 *      `fly machine stop` during a job, etc.). The same SQL function
 *      also writes `status='failed'` to the affected deck records so
 *      the UI swaps spinner → "Try again" automatically.
 *
 * HTTP surface:
 *   GET  /healthz — for Fly.io health checks
 *   POST /wake    — optional fire-and-forget ping from the API endpoint
 *                   when a new job is enqueued (skips the 3s polling
 *                   latency). The worker doesn't trust the body — it
 *                   just polls immediately on receipt.
 */

import http from 'node:http';
import { type SupabaseClient } from '@supabase/supabase-js';
import { loadEnv } from './env.js';
import { makeServiceClient } from './lib/serviceClient.js';
import { runCleanTextJob, type CleanTextJob } from './runCleanTextJob.js';
import { runVideoConvertJob, type VideoConvertJob } from './runVideoConvertJob.js';
import { runCompressJob, type CompressJob } from './runCompressJob.js';
import { runDeckJob, type DeckJob } from './runDeckJob.js';
import { runDocumentJob, type DocumentJob } from './runDocumentJob.js';
import { runImageJob, type ImageJob } from './runImageJob.js';
import { runMigrationJob, type MigrationJob } from './runMigrationJob.js';
import { runPreviewJob, type PreviewJob } from './runPreviewJob.js';
import { runRegaLookupJob, type RegaLookupJob } from './runRegaLookupJob.js';
import { runScheduledWhatsappJob, type ScheduledWhatsappJob } from './runScheduledWhatsappJob.js';
import { runCollectionJob, type CollectionJob } from './marketing/runCollectionJob.js';
import { runCreativeCleanup } from './marketing/creativeCleanup.js';
import { sweepContentBacklog } from './marketing/content/sweepBacklog.js';
import { getSessionStatus, restartSession, type WahaSendConfig } from './waha.js';

const env = loadEnv();

// T2: identity-tagged service-role client (x-wassel-service='worker',
// x-wassel-instance=FLY_MACHINE_ID) so a worker storm/loop is attributable
// in Postgres logs. Shared by all poll loops in this process.
const supabase: SupabaseClient = makeServiceClient(env, 'worker');

// WAHA send config (scheduled_whatsapp_jobs) — null until both WAHA secrets are
// set, which gates the scheduled-WhatsApp + WAHA-session-watchdog loops below.
const wahaSend: WahaSendConfig | null =
  env.WAHA_URL && env.WAHA_API_KEY ? { url: env.WAHA_URL, apiKey: env.WAHA_API_KEY, supabase } : null;

let shuttingDown = false;
let busy = false;
let wakeRequested = false;
// Image Chats v2 runs on an INDEPENDENT loop with its own busy/wake flags so
// 30s-5min image turns never head-of-line-block behind 3-12min deck jobs (and
// vice-versa). Both loops share this one process + Supabase client.
let imageBusy = false;
let imageWakeRequested = false;
// Listing-photo text removal (generation_jobs kind='clean-text') gets its OWN
// independent loop too: a listing fans out N per-photo clean jobs in parallel and
// they should drain at full speed without head-of-line-blocking behind image-chat
// turns (and vice-versa). Shares the generation_jobs queue + RPCs; the image
// loop's generation_jobs_watchdog() already sweeps stale jobs of ALL kinds.
let cleanBusy = false;
let cleanWakeRequested = false;
// Listing-video conversion (generation_jobs kind='video-convert') gets its own
// loop: an ffmpeg remux takes seconds-to-minutes and must not head-of-line-
// block photo cleaning (or vice-versa). Shares the generation_jobs RPCs; the
// image loop's watchdog sweeps stale jobs of ALL kinds.
let videoBusy = false;
let videoWakeRequested = false;
// Office-preview conversions (file_preview_jobs) get a THIRD independent loop
// for the same reason — a 2-10s soffice run should never wait behind a deck.
let previewBusy = false;
let previewWakeRequested = false;
// PDF compression (pdf_compress_jobs) gets a FOURTH independent loop — bulk
// compress fan-outs should drain at full speed regardless of deck/image load.
let compressBusy = false;
let compressWakeRequested = false;
// Scheduled Reports (2026-06-17) get a FIFTH independent, time-gated loop:
// claim due reports (next_run_at passed) and trigger the owner-scoped runner on
// the app. Self-disables when REPORTS_RUNNER_SECRET is unset.
let reportsBusy = false;
let reportsWakeRequested = false;
// Document generation (document_jobs, 2026-06-21) gets a SIXTH independent loop:
// render an authored template + a record's data into a branded A4 PDF via the
// same LibreOffice path the office-preview queue uses.
let documentBusy = false;
let documentWakeRequested = false;
// Data Migration extraction (data_migration_jobs, 2026-06-23) gets a SEVENTH
// independent loop: run the file-heavy AI vision actions (extract / plan /
// discuss) that used to be held-open HTTP requests on /api/migrate.
let migrationBusy = false;
let migrationWakeRequested = false;
// Server-authoritative workflow runner (workflow_jobs, EIGHTH loop). Claims a
// captured record-write event and POSTs the protected runner endpoint; the
// worker owns the queue lifecycle (complete/fail), driven by the RESPONSE BODY
// classification — never HTTP 200 alone. Self-disables until
// WORKFLOW_RUNNER_SECRET is set; 3 consecutive 401/503 auth-disable the loop
// (a config fault won't be fixed by retrying jobs) while the watchdog keeps
// running. `workflowAuthFailures` resets on any successful runner call.
let workflowBusy = false;
let workflowWakeRequested = false;
let workflowAuthDisabled = false;
let workflowAuthFailures = 0;
// REGA advertiser-phone lookup (rega_lookup_jobs, NINTH loop). Drives a
// Browserbase session to read the public REGA registry for a market listing.
// Registered only when BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID are set.
let regaBusy = false;
let regaWakeRequested = false;
// Scheduled WhatsApp sends (scheduled_whatsapp_jobs, TENTH loop). Time-gated:
// claim rows whose deliver_at has passed and send them via WAHA (WAHA has no
// native deliverAt). Plus a WAHA session watchdog that restarts a session that
// is dead-but-"WORKING" (eval §4b). Both gated on the WAHA secrets.
let scheduledWaBusy = false;
let scheduledWaWakeRequested = false;
// Marketing Intelligence collection (mkt_collection_jobs). Gated on
// MARKETING_COLLECTION_ENABLED=1 AND the DB global pause / per-account enable, so
// deploying this code is a no-op until a pilot account is explicitly turned on.
let marketingBusy = false;
let marketingWakeRequested = false;
// Marketing Intelligence ops monitoring (heartbeat + self-diagnostics + freshness
// + alert generation). ALWAYS-ON (independent of MARKETING_COLLECTION_ENABLED) so
// we observe the platform's health even when collection is paused/disabled.
let marketingOpsBusy = false;
let wahaWatchdogBusy = false;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Claim ONE pending job (if any) and run it to completion. Returns true
 * if a job was claimed (so the caller can immediately try again to
 * drain a backlog), false if the queue was empty.
 */
async function claimAndRunOne(): Promise<boolean> {
  const { data, error } = await supabase.rpc('deck_job_claim_next', {
    p_worker_id: env.WORKER_ID,
  });
  if (error) {
    console.error(`[worker] claim failed: ${error.message}`);
    return false;
  }
  const rows = (data ?? []) as Array<{
    job_id: string;
    deck_record_id: string;
    user_id: string;
    payload: Record<string, unknown>;
    attempts: number;
  }>;
  if (rows.length === 0) return false;
  const row = rows[0]!;
  const job: DeckJob = {
    id: row.job_id,
    deckRecordId: row.deck_record_id,
    userId: row.user_id,
    payload: row.payload,
    attempts: row.attempts,
  };
  console.log(
    `[worker] claimed job=${job.id} record=${job.deckRecordId} attempts=${job.attempts}`,
  );

  try {
    await runDeckJob({ supabase, env, job });
    const { error: doneErr } = await supabase.rpc('deck_job_complete', {
      p_job_id: job.id,
    });
    if (doneErr) {
      console.error(`[worker] deck_job_complete RPC failed: ${doneErr.message}`);
    } else {
      console.log(`[worker] completed job=${job.id}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[worker] job=${job.id} FAILED:`, msg);
    if (err instanceof Error && err.stack) console.error(err.stack);
    try {
      const { error: failErr } = await supabase.rpc('deck_job_fail', {
        p_job_id: job.id,
        p_error: msg,
      });
      if (failErr) {
        console.error(`[worker] deck_job_fail RPC failed: ${failErr.message}`);
      }
    } catch (innerErr) {
      console.error(
        `[worker] could not mark job failed: ${(innerErr as Error).message}`,
      );
    }
  }
  return true;
}

async function runWatchdog(): Promise<void> {
  try {
    const { data, error } = await supabase.rpc('deck_jobs_watchdog');
    if (error) {
      console.error(`[worker] watchdog RPC error: ${error.message}`);
      return;
    }
    const swept = typeof data === 'number' ? data : 0;
    if (swept > 0) {
      console.warn(`[worker] watchdog swept ${swept} stale job(s)`);
    }
  } catch (err) {
    console.error(`[worker] watchdog threw:`, err);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Image Chats v2 — generation_jobs (kind='image') queue.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Claim ONE queued image job (if any) and run it to completion. Mirrors
 * claimAndRunOne for decks but against the generation_jobs queue and the
 * per-message runImageJob pipeline. Returns true if a job was claimed.
 */
async function claimAndRunOneImage(): Promise<boolean> {
  const { data, error } = await supabase.rpc('generation_job_claim_next', {
    p_worker_id: env.WORKER_ID,
    p_kind: 'image',
  });
  if (error) {
    console.error(`[worker] image claim failed: ${error.message}`);
    return false;
  }
  const rows = (data ?? []) as Array<{
    job_id: string;
    record_id: string;
    message_id: string | null;
    generation_id: string | null;
    user_id: string;
    kind: string;
    prompt: string | null;
    params: Record<string, unknown>;
    attempts: number;
  }>;
  if (rows.length === 0) return false;
  const row = rows[0]!;
  const job: ImageJob = {
    id: row.job_id,
    recordId: row.record_id,
    messageId: row.message_id ?? null,
    generationId: row.generation_id ?? null,
    userId: row.user_id,
    kind: row.kind,
    prompt: row.prompt,
    params: row.params,
    attempts: row.attempts,
  };
  console.log(
    `[worker] claimed image job=${job.id} record=${job.recordId} gen=${job.generationId ?? '-'} msg=${job.messageId ?? '-'} attempts=${job.attempts}`,
  );

  try {
    const result = await runImageJob({ supabase, env, job });
    // generation_job_complete only touches status='running' rows — if the user
    // cancelled or the watchdog already failed it, this is a harmless no-op.
    const { error: doneErr } = await supabase.rpc('generation_job_complete', {
      p_job_id: job.id,
      p_result: result ?? {},
    });
    if (doneErr) {
      console.error(`[worker] generation_job_complete RPC failed: ${doneErr.message}`);
    } else {
      console.log(`[worker] completed image job=${job.id}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[worker] image job=${job.id} FAILED:`, msg);
    if (err instanceof Error && err.stack) console.error(err.stack);
    try {
      const { error: failErr } = await supabase.rpc('generation_job_fail', {
        p_job_id: job.id,
        p_error: msg,
      });
      if (failErr) {
        console.error(`[worker] generation_job_fail RPC failed: ${failErr.message}`);
      }
    } catch (innerErr) {
      console.error(
        `[worker] could not mark image job failed: ${(innerErr as Error).message}`,
      );
    }
  }
  return true;
}

async function runImageWatchdog(): Promise<void> {
  try {
    const { data, error } = await supabase.rpc('generation_jobs_watchdog');
    if (error) {
      console.error(`[worker] image watchdog RPC error: ${error.message}`);
      return;
    }
    const swept = typeof data === 'number' ? data : 0;
    if (swept > 0) {
      console.warn(`[worker] image watchdog swept ${swept} stale job(s)`);
    }
  } catch (err) {
    console.error(`[worker] image watchdog threw:`, err);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Listing-photo text removal — generation_jobs (kind='clean-text') queue.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Claim ONE queued clean-text job (if any) and run it to completion. Mirrors
 * claimAndRunOneImage but against kind='clean-text' and the per-photo
 * runCleanTextJob pipeline. The claimed row's message_id carries the cleaning
 * entry id this job fills. Returns true if a job was claimed.
 */
async function claimAndRunOneCleanText(): Promise<boolean> {
  const { data, error } = await supabase.rpc('generation_job_claim_next', {
    p_worker_id: env.WORKER_ID,
    p_kind: 'clean-text',
  });
  if (error) {
    console.error(`[worker] clean-text claim failed: ${error.message}`);
    return false;
  }
  const rows = (data ?? []) as Array<{
    job_id: string;
    record_id: string;
    message_id: string | null;
    user_id: string;
    kind: string;
    prompt: string | null;
    params: Record<string, unknown>;
    attempts: number;
  }>;
  if (rows.length === 0) return false;
  const row = rows[0]!;
  if (!row.message_id) {
    console.error(`[worker] clean-text job=${row.job_id} has no message_id (cleaning entry id) — failing`);
    await supabase.rpc('generation_job_fail', { p_job_id: row.job_id, p_error: 'missing cleaning entry id' });
    return true;
  }
  const job: CleanTextJob = {
    id: row.job_id,
    recordId: row.record_id,
    entryId: row.message_id,
    userId: row.user_id,
    params: row.params ?? {},
    attempts: row.attempts,
  };
  console.log(
    `[worker] claimed clean-text job=${job.id} record=${job.recordId} entry=${job.entryId} attempts=${job.attempts}`,
  );

  try {
    const result = await runCleanTextJob({ supabase, env, job });
    // generation_job_complete only touches status='running' rows — a cancel or
    // watchdog-fail makes this a harmless no-op.
    const { error: doneErr } = await supabase.rpc('generation_job_complete', {
      p_job_id: job.id,
      p_result: result ?? {},
    });
    if (doneErr) {
      console.error(`[worker] generation_job_complete (clean-text) RPC failed: ${doneErr.message}`);
    } else {
      console.log(`[worker] completed clean-text job=${job.id}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[worker] clean-text job=${job.id} FAILED:`, msg);
    if (err instanceof Error && err.stack) console.error(err.stack);
    try {
      const { error: failErr } = await supabase.rpc('generation_job_fail', {
        p_job_id: job.id,
        p_error: msg,
      });
      if (failErr) {
        console.error(`[worker] generation_job_fail (clean-text) RPC failed: ${failErr.message}`);
      }
    } catch (innerErr) {
      console.error(
        `[worker] could not mark clean-text job failed: ${(innerErr as Error).message}`,
      );
    }
  }
  return true;
}

/**
 * Clean-text twin of imagePollLoop. Runs concurrently with its own busy/wake
 * flags. Does NOT tick a watchdog — generation_jobs_watchdog() (run by the image
 * loop) already sweeps stale jobs of ALL kinds, including clean-text.
 */
async function cleanTextPollLoop(): Promise<void> {
  while (!shuttingDown) {
    cleanBusy = true;
    let didClaim = false;
    try {
      didClaim = await claimAndRunOneCleanText();
    } catch (err) {
      console.error('[worker] clean-text poll iteration error:', err);
    }
    cleanBusy = false;

    if (didClaim || cleanWakeRequested) {
      cleanWakeRequested = false;
      continue;
    }
    const wokeAt = Date.now();
    while (Date.now() - wokeAt < env.POLL_INTERVAL_MS && !cleanWakeRequested && !shuttingDown) {
      await sleep(200);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Listing-video conversion — generation_jobs (kind='video-convert') queue.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Claim ONE queued video-convert job (if any) and run it to completion.
 * Mirrors claimAndRunOneCleanText against kind='video-convert' and the
 * ffmpeg HLS→mp4 pipeline (runVideoConvertJob). Returns true if a job was
 * claimed.
 */
async function claimAndRunOneVideoConvert(): Promise<boolean> {
  const { data, error } = await supabase.rpc('generation_job_claim_next', {
    p_worker_id: env.WORKER_ID,
    p_kind: 'video-convert',
  });
  if (error) {
    console.error(`[worker] video-convert claim failed: ${error.message}`);
    return false;
  }
  const rows = (data ?? []) as Array<{
    job_id: string;
    record_id: string;
    message_id: string | null;
    user_id: string;
    kind: string;
    prompt: string | null;
    params: Record<string, unknown>;
    attempts: number;
  }>;
  if (rows.length === 0) return false;
  const row = rows[0]!;
  const job: VideoConvertJob = {
    id: row.job_id,
    recordId: row.record_id,
    userId: row.user_id,
    params: row.params ?? {},
    attempts: row.attempts,
  };
  console.log(
    `[worker] claimed video-convert job=${job.id} listing=${job.recordId} attempts=${job.attempts}`,
  );
  try {
    const result = await runVideoConvertJob({ supabase, env, job });
    const { error: doneErr } = await supabase.rpc('generation_job_complete', {
      p_job_id: job.id,
      p_result: result ?? {},
    });
    if (doneErr) {
      console.error(`[worker] generation_job_complete (video-convert) RPC failed: ${doneErr.message}`);
    } else {
      console.log(`[worker] completed video-convert job=${job.id}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[worker] video-convert job=${job.id} FAILED:`, msg);
    try {
      const { error: failErr } = await supabase.rpc('generation_job_fail', {
        p_job_id: job.id,
        p_error: msg,
      });
      if (failErr) {
        console.error(`[worker] generation_job_fail (video-convert) RPC failed: ${failErr.message}`);
      }
    } catch (innerErr) {
      console.error(`[worker] could not mark video-convert job failed: ${(innerErr as Error).message}`);
    }
  }
  return true;
}

/** Video-convert twin of cleanTextPollLoop (own busy/wake flags, no watchdog). */
async function videoConvertPollLoop(): Promise<void> {
  while (!shuttingDown) {
    videoBusy = true;
    let didClaim = false;
    try {
      didClaim = await claimAndRunOneVideoConvert();
    } catch (err) {
      console.error('[worker] video-convert poll iteration error:', err);
    }
    videoBusy = false;

    if (didClaim || videoWakeRequested) {
      videoWakeRequested = false;
      continue;
    }
    const wokeAt = Date.now();
    while (Date.now() - wokeAt < env.POLL_INTERVAL_MS && !videoWakeRequested && !shuttingDown) {
      await sleep(200);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Office preview — file_preview_jobs queue (LibreOffice → PDF).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Claim ONE queued preview job (if any) and run it to completion. Mirrors the
 * deck/image claim-run-complete shape against file_preview_jobs. Returns true
 * if a job was claimed.
 */
async function claimAndRunOnePreview(): Promise<boolean> {
  const { data, error } = await supabase.rpc('file_preview_claim_next', {
    p_worker_id: env.WORKER_ID,
  });
  if (error) {
    console.error(`[worker] preview claim failed: ${error.message}`);
    return false;
  }
  const rows = (data ?? []) as Array<{
    job_id: string;
    file_id: string;
    attempts: number;
    storage_bucket: string;
    storage_path: string;
    mime_type: string;
    size_bytes: number;
    original_name: string;
  }>;
  if (rows.length === 0) return false;
  const row = rows[0]!;
  const job: PreviewJob = {
    id: row.job_id,
    fileId: row.file_id,
    attempts: row.attempts,
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    originalName: row.original_name,
  };
  console.log(
    `[worker] claimed preview job=${job.id} file=${job.fileId} mime=${job.mimeType} attempts=${job.attempts}`,
  );

  try {
    const previewPath = await runPreviewJob({ supabase, env, job });
    // file_preview_complete only touches status='running' rows — a late finish
    // after the watchdog already failed the job is a harmless no-op.
    const { error: doneErr } = await supabase.rpc('file_preview_complete', {
      p_job_id: job.id,
      p_preview_path: previewPath,
    });
    if (doneErr) {
      console.error(`[worker] file_preview_complete RPC failed: ${doneErr.message}`);
    } else {
      console.log(`[worker] completed preview job=${job.id} → ${previewPath}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[worker] preview job=${job.id} FAILED:`, msg);
    if (err instanceof Error && err.stack) console.error(err.stack);
    try {
      const { error: failErr } = await supabase.rpc('file_preview_fail', {
        p_job_id: job.id,
        p_error: msg,
      });
      if (failErr) {
        console.error(`[worker] file_preview_fail RPC failed: ${failErr.message}`);
      }
    } catch (innerErr) {
      console.error(
        `[worker] could not mark preview job failed: ${(innerErr as Error).message}`,
      );
    }
  }
  return true;
}

async function runPreviewWatchdog(): Promise<void> {
  try {
    const { data, error } = await supabase.rpc('file_preview_watchdog');
    if (error) {
      console.error(`[worker] preview watchdog RPC error: ${error.message}`);
      return;
    }
    const swept = typeof data === 'number' ? data : 0;
    if (swept > 0) {
      console.warn(`[worker] preview watchdog swept ${swept} stale job(s)`);
    }
  } catch (err) {
    console.error(`[worker] preview watchdog threw:`, err);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PDF compression — pdf_compress_jobs queue (Ghostscript).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Claim ONE queued compress job (if any) and run it to completion. Mirrors
 * the deck/image/preview claim-run-complete shape against pdf_compress_jobs.
 * Returns true if a job was claimed.
 */
async function claimAndRunOneCompress(): Promise<boolean> {
  const { data, error } = await supabase.rpc('pdf_compress_claim_next', {
    p_worker_id: env.WORKER_ID,
  });
  if (error) {
    console.error(`[worker] compress claim failed: ${error.message}`);
    return false;
  }
  const rows = (data ?? []) as Array<{
    job_id: string;
    file_id: string;
    attempts: number;
    storage_bucket: string;
    storage_path: string;
    mime_type: string;
    size_bytes: number;
    original_name: string;
    folder_id: string | null;
    model_id: string | null;
    record_id: string | null;
    uploaded_by_user_id: string;
  }>;
  if (rows.length === 0) return false;
  const row = rows[0]!;
  const job: CompressJob = {
    id: row.job_id,
    fileId: row.file_id,
    attempts: row.attempts,
    storageBucket: row.storage_bucket,
    storagePath: row.storage_path,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    originalName: row.original_name,
    folderId: row.folder_id,
    modelId: row.model_id,
    recordId: row.record_id,
    uploadedByUserId: row.uploaded_by_user_id,
  };
  console.log(
    `[worker] claimed compress job=${job.id} file=${job.fileId} size=${job.sizeBytes} attempts=${job.attempts}`,
  );

  try {
    const result = await runCompressJob({ supabase, env, job });
    // pdf_compress_complete only touches status='running' rows — a late finish
    // after the watchdog already failed the job is a harmless no-op.
    const { error: doneErr } = await supabase.rpc('pdf_compress_complete', {
      p_job_id: job.id,
      p_result_file_id: result.resultFileId,
      p_original_bytes: result.originalBytes,
      p_compressed_bytes: result.compressedBytes,
    });
    if (doneErr) {
      console.error(`[worker] pdf_compress_complete RPC failed: ${doneErr.message}`);
    } else {
      console.log(
        `[worker] completed compress job=${job.id} → ${result.resultFileId ?? 'no-gain'} (${result.originalBytes} → ${result.compressedBytes})`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Timeout self-heal: Fly shared-cpu machines throttle to 1/16 vCPU once
    // their burst credits drain (live 2026-06-11: this exact job took 2m50s
    // on a fresh machine, >9 min on a drained one). Requeue so a different —
    // likely credit-fresh — machine claims it; cap at 3 attempts total.
    if (msg.includes('timed out') && job.attempts < 3) {
      console.warn(
        `[worker] compress job=${job.id} timed out (attempt ${job.attempts}) — requeueing for another machine`,
      );
      try {
        const { error: requeueErr } = await supabase.rpc('pdf_compress_requeue', {
          p_job_id: job.id,
        });
        if (!requeueErr) {
          // Sit out two poll intervals so THIS (likely throttled) machine
          // doesn't win the race to re-claim its own requeued job — the four
          // siblings poll every POLL_INTERVAL_MS and will grab it first.
          await sleep(env.POLL_INTERVAL_MS * 2);
          return true;
        }
        console.error(`[worker] pdf_compress_requeue RPC failed: ${requeueErr.message}`);
      } catch (requeueInnerErr) {
        console.error(
          `[worker] could not requeue compress job: ${(requeueInnerErr as Error).message}`,
        );
      }
      // Requeue path failed — fall through to the normal fail flow.
    }
    console.error(`[worker] compress job=${job.id} FAILED:`, msg);
    if (err instanceof Error && err.stack) console.error(err.stack);
    try {
      const { error: failErr } = await supabase.rpc('pdf_compress_fail', {
        p_job_id: job.id,
        p_error: msg,
      });
      if (failErr) {
        console.error(`[worker] pdf_compress_fail RPC failed: ${failErr.message}`);
      }
    } catch (innerErr) {
      console.error(
        `[worker] could not mark compress job failed: ${(innerErr as Error).message}`,
      );
    }
  }
  return true;
}

async function runCompressWatchdog(): Promise<void> {
  try {
    const { data, error } = await supabase.rpc('pdf_compress_watchdog');
    if (error) {
      console.error(`[worker] compress watchdog RPC error: ${error.message}`);
      return;
    }
    const swept = typeof data === 'number' ? data : 0;
    if (swept > 0) {
      console.warn(`[worker] compress watchdog swept ${swept} stale job(s)`);
    }
  } catch (err) {
    console.error(`[worker] compress watchdog threw:`, err);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Document generation — document_jobs queue (template → DOCX → LibreOffice PDF).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Claim ONE queued document job (if any) and run it to completion. Mirrors the
 * deck/image/preview/compress claim-run-complete shape against document_jobs.
 * Returns true if a job was claimed.
 */
async function claimAndRunOneDocument(): Promise<boolean> {
  const { data, error } = await supabase.rpc('document_job_claim_next', {
    p_worker_id: env.WORKER_ID,
  });
  if (error) {
    console.error(`[worker] document claim failed: ${error.message}`);
    return false;
  }
  const rows = (data ?? []) as Array<{
    job_id: string;
    source_record_id: string;
    source_model_id: string;
    template_id: string;
    template_file_id: string;
    target_folder_id: string | null;
    owner_user_id: string;
    owner_auth_uid: string;
    client_record_id: string | null;
    unit_record_id: string | null;
    project_record_id: string | null;
    attempts: number;
    template_label_ar: string;
    template_label_en: string;
    content_json: unknown;
    settings: unknown;
  }>;
  if (rows.length === 0) return false;
  const row = rows[0]!;
  const job: DocumentJob = {
    id: row.job_id,
    sourceRecordId: row.source_record_id,
    sourceModelId: row.source_model_id,
    templateId: row.template_id,
    templateFileId: row.template_file_id,
    targetFolderId: row.target_folder_id,
    ownerUserId: row.owner_user_id,
    ownerAuthUid: row.owner_auth_uid,
    clientRecordId: row.client_record_id,
    unitRecordId: row.unit_record_id,
    projectRecordId: row.project_record_id,
    attempts: row.attempts,
    templateLabelAr: row.template_label_ar,
    templateLabelEn: row.template_label_en,
    contentJson: (row.content_json ?? { type: 'doc', content: [] }) as DocumentJob['contentJson'],
    settings: row.settings,
  };
  console.log(
    `[worker] claimed document job=${job.id} record=${job.sourceRecordId} template=${job.templateId} attempts=${job.attempts}`,
  );

  try {
    const resultFileId = await runDocumentJob({ supabase, env, job });
    // document_job_complete only touches status='running' rows — a late finish
    // after the watchdog already failed the job is a harmless no-op.
    const { error: doneErr } = await supabase.rpc('document_job_complete', {
      p_job_id: job.id,
      p_result_file_id: resultFileId,
    });
    if (doneErr) {
      console.error(`[worker] document_job_complete RPC failed: ${doneErr.message}`);
    } else {
      console.log(`[worker] completed document job=${job.id} → ${resultFileId}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[worker] document job=${job.id} FAILED:`, msg);
    if (err instanceof Error && err.stack) console.error(err.stack);
    try {
      const { error: failErr } = await supabase.rpc('document_job_fail', {
        p_job_id: job.id,
        p_error: msg,
      });
      if (failErr) {
        console.error(`[worker] document_job_fail RPC failed: ${failErr.message}`);
      }
    } catch (innerErr) {
      console.error(`[worker] could not mark document job failed: ${(innerErr as Error).message}`);
    }
  }
  return true;
}

async function runDocumentWatchdog(): Promise<void> {
  try {
    const { data, error } = await supabase.rpc('document_jobs_watchdog');
    if (error) {
      console.error(`[worker] document watchdog RPC error: ${error.message}`);
      return;
    }
    const swept = typeof data === 'number' ? data : 0;
    if (swept > 0) {
      console.warn(`[worker] document watchdog swept ${swept} stale job(s)`);
    }
  } catch (err) {
    console.error(`[worker] document watchdog threw:`, err);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Conflict-storm watchdog (2026-06-16) — the safety net for the record_save
// version-conflict retry storm. Runs on its OWN short interval (independent of
// the per-queue watchdogs) so detection is fast. conflict_storm_sweep() is
// read-only; on a storm it raises a system_alerts row + we log LOUDLY here +
// optionally ping CONFLICT_ALERT_WEBHOOK_URL. The client-side fixes (permanent
// breaker + reload-on-conflict) make storms rare; this is the last line of
// defense so one can never again run unnoticed for days.
const CONFLICT_SWEEP_INTERVAL_MS = 30_000;

async function runConflictStormSweep(): Promise<void> {
  try {
    const { data, error } = await supabase.rpc('conflict_storm_sweep');
    if (error) {
      console.error(`[worker] conflict_storm_sweep RPC error: ${error.message}`);
      return;
    }
    const res = (data ?? {}) as {
      storm?: boolean;
      rollback_rate?: number; // 2026-06-21: primary signal (xact_rollback/sec)
      aborted?: number;
      active?: number;
      alert_id?: number | null;
    };
    if (res.storm) {
      console.error(
        `[worker] 🚨 CONFLICT STORM DETECTED — ${res.rollback_rate ?? '?'} rollbacks/sec (alert #${res.alert_id ?? '-'}). ` +
          `A client is hammering record_save with a stale version. The enriched version_mismatch ERROR in the Postgres logs now carries [record=<uuid> model=<uuid> user=<uuid>] (or grep record_save_conflict); ` +
          `then SELECT block_conflict_storm_record('<id>') and/or kill_conflict_storm_record('<id>').`,
      );
      const hook = process.env.CONFLICT_ALERT_WEBHOOK_URL;
      if (hook) {
        try {
          await fetch(hook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: `🚨 Wassell: record_save conflict storm (${res.rollback_rate ?? '?'} rollbacks/sec). Postgres logs carry the record/model/user; run block_/kill_conflict_storm_record(<id>).`,
            }),
          });
        } catch (hookErr) {
          console.error(`[worker] conflict alert webhook failed:`, hookErr);
        }
      }
    }
  } catch (err) {
    console.error(`[worker] conflict_storm_sweep threw:`, err);
  }
}

async function conflictWatchdogLoop(): Promise<void> {
  while (!shuttingDown) {
    await runConflictStormSweep();
    const wokeAt = Date.now();
    while (Date.now() - wokeAt < CONFLICT_SWEEP_INTERVAL_MS && !shuttingDown) {
      await sleep(1000);
    }
  }
}

/**
 * Main loop. Stays in this function for the lifetime of the process.
 * Drains the queue as fast as it can, then sleeps POLL_INTERVAL_MS
 * between polls. /wake POSTs set wakeRequested=true to skip the
 * current sleep and poll immediately.
 */
async function pollLoop(): Promise<void> {
  let lastWatchdog = 0;
  while (!shuttingDown) {
    busy = true;
    let didClaim = false;
    try {
      didClaim = await claimAndRunOne();
    } catch (err) {
      console.error('[worker] poll iteration error:', err);
    }
    busy = false;

    // Watchdog tick — independent of whether we just ran a job. Cheap
    // (single UPDATE through a partial index) so we don't bother
    // throttling beyond the interval.
    if (Date.now() - lastWatchdog > env.WATCHDOG_INTERVAL_MS) {
      lastWatchdog = Date.now();
      await runWatchdog();
    }

    if (didClaim || wakeRequested) {
      // Drain the queue without sleeping when there's work or a wake
      // ping arrived during/after the last job.
      wakeRequested = false;
      continue;
    }
    // Sleep — but break early on a wake.
    const wokeAt = Date.now();
    while (Date.now() - wokeAt < env.POLL_INTERVAL_MS && !wakeRequested && !shuttingDown) {
      await sleep(200);
    }
  }
}

/**
 * Image-queue twin of pollLoop. Runs concurrently (Promise.all at boot) with
 * its own imageBusy flag + imageWakeRequested, so an in-flight deck never
 * stalls image turns. Ticks generation_jobs_watchdog() on the same interval.
 */
async function imagePollLoop(): Promise<void> {
  let lastWatchdog = 0;
  while (!shuttingDown) {
    imageBusy = true;
    let didClaim = false;
    try {
      didClaim = await claimAndRunOneImage();
    } catch (err) {
      console.error('[worker] image poll iteration error:', err);
    }
    imageBusy = false;

    if (Date.now() - lastWatchdog > env.WATCHDOG_INTERVAL_MS) {
      lastWatchdog = Date.now();
      await runImageWatchdog();
    }

    if (didClaim || imageWakeRequested) {
      imageWakeRequested = false;
      continue;
    }
    const wokeAt = Date.now();
    while (Date.now() - wokeAt < env.POLL_INTERVAL_MS && !imageWakeRequested && !shuttingDown) {
      await sleep(200);
    }
  }
}

/**
 * Preview-queue twin of pollLoop/imagePollLoop. Runs concurrently with its
 * own busy/wake flags. Ticks file_preview_watchdog() on the same interval.
 */
async function previewPollLoop(): Promise<void> {
  let lastWatchdog = 0;
  while (!shuttingDown) {
    previewBusy = true;
    let didClaim = false;
    try {
      didClaim = await claimAndRunOnePreview();
    } catch (err) {
      console.error('[worker] preview poll iteration error:', err);
    }
    previewBusy = false;

    if (Date.now() - lastWatchdog > env.WATCHDOG_INTERVAL_MS) {
      lastWatchdog = Date.now();
      await runPreviewWatchdog();
    }

    if (didClaim || previewWakeRequested) {
      previewWakeRequested = false;
      continue;
    }
    const wokeAt = Date.now();
    while (Date.now() - wokeAt < env.POLL_INTERVAL_MS && !previewWakeRequested && !shuttingDown) {
      await sleep(200);
    }
  }
}

/**
 * Compress-queue twin of the other poll loops. Runs concurrently with its
 * own busy/wake flags. Ticks pdf_compress_watchdog() on the same interval.
 */
async function compressPollLoop(): Promise<void> {
  let lastWatchdog = 0;
  while (!shuttingDown) {
    compressBusy = true;
    let didClaim = false;
    try {
      didClaim = await claimAndRunOneCompress();
    } catch (err) {
      console.error('[worker] compress poll iteration error:', err);
    }
    compressBusy = false;

    if (Date.now() - lastWatchdog > env.WATCHDOG_INTERVAL_MS) {
      lastWatchdog = Date.now();
      await runCompressWatchdog();
    }

    if (didClaim || compressWakeRequested) {
      compressWakeRequested = false;
      continue;
    }
    const wokeAt = Date.now();
    while (Date.now() - wokeAt < env.POLL_INTERVAL_MS && !compressWakeRequested && !shuttingDown) {
      await sleep(200);
    }
  }
}

/**
 * Document-queue twin of the other poll loops. Runs concurrently with its own
 * busy/wake flags. Ticks document_jobs_watchdog() on the same interval.
 */
async function documentPollLoop(): Promise<void> {
  let lastWatchdog = 0;
  while (!shuttingDown) {
    documentBusy = true;
    let didClaim = false;
    try {
      didClaim = await claimAndRunOneDocument();
    } catch (err) {
      console.error('[worker] document poll iteration error:', err);
    }
    documentBusy = false;

    if (Date.now() - lastWatchdog > env.WATCHDOG_INTERVAL_MS) {
      lastWatchdog = Date.now();
      await runDocumentWatchdog();
    }

    if (didClaim || documentWakeRequested) {
      documentWakeRequested = false;
      continue;
    }
    const wokeAt = Date.now();
    while (Date.now() - wokeAt < env.POLL_INTERVAL_MS && !documentWakeRequested && !shuttingDown) {
      await sleep(200);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Data Migration — data_migration_jobs queue (extract / plan / discuss).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Claim ONE queued migration job (if any) and run it to completion. Mirrors the
 * deck/image claim-run-complete shape against data_migration_jobs. runMigrationJob
 * already reflects a failure onto the record (so the SPA spinner exits); here we
 * just mark the job done/failed. Returns true if a job was claimed.
 */
async function claimAndRunOneMigration(): Promise<boolean> {
  const { data, error } = await supabase.rpc('data_migration_job_claim_next', {
    p_worker_id: env.WORKER_ID,
  });
  if (error) {
    console.error(`[worker] migration claim failed: ${error.message}`);
    return false;
  }
  const rows = (data ?? []) as Array<{
    job_id: string;
    migration_record_id: string;
    user_id: string;
    kind: MigrationJob['kind'];
    payload: Record<string, unknown>;
    attempts: number;
  }>;
  if (rows.length === 0) return false;
  const row = rows[0]!;
  const job: MigrationJob = {
    id: row.job_id,
    recordId: row.migration_record_id,
    userId: row.user_id,
    kind: row.kind,
    payload: row.payload ?? {},
    attempts: row.attempts,
  };
  console.log(
    `[worker] claimed migration job=${job.id} kind=${job.kind} record=${job.recordId} attempts=${job.attempts}`,
  );

  try {
    const result = await runMigrationJob({ supabase, env, job });
    // data_migration_job_complete only touches status='running' rows — a late
    // finish after the watchdog/cancel already moved the job is a harmless no-op.
    const { error: doneErr } = await supabase.rpc('data_migration_job_complete', {
      p_job_id: job.id,
      p_result: result ?? {},
    });
    if (doneErr) {
      console.error(`[worker] data_migration_job_complete RPC failed: ${doneErr.message}`);
    } else {
      console.log(`[worker] completed migration job=${job.id}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[worker] migration job=${job.id} FAILED:`, msg);
    if (err instanceof Error && err.stack) console.error(err.stack);
    try {
      const { error: failErr } = await supabase.rpc('data_migration_job_fail', {
        p_job_id: job.id,
        p_error: msg,
      });
      if (failErr) {
        console.error(`[worker] data_migration_job_fail RPC failed: ${failErr.message}`);
      }
    } catch (innerErr) {
      console.error(`[worker] could not mark migration job failed: ${(innerErr as Error).message}`);
    }
  }
  return true;
}

async function runMigrationWatchdog(): Promise<void> {
  try {
    const { data, error } = await supabase.rpc('data_migration_jobs_watchdog');
    if (error) {
      console.error(`[worker] migration watchdog RPC error: ${error.message}`);
      return;
    }
    const swept = typeof data === 'number' ? data : 0;
    if (swept > 0) {
      console.warn(`[worker] migration watchdog swept ${swept} stale job(s)`);
    }
  } catch (err) {
    console.error(`[worker] migration watchdog threw:`, err);
  }
}

/**
 * Migration-queue twin of the other poll loops. Runs concurrently with its own
 * busy/wake flags. Ticks data_migration_jobs_watchdog() on the same interval.
 */
async function migrationPollLoop(): Promise<void> {
  let lastWatchdog = 0;
  while (!shuttingDown) {
    migrationBusy = true;
    let didClaim = false;
    try {
      didClaim = await claimAndRunOneMigration();
    } catch (err) {
      console.error('[worker] migration poll iteration error:', err);
    }
    migrationBusy = false;

    if (Date.now() - lastWatchdog > env.WATCHDOG_INTERVAL_MS) {
      lastWatchdog = Date.now();
      await runMigrationWatchdog();
    }

    if (didClaim || migrationWakeRequested) {
      migrationWakeRequested = false;
      continue;
    }
    const wokeAt = Date.now();
    while (Date.now() - wokeAt < env.POLL_INTERVAL_MS && !migrationWakeRequested && !shuttingDown) {
      await sleep(200);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// REGA advertiser-phone lookup — rega_lookup_jobs queue (Browserbase).
// ─────────────────────────────────────────────────────────────────────────

/**
 * Claim ONE queued REGA lookup job (if any) and run it to completion. Mirrors the
 * deck/image claim-run-complete shape against rega_lookup_jobs. runRegaLookupJob
 * already reflects a failure onto the listing record (so the SPA button spinner
 * exits); here we just mark the job done/failed. Returns true if a job was claimed.
 */
async function claimAndRunOneRega(): Promise<boolean> {
  const { data, error } = await supabase.rpc('rega_lookup_job_claim_next', {
    p_worker_id: env.WORKER_ID,
  });
  if (error) {
    console.error(`[worker] rega claim failed: ${error.message}`);
    return false;
  }
  const rows = (data ?? []) as Array<{
    job_id: string;
    listing_record_id: string;
    user_id: string;
    attempts: number;
  }>;
  if (rows.length === 0) return false;
  const row = rows[0]!;
  const job: RegaLookupJob = {
    id: row.job_id,
    recordId: row.listing_record_id,
    userId: row.user_id,
    attempts: row.attempts,
  };
  console.log(
    `[worker] claimed rega job=${job.id} listing=${job.recordId} attempts=${job.attempts}`,
  );

  try {
    const result = await runRegaLookupJob({ supabase, env, job });
    // rega_lookup_job_complete only touches status='running' rows — a late finish
    // after the watchdog already failed the job is a harmless no-op.
    const { error: doneErr } = await supabase.rpc('rega_lookup_job_complete', {
      p_job_id: job.id,
      p_result: result ?? {},
    });
    if (doneErr) {
      console.error(`[worker] rega_lookup_job_complete RPC failed: ${doneErr.message}`);
    } else {
      console.log(`[worker] completed rega job=${job.id} → ${(result as { outcome?: string }).outcome ?? 'ok'}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[worker] rega job=${job.id} FAILED:`, msg);
    if (err instanceof Error && err.stack) console.error(err.stack);
    try {
      const { error: failErr } = await supabase.rpc('rega_lookup_job_fail', {
        p_job_id: job.id,
        p_error: msg,
      });
      if (failErr) {
        console.error(`[worker] rega_lookup_job_fail RPC failed: ${failErr.message}`);
      }
    } catch (innerErr) {
      console.error(`[worker] could not mark rega job failed: ${(innerErr as Error).message}`);
    }
  }
  return true;
}

async function runRegaWatchdog(): Promise<void> {
  try {
    const { data, error } = await supabase.rpc('rega_lookup_jobs_watchdog');
    if (error) {
      console.error(`[worker] rega watchdog RPC error: ${error.message}`);
      return;
    }
    const swept = typeof data === 'number' ? data : 0;
    if (swept > 0) {
      console.warn(`[worker] rega watchdog swept ${swept} stale job(s)`);
    }
  } catch (err) {
    console.error(`[worker] rega watchdog threw:`, err);
  }
}

/**
 * REGA-queue twin of the other poll loops. Runs concurrently with its own
 * busy/wake flags. Ticks rega_lookup_jobs_watchdog() on the same interval.
 */
async function regaPollLoop(): Promise<void> {
  let lastWatchdog = 0;
  while (!shuttingDown) {
    regaBusy = true;
    let didClaim = false;
    try {
      didClaim = await claimAndRunOneRega();
    } catch (err) {
      console.error('[worker] rega poll iteration error:', err);
    }
    regaBusy = false;

    if (Date.now() - lastWatchdog > env.WATCHDOG_INTERVAL_MS) {
      lastWatchdog = Date.now();
      await runRegaWatchdog();
    }

    if (didClaim || regaWakeRequested) {
      regaWakeRequested = false;
      continue;
    }
    const wokeAt = Date.now();
    while (Date.now() - wokeAt < env.POLL_INTERVAL_MS && !regaWakeRequested && !shuttingDown) {
      await sleep(200);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Scheduled Reports — time-gated. scheduled_report_claim_due returns only
// reports whose next_run_at has passed (SKIP LOCKED), so no separate scheduler
// is needed. Each due report is run by POSTing the owner-scoped runner endpoint
// on the app (the worker can't import the analytics engine). The runner does the
// bookkeeping (next_run_at, status, history); a crashed run is reset by the
// reports watchdog after 10 min.
// ─────────────────────────────────────────────────────────────────────────

async function claimAndRunDueReports(): Promise<boolean> {
  const { data, error } = await supabase.rpc('scheduled_report_claim_due', {
    p_worker_id: env.WORKER_ID,
    p_limit: 5,
  });
  if (error) {
    console.error(`[worker] report claim failed: ${error.message}`);
    return false;
  }
  const rows = (data ?? []) as Array<{ id: string; title: string }>;
  if (rows.length === 0) return false;
  for (const r of rows) {
    console.log(`[worker] running scheduled report=${r.id} "${r.title}"`);
    try {
      const res = await fetch(`${env.APP_URL}/api/internal/run-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-reports-runner-secret': env.REPORTS_RUNNER_SECRET! },
        body: JSON.stringify({ report_id: r.id }),
      });
      const body = (await res.json().catch(() => ({}))) as { result?: { status?: string }; error?: string };
      if (!res.ok) {
        console.error(`[worker] report=${r.id} runner HTTP ${res.status}: ${body.error ?? ''}`);
      } else {
        console.log(`[worker] report=${r.id} → ${body.result?.status ?? 'ok'}`);
      }
    } catch (err) {
      // Left status='running'; the watchdog resets it after 10 min so it retries.
      console.error(`[worker] report=${r.id} runner call threw:`, err);
    }
  }
  return true;
}

async function runReportsWatchdog(): Promise<void> {
  try {
    const { data, error } = await supabase.rpc('scheduled_reports_watchdog');
    if (error) {
      console.error(`[worker] reports watchdog RPC error: ${error.message}`);
      return;
    }
    const swept = typeof data === 'number' ? data : 0;
    if (swept > 0) console.warn(`[worker] reports watchdog reset ${swept} stuck report(s)`);
  } catch (err) {
    console.error(`[worker] reports watchdog threw:`, err);
  }
}

async function reportsPollLoop(): Promise<void> {
  let lastWatchdog = 0;
  while (!shuttingDown) {
    reportsBusy = true;
    let didClaim = false;
    try {
      didClaim = await claimAndRunDueReports();
    } catch (err) {
      console.error('[worker] reports poll iteration error:', err);
    }
    reportsBusy = false;

    if (Date.now() - lastWatchdog > env.WATCHDOG_INTERVAL_MS) {
      lastWatchdog = Date.now();
      await runReportsWatchdog();
    }

    if (didClaim || reportsWakeRequested) {
      reportsWakeRequested = false;
      continue;
    }
    const wokeAt = Date.now();
    while (Date.now() - wokeAt < env.POLL_INTERVAL_MS && !reportsWakeRequested && !shuttingDown) {
      await sleep(200);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Server-authoritative workflow runner — workflow_jobs queue.
// ─────────────────────────────────────────────────────────────────────────

interface RunnerResponseBody {
  ok?: boolean;
  job_id?: string;
  retryable?: boolean;
  results?: Array<{ workflow_id: string; run_id: string | null; status: string; failure_class?: string; reason?: string }>;
  error?: string;
  reason?: string;
}

async function failWorkflowJob(jobId: string, errMsg: string): Promise<void> {
  try {
    const { error } = await supabase.rpc('workflow_job_fail', { p_job_id: jobId, p_error: errMsg });
    if (error) console.error(`[worker] workflow_job_fail RPC failed job=${jobId}: ${error.message}`);
  } catch (e) {
    console.error(`[worker] could not fail workflow job=${jobId}: ${(e as Error).message}`);
  }
}

/**
 * Claim ONE workflow job and run it via the protected runner endpoint. The
 * worker owns complete/fail; the decision is driven by the RESPONSE BODY
 * classification, never HTTP 200 alone:
 *   transport (network / timeout / 5xx / malformed body) → fail (backoff → dead)
 *   401 / 503 (auth/misconfig)                           → 3-strike self-disable, LEAVE job
 *   409 not_processing/lease_expired/locked_by_mismatch  → leave (watchdog owns it)
 *   400 / 404                                            → leave + loud log (non-retryable)
 *   200 + body.retryable === true                        → fail (a run hit a transient failure)
 *   200 + body.retryable === false                       → complete (deterministic run
 *        failures belong in workflow_runs, not the queue → completed_with_failed_runs)
 */
async function claimAndRunOneWorkflow(): Promise<boolean> {
  const { data, error } = await supabase.rpc('workflow_job_claim_next', { p_worker_id: env.WORKER_ID });
  if (error) {
    console.error(`[worker] workflow claim failed: ${error.message}`);
    return false;
  }
  const rows = (data ?? []) as Array<{ job_id: string }>;
  if (rows.length === 0) return false;
  const jobId = rows[0]!.job_id;
  console.log(`[worker] claimed workflow job=${jobId}`);

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(`${env.APP_URL}/api/internal/run-workflow-job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-workflow-runner-secret': env.WORKFLOW_RUNNER_SECRET! },
      body: JSON.stringify({ job_id: jobId, worker_id: env.WORKER_ID }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[worker] workflow job=${jobId} transport error: ${msg}`);
    await failWorkflowJob(jobId, `transport: ${msg}`);
    return true;
  }

  // Auth / misconfig — retrying jobs won't fix it. Leave the job (the watchdog
  // requeues it after the lease, so no attempt is wasted) and 3-strike-disable.
  if (res.status === 401 || res.status === 503) {
    workflowAuthFailures += 1;
    console.error(`[worker] workflow job=${jobId} HTTP ${res.status} (auth/misconfig) — strike ${workflowAuthFailures}/3; leaving job for the watchdog`);
    if (workflowAuthFailures >= 3 && !workflowAuthDisabled) {
      workflowAuthDisabled = true;
      console.error('[worker] 🚨 workflow loop AUTH-DISABLED after 3 consecutive 401/503 — set WORKFLOW_RUNNER_SECRET (Vercel + Fly) then redeploy/restart the worker. Watchdog keeps running.');
    }
    return true;
  }
  // Any reachable runner call (even one reporting failures) clears the counter.
  workflowAuthFailures = 0;

  let body: RunnerResponseBody = {};
  try {
    body = (await res.json()) as RunnerResponseBody;
  } catch {
    console.error(`[worker] workflow job=${jobId} HTTP ${res.status} malformed body → fail`);
    await failWorkflowJob(jobId, `malformed body (HTTP ${res.status})`);
    return true;
  }

  // State discipline — the job moved on (watchdog/another worker). Leave it.
  if (res.status === 409) {
    console.warn(`[worker] workflow job=${jobId} 409 ${body.reason ?? ''} — leaving job (state moved on)`);
    return true;
  }
  // Non-retryable client errors — not ours to complete/fail; log loud + leave.
  if (res.status === 400 || res.status === 404) {
    console.error(`[worker] workflow job=${jobId} HTTP ${res.status} ${body.error ?? ''} — leaving job (non-retryable client error)`);
    return true;
  }
  // 5xx → transport-class → retry/backoff.
  if (res.status >= 500) {
    console.error(`[worker] workflow job=${jobId} HTTP ${res.status} ${body.error ?? ''} → fail`);
    await failWorkflowJob(jobId, `HTTP ${res.status}: ${body.error ?? ''}`);
    return true;
  }

  // 200 — classify by the BODY, not the status.
  if (body.retryable) {
    console.warn(`[worker] workflow job=${jobId} 200 but body.retryable → failing for backoff`);
    await failWorkflowJob(jobId, 'runner reported a retryable failure');
    return true;
  }
  const failedRuns = (body.results ?? []).filter((r) => r.status === 'failed');
  const { error: doneErr } = await supabase.rpc('workflow_job_complete', { p_job_id: jobId });
  if (doneErr) console.error(`[worker] workflow_job_complete failed job=${jobId}: ${doneErr.message}`);
  else if (failedRuns.length) console.log(`[worker] completed_with_failed_runs job=${jobId} (${failedRuns.length} deterministic run failure(s))`);
  else console.log(`[worker] completed workflow job=${jobId}`);
  return true;
}

async function runWorkflowWatchdog(): Promise<void> {
  try {
    const { data, error } = await supabase.rpc('workflow_jobs_watchdog');
    if (error) { console.error(`[worker] workflow watchdog RPC error: ${error.message}`); return; }
    const swept = typeof data === 'number' ? data : 0;
    if (swept > 0) console.warn(`[worker] workflow watchdog swept ${swept} stale job(s)`);
  } catch (err) {
    console.error('[worker] workflow watchdog threw:', err);
  }
}

/**
 * Workflow-queue twin of the other poll loops. When auth-disabled it STOPS
 * claiming but the loop stays alive so the watchdog keeps freeing stuck jobs
 * (the watchdog never calls the protected endpoint).
 */
async function workflowPollLoop(): Promise<void> {
  let lastWatchdog = 0;
  while (!shuttingDown) {
    workflowBusy = true;
    let didClaim = false;
    if (!workflowAuthDisabled) {
      try {
        didClaim = await claimAndRunOneWorkflow();
      } catch (err) {
        console.error('[worker] workflow poll iteration error:', err);
      }
    }
    workflowBusy = false;

    if (Date.now() - lastWatchdog > env.WATCHDOG_INTERVAL_MS) {
      lastWatchdog = Date.now();
      await runWorkflowWatchdog();
    }

    if (didClaim || workflowWakeRequested) {
      workflowWakeRequested = false;
      continue;
    }
    const wokeAt = Date.now();
    while (Date.now() - wokeAt < env.POLL_INTERVAL_MS && !workflowWakeRequested && !shuttingDown) {
      await sleep(200);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Marketing Intelligence — mkt_collection_jobs queue. Claim one job, run the
// collect→normalize→dedup→attribute→snapshot pipeline, complete/fail with backoff.
// The loop also ticks the scheduler (mkt_enqueue_due_accounts) + watchdog.
// ─────────────────────────────────────────────────────────────────────────
async function claimAndRunOneMarketing(): Promise<boolean> {
  const { data, error } = await supabase.rpc('mkt_job_claim_next', {
    p_worker_id: env.WORKER_ID,
    p_lease_seconds: 600,
  });
  if (error) {
    console.error(`[worker] marketing claim failed: ${error.message}`);
    return false;
  }
  const rows = (data ?? []) as Array<{
    job_id: string; kind: string; provider: CollectionJob['provider'];
    social_account_id: string | null; params: Record<string, unknown>;
    attempts: number; max_attempts: number;
  }>;
  if (rows.length === 0) return false;
  const row = rows[0]!;
  const job: CollectionJob = {
    id: row.job_id, kind: row.kind, provider: row.provider,
    social_account_id: row.social_account_id, params: row.params ?? {},
    attempts: row.attempts, max_attempts: row.max_attempts,
  };
  console.log(`[worker] claimed marketing job=${job.id} kind=${job.kind} provider=${job.provider} attempts=${job.attempts}`);
  try {
    const { stats } = await runCollectionJob({ supabase, env, job });
    await supabase.rpc('mkt_job_complete', { p_job_id: job.id, p_result: stats });
    console.log(`[worker] marketing job=${job.id} ok: received=${stats.received} inserted=${stats.inserted} updated=${stats.updated} skipped=${stats.skipped}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const { data: outcome } = await supabase.rpc('mkt_job_fail', { p_job_id: job.id, p_error: msg });
    console.error(`[worker] marketing job=${job.id} failed (${outcome}): ${msg}`);
  }
  return true;
}

async function marketingPollLoop(): Promise<void> {
  let lastMaint = 0;
  while (!shuttingDown) {
    marketingBusy = true;
    let didClaim = false;
    try {
      didClaim = await claimAndRunOneMarketing();
    } catch (err) {
      console.error('[worker] marketing poll iteration error:', err);
    }
    marketingBusy = false;

    // Watchdog (reclaim stale leases) + scheduler (enqueue due pilot accounts).
    if (Date.now() - lastMaint > env.WATCHDOG_INTERVAL_MS) {
      lastMaint = Date.now();
      try {
        await supabase.rpc('mkt_jobs_watchdog');
        const { data: enq } = await supabase.rpc('mkt_enqueue_due_accounts');
        if (enq && Number(enq) > 0) console.log(`[worker] marketing scheduler enqueued ${enq} job(s)`);
        // Second, independent enqueue path. The scheduler only reacts to events
        // ("this account is due"); the sweep reacts to STATE ("this post has no
        // media"), so a post can never be stranded by a missed enqueue again.
        const sweep = await sweepContentBacklog(supabase, env.WORKER_ID);
        if (sweep.media_recover || sweep.visual_ocr || sweep.content_process) {
          console.log(`[worker] content sweep: media_recover=${sweep.media_recover} visual_ocr=${sweep.visual_ocr} content_process=${sweep.content_process}`);
        }
        // Scheduler heartbeat — ops monitoring flags it offline if this stops ticking.
        await supabase.rpc('mkt_heartbeat', { p_component: 'scheduler', p_detail: { enqueued: enq ?? 0 } });
      } catch (e) {
        console.error('[worker] marketing maintenance error:', e instanceof Error ? e.message : e);
      }
    }

    if (didClaim || marketingWakeRequested) {
      marketingWakeRequested = false;
      continue;
    }
    const wokeAt = Date.now();
    while (Date.now() - wokeAt < env.POLL_INTERVAL_MS && !marketingWakeRequested && !shuttingDown) {
      await sleep(200);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Marketing Intelligence OPS monitoring loop (always-on).
// Every OPS_HEARTBEAT_MS: write the worker heartbeat + a live storage-availability
// check (the one diagnostic that needs real I/O the SQL side can't do). Every
// OPS_EVAL_MS: call mkt_ops_evaluate() — captures daily KPIs, runs SQL diagnostics,
// scans freshness, and GENERATES (never sends) operational alerts. All idempotent;
// a failure here is logged loudly and the loop keeps ticking (monitoring must not
// crash the worker). This runs even when collection is disabled so "silently
// stopped collecting" surfaces as org_stale / provider_no_data alerts.
// ─────────────────────────────────────────────────────────────────────────
const OPS_HEARTBEAT_MS = 60_000;
const OPS_EVAL_MS = Math.max(env.WATCHDOG_INTERVAL_MS, 60_000);
const OPS_CLEANUP_MS = 86_400_000; // orphan-creative cleanup, dry-run, once/day
async function marketingOpsPollLoop(): Promise<void> {
  let lastEval = 0;
  let lastCleanup = 0;
  while (!shuttingDown) {
    marketingOpsBusy = true;
    try {
      await supabase.rpc('mkt_heartbeat', {
        p_component: 'worker',
        p_detail: { worker_id: env.WORKER_ID, uptime_s: Math.round(process.uptime()) },
      });
      // Live storage-availability check (SECURITY DEFINER SQL can't reach storage).
      const t0 = Date.now();
      const { error: stErr } = await supabase.storage
        .from('marketing-assets')
        .list('', { limit: 1 });
      await supabase.rpc('mkt_diagnostic_set', {
        p_check: 'storage_available',
        p_status: stErr ? 'down' : 'ok',
        p_detail: stErr ? stErr.message : 'reachable',
        p_latency_ms: Date.now() - t0,
      });
      if (Date.now() - lastEval > OPS_EVAL_MS) {
        lastEval = Date.now();
        const { error: evErr } = await supabase.rpc('mkt_ops_evaluate');
        if (evErr) console.error('[worker] marketing ops evaluate error:', evErr.message);
      }
      // Orphaned-creative cleanup — DRY-RUN only in production (detects + records,
      // never deletes). Flip WASSEL_CREATIVE_CLEANUP_DELETE=1 to enable deletion.
      if (Date.now() - lastCleanup > OPS_CLEANUP_MS) {
        lastCleanup = Date.now();
        try {
          const r = await runCreativeCleanup(supabase, { dryRun: process.env.WASSEL_CREATIVE_CLEANUP_DELETE !== '1', retentionDays: 7 });
          console.log(`[worker] creative cleanup: scanned=${r.scanned} orphans=${r.orphans} deleted=${r.deleted} dryRun=${r.dryRun}`);
        } catch (e) { console.error('[worker] creative cleanup error:', e instanceof Error ? e.message : e); }
      }
    } catch (e) {
      console.error('[worker] marketing ops loop error:', e instanceof Error ? e.message : e);
    }
    marketingOpsBusy = false;
    const wokeAt = Date.now();
    while (Date.now() - wokeAt < OPS_HEARTBEAT_MS && !shuttingDown) {
      await sleep(500);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// HTTP server: /healthz for Fly health checks, /wake for API ping.
// ─────────────────────────────────────────────────────────────────────────
/**
 * WAHA reverse proxy (WA-06).
 *
 * WAHA refuses Vercel's egress with 403 while accepting Fly, so every gateway
 * call from the app is forwarded through a worker that attaches the real key.
 * That proxy lived on `wassel-wa-agent` — which runs exactly ONE machine by
 * design, because a second would spawn a second Claude session for the same
 * customer. So a singleton constraint that exists for the AI was silently also
 * the availability ceiling for ALL sending, chat-list loads and history loads:
 * every wa-agent deploy or reboot took WhatsApp down with it.
 *
 * This app already runs five machines and already holds both WAHA secrets, so
 * hosting the proxy here makes it highly available without touching the AI
 * runner's singleton guarantee — the two concerns simply stop sharing a
 * machine. Fly load-balances across the five.
 *
 * Auth is the shared WHATSAPP_AI_SECRET, as before; without it this would be an
 * open relay to the WhatsApp gateway.
 */
async function handleWahaProxy(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const secret = process.env.WHATSAPP_AI_SECRET ?? '';
  if (!secret || req.headers['x-wassel-proxy-secret'] !== secret) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  const base = (process.env.WAHA_URL ?? '').replace(/\/+$/, '');
  const key = process.env.WAHA_API_KEY ?? '';
  if (!base || !key) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'WAHA_URL / WAHA_API_KEY not set on the worker' }));
    return;
  }
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const upstream = await fetch(`${base}${url.pathname.slice('/waha'.length)}${url.search}`, {
      method: req.method,
      headers: {
        'X-Api-Key': key,
        ...(req.headers['content-type'] ? { 'Content-Type': String(req.headers['content-type']) } : {}),
      },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream' });
    res.end(buf);
  } catch (err) {
    console.error('[worker] waha proxy error:', err);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `proxy failed: ${err instanceof Error ? err.message : String(err)}` }));
  }
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url ?? '/', 'http://localhost');
  if (reqUrl.pathname.startsWith('/waha/')) {
    void handleWahaProxy(req, res, reqUrl);
    return;
  }
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        busy,
        image_busy: imageBusy,
        clean_busy: cleanBusy,
        video_busy: videoBusy,
        preview_busy: previewBusy,
        compress_busy: compressBusy,
        document_busy: documentBusy,
        migration_busy: migrationBusy,
        reports_busy: reportsBusy,
        reports_enabled: !!env.REPORTS_RUNNER_SECRET,
        workflow_enabled: !!env.WORKFLOW_RUNNER_SECRET,
        workflow_proof_only: env.WORKFLOW_PROOF_ONLY,
        workflow_auth_disabled: workflowAuthDisabled,
        workflow_auth_failures: workflowAuthFailures,
        workflow_busy: workflowBusy,
        rega_busy: regaBusy,
        rega_enabled: !!(env.BROWSERBASE_API_KEY && env.BROWSERBASE_PROJECT_ID),
        marketing_busy: marketingBusy,
        marketing_enabled: env.MARKETING_COLLECTION_ENABLED,
        marketing_ops_busy: marketingOpsBusy,
        worker_id: env.WORKER_ID,
        uptime_s: Math.round(process.uptime()),
      }),
    );
    return;
  }
  if (req.method === 'POST' && req.url === '/wake') {
    // Wake ALL queues — the endpoint that pings /wake doesn't say which kind
    // of job it enqueued, and an extra poll on the idle loops is cheap.
    wakeRequested = true;
    imageWakeRequested = true;
    cleanWakeRequested = true;
    videoWakeRequested = true;
    previewWakeRequested = true;
    compressWakeRequested = true;
    documentWakeRequested = true;
    migrationWakeRequested = true;
    reportsWakeRequested = true;
    workflowWakeRequested = true;
    regaWakeRequested = true;
    scheduledWaWakeRequested = true;
    marketingWakeRequested = true;
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ack: true }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(env.PORT, () => {
  console.log(
    `[worker] HTTP listening on :${env.PORT}, worker_id=${env.WORKER_ID}, poll=${env.POLL_INTERVAL_MS}ms`,
  );
});

// Graceful shutdown — give the current job up to 60s to wrap.
async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] ${signal} received — draining`);
  shuttingDown = true;
  server.close();
  const deadline = Date.now() + 60_000;
  while ((busy || imageBusy || cleanBusy || previewBusy || compressBusy || documentBusy || migrationBusy || reportsBusy || workflowBusy || regaBusy || scheduledWaBusy || marketingBusy) && Date.now() < deadline) {
    await sleep(500);
  }
  console.log('[worker] exiting');
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// ─────────────────────────────────────────────────────────────────────────
// Scheduled WhatsApp sends (scheduled_whatsapp_jobs) — time-gated, WAHA only.
// scheduled_whatsapp_claim_due returns only rows whose deliver_at has passed
// (SKIP LOCKED), so no separate scheduler is needed. Each row is sent via WAHA.
// The same loop ticks the queue watchdog AND the WAHA session (zombie) watchdog.
// ─────────────────────────────────────────────────────────────────────────

interface ScheduledWaRow {
  job_id: string;
  device_id: string;
  chat_wid: string;
  phone: string | null;
  body: string | null;
  media: unknown;
  reference: string | null;
  attempts: number;
}

// Retry posture (added 2026-07-23 after the 10:00 batch died on one attempt):
// a WAHA-level 5xx / network failure is TRANSIENT (zombie session, WAHA restart,
// WhatsApp server hiccup — e.g. "server returned error 463"), so the job is
// requeued with backoff up to 3 total attempts instead of failing permanently.
// App-level errors (bad media ref, partial send) still fail on the first try.
const SCHEDULED_WA_MAX_ATTEMPTS = 3;

/**
 * WhatsApp error 463 — the reach-out time-lock on a contact we hold no token
 * for. It is a PERMANENT refusal by WhatsApp's servers, and it arrives wrapped
 * in a WAHA 500:
 *
 *   WAHA /api/sendText failed: 500 {"statusCode":500,…,
 *     "message":"2 UNKNOWN: server returned error 463",…}
 *
 * Classifying on the status alone therefore called it transient and did the two
 * worst possible things: retried it three times (each retry re-arms the lock,
 * per WAHA #1992 / whatsmeow #1074) and restarted the WhatsApp session, which
 * fixes nothing because the refusal is server-side. 11 of the 37 permanently
 * failed jobs are 463s that were treated this way (WA-07, audit 2026-07-28).
 *
 * Matched on the body, BEFORE the generic 5xx rule.
 */
function isColdOutreachLock(msg: string): boolean {
  return /server returned error 463\b/.test(msg) || /\berror 463\b/.test(msg);
}

function isTransientWahaSendError(msg: string): boolean {
  if (isColdOutreachLock(msg)) return false;
  return /^WAHA \/api\/\w+ failed: 5\d\d/.test(msg) || /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg);
}

// A send failing with a WAHA 5xx is strong evidence the session is a zombie
// (dead-but-'WORKING' — the state the status watchdog deliberately only logs),
// so kick a restart before the retry lands. Debounced per session so a burst of
// failing jobs triggers ONE restart, not one per job.
const WAHA_RESTART_DEBOUNCE_MS = 10 * 60_000;

/**
 * Restarting a WhatsApp session is a heavy, disruptive act — it drops whatever
 * the other machines have in flight on that session — and it must happen at
 * most once across the fleet.
 *
 * The old guard was a process-local Map. wassel-deck-worker runs FIVE machines,
 * each with its own copy, so a session that briefly stopped being WORKING could
 * receive up to five concurrent restarts, and a burst of 5xx sends five more.
 * Repeatedly restarting an active session risks losing the pairing — the exact
 * failure the Doha move was meant to end (WA-08, audit 2026-07-28).
 *
 * A Postgres advisory lock is the fleet-wide equivalent: whoever takes it acts,
 * everyone else moves on. It is released when the transaction/session ends, so
 * a machine dying mid-restart cannot wedge the lock forever.
 */
async function withSessionRemediationLock(session: string, fn: () => Promise<void>): Promise<boolean> {
  const { data, error } = await supabase.rpc('waha_try_remediation_lock', {
    p_session: session,
    p_min_interval_seconds: Math.floor(WAHA_RESTART_DEBOUNCE_MS / 1000),
  });
  if (error) {
    console.error(`[worker] remediation lock rpc failed for '${session}':`, error.message);
    return false;
  }
  if (data !== true) return false;   // another machine owns it, or too soon
  await fn();
  return true;
}

async function maybeRestartWahaSessionAfterSendFailure(session: string, reason: string): Promise<void> {
  if (!wahaSend) return;
  await withSessionRemediationLock(session, async () => {
    try {
      await restartSession(wahaSend!, session);
      console.warn(`[worker] restarted WAHA session '${session}' (${reason})`);
      await logWahaRemediation(session, reason, 'restarted', null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[worker] WAHA session restart '${session}' failed:`, msg);
      await logWahaRemediation(session, reason, 'failed', msg);
    }
  });
}

/** Every restart is recorded — who, why, and whether it worked. Restarts were
 *  previously invisible outside a worker log line nobody watches. */
async function logWahaRemediation(session: string, reason: string, outcome: string, error: string | null): Promise<void> {
  const { error: logErr } = await supabase.from('activity_log').insert({
    category: 'whatsapp',
    event_type: 'session_remediation',
    target_label: `waha session: ${session}`,
    summary_ar: `إعادة تشغيل جلسة واتساب ${session} (${outcome})`,
    summary_en: `WhatsApp session ${session} remediation (${outcome})`,
    details: { session, reason, outcome, worker: env.WORKER_ID },
    status: outcome === 'restarted' ? 'success' : 'error',
    error,
  });
  if (logErr) console.error('[worker] remediation log failed:', logErr.message);
}

/**
 * Write the chat_messages row for a message this worker just delivered.
 *
 * Twin of api/_lib/whatsappSendAuth.ts#recordOutboundMessage — the worker is a
 * standalone package and cannot import from api/_lib (same posture as
 * worker/src/imageGen.ts). Change both together.
 *
 * The conversation id is READ from `records` rather than recomputed: the uuidv5
 * derivation lives in three places already and a fourth copy here would be a
 * fourth thing to drift.
 */
async function persistQueuedOutbound(
  job: ScheduledWhatsappJob,
  result: Record<string, unknown>,
): Promise<void> {
  const ids = Array.isArray(result.ids) ? (result.ids as string[]) : [];
  if (ids.length === 0) return;

  const { data: conv } = await supabase
    .from('records')
    .select('id')
    .eq('data->>wid', job.chatWid)
    .maybeSingle();
  const conversationId = (conv as { id?: string } | null)?.id;
  if (!conversationId) {
    console.warn(`[worker] no conversation record for ${job.chatWid} — outbound row skipped`);
    return;
  }

  const digits = job.chatWid.split('@')[0] ?? '';
  const hasBody = Boolean(job.body && job.body.trim());
  const rows = ids.map((id, i) => ({
    id,
    chat_wid: job.chatWid,
    conversation_record_id: conversationId,
    device_id: job.deviceId,
    flow: 'out' as const,
    // A row carries the text only when it IS the text part: runScheduledWhatsappJob
    // sends the body first, then each media item.
    kind: hasBody && i === 0 ? 'text' : 'document',
    body: hasBody && i === 0 ? job.body : null,
    from_phone: null,
    to_phone: `+${digits}`,
    ack: 'sent',
    date: new Date().toISOString(),
    reference: job.reference,
    // An `ai:` reference is written by /api/whatsapp/ai-send; anything else
    // reaching this queue is a scheduled or fanned-out send (WA-24).
    send_source: job.reference?.startsWith('ai:') ? 'ai' : 'media_batch',
  }));

  const { error } = await supabase.from('chat_messages').upsert(rows, { onConflict: 'id', ignoreDuplicates: false });
  if (error) {
    // Loud but never fatal — the customer already has the message, and failing
    // the job here would mark a delivered send as failed.
    console.error('[worker] could not persist queued outbound rows:', error.message);
  }
}

/**
 * Make a permanently-failed queued send VISIBLE (WA-13).
 *
 * A terminal failure used to update a row in scheduled_whatsapp_jobs and stop
 * there: no toast, no task, no alert. 37 messages died that way and were found
 * only by reading the table — including AI replies, where the agent had already
 * recorded "sent" in its own transcript. Both the customer and the CRM believed
 * contact had been made.
 *
 * The thread is where a rep will actually see it, so the failure is written as
 * a failed message bubble in the conversation it belongs to, carrying the
 * reason. A synthetic `failed:<job>` id keeps it distinct from any real message
 * and out of the hash-dedupe (messageIdHash returns null for it).
 */
async function surfaceTerminalSendFailure(job: ScheduledWhatsappJob, reason: string): Promise<void> {
  const { data: conv } = await supabase
    .from('records').select('id').eq('data->>wid', job.chatWid).maybeSingle();
  const conversationId = (conv as { id?: string } | null)?.id;
  const digits = job.chatWid.split('@')[0] ?? '';

  if (conversationId) {
    const { error } = await supabase.from('chat_messages').upsert({
      id: `failed:${job.id}`,
      chat_wid: job.chatWid,
      conversation_record_id: conversationId,
      device_id: job.deviceId,
      flow: 'out',
      kind: 'text',
      body: job.body ?? '[media]',
      from_phone: null,
      to_phone: `+${digits}`,
      ack: 'failed',
      date: new Date().toISOString(),
      reference: job.reference,
    }, { onConflict: 'id', ignoreDuplicates: false });
    if (error) console.error('[worker] could not surface failed send in the thread:', error.message);
  } else {
    console.warn(`[worker] no conversation record for ${job.chatWid} — failed send not surfaced in a thread`);
  }

  const { error: logErr } = await supabase.from('activity_log').insert({
    category: 'whatsapp',
    event_type: 'send_failed',
    target_record_id: conversationId ?? null,
    target_label: `whatsapp send failed: +${digits.slice(0, 4)}${'•'.repeat(Math.max(0, digits.length - 6))}${digits.slice(-2)}`,
    summary_ar: 'فشل إرسال رسالة واتساب نهائياً',
    summary_en: 'WhatsApp message permanently failed to send',
    details: { job_id: job.id, reason, attempts: job.attempts, device_id: job.deviceId, conversation_id: conversationId ?? null },
    status: 'error',
    error: reason,
  });
  if (logErr) console.error('[worker] failed-send log failed:', logErr.message);
}

async function claimAndRunOneScheduledWhatsapp(): Promise<boolean> {
  if (!wahaSend) return false;
  const { data, error } = await supabase.rpc('scheduled_whatsapp_claim_due', {
    p_worker_id: env.WORKER_ID,
    p_limit: 5,
  });
  if (error) {
    console.error(`[worker] scheduled-wa claim failed: ${error.message}`);
    return false;
  }
  const rows = (data ?? []) as ScheduledWaRow[];
  if (rows.length === 0) return false;

  for (const r of rows) {
    const job: ScheduledWhatsappJob = {
      id: r.job_id,
      deviceId: r.device_id,
      chatWid: r.chat_wid,
      phone: r.phone,
      body: r.body,
      media: Array.isArray(r.media) ? (r.media as ScheduledWhatsappJob['media']) : [],
      reference: r.reference,
      attempts: r.attempts,
    };
    console.log(`[worker] sending scheduled WhatsApp job=${job.id} chat=${job.chatWid} attempts=${job.attempts}`);
    try {
      const result = await runScheduledWhatsappJob(wahaSend, job);
      const { error: doneErr } = await supabase.rpc('scheduled_whatsapp_complete', { p_job_id: job.id, p_result: result });
      if (doneErr) console.error(`[worker] scheduled_whatsapp_complete failed: ${doneErr.message}`);

      // WA-04 (queued half) — persist the outbound message HERE too.
      //
      // The API endpoint writes its own row at send time, but every QUEUED send
      // goes out from this worker instead: AI replies, scheduled messages, the
      // media fan-out. Those were still relying on WhatsApp echoing our send
      // back through the inbound webhook, so a lost echo meant the customer had
      // the message and the CRM did not — and that is worst precisely here,
      // where the AI is answering with nobody watching.
      //
      // Keyed by the id WAHA returned, which is the id the echo carries, so the
      // webhook upsert merges onto this row instead of adding a second bubble.
      await persistQueuedOutbound(job, result);

      // WA-10 — give the AI audit row the REAL message id.
      //
      // /api/whatsapp/ai-send writes whatsapp_ai_replies keyed `sched:<job>`
      // because the true id does not exist until we send. Nothing ever went
      // back to fix it, so whatsapp_ai_should_reply's `message_wid = m.id`
      // branch could never match and it fell through to "same body within 600
      // seconds". Any queue delay past ten minutes — a requeue, a 463 retry,
      // a backlog — then reclassified the agent's OWN message as a human
      // reply, tripping `human_active` and silencing the AI in that chat for
      // human_quiet_hours. Already happened once: audit at 07:20:47, echo at
      // 07:38:12, 17.5 minutes apart.
      const realWid = Array.isArray((result as { ids?: unknown }).ids)
        ? ((result as { ids: unknown[] }).ids[0] as string | undefined)
        : undefined;
      if (realWid) {
        const { error: aiErr } = await supabase
          .from('whatsapp_ai_replies')
          .update({ message_wid: realWid })
          .eq('message_wid', `sched:${job.id}`);
        if (aiErr) console.error(`[worker] ai-reply wid reconcile failed: ${aiErr.message}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[worker] scheduled WhatsApp job=${job.id} FAILED (attempt ${job.attempts}):`, msg);

      // WhatsApp refused this RECIPIENT, not this request. Retrying deepens the
      // lock and restarting the session does nothing — so fail once, loudly,
      // with a reason a human can act on.
      if (isColdOutreachLock(msg)) {
        console.warn(`[worker] job=${job.id} hit the WhatsApp cold-outreach lock (463) — permanent for now, NOT retried`);
        const { error: failErr } = await supabase.rpc('scheduled_whatsapp_fail', {
          p_job_id: job.id,
          p_error: `cold_outreach_locked: WhatsApp is refusing first contact with this number (error 463). Message manually from the phone once, or wait for the customer to write first. Original: ${msg.slice(0, 300)}`,
        });
        if (failErr) console.error(`[worker] scheduled_whatsapp_fail failed: ${failErr.message}`);
        await surfaceTerminalSendFailure(job, 'WhatsApp is refusing first contact with this number (error 463)');
        continue;
      }

      if (isTransientWahaSendError(msg) && job.attempts < SCHEDULED_WA_MAX_ATTEMPTS) {
        await maybeRestartWahaSessionAfterSendFailure(job.deviceId, `5xx send failure on job ${job.id}`);
        const delayS = 120 * job.attempts; // 2 min, then 4 min
        const { error: rqErr } = await supabase.rpc('scheduled_whatsapp_requeue', { p_job_id: job.id, p_error: msg, p_delay_s: delayS });
        if (!rqErr) {
          console.warn(`[worker] scheduled WhatsApp job=${job.id} requeued (+${delayS}s)`);
          continue;
        }
        // Requeue RPC missing/failed → fall through to a loud permanent fail.
        console.error(`[worker] scheduled_whatsapp_requeue failed: ${rqErr.message}`);
      }
      const { error: failErr } = await supabase.rpc('scheduled_whatsapp_fail', { p_job_id: job.id, p_error: msg });
      if (failErr) console.error(`[worker] scheduled_whatsapp_fail failed: ${failErr.message}`);
      await surfaceTerminalSendFailure(job, msg.slice(0, 300));
    }
  }
  return true;
}

async function runScheduledWhatsappWatchdog(): Promise<void> {
  try {
    const { data, error } = await supabase.rpc('scheduled_whatsapp_watchdog');
    if (error) { console.error(`[worker] scheduled-wa watchdog RPC error: ${error.message}`); return; }
    const swept = typeof data === 'number' ? data : 0;
    if (swept > 0) console.warn(`[worker] scheduled-wa watchdog swept ${swept} stuck send(s)`);
  } catch (err) {
    console.error('[worker] scheduled-wa watchdog threw:', err);
  }
}

/**
 * WAHA session (zombie) watchdog — the gateway has no built-in liveness probe
 * (eval §5, WAHA issue #1931/#2151). v1 recovers the RELIABLE failure modes:
 * a session that is NOT 'WORKING' (FAILED / STOPPED / logged-out) is restarted
 * via the API (restart recovers in ~10s without re-scan, proven in the POC). A
 * dead-but-'WORKING' session is only LOGGED (with its activity age) — auto-
 * restarting a healthy-but-quiet session would needlessly drop it, so
 * activity-age restart is deliberately NOT automated in v1.
 */
async function runWahaSessionWatchdog(): Promise<void> {
  if (!wahaSend || wahaWatchdogBusy) return;
  wahaWatchdogBusy = true;
  try {
    const { data, error } = await supabase
      .from('whatsapp_numbers')
      .select('device_id, session_name')
      .eq('provider', 'waha')
      .eq('is_active', true);
    if (error) { console.error(`[worker] waha watchdog list failed: ${error.message}`); return; }
    const sessions = (data ?? []).map((r) => (r.session_name as string | null) ?? (r.device_id as string));
    for (const session of sessions) {
      if (!session) continue;
      try {
        const st = await getSessionStatus(wahaSend, session);
        if (st.status !== 'WORKING') {
          // Behind the same fleet-wide lock as the send-failure path: all five
          // machines run this watchdog on the same interval and would otherwise
          // observe one flap and issue five restarts.
          console.warn(`[worker] waha session '${session}' status=${st.status}`);
          await maybeRestartWahaSessionAfterSendFailure(session, `watchdog saw status=${st.status}`);
        } else if (st.activityTs) {
          const ageMin = Math.round((Date.now() - st.activityTs) / 60000);
          if (ageMin > 30) console.warn(`[worker] waha session '${session}' WORKING but last activity ${ageMin}m ago (watch for zombie)`);
        }
      } catch (e) {
        console.error(`[worker] waha watchdog probe '${session}' failed:`, (e as Error).message);
      }
    }
  } finally {
    wahaWatchdogBusy = false;
  }
}

async function scheduledWhatsappPollLoop(): Promise<void> {
  let lastWatchdog = 0;
  while (!shuttingDown) {
    scheduledWaBusy = true;
    let didClaim = false;
    try {
      didClaim = await claimAndRunOneScheduledWhatsapp();
    } catch (err) {
      console.error('[worker] scheduled-wa poll iteration error:', err);
    }
    scheduledWaBusy = false;

    if (Date.now() - lastWatchdog > env.WATCHDOG_INTERVAL_MS) {
      lastWatchdog = Date.now();
      await runScheduledWhatsappWatchdog();
      await runWahaSessionWatchdog();
    }

    if (didClaim || scheduledWaWakeRequested) {
      scheduledWaWakeRequested = false;
      continue;
    }
    const wokeAt = Date.now();
    while (Date.now() - wokeAt < env.POLL_INTERVAL_MS && !scheduledWaWakeRequested && !shuttingDown) {
      await sleep(200);
    }
  }
}

// Drain the queues concurrently for the lifetime of the process.
let loops: Array<Promise<void>>;
if (env.WORKFLOW_PROOF_ONLY) {
  // LOCAL PROOF MODE ONLY — register ONLY the workflow loop so a local run
  // against a preview endpoint can't claim/process live deck/image/document/
  // migration jobs from the shared prod DB. MUST NOT be set on the prod Fly
  // worker. Default behavior (all loops) is unchanged when the flag is absent.
  console.warn('[worker] ⚠️ WORKFLOW_PROOF_ONLY=1 — registering ONLY the workflow loop (local proof; never set this in prod)');
  loops = [workflowPollLoop()];
} else {
  loops = [
    pollLoop(),
    imagePollLoop(),
    cleanTextPollLoop(),
    videoConvertPollLoop(),
    previewPollLoop(),
    compressPollLoop(),
    documentPollLoop(),
    migrationPollLoop(),
    conflictWatchdogLoop(),
    marketingOpsPollLoop(), // always-on: ops monitoring runs even when collection is disabled
  ];
  // Scheduled-reports loop only runs when the shared secret is set (feature on).
  if (env.REPORTS_RUNNER_SECRET) {
    console.log('[worker] scheduled-reports loop enabled');
    loops.push(reportsPollLoop());
  } else {
    console.log('[worker] scheduled-reports loop disabled (REPORTS_RUNNER_SECRET unset)');
  }
  // Workflow runner loop — self-disabled (inert) until WORKFLOW_RUNNER_SECRET is
  // set on the Fly worker (matching the Vercel prod env). Deploying this code is
  // a no-op for the queue until the secret exists.
  if (env.WORKFLOW_RUNNER_SECRET) {
    console.log('[worker] workflow runner loop enabled');
    loops.push(workflowPollLoop());
  } else {
    console.log('[worker] workflow runner loop disabled (WORKFLOW_RUNNER_SECRET unset)');
  }
  // REGA advertiser-phone lookup loop — only when Browserbase creds are set
  // (deploying this code is a no-op for the queue until both secrets exist).
  if (env.BROWSERBASE_API_KEY && env.BROWSERBASE_PROJECT_ID) {
    console.log('[worker] rega lookup loop enabled');
    loops.push(regaPollLoop());
  } else {
    console.log('[worker] rega lookup loop disabled (BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID unset)');
  }
  // Scheduled-WhatsApp + WAHA-session-watchdog loop — only when the WAHA gateway
  // is configured (deploying this code is a no-op for the queue until both
  // WAHA_URL + WAHA_API_KEY exist, i.e. after a number is moved to WAHA).
  if (wahaSend) {
    console.log('[worker] scheduled-WhatsApp (WAHA) loop enabled');
    loops.push(scheduledWhatsappPollLoop());
  } else {
    console.log('[worker] scheduled-WhatsApp (WAHA) loop disabled (WAHA_URL / WAHA_API_KEY unset)');
  }
  // Marketing collection loop — gated on MARKETING_COLLECTION_ENABLED. Even when
  // on, the DB global pause (mkt_settings.collection_paused) + per-account enable
  // keep it inert until a pilot account is explicitly turned on.
  if (env.MARKETING_COLLECTION_ENABLED) {
    console.log('[worker] marketing collection loop enabled (DB pause/enable still gate actual runs)');
    loops.push(marketingPollLoop());
  } else {
    console.log('[worker] marketing collection loop disabled (MARKETING_COLLECTION_ENABLED != 1)');
  }
}
Promise.all(loops).catch((err) => {
  console.error('[worker] poll loop crashed:', err);
  process.exit(1);
});
