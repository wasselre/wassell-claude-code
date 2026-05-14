/**
 * POST /api/icons/generate
 *
 * Generate a single icon from a user-provided description (the "Generate"
 * tab in `IconPickerModal`), upload it to
 * `marketing-assets/icons/generated/<uuid>.<ext>`, and return the public URL.
 *
 * Body: `{ prompt: string, style?: string }`.
 *
 * Routes through fal.ai's recraft-v3 text-to-image with the
 * `vector_illustration/line_art` style by default — the closest recraft
 * substyle to the website's hand-coded Lucide-style monolines. Per
 * recraft-v3's output behavior, `vector_illustration/*` returns SVG; we
 * sniff the bytes and store with the matching content type so browsers
 * actually render it (an earlier bug saved SVG as `image/png` and every
 * icon broke).
 *
 * Loud failures only — per CLAUDE.md "Silent Failures":
 *   - fal.ai non-2xx / FAILED queue state → 502 with the upstream error.
 *   - storage upload error → 500 with the storage error.
 *   - missing JWT / invalid JWT → 401 (via withAuth).
 *
 * Auth: requires the caller's Supabase JWT; the upload uses that JWT so
 * the bucket's authenticated-write RLS applies.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import { imageGenIcon, pollImageGen } from '../_lib/imageGen.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

interface RequestBody {
  prompt?: string;
  style?: string;
}

const WASSEL_STYLE_PREFIX =
  'Minimal flat icon, single line weight, monoline outline only, '
  + 'copper #B8734F stroke, transparent background, centered, no fill, '
  + 'no gradient, no shadow, no text. Subject: ';

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
    const userPrompt = body.prompt?.trim();
    if (!userPrompt) return jsonError(400, 'prompt is required');
    if (userPrompt.length > 300) {
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

    const fullPrompt = `${WASSEL_STYLE_PREFIX}${userPrompt}.`;
    const start = await imageGenIcon({ prompt: fullPrompt, style: body.style });
    const result = await pollImageGen(start, { intervalMs: 1500, timeoutMs: 55_000 });
    if (result.status !== 'completed' || !result.imageUrls?.[0]) {
      const detail = result.rawError ? `: ${result.rawError}` : '';
      return jsonError(502, `icon generation ${result.status}${detail}`);
    }

    const srcRes = await fetch(result.imageUrls[0]);
    if (!srcRes.ok) {
      return jsonError(502, `failed to fetch generated icon: ${srcRes.status}`);
    }
    const bytes = new Uint8Array(await srcRes.arrayBuffer());
    // recraft `vector_illustration/*` returns SVG even when the response
    // URL ends `.png`. Sniff the bytes so we store with the right
    // extension + content type (browsers refuse to render SVG bytes
    // labelled image/png).
    const head = new TextDecoder().decode(bytes.slice(0, 200)).trimStart();
    const isSvg = head.startsWith('<svg') || head.startsWith('<?xml');
    const ext = isSvg ? 'svg' : 'png';
    const contentType = isSvg ? 'image/svg+xml' : 'image/png';
    const path = `icons/generated/${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from('marketing-assets')
      .upload(path, bytes, {
        contentType,
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
