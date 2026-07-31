/**
 * POST /api/value-translate
 *
 * Translates a batch of RECORD VALUES (free-typed data: project names, notes,
 * analyses) between Arabic and English and persists the results in the
 * `value_translations` cache table. The SPA calls this when its display
 * resolver misses the cache — the visible value stays in the source language
 * until the response lands, then re-renders translated. Records themselves are
 * NEVER written: translations are a display overlay keyed by sha256 of the
 * source text (edit the value → new hash → fresh translation; no invalidation
 * logic exists anywhere).
 *
 * Provider: DeepSeek primary (user decision 2026-07-31), Claude Haiku
 * fallback — same posture as /api/translate. One LLM call per request handles
 * the whole batch (≤25 items) as a JSON array in/out.
 *
 * Runtime: edge — bursty, short calls, same rationale as /api/translate.
 * This is NOT a long-running job (≤25 short strings, seconds); the "never hold
 * an HTTP request open" rule for the worker queues targets multi-minute
 * generation, not this.
 *
 * Kinds: 'name' → transliterate the way Saudi developers write names in Latin
 * script (or render in Arabic script for en→ar); 'text' → natural faithful
 * translation.
 */

import Anthropic from '@anthropic-ai/sdk';
import { withAuth, jsonError, jsonOk } from './_lib/auth.js';
import { deepseekEnabled, deepseekJson, logDeepseekFallback } from './_lib/deepseek.js';
import { makeServiceClient } from './_lib/serviceClient.js';

export const config = { runtime: 'edge' };

const MAX_ITEMS = 25;
const MAX_CHARS = 4000;

interface RequestItem {
  text?: string;
  kind?: 'name' | 'text';
  model_hint?: string;
  field_hint?: string;
}

interface RequestBody {
  target?: 'ar' | 'en';
  items?: RequestItem[];
}

interface BatchResultItem {
  i: number;
  t: string;
}

const SYSTEM_PROMPT = `You translate CRM record values between Arabic and English for a Saudi Arabian real-estate company (Wassel / وصل العقارية).

You will receive a JSON array of items: {"i": <index>, "kind": "name"|"text", "src": "<source text>"} and a target language.

Rules per kind:

1. **name** — proper nouns: project names, developer/company names, person names, unit model codes.
   - To English: TRANSLITERATE to Latin script the way Saudi developers write them in English marketing (e.g. "مساكن الأصيل" → "Masaken Al Aseel", "شركة الماجدية العقارية" → "Al Majdiah Real Estate"). Translate only generic words like شركة/مشروع when natural ("Company", "Project"); never invent a different name.
   - To Arabic: render the name in Arabic script the way Saudi media writes it.

2. **text** — notes, descriptions, analyses.
   - Translate naturally and FAITHFULLY. Keep every fact: numbers, prices, dates, directions, names. Professional real-estate register. Do not summarize, embellish, or drop anything.

3. Keep digits as-is. Keep URLs, phone numbers, and codes untouched.

4. Every item MUST appear in the output with its same index "i". Never skip, never reorder facts.`;

