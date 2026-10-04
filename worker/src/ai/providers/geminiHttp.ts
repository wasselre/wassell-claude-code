/**
 * Google Gemini API — the HTTP layer shared by the embedding provider and the
 * video analyser (marketing/cv/gemini). Plain `fetch`, header auth
 * (`x-goog-api-key`), JSON in and out.
 *
 * Retries: 429 (rate limit), 500, 502, 503 ("high demand") and 504 and network
 * errors are retried with exponential backoff (default 5 attempts, 2 s base,
 * capped at 60 s). Any other 4xx is a request bug and is thrown at once.
 * Every failure is `provider:gemini …` so the lanes map it to error_kind.
 *
 * The key is read at call time (`GEMINI_API_KEY`) so a worker boots fine
 * without it; the first call then fails with a clear message.
 *
 * PRICES — https://ai.google.dev/gemini-api/docs/pricing, read 2026-10-04
 * (paid tier, USD per 1M tokens). Keep in step with the ai_price_book rows in
 * supabase/migrations/2026-10-04_02_cv_gemini.sql.
 *   gemini-3.8-flash    input 0.75 / output 3.75 (thinking included) /
 *                       cached input 0.075 until 2026-12-31; 1.50 / 7.50 /
 *                       0.15 from 2027-01-01. Google caches repeated input on
 *                       its own (implicit caching) and reports it as
 *                       cachedContentTokenCount — measured 7,360 of 12,584
 *                       input tokens on one video call (2026-10-04).
 *   gemini-embedding-2  text input 0.20, image input 0.45.
 */

import { providerError } from '../types.js';

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com';

export interface GeminiHttpOptions {
  apiKey?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function geminiApiKey(explicit?: string): string {
  const key = (explicit ?? process.env.GEMINI_API_KEY ?? '').trim();
  if (!key) throw providerError('gemini', 'GEMINI_API_KEY is not set');
  return key;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** POST JSON to `${GEMINI_API_BASE}${path}`; returns the parsed body. */
export async function geminiPost<R>(path: string, body: unknown, opts: GeminiHttpOptions = {}): Promise<R> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
  const baseDelayMs = opts.baseDelayMs ?? 2_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const key = geminiApiKey(opts.apiKey);
  const payload = JSON.stringify(body);

  for (let attempt = 1; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${GEMINI_API_BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: payload,
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const detail = ctrl.signal.aborted ? `timeout after ${timeoutMs}ms` : `network error: ${errMessage(err)}`;
      if (attempt < maxAttempts) {
        console.error(`[ai/gemini] POST ${path} attempt ${attempt}/${maxAttempts} ${detail} — retrying`);
        await sleep(backoff(baseDelayMs, attempt));
        continue;
      }
      throw providerError('gemini', `POST ${path} ${detail} (attempts=${attempt})`, err);
    }
    clearTimeout(timer);
    if (!res.ok) {
      const snippet = (await safeText(res)).slice(0, 1500);
      if (res.status === 402) {
        // "Your prepayment credits are depleted": nothing works until someone
        // tops up the AI Studio prepay balance. Same path as a daily quota —
        // callers defer the work and pause, then try again every 15 minutes, so
        // a top-up resumes everything by itself. (2026-10-04: ~4,500 calls
        // failed over 8 hours before this existed, with no pause and no alert.)
        throw providerError('gemini', `${DAILY_QUOTA_MARK} ${CREDITS_DEPLETED} — retry after ${CREDITS_RECHECK_SEC}s: ${snippet.replace(/\s+/g, ' ').slice(0, 200)}`);
      }
      const daily = res.status === 429 ? dailyQuotaOf(snippet) : null;
      if (daily) {
        // A per-DAY quota does not refill in seconds — retrying here only burns
        // the job. Callers recognise DAILY_QUOTA_MARK and defer the work.
        throw providerError('gemini', `${DAILY_QUOTA_MARK} ${daily.quota} — retry after ${daily.retryAfterSec}s`);
      }
      if (RETRYABLE.has(res.status) && attempt < maxAttempts) {
        // A 429 names the quota and how long to wait (RetryInfo.retryDelay "37s").
        const asked = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(snippet);
        const wait = asked ? Math.min(120_000, Math.ceil(Number(asked[1]) * 1000) + 500) : backoff(baseDelayMs, attempt);
        const quota = /"quotaId":\s*"([^"]+)"/.exec(snippet)?.[1];
        console.error(`[ai/gemini] POST ${path} attempt ${attempt}/${maxAttempts} HTTP ${res.status}${quota ? ` quota=${quota}` : ''} — retrying in ${Math.round(wait / 1000)}s: ${snippet.replace(/\s+/g, ' ').slice(0, 200)}`);
        await sleep(wait);
        continue;
      }
      throw providerError('gemini', `POST ${path} HTTP ${res.status}: ${snippet || res.statusText}`);
    }
    try {
      return (await res.json()) as R;
    } catch (err) {
      // Only a body that is not JSON lands here.
      throw providerError('gemini', `POST ${path} returned a non-JSON body: ${errMessage(err)}`, err);
    }
  }
}

