/**
 * /api/geo-preference/backfill — enqueue + drive a review-first BACKFILL run of
 * the Geography Understanding Ability over a set of clients.
 *
 * A run replays each client's chat + call history through extract → runReviewFirst
 * and lands ONE `pending` row in geo_pref_proposals per client. It NEVER contacts
 * a customer and NEVER writes a client's active preferences — auto_write stays
 * false. See api/_lib/geoPreference/backfillRunner.ts for the safety boundary.
 *
 * ADMIN-ONLY. Every action verifies the caller's JWT (withAuth) then checks
 * wassell_is_admin server-side before any service-role RPC runs; the queue RPCs
 * are themselves locked to service_role.
 *
 *   POST { action:'enqueue', clientIds?, runId? }
 *        → { run_id, inserted, skipped, total }.  One job per (run_id, client_id)
 *          via the UNIQUE constraint, so re-enqueue is idempotent + resumable.
 *          Omitting clientIds enqueues the DEV split from geo_pref_gold_split.
 *   POST { action:'process', runId, max?, budgetMs? }
 *        → { processed, done, failed, proposals, drained, progress }.  Claims and
 *          processes a BOUNDED batch (never a long-held request); call again while
 *          drained=false to resume. Idempotent: done jobs are never re-claimed.
 *   GET  ?runId=…  → { run_id, progress: { pending, running, done, failed } }.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'node:crypto';
import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import { makeServiceClient } from '../_lib/serviceClient.js';
import { makeSupabaseBackfillDeps } from '../_lib/geoPreference/backfillPorts.js';
import { runBackfillBatch } from '../_lib/geoPreference/backfillRunner.js';
import {
  readNodeBodyLimited, PayloadTooLargeError, sendPayloadTooLarge, MAX_REQUEST_BODY_BYTES,
} from '../_lib/httpBody.js';

export const config = {
  runtime: 'nodejs',
  // 'process' does a bounded batch of per-client extractions; keep it well under
  // the ceiling and let the caller loop. Enqueue/GET are sub-second.
  maxDuration: 300,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// run_id is a TEXT column (2026-09-03a) — accept a uuid or a short operator label.
const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const DEFAULT_PROCESS_MAX = 50;
const DEFAULT_PROCESS_BUDGET_MS = 240_000;

async function nodeToWebRequest(nodeReq: IncomingMessage): Promise<Request> {
  const host = (nodeReq.headers.host as string | undefined) ?? 'localhost';
  const url = new URL(nodeReq.url ?? '/', `https://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const method = nodeReq.method ?? 'GET';
  const body =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : await readNodeBodyLimited(nodeReq, MAX_REQUEST_BODY_BYTES);
  return new Request(url.toString(), { method, headers, body });
}

async function writeWebResponseToNode(webResp: Response, nodeRes: ServerResponse): Promise<void> {
  nodeRes.statusCode = webResp.status;
  for (const [k, v] of webResp.headers) nodeRes.setHeader(k, v);
  const buf = Buffer.from(await webResp.arrayBuffer());
  nodeRes.end(buf);
}

interface ProgressRow { status: string; count: number }
function shapeProgress(rows: ProgressRow[]): Record<string, number> {
  const out: Record<string, number> = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const r of rows) out[r.status] = Number(r.count) || 0;
  return out;
}

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  let req: Request;
  try {
    req = await nodeToWebRequest(nodeReq);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) return sendPayloadTooLarge(nodeRes, err.limitBytes);
    throw err;
  }

  const resp = await withAuth(req, async (user) => {
    const sb = makeServiceClient('api:geo-preference-backfill');
    if (!sb) return jsonError(500, 'server env missing: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');

    // ADMIN GATE — every action is admin-only.
    const { data: isAdmin, error: adminErr } = await sb.rpc('wassell_is_admin', { auth_user_id: user.userId });
    if (adminErr) return jsonError(500, `admin check failed: ${adminErr.message}`);
    if (isAdmin !== true) return jsonError(403, 'geo-preference backfill is admin-only');

    // ── GET: run progress ──
    if (req.method === 'GET') {
      const runId = new URL(req.url).searchParams.get('runId') ?? '';
      if (!RUN_ID_RE.test(runId)) return jsonError(400, 'a valid runId query param is required');
      const { data, error } = await sb.rpc('geo_pref_backfill_progress', { p_run_id: runId });
      if (error) return jsonError(500, `progress failed: ${error.message}`);
      return jsonOk({ run_id: runId, progress: shapeProgress((data ?? []) as ProgressRow[]) });
    }

    if (req.method !== 'POST') return jsonError(405, 'Method not allowed');

    let body: { action?: string; clientIds?: unknown; runId?: string; max?: number; budgetMs?: number };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }

    const action = typeof body.action === 'string' ? body.action : '';

    // ── POST enqueue ──
    if (action === 'enqueue') {
      let clientIds: string[] | null = null;
      if (body.clientIds != null) {
        if (!Array.isArray(body.clientIds)) return jsonError(400, 'clientIds must be an array of uuids');
        clientIds = body.clientIds.filter((x): x is string => typeof x === 'string' && UUID_RE.test(x));
        if (clientIds.length === 0) return jsonError(400, 'clientIds contained no valid uuids');
      }
      const runId = body.runId && RUN_ID_RE.test(body.runId) ? body.runId : randomUUID();
      const { data, error } = await sb.rpc('geo_pref_backfill_enqueue', {
        p_run_id: runId,
        p_client_ids: clientIds,
      });
      if (error) return jsonError(500, `enqueue failed: ${error.message}`);
      const row = (Array.isArray(data) ? data[0] : data) as { inserted: number; skipped: number; total: number } | null;
      console.log(`[geo-backfill] enqueue run=${runId} inserted=${row?.inserted ?? 0} skipped=${row?.skipped ?? 0} total=${row?.total ?? 0} by=${user.userId}`);
      return jsonOk({
        run_id: runId,
        inserted: row?.inserted ?? 0,
        skipped: row?.skipped ?? 0,
        total: row?.total ?? 0,
      }, 202);
    }

    // ── POST process (bounded, resumable) ──
    if (action === 'process') {
      const runId = body.runId ?? '';
      if (!RUN_ID_RE.test(runId)) return jsonError(400, 'a valid runId is required');
      const max = Number.isFinite(body.max) && (body.max as number) > 0 ? Math.floor(body.max as number) : DEFAULT_PROCESS_MAX;
      const budgetMs = Number.isFinite(body.budgetMs) && (body.budgetMs as number) > 0
        ? Math.min(Math.floor(body.budgetMs as number), DEFAULT_PROCESS_BUDGET_MS)
        : DEFAULT_PROCESS_BUDGET_MS;

      const deps = makeSupabaseBackfillDeps(sb, `api:${user.userId.slice(0, 8)}`, {
        log: (m) => console.log(m),
      });
      const result = await runBackfillBatch(deps, { runId, max, budgetMs });

      const { data: prog } = await sb.rpc('geo_pref_backfill_progress', { p_run_id: runId });
      console.log(`[geo-backfill] process run=${runId} processed=${result.processed} done=${result.done} failed=${result.failed} proposals=${result.proposals} drained=${result.drained}`);
      return jsonOk({ run_id: runId, ...result, progress: shapeProgress((prog ?? []) as ProgressRow[]) });
    }

    return jsonError(400, `unknown action '${action}' (expected 'enqueue' or 'process')`);
  });

  await writeWebResponseToNode(resp, nodeRes);
}
