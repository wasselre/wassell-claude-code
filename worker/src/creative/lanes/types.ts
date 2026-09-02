/**
 * Lane contract for the Post Creative Director worker lanes (contracts §3).
 *
 * WRITTEN FIRST (owner A-WORKER): every creative lane loop takes ONE deps bag
 * and runs forever until the process shuts down. Peer lanes (A-VIS
 * designReadLane, A-ASSETS assetMetaLane) declared a structurally identical
 * local copy while this file did not exist; the shapes are identical by
 * contract, so their loops accept this deps bag without edits.
 *
 * Registration lives in worker/src/index.ts (`// ── creative director lanes ──`
 * region): the same deps object is shared by all four loops
 * (creativeJobsLoop, creativeImageLoop, designReadLoop, assetMetaLoop).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from '../../env.js';

export interface LaneDeps {
  /** Service-role client (bypasses RLS; the queues/tables have no policies). */
  supabase: SupabaseClient;
  env: WorkerEnv;
  /** env.WORKER_ID — stamped on claimed jobs. */
  workerId: string;
  /** Interruptible-ish sleep (the loops re-check isShuttingDown after it). */
  sleep(ms: number): Promise<void>;
  /** true once the process is draining — loops return at the next checkpoint. */
  isShuttingDown(): boolean;
  /** Lane progress line (console.log under the hood). */
  log(msg: string, extra?: unknown): void;
}

/** Each lane module exports `export const <name>Loop: LaneLoop`. */
export type LaneLoop = (deps: LaneDeps) => Promise<void>;
