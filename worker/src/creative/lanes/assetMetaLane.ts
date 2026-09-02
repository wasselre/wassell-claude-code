/**
 * Asset-meta lane (worker sweep, no queue) — Post Creative Director.
 *
 * Each tick, gated by DATA flags (contracts §1):
 *   1. DETERMINISTIC META pass — `creative_backfill.asset_meta.enabled`:
 *      pulls `creative_asset_backfill_targets('meta', batch_size)` (project-
 *      linked images missing dims/palette), downloads each from its storage
 *      bucket with the service client, computes width/height/aspect/palette
 *      (assetMeta/deterministic.ts) and writes them with visual_meta_version
 *      'det-v1'. One bad file NEVER fails the lane — it is logged and skipped.
 *   2. ENRICH V2 batch — `creative_backfill.asset_enrich.enabled` AND
 *      `creative_writer.asset_enrich_v2`: delegated to A-VIS's shared backfill
 *      controller `runBackfillBatch('asset_enrich', …)`, which owns the
 *      `approved_cost_usd` gate and the creative_backfill_runs bookkeeping.
 *
 * PEER-MODULE POSTURE (per briefs/_COMMON.md): worker/src/creative/lanes/
 * types.ts (A-WORKER) and worker/src/creative/backfill.ts (A-VIS) may not
 * exist yet. The LaneDeps interface is therefore DECLARED LOCALLY here
 * (structurally identical to the contract, contracts §3) and runBackfillBatch
 * is resolved by lazy dynamic import — when the peer lands it is picked up
 * with no code change; before then the enrich step logs and skips.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { WorkerEnv } from '../../env.js';
import { applyDeterministicMeta, computeDeterministicMeta } from '../assetMeta/deterministic.js';

// ── Local mirror of A-WORKER's lanes/types.ts (contracts §3) ────────────────
// Replace with `import type { LaneDeps, LaneLoop } from './types.js'` once the
// peer file lands — the shapes are identical by contract.
export interface LaneDeps {
  supabase: SupabaseClient;
  env: WorkerEnv;
  workerId: string;
  sleep(ms: number): Promise<void>;
  isShuttingDown(): boolean;
  log(msg: string, extra?: unknown): void;
}
export type LaneLoop = (deps: LaneDeps) => Promise<void>;

/** Assumed signature of A-VIS's shared backfill controller (brief: "v2
 *  enrichment via runBackfillBatch('asset_enrich', …) gated by
 *  approved_cost_usd"). If A-VIS ships a different shape, ONLY this type and
 *  the call below change. */
export interface BackfillBatchResult {
  processed: number;
  failed: number;
  cost_usd: number | null;
}
export type RunBackfillBatchFn = (
  kind: 'asset_enrich',
  deps: LaneDeps,
  opts: { batchSize: number },
) => Promise<BackfillBatchResult>;

// ── Settings ────────────────────────────────────────────────────────────────

