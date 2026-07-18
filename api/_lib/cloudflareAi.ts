/**
 * Cloudflare Workers AI provider — STANDALONE, deliberately unwired.
 *
 * Talks to Cloudflare's OpenAI-compatible chat-completions endpoint for
 * Cloudflare-HOSTED models (we do not self-host or upload weights):
 *
 *   POST https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1/chat/completions
 *
 * Default model: @cf/qwen/qwen3-30b-a3b-fp8 (Qwen3 30B MoE, fp8).
 *
 * ISOLATION RULE (2026-07-18, user decision): this module must NOT be imported
 * by any existing flow — no translation, no listings, no copywriting, nothing —
 * until a separate integration plan is explicitly approved. It exists so the
 * provider is ready, testable, and swappable-in later. Anthropic remains the
 * production LLM everywhere.
 *
 * Env (see .env.example + docs/cloudflare-workers-ai.md):
 *   CLOUDFLARE_ACCOUNT_ID   — the company Cloudflare account id (hex string)
 *   CLOUDFLARE_API_TOKEN    — scoped API token (Workers AI Read+Edit ONLY;
 *                             never the Global API Key)
 *   CLOUDFLARE_AI_MODEL     — optional; defaults to @cf/qwen/qwen3-30b-a3b-fp8
 *   CLOUDFLARE_AI_BASE_URL  — optional; defaults to the v4 accounts AI base.
 *                             May contain the literal placeholder {ACCOUNT_ID}.
 *
 * Error handling contract:
 *   - Every failure throws CloudflareAiError with a stable `kind`:
 *     'auth' (401/403), 'rate_limit' (429 w/ rate-limit signature),
 *     'quota_exhausted' (free daily Neuron allowance spent — Cloudflare
 *     rejects with a capacity/allocation error), 'timeout' (AbortController
 *     deadline), 'api_error' (other 4xx/5xx), 'network' (fetch failure).
 *   - NO automatic retries. Callers decide; the free-plan quota error in
 *     particular must never be retried in a loop (it fails until the daily
 *     UTC reset).
 *   - Default request timeout 60 s (configurable per call).
 *
 * Logging: one console line per request with model/status/duration/usage.
 * NEVER logs the token and NEVER logs prompt or completion content
 * (CLAUDE.md silent-failures posture: loud errors, but no customer content).
 */

const DEFAULT_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
const DEFAULT_TIMEOUT_MS = 60_000;

export type CloudflareAiErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'timeout'
  | 'api_error'
  | 'network';

export class CloudflareAiError extends Error {
  readonly kind: CloudflareAiErrorKind;
  readonly status: number | null;

  constructor(kind: CloudflareAiErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'CloudflareAiError';
    this.kind = kind;
    this.status = status;
  }
}

export interface CloudflareAiEnv {
  accountId: string;
  apiToken: string;
  model: string;
  baseUrl: string;
}

/**
 * Read + validate the Cloudflare env. Throws (loudly) when required vars are
 * absent — callers should treat that as "provider not configured", not retry.
 */
export function readCloudflareAiEnv(): CloudflareAiEnv {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? '';
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? '';
  if (!accountId) throw new CloudflareAiError('auth', 'CLOUDFLARE_ACCOUNT_ID is not set');
  if (!apiToken) throw new CloudflareAiError('auth', 'CLOUDFLARE_API_TOKEN is not set');
  const model = process.env.CLOUDFLARE_AI_MODEL?.trim() || DEFAULT_MODEL;
  const rawBase =
    process.env.CLOUDFLARE_AI_BASE_URL?.trim() ||
    'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1';
  const baseUrl = rawBase.replace('{ACCOUNT_ID}', accountId).replace(/\/$/, '');
  return { accountId, apiToken, model, baseUrl };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionOpts {
  messages: ChatMessage[];
  /** Defaults to CLOUDFLARE_AI_MODEL / @cf/qwen/qwen3-30b-a3b-fp8. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Hard deadline for the whole request. Default 60 s. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ChatCompletionResult {
  /** Assistant message content (Qwen3 may embed <think>…</think> blocks). */
  content: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  durationMs: number;
}

interface OpenAiCompatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  errors?: Array<{ code?: number; message?: string }>;
  error?: { message?: string; code?: number | string; type?: string };
}

/** True when a Cloudflare error payload smells like the daily free-allowance cap. */
function looksLikeQuotaExhaustion(status: number, bodyText: string): boolean {
  const t = bodyText.toLowerCase();
  return (
    (status === 429 || status === 403 || status === 402) &&
    (t.includes('allocation') || t.includes('neuron') || t.includes('quota') || t.includes('capacity') || t.includes('limit exceeded'))
  );
}

/**
 * One chat-completions call. No retries, no streaming — the minimal
 * verification surface for this phase.
 */
export async function cloudflareChatCompletion(opts: ChatCompletionOpts): Promise<ChatCompletionResult> {
  const env = readCloudflareAiEnv();
  const model = opts.model ?? env.model;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (opts.signal) {
    // Chain the caller's signal into ours so either can cancel.
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${env.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.apiToken}`,
      },
      body: JSON.stringify({
        model,
        messages: opts.messages,
        ...(opts.maxTokens != null ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
        stream: false,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const durationMs = Date.now() - started;
    if (ctrl.signal.aborted && !opts.signal?.aborted) {
      console.error(`[cloudflare-ai] timeout model=${model} after ${durationMs}ms (limit ${timeoutMs}ms)`);
      throw new CloudflareAiError('timeout', `Cloudflare AI request timed out after ${timeoutMs}ms`);
    }
    console.error(
      `[cloudflare-ai] network error model=${model} after ${durationMs}ms: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw new CloudflareAiError('network', `Cloudflare AI request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  clearTimeout(timer);
  const durationMs = Date.now() - started;

  if (!res.ok) {
    // Error bodies carry Cloudflare error envelopes — safe to inspect, but cap
    // what we propagate and never echo request content back out.
    const bodyText = await res.text().catch(() => '');
    const snippet = bodyText.slice(0, 300);
    let kind: CloudflareAiErrorKind = 'api_error';
    if (res.status === 401 || res.status === 403) kind = 'auth';
    if (res.status === 429) kind = 'rate_limit';
    if (looksLikeQuotaExhaustion(res.status, bodyText)) kind = 'quota_exhausted';
    console.error(`[cloudflare-ai] ${kind} model=${model} status=${res.status} duration=${durationMs}ms`);
    throw new CloudflareAiError(kind, `Cloudflare AI ${res.status}: ${snippet}`, res.status);
  }

  let json: OpenAiCompatResponse;
  try {
    json = (await res.json()) as OpenAiCompatResponse;
  } catch {
    console.error(`[cloudflare-ai] invalid JSON model=${model} status=${res.status} duration=${durationMs}ms`);
    throw new CloudflareAiError('api_error', 'Cloudflare AI returned non-JSON body', res.status);
  }

  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    console.error(`[cloudflare-ai] empty completion model=${model} duration=${durationMs}ms`);
    throw new CloudflareAiError('api_error', 'Cloudflare AI response had no completion content', res.status);
  }

  const usage = json.usage
    ? {
        promptTokens: json.usage.prompt_tokens ?? 0,
        completionTokens: json.usage.completion_tokens ?? 0,
        totalTokens: json.usage.total_tokens ?? 0,
      }
    : null;
  console.log(
    `[cloudflare-ai] ok model=${model} duration=${durationMs}ms tokens=${usage ? `${usage.promptTokens}+${usage.completionTokens}` : 'n/a'}`,
  );
  return { content, model: json.model ?? model, usage, durationMs };
}
