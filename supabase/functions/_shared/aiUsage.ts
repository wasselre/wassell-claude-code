/**
 * aiUsage — Deno port of `api/_lib/aiUsage.ts` for Supabase edge functions.
 *
 * A THIRD copy exists for the same reason the worker has a second one: a Deno
 * edge function cannot import from `api/_lib` (different runtime, different
 * module resolution), exactly as this directory's `anthropic.ts` and
 * `supabase.ts` already duplicate their api-side counterparts.
 *
 * Kept deliberately minimal — edge functions make one or two model calls each,
 * so only `recordAiUsage` and the two token extractors are ported. If you add a
 * capability here, add it to `api/_lib/aiUsage.ts` first and keep the shapes
 * identical; the `ai_usage` row format is the contract all three share.
 *
 * Same failure posture as the api copy: a recording failure is logged with
 * console.error and swallowed, and it never swallows the caller's own error.
 */

export type AiArea = 'sales' | 'translation' | 'marketing' | 'competitors' | 'internal' | 'website';
export type AiProvider = 'anthropic' | 'deepseek' | 'moonshot' | 'fal' | 'modal' | 'runner';

export interface AiUsageInput {
  area: AiArea;
  callSite: string;
  operation?: string;
  provider: AiProvider;
  model: string;
  status?: 'ok' | 'error';
  error?: string | null;
  isFallback?: boolean;
  fallbackFrom?: AiProvider | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  latencyMs?: number;
  entityKind?: string | null;
  entityId?: string | null;
  meta?: Record<string, unknown>;
}

const INSERT_TIMEOUT_MS = 3_000;
let warnedMissingEnv = false;

function int(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Record ONE model call. Never throws. */
export async function recordAiUsage(input: AiUsageInput): Promise<void> {
  const url = (Deno.env.get('SUPABASE_URL') ?? '').trim().replace(/\/$/, '');
  const key = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').trim();
  if (!url || !key) {
    if (!warnedMissingEnv) {
      warnedMissingEnv = true;
      console.error(
        '[aiUsage] SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are not both set — AI usage is NOT being recorded from this edge function.',
      );
    }
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INSERT_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/rest/v1/ai_usage`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
        'x-wassel-service': 'ai-usage',
      },
      body: JSON.stringify({
        area: input.area,
        call_site: input.callSite,
        operation: input.operation ?? null,
        provider: input.provider,
        model: input.model,
        status: input.status ?? 'ok',
        error: input.error ? String(input.error).slice(0, 2000) : null,
        is_fallback: input.isFallback ?? false,
        fallback_from: input.fallbackFrom ?? null,
        input_tokens: int(input.inputTokens),
        output_tokens: int(input.outputTokens),
        cache_read_tokens: int(input.cacheReadTokens),
        cache_write_tokens: int(input.cacheWriteTokens),
        latency_ms: int(input.latencyMs) || null,
        entity_kind: input.entityKind ?? null,
        entity_id: input.entityId ?? null,
        meta: input.meta ?? {},
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(
        `[aiUsage] insert failed for ${input.callSite} (${input.provider}/${input.model}): HTTP ${res.status} ${body.slice(0, 300)}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`[aiUsage] insert threw for ${input.callSite}: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

interface TokenFields {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Anthropic Messages API usage shape. */
export function anthropicTokens(res: unknown): TokenFields {
  const u = (res as { usage?: Record<string, number | null> } | null)?.usage;
  return {
    inputTokens: Number(u?.input_tokens ?? 0),
    outputTokens: Number(u?.output_tokens ?? 0),
    cacheReadTokens: Number(u?.cache_read_input_tokens ?? 0),
    cacheWriteTokens: Number(u?.cache_creation_input_tokens ?? 0),
  };
}

/** OpenAI-compatible usage shape (DeepSeek). */
export function openAiCompatTokens(body: unknown): TokenFields {
  const u = (body as { usage?: Record<string, number> } | null)?.usage;
  const prompt = Number(u?.prompt_tokens ?? 0);
  const hit = Number(u?.prompt_cache_hit_tokens ?? 0);
  return {
    inputTokens: hit > 0 ? Math.max(0, prompt - hit) : prompt,
    outputTokens: Number(u?.completion_tokens ?? 0),
    cacheReadTokens: hit,
    cacheWriteTokens: 0,
  };
}

/**
 * The model an OpenAI-compatible provider actually served, falling back to the
 * name we asked for.
 *
 * Why this matters, found 2026-09-15: every DeepSeek call site sends the alias
 * `deepseek-chat`, and that is what the ledger stored. But DeepSeek's published
 * price list does not contain `deepseek-chat` — it prices `deepseek-flash` and
 * `deepseek-v4-pro`, which the alias resolves to. So 75 metered calls could
 * never be matched to a citable rate and sat permanently in
 * `v_ai_usage_unpriced`, which in turn made the DeepSeek credit balance an
 * upper bound rather than a figure.
 *
 * Recording the RESOLVED name fixes that at the source: the row then names a
 * model that appears on the vendor's price list. Rows written before this
 * change keep the alias, so seed `deepseek-chat` in `ai_price_book` too if you
 * want the historical ones costed.
 */
export function openAiCompatModel(body: unknown, requested: string): string {
  const served = (body as { model?: unknown } | null)?.model;
  return typeof served === 'string' && served.trim() ? served.trim() : requested;
}