export interface AssetMetaFlags {
  metaEnabled: boolean;
  metaBatchSize: number;
  enrichEnabled: boolean;
  enrichBatchSize: number;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Read the two settings rows and resolve the lane's flags. Unreadable settings
 * throw (loud) — a lane that cannot read its flags must not guess them.
 */
export async function readAssetMetaFlags(
  sb: Pick<SupabaseClient, 'from'>,
): Promise<AssetMetaFlags> {
  const [cwRes, cbRes] = await Promise.all([
    sb.from('mos_settings').select('value').eq('key', 'creative_writer').maybeSingle(),
    sb.from('mos_settings').select('value').eq('key', 'creative_backfill').maybeSingle(),
  ]);
  if (cwRes.error) throw new Error(`mos_settings.creative_writer read failed: ${cwRes.error.message}`);
  if (cbRes.error) throw new Error(`mos_settings.creative_backfill read failed: ${cbRes.error.message}`);

  const cw = asRecord((cwRes.data as { value?: unknown } | null)?.value);
  const cb = asRecord((cbRes.data as { value?: unknown } | null)?.value);
  const meta = asRecord(cb.asset_meta);
  const enrich = asRecord(cb.asset_enrich);
  const batch = (v: unknown, dflt: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : dflt;

  return {
    metaEnabled: meta.enabled === true,
    metaBatchSize: batch(meta.batch_size, 25),
    // The v2 pass needs BOTH: the backfill tier enabled AND the v2 code path
    // flagged on in creative_writer (the flag that also gates runEnrichmentJob).
    enrichEnabled: enrich.enabled === true && cw.asset_enrich_v2 === true,
    enrichBatchSize: batch(enrich.batch_size, 10),
  };
}

// ── Peer resolution (A-VIS backfill controller) ─────────────────────────────

let backfillTried = false;
let backfillFn: RunBackfillBatchFn | null = null;

async function resolveRunBackfillBatch(): Promise<RunBackfillBatchFn | null> {
  if (backfillTried) return backfillFn;
  backfillTried = true;
  try {
    // Computed specifier: worker/src/creative/backfill.ts is A-VIS's file and
    // may not exist yet — a static import would break THIS package's typecheck.
    const specifier = '../backfill.js';
    const mod = (await import(specifier)) as { runBackfillBatch?: unknown };
    backfillFn = (typeof mod.runBackfillBatch === 'function' ? mod.runBackfillBatch : null) as RunBackfillBatchFn | null;
    if (!backfillFn) {
      console.error('[assetMetaLane] worker/src/creative/backfill.ts has no runBackfillBatch export — enrich v2 batch disabled until A-VIS lands it');
    }
  } catch (e) {
    backfillFn = null;
    console.error(`[assetMetaLane] worker/src/creative/backfill.ts not available yet (${e instanceof Error ? e.message : String(e)}) — enrich v2 batch disabled until A-VIS lands it`);
  }
  return backfillFn;
}

/** Test hook — re-resolve the peer import on the next tick. */
export function resetAssetMetaLaneState(): void {
  backfillTried = false;
  backfillFn = null;
}

// ── One tick ────────────────────────────────────────────────────────────────

interface BackfillTargetRow {
  file_id: string;
  storage_bucket: string;
  storage_path: string;
  mime_type: string;
}

export interface AssetMetaTickResult {
  didWork: boolean;
  meta: { processed: number; failed: number };
  enrich: { processed: number; failed: number } | null;
}

/**
 * One lane tick. Exported for tests: inject a fake supabase + an optional
 * runBackfillBatch override (peer injection). Never throws for a single bad
 * file; throws only when the flags or the targets RPC are unreadable.
 */
export async function assetMetaTick(
  deps: LaneDeps,
  io: { runBackfillBatch?: RunBackfillBatchFn | null } = {},
): Promise<AssetMetaTickResult> {
  const flags = await readAssetMetaFlags(deps.supabase);
  const out: AssetMetaTickResult = { didWork: false, meta: { processed: 0, failed: 0 }, enrich: null };

  // ── 1. Deterministic meta pass ────────────────────────────────────────────
  if (flags.metaEnabled && !deps.isShuttingDown()) {
    const { data, error } = await deps.supabase.rpc('creative_asset_backfill_targets', {
      p_kind: 'meta',
      p_limit: flags.metaBatchSize,
    });
    if (error) throw new Error(`creative_asset_backfill_targets('meta') failed: ${error.message}`);
    const targets = (data ?? []) as BackfillTargetRow[];
    for (const t of targets) {
      if (deps.isShuttingDown()) break;
      try {
        const { data: blob, error: dlErr } = await deps.supabase.storage
          .from(t.storage_bucket)
          .download(t.storage_path);
        if (dlErr || !blob) throw new Error(dlErr?.message ?? 'no data');
        const buffer = Buffer.from(await blob.arrayBuffer());
        const meta = await computeDeterministicMeta(buffer);
        if (meta.width_px === null && meta.dominant_colors === null) {
          throw new Error('undecodable image bytes (no dims, no palette)');
        }
        await applyDeterministicMeta(deps.supabase, t.file_id, meta);
        out.meta.processed += 1;
      } catch (e) {
        // One bad file must NEVER fail the lane — log precisely and continue.
        out.meta.failed += 1;
        console.error(`[assetMetaLane] meta pass file=${t.file_id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (targets.length > 0) {
      out.didWork = true;
      deps.log(`asset meta pass: ${out.meta.processed} processed, ${out.meta.failed} failed of ${targets.length}`);
    }
  }

  // ── 2. Enrich v2 batch (peer controller; owns the approved_cost_usd gate) ──
  if (flags.enrichEnabled && !deps.isShuttingDown()) {
    const run = io.runBackfillBatch !== undefined ? io.runBackfillBatch : await resolveRunBackfillBatch();
    if (run) {
      const res = await run('asset_enrich', deps, { batchSize: flags.enrichBatchSize });
      out.enrich = { processed: res.processed, failed: res.failed };
      if (res.processed > 0 || res.failed > 0) {
        out.didWork = true;
        deps.log(`asset enrich v2 batch: ${res.processed} processed, ${res.failed} failed, cost_usd=${res.cost_usd ?? 'unknown'}`);
      }
    }
  }

  return out;
}

// ── The loop ────────────────────────────────────────────────────────────────

const IDLE_SLEEP_MS = 30_000;
const BUSY_SLEEP_MS = 1_000;

/**
 * The lane loop registered in worker/src/index.ts (A-WORKER wires it). Flags
 * are re-read EVERY tick (contracts §0 rule 14: rollback = flip); when both
 * passes are disabled the lane sleeps 30 s and does no work.
 */
export const assetMetaLaneLoop: LaneLoop = async (deps) => {
  for (;;) {
    if (deps.isShuttingDown()) return;
    let idle = true;
    try {
      const r = await assetMetaTick(deps);
      idle = !r.didWork;
    } catch (e) {
      // A tick-level failure (settings/targets unreadable) is loud but must not
      // kill the loop — the next tick retries.
      console.error(`[assetMetaLane] tick failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await deps.sleep(idle ? IDLE_SLEEP_MS : BUSY_SLEEP_MS);
  }
};
