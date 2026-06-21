/**
 * GET / POST /api/sweep-appointment-noshows
 *
 * Vercel cron sweeper for the appointment no-show auto-close.
 *
 * **What it does:**
 *   1. Calls `appointments_due_for_noshow()` — appointments past
 *      (`appointment_date` + 24h, interpreted as Asia/Riyadh) that are still in
 *      an open status (scheduled / confirmed / unset), excluding the
 *      pre-2026-06-21 backlog. This is the appointments analogue of the
 *      `scheduled_datetime <= now()` query the followups sweeper runs inline.
 *   2. For each due row, runs every active `on_due` workflow whose
 *      `trigger_model_id` is the appointments model — i.e. the
 *      "Auto-close appointment as No-Show after 24h" workflow — through the
 *      shared server mini-engine in `_lib/workflowSweeper.ts`. That workflow's
 *      branch re-checks the open status and its `update_record` action flips the
 *      appointment to `no_show`.
 *
 * **Why no `fired_at` claim (unlike sweep-due-followups):**
 *   The action moves the status OUT of the open set, so a flipped appointment is
 *   simply not returned by the next sweep — the status guard is the natural
 *   idempotency. Concurrent ticks (or a human editing mid-sweep) are handled by
 *   the engine's optimistic-concurrency self-update: the flip goes through
 *   `record_save` with `p_expected_version` = the version read here, so a
 *   competing write bumps the version and the late writer is rejected (skipped),
 *   NEVER overriding a human update.
 *
 * **Auth / runtime:** identical posture to `api/sweep-due-followups.ts` —
 *   CRON_SECRET bearer (or `?secret=`), edge runtime, service-role Supabase.
 *
 * @see api/_lib/workflowSweeper.ts
 * @see supabase/migrations/2026-06-21_appointment_noshow_autoclose.sql
 * @see docs/prd/workflow-automation.md
 */

import { getServiceSupabase } from './_lib/supabaseServer.js';
import { runOnDueForRecord, type SweeperContext, type WorkflowRunSummary } from './_lib/workflowSweeper.js';
import type { AppModel, AppRecord, Workflow } from '../src/types/index.js';

export const config = {
  runtime: 'edge',
};

interface SweepResult {
  ok: true;
  swept_count: number;
  flipped: { id: string }[];
  runs: WorkflowRunSummary[];
  duration_ms: number;
}

interface DueRow {
  id: string;
  model_id: string;
  data: Record<string, unknown>;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  version: number | null;
}

export default async function handler(req: Request): Promise<Response> {
  const startedAt = Date.now();

  // 1. Auth — refuse to run unauthenticated (a public sweeper is a DoS vector).
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return json({ error: 'CRON_SECRET is not set; refusing to run an unauthenticated sweeper' }, 500);
  }
  const url = new URL(req.url);
  const authHeader = req.headers.get('authorization') ?? '';
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const sent = bearer || url.searchParams.get('secret') || '';
  if (sent !== expected) {
    return json({ error: 'unauthorized' }, 401);
  }

  // 2. Service-role Supabase (bypasses RLS — the sweeper acts for every user's
  //    appointments and we don't forge JWTs).
  const supabase = getServiceSupabase();

  // 3. Due appointments. All the appointments-specific logic (Riyadh timezone,
  //    24h window, open-status guard, going-forward cutoff) lives in the SQL
  //    function so the endpoint stays a thin runner.
  const { data: dueData, error: dueErr } = await supabase.rpc('appointments_due_for_noshow');
  if (dueErr) {
    return json({ error: `appointments_due_for_noshow failed: ${dueErr.message}` }, 500);
  }
  const dueRows = (dueData ?? []) as DueRow[];
  if (dueRows.length === 0) {
    return json({ ok: true, swept_count: 0, flipped: [], runs: [], duration_ms: Date.now() - startedAt });
  }

  // 4. Load on_due workflows + all models for the engine context (small tables).
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

  // 5. Run the no-show workflow for each due appointment. `runOnDueForRecord`
  //    only runs workflows whose trigger_model_id matches the appointments
  //    model, so the followups on_due workflow is never run here.
  const flipped: { id: string }[] = [];
  const runs: WorkflowRunSummary[] = [];

  for (const row of dueRows) {
    // The workflow's update_record action self-targets via filter_field_id 'id'
    // + filter_trigger_field_id 'id', so the trigger record must expose its own
    // id under data.id. This is endpoint-local: the engine writes onto a FRESH
    // copy of the target's data (not the trigger snapshot), so the injected key
    // never lands on the saved appointment record.
    const triggerRecord: AppRecord = {
      id: row.id,
      model_id: row.model_id,
      data: { ...row.data, id: row.id },
      created_at: row.created_at,
      updated_at: row.updated_at,
      created_by_user_id: row.created_by_user_id ?? undefined,
      // Drives the optimistic-concurrency guard on the self-update — a human
      // edit since this row was selected bumps `version` and the flip is
      // rejected (skipped), so a manual update is never overridden.
      version: row.version ?? undefined,
    };
    const summaries = await runOnDueForRecord(triggerRecord, ctx);
    runs.push(...summaries);
    // Count as flipped only when an action actually executed (not skipped due to
    // a version conflict or an unmatched branch).
    if (summaries.some((s) => s.actions.some((a) => a.status === 'executed'))) {
      flipped.push({ id: row.id });
    }
  }

  const result: SweepResult = {
    ok: true,
    swept_count: flipped.length,
    flipped,
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
