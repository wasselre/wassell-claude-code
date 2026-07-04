/**
 * GET / POST /api/sweep-due-followups
 *
 * Vercel cron sweeper for the `on_due` workflow trigger.
 *
 * **What it does:**
 *   1. Finds followup records whose `data->>'scheduled_datetime' <= now()`
 *      AND `data->>'fired_at' IS NULL`.
 *   2. Atomically claims each row by stamping `fired_at = now()` so the
 *      next sweep tick cannot double-fire the same row.
 *   3. For every claimed row, runs every active `on_due` workflow whose
 *      `trigger_model_id` is the followups model — branch eval + action
 *      execution via the server mini-engine in `_lib/workflowSweeper.ts`.
 *
 * **Auth:**
 *   - Vercel Cron sends a header `Authorization: Bearer $CRON_SECRET` if
 *     `CRON_SECRET` is set in env. We accept that, OR
 *     `?secret=<CRON_SECRET>` for manual curl smoke tests.
 *   - Without a configured `CRON_SECRET`, returns 500 (refusing to run
 *     without auth — a public sweeper would be a DoS vector).
 *
 * **Idempotency:**
 *   - The atomic claim (UPDATE ... WHERE fired_at IS NULL RETURNING) makes
 *     re-entry safe at the row level.
 *   - WhatsApp sends use a stable `reference` derived from the action +
 *     trigger row + fired_at so Haberchat dedupes if a retry sneaks past.
 *
 * @see api/_lib/workflowSweeper.ts
 * @see docs/prd/workflow-automation.md
 */

import { getServiceSupabase } from './_lib/supabaseServer.js';
import { runOnDueForRecord, type SweeperContext, type WorkflowRunSummary } from './_lib/workflowSweeper.js';
import type { AppModel, AppRecord, Workflow } from '../src/types/index.js';

export const config = {
  // Web Request/Response signature → edge runtime, matching the
  // haberchat webhook pattern (`api/webhook/haberchat.ts`). The
  // sweeper's only side effects are Supabase HTTP + Haberchat HTTP,
  // both of which work fine on edge.
  runtime: 'edge',
};

interface SweepResult {
  ok: true;
  swept_count: number;
  claimed: { id: string }[];
  runs: WorkflowRunSummary[];
  duration_ms: number;
}

