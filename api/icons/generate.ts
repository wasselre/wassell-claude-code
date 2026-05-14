/**
 * POST /api/icons/generate
 *
 * Generate a single icon PNG from a user-provided description, upload
 * it to `marketing-assets/icons/generated/<uuid>.png`, and return the
 * public URL. Used by `IconPickerModal` on the "Generate" tab.
 *
 * Body: `{ prompt: string }`. The prompt is the user's raw description
 * (e.g. "rooftop swimming pool"); we add the Wassel style framing on the
 * server so every generated icon looks consistent regardless of caller.
 *
 * Loud failures only — per CLAUDE.md "Silent Failures":
 *   - fal.ai non-2xx → throws → 500 with the upstream body.
 *   - storage upload error → 500 with the storage error.
 *   - missing JWT / invalid JWT → 401 (via withAuth).
 *
 * Auth: requires the caller's Supabase JWT; the upload uses that JWT so
 * the bucket's authenticated-write RLS applies (same posture as
 * `src/lib/imageUpload.ts`). No service-role usage here.
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
  /**
   * Optional style override forwarded to recraft-v3. Defaults to
   * `icon/broken_line` in `imageGenIcon` if omitted.
   */
  style?: string;
}

const WASSEL_STYLE_PREFIX =
  'Single real-estate icon, copper #B8734F outline on transparent background, ' +
  'flat vector, single line weight, centered, minimal, no text, no shadows. ' +
  'Subject: ';

/* ─── Node ↔ Web Request adapter (mirrors api/marketing/generate.ts) ─ */

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

    // Phase 1 — kick off fal.ai job and wait for the queue to terminate.
    const fullPrompt = `${WASSEL_STYLE_PREFIX}${userPrompt}.`;
    const start = await imageGenIcon({ prompt: fullPrompt, style: body.style });
    const result = await pollImageGen(start, { intervalMs: 1500, timeoutMs: 55_000 });
    if (result.status !== 'completed' || !result.imageUrls?.[0]) {
      const detail = result.rawError ? `: ${result.rawError}` : '';
      return jsonError(502, `icon generation ${result.status}${detail}`);
    }
    const sourceUrl = result.imageUrls[0];

    // Phase 2 — pull the fal.ai temp URL and re-upload to our bucket so
    // the resulting URL is stable, scoped to our project, and not subject
    // to fal.ai's expiry. recraft-v3's `vector_illustration` style returns
    // SVG even when the fal.ai response URL ends in `.png`, so sniff the
    // first bytes and store with the correct extension + content type —
    // otherwise the browser refuses to render SVG bytes labelled image/png.
    const srcRes = await fetch(sourceUrl);
    if (!srcRes.ok) {
      return jsonError(502, `failed to fetch generated icon: ${srcRes.status}`);
    }
    const bytes = new Uint8Array(await srcRes.arrayBuffer());
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
