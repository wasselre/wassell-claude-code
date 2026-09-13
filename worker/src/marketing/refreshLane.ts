/**
 * Refresh-cycle lane — the weekly paid creative refresh (campaign planning,
 * 2026-09-13). A SWEEP lane, not a queue lane: its work is "which cycles are
 * due today", which is a query, so there is nothing to enqueue and nothing to
 * claim. It runs one `runRefreshCycleTick` (see `worker/src/runRefreshCycleJob.ts`)
 * every 60 s.
 *
 * Three self-disables, each logged ONCE and then quiet:
 *   • `mos_settings.planning.refresh_loop_enabled = false` — the operator's
 *     kill switch (the tick itself checks it, so flipping it back takes effect
 *     within one interval);
 *   • the planning tables are not in this database yet — the migration is a
 *     separate workstream, so the lane says so and sleeps 5 minutes instead of
 *     erroring every minute;
 *   • no Meta credentials — decisions still get ranked and written (they are
 *     pure database work); only the swap and the metrics pull are skipped.
 *
 * Several worker machines run this lane at once. That is safe because every
 * step is idempotent and status-guarded: the decision write only matches
 * `scheduled|producing|ready`, the swap only activates what is not already
 * ACTIVE, and the metrics pull is throttled by the table's own `synced_at`
 * watermark.
 */
import type { LaneDeps, LaneLoop } from '../creative/lanes/types.js';
import { MissingPlanningSchemaError, runRefreshCycleTick } from '../runRefreshCycleJob.js';

const POLL_MS = 60_000;
const NO_SCHEMA_SLEEP_MS = 5 * 60_000;

const OFF_REASON = 'planning.refresh_loop_enabled is off';
const MISSING_LOG_EVERY_MS = 10 * 60_000;
const missingLoggedAt = new Map<string, number>();

/** One sweep. Returns true when the operator's kill switch is off. */
export async function runRefreshCycleSweep(deps: LaneDeps): Promise<boolean> {
  const res = await runRefreshCycleTick({
    supabase: deps.supabase,
    log: (msg, extra) => deps.log(`[refresh] ${msg}`, extra),
  });
  // A sweep whose object is not migrated yet is a PARTIAL outage of the lane —
  // it keeps being reported (throttled to once every 10 minutes per sweep)
  // rather than logged once and forgotten, because a silent partial outage is
  // exactly what this repo has been burned by.
  const now = Date.now();
  for (const m of res.missing) {
    const label = m.split(':')[0] ?? m;
    if (now - (missingLoggedAt.get(label) ?? 0) < MISSING_LOG_EVERY_MS) continue;
    missingLoggedAt.set(label, now);
    console.error(`[refreshLane] sweep disabled — ${m}`);
  }
  return res.metrics?.reason === OFF_REASON;
}

export const refreshCycleLoop: LaneLoop = async (deps) => {
  const { sleep, isShuttingDown } = deps;
  let warnedNoSchema = false;
  let warnedOff = false;
  for (;;) {
    if (isShuttingDown()) return;
    let sleepMs = POLL_MS;
    try {
      const off = await runRefreshCycleSweep(deps);
      if (off && !warnedOff) {
        console.error(`[refreshLane] ${OFF_REASON} — lane idle (flip the setting to resume; it takes effect within a minute)`);
        warnedOff = true;
      }
      if (!off) warnedOff = false;
      warnedNoSchema = false;
    } catch (e) {
      if (e instanceof MissingPlanningSchemaError) {
        if (!warnedNoSchema) {
          console.error(`[refreshLane] the campaign-planning tables are not in this database yet (${e.message}) — lane idle until they are`);
          warnedNoSchema = true;
        }
        sleepMs = NO_SCHEMA_SLEEP_MS;
      } else {
        console.error('[refreshLane] tick failed:', e instanceof Error ? e.message : e);
        if (e instanceof Error && e.stack) console.error(e.stack);
      }
    }
    await sleep(sleepMs);
  }
};
