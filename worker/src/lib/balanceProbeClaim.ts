import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Single-runner claim for the hourly browser balance-probe tick (2026-09-16).
 *
 * The Fly app runs FIVE general machines, and this tick is TIMED, not a queue
 * poll — without a claim, all five would open Browserbase sessions and write
 * duplicate probe rows every hour. `ai_balance_probe_try_claim` makes the
 * Postgres PRIMARY KEY on the hour bucket the mutex: exactly one machine wins
 * each hour, no matter how many wake in the same instant.
 *
 * Failing to claim must NEVER mean "probe anyway" — that reintroduces the
 * stampede. Every non-win path (loser, rpc error) returns false.
 *
 * Returns true only when this machine won the hour and may run the probe.
 */
export async function tryClaimBalanceProbeHour(
  supabase: SupabaseClient,
  workerId: string,
): Promise<boolean> {
  const { data: won, error } = await supabase.rpc('ai_balance_probe_try_claim', {
    p_worker: workerId,
  });

  if (error) {
    // Loud, but do NOT probe: an unknown claim state is a lost claim.
    console.error('[worker] balance probe claim failed — skipping this hour:', error);
    return false;
  }

  if (won !== true) {
    // Another machine has this hour. console.log at most — four machines
    // logging a skip every hour is noise, never warn.
    console.log('[worker] balance probe: another machine claimed this hour — skipping');
    return false;
  }

  return true;
}
