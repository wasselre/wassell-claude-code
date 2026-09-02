/**
 * Creative-jobs lane (contracts §3) — drains `mos_creative_jobs` for the Post
 * Creative Director.
 *
 * Flag: `mos_settings.creative_writer.post_enabled` — re-read EVERY tick;
 * sleeps 30 s while off (contracts §0.14: rollback = flip the flag; shipping
 * the lane with the flag off is a no-op).
 *
 * Poll shape mirrors `scriptPollLoop` (4 s): claim via
 * `mos_creative_job_claim_next` (FOR UPDATE SKIP LOCKED), run
 * `runCreativeJob`, complete with {package_id, needs_attention, validation} +
 * the roles ledger + cost; on failure classify the error
 * (`classifyCreativeError`) and fail with the stable error_kind — the RPC
 * requeues only 'provider'/'transient' while attempts < max_attempts.
 * `mos_creative_jobs_watchdog()` runs every ~5 min (lease-expired running jobs
 * → failed 'watchdog').
 */
import { loadCreativeFlags, type CreativeJobLike } from '../io.js';
import { classifyCreativeError, runCreativeJob } from '../runCreativeJob.js';
import type { LaneDeps, LaneLoop } from './types.js';

const FLAG_SLEEP_MS = 30_000;
const POLL_MS = 4_000;
const WATCHDOG_INTERVAL_MS = 5 * 60_000;

/** Claim ONE queued creative job and run it to completion. Returns true when a job was claimed. */
export async function claimAndRunOneCreativeJob(deps: LaneDeps): Promise<boolean> {
  const { supabase: sb, workerId, log } = deps;
  const { data, error } = await sb.rpc('mos_creative_job_claim_next', { p_worker_id: workerId });
  if (error) {
    console.error(`[creativeJobsLane] claim failed: ${error.message}`);
    return false;
  }
  const rows = (data ?? []) as Array<{
    job_id: string;
    content_id: string;
    kind: CreativeJobLike['kind'];
    params: Record<string, unknown>;
    requested_by: string | null;
    attempts: number;
  }>;
  if (rows.length === 0) return false;
  const row = rows[0]!;
  const job: CreativeJobLike = {
    id: row.job_id,
    content_id: row.content_id,
    kind: row.kind,
    params: row.params ?? {},
    requested_by: row.requested_by ?? null,
    attempts: row.attempts,
  };
  log(`claimed creative job=${job.id} kind=${job.kind} content=${job.content_id} attempts=${job.attempts}`);

  try {
    const outcome = await runCreativeJob({ supabase: sb, env: deps.env, job, log });
    // complete only touches a 'running' row — a cancel/watchdog sweep behind us
    // makes this a harmless no-op (same guard as every other queue).
    const { error: doneErr } = await sb.rpc('mos_creative_job_complete', {
      p_job_id: job.id,
      p_result: outcome.result,
      p_roles: outcome.roles,
      p_cost_usd: outcome.cost_usd,
    });
    if (doneErr) {
      console.error(`[creativeJobsLane] mos_creative_job_complete RPC failed: ${doneErr.message}`);
    } else {
      log(`completed creative job=${job.id} package=${String(outcome.result.package_id ?? '-')} needs_attention=${String(outcome.result.needs_attention ?? false)}`);
    }
  } catch (err) {
    const { message, kind } = classifyCreativeError(err);
    console.error(`[creativeJobsLane] creative job=${job.id} FAILED (${kind}):`, message);
    if (err instanceof Error && err.stack) console.error(err.stack);
    try {
      const { error: failErr } = await sb.rpc('mos_creative_job_fail', {
        p_job_id: job.id,
        p_error: message,
        p_error_kind: kind,
      });
      if (failErr) {
        console.error(`[creativeJobsLane] mos_creative_job_fail RPC failed: ${failErr.message}`);
      }
    } catch (innerErr) {
      console.error(`[creativeJobsLane] could not mark creative job failed: ${(innerErr as Error).message}`);
    }
  }
  return true;
}

async function runCreativeWatchdog(deps: LaneDeps): Promise<void> {
  try {
    const { data, error } = await deps.supabase.rpc('mos_creative_jobs_watchdog');
    if (error) {
      console.error(`[creativeJobsLane] watchdog RPC error: ${error.message}`);
      return;
    }
    const swept = typeof data === 'number' ? data : 0;
    if (swept > 0) deps.log(`creative watchdog swept ${swept} stale job(s)`);
  } catch (err) {
    console.error('[creativeJobsLane] watchdog threw:', err);
  }
}

export const creativeJobsLoop: LaneLoop = async (deps) => {
  const { supabase: sb, sleep, isShuttingDown } = deps;
  let lastWatchdog = 0;
  for (;;) {
    if (isShuttingDown()) return;
    let sleepMs = POLL_MS;
    try {
      const flags = await loadCreativeFlags(sb);
      if (!flags.post_enabled) {
        sleepMs = FLAG_SLEEP_MS;
      } else {
        const claimed = await claimAndRunOneCreativeJob(deps);
        if (claimed) sleepMs = 0; // drain a backlog without waiting
        if (Date.now() - lastWatchdog > WATCHDOG_INTERVAL_MS) {
          lastWatchdog = Date.now();
          await runCreativeWatchdog(deps);
        }
      }
    } catch (e) {
      // A failed tick (flags read, claim RPC) must not kill the loop — loud, retried next tick.
      console.error('[creativeJobsLane] tick failed:', e instanceof Error ? e.message : e);
    }
    await sleep(sleepMs);
  }
};
