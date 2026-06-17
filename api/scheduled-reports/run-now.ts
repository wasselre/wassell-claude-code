/**
 * POST /api/scheduled-reports/run-now  — "Run now" from the admin UI.
 *
 * User-JWT authenticated. Authorization reuses RLS: only a caller who can SELECT
 * the report (admin, per scheduled_reports' admin-RLS) may run it. The compute
 * itself is owner-scoped inside runReportById (the owner's minted JWT), exactly
 * like a scheduled run — so "Run now" and the schedule produce identical output.
 *
 * Body: { report_id } → 200 { result } | 401 | 403 | 400
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import { runReportById } from '../_lib/reportRunner.js';

export const config = { runtime: 'nodejs', maxDuration: 120 };

async function readNodeBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function nodeToWebRequest(nodeReq: IncomingMessage): Promise<Request> {
  const host = (nodeReq.headers.host as string | undefined) ?? 'localhost';
  const url = new URL(nodeReq.url ?? '/', `https://${host}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const method = nodeReq.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readNodeBody(nodeReq);
  return new Request(url.toString(), { method, headers, body });
}
async function writeWebResponseToNode(webResp: Response, nodeRes: ServerResponse): Promise<void> {
  nodeRes.statusCode = webResp.status;
  for (const [k, v] of webResp.headers) nodeRes.setHeader(k, v);
  nodeRes.end(Buffer.from(await webResp.arrayBuffer()));
}

async function mainHandler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, 'method not allowed');
  return withAuth(req, async (_user) => {
    let reportId: string | undefined;
    try {
      reportId = ((await req.json()) as { report_id?: string }).report_id;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    if (!reportId) return jsonError(400, 'report_id is required');

    // Authz via RLS: the caller must be able to read this report (admin-only).
    const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !anonKey) return jsonError(500, 'Supabase env vars missing');
    const jwt = (req.headers.get('Authorization') ?? '').slice(7).trim();
    const caller = createClient(url, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const { data, error } = await caller.from('scheduled_reports').select('id').eq('id', reportId).maybeSingle();
    if (error) return jsonError(500, `authz check failed: ${error.message}`);
    if (!data) return jsonError(403, 'not allowed to run this report');

    const result = await runReportById(reportId, 'manual');
    return jsonOk({ result });
  });
}

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  let webReq: Request;
  try {
    webReq = await nodeToWebRequest(nodeReq);
  } catch (err) {
    nodeRes.statusCode = 500;
    nodeRes.setHeader('Content-Type', 'application/json');
    nodeRes.end(JSON.stringify({ error: `request adapter failed: ${err instanceof Error ? err.message : String(err)}` }));
    return;
  }
  await writeWebResponseToNode(await mainHandler(webReq), nodeRes);
}
