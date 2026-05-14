/**
 * POST /api/icons/generate
 *
 * Generate a single icon from a user-provided description (and optional
 * reference image) using Nano Banana 2 (Google Gemini 3 Pro Image)
 * served via fal.ai. Result is uploaded to
 * `marketing-assets/icons/generated/<uuid>.<ext>` and returned as a
 * public URL.
 *
 * Body: `{ prompt?, image_data_url?, mode? }`.
 *   - At least one of `prompt` or `image_data_url` is required.
 *   - `mode` (only meaningful with an image) is `'exact'` or
 *     `'reference'`. Both modes force Wassel branding via the prompt;
 *     'exact' tells the model to trace the subject; 'reference' tells
 *     it to take the subject only as inspiration.
 *
 * Engine choice: Nano Banana 2 is multi-modal — same model can do
 * text-to-image AND image-edit, so we get one consistent style for
 * both Generate-tab branches. Falls through fal.ai's queue API
 * (startNanoBanana → pollImageGen) just like the marketing-deck flow.
 *
 * Loud failures only — per CLAUDE.md "Silent Failures":
 *   - fal.ai non-2xx → 502 with upstream body.
 *   - storage upload error → 500.
 *   - missing JWT → 401 (via withAuth).
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import { imageGenIcon, imageGenIconEdit, pollImageGen } from '../_lib/imageGen.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

type Mode = 'exact' | 'reference';

interface RequestBody {
  prompt?: string;
  /**
   * Optional reference image as a base64 data URL
   * (`data:image/<png|jpeg|webp|gif>;base64,<payload>`). Frontend is
   * expected to compress client-side first; server enforces 5 MB as
   * a safety net.
   */
  image_data_url?: string;
  /** Required when `image_data_url` is set; defaults to 'reference'. */
  mode?: Mode;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface ParsedImage {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  ext: string;
  contentType: string;
}

function parseDataUrl(input: string): ParsedImage | { error: string } {
  const m = /^data:([a-z]+\/[a-z0-9+.-]+);base64,(.+)$/i.exec(input.trim());
  if (!m) return { error: 'image_data_url must be a base64 data URL' };
  const mediaType = m[1].toLowerCase();
  const allowed: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  if (!(mediaType in allowed)) return { error: `unsupported image type: ${mediaType}` };
  const base64 = m[2];
  const approxBytes = Math.floor((base64.length * 3) / 4);
  if (approxBytes > MAX_IMAGE_BYTES) {
    return { error: `image too large (${Math.round(approxBytes / 1024)} KB, max 5 MB)` };
  }
  return {
    base64,
    mediaType: mediaType as ParsedImage['mediaType'],
    ext: allowed[mediaType],
    contentType: mediaType,
  };
}

// Wassel brand framing applied to every generation prompt — Nano Banana
// honors style guidance much more reliably when it's spelled out.
const WASSEL_STYLE =
  'Style: minimal flat vector icon in the Lucide / Heroicons family. '
  + 'Single line weight, monoline outline only, stroke color exactly '
  + '#B8734F (Wassel copper). Transparent background. No fill, no '
  + 'gradient, no shadow, no text. 24x24 viewBox spirit, centered.';

function buildPrompt(opts: { userPrompt: string; mode: Mode; hasImage: boolean }): string {
  const { userPrompt, mode, hasImage } = opts;
  if (!hasImage) {
    return `${WASSEL_STYLE}\n\nSubject: ${userPrompt}.`;
  }
  const modeInstruction = mode === 'exact'
    ? 'Recreate the subject and silhouette of the attached image as a single monoline icon. Preserve its shape; do not invent new objects. Ignore the image colors entirely.'
    : 'Use the attached image ONLY as visual inspiration for the subject. Design a clean minimalist icon of that subject; do not trace the photo.';
  const tail = userPrompt ? `\n\nAdditional context: ${userPrompt}.` : '';
  return `${WASSEL_STYLE}\n\n${modeInstruction}${tail}`;
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
    const userPrompt = body.prompt?.trim() ?? '';
    if (userPrompt.length > 300) {
      return jsonError(400, 'prompt is too long (max 300 chars)');
    }

    let image: ParsedImage | undefined;
    if (body.image_data_url) {
      const parsed = parseDataUrl(body.image_data_url);
      if ('error' in parsed) return jsonError(400, parsed.error);
      image = parsed;
    }
    if (!userPrompt && !image) {
      return jsonError(400, 'prompt or image_data_url is required');
    }
    const mode: Mode = body.mode === 'exact' ? 'exact' : 'reference';

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

    // If the user provided a reference image, upload it to the bucket
    // first — Nano Banana 2 fetches input bytes by URL.
    let referenceUrl: string | undefined;
    if (image) {
      const refBytes = Uint8Array.from(Buffer.from(image.base64, 'base64'));
      const refPath = `icons/reference/${crypto.randomUUID()}.${image.ext}`;
      const { error: upErr } = await supabase.storage
        .from('marketing-assets')
        .upload(refPath, refBytes, {
          contentType: image.contentType,
          upsert: false,
        });
      if (upErr) {
        return jsonError(500, `reference image upload failed: ${upErr.message}`);
      }
      const { data } = supabase.storage.from('marketing-assets').getPublicUrl(refPath);
      referenceUrl = data?.publicUrl;
      if (!referenceUrl) {
        return jsonError(500, 'reference image uploaded but URL could not be resolved');
      }
    }

    const fullPrompt = buildPrompt({ userPrompt, mode, hasImage: !!image });

    const start = referenceUrl
      ? await imageGenIconEdit({ prompt: fullPrompt, imageUrls: [referenceUrl] })
      : await imageGenIcon({ prompt: fullPrompt });
    const result = await pollImageGen(start, { intervalMs: 1500, timeoutMs: 55_000 });
    if (result.status !== 'completed' || !result.imageUrls?.[0]) {
      const detail = result.rawError ? `: ${result.rawError}` : '';
      return jsonError(502, `icon generation ${result.status}${detail}`);
    }

    // Fetch the fal.ai result URL and re-host in our bucket so the
    // stored URL is stable. Sniff bytes for SVG-as-PNG mislabeling
    // (Nano Banana usually returns true PNG, but be defensive).
    const srcRes = await fetch(result.imageUrls[0]);
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
      .upload(path, bytes, { contentType, upsert: false });
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
