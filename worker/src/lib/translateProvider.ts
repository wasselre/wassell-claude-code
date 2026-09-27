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
import { recordAiUsage, openAiCompatTokens, openAiCompatModel, trackedAnthropic } from './aiUsage.js';
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

/**
 * Punctuation that sits AFTER a link rather than inside it.
 *
 * `\S+` grabs everything up to whitespace, so "(<link>)، ويضم" yielded the fact
 * `…masterplan-rabwat-alramz.pdf)،` — closing paren and Arabic comma included.
 * An English translation writes "),", never ")،", so that field could not be
 * translated by ANY output: the guard demanded Arabic punctuation inside an
 * English sentence. That is the real reason «ربوة الرمز» → project_analysis
 * retried from 6 to 27 September and never once succeeded. Strip the tail so
 * the protected fact is the link itself, which is the thing we actually care
 * about keeping. (The digits branch has always done this — `[,.]+$`.)
 */
const URL_TRAILING_PUNCT = /[)\]}>.,;:!?"'«»،؛؟]+$/;

export function stripUrlTail(raw: string): string {
  const trimmed = raw.replace(URL_TRAILING_PUNCT, '');
  // A "link" that is nothing but punctuation is not a link; keep the original
  // rather than returning an empty fact that matches everything.
  return trimmed.length > 'https://'.length ? trimmed : raw;
}

/** Digits (Arabic-Indic normalized) + URLs that must survive translation. */
export function protectedFacts(src: string): string[] {
  const norm = src.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const digits = norm.match(/\d[\d,.]{1,}/g) ?? [];
  const urls = (src.match(/https?:\/\/\S+/g) ?? []).map(stripUrlTail);
  return [...new Set([...digits.map((d) => d.replace(/[,.]+$/, '')), ...urls])];
}

export function assertFactsIntact(src: string, out: string): string[] {
  const outNorm = out.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/,/g, '');
  return protectedFacts(src).filter((f) => !outNorm.includes(f.replace(/,/g, '')));
}

/**
 * Links never reach the model — they travel as placeholders and come back.
 *
 * WHY. The fact guard above refuses any output that lost a URL, and it is right
 * to: a translated brochure line pointing at the wrong PDF is worse than no
 * translation. But a long link is exactly what a translator mangles — it
 * re-encodes a hyphen, drops a path segment, "tidies" the file name. Measured
 * on 2026-09-27: «ربوة الرمز» → project_analysis had been failing on
 * `…/masterplan-rabwat-alramz.pdf` since 6 September, retrying every 30 minutes
 * forever (the retry cap in 2026-09-27_translation_retry_cap.sql is the other
 * half of that fix — this half makes the item actually translatable).
 *
 * Swapping each link for `[[L0]]` before the call removes the thing the model
 * gets wrong, and restoring afterwards puts the byte-identical original back —
 * so the guard passes for the right reason, not because it was weakened. A
 * placeholder the model DROPS is still a lost fact and still fails.
 */
const LINK_RE = /https?:\/\/\S+/g;
/** Tolerant of a model that adds spaces inside the brackets. Nothing else. */
const PLACEHOLDER_RE = /\[\[\s*L(\d+)\s*\]\]/g;

export function maskLinks(text: string): { masked: string; links: string[] } {
  const links: string[] = [];
  const masked = text.replace(LINK_RE, (raw) => {
    // The trailing "), ." belongs to the SENTENCE, not the link — it must stay
    // in the text the model translates, or the model has to guess where the
    // Arabic punctuation went. Same boundary as protectedFacts, deliberately.
    const url = stripUrlTail(raw);
    const tail = raw.slice(url.length);
    links.push(url);
    return `[[L${links.length - 1}]]${tail}`;
  });
  return { masked, links };
}

export function restoreLinks(text: string, links: string[]): { text: string; missing: string[] } {
  if (links.length === 0) return { text, missing: [] };
  const seen = new Set<number>();
  const restored = text.replace(PLACEHOLDER_RE, (whole, idx: string) => {
    const i = Number(idx);
    const url = links[i];
    if (url === undefined) return whole;   // a placeholder we never issued — leave it visible
    seen.add(i);
    return url;
  });
  const missing = links.filter((_, i) => !seen.has(i));
  return { text: restored, missing };
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
5. A source may contain placeholders like [[L0]] or [[L3]]. Copy each placeholder into your output EXACTLY as written — same brackets, same number, no spaces added, never translated and never dropped. Place it where the link belongs in the target sentence.
6. Every item MUST appear in the output with its same index "i". Reply with ONLY the JSON object {"results":[{"i": number, "t": string}]}.`;

interface ProviderOpts {
  deepseekKey: string | null;
  anthropicKey: string;
}

async function deepseekCall(key: string, payload: unknown[]): Promise<Map<number, string>> {
  const started = Date.now();
  // Highest-volume model call in the app. One row per BATCH, which is what a
  // provider request actually is; items_in says how many values it carried.
  const bill = (status: 'ok' | 'error', body: unknown, error?: unknown) =>
    recordAiUsage({
      area: 'translation',
      callSite: 'worker/translateProvider',
      operation: 'batch',
      provider: 'deepseek',
      model: openAiCompatModel(body, 'deepseek-chat'),
      status,
      error: error ? (error instanceof Error ? error.message : String(error)) : null,
      latencyMs: Date.now() - started,
      meta: { items_in: payload.length },
      ...(body ? openAiCompatTokens(body) : {}),
    });
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
  if (!res.ok) {
    const err = new Error(`deepseek HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await bill('error', null, err);
    throw err;
  }
  const body = (await res.json()) as {
    choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
  };
  if (body.choices?.[0]?.finish_reason === 'length') {
    // A truncated reply still consumed every token it generated — bill it.
    const err = new Error('deepseek reply truncated (finish_reason=length)');
    await bill('error', body, err);
    throw err;
  }
  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    const err = new Error('deepseek returned an empty completion');
    await bill('error', body, err);
    throw err;
  }
  await bill('ok', body);
  return parseResults(content);
}

async function haikuCall(key: string, payload: unknown[]): Promise<Map<number, string>> {
  // Every row this produces means DeepSeek failed. A rising count is the
  // signal that the cheap path has stopped carrying the traffic.
  const client = trackedAnthropic(new Anthropic({ apiKey: key }), {
    area: 'translation',
    callSite: 'worker/translateProvider',
    operation: 'batch',
    isFallback: true,
    fallbackFrom: 'deepseek',
    meta: { items_in: payload.length },
  });
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
    // Links leave as [[L0]] and come back as themselves — see maskLinks.
    const masked = batch.map((it) => maskLinks(it.text));
    const payload = batch.map((it, i) => ({
      i,
      kind: it.mixedSource ? 'mixed' : it.treatment === 'transliterate' ? 'name' : 'text',
      target: it.targetLang,
      src: masked[i]!.masked,
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
      // Put the real links back before ANY checking: the guard compares against
      // the untouched source, so it must see the untouched links.
      const { text: restored, missing: lostLinks } = restoreLinks(t, masked[i]!.links);
      if (lostLinks.length > 0) {
        results.set(it.id, { error: `protected link lost: ${lostLinks.slice(0, 2).join(', ')}`, provider });
        return;
      }
      const missing = assertFactsIntact(it.text, restored);
      if (missing.length > 0) {
        results.set(it.id, { error: `protected facts lost: ${missing.slice(0, 3).join(', ')}`, provider });
        return;
      }
      results.set(it.id, { translated: restored, provider });
    });
  }
  return results;
}
