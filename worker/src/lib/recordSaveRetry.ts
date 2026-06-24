/**
 * Shared record_save retry contract (T4 Phase A) — WORKER COPY.
 *
 * COPY of api/_lib/recordSaveRetry.ts. The worker is a standalone npm package
 * (rootDir:src; the Dockerfile copies only src/) and CANNOT import from api/_lib
 * — same posture as worker/src/imageGen.ts etc. Keep the two in sync.
 *
 * CONTRACT:
 *   - max 3 attempts; full-jitter exponential backoff (base 100ms, cap 2s);
 *     total budget <= 5s.
 *   - retry ONLY: transient/network, 503/504, and 40001/version_mismatch — and a
 *     version retry ALWAYS re-reads the fresh row + re-merges first, so a stale
 *     version is NEVER resent blindly.
 *   - NEVER retry: conflict_storm_blocked (server terminally rate-limited),
 *     auth/validation 4xx, version_mismatch past budget.
 *
 * CRITICAL: conflict_storm_blocked shares SQLSTATE 40001 with version_mismatch,
 * so it MUST be classified by MESSAGE first (the bug this fixes: the old worker
 * loop retried it up to 6x). No DB change; does not touch record_save.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface SaveError {
  code?: string | null;
  message?: string | null;
}

export type SaveDisposition = 'success' | 'retry_version' | 'retry_transient' | 'terminal';

export function classifySaveError(error: SaveError | null | undefined): SaveDisposition {
  if (!error) return 'success';
  const msg = (error.message ?? '').toLowerCase();
  if (msg.includes('conflict_storm_blocked')) return 'terminal';
  const code = (error.code ?? '').toString().toLowerCase();
  if (code === '40001' || msg.includes('version_mismatch') || msg.includes('serialization_failure')) {
    return 'retry_version';
  }
  if (
    code === '503' || code === '504' || code === 'etimedout' || code === 'econnreset' ||
    msg.includes('fetch failed') || msg.includes('network') || msg.includes('timeout') ||
    msg.includes('econnreset') || msg.includes('503') || msg.includes('504') ||
    msg.includes('service unavailable') || msg.includes('bad gateway') || msg.includes('gateway timeout')
  ) {
    return 'retry_transient';
  }
  return 'terminal';
}

export interface RetryOptions {
  maxAttempts?: number;
  baseMs?: number;
  capMs?: number;
  budgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface RetryOutcome {
  ok: boolean;
  attempts: number;
  error?: SaveError;
}

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
    if (attempt >= maxAttempts) break;
    const ceil = Math.min(capMs, baseMs * 2 ** (attempt - 1));
    const delay = Math.floor(random() * ceil);
    if (now() - start + delay > budgetMs) break;
    await sleep(delay);
  }
  return { ok: false, attempts: maxAttempts, error: lastError };
}

export interface RecordSaveArgs {
  recordId: string;
  build: (current: Record<string, unknown>) => Record<string, unknown> | null;
}

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
    if (newData == null) return null;
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
