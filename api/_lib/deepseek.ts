/**
 * deepseek — DeepSeek chat-completions client for TRANSLATION tasks.
 *
 * User decision (2026-07-31): translation runs on DeepSeek (`deepseek-chat`,
 * OpenAI-compatible API at api.deepseek.com), replacing the Qwen/Cloudflare
 * route for /api/translate and powering the new record-value translation
 * endpoint (/api/value-translate). Claude Haiku remains the fallback in every
 * routed endpoint — a user request never fails because DeepSeek did.
 *
 * Enabled ONLY when DEEPSEEK_API_KEY is set. Edge-runtime compatible (fetch +
 * AbortController, no Node APIs).
 *
 * Encoding note (learned live 2026-07-31): DeepSeek handles Arabic perfectly,
 * but Arabic mangled to `?????` before the request produces confident
 * hallucinations. Payloads are always JSON.stringify'd UTF-8 here — never
 * build request bodies through a Windows shell.
 *
 * Metering (2026-09-14): this is the choke point for EVERY DeepSeek call made
 * from api/, so it is where usage is recorded. `opts.track` is REQUIRED — the
 * type is what guarantees a new endpoint cannot start spending on DeepSeek
 * without appearing in the cost ledger. If you are adding a caller and the
 * compiler is asking you for `track`, that is the point.
 */

import { recordAiUsage, openAiCompatTokens, openAiCompatModel, type AiCallRef } from './aiUsage.js';

const DEEPSEEK_BASE = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = 'deepseek-chat';
const DEFAULT_MAX_TOKENS = 2_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export function deepseekEnabled(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY?.trim());
}

export interface DeepseekChatOpts {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Force response_format json_object (the model must be told to emit JSON in the prompt too). */
  json?: boolean;
  /**
   * Which feature is spending. REQUIRED so no call site can bill DeepSeek
   * without landing in `ai_usage` — see the metering note at the top.
   */
  track: AiCallRef;
  /** Optional row enrichment for the ledger. */
  userId?: string | null;
  entityKind?: string | null;
  entityId?: string | null;
}

interface DeepseekCompletion {
  /** The model the alias resolved to — this, not DEEPSEEK_MODEL, is what was billed. */
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

/** One-shot chat completion. Returns the assistant text. Throws on any failure. */
export async function deepseekChat(opts: DeepseekChatOpts): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not configured');

  const started = Date.now();
  /** Record one attempt. Shared by the success and failure paths so a call that
   *  burned prompt tokens and then failed is still on the bill. */
  const record = async (status: 'ok' | 'error', body: DeepseekCompletion | null, error?: unknown) => {
    await recordAiUsage({
      ...opts.track,
      provider: 'deepseek',
      model: openAiCompatModel(body, DEEPSEEK_MODEL),
      status,
      error: error ? (error instanceof Error ? error.message : String(error)) : null,
      latencyMs: Date.now() - started,
      userId: opts.userId ?? null,
      entityKind: opts.entityKind ?? null,
      entityId: opts.entityId ?? null,
      ...(body ? openAiCompatTokens(body) : {}),
    });
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
        max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: opts.temperature ?? 0.2,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    // Transport failure (timeout, DNS, abort): no usage came back, but the
    // attempt is still worth a row — a burst of these is what a fallback storm
    // looks like from the cost side.
    await record('error', null, err);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`deepseek HTTP ${res.status}: ${text.slice(0, 300)}`);
    await record('error', null, err);
    throw err;
  }
  const body = (await res.json()) as DeepseekCompletion;
  const content = body.choices?.[0]?.message?.content?.trim();
  if (!content) {
    const err = new Error(body.error?.message ?? 'deepseek returned an empty completion');
    // An empty completion still consumed the prompt — record the real tokens.
    await record('error', body, err);
    throw err;
  }
  await record('ok', body);
  return content;
}

export interface DeepseekJsonOpts extends DeepseekChatOpts {
  /** Human-readable shape description embedded in the prompt. */
  shape: string;
  /** Keys that must be present (non-empty when strings) in the parsed object. */
  requiredKeys: string[];
}

/**
 * One-shot structured generation: json_object mode + shape instruction, parses
 * the reply and validates required keys. Throws on any mismatch — callers fall
 * back to their Anthropic path.
 */
export async function deepseekJson<T extends object>(opts: DeepseekJsonOpts): Promise<T> {
  const system = `${opts.system}\n\nOUTPUT FORMAT (hard requirement): respond with ONLY one JSON object of exactly this shape — no prose before or after it, no markdown fences:\n${opts.shape}`;
  const raw = await deepseekChat({ ...opts, system, json: true });

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('deepseek reply contained no JSON object');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('deepseek reply was not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('deepseek reply was not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of opts.requiredKeys) {
    const v = obj[key];
    if (v == null || (typeof v === 'string' && !v.trim())) {
      throw new Error(`deepseek reply missing required key "${key}"`);
    }
  }
  return obj as unknown as T;
}

/**
 * Standard loud fallback log. Call from an endpoint's catch around the
 * DeepSeek attempt, then run the Anthropic path. Never throws.
 */
export function logDeepseekFallback(endpoint: string, err: unknown): void {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(`[deepseek] failed for ${endpoint} — falling back to Anthropic: ${msg}`);
}
