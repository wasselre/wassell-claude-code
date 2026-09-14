/**
 * aiUsage — the single recorder for every AI call the app makes.
 *
 * WHY: an audit on 2026-09-14 found only 9 of ~44 AI call sites recorded a
 * cost, all of them in Marketing. The whole Sales side, every translation call
 * and both Opus agents ran with no telemetry, so the AI bill could not be
 * attributed to a feature. This module + `ai_usage` (see
 * supabase/migrations/2026-09-14_ai_usage_ledger.sql) close that gap.
 *
 * TRANSPORT: a plain `fetch` POST to PostgREST with the service-role key —
 * deliberately NOT the Supabase SDK. The same source has to run on Vercel Edge,
 * on the Fly worker (Node) and in a Deno edge function; raw fetch is the one
 * thing all three have, and it keeps `worker/src/lib/aiUsage.ts` a verbatim
 * copy of this file.
 *
 * FAILURE POSTURE (read before "simplifying" it): a recording failure is
 * logged with console.error and then swallowed. This is a deliberate, scoped
 * silence, not the pattern CLAUDE.md bans:
 *   - It is scoped to ONE operation (inserting a metering row) and every
 *     failure mode is surfaced on stdout, never hidden.
 *   - It does not swallow the caller's error. `trackAnthropic` / `trackFetch`
 *     re-throw the provider error unchanged after recording it.
 *   - A lost usage row costs a metering gap; a thrown one would cost the user
 *     their actual request. Given that trade the request wins.
 * There is no retry queue: by the time the insert fails the isolate is often
 * about to be frozen, and a durable queue for telemetry is more machinery than
 * the data is worth. Gaps are visible — `v_ai_usage_daily` shows the hole.
 *
 * COST: nothing here prices anything. Tokens go to the database and the
 * `ai_usage_cost` trigger applies the operator-editable `ai_price_book`. That
 * way a provider whose rate we do not know still produces a complete token
 * record, and entering the rate later re-costs the whole history.
 */

/** Coarse business bucket a cost report groups by. */
export type AiArea =
  | 'sales'
  | 'translation'
  | 'marketing'
  | 'competitors'
  | 'internal'
  | 'website';

export type AiProvider =
  | 'anthropic'
  | 'deepseek'
  | 'moonshot'
  | 'fal'
  | 'modal'
  | 'runner';

/**
 * Where a call came from. Every AI call site in the codebase passes one of
 * these; `callSite` is a STABLE slug (normally the module path) because it is
 * what a cost report groups by — renaming it splits the history in two.
 */
export interface AiCallRef {
  area: AiArea;
  callSite: string;
  operation?: string;
}

export interface AiTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface AiUsageInput extends AiCallRef, AiTokenUsage {
  provider: AiProvider;
  model: string;
  status?: 'ok' | 'error';
  error?: string | null;
  /** True when this is the fallback leg after another provider failed. */
  isFallback?: boolean;
  fallbackFrom?: AiProvider | null;
  /** Non-token billing: images generated, GPU seconds, audio minutes. */
  units?: number | null;
  unitKind?: 'image' | 'gpu_second' | 'minute' | 'video' | 'query' | null;
  latencyMs?: number;
  userId?: string | null;
  entityKind?: string | null;
  entityId?: string | null;
  requestId?: string | null;
  meta?: Record<string, unknown>;
  /**
   * Pre-computed cost, for a caller that already priced the call itself (the
   * role lanes get an exact figure back from the provider). When set, the
   * database trigger keeps it instead of re-deriving from the price book.
   * Leave unset everywhere else — pricing is the price book's job.
   */
  costUsd?: number | null;
}

const INSERT_TIMEOUT_MS = 3_000;

let warnedMissingEnv = false;

function serviceEnv(): { url: string; key: string } | null {
  const url = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!url || !key) {
    if (!warnedMissingEnv) {
      warnedMissingEnv = true;
      console.error(
        '[aiUsage] SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are not both set — AI usage is NOT being recorded in this environment. Every model call from here is invisible to cost reporting.',
      );
    }
    return null;
  }
  return { url: url.replace(/\/$/, ''), key };
}

