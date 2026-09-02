/**
 * Anthropic LlmProvider — one structured-JSON call per role invocation.
 *
 * - System prompt is the stable prefix: a single text block carrying
 *   `cache_control: {type:'ephemeral'}` (unless `req.cache === false`).
 * - Images go in the user turn (url or base64 blocks) BEFORE the text.
 * - Structured output: `output_config.format = {type:'json_schema', schema}`.
 *   If the API rejects that for the model (400 mentioning output_config /
 *   format / structured), we retry ONCE with a single forced tool whose
 *   input_schema is the same schema, and remember the mode per model so the
 *   next call skips straight to the tool path.
 * - `params.thinking === 'adaptive'` → `thinking:{type:'adaptive'}`; 'off' →
 *   `{type:'disabled'}`; unset → omit (model default). `params.effort` →
 *   `output_config.effort`. `temperature` is only forwarded when thinking is
 *   not adaptive (the API rejects sampling params alongside thinking).
 * - Retries 429 / 5xx (incl. 529 overloaded) / connection errors with
 *   exponential backoff, max 3 attempts. The SDK client we construct has its
 *   own retries turned off so the loop here is the only one.
 * - Every failure surfaces as an Error prefixed `provider:anthropic …`
 *   (contracts §12). Nothing is swallowed.
 */

import Anthropic from '@anthropic-ai/sdk';
import { computeCostUsd } from '../pricing.js';
import {
  providerError,
  type CallRequest,
  type CallResult,
  type LlmProvider,
  type RoleConfig,
  type RoleImage,
} from '../types.js';

export interface AnthropicProviderOptions {
  /** Defaults to process.env.ANTHROPIC_API_KEY (read lazily on first call). */
  apiKey?: string;
  /** Inject a pre-built client (tests pass a fake with `messages.create`). */
  client?: AnthropicLike;
  /** Total attempts for retryable failures. Default 3. */
  maxAttempts?: number;
  /** Backoff base in ms (attempt n waits base·2^(n-1) + jitter). Default 1000. */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** The slice of the SDK client we use — lets tests inject a fake without vi.mock. */
export interface AnthropicLike {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

type StructuredMode = 'format' | 'tool';

const FALLBACK_TOOL_NAME = 'emit_result';
const DEFAULT_MAX_TOKENS = 4096;

/** Per-model memory of which structured-output mode the API accepted. */
const structuredModeByModel = new Map<string, StructuredMode>();

/** Test hook — forget learned per-model structured modes. */
export function resetAnthropicProviderState(): void {
  structuredModeByModel.clear();
}

export function createAnthropicProvider(opts: AnthropicProviderOptions = {}): LlmProvider {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  let client: AnthropicLike | null = opts.client ?? null;

  function getClient(): AnthropicLike {
    if (client) return client;
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw providerError('anthropic', 'ANTHROPIC_API_KEY is not set');
    // maxRetries:0 — this module owns the retry loop (otherwise 3 × SDK's 2 = 9 attempts).
    client = new Anthropic({ apiKey, maxRetries: 0 });
    return client;
  }

  async function call<T>(role: RoleConfig, req: CallRequest): Promise<CallResult<T>> {
    if (role.provider !== 'anthropic') {
      throw providerError('anthropic', `role provider is '${role.provider}', not anthropic`);
    }
    const started = now();
    const base = buildBaseParams(role, req);
    let mode: StructuredMode = structuredModeByModel.get(role.model) ?? 'format';
    // Resolve the client OUTSIDE the retry try/catch: a missing API key is a
    // config error (already `provider:`-prefixed), not something to retry or re-wrap.
    const api = getClient();

    let attempt = 0;
    for (;;) {
      attempt += 1;
      const params = mode === 'format' ? withFormat(base, req) : withForcedTool(base, req);
      let res: Anthropic.Message;
      try {
        res = await api.messages.create(params);
      } catch (err) {
        if (mode === 'format' && isStructuredOutputRejection(err)) {
          console.error(
            `[ai/anthropic] model=${role.model} rejected output_config.format — falling back to forced tool: ${errMessage(err)}`,
          );
          mode = 'tool';
          structuredModeByModel.set(role.model, 'tool');
          attempt -= 1; // the fallback is not a retry against a transient failure
          continue;
        }
        if (isRetryable(err) && attempt < maxAttempts) {
          const delay = backoffMs(baseDelayMs, attempt);
          console.error(
            `[ai/anthropic] model=${role.model} attempt ${attempt}/${maxAttempts} failed (${describe(err)}) — retrying in ${delay}ms`,
          );
          await sleep(delay);
          continue;
        }
        throw providerError('anthropic', `${describe(err)} (model=${role.model}, attempts=${attempt})`, err);
      }
      structuredModeByModel.set(role.model, mode);
      return finish<T>(role, res, mode, now() - started);
    }
  }

  return { kind: 'anthropic', call };
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

function buildBaseParams(role: RoleConfig, req: CallRequest): Anthropic.MessageCreateParamsNonStreaming {
  const p = role.params ?? {};
  const system: Anthropic.TextBlockParam[] = [
    req.cache === false
      ? { type: 'text', text: req.system }
      : { type: 'text', text: req.system, cache_control: { type: 'ephemeral' } },
  ];
  const content: Anthropic.ContentBlockParam[] = [];
  for (const im of req.images ?? []) content.push(imageBlock(im));
  content.push({ type: 'text', text: req.user });

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: role.model,
    max_tokens: p.max_tokens ?? DEFAULT_MAX_TOKENS,
    system,
    messages: [{ role: 'user', content }],
  };
  if (p.thinking === 'adaptive') params.thinking = { type: 'adaptive' };
  else if (p.thinking === 'off') params.thinking = { type: 'disabled' };
  if (p.effort) params.output_config = { effort: p.effort };
  if (typeof p.temperature === 'number' && p.thinking !== 'adaptive') params.temperature = p.temperature;
  return params;
}

function withFormat(base: Anthropic.MessageCreateParamsNonStreaming, req: CallRequest): Anthropic.MessageCreateParamsNonStreaming {
  return {
    ...base,
    output_config: { ...(base.output_config ?? {}), format: { type: 'json_schema', schema: req.schema } },
  };
}

function withForcedTool(base: Anthropic.MessageCreateParamsNonStreaming, req: CallRequest): Anthropic.MessageCreateParamsNonStreaming {
  const tool: Anthropic.Tool = {
    name: FALLBACK_TOOL_NAME,
    description: 'Return the final answer as a single JSON object matching the schema. Call exactly once.',
    input_schema: { ...req.schema, type: 'object' } as Anthropic.Tool.InputSchema,
  };
  return {
    ...base,
    tools: [tool],
    tool_choice: { type: 'tool', name: FALLBACK_TOOL_NAME, disable_parallel_tool_use: true },
  };
}

function imageBlock(im: RoleImage): Anthropic.ImageBlockParam {
  if (im.base64 !== undefined) {
    return { type: 'image', source: { type: 'base64', media_type: mediaType(im.mime), data: im.base64 } };
  }
  return { type: 'image', source: { type: 'url', url: im.url } };
}

function mediaType(mime: string | undefined): Anthropic.Base64ImageSource['media_type'] {
  const m = (mime ?? '').toLowerCase();
  if (m.includes('png')) return 'image/png';
  if (m.includes('webp')) return 'image/webp';
  if (m.includes('gif')) return 'image/gif';
  if (m.includes('jpeg') || m.includes('jpg') || m === '') return 'image/jpeg';
  throw providerError('anthropic', `unsupported image mime '${mime}' (jpeg/png/gif/webp only)`);
}

// ---------------------------------------------------------------------------
// Response handling
// ---------------------------------------------------------------------------

function finish<T>(role: RoleConfig, res: Anthropic.Message, mode: StructuredMode, latencyMs: number): CallResult<T> {
  if (res.stop_reason === 'refusal') {
    const cat = res.stop_details && 'category' in res.stop_details ? String(res.stop_details.category) : 'unknown';
    throw providerError('anthropic', `refusal (category=${cat}, model=${role.model})`);
  }
  if (res.stop_reason === 'max_tokens') {
    throw providerError(
      'anthropic',
      `max_tokens reached before the JSON was complete (model=${role.model}, max_tokens=${role.params?.max_tokens ?? DEFAULT_MAX_TOKENS})`,
    );
  }

  let output: T;
  if (mode === 'tool') {
    const block = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!block) throw providerError('anthropic', `forced tool '${FALLBACK_TOOL_NAME}' was not called (model=${role.model})`);
    output = block.input as T;
  } else {
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (!text.trim()) throw providerError('anthropic', `empty text response (model=${role.model})`);
    try {
      output = JSON.parse(text) as T;
    } catch (err) {
      // Only a JSON syntax error is expected here — anything else propagates as-is.
      if (!(err instanceof SyntaxError)) throw err;
      throw providerError('anthropic', `invalid JSON in structured output (model=${role.model}): ${err.message}`, err);
    }
  }

