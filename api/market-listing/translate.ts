/**
 * POST /api/market-listing/translate
 *
 * ON-DEMAND English translation for a SINGLE market listing. The operator
 * triggers this per-listing from the record form ("Translate to English"); it
 * is NOT part of the eager durable translation pipeline (market_listings is a
 * frozen model excluded from that by decision D-2, and the operator wants
 * translation only when explicitly requested).
 *
 * Flow: RLS-gate the listing (read its Arabic `title`/`description` through the
 * caller's OWN JWT so Postgres RLS decides access) → translate AR→EN with
 * DeepSeek (Claude Haiku fallback, same posture as /api/translate) → persist
 * into the `title_en`/`description_en` columns via the row-locked
 * `market_listing_set_translation` RPC (service role). The persisted English
 * then flows through `market_listings_v` → `unified_records` and renders in the
 * form's read-only English fields.
 *
 * Runtime: edge — a short, bursty, interactive call (two strings). NOT a
 * long-running job; the "never hold an HTTP request open" worker rule targets
 * multi-minute generation, not this.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { withAuth, jsonError, jsonOk, AuthError } from '../_lib/auth.js';
import { deepseekEnabled, deepseekJson, logDeepseekFallback } from '../_lib/deepseek.js';
import { makeServiceClient, serviceIdentityHeaders } from '../_lib/serviceClient.js';

export const config = { runtime: 'edge' };

const SERVICE_NAME = 'api:market-listing-translate';
const MAX_CHARS = 8000;

interface RequestBody {
  id?: string;
}

interface TranslationOut {
  title_en: string;
  description_en: string;
}

const SYSTEM_PROMPT = `You translate Saudi Arabian real-estate listing text from Arabic to English for Wassel Real Estate (وصل العقارية).

You receive a listing's title and description (Arabic). Return an English translation of each.

Rules:
- Translate naturally and FAITHFULLY into professional real-estate English. Do not summarize, embellish, or drop anything.
- Keep EVERY fact exactly: numbers, prices, areas, dimensions, room counts, directions (north/south/east/west), street names, district and city names, phone numbers, and codes. Digits stay as digits.
- Transliterate Saudi place and street names the way they are written in English (e.g. حي النرجس → "Al Narjis district", شارع الملك سلمان → "King Salman Road").
- If an input field is empty, return an empty string for it.
- Output ONLY the two fields; never add commentary.`;

const TOOL_SCHEMA = {
  name: 'listing_translation',
  description: 'Return the English translation of the listing title and description.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title_en: { type: 'string', description: 'English translation of the title (empty string if the title is empty).' },
      description_en: { type: 'string', description: 'English translation of the description (empty string if the description is empty).' },
    },
    required: ['title_en', 'description_en'],
  },
};

function buildUserMessage(title: string, description: string): string {
  return `Translate this listing to English.\n\nTitle (Arabic):\n${title || '(empty)'}\n\nDescription (Arabic):\n${description || '(empty)'}`;
}

/** RLS-gated read of the listing through the caller's JWT (frozen_view policy). */
async function readListing(req: Request, id: string): Promise<{ title: string; description: string }> {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new AuthError(500, 'Supabase env vars missing (URL or anon key)');
  const authHeader = req.headers.get('Authorization') ?? '';
  const scoped = createClient(url, anonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeader, ...serviceIdentityHeaders(SERVICE_NAME) } },
  });
  // Only market listings live in this table, so a hit both gates access AND
  // confirms the id is a market listing. RLS denial → zero rows → 403.
  const { data, error } = await scoped
    .from('market_listings')
    .select('title, description')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new AuthError(500, `listing read failed: ${error.message}`);
  if (!data) throw new AuthError(403, 'not permitted for this listing (or it does not exist)');
  return {
    title: (typeof data.title === 'string' ? data.title : '').trim().slice(0, MAX_CHARS),
    description: (typeof data.description === 'string' ? data.description : '').trim().slice(0, MAX_CHARS),
  };
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, 'Method not allowed');

  return withAuth(req, async () => {
    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }
    const id = (body.id ?? '').trim();
    if (!id) return jsonError(400, 'id is required');

    let listing: { title: string; description: string };
    try {
      listing = await readListing(req, id);
    } catch (err) {
      if (err instanceof AuthError) return jsonError(err.status, err.message);
      throw err;
    }

    if (!listing.title && !listing.description) {
      return jsonError(400, 'listing has no Arabic title or description to translate');
    }

    const userMessage = buildUserMessage(listing.title, listing.description);
    let out: TranslationOut | null = null;

    // ── Primary: DeepSeek ────────────────────────────────────────────────
    if (deepseekEnabled()) {
      try {
        const raw = await deepseekJson<TranslationOut>({
          system: SYSTEM_PROMPT,
          user: userMessage,
          shape: '{"title_en": string, "description_en": string}',
          requiredKeys: ['title_en', 'description_en'],
          maxTokens: 8_000,
          timeoutMs: 30_000,
        });
        out = {
          title_en: typeof raw.title_en === 'string' ? raw.title_en.trim() : '',
          description_en: typeof raw.description_en === 'string' ? raw.description_en.trim() : '',
        };
      } catch (err) {
        logDeepseekFallback('/api/market-listing/translate', err);
        out = null;
      }
    }

    // ── Fallback: Claude Haiku (forced tool) ─────────────────────────────
    if (!out) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return jsonError(502, 'translation providers are not configured');
      const client = new Anthropic({ apiKey });
      let response;
      try {
        response = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 8_000,
          system: SYSTEM_PROMPT,
          tools: [TOOL_SCHEMA],
          tool_choice: { type: 'tool', name: 'listing_translation' },
          messages: [{ role: 'user', content: userMessage }],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonError(502, `Translation failed: ${msg}`);
      }
      const toolBlock = response.content.find((b) => b.type === 'tool_use');
      if (toolBlock && toolBlock.type === 'tool_use') {
        const input = toolBlock.input as Partial<TranslationOut>;
        out = {
          title_en: typeof input.title_en === 'string' ? input.title_en.trim() : '',
          description_en: typeof input.description_en === 'string' ? input.description_en.trim() : '',
        };
      }
      if (!out) return jsonError(502, 'Translation model returned no result');
    }

    // Only translate the sides that had source text (guard against a model
    // hallucinating content for an empty field).
    const titleEn = listing.title ? out.title_en : '';
    const descriptionEn = listing.description ? out.description_en : '';
    if (!titleEn && !descriptionEn) {
      return jsonError(502, 'Translation returned empty output');
    }

    // Persist via the row-locked RPC (service role). Empty sides are left as-is
    // by the RPC (COALESCE(NULLIF(...), existing)).
    const service = makeServiceClient(SERVICE_NAME);
    if (!service) return jsonError(500, 'service credentials are not configured');
    const { error: rpcErr } = await service.rpc('market_listing_set_translation', {
      p_id: id,
      p_title_en: titleEn,
      p_description_en: descriptionEn,
    });
    if (rpcErr) return jsonError(502, `saving the translation failed: ${rpcErr.message}`);

    return jsonOk({ ok: true, title_en: titleEn, description_en: descriptionEn });
  });
}