function int(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Record ONE model call. Never throws — see the failure posture above.
 * Awaited by callers on purpose: on Vercel Edge the isolate can be frozen the
 * moment the response is returned, so a fire-and-forget insert would be lost.
 */
export async function recordAiUsage(input: AiUsageInput): Promise<void> {
  const env = serviceEnv();
  if (!env) return;

  const row = {
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
    units: typeof input.units === 'number' && Number.isFinite(input.units) ? input.units : null,
    unit_kind: input.unitKind ?? null,
    latency_ms: int(input.latencyMs) || null,
    user_id: input.userId ?? null,
    entity_kind: input.entityKind ?? null,
    entity_id: input.entityId ?? null,
    request_id: input.requestId ?? null,
    meta: input.meta ?? {},
    // cost_known distinguishes "priced at 0" from "we do not know" — a null
    // cost must never be written as a known zero.
    ...(typeof input.costUsd === 'number' && Number.isFinite(input.costUsd)
      ? { cost_usd: input.costUsd, cost_known: true }
      : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INSERT_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.url}/rest/v1/ai_usage`, {
      method: 'POST',
      headers: {
        apikey: env.key,
        Authorization: `Bearer ${env.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
        'x-wassel-service': 'ai-usage',
      },
      body: JSON.stringify(row),
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
    console.error(`[aiUsage] insert threw for ${input.callSite} (${input.provider}/${input.model}): ${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

/** The usage shape the Anthropic Messages API returns (Kimi's Anthropic-compatible endpoint matches it). */
interface AnthropicUsageShape {
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  } | null;
}

export function anthropicTokens(res: unknown): AiTokenUsage {
  const u = (res as AnthropicUsageShape | null)?.usage;
  if (!u) return {};
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/** The usage shape any OpenAI-compatible endpoint returns (DeepSeek included). */
interface OpenAiUsageShape {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** DeepSeek splits the prompt into cache hit / miss; the hit half is billed at the cache rate. */
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  } | null;
}

export function openAiCompatTokens(body: unknown): AiTokenUsage {
  const u = (body as OpenAiUsageShape | null)?.usage;
  if (!u) return {};
  const hit = u.prompt_cache_hit_tokens ?? 0;
  const prompt = u.prompt_tokens ?? 0;
  // Bill the cache-hit half at the cache-read rate and the rest as input, so
  // the row reflects what the provider actually charges rather than one flat
  // prompt number.
  return {
    inputTokens: hit > 0 ? Math.max(0, prompt - hit) : prompt,
    outputTokens: u.completion_tokens ?? 0,
    cacheReadTokens: hit,
  };
}

// ---------------------------------------------------------------------------
// Wrappers — time the call, record success AND failure, re-throw unchanged
// ---------------------------------------------------------------------------

export interface TrackOptions extends AiCallRef {
  provider: AiProvider;
  model: string;
  isFallback?: boolean;
  fallbackFrom?: AiProvider | null;
  userId?: string | null;
  entityKind?: string | null;
  entityId?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * Wrap one Anthropic (or Anthropic-compatible, e.g. Kimi) call.
 *
 *   const res = await trackAnthropic(
 *     { area: 'sales', callSite: 'api/client-summary', provider: 'anthropic', model: MODEL },
 *     () => client.messages.create({ ... }),
 *   );
 *
 * A thrown provider error is recorded as a `status='error'` row and re-thrown
 * untouched, so the caller's own fallback logic is unaffected.
 */
export async function trackAnthropic<T>(opts: TrackOptions, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const res = await run();
    await recordAiUsage({
      ...opts,
      status: 'ok',
      latencyMs: Date.now() - started,
      ...anthropicTokens(res),
    });
    return res;
  } catch (err) {
    await recordAiUsage({
      ...opts,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    });
    throw err;
  }
}

/**
 * Wrap one OpenAI-compatible call whose parsed JSON body carries `usage`
 * (DeepSeek). `run` must resolve to the PARSED body.
 */
export async function trackOpenAiCompat<T>(opts: TrackOptions, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const body = await run();
    await recordAiUsage({
      ...opts,
      status: 'ok',
      latencyMs: Date.now() - started,
      ...openAiCompatTokens(body),
    });
    return body;
  } catch (err) {
    await recordAiUsage({
      ...opts,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    });
    throw err;
  }
}

/**
 * Wrap an Anthropic SDK CLIENT so every `messages.create` through it is
 * recorded — model, tokens, latency, and failures — with no change at the call
 * sites themselves:
 *
 *   const client = trackedAnthropic(new Anthropic({ apiKey }), {
 *     area: 'sales', callSite: 'api/client-summary', isFallback: true, fallbackFrom: 'deepseek',
 *   });
 *
 * Preferred over `trackAnthropic` for an endpoint that makes one or more plain
 * (non-streaming) calls: a future call added to the same file is metered
 * automatically instead of being forgotten.
 *
 * `messages.stream` is deliberately NOT wrapped — a stream's usage is only
 * known at `finalMessage()`, so streaming call sites record explicitly (see
 * api/builder-agent.ts). Streaming still works through this wrapper untouched.
 *
 * The casts below are the price of preserving the SDK's exact overloads at
 * every call site. They are confined to this function and assert only that the
 * wrapper forwards the same arguments and returns the same value.
 */
export function trackedAnthropic<T extends object>(client: T, ref: TrackedClientRef): T {
  const provider: AiProvider = ref.provider ?? 'anthropic';
  const inner = client as unknown as {
    messages: { create: (...args: unknown[]) => Promise<unknown> };
  };
  const originalCreate = inner.messages.create.bind(inner.messages);

  const wrappedCreate = async (...args: unknown[]): Promise<unknown> => {
    const params = (args[0] ?? {}) as { model?: string };
    const model = ref.modelOverride ?? params.model ?? 'unknown';
    const started = Date.now();
    try {
      const res = await originalCreate(...args);
      await recordAiUsage({
        area: ref.area,
        callSite: ref.callSite,
        operation: ref.operation,
        provider,
        model,
        status: 'ok',
        isFallback: ref.isFallback,
        fallbackFrom: ref.fallbackFrom,
        userId: ref.userId,
        entityKind: ref.entityKind,
        entityId: ref.entityId,
        meta: ref.meta,
        latencyMs: Date.now() - started,
        ...anthropicTokens(res),
      });
      return res;
    } catch (err) {
      await recordAiUsage({
        area: ref.area,
        callSite: ref.callSite,
        operation: ref.operation,
        provider,
        model,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        isFallback: ref.isFallback,
        fallbackFrom: ref.fallbackFrom,
        userId: ref.userId,
        entityKind: ref.entityKind,
        entityId: ref.entityId,
        meta: ref.meta,
        latencyMs: Date.now() - started,
      });
      throw err;
    }
  };

  // Proxy rather than a spread copy: the SDK client carries getters and
  // prototype methods that a shallow `{...client}` would drop.
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== 'messages') return Reflect.get(target, prop, receiver);
      const messages = Reflect.get(target, prop, receiver) as object;
      return new Proxy(messages, {
        get(mTarget, mProp, mReceiver) {
          if (mProp === 'create') return wrappedCreate;
          const v = Reflect.get(mTarget, mProp, mReceiver);
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(mTarget) : v;
        },
      });
    },
  });
}

export interface TrackedClientRef extends AiCallRef {
  /** Defaults to 'anthropic'. Pass 'moonshot' for Kimi's Anthropic-compatible endpoint. */
  provider?: AiProvider;
  /** Use when the billed model name differs from `params.model`. */
  modelOverride?: string;
  isFallback?: boolean;
  fallbackFrom?: AiProvider | null;
  userId?: string | null;
  entityKind?: string | null;
  entityId?: string | null;
  meta?: Record<string, unknown>;
}

/**
 * Wrap one unit-billed call (fal image edit, Modal GPU job, transcription).
 * `units` is how many billable units the call consumed — images produced,
 * GPU seconds, audio minutes.
 */
export async function trackUnits<T>(
  opts: TrackOptions & { unitKind: NonNullable<AiUsageInput['unitKind']> },
  run: () => Promise<T>,
  unitsOf: (result: T) => number,
): Promise<T> {
  const started = Date.now();
  try {
    const res = await run();
    let units = 0;
    try {
      units = unitsOf(res);
    } catch (err) {
      // A broken unit-counter must not lose the whole row: record the call with
      // zero units and say so, rather than dropping the evidence it happened.
      console.error(`[aiUsage] unit counter threw for ${opts.callSite}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await recordAiUsage({ ...opts, status: 'ok', units, latencyMs: Date.now() - started });
    return res;
  } catch (err) {
    await recordAiUsage({
      ...opts,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      units: 0,
      latencyMs: Date.now() - started,
    });
    throw err;
  }
}
