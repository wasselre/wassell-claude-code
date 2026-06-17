/**
 * POST /api/analytics
 *
 * Server-side execution of the universal analytics engine. Runs the SAME pure
 * `runAnalyticsQuery` the browser uses (`src/lib/analytics`) via the shared
 * `api/_lib/analyticsRun` helper — the one place that loads RLS-scoped records
 * and runs the engine (also used by the Scheduled Reports runner), so a result
 * can never disagree between the builder preview, the server, and a report.
 *
 * Body: { query: AnalyticsQuery, include_record_ids?: boolean, comparison?: boolean }
 * → 200 { result: AnalyticsResult } | 400 invalid query | 401 bad JWT
 *
 * Auth: `withAuth` validates the caller's Supabase JWT; the data client is the
 * anon key + the caller's `Authorization` header, so reads of `unified_records`
 * (security_invoker) apply the CALLER's RLS. NO service role here.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import { validateAnalyticsQuery } from '../src/lib/analytics/index.js';
import { prepareContext, runQueryWithClient } from './_lib/analyticsRun.js';
import type { AnalyticsQuery } from '../src/lib/analytics/types.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

interface RequestBody {
  query?: AnalyticsQuery;
  include_record_ids?: boolean;
  comparison?: boolean;
}

/* ─── Node ↔ Web Request/Response adapter (same as run-button-workflow) ─── */
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
  const buf = Buffer.from(await webResp.arrayBuffer());
  nodeRes.end(buf);
}

async function mainHandler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, `Method ${req.method} not allowed`);

  return withAuth(req, async (_user) => {
    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const query = body.query;
    const validationError = validateAnalyticsQuery(query);
    if (validationError || !query) return jsonError(400, validationError ?? 'query is required');

    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnonKey) return jsonError(500, 'Supabase env vars missing');

    // Caller-scoped client: anon key + the caller's JWT → unified_records reads
    // apply the CALLER's RLS.
    const jwt = (req.headers.get('Authorization') ?? '').slice(7).trim();
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    const prepared = await prepareContext(supabase);
    if (!prepared.modelsById.has(query.source_model_id)) {
      return jsonError(400, `unknown source_model_id: ${query.source_model_id}`);
    }
    const result = await runQueryWithClient(supabase, query, prepared, {
      includeRecordIds: !!body.include_record_ids,
      comparison: !!body.comparison,
    });
    return jsonOk({ result });
  });
}

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  let webReq: Request;
  try {
    webReq = await nodeToWebRequest(nodeReq);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    nodeRes.statusCode = 500;
    nodeRes.setHeader('Content-Type', 'application/json');
    nodeRes.end(JSON.stringify({ error: `request adapter failed: ${msg}` }));
    return;
  }
  const webResp = await mainHandler(webReq);
  await writeWebResponseToNode(webResp, nodeRes);
}