  const u = res.usage;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const write5m = u.cache_creation?.ephemeral_5m_input_tokens;
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens;
  const cacheWriteTotal = u.cache_creation_input_tokens ?? 0;
  // When the TTL breakdown is absent, attribute the whole write to the 5-minute rate (our only TTL).
  const w5 = typeof write5m === 'number' ? write5m : cacheWriteTotal;
  const w1 = typeof write1h === 'number' ? write1h : 0;

  return {
    output,
    usage: { in: u.input_tokens, out: u.output_tokens, cache_read: cacheRead, cache_write: cacheWriteTotal },
    cost_usd: computeCostUsd(role.model, {
      input: u.input_tokens,
      output: u.output_tokens,
      cache_read: cacheRead,
      cache_write_5m: w5,
      cache_write_1h: w1,
    }),
    provider: 'anthropic',
    model: role.model,
    version: role.version ?? res.model ?? null,
    latency_ms: Math.max(0, Math.round(latencyMs)),
    structured_via: mode,
  };
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function isStructuredOutputRejection(err: unknown): boolean {
  if (!(err instanceof Anthropic.BadRequestError)) return false;
  const msg = errMessage(err).toLowerCase();
  return msg.includes('output_config') || msg.includes('output_format') || msg.includes('structured') || msg.includes('json_schema');
}

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.InternalServerError) return true; // covers 500/502/503/529 overloaded
  if (err instanceof Anthropic.APIConnectionError) return true; // network / timeout
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : 0;
    return status === 429 || status >= 500 || err.type === 'overloaded_error';
  }
  return false;
}

function backoffMs(base: number, attempt: number): number {
  const jitter = Math.floor(Math.random() * base * 0.25);
  return base * 2 ** (attempt - 1) + jitter;
}

function describe(err: unknown): string {
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? String(err.status) : 'conn';
    return `${err.constructor.name} ${status}${err.type ? ` ${err.type}` : ''}: ${err.message}`;
  }
  return errMessage(err);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
