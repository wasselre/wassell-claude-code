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
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadEnv } from './env.js';
import { runCompressJob, type CompressJob } from './runCompressJob.js';
import { runDeckJob, type DeckJob } from './runDeckJob.js';
import { runDocumentJob, type DocumentJob } from './runDocumentJob.js';
import { runImageJob, type ImageJob } from './runImageJob.js';
import { runPreviewJob, type PreviewJob } from './runPreviewJob.js';

const env = loadEnv();

const supabase: SupabaseClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

let shuttingDown = false;
let busy = false;
let wakeRequested = false;
// Image Chats v2 runs on an INDEPENDENT loop with its own busy/wake flags so
// 30s-5min image turns never head-of-line-block behind 3-12min deck jobs (and
// vice-versa). Both loops share this one process + Supabase client.
let imageBusy = false;
let imageWakeRequested = false;
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
// HTTP server: /healthz for Fly health checks, /wake for API ping.
// ─────────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        busy,
        image_busy: imageBusy,
        preview_busy: previewBusy,
        compress_busy: compressBusy,
        document_busy: documentBusy,
        reports_busy: reportsBusy,
        reports_enabled: !!env.REPORTS_RUNNER_SECRET,
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
    previewWakeRequested = true;
    compressWakeRequested = true;
    documentWakeRequested = true;
    reportsWakeRequested = true;
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
  while ((busy || imageBusy || previewBusy || compressBusy || documentBusy || reportsBusy) && Date.now() < deadline) {
    await sleep(500);
  }
  console.log('[worker] exiting');
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Drain all four queues concurrently for the lifetime of the process, plus the
// conflict-storm watchdog (its own short-interval loop).
const loops = [
  pollLoop(),
  imagePollLoop(),
  previewPollLoop(),
  compressPollLoop(),
  documentPollLoop(),
  conflictWatchdogLoop(),
];
// Scheduled-reports loop only runs when the shared secret is set (feature on).
if (env.REPORTS_RUNNER_SECRET) {
  console.log('[worker] scheduled-reports loop enabled');
  loops.push(reportsPollLoop());
} else {
  console.log('[worker] scheduled-reports loop disabled (REPORTS_RUNNER_SECRET unset)');
}
Promise.all(loops).catch((err) => {
  console.error('[worker] poll loop crashed:', err);
  process.exit(1);
});