const TOOL_SCHEMA = {
  name: 'translate_values',
  description: 'Return the translated text for every input item.',
  input_schema: {
    type: 'object' as const,
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            i: { type: 'number', description: 'Index of the input item.' },
            t: { type: 'string', description: 'Translated text.' },
          },
          required: ['i', 't'],
        },
      },
    },
    required: ['results'],
  },
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Validate a batch translation output: every index present, non-empty text. */
function validateResults(raw: unknown, count: number): Map<number, string> | null {
  if (!raw || typeof raw !== 'object') return null;
  const arr = (raw as { results?: unknown }).results;
  if (!Array.isArray(arr)) return null;
  const out = new Map<number, string>();
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const { i, t } = item as Partial<BatchResultItem>;
    if (typeof i !== 'number' || typeof t !== 'string' || !t.trim()) continue;
    out.set(i, t.trim());
  }
  for (let i = 0; i < count; i++) {
    if (!out.has(i)) return null;
  }
  return out;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return jsonError(405, 'Method not allowed');

  return withAuth(req, async (_user) => {
    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return jsonError(400, 'invalid JSON body');
    }

    const target = body.target;
    if (target !== 'ar' && target !== 'en') return jsonError(400, "target must be 'ar' or 'en'");

    const items = (body.items ?? [])
      .map((it) => ({
        text: (it.text ?? '').trim(),
        kind: it.kind === 'name' ? 'name' : 'text',
        model_hint: (it.model_hint ?? '').slice(0, 80) || null,
        field_hint: (it.field_hint ?? '').slice(0, 80) || null,
      }))
      .filter((it) => it.text.length > 0 && it.text.length <= MAX_CHARS);
    if (items.length === 0) return jsonError(400, 'items is empty');
    if (items.length > MAX_ITEMS) return jsonError(400, `too many items — max ${MAX_ITEMS} per call`);

    const service = makeServiceClient('api:value-translate');
    if (!service) return jsonError(500, 'service credentials are not configured');

    const hashes = await Promise.all(items.map((it) => sha256Hex(it.text)));

    // Serve whatever the cache already has (another tab / the backfill may have
    // beaten us to it) and only pay for the misses.
    const { data: cachedRows, error: cacheErr } = await service
      .from('value_translations')
      .select('source_hash, translated_text')
      .eq('target_lang', target)
      .in('source_hash', hashes);
    if (cacheErr) return jsonError(502, `cache read failed: ${cacheErr.message}`);

    const cached = new Map<string, string>((cachedRows ?? []).map((r) => [r.source_hash as string, r.translated_text as string]));
    const missing = items
      .map((it, idx) => ({ ...it, hash: hashes[idx] ?? '' }))
      .filter((it) => it.hash !== '' && !cached.has(it.hash));

    const translated = new Map<string, string>();
    if (missing.length > 0) {
      const payload = missing.map((it, i) => ({ i, kind: it.kind, src: it.text }));
      const userMessage = `Target language: ${target === 'en' ? 'English' : 'Arabic'}.\nItems:\n${JSON.stringify(payload)}`;

      let results: Map<number, string> | null = null;

      // ── Primary: DeepSeek ────────────────────────────────────────────
      if (deepseekEnabled()) {
        try {
          const out = await deepseekJson<{ results: BatchResultItem[] }>({
            system: SYSTEM_PROMPT,
            user: userMessage,
            shape: '{"results":[{"i": number, "t": string}]}',
            requiredKeys: ['results'],
            maxTokens: 8_000,
            timeoutMs: 25_000,
          });
          results = validateResults(out, missing.length);
          if (!results) throw new Error('deepseek returned an incomplete batch');
        } catch (err) {
          logDeepseekFallback('/api/value-translate', err);
          results = null;
        }
      }

      // ── Fallback: Claude Haiku forced tool ───────────────────────────
      if (!results) {
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
            tool_choice: { type: 'tool', name: 'translate_values' },
            messages: [{ role: 'user', content: userMessage }],
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return jsonError(502, `Translation failed: ${msg}`);
        }
        const toolBlock = response.content.find((b) => b.type === 'tool_use');
        results = toolBlock && toolBlock.type === 'tool_use' ? validateResults(toolBlock.input, missing.length) : null;
        if (!results) return jsonError(502, 'Translation model returned an incomplete batch');
      }

      const rows = missing.map((it, i) => ({
        source_hash: it.hash,
        target_lang: target,
        source_text: it.text,
        translated_text: results.get(i) as string,
        kind: it.kind,
        provider: deepseekEnabled() ? 'deepseek' : 'anthropic',
        model_hint: it.model_hint,
        field_hint: it.field_hint,
      }));
      const { error: upsertErr } = await service
        .from('value_translations')
        .upsert(rows, { onConflict: 'target_lang,source_hash' });
      // A failed cache write must not eat the translations the user is waiting
      // for — return them anyway, but log loudly (they'll be re-requested and
      // re-paid next session, which is the visible symptom to chase).
      if (upsertErr) console.error('[value-translate] cache write failed:', upsertErr.message);

      for (const row of rows) translated.set(row.source_hash, row.translated_text);
    }

    return jsonOk({
      ok: true,
      results: items.map((it, idx) => {
        const hash = hashes[idx] ?? '';
        return {
          text: it.text,
          translated: cached.get(hash) ?? translated.get(hash) ?? null,
        };
      }),
    });
  });
}
