/**
 * OpenAI Chat Completions — the HTTP layer for the competitor post reader
 * (gpt-6-luna) and the image design reader (gpt-6.1-sol), added 2026-10-06
 * after a 30-post blind bake-off against Gemini, Claude and Kimi. Plain `fetch`,
 * Bearer auth, structured output via `response_format: json_schema` (strict).
 *
 * Retries: 429 rate limits (honouring `retry-after`), 500/502/503/504 and
 * network errors, exponential backoff. An EMPTY balance (429
 * `insufficient_quota`) is never retried — it is raised with DAILY_QUOTA_MARK +
 * OPENAI_QUOTA so the reader pauses with one alert instead of looping (the
 * Gemini 402 lesson, 2026-10-04). Any other 4xx is a request bug: thrown at once.
 *
 * The key is read at call time (`OPENAI_API_KEY`), so a worker boots fine
 * without it; the first call then fails with a clear message.
 *
 * PRICES — https://developers.openai.com/api/docs/pricing, read 2026-10-06
 * (standard tier, USD per 1M tokens; batch is half). Keep in step with the
 * ai_price_book rows in supabase/migrations/2026-10-06_01_openai_readers.sql.
 *   gpt-6-luna   input 0.10 / output 0.50
 *   gpt-6.1-sol  input 2.00 / output 10.00
 * Reasoning tokens are billed as output and are included in completion_tokens.
 * Cached input has its own (lower) rate that the page did not list for these
 * models; it is priced as normal input here, so a cost is at worst slightly high.
 */
import { providerError } from '../types.js';
import { DAILY_QUOTA_MARK } from './geminiHttp.js';

export const OPENAI_API_BASE = 'https://api.openai.com';
/** Names the empty-balance case inside a DAILY_QUOTA_MARK error. */
export const OPENAI_QUOTA = 'openai_insufficient_quota';
const QUOTA_RECHECK_SEC = 900;

export const OPENAI_PRICES: Record<string, { input: number; output: number }> = {
  'gpt-6-luna': { input: 0.10, output: 0.50 },
  'gpt-6.1-sol': { input: 2.00, output: 10.00 },
};

export interface OpenAiUsage { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }

/** USD for one call at the cited standard rate; null for a model with no cited price. Pure — tested. */
export function openaiCostUsd(model: string, u: OpenAiUsage | undefined): number | null {
  const p = OPENAI_PRICES[model];
  if (!p) return null;
  const i = Number(u?.prompt_tokens ?? 0) || 0;
  const o = Number(u?.completion_tokens ?? 0) || 0;
  return Math.round(((i / 1e6) * p.input + (o / 1e6) * p.output) * 1e6) / 1e6;
}

/**
 * The strict-mode version of a JSON schema: every object closed and every
 * property required, no numeric / length / pattern constraints (strict mode
 * rejects some of them; the callers' validators re-apply the real rules).
 * Pure — tested.
 */
export function openaiStrictSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(openaiStrictSchema);
  if (!s || typeof s !== 'object') return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (['minimum', 'maximum', 'minItems', 'maxItems', 'pattern', 'description'].includes(k)) continue;
    out[k] = k === 'properties'
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, openaiStrictSchema(pv)]))
      : openaiStrictSchema(v);
  }
  if (out.type === 'object') {
    out.additionalProperties = false;
    out.required = Object.keys((out.properties ?? {}) as Record<string, unknown>);
  }
  return out;
}

/** True when a 429 body is the empty-balance refusal, not a rate limit. Pure — tested. */
export function isInsufficientQuota(body: string): boolean {
  return /insufficient_quota/i.test(body) || /exceeded your current quota/i.test(body);
}

export interface OpenAiCallOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface OpenAiChatResult { text: string; usage: OpenAiUsage; finishReason: string; model: string }

/**
 * One structured chat completion. `content` is the user message's parts
 * (text + image_url). Returns the assistant text (the JSON) and the usage.
 */
export async function openaiChatJson(
  model: string,
  content: unknown[],
  schemaName: string,
  schema: unknown,
  opts: OpenAiCallOptions = {},
): Promise<OpenAiChatResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw providerError('openai_compat', 'OPENAI_API_KEY is not set');
  const doFetch = opts.fetch ?? globalThis.fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 6);
  const baseDelayMs = opts.baseDelayMs ?? 3_000;
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content }],
    response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } },
    max_completion_tokens: 32_000,
  });
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(`${OPENAI_API_BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
      });
    } catch (e) {
      if (attempt >= maxAttempts) throw providerError('openai_compat', `${model} network error after ${attempt} attempts: ${(e as Error).message}`, e);
      await sleep(Math.min(60_000, baseDelayMs * 2 ** (attempt - 1)));
      continue;
    }
    const raw = await res.text();
    if (res.ok) {
      let j: { choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>; usage?: OpenAiUsage; model?: string };
      try { j = JSON.parse(raw); } catch (e) { throw providerError('openai_compat', `${model} returned non-JSON: ${raw.slice(0, 200)}`, e); }
      const c = j.choices?.[0];
      if (c?.message?.refusal) throw providerError('openai_compat', `${model} refused: ${c.message.refusal.slice(0, 200)}`);
      return { text: c?.message?.content ?? '', usage: j.usage ?? {}, finishReason: c?.finish_reason ?? 'none', model: j.model ?? model };
    }
    const snippet = raw.replace(/\s+/g, ' ').slice(0, 300);
    if (res.status === 429 && isInsufficientQuota(raw)) {
      // Empty balance: retrying cannot help and only burns time. Pause the lane.
      throw providerError('openai_compat', `${DAILY_QUOTA_MARK} ${OPENAI_QUOTA} — retry after ${QUOTA_RECHECK_SEC}s: ${snippet}`);
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= maxAttempts) {
      throw providerError('openai_compat', `${model} HTTP ${res.status} (attempt ${attempt}): ${snippet}`);
    }
    const ra = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(ra) && ra > 0 ? Math.min(120_000, ra * 1000) : Math.min(60_000, baseDelayMs * 2 ** (attempt - 1));
    console.warn(`[ai/openai] ${model} HTTP ${res.status} attempt ${attempt}/${maxAttempts} — retrying in ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }
}
