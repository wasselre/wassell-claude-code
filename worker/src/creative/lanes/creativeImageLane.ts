/**
 * Creative-image lane (contracts §3) — drains `generation_jobs`
 * kind='creative-image' (the human-approved AI image executions).
 *
 * Flag: `mos_settings.creative_writer.ai_image_execution` — re-read EVERY
 * tick; sleeps 30 s while off so approved executions stay QUEUED (they run the
 * moment the flag flips on). The job itself re-checks the flag
 * (runCreativeImageJob) — a race between claim and flip still refuses loudly.
 *
 * Claim/complete/fail mirror `claimAndRunOneCleanText` against
 * `generation_job_claim_next(worker, 'creative-image')`. No watchdog here:
 * the image loop's `generation_jobs_watchdog()` already sweeps stale jobs of
 * ALL kinds, including creative-image — a swept job's package execution is
 * still patched by the job's own failure path when it lands late (the patch
 * RPC is unconditional on the package row, not the job row).
 */
import { makeCreativeImageIo, runCreativeImageJob, type CreativeImageJob } from '../runCreativeImageJob.js';
import type { LaneDeps, LaneLoop } from './types.js';

const FLAG_SLEEP_MS = 30_000;
const POLL_MS = 4_000;

/** Claim ONE queued creative-image job and run it to completion. Returns true when a job was claimed. */
export async function claimAndRunOneCreativeImage(deps: LaneDeps): Promise<boolean> {
  const { supabase: sb, workerId, log } = deps;
  const { data, error } = await sb.rpc('generation_job_claim_next', {
    p_worker_id: workerId,
    p_kind: 'creative-image',
  });
  if (error) {
    console.error(`[creativeImageLane] claim failed: ${error.message}`);
    return false;
  }
  const rows = (data ?? []) as Array<{
    job_id: string;
    record_id: string;
    user_id: string;
    params: Record<string, unknown>;
    attempts: number;
  }>;
  if (rows.length === 0) return false;
  const row = rows[0]!;
  const job: CreativeImageJob = {
    id: row.job_id,
    recordId: row.record_id,
    userId: row.user_id,
    params: row.params ?? {},
    attempts: row.attempts,
  };
  log(`claimed creative-image job=${job.id} package=${String(job.params.package_id ?? '-')} index=${String(job.params.index ?? '-')} attempts=${job.attempts}`);

  try {
    const result = await runCreativeImageJob({ supabase: sb, env: deps.env, job, log });
    // generation_job_complete only touches status='running' rows — a cancel or
    // watchdog sweep behind us makes this a harmless no-op.
    const { error: doneErr } = await sb.rpc('generation_job_complete', {
      p_job_id: job.id,
      p_result: result as unknown as Record<string, unknown>,
    });
    if (doneErr) {
      console.error(`[creativeImageLane] generation_job_complete RPC failed: ${doneErr.message}`);
    } else {
      log(`completed creative-image job=${job.id} file=${result.file_id}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[creativeImageLane] creative-image job=${job.id} FAILED:`, msg);
    if (err instanceof Error && err.stack) console.error(err.stack);
    try {
      const { error: failErr } = await sb.rpc('generation_job_fail', {
        p_job_id: job.id,
        p_error: msg,
      });
      if (failErr) {
        console.error(`[creativeImageLane] generation_job_fail RPC failed: ${failErr.message}`);
      }
    } catch (innerErr) {
      console.error(`[creativeImageLane] could not mark creative-image job failed: ${(innerErr as Error).message}`);
    }
  }
  return true;
}

export const creativeImageLoop: LaneLoop = async (deps) => {
  const { supabase: sb, sleep, isShuttingDown } = deps;
  const io = makeCreativeImageIo();
  for (;;) {
    if (isShuttingDown()) return;
    let sleepMs = POLL_MS;
    try {
      const enabled = await io.readAiExecutionEnabled(sb);
      if (!enabled) {
        sleepMs = FLAG_SLEEP_MS;
      } else {
        const claimed = await claimAndRunOneCreativeImage(deps);
        if (claimed) sleepMs = 0; // drain a backlog without waiting
      }
    } catch (e) {
      // A failed tick (flag read, claim RPC) must not kill the loop — loud, retried next tick.
      console.error('[creativeImageLane] tick failed:', e instanceof Error ? e.message : e);
    }
    await sleep(sleepMs);
  }
};