export default async function handler(req: Request): Promise<Response> {
  const startedAt = Date.now();

  // 1. Auth ─────────────────────────────────────────────────────────
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return json({ error: 'CRON_SECRET is not set; refusing to run an unauthenticated sweeper' }, 500);
  }
  const url = new URL(req.url);
  const authHeader = req.headers.get('authorization') ?? '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const sent = bearer || url.searchParams.get('secret') || '';
  if (sent !== expected) {
    return json({ error: 'unauthorized' }, 401);
  }

  // 2. Service-role Supabase (bypasses RLS — the sweeper writes for
  //    every user's records and we don't want to forge JWTs).
  const supabase = getServiceSupabase();

  // 3. Find the followups model — every `on_due` workflow in v1
  //    targets it. If the model is somehow missing, return 200 with a
  //    no-op rather than 500: the cron should not page on a fresh
  //    install where seeding hasn't run yet.
  const { data: modelRows, error: modelErr } = await supabase
    .from('models')
    .select('*')
    .eq('name', 'followups')
    .limit(1);
  if (modelErr) {
    return json({ error: `models query failed: ${modelErr.message}` }, 500);
  }
  const followupsModelRow = modelRows?.[0];
  if (!followupsModelRow) {
    return json({ ok: true, swept_count: 0, claimed: [], runs: [], duration_ms: Date.now() - startedAt });
  }
  const followupsModelId: string = followupsModelRow.id as string;

  // 4. Atomically claim due rows. JSONB filter syntax: PostgREST
  //    accepts `data->>scheduled_datetime` only via raw SQL or the
  //    `.filter()` shortcut. Easier to fetch candidates and filter
  //    client-side here — typical sweep finds 0–10 rows so the cost
  //    is negligible. The atomic check-and-set is the JSONB UPDATE
  //    in the next step, not the SELECT.
  const nowIso = new Date().toISOString();
  const { data: candidates, error: candidatesErr } = await supabase
    .from('records')
    .select('id, model_id, data, created_by_user_id, created_at, updated_at')
    .eq('model_id', followupsModelId)
    .is('data->>fired_at', null)
    .lte('data->>scheduled_datetime', nowIso);
  if (candidatesErr) {
    return json({ error: `candidates query failed: ${candidatesErr.message}` }, 500);
  }
  // Never fire on_due workflows for an already-closed follow-up. A completed/
  // cancelled/skipped row is terminal — sweeping it would let the WhatsApp
  // escalation (which keys off whatsapp_state) spawn a ghost task from a task
  // the rep already finished. Belt-and-braces alongside the workflow's own
  // status condition. (`followup_status` may be null/'' on legacy workflow-
  // created rows → treated as open, which is correct.)
  const DONE_STATES = new Set(['completed', 'cancelled', 'skipped']);
  const dueRows = ((candidates ?? []) as Array<{
    id: string;
    model_id: string;
    data: Record<string, unknown>;
    created_by_user_id: string | null;
    created_at: string;
    updated_at: string;
  }>).filter((r) => !DONE_STATES.has(String((r.data as Record<string, unknown>).followup_status ?? '').trim()));

  // 5. Load all workflows once (small table, simpler than per-row
  //    queries) plus all models for the engine context.
  const [workflowsRes, allModelsRes] = await Promise.all([
    supabase.from('workflows').select('*').eq('is_active', true).eq('trigger_event', 'on_due'),
    supabase.from('models').select('*'),
  ]);
  if (workflowsRes.error) {
    return json({ error: `workflows query failed: ${workflowsRes.error.message}` }, 500);
  }
  if (allModelsRes.error) {
    return json({ error: `models full-load failed: ${allModelsRes.error.message}` }, 500);
  }
  const workflows = (workflowsRes.data ?? []) as Workflow[];
  const allModels = (allModelsRes.data ?? []) as AppModel[];

  const ctx: SweeperContext = {
    supabase,
    models: allModels,
    workflows,
    recordsByModel: new Map(),
  };

  // 6. For each due row: claim atomically, then run on_due workflows.
  const claimed: { id: string }[] = [];
  const runs: WorkflowRunSummary[] = [];

  for (const row of dueRows) {
    const claimedAt = new Date().toISOString();
    // Atomic claim: only update rows where fired_at is still null. If
    // a competing sweeper instance already claimed this row, our
    // update returns zero rows and we skip.
    const newData = { ...row.data, fired_at: claimedAt };
    const { data: updated, error: claimErr } = await supabase
      .from('records')
      .update({ data: newData })
      .eq('id', row.id)
      .is('data->>fired_at', null)
      .select('id');
    if (claimErr) {
      // eslint-disable-next-line no-console
      console.error(`[sweep-due-followups] claim failed for ${row.id}: ${claimErr.message}`);
      continue;
    }
    if (!updated || updated.length === 0) {
      // Row was claimed by another sweep tick between our SELECT and
      // UPDATE. Skip — the other sweep will run the workflows.
      continue;
    }

    claimed.push({ id: row.id });
    const triggerRecord: AppRecord = {
      id: row.id,
      model_id: row.model_id,
      data: newData,
      created_at: row.created_at,
      updated_at: claimedAt,
      created_by_user_id: row.created_by_user_id ?? undefined,
    };
    const summaries = await runOnDueForRecord(triggerRecord, ctx);
    runs.push(...summaries);
  }

  const result: SweepResult = {
    ok: true,
    swept_count: claimed.length,
    claimed,
    runs,
    duration_ms: Date.now() - startedAt,
  };
  return json(result);
}

function json(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
