import { hostname } from 'node:os';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadEnv, type WorkerEnv } from './env.ts';
import { createWorkerSupabase } from './supabase.ts';
import { startHeartbeat, type HeartbeatHandle } from './heartbeat.ts';
import { runJob } from './runner.ts';
import { WORKER_VERSION } from './version.ts';
import type { PresentationJobRow } from './types.ts';

/** Label written to `presentation_jobs.claimed_by` on every claim. The
 *  `cloud:` prefix distinguishes our rows from the legacy local daemon's
 *  rows so the boot-time stale-job sweep doesn't trash each other's work. */
function workerLabel(): string {
  return `cloud:${hostname()}:${process.pid}`;
}

async function sweepStaleRunningJobs(supabase: SupabaseClient, worker: string): Promise<number> {
  // On boot, any 'running' rows still claimed by THIS worker are leftovers
  // from a crash. Mark them failed; the user retries from the app. We never
  // auto-resume because Phase 0 has nothing to resume — Phase 3+ may revisit.
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('presentation_jobs')
    .update({
      status: 'failed',
      error_code: 'daemon_restarted',
      error_message: 'Cloud worker restarted while this job was running',
      finished_at: nowIso,
      updated_at: nowIso,
    })
    .eq('status', 'running')
    .eq('claimed_by', worker)
    .select('id');
  if (error) {
    console.error(`[sweep] failed: ${error.message}`);
    return 0;
  }
  return data?.length ?? 0;
}

async function claimNext(
  supabase: SupabaseClient,
  worker: string,
): Promise<PresentationJobRow | null> {
  const { data, error } = await supabase.rpc('claim_next_presentation_job', { p_worker: worker });
  if (error) {
    console.error(`[claim] rpc failed: ${error.message}`);
    return null;
  }
  if (!data || (Array.isArray(data) && data.length === 0)) return null;
  const row = Array.isArray(data) ? data[0] : data;
  return row as PresentationJobRow;
}

interface WorkerState {
  lastError: { message: string; at: string } | null;
  shuttingDown: boolean;
}

async function main(): Promise<void> {
  const env: WorkerEnv = loadEnv();
  const supabase = createWorkerSupabase(env);
  const worker = workerLabel();
  const state: WorkerState = { lastError: null, shuttingDown: false };

  console.log(`[cloud-worker] starting v${WORKER_VERSION} as ${worker}`);
  console.log(
    `[cloud-worker] poll=${env.pollIntervalMs}ms heartbeat=${env.heartbeatIntervalMs}ms timeout=${env.jobTimeoutSeconds}s`,
  );

  const swept = await sweepStaleRunningJobs(supabase, worker);
  if (swept > 0) {
    console.log(`[cloud-worker] swept ${swept} stale 'running' job(s) from a previous crash`);
  }

  const heartbeat: HeartbeatHandle = startHeartbeat({
    supabase,
    intervalMs: env.heartbeatIntervalMs,
    getLastError: () => state.lastError,
  });
  await heartbeat.beatNow();

  // Strict serialization: one job at a time. Phase 0 doesn't need this since
  // Anthropic API calls are happily parallel, but keeping it serial matches
  // the legacy daemon's contract (the picker UI assumes one in-flight run)
  // and lets Phase 3 plug in tools that can't be parallelized without code
  // changes.
  const loop = async (): Promise<void> => {
    while (!state.shuttingDown) {
      let job: PresentationJobRow | null = null;
      try {
        job = await claimNext(supabase, worker);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[loop] claim threw: ${msg}`);
        state.lastError = { message: msg, at: new Date().toISOString() };
      }

      if (!job) {
        await sleep(env.pollIntervalMs);
        continue;
      }

      try {
        await runJob(supabase, env, job);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[loop] runJob threw for ${job.id}: ${msg}`);
        state.lastError = { message: msg, at: new Date().toISOString() };
      }
    }
  };

  const shutdown = async (signal: string): Promise<void> => {
    if (state.shuttingDown) return;
    state.shuttingDown = true;
    console.log(`[cloud-worker] ${signal} received — shutting down`);
    try {
      await heartbeat.stop();
    } catch (err) {
      console.error(
        `[cloud-worker] heartbeat stop failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Final heartbeat with last_error set to a clean shutdown marker so the
    // app can tell a graceful exit from a crash.
    try {
      await supabase.from('daemon_status').upsert({
        id: 'presentations',
        last_heartbeat_at: new Date().toISOString(),
        hostname: `cloud:${hostname()}`,
        pid: process.pid,
        version: WORKER_VERSION,
        last_error: `shutdown (${signal})`,
        last_error_at: new Date().toISOString(),
      });
    } catch {
      // Going down anyway.
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await loop();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[cloud-worker] fatal: ${msg}`);
  process.exit(1);
});
