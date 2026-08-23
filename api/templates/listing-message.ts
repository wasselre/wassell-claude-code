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
import { llmRoutingEnabled, llmJson, logLlmFallback } from '../_lib/textLlm.js';
import { resolveLocalizedName, type LocalizedName } from '../../src/lib/geo/localizedName.js';

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
  living_rooms: number | null;
  floors_count: number | null;
  age: string | null;
  frontage: string | null;
  street_width: number | null;
  features: string[];
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

You are given STRUCTURED FACTS (unit type, district, city, area in m², rooms, floors, age, frontage, street width, features, optional price) plus the listing's free-text Arabic DESCRIPTION. Write the message by calling \`write_listing_message\`.

Rules:
1. Write in BOTH languages: body_ar (Arabic, the primary) and body_en (a faithful English equivalent).
2. COVER EVERY FACT: the message must mention EVERY structured fact that is present (non-null), plus every real feature/amenity stated in the DESCRIPTION (e.g. private pool, elevator, maid's room, parking, finishing quality, furnished/unfurnished, utilities, near a mosque/school) — each summarized briefly, not quoted verbatim. Skip only facts that are null/absent. Do NOT invent amenities, prices, areas, or any fact not given.
3. FORMAT: a short attractive intro line naming the unit type + district/city, then ONE short line per fact (use "- " dashes), grouped sensibly (size/rooms together is fine). Keep each line tight — this is WhatsApp, summarize, never ramble.
   Domain terms — use the exact real-estate wording:
   - \`frontage\` is the building's FACADE direction (الواجهة): write «الواجهة غربية» / «الواجهة شمالية» … in Arabic (adjective form) and "West frontage" in English. NEVER call it مدخل / entrance.
   - \`street_width_m\` is عرض الشارع: «شارع عرض 20 م» / "on a 20 m street".
   - \`property_age\` قيمة «جديد» stays «جديد» / "Brand new".
4. Use Saudi Riyal (ر.س / SAR) if a price is provided; never invent a price.
5. GEOGRAPHY IS AUTHORITATIVE — NEVER INVENT IT. The facts carry \`district_ar\`/\`district_en\` and \`city_ar\`/\`city_en\` resolved from the company database. Use the \`_ar\` values VERBATIM in body_ar and the \`_en\` values VERBATIM in body_en. Do NOT transliterate, translate, re-spell, abbreviate, expand or "correct" them — copy them character for character. If a value is null, omit that place entirely; never guess it and never substitute the other language's value.
6. A few tasteful emojis are fine; do not overuse them.
7. END the message after the facts — the LAST line is the price (or the last available fact if there is no price). Do NOT add any closing line: NO call to action, NO "للتواصل والاستفسار", NO contact/inquiry line, NO agency name or sign-off (e.g. «وصل العقارية» / «لقطة وصل» / «Wassel»). Nothing after the facts.
8. Natural marketing tone — summarized facts, not a dry copy of the description. NEVER write prose outside the tool; ALWAYS call write_listing_message.`;

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

/**
 * Protected-fact validation (Issue #8).
 *
 * The authoritative place names are supplied to the model; this asserts the
 * model actually used them. A body that DROPPED or ALTERED a place name is
 * rejected rather than published — prompt instructions alone proved insufficient
 * (Qwen3 measured ~30% run-to-run variance on proper nouns, and produced
 * "Al-Muharraq" for «حي المهدية»).
 *
 * Deliberately NOT a blanket "no Arabic in the English body" rule: brand names
 * and intentionally untransliterated terms are legitimate. We assert only the
 * exact localized geography values.
 */
function assertGeographyIntact(args: {
  bodyAr: string | null;
  bodyEn: string | null;
  districtGeo: LocalizedName | null;
  cityGeo: LocalizedName | null;
  provider: string;
}): void {
  const { bodyAr, bodyEn, districtGeo, cityGeo, provider } = args;
  const violations: string[] = [];

  const checkAr = (geo: LocalizedName | null, level: string) => {
    if (!geo || !bodyAr) return;
    if (!bodyAr.includes(geo.ar)) violations.push(`body_ar is missing the authoritative ${level} «${geo.ar}»`);
  };
  const checkEn = (geo: LocalizedName | null, level: string) => {
    if (!geo || !bodyEn) return;
    // Accept either the display form ("Al Mahdiyah") or the canonical stored
    // form ("Al Mahdiyah Dist.") — both are authoritative, neither is invented.
    const ok = bodyEn.includes(geo.enDisplay) || bodyEn.includes(geo.enCanonical);
    if (!ok) violations.push(`body_en is missing the authoritative ${level} "${geo.enDisplay}"`);
    // The Arabic form must never appear in the English body.
    if (bodyEn.includes(geo.ar)) violations.push(`body_en contains the ARABIC ${level} «${geo.ar}» instead of "${geo.enDisplay}"`);
  };

  checkAr(districtGeo, 'district');
  checkAr(cityGeo, 'city');
  checkEn(districtGeo, 'district');
  checkEn(cityGeo, 'city');

  if (violations.length > 0) {
    // Loud, never silent — this is a correctness failure, not a style nit.
    console.error(`[listing-message] REJECTED ${provider} output — protected geography altered: ${violations.join('; ')}`);
    throw new Error(`generated message failed geography validation (${provider}): ${violations.join('; ')}`);
  }
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
    // unified_records spans records + frozen models (market_listings froze
    // 2026-08-07) with the same jsonb `data` shape; model_id still guards the id.
    const { data: listingRow, error: listingErr } = await jwtClient
      .from('unified_records')
      .select('data')
      .eq('id', listingId)
      .eq('model_id', mlModel.id as string)
      .single();
    if (listingErr || !listingRow) return jsonError(404, `listing not found: ${listingErr?.message ?? listingId}`);
    const ld = (listingRow.data ?? {}) as Record<string, unknown>;

    // Resolve district / city from the (frozen) geo models via unified_records.
    // Reference data — service role read, non-sensitive.
    //
    // ISSUE #8 — this used to return ONE Arabic string (`display_name ?? name_ar
    // ?? name_en`, where the name_en branch was unreachable because display_name
    // is Arabic and never null). The prompt then ordered the model to invent the
    // Latin spelling, and it rendered «حي المهدية» as "Al-Muharraq" — a city in
    // Bahrain — in a customer WhatsApp message. Both names are now resolved from
    // the authoritative record and handed to the model explicitly.
    const resolveGeoLocalized = async (id: string | null): Promise<LocalizedName | null> => {
      if (!id) return null;
      const { data } = await svc.from('unified_records').select('data').eq('id', id).maybeSingle();
      const gd = (data as { data?: Record<string, unknown> } | null)?.data ?? null;
      const localized = resolveLocalizedName(id, gd);
      if (!localized && gd) {
        console.error(
          `[listing-message] geography ${id} is not fully localized (missing name_en) — omitting from the message rather than letting the model invent an English name`,
        );
      }
      return localized;
    };
    const loc =
      ld.location && typeof ld.location === 'object' && !Array.isArray(ld.location)
        ? (ld.location as Record<string, unknown>)
        : {};
    const districtGeo = await resolveGeoLocalized(oneId(loc.district));
    const cityGeo = await resolveGeoLocalized(oneId(loc.city));
    const district = districtGeo?.ar ?? null;
    const city = cityGeo?.ar ?? null;

    const facts: ListingFacts = {
      title: asString(ld.title),
      property_type: asString(ld.property_type),
      district,
      city,
      area: asFiniteNumber(ld.area),
      bedrooms: asFiniteNumber(ld.bedrooms),
      bathrooms: asFiniteNumber(ld.bathrooms),
      living_rooms: asFiniteNumber(ld.living_rooms),
      floors_count: asFiniteNumber(ld.floors_count),
      age: asString(ld.age),
      frontage: asString(ld.frontage),
      street_width: asFiniteNumber(ld.street_width),
      features: Array.isArray(ld.features)
        ? (ld.features as unknown[]).filter((f): f is string => typeof f === 'string' && !!f.trim())
        : [],
      price: asFiniteNumber(ld.price),
      description: asString(ld.description),
    };

    const userContent = `STRUCTURED FACTS (JSON):
${JSON.stringify(
  {
    unit_type: facts.property_type,
    // ISSUE #8 — authoritative bilingual geography. The model must COPY these
    // verbatim into the matching language body and never transliterate.
    district_ar: districtGeo?.ar ?? null,
    district_en: districtGeo?.enDisplay ?? null,
    city_ar: cityGeo?.ar ?? null,
    city_en: cityGeo?.enDisplay ?? null,
    area_m2: facts.area,
    bedrooms: facts.bedrooms,
    bathrooms: facts.bathrooms,
    living_rooms: facts.living_rooms,
    floors: facts.floors_count,
    property_age: facts.age,
    frontage: facts.frontage,
    street_width_m: facts.street_width,
    features: facts.features.length > 0 ? facts.features : null,
    price_sar: facts.price,
  },
  null,
  2,
)}

LISTING DESCRIPTION (Arabic free text — extract amenities/features from here only):
${facts.description ?? '(no description provided)'}`;

    // ── Primary: DeepSeek (writing/translation routing) ──
    if (llmRoutingEnabled()) {
      try {
        const out = await llmJson<{ body_ar: string; body_en: string }>({
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
          // Protected-fact gate: a model that altered an authoritative place
          // name is REJECTED, not published. Throwing here routes to the
          // Anthropic fallback below, which is validated the same way.
          assertGeographyIntact({ bodyAr: qAr, bodyEn: qEn, districtGeo, cityGeo, provider: 'deepseek' });
          return jsonOk({
            ok: true, body_ar: qAr ?? '', body_en: qEn ?? '', facts,
            generated_by: 'deepseek:deepseek-chat',
          });
        }
        throw new Error('deepseek returned an empty message');
      } catch (err) {
        logLlmFallback('/api/templates/listing-message', err);
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

    // Same protected-fact gate as the DeepSeek path — no provider is trusted to
    // leave authoritative place names alone.
    try {
      assertGeographyIntact({ bodyAr, bodyEn, districtGeo, cityGeo, provider: 'anthropic' });
    } catch (err) {
      return jsonError(502, err instanceof Error ? err.message : String(err));
    }

    return jsonOk({
      ok: true, body_ar: bodyAr ?? '', body_en: bodyEn ?? '', facts,
      generated_by: 'anthropic:claude-opus-4-7',
    });
  });
  await writeWebResponseToNode(resp, nodeRes);
}
