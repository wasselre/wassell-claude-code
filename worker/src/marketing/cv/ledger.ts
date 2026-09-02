// ============================================================================
// Cost ledger + daily budget gate (contracts §1.3 / §9).
//
// Every paid call in the cv lanes MUST append to mkt_cv_cost_ledger via
// mkt_cv_cost_add (it also rolls the cost onto the video row). Before every
// paid call, checkBudget() asks mkt_cv_budget_ok(); when the day's spend has
// reached cv.daily_budget_usd it emits ONE deduped ops alert and throws the
// terminal `budget_exceeded:` error, which mkt_cv_job_fail treats as final
// (no requeue). Partial progress written before the throw stays.
// ============================================================================
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RoleStamp } from './types.js';

export type LedgerKind = 'cv_process' | 'frame_describe' | 'shot_analyze' | 'embed' | 'ocr' | 'describe_on_demand';

export async function addCost(sb: SupabaseClient, kind: LedgerKind, videoId: string | null, stamp: RoleStamp): Promise<void> {
  // null = the model is not in pricing.ts (unknown ≠ zero). The ledger takes 0
  // so the day's total stays a number, but the row keeps provider/model so it
  // can be repriced later, and the role stamp on the shot/frame keeps the null.
  if (typeof stamp.cost_usd !== 'number') {
    console.warn(`[cv] unknown cost for model ${stamp.provider}/${stamp.model} (role ${stamp.role}, ${kind}) — ledger records 0`);
  }
  const { error } = await sb.rpc('mkt_cv_cost_add', {
    p_kind: kind,
    p_video_id: videoId,
    p_role: stamp.role,
    p_provider: stamp.provider,
    p_model: stamp.model,
    p_cost: typeof stamp.cost_usd === 'number' ? stamp.cost_usd : 0,
  });
  if (error) throw new Error(`mkt_cv_cost_add failed: ${error.message}`);
}

export class BudgetExceededError extends Error {
  constructor(detail: string) { super(`budget_exceeded: ${detail}`); this.name = 'BudgetExceededError'; }
}

export function isBudgetExceeded(e: unknown): boolean {
  return e instanceof BudgetExceededError || (e instanceof Error && e.message.startsWith('budget_exceeded:'));
}

/** Riyadh calendar day, matching mkt_cv_cost_today()'s midnight boundary. */
function riyadhDay(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export async function checkBudget(sb: SupabaseClient, context: string): Promise<void> {
  const { data, error } = await sb.rpc('mkt_cv_budget_ok');
  if (error) throw new Error(`mkt_cv_budget_ok failed: ${error.message}`);
  if (data === true) return;
  const day = riyadhDay();
  const { error: alertErr } = await sb.rpc('mkt_alert_emit', {
    p_kind: 'cv_budget_exceeded',
    p_dedup_key: `cv_budget_exceeded:${day}`,
    p_title: 'Visual intelligence paused: daily budget reached',
    p_severity: 'warning',
    p_subject_type: 'cv',
    p_subject_id: day,
    p_body: `cv.daily_budget_usd reached while ${context}. Jobs fail with budget_exceeded until midnight Riyadh or a higher budget.`,
    p_evidence: { context, day },
  });
  if (alertErr) console.error(`[cv] mkt_alert_emit failed (budget alert not recorded): ${alertErr.message}`);
  throw new BudgetExceededError(`daily cv budget reached (${context})`);
}

export function stampOf(role: RoleStamp['role'], r: { provider: string; model: string; version: string | null; cost_usd: number | null; latency_ms: number }): RoleStamp {
  return { role, provider: r.provider, model: r.model, version: r.version, cost_usd: r.cost_usd, latency_ms: r.latency_ms };
}