/** In every error thrown for an exhausted per-day quota (429 with a *PerDay* quotaId) or an empty prepaid balance (402). */
export const DAILY_QUOTA_MARK = 'daily_quota_exhausted';
/** Names the 402 case inside a DAILY_QUOTA_MARK error: the AI Studio prepaid balance is empty. */
export const CREDITS_DEPLETED = 'prepayment_credits_depleted';
const CREDITS_RECHECK_SEC = 900;

/** `{quota, retryAfterSec}` when a 429 body names a per-day quota; else null. Pure — tested. */
export function dailyQuotaOf(body: string): { quota: string; retryAfterSec: number } | null {
  const quota = /"quotaId":\s*"([^"]*PerDay[^"]*)"/.exec(body)?.[1];
  if (!quota) return null;
  const delay = Number(/"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(body)?.[1]);
  return { quota, retryAfterSec: Number.isFinite(delay) && delay > 0 ? Math.ceil(delay) : 3600 };
}

/** Seconds to wait, from an error carrying DAILY_QUOTA_MARK; null for any other error. */
export function dailyQuotaRetryAfter(message: string): number | null {
  if (!message.includes(DAILY_QUOTA_MARK)) return null;
  const n = Number(/retry after (\d+)s/.exec(message)?.[1]);
  return Number.isFinite(n) && n > 0 ? n : 3600;
}

/** Token counts per modality, from `usageMetadata.promptTokenDetails`. */
export interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  /** Input tokens served from Google's implicit cache (billed at the cached rate). */
  cachedContentTokenCount?: number;
  /** generateContent spells it promptTokensDetails; embedContent promptTokenDetails. */
  promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
  promptTokenDetails?: Array<{ modality?: string; tokenCount?: number }>;
}

export function modalityTokens(u: GeminiUsage | undefined): { text: number; image: number; video: number; audio: number; total: number } {
  const out = { text: 0, image: 0, video: 0, audio: 0, total: Number(u?.promptTokenCount ?? 0) || 0 };
  for (const d of u?.promptTokenDetails ?? u?.promptTokensDetails ?? []) {
    const n = Number(d.tokenCount ?? 0) || 0;
    const m = String(d.modality ?? '').toUpperCase();
    if (m === 'TEXT') out.text += n;
    else if (m === 'IMAGE') out.image += n;
    else if (m === 'VIDEO') out.video += n;
    else if (m === 'AUDIO') out.audio += n;
  }
  return out;
}

const FLASH_PRICE_SWITCH = Date.UTC(2027, 0, 1);

/**
 * USD for one gemini-3.8-flash call. `inputTokens` is promptTokenCount (ALL
 * input, cached included); `cachedTokens` of them are billed at the cached
 * rate instead. Output includes thinking tokens.
 */
export function flashCostUsd(inputTokens: number, outputTokens: number, cachedTokens = 0, now: number = Date.now()): number {
  const [inRate, outRate, cacheRate] = now >= FLASH_PRICE_SWITCH ? [1.5, 7.5, 0.15] : [0.75, 3.75, 0.075];
  const cached = Math.min(Math.max(0, cachedTokens), inputTokens);
  return round6(((inputTokens - cached) / 1e6) * inRate + (cached / 1e6) * cacheRate + (outputTokens / 1e6) * outRate);
}

/** USD for one gemini-embedding-2 call. Tokens not attributed to a modality are priced as text. */
export function embeddingCostUsd(u: GeminiUsage | undefined): number {
  const t = modalityTokens(u);
  const unattributed = Math.max(0, t.total - t.text - t.image - t.video - t.audio);
  return round6(((t.text + unattributed) / 1e6) * 0.2 + (t.image / 1e6) * 0.45);
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function backoff(base: number, attempt: number): number {
  return Math.min(60_000, base * 2 ** (attempt - 1)) + Math.floor(Math.random() * base * 0.25);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    // The status code is the signal we keep when the body cannot be read.
    console.error(`[ai/gemini] could not read error body: ${errMessage(err)}`);
    return '';
  }
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
