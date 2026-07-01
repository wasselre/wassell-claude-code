/**
 * POST /api/rega-lookup — enqueue an on-demand advertiser-phone lookup for a
 * market_listings record (the "التواصل مع المعلن" button).
 *
 * ENQUEUE-ONLY (no Browserbase here): the scrape is ~30-60s and would blow the
 * "never hold an HTTP request open for a long call" rule (CLAUDE.md). This inserts
 * ONE rega_lookup_jobs row, pings the Fly worker, and returns 202. The worker
 * (worker/src/runRegaLookupJob.ts) drives Browserbase → REGA registry → writes
 * advertiser_phone / advertiser_name onto the listing; the SPA reads it via
 * Supabase Realtime and opens an in-app WhatsApp chat. No SSE, no held HTTP.
 *
 * Auth: withAuth (Supabase JWT). The caller must be able to SEE the listing under
 * RLS (assertCanAccessRecord) before the service-role enqueue — service role
 * bypasses RLS, so this gate stops any authenticated user from driving a lookup on
 * a record they can't see.
 *
 * Body: { recordId }  →  202 { job_id }
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { withAuth, jsonError, jsonOk, assertCanAccessRecord } from './_lib/auth.js';
import { makeServiceClient } from './_lib/serviceClient.js';
import {
  readNodeBodyLimited,
  PayloadTooLargeError,
  sendPayloadTooLarge,
  MAX_REQUEST_BODY_BYTES,
} from './_lib/httpBody.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 30, // enqueue + wake ping only — the scrape runs on the worker.
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Best-effort wake ping so the worker skips its ~3s poll. Never blocks. */
async function wakeWorker(jobId: string): Promise<void> {
  const workerUrl = process.env.WASSEL_DECK_WORKER_URL;
  if (!workerUrl) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    await fetch(`${workerUrl.replace(/\/$/, '')}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
  } catch (err) {
    console.warn(`[rega-lookup] wake ping failed (non-fatal): ${(err as Error).message}`);
  }
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
    if (req.method !== 'POST') return jsonError(405, 'Method not allowed');

    let body: { recordId?: string };
    try {
      body = (await req.json()) as { recordId?: string };
    } catch {
      return jsonError(400, 'invalid JSON body');
    }

    const recordId = body.recordId;
    if (!recordId || typeof recordId !== 'string' || !UUID_RE.test(recordId)) {
      return jsonError(400, 'a valid recordId is required');
    }

    // Access gate: the caller must be able to SEE this listing under RLS before
    // the service-role enqueue. Throws AuthError(403) → withAuth maps it.
    await assertCanAccessRecord(req, recordId, 'api:rega-lookup');

    const sb = makeServiceClient('api:rega-lookup');
    if (!sb) return jsonError(500, 'server env missing: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');

    const { data: jobId, error: enqErr } = await sb.rpc('rega_lookup_job_enqueue', {
      p_listing_record_id: recordId,
      p_user_id: user.userId,
    });
    if (enqErr || !jobId) {
      return jsonError(500, `failed to enqueue rega lookup: ${enqErr?.message ?? 'unknown'}`);
    }

    console.log(`[rega-lookup] queued job=${jobId} listing=${recordId} user=${user.userId}`);
    void wakeWorker(jobId as string);
    return jsonOk({ job_id: jobId }, 202);
  });

  await writeWebResponseToNode(resp, nodeRes);
}
