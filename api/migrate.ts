/**
 * POST /api/migrate — the AI backend for the Data Migration wizard.
 *
 * One Node function, dispatched on `action`:
 *   - extract          : signed-URL files (PDF/image) → one unified raw table
 *   - suggest_mappings : raw headers + samples + target fields → column→field map  (Phase 4)
 *   - standardize      : a column's distinct values → canonical option/lookup map (Phase 4)
 *
 * Node runtime (maxDuration 300) because vision extraction can take a couple of
 * minutes; the browser calls this directly and shows a spinner (no SSE — the
 * request returns the structured result). Auth via withAuth (Supabase JWT).
 * No service-role: the client mints short-lived signed URLs for its own
 * uploaded files and passes them here; we just fetch them.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import {
  runExtract,
  runSuggestMappings,
  runStandardize,
  type ExtractFileInput,
  type TargetFieldLite,
  type StandardizeCandidate,
} from './_lib/migrateAgent.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 300,
};

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

interface MigrateRequestBody {
  action?: 'extract' | 'suggest_mappings' | 'standardize';
  // extract
  files?: ExtractFileInput[];
  // suggest_mappings
  headers?: string[];
  sampleRows?: string[][];
  fields?: TargetFieldLite[];
  // standardize
  fieldType?: 'dropdown' | 'multiselect' | 'lookup';
  fieldLabel?: string;
  candidates?: StandardizeCandidate[];
  rawValues?: string[];
}

export default async function handler(nodeReq: IncomingMessage, nodeRes: ServerResponse): Promise<void> {
  const req = await nodeToWebRequest(nodeReq);
  const resp = await withAuth(req, async (_user) => {
    if (req.method !== 'POST') return jsonError(405, 'Method not allowed');
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return jsonError(500, 'ANTHROPIC_API_KEY is not configured');

    let body: MigrateRequestBody;
    try {
      body = (await req.json()) as MigrateRequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }

    switch (body.action) {
      case 'extract': {
        const files = Array.isArray(body.files) ? body.files : [];
        if (files.length === 0) return jsonError(400, 'extract: files[] is required');
        for (const f of files) {
          if (!f || typeof f.url !== 'string' || typeof f.name !== 'string') {
            return jsonError(400, 'extract: each file needs { name, mimeType, url }');
          }
        }
        try {
          const result = await runExtract(apiKey, files);
          return jsonOk({ ok: true, ...result });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return jsonError(502, `Extraction failed: ${msg}`);
        }
      }
      case 'suggest_mappings': {
        const headers = Array.isArray(body.headers) ? body.headers : [];
        const fields = Array.isArray(body.fields) ? body.fields : [];
        if (headers.length === 0 || fields.length === 0) {
          return jsonError(400, 'suggest_mappings: headers[] and fields[] are required');
        }
        try {
          const mappings = await runSuggestMappings(apiKey, {
            headers,
            sampleRows: Array.isArray(body.sampleRows) ? body.sampleRows : [],
            fields,
          });
          return jsonOk({ ok: true, mappings });
        } catch (err) {
          return jsonError(502, `Mapping failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      case 'standardize': {
        const fieldType = body.fieldType;
        const rawValues = Array.isArray(body.rawValues) ? body.rawValues : [];
        if (!fieldType || rawValues.length === 0) {
          return jsonError(400, 'standardize: fieldType and rawValues[] are required');
        }
        try {
          const decisions = await runStandardize(apiKey, {
            fieldType,
            fieldLabel: body.fieldLabel ?? '',
            candidates: Array.isArray(body.candidates) ? body.candidates : [],
            rawValues,
          });
          return jsonOk({ ok: true, decisions });
        } catch (err) {
          return jsonError(502, `Standardization failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      default:
        return jsonError(400, `unknown action "${body.action ?? ''}"`);
    }
  });
  await writeWebResponseToNode(resp, nodeRes);
}
