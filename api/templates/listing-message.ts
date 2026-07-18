/**
 * POST /api/templates/listing-message
 *
 * Writes a bilingual WhatsApp marketing message for ONE market_listings record.
 * Input: { listing_id }. Output: { ok, body_ar, body_en, facts }.
 *
 * Why AI (not deterministic token-fill like the project generator): the listing's
 * features/amenities live only in its free-text Arabic `description`, so they need
 * extracting. We resolve the STRUCTURED facts server-side (unit type, district +
 * city, area, bedrooms, bathrooms) and hand them + the description to Claude, which
 * writes attractive copy that weaves the amenities in. Claude is told to use ONLY
 * the supplied facts — it must not invent prices, areas, or features.
 *
 * The geography names (district/city) are resolved from the frozen geo models via
 * the unified_records view server-side, so the browser needn't have geo loaded.
 * The matching photo-cleaning runs separately on /api/templates/clean-listing-images.
 *
 * Loud failures only (CLAUDE.md): 401 (auth), 400 (validation), 404 (listing),
 * 500 (env), 502 (Anthropic).
 */

import type { IncomingMessage, ServerResponse } from 'http';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk } from '../_lib/auth.js';
import { getServiceClient } from '../_lib/files.js';
import { qwenRoutingEnabled, qwenJson, logQwenFallback } from '../_lib/textLlm.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

interface RequestBody {
  listing_id?: string;
}

interface ListingFacts {
  title: string | null;
  property_type: string | null;
  district: string | null;
  city: string | null;
  area: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  price: number | null;
  description: string | null;
}

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

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function asFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function oneId(v: unknown): string | null {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : null;
  return typeof v === 'string' && v ? v : null;
}

const SYSTEM_PROMPT = `You are a real-estate marketing copywriter for Wassel Real Estate (وصل العقارية), a Saudi company. You write short, attractive WhatsApp messages that advertise a single property listing to a potential buyer.

You are given STRUCTURED FACTS (unit type, district, city, area in m², bedrooms, bathrooms, optional price) plus the listing's free-text Arabic DESCRIPTION. Write the message by calling \`write_listing_message\`.

Rules:
1. Write in BOTH languages: body_ar (Arabic, the primary) and body_en (a faithful English equivalent).
2. The message MUST mention, where present: the unit type, the district, the area (m²), the number of bedrooms, and the number of bathrooms.
3. Extract the features / amenities ONLY from the DESCRIPTION (e.g. private pool, elevator, maid's room, parking, finishing quality, near a mosque/school) and weave the real ones in. Do NOT invent amenities, prices, areas, or any fact not given.
4. Use Saudi Riyal (ر.س / SAR) if a price is provided; never invent a price.
5. Keep it concise and WhatsApp-friendly (a short intro line + the key facts). A few tasteful emojis are fine; do not overuse them.
6. END the message after the key facts — the LAST line is the price (or the last available fact if there is no price). Do NOT add any closing line: NO call to action, NO "للتواصل والاستفسار", NO contact/inquiry line, NO agency name or sign-off (e.g. «وصل العقارية» / «لقطة وصل» / «Wassel»). Nothing after the facts.
7. Natural marketing tone — not a dry field list. NEVER write prose outside the tool; ALWAYS call write_listing_message.`;

