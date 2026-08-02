/**
 * Translation provider layer for the W1 translation lane (bilingual REV 4).
 *
 * DeepSeek (`deepseek-chat`) primary, Claude Haiku fallback — the decision-
 * sheet posture (D-1 signed 2026-08-02: DeepSeek for everything). This is a
 * worker-package COPY of the api/_lib DeepSeek client pattern (the worker
 * cannot import from api/_lib — same posture as imageGen.ts / documents/*).
 *
 * Hard-learned rules baked in:
 *  - char-budget batching (3,000 src chars / 20 items) — long prose overflows
 *    max_tokens and truncates the JSON reply (live incident 2026-07-31)
 *  - finish_reason='length' throws instead of returning garbage
 *  - Arabic must never transit a shell — everything here is UTF-8 JSON bodies
 *  - protected-fact assertion: digits/URLs in the source must survive into
 *    the output or the item FAILS loudly (generalized from
 *    listing-message.ts assertGeographyIntact)
 */

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';

export type TargetLang = 'ar' | 'en';
export type SourceLang = 'ar' | 'en' | 'mixed' | 'und';
export type Treatment = 'translate' | 'transliterate' | 'copy';

export const DETECTOR_VERSION = 'script-ratio-v1';
const BATCH_MAX_ITEMS = 20;
const BATCH_MAX_CHARS = 3000;

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Script-ratio language detection (REV 4 §B3). */
export function detectLang(text: string): { lang: SourceLang; confidence: number } {
  const letters = text.replace(/[^A-Za-z؀-ۿ]/g, '');
  if (letters.length === 0) return { lang: 'und', confidence: 0 };
  const ar = (letters.match(/[؀-ۿ]/g) ?? []).length;
  const ratio = ar / letters.length;
  if (ratio >= 0.8) return { lang: 'ar', confidence: ratio };
  if (ratio <= 0.2) return { lang: 'en', confidence: 1 - ratio };
  return { lang: 'mixed', confidence: 1 - Math.abs(0.5 - ratio) };
}

/** Digits (Arabic-Indic normalized) + URLs that must survive translation. */
export function protectedFacts(src: string): string[] {
  const norm = src.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const digits = norm.match(/\d[\d,.]{1,}/g) ?? [];
  const urls = src.match(/https?:\/\/\S+/g) ?? [];
  return [...new Set([...digits.map((d) => d.replace(/[,.]+$/, '')), ...urls])];
}

export function assertFactsIntact(src: string, out: string): string[] {
  const outNorm = out.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/,/g, '');
  return protectedFacts(src).filter((f) => !outNorm.includes(f.replace(/,/g, '')));
}

export interface TranslateItem {
  id: string;
  text: string;
  treatment: Treatment;
  targetLang: TargetLang;
  /** mixed-source items get the "normalize into pure target" instruction */
  mixedSource?: boolean;
}

export interface TranslateResult {
  translated?: string;
  error?: string;
  provider: 'deepseek' | 'anthropic';
}

const SYSTEM_PROMPT = `You translate CRM record values between Arabic and English for a Saudi Arabian real-estate company (Wassel / وصل العقارية).

You will receive a JSON array of items: {"i": <index>, "kind": "name"|"text"|"mixed", "target": "ar"|"en", "src": "<source text>"}.

Rules:
1. kind "name" — proper nouns (projects, developers, people, unit models). To English: TRANSLITERATE the way Saudi developers write names in English marketing (e.g. "مساكن الأصيل" → "Masaken Al Aseel"); translate only generic words (شركة → Company). To Arabic: render the name in Arabic script as Saudi media writes it. Never invent a different name.
2. kind "text" — translate naturally and FAITHFULLY into the target language. Keep every fact: numbers, prices, dates, directions, names. Professional real-estate register. Never summarize, embellish, or drop anything.
3. kind "mixed" — the source mixes Arabic and English. Produce a clean, natural version PURELY in the target language, preserving embedded proper nouns and codes verbatim.
4. Keep digits, URLs, phone numbers, and codes untouched.
5. Every item MUST appear in the output with its same index "i". Reply with ONLY the JSON object {"results":[{"i": number, "t": string}]}.`;

interface ProviderOpts {
  deepseekKey: string | null;
  anthropicKey: string;
}

async function deepseekCall(key: string, payload: unknown[]): Promise<Map<number, string>> {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Items:\n${JSON.stringify(payload)}` },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 8000,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`deepseek HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as {
    choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
  };
  if (body.choices?.[0]?.finish_reason === 'length') {
    throw new Error('deepseek reply truncated (finish_reason=length)');
  }
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error('deepseek returned an empty completion');
  return parseResults(content);
}

async function haikuCall(key: string, payload: unknown[]): Promise<Map<number, string>> {
  const client = new Anthropic({ apiKey: key });
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Items:\n${JSON.stringify(payload)}` }],
  });
  const text = response.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') throw new Error('haiku returned no text');
  return parseResults(text.text);
}

function parseResults(raw: string): Map<number, string> {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('provider reply contained no JSON object');
  const parsed = JSON.parse(raw.slice(start, end + 1)) as { results?: Array<{ i: number; t: string }> };
  const out = new Map<number, string>();
  for (const r of parsed.results ?? []) {
    if (typeof r?.i === 'number' && typeof r?.t === 'string' && r.t.trim()) out.set(r.i, r.t.trim());
  }
  return out;
}

/**
 * Translate a set of items with char-budget batching, DeepSeek→Haiku
 * fallback, and per-item protected-fact assertion. Never throws for a single
 * bad item — each result carries its own error.
 */
export async function translateItems(
  opts: ProviderOpts,
  items: TranslateItem[],
): Promise<Map<string, TranslateResult>> {
  const results = new Map<string, TranslateResult>();

  const batches: TranslateItem[][] = [];
  let current: TranslateItem[] = [];
  let chars = 0;
  for (const it of items) {
    if (current.length > 0 && (current.length >= BATCH_MAX_ITEMS || chars + it.text.length > BATCH_MAX_CHARS)) {
      batches.push(current); current = []; chars = 0;
    }
    current.push(it); chars += it.text.length;
  }
  if (current.length > 0) batches.push(current);

  for (const batch of batches) {
    const payload = batch.map((it, i) => ({
      i,
      kind: it.mixedSource ? 'mixed' : it.treatment === 'transliterate' ? 'name' : 'text',
      target: it.targetLang,
      src: it.text,
    }));
    let map: Map<number, string> | null = null;
    let provider: 'deepseek' | 'anthropic' = 'deepseek';
    try {
      if (!opts.deepseekKey) throw new Error('DEEPSEEK_API_KEY not set');
      map = await deepseekCall(opts.deepseekKey, payload);
    } catch (err) {
      console.error(`[translate] deepseek batch failed, falling back to haiku: ${(err as Error).message}`);
      provider = 'anthropic';
      try {
        map = await haikuCall(opts.anthropicKey, payload);
      } catch (err2) {
        const msg = (err2 as Error).message;
        for (const it of batch) results.set(it.id, { error: `providers failed: ${msg}`, provider });
        continue;
      }
    }
    batch.forEach((it, i) => {
      const t = map?.get(i);
      if (!t) {
        results.set(it.id, { error: 'missing from provider reply', provider });
        return;
      }
      const missing = assertFactsIntact(it.text, t);
      if (missing.length > 0) {
        results.set(it.id, { error: `protected facts lost: ${missing.slice(0, 3).join(', ')}`, provider });
        return;
      }
      results.set(it.id, { translated: t, provider });
    });
  }
  return results;
}
