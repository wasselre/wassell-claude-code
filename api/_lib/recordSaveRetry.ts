/**
 * Shared record_save retry contract (T4 Phase A).
 *
 * One place that encodes how a SERVER-SIDE optimistic record_save should retry,
 * so the image-chat endpoints + the image worker stop hand-rolling slightly
 * different loops. The browser keeps its own T1 breaker; this is the server twin.
 *
 * CONTRACT:
 *   - max 3 attempts; full-jitter exponential backoff (base 100ms, cap 2s);
 *     total budget <= 5s.
 *   - retry ONLY: transient/network, 503/504, and 40001/version_mismatch — and
 *     a version retry ALWAYS re-reads the fresh row + re-merges first (the
 *     `recordSaveWithRetry` step re-reads on every attempt), so a stale version
 *     is NEVER resent blindly.
 *   - NEVER retry: conflict_storm_blocked (the server terminally rate-limited the
 *     record/session — retrying is exactly wrong), auth/validation 4xx, and a
 *     version_mismatch that recurs past the attempt budget.
 *
 * CRITICAL: conflict_storm_blocked is raised with SQLSTATE 40001
 * (serialization_failure) — the SAME code as version_mismatch — so it MUST be
 * classified by MESSAGE first, otherwise it looks like a retryable version
 * conflict (the bug this helper fixes: the old loops retried it up to 6x).
 *
 * No DB change; does not touch record_save.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface SaveError {
  code?: string | null;
  message?: string | null;
}

export type SaveDisposition = 'success' | 'retry_version' | 'retry_transient' | 'terminal';

/** Pure: classify a record_save error into a retry disposition. */
export function classifySaveError(error: SaveError | null | undefined): SaveDisposition {
  if (!error) return 'success';
  const msg = (error.message ?? '').toLowerCase();
  // MUST come before the 40001 branch — conflict_storm_blocked shares SQLSTATE 40001.
  if (msg.includes('conflict_storm_blocked')) return 'terminal';
  const code = (error.code ?? '').toString().toLowerCase();
  if (code === '40001' || msg.includes('version_mismatch') || msg.includes('serialization_failure')) {
    return 'retry_version';
  }
  if (
    code === '503' || code === '504' || code === 'etimedout' || code === 'econnreset' ||
    msg.includes('fetch failed') || msg.includes('network') || msg.includes('timeout') ||
    // "Timed out acquiring connection from connection pool." — Supabase pooler
    // under burst load (seen live 2026-07-18 during a 20+-writer clean-text
    // burst). Spelled "timed out" (with a space), so the 'timeout' match above
    // misses it and it was classified terminal.
    msg.includes('timed out') || msg.includes('connection pool') ||
    msg.includes('econnreset') || msg.includes('503') || msg.includes('504') ||
    msg.includes('service unavailable') || msg.includes('bad gateway') || msg.includes('gateway timeout')
  ) {
    return 'retry_transient';
  }
  // auth/validation/FK/etc. — terminal.
  return 'terminal';
}

export interface RetryOptions {
  maxAttempts?: number; // default 3
  baseMs?: number;      // default 100
  capMs?: number;       // default 2000
  budgetMs?: number;    // default 5000
  // Injectable for deterministic tests.
  sleep?: (ms: number) => Promise<void>;
  random?: () => number; // [0,1)
  now?: () => number;    // epoch ms
}

export interface RetryOutcome {
  ok: boolean;
  attempts: number;
  error?: SaveError;
}

/**
 * Pure-ish retry loop over a `step` that performs ONE read+merge+save and
 * returns the save's error (or null on success). Re-invokes `step` (which
 * re-reads fresh) on a retryable disposition, within the attempt + time budget.
 * A `step` that THROWS (e.g. read failure / not-found) propagates immediately —
 * those are terminal and not retried. Exposed for direct unit testing.
 */
export async function retryRecordSave(
  step: () => Promise<SaveError | null>,
  opts: RetryOptions = {},
): Promise<RetryOutcome> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseMs = opts.baseMs ?? 100;
  const capMs = opts.capMs ?? 2000;
  const budgetMs = opts.budgetMs ?? 5000;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;

  const start = now();
  let lastError: SaveError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const error = await step();
    const disp = classifySaveError(error);
    if (disp === 'success') return { ok: true, attempts: attempt };
    lastError = error ?? undefined;
    if (disp === 'terminal') return { ok: false, attempts: attempt, error: lastError };
    // retry_version / retry_transient — stop if out of attempts or budget.
    if (attempt >= maxAttempts) break;
    const ceil = Math.min(capMs, baseMs * 2 ** (attempt - 1));
    const delay = Math.floor(random() * ceil); // full jitter: [0, ceil)
    if (now() - start + delay > budgetMs) break;
    await sleep(delay);
  }
  return { ok: false, attempts: maxAttempts, error: lastError };
}

export interface RecordSaveArgs {
  recordId: string;
  /**
   * Compute the new full `data` from the freshly-read current data. Return null
   * to SKIP the save (treated as success — e.g. nothing changed). May throw to
   * abort terminally (e.g. target item missing).
   */
  build: (current: Record<string, unknown>) => Record<string, unknown> | null;
}

/**
 * Read-fresh → build → record_save, with the standard retry contract. Reads
 * model_id/version/created_by from the row each attempt (so a version retry is
 * always against the latest row — never a stale resend). Throws on terminal
 * failure, matching the existing callers' behavior (handler → 500 / job → fail).
 */
export async function recordSaveWithRetry(
  client: SupabaseClient,
  args: RecordSaveArgs,
  opts: RetryOptions = {},
): Promise<void> {
  const step = async (): Promise<SaveError | null> => {
    const { data: cur, error: readErr } = await client
      .from('records')
      .select('model_id, data, version, created_by_user_id')
      .eq('id', args.recordId)
      .single();
    if (readErr || !cur) {
      throw new Error(`record_save read failed (${args.recordId}): ${readErr?.message ?? 'not found'}`);
    }
    const row = cur as {
      model_id: string;
      data: Record<string, unknown> | null;
      version: number | null;
      created_by_user_id: string | null;
    };
    const newData = args.build((row.data ?? {}) as Record<string, unknown>);
    if (newData == null) return null; // build decided no-op → success, no save.
    const { error: saveErr } = await client.rpc('record_save', {
      p_model_id: row.model_id,
      p_id: args.recordId,
      p_data: newData,
      p_created_by: row.created_by_user_id ?? null,
      p_expected_version: row.version ?? null,
    });
    return (saveErr as SaveError | null) ?? null;
  };

  const result = await retryRecordSave(step, opts);
  if (!result.ok) {
    throw new Error(
      `record_save failed after ${result.attempts} attempt(s): ${result.error?.message ?? 'unknown'}`,
    );
  }
}
