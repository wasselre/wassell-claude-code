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
 */

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
}

interface DeepseekCompletion {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

/** One-shot chat completion. Returns the assistant text. Throws on any failure. */
export async function deepseekChat(opts: DeepseekChatOpts): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not configured');

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
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`deepseek HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const body = (await res.json()) as DeepseekCompletion;
  const content = body.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error(body.error?.message ?? 'deepseek returned an empty completion');
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
