/**
 * aiUsage (scripts) — the AI cost recorder for operator-run `.mjs` tooling.
 *
 * WHY A FOURTH COPY. The recorder exists as `api/_lib/aiUsage.ts` (canonical),
 * `worker/src/lib/aiUsage.ts` (generated) and
 * `supabase/functions/_shared/aiUsage.ts` (Deno port). Scripts in this folder
 * are plain ESM `.mjs` run straight by node with no build step, so they cannot
 * import any of the three. This is the smallest faithful port: the same row
 * shape, the same PostgREST insert, the same failure posture.
 *
 * WHY IT EXISTS AT ALL. Until 2026-09-15 `scripts/` was outside the metering
 * guard's scan entirely, so a backfill or an eval run here spent real money
 * with no ledger row. `backfill-value-translations.mjs` alone walks the record
 * corpus through DeepSeek. Operator-run batches are not a rounding error —
 * measured that day, hand-run work was the LARGER share of the Anthropic bill.
 *
 * FAILURE POSTURE (identical to the canonical recorder, deliberately): a
 * recording failure is logged with console.error and then swallowed. The
 * silence is scoped to ONE operation — inserting a metering row — every failure
 * mode is printed, and the caller's own error is never touched. A script must
 * not die because the ledger was unreachable, and a missing row must never be
 * invisible.
 *
 * Keep in step with api/_lib/aiUsage.ts when the row shape changes.
 */

import { readFileSync } from 'node:fs';

const INSERT_TIMEOUT_MS = 3_000;

let warnedMissingEnv = false;

/** Load .env / .env.local the way the other scripts here do (no dotenv dep). */
export function loadScriptEnv() {
  for (const f of ['.env', '.env.local']) {
    try {
      for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*([\s\S]*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
      }
    } catch {
      /* a missing .env is normal in CI; real env vars win anyway */
    }
  }
}

function serviceEnv() {
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

function int(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Record ONE model call. Never throws. */
export async function recordAiUsage(input) {
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
    // Operator-run work is marked so the page can separate "the product spent
    // this" from "a person ran a batch" — they are different decisions.
    meta: { run_kind: 'operator_script', ...(input.meta ?? {}) },
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

/** Token fields out of an Anthropic Messages response. */
export function anthropicTokens(res) {
  const u = res?.usage;
  if (!u) return {};
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/** Token fields out of an OpenAI-compatible completion (DeepSeek, Kimi). */
export function openAiCompatTokens(body) {
  const u = body?.usage;
  if (!u) return {};
  const hit = u.prompt_cache_hit_tokens ?? 0;
  const prompt = u.prompt_tokens ?? 0;
  return {
    inputTokens: hit > 0 ? Math.max(0, prompt - hit) : prompt,
    outputTokens: u.completion_tokens ?? 0,
    cacheReadTokens: hit,
  };
}

/**
 * The model the provider actually served, falling back to what we asked for.
 * DeepSeek prices `deepseek-flash` / `deepseek-v4-pro`, never the `deepseek-chat`
 * alias every call site sends — storing the alias leaves the row unpriceable.
 */
export function openAiCompatModel(body, requested) {
  const served = body?.model;
  return typeof served === 'string' && served.trim() ? served.trim() : requested;
}

/**
 * Wrap an Anthropic SDK client so every model call through it is metered.
 *
 * Covers all four shapes the scripts in this folder actually use:
 *   client.messages.create        — the standard path
 *   client.beta.messages.create   — the beta namespace (code execution, files)
 *   client.beta.messages.stream   — recorded when finalMessage() resolves,
 *                                   because a stream has no usage until then
 *   client.messages.stream        — same
 *
 * `client.beta.files` / `client.beta.skills` pass through untouched: those are
 * storage APIs and cost no tokens, so a metering row for them would be noise.
 *
 * Streaming is recorded on finalMessage() rather than on stream creation. A
 * caller that drains the events and never calls finalMessage() gets no row —
 * that is the same limitation the canonical recorder documents, and every
 * script here calls it.
 */
export function trackedAnthropic(client, opts) {
  const record = async (model, started, res, err) => {
    await recordAiUsage({
      ...opts,
      provider: opts.provider ?? 'anthropic',
      model,
      status: err ? 'error' : 'ok',
      error: err ? (err instanceof Error ? err.message : String(err)) : null,
      latencyMs: Date.now() - started,
      ...(res ? anthropicTokens(res) : {}),
    });
  };

  const wrapMessages = (messages) =>
    new Proxy(messages, {
      get(m, prop, recv) {
        if (prop === 'create') {
          return async (params, ...rest) => {
            const started = Date.now();
            const model = opts.modelOverride ?? params?.model ?? 'unknown';
            try {
              const res = await m.create.call(m, params, ...rest);
              await record(model, started, res, null);
              return res;
            } catch (err) {
              // A failed call still burned input tokens, and a run of these is
              // how a broken script shows up on the bill. Record, re-throw as-is.
              await record(model, started, null, err);
              throw err;
            }
          };
        }
        if (prop === 'stream') {
          return (params, ...rest) => {
            const started = Date.now();
            const model = opts.modelOverride ?? params?.model ?? 'unknown';
            const turn = m.stream.call(m, params, ...rest);
            let recorded = false;
            return new Proxy(turn, {
              get(t, p, r) {
                if (p !== 'finalMessage') {
                  const v = Reflect.get(t, p, r);
                  return typeof v === 'function' ? v.bind(t) : v;
                }
                return async (...a) => {
                  try {
                    const res = await t.finalMessage(...a);
                    // Guard against a caller awaiting finalMessage() twice —
                    // the SDK caches it, and two rows would double the bill.
                    if (!recorded) { recorded = true; await record(model, started, res, null); }
                    return res;
                  } catch (err) {
                    if (!recorded) { recorded = true; await record(model, started, null, err); }
                    throw err;
                  }
                };
              },
            });
          };
        }
        const v = Reflect.get(m, prop, recv);
        return typeof v === 'function' ? v.bind(m) : v;
      },
    });

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'messages') return wrapMessages(target.messages);
      if (prop === 'beta') {
        const beta = target.beta;
        return new Proxy(beta, {
          get(b, p, r) {
            // Only `beta.messages` spends tokens; files/skills are storage.
            if (p === 'messages') return wrapMessages(b.messages);
            const v = Reflect.get(b, p, r);
            return typeof v === 'function' ? v.bind(b) : v;
          },
        });
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
