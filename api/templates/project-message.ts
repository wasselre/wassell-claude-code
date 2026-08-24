/**
 * POST /api/templates/project-message
 *
 * DETERMINISTIC WhatsApp marketing message for ONE of our own projects — the
 * no-LLM sibling of project-message-ai. Thin wrapper over the shared builder
 * `api/_lib/projectSheet.ts` (which reuses the app's canonical composer verbatim:
 * available-only prices, exact house labels).
 *
 * Auth: shared WHATSAPP_AI_SECRET (headless, service-role read) OR a user JWT
 * (RLS-gated read). Input: { project_id? , project_name? } (one required).
 * Output: { ok, project_id, body_ar, body_en, facts, missing }
 *       | { not_found } | { ambiguous, matches } | { error }
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import { getServiceClient } from '../_lib/files.js';
import { resolveProjectSheet, type SheetResult } from '../_lib/projectSheet.js';

export const config = { runtime: 'nodejs', maxDuration: 30 };

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
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function sheetToResponse(r: SheetResult): Response {
  if (r.ok) return jsonOk({ ok: true, project_id: r.project_id, body_ar: r.body_ar, body_en: r.body_en, facts: r.facts, missing: r.missing });
  if (r.reason === 'not_found') return jsonOk({ not_found: true });
  if (r.reason === 'ambiguous') return jsonOk({ ambiguous: true, matches: r.matches }, 409);
  return jsonError(r.message?.includes('not found') ? 404 : 500, r.message ?? 'error');
}

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  const req = await nodeToWebRequest(nodeReq);
  if (req.method !== 'POST') { await writeWebResponseToNode(jsonError(405, 'Method not allowed'), nodeRes); return; }

  let body: { project_id?: string; project_name?: string };
  try { body = (await req.clone().json()) as typeof body; }
  catch { await writeWebResponseToNode(jsonError(400, 'invalid JSON body'), nodeRes); return; }
  const projectId = body.project_id?.trim() || undefined;
  const projectName = body.project_name?.trim() || undefined;
  if (!projectId && !projectName) { await writeWebResponseToNode(jsonError(400, 'project_id or project_name is required'), nodeRes); return; }

  const svc = getServiceClient();
  const aiSecret = process.env.WHATSAPP_AI_SECRET;
  const provided = req.headers.get('x-wassel-ai-secret') ?? '';

  if (aiSecret && provided && constantTimeEqual(provided, aiSecret)) {
    const r = await resolveProjectSheet(svc, svc, { projectId, projectName });
    await writeWebResponseToNode(sheetToResponse(r), nodeRes);
    return;
  }

  const resp = await withAuth(req, async () => {
    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    const auth = req.headers.get('Authorization') ?? '';
    const jwt = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    if (!supabaseUrl || !anonKey || !jwt) return jsonError(500, 'Supabase env vars missing or JWT absent');
    const jwtClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    return sheetToResponse(await resolveProjectSheet(jwtClient, svc, { projectId, projectName }));
  });
  await writeWebResponseToNode(resp, nodeRes);
}
