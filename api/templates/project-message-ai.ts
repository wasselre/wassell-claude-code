/**
 * POST /api/templates/project-message-ai
 *
 * AI-REWRITES (or FACT-CHECKS) the WhatsApp marketing message for ONE of our own
 * projects (an `all_projects` record) from the project's CURRENT data — so a rep
 * sending a project message never has to trust a template written weeks ago
 * against a price/unit-mix that has since changed.
 *
 * Thin wrapper over the shared `api/_lib/projectMessageAi.ts` (the whole
 * generate/fact-check pipeline: full-record prompt, authoritative facts block,
 * provider selection, protected-fact guard). The WhatsApp bot flow
 * (api/_lib/aiSendProject.ts) calls the SAME shared function with a service-role
 * client, so there is one implementation and no internal HTTP hop.
 *
 * Input:  { project_id, provider?, existing_ar?, existing_en? }
 * Output: { ok, mode, body_ar, body_en, facts, generated_by }
 *
 * Loud failures only (CLAUDE.md): 401 (auth), 400 (validation), 404 (project),
 * 500 (env), 502 (provider / guard rejection).
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import { getServiceClient } from '../_lib/files.js';
import { generateProjectMessage } from '../_lib/projectMessageAi.js';

// Kimi on a large project record runs long (~40s measured); give headroom so a
// bigger record can't hit the timeout cliff. Well under Vercel Pro's 300s max.
export const config = { runtime: 'nodejs', maxDuration: 120 };

interface RequestBody {
  project_id?: string;
  provider?: 'anthropic' | 'kimi';
  existing_ar?: string;
  existing_en?: string;
}

// ── Node↔Web bridge (the nodejs runtime ignores a returned Web Response) ────
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

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  const req = await nodeToWebRequest(nodeReq);
  const resp = await withAuth(req, async (_user) => {
    if (req.method !== 'POST') return jsonError(405, 'Method not allowed');

    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const projectId = body.project_id?.trim();
    if (!projectId) return jsonError(400, 'project_id is required');

    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    const auth = req.headers.get('Authorization') ?? '';
    const jwt = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    if (!supabaseUrl || !anonKey || !jwt) return jsonError(500, 'Supabase env vars missing or JWT absent');
    const jwtClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const svc = getServiceClient();

    const r = await generateProjectMessage(jwtClient, svc, {
      projectId,
      provider: body.provider,
      existingAr: body.existing_ar,
      existingEn: body.existing_en,
    });
    if (!r.ok) return jsonError(r.status, r.error);
    return jsonOk({
      ok: true,
      mode: r.mode,
      body_ar: r.body_ar,
      body_en: r.body_en,
      facts: r.facts,
      generated_by: r.generated_by,
    });
  });
  await writeWebResponseToNode(resp, nodeRes);
}