const TOOL_SCHEMA = {
  name: 'write_listing_message',
  description: 'Return the bilingual WhatsApp marketing message for the listing.',
  input_schema: {
    type: 'object' as const,
    properties: {
      body_ar: { type: 'string', description: 'The Arabic WhatsApp message (primary).' },
      body_en: { type: 'string', description: 'A faithful English equivalent of the same message.' },
    },
    required: ['body_ar', 'body_en'],
  },
};

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
    const listingId = body.listing_id?.trim();
    if (!listingId) return jsonError(400, 'listing_id is required');

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

    // RLS-gate the listing under the caller's JWT; read its full data.
    const { data: mlModel, error: mlErr } = await jwtClient
      .from('models').select('id').eq('name', 'market_listings').single();
    if (mlErr || !mlModel) return jsonError(500, `market_listings model not found: ${mlErr?.message ?? ''}`);
    const { data: listingRow, error: listingErr } = await jwtClient
      .from('records')
      .select('data')
      .eq('id', listingId)
      .eq('model_id', mlModel.id as string)
      .single();
    if (listingErr || !listingRow) return jsonError(404, `listing not found: ${listingErr?.message ?? listingId}`);
    const ld = (listingRow.data ?? {}) as Record<string, unknown>;

    // Resolve district / city display names from the (frozen) geo models via
    // unified_records. Reference data — service role read, non-sensitive.
    const resolveGeoName = async (id: string | null): Promise<string | null> => {
      if (!id) return null;
      const { data } = await svc.from('unified_records').select('data').eq('id', id).maybeSingle();
      const gd = (data as { data?: Record<string, unknown> } | null)?.data ?? null;
      if (!gd) return null;
      return asString(gd.display_name) ?? asString(gd.name_ar) ?? asString(gd.name_en);
    };
    const loc =
      ld.location && typeof ld.location === 'object' && !Array.isArray(ld.location)
        ? (ld.location as Record<string, unknown>)
        : {};
    const district = await resolveGeoName(oneId(loc.district));
    const city = await resolveGeoName(oneId(loc.city));

    const facts: ListingFacts = {
      title: asString(ld.title),
      property_type: asString(ld.property_type),
      district,
      city,
      area: asFiniteNumber(ld.area),
      bedrooms: asFiniteNumber(ld.bedrooms),
      bathrooms: asFiniteNumber(ld.bathrooms),
      price: asFiniteNumber(ld.price),
      description: asString(ld.description),
    };

    const userContent = `STRUCTURED FACTS (JSON):
${JSON.stringify(
  {
    unit_type: facts.property_type,
    district: facts.district,
    city: facts.city,
    area_m2: facts.area,
    bedrooms: facts.bedrooms,
    bathrooms: facts.bathrooms,
    price_sar: facts.price,
  },
  null,
  2,
)}

LISTING DESCRIPTION (Arabic free text — extract amenities/features from here only):
${facts.description ?? '(no description provided)'}`;

    // ── Primary: Qwen on Cloudflare Workers AI (writing/translation routing) ──
    if (qwenRoutingEnabled()) {
      try {
        const out = await qwenJson<{ body_ar: string; body_en: string }>({
          system: SYSTEM_PROMPT.replace(
            ' Write the message by calling `write_listing_message`.',
            '',
          ).replace(' NEVER write prose outside the tool; ALWAYS call write_listing_message.', ''),
          user: userContent,
          shape: '{"body_ar": string, "body_en": string}',
          requiredKeys: ['body_ar', 'body_en'],
          maxTokens: 3_000,
          timeoutMs: 55_000,
        });
        const qAr = asString(out.body_ar);
        const qEn = asString(out.body_en);
        if (qAr || qEn) {
          return jsonOk({ ok: true, body_ar: qAr ?? '', body_en: qEn ?? '', facts });
        }
        throw new Error('qwen returned an empty message');
      } catch (err) {
        logQwenFallback('/api/templates/listing-message', err);
      }
    }

    // ── Fallback: Claude force-tool (original path, unchanged) ─────────
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return jsonError(500, 'ANTHROPIC_API_KEY is not configured');
    const client = new Anthropic({ apiKey });
    let response;
    try {
      response = await client.messages.create({
        // claude-opus-4-7 — the alias api/_lib/aiAgent.ts uses and that
        // api/templates/generate-from-description.ts proved valid for this account.
        model: 'claude-opus-4-7',
        max_tokens: 2_000,
        system: SYSTEM_PROMPT,
        tools: [TOOL_SCHEMA],
        tool_choice: { type: 'tool', name: 'write_listing_message' },
        messages: [{ role: 'user', content: userContent }],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonError(502, `Anthropic call failed: ${msg}`);
    }

    const toolBlock = response.content.find((b) => b.type === 'tool_use');
    if (!toolBlock || toolBlock.type !== 'tool_use') {
      return jsonError(502, 'Claude did not call the write_listing_message tool');
    }
    const out = toolBlock.input as { body_ar?: string; body_en?: string };
    const bodyAr = asString(out.body_ar);
    const bodyEn = asString(out.body_en);
    if (!bodyAr && !bodyEn) return jsonError(502, 'Claude returned an empty message');

    return jsonOk({ ok: true, body_ar: bodyAr ?? '', body_en: bodyEn ?? '', facts });
  });
  await writeWebResponseToNode(resp, nodeRes);
}
