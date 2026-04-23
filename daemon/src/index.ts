import { hostname } from 'node:os';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadEnv, type DaemonEnv } from './env.ts';
import { createDaemonSupabase } from './supabase.ts';
import { syncTemplateManifests, watchTemplates } from './templates.ts';
import { startHeartbeat, type HeartbeatHandle } from './heartbeat.ts';
import { runJob } from './runner.ts';
import { installFileLogger } from './logger.ts';
import { DAEMON_VERSION } from './version.ts';
import type { PresentationJob } from './types.ts';

/** Label written to `presentation_jobs.claimed_by` on every claim. Used for
 *  the crash-recovery sweep on boot — only our own stale rows are swept so a
 *  second daemon running somewhere else is left alone. */
function workerLabel(): string {
  return `${hostname()}:${process.pid}`;
}

/** On startup, look for jobs still marked `running` by this host+pid combo
 *  (we can't have crashed any other worker's row). Mark them `failed` with
 *  error_code='daemon_restarted'. The user retries from the app; we never
 *  auto-resume because `/wassel` creates Drive folders and a mid-run crash
 *  is not idempotent. */
async function sweepStaleRunningJobs(supabase: SupabaseClient, worker: string): Promise<number> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('presentation_jobs')
    .update({
      status: 'failed',
      error_code: 'daemon_restarted',
      error_message: 'Daemon restarted while this job was running',
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

async function claimNext(supabase: SupabaseClient, worker: string): Promise<PresentationJob | null> {
  const { data, error } = await supabase.rpc('claim_next_presentation_job', { p_worker: worker });
  if (error) {
    console.error(`[claim] rpc failed: ${error.message}`);
    return null;
  }
  if (!data || (Array.isArray(data) && data.length === 0)) return null;
  const row = Array.isArray(data) ? data[0] : data;
  return row as PresentationJob;
}

interface DaemonState {
  lastError: { message: string; at: string } | null;
  shuttingDown: boolean;
}

async function main(): Promise<void> {
  const env: DaemonEnv = loadEnv();
  // Install file logger FIRST so every later log line (including template-sync
  // errors) lands in the file too.
  installFileLogger(env.logDir);

  const supabase = createDaemonSupabase(env);
  const worker = workerLabel();
  const state: DaemonState = { lastError: null, shuttingDown: false };

  console.log(`[daemon] starting v${DAEMON_VERSION} as ${worker}`);
  console.log(`[daemon] templates dir: ${env.templatesDir}`);
  console.log(`[daemon] poll=${env.pollIntervalMs}ms heartbeat=${env.heartbeatIntervalMs}ms timeout=${env.jobTimeoutSeconds}s`);

  const swept = await sweepStaleRunningJobs(supabase, worker);
  if (swept > 0) {
    console.log(`[daemon] swept ${swept} stale 'running' job(s) from a previous crash`);
  }

  const initialSync = await syncTemplateManifests(supabase, env);
  console.log(
    `[daemon] initial template sync: synced=${initialSync.synced.length} invalid=${initialSync.invalid.length} disabled=${initialSync.disabled.length}`,
  );
  if (initialSync.invalid.length > 0) {
    state.lastError = {
      message: `${initialSync.invalid.length} template manifest(s) failed to sync — see daemon log`,
      at: new Date().toISOString(),
    };
  }

  const stopWatch = watchTemplates(supabase, env, () => {
    // Intentional no-op — the sync already logs. Surface could drive a UI
    // "templates changed" indicator later.
  });

  const heartbeat: HeartbeatHandle = startHeartbeat({
    supabase,
    intervalMs: env.heartbeatIntervalMs,
    getLastError: () => state.lastError,
  });
  await heartbeat.beatNow();

  // Main job-processing loop. Strict serialization: one job at a time (the
  // Paseetah research step drives a real Chrome window; concurrent runs
  // would thrash it). If a tick finds no job it sleeps for POLL_INTERVAL_MS
  // before checking again.
  const loop = async (): Promise<void> => {
    while (!state.shuttingDown) {
      let job: PresentationJob | null = null;
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
        const result = await runJob(supabase, env, job);
        if (result.terminalStatus === 'failed' && result.errorCode) {
          state.lastError = {
            message: `job ${job.id} failed: ${result.errorCode}`,
            at: new Date().toISOString(),
          };
        }
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
    console.log(`[daemon] ${signal} received — shutting down`);
    try {
      await stopWatch();
    } catch (err) {
      console.error(`[daemon] watcher stop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await heartbeat.stop();
    } catch (err) {
      console.error(`[daemon] heartbeat stop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Final heartbeat with last_error set to a clean shutdown marker.
    try {
      await supabase.from('daemon_status').upsert({
        id: 'presentations',
        last_heartbeat_at: new Date().toISOString(),
        hostname: hostname(),
        pid: process.pid,
        version: DAEMON_VERSION,
        last_error: `shutdown (${signal})`,
        last_error_at: new Date().toISOString(),
      });
    } catch {
      // ignore — we're going down anyway
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
  console.error(`[daemon] fatal: ${msg}`);
  process.exit(1);
});
