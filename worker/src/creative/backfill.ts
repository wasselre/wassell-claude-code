/**
 * Shared creative backfill controller (contracts §9).
 *
 * ONE generic implementation; each kind ('design_reads' — this module's owner;
 * 'asset_meta' / 'asset_enrich' — A-ASSETS) supplies a BackfillKindHandler with
 * its own target fetch + batch processing. The controller owns the cross-kind
 * rules:
 *
 *  - Config lives in DATA: mos_settings.creative_backfill.<kind>
 *    {enabled, lane:'runner'|'worker', batch_size, tiers, paused_at,
 *     approved_cost_usd, estimated_cost_per_item, pilot_ids}.
 *  - Interruptible: the config row is re-read on EVERY batch, so flipping
 *    enabled=false or setting paused_at stops the walk at the next batch.
 *  - Pilot mode: while pilot_ids is non-empty, only those subjects are
 *    processed (tier 0) — the pilot measures the real per-item cost before the
 *    tier walk is approved.
 *  - Cost gate: the worker (API) lane REFUSES a batch loudly when
 *    approved_cost_usd < items × estimated_cost_per_item. The runner lane has
 *    no incremental per-item cost and skips the gate.
 *  - Observability: every batch opens a creative_backfill_runs row
 *    (start/finish RPCs) with processed/failed/cost.
 *  - Idempotent by construction: handlers fetch "subjects lacking a read" and
 *    writes are upserts, so a re-run of the same tier is a no-op. Two workers
 *    may double-process at most one batch — acceptable per contracts §9.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type BackfillLane = 'runner' | 'worker';

export interface BackfillConfig {
  enabled: boolean;
  lane: BackfillLane;
  batch_size: number;
  tiers: number[];
  paused_at: string | null;
  approved_cost_usd: number | null;
  estimated_cost_per_item: number | null;
  pilot_ids: string[];
}

export interface BackfillDeps {
  sb: SupabaseClient;
  workerId: string;
  log?: (msg: string, extra?: unknown) => void;
}

export interface BackfillProcessOutcome {
  processed: number;
  failed: number;
  /** USD spent by THIS batch; null when unknown (never a guessed number). */
  costUsd: number | null;
  note?: string;
}

export interface BackfillKindHandler<TTarget = unknown> {
  /** Config key under mos_settings.creative_backfill. */
  kind: string;
  /**
   * Fetch up to `limit` targets of ONE tier lacking work. tier 0 is the pilot:
   * `pilotIds` restricts to exactly those subjects (whether or not they would
   * tier-match normally).
   */
  fetchTargets(args: { tier: number; limit: number; pilotIds: string[] }): Promise<TTarget[]>;
  /** Process one batch. Runner lane = enqueue + return; worker lane = direct. */
  processBatch(targets: TTarget[], ctx: { lane: BackfillLane }): Promise<BackfillProcessOutcome>;
}

export interface BackfillBatchResult {
  kind: string;
  skipped: 'disabled' | 'paused' | 'no_targets' | 'cost_gate' | null;
  tier: number | null;
  pilot: boolean;
  run_id: string | null;
  target_count: number;
  processed: number;
  failed: number;
  cost_usd: number | null;
  estimated_cost_usd: number | null;
  approved_cost_usd: number | null;
}

const DEFAULTS: Omit<BackfillConfig, 'enabled'> = {
  lane: 'worker',
  batch_size: 24,
  tiers: [1, 2, 3],
  paused_at: null,
  approved_cost_usd: null,
  estimated_cost_per_item: null,
  pilot_ids: [],
};

/** Read mos_settings.creative_backfill.<kind> with defensive parsing. */
export async function readBackfillConfig(sb: SupabaseClient, kind: string): Promise<BackfillConfig> {
  const { data, error } = await sb.from('mos_settings').select('value').eq('key', 'creative_backfill').maybeSingle();
  if (error) throw new Error(`provider:supabase mos_settings.creative_backfill read failed: ${error.message}`);
  const root = (data as { value?: unknown } | null)?.value;
  const raw = root && typeof root === 'object' && !Array.isArray(root)
    ? (root as Record<string, unknown>)[kind]
    : undefined;
  const cfg = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  return {
    enabled: cfg.enabled === true,
    lane: cfg.lane === 'runner' ? 'runner' : DEFAULTS.lane,
    batch_size: Number.isInteger(cfg.batch_size) && (cfg.batch_size as number) > 0 ? (cfg.batch_size as number) : DEFAULTS.batch_size,
    tiers: Array.isArray(cfg.tiers) && cfg.tiers.every((t) => Number.isInteger(t)) && cfg.tiers.length > 0
      ? (cfg.tiers as number[]) : DEFAULTS.tiers,
    paused_at: typeof cfg.paused_at === 'string' && cfg.paused_at.length > 0 ? cfg.paused_at : null,
    approved_cost_usd: typeof cfg.approved_cost_usd === 'number' ? cfg.approved_cost_usd : null,
    estimated_cost_per_item: typeof cfg.estimated_cost_per_item === 'number' ? cfg.estimated_cost_per_item : null,
    pilot_ids: Array.isArray(cfg.pilot_ids) ? cfg.pilot_ids.filter((x): x is string => typeof x === 'string') : [],
  };
}

