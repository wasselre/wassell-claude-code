/**
 * Meta-ad lane — drains `generation_jobs` kind='meta-ad' (the ads the manager's
 * approval hands to the automation; see runMetaAdJob.ts).
 *
 * Self-disables (logged once, sleeps 60 s) while the worker has no Meta
 * credentials, so a machine without META_SYSTEM_USER_TOKEN never claims a job
 * it cannot finish — the job stays queued for one that can.
 *
 * Claim / complete / fail mirror the creative-image lane. A thrown job error
 * first records the failure on the ad row + notifies the manager
 * (failMetaAdJob), THEN marks the queue row failed — so the UI never shows a
 * silently stuck «جارٍ إنشاء الإعلان».
 */
import type { LaneDeps, LaneLoop } from '../creative/lanes/types.js';
import { loadMetaConfig } from './metaMarketingApi.js';
import { failMetaAdJob, runMetaAdJob, type MetaAdJob } from '../runMetaAdJob.js';

const POLL_MS = 4_000;
const NO_CREDS_SLEEP_MS = 60_000;

export async function claimAndRunOneMetaAd(deps: LaneDeps): Promise<boolean> {
  const { supabase: sb, workerId, log } = deps;
  const { data, error } = await sb.rpc('generation_job_claim_next', {
    p_worker_id: workerId,
    p_kind: 'meta-ad',
  });
  if (error) {
    console.error(`[metaAdLane] claim failed: ${error.message}`);
    return false;
  }
  const rows = (data ?? []) as Array<{
    job_id: string; record_id: string; user_id: string; params: Record<string, unknown>; attempts: number;
  }>;
  if (rows.length === 0) return false;
  const row = rows[0]!;
  const job: MetaAdJob = {
    id: row.job_id,
    recordId: row.record_id,
    userId: row.user_id,
    params: row.params ?? {},
    attempts: row.attempts,
  };
  log(`claimed meta-ad job=${job.id} content=${job.recordId} ad_row=${String(job.params.ad_row_id ?? '-')} attempts=${job.attempts}`);

  try {
    const result = await runMetaAdJob({
      supabase: sb, env: deps.env, job,
      log: (msg, extra) => log(`[meta-ad ${job.id.slice(0, 8)}] ${msg}`, extra),
    });
    const { error: doneErr } = await sb.rpc('generation_job_complete', {
      p_job_id: job.id,
      p_result: result as unknown as Record<string, unknown>,
    });
    if (doneErr) console.error(`[metaAdLane] generation_job_complete RPC failed: ${doneErr.message}`);
    else log(`completed meta-ad job=${job.id} ad=${result.platform_ad_id}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[metaAdLane] meta-ad job=${job.id} FAILED:`, msg);
    if (err instanceof Error && err.stack) console.error(err.stack);
    try {
      await failMetaAdJob(sb, job, msg);
    } catch (inner) {
      console.error(`[metaAdLane] could not record the failure on the ad row: ${(inner as Error).message}`);
    }
    try {
      const { error: failErr } = await sb.rpc('generation_job_fail', { p_job_id: job.id, p_error: msg });
      if (failErr) console.error(`[metaAdLane] generation_job_fail RPC failed: ${failErr.message}`);
    } catch (inner) {
      console.error(`[metaAdLane] could not mark meta-ad job failed: ${(inner as Error).message}`);
    }
  }
  return true;
}

export const metaAdLoop: LaneLoop = async (deps) => {
  const { sleep, isShuttingDown } = deps;
  let warnedNoCreds = false;
  for (;;) {
    if (isShuttingDown()) return;
    let sleepMs = POLL_MS;
    try {
      if (!loadMetaConfig()) {
        if (!warnedNoCreds) {
          console.error('[metaAdLane] Meta credentials missing (META_SYSTEM_USER_TOKEN / META_AD_ACCOUNT_ID) — lane idle');
          warnedNoCreds = true;
        }
        sleepMs = NO_CREDS_SLEEP_MS;
      } else {
        const claimed = await claimAndRunOneMetaAd(deps);
        if (claimed) sleepMs = 0;
      }
    } catch (e) {
      console.error('[metaAdLane] tick failed:', e instanceof Error ? e.message : e);
    }
    await sleep(sleepMs);
  }
};
