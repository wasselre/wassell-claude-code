/**
 * POST /api/internal/run-workflow-job  — internal, worker-only.
 *
 * Executes the workflows eligible for ONE claimed workflow_jobs row. Auth is a
 * shared secret (WORKFLOW_RUNNER_SECRET), NOT a user JWT — the caller is the Fly
 * worker, not a browser.
 *
 * RUNNER = EXECUTION ONLY. This endpoint never calls workflow_job_complete /
 * _fail — the worker owns the queue lifecycle. It returns a structured result;
 * the worker decides complete vs fail-with-retry.
 *
 * Contract (job_id is the source of truth — the request body's snapshots are
 * NEVER trusted; everything is read fresh from the DB row):
 *   missing secret              → 503 (misconfigured — fail closed, no bypass)
 *   wrong secret                → 401
 *   non-POST                    → 405
 *   bad body                    → 400
 *   job not found               → 404
 *   job.status != 'processing'  → 409 not_processing
 *   lease expired (>10m)        → 409 lease_expired
 *   locked_by != worker_id      → 409 locked_by_mismatch
 *   ok                          → 200 { result }
 */
import type { IncomingMessage, ServerResponse } from 'http';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { runWorkflowJob, type CapturedJob } from '../_lib/workflowRunner.js';

export const config = { runtime: 'nodejs', maxDuration: 120 };

// Must match workflow_jobs_watchdog's lease (10 min). A job still 'processing'
// past this is considered abandoned and the watchdog will requeue it, so the
// endpoint refuses to run it under the stale claim.
const LEASE_MS = 10 * 60 * 1000;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (status: number, body: unknown): void => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };

  if (req.method !== 'POST') return send(405, { error: 'method not allowed' });

  // Fail closed: a missing secret is a misconfiguration, NOT an open door.
  const secret = process.env.WORKFLOW_RUNNER_SECRET;
  if (!secret) return send(503, { error: 'WORKFLOW_RUNNER_SECRET not configured' });
  const provided = (req.headers['x-workflow-runner-secret'] as string | undefined) ?? '';
  if (!provided || !timingSafeEqual(provided, secret)) return send(401, { error: 'unauthorized' });

  let jobId: string | undefined;
  let workerId: string | undefined;
  try {
    const body = JSON.parse((await readBody(req)) || '{}') as { job_id?: string; worker_id?: string };
    jobId = body.job_id;
    workerId = body.worker_id;
  } catch {
    return send(400, { error: 'invalid JSON body' });
  }
  if (!jobId || !workerId) return send(400, { error: 'job_id and worker_id are required' });

  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return send(503, { error: 'Supabase service env not configured' });
  const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Load the job FRESH — the body is never the source of truth.
  const { data: jobRow, error: loadErr } = await supabase
    .from('workflow_jobs')
    .select('id, model_id, record_id, trigger_event, previous_data, new_data, changed_fields, actor_user_id, depth, status, locked_at, locked_by')
    .eq('id', jobId)
    .maybeSingle();
  if (loadErr) return send(500, { error: `load job failed: ${loadErr.message}` });
  if (!jobRow) return send(404, { error: 'job not found' });

  // State discipline — these are NOT the same guarantee as business idempotency.
  if (jobRow.status !== 'processing') return send(409, { error: 'job not processing', reason: 'not_processing', status: jobRow.status });
  const lockedAtMs = jobRow.locked_at ? new Date(jobRow.locked_at as string).getTime() : 0;
  if (!lockedAtMs || Date.now() - lockedAtMs > LEASE_MS) return send(409, { error: 'lease expired', reason: 'lease_expired' });
  if (jobRow.locked_by !== workerId) return send(409, { error: 'locked by another worker', reason: 'locked_by_mismatch', locked_by: jobRow.locked_by });

  const job: CapturedJob = {
    job_id: jobRow.id as string,
    model_id: jobRow.model_id as string,
    record_id: jobRow.record_id as string,
    trigger_event: jobRow.trigger_event as CapturedJob['trigger_event'],
    previous_data: (jobRow.previous_data as Record<string, unknown> | null) ?? null,
    new_data: (jobRow.new_data as Record<string, unknown> | null) ?? null,
    changed_fields: (jobRow.changed_fields as string[] | null) ?? [],
    actor_user_id: (jobRow.actor_user_id as string | null) ?? null,
    depth: (jobRow.depth as number | null) ?? 0,
  };

  try {
    const result = await runWorkflowJob(supabase, job);
    // Do NOT complete/fail the job here — the worker owns the queue lifecycle.
    return send(200, { ok: true, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return send(500, { error: msg });
  }
}