function baseResult(kind: string, cfg: BackfillConfig): BackfillBatchResult {
  return {
    kind, skipped: null, tier: null, pilot: false, run_id: null,
    target_count: 0, processed: 0, failed: 0, cost_usd: null,
    estimated_cost_usd: null, approved_cost_usd: cfg.approved_cost_usd,
  };
}

/**
 * Run ONE backfill batch for a kind: re-read config → pick pilot/tier → cost
 * gate → open a run row → process → close the run row. Safe to call once per
 * lane tick.
 */
export async function runBackfillBatch<TTarget>(
  handler: BackfillKindHandler<TTarget>,
  deps: BackfillDeps,
): Promise<BackfillBatchResult> {
  const { sb, workerId, log } = deps;
  const cfg = await readBackfillConfig(sb, handler.kind);
  const result = baseResult(handler.kind, cfg);

  if (!cfg.enabled) { result.skipped = 'disabled'; return result; }
  if (cfg.paused_at) { result.skipped = 'paused'; return result; }

  // ── target selection: pilot first, then the tier walk ─────────────────────
  const pilot = cfg.pilot_ids.length > 0;
  let targets: TTarget[] = [];
  let tier: number | null = null;
  if (pilot) {
    tier = 0;
    targets = await handler.fetchTargets({ tier: 0, limit: cfg.batch_size, pilotIds: cfg.pilot_ids });
  } else {
    for (const t of cfg.tiers) {
      tier = t;
      targets = await handler.fetchTargets({ tier: t, limit: cfg.batch_size, pilotIds: [] });
      if (targets.length > 0) break;
    }
  }
  result.tier = tier;
  result.pilot = pilot;
  result.target_count = targets.length;
  if (targets.length === 0) { result.skipped = 'no_targets'; return result; }

  // ── cost gate (worker lane only — the runner lane has no per-item meter) ──
  if (cfg.lane === 'worker') {
    const perItem = cfg.estimated_cost_per_item ?? 0;
    const estimated = perItem > 0 ? targets.length * perItem : 0;
    result.estimated_cost_usd = estimated;
    if (estimated > 0 && (cfg.approved_cost_usd === null || cfg.approved_cost_usd < estimated)) {
      result.skipped = 'cost_gate';
      // Loud by design (no silent skips): the operator must raise
      // approved_cost_usd or switch the lane to 'runner'.
      console.error(
        `[backfill] ${handler.kind}: REFUSING tier ${tier} batch — estimated $${estimated.toFixed(4)} ` +
        `(${targets.length} items × $${perItem}) exceeds approved_cost_usd ` +
        `${cfg.approved_cost_usd === null ? '(unset)' : `$${cfg.approved_cost_usd}`}`,
      );
      return result;
    }
  }

  // ── run row + processing ──────────────────────────────────────────────────
  const { data: runId, error: startErr } = await sb.rpc('creative_backfill_run_start', {
    p_kind: handler.kind, p_tier: tier, p_worker_id: workerId,
  });
  if (startErr) throw new Error(`provider:supabase creative_backfill_run_start failed: ${startErr.message}`);
  result.run_id = String(runId);

  try {
    const out = await handler.processBatch(targets, { lane: cfg.lane });
    result.processed = out.processed;
    result.failed = out.failed;
    result.cost_usd = out.costUsd;
    const { error: finErr } = await sb.rpc('creative_backfill_run_finish', {
      p_run_id: runId,
      p_status: 'completed',
      p_processed: out.processed,
      p_failed: out.failed,
      p_cost_usd: out.costUsd,
      p_note: out.note ?? (pilot ? `pilot (${cfg.pilot_ids.length} ids)` : null),
    });
    if (finErr) console.error(`[backfill] ${handler.kind}: run_finish failed for ${runId}: ${finErr.message}`);
    log?.(`backfill ${handler.kind}: tier ${tier} processed=${out.processed} failed=${out.failed}`);
    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const { error: finErr } = await sb.rpc('creative_backfill_run_finish', {
      p_run_id: runId, p_status: 'failed', p_processed: result.processed, p_failed: result.failed,
      p_cost_usd: null, p_note: msg.slice(0, 400),
    });
    if (finErr) console.error(`[backfill] ${handler.kind}: run_finish(failed) failed for ${runId}: ${finErr.message}`);
    throw e;
  }
}
