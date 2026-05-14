/**
 * POST /api/icons/generate
 *
 * Generate a single SVG icon from a user-provided description, upload
 * it to `marketing-assets/icons/generated/<uuid>.svg`, and return the
 * public URL. Used by `IconPickerModal` on the "Generate" tab.
 *
 * Body: `{ prompt: string }`. The prompt is the user's raw description
 * ("rooftop swimming pool"); the brand framing + monoline-Wassel-copper
 * style live in the Claude system prompt server-side, so every icon is
 * consistent regardless of caller.
 *
 * Loud failures only — per CLAUDE.md "Silent Failures":
 *   - Anthropic non-2xx / malformed SVG → throws → 502 with the message.
 *   - storage upload error → 500 with the storage error.
 *   - missing JWT / invalid JWT → 401 (via withAuth).
 *
 * Auth: requires the caller's Supabase JWT; the upload uses that JWT so
 * the bucket's authenticated-write RLS applies. No service-role usage.
 *
 * History: previously called fal.ai's recraft-v3, which produced busy
 * editorial illustrations rather than clean flat icons. Switched to
 * Claude (Sonnet 4.6) because it reliably emits minimal monoline SVGs
 * matching the Wassel brand when forced through a strict tool schema.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import { generateIconSvg } from '../_lib/iconGenClaude.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 30,
};

interface RequestBody {
  prompt?: string;
}

/* ─── Node ↔ Web Request adapter ─────────────────────────────────── */

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

/* ─── Main handler ───────────────────────────────────────────────── */

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
    const prompt = body.prompt?.trim();
    if (!prompt) return jsonError(400, 'prompt is required');
    if (prompt.length > 300) {
      return jsonError(400, 'prompt is too long (max 300 chars)');
    }

    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
    const auth = req.headers.get('Authorization') ?? '';
    const jwt = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    if (!supabaseUrl || !anonKey || !jwt) {
      return jsonError(500, 'Supabase env vars missing or JWT absent');
    }
    const supabase = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });

    let svg: string;
    try {
      svg = await generateIconSvg({ prompt });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonError(502, `icon generation failed: ${msg}`);
    }

    const bytes = new TextEncoder().encode(svg);
    const path = `icons/generated/${crypto.randomUUID()}.svg`;
    const { error: upErr } = await supabase.storage
      .from('marketing-assets')
      .upload(path, bytes, {
        contentType: 'image/svg+xml',
        upsert: false,
      });
    if (upErr) {
      return jsonError(500, `icon upload failed: ${upErr.message}`);
    }
    const { data } = supabase.storage.from('marketing-assets').getPublicUrl(path);
    const publicUrl = data?.publicUrl;
    if (!publicUrl) {
      return jsonError(500, 'icon uploaded but public URL could not be resolved');
    }
    return jsonOk({ url: publicUrl });
  });
  await writeWebResponseToNode(resp, nodeRes);
}
