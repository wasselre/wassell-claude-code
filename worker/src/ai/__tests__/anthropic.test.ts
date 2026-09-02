import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicProvider, resetAnthropicProviderState, type AnthropicLike } from '../providers/anthropic';
import type { RoleConfig } from '../types';

type CreateParams = Anthropic.MessageCreateParamsNonStreaming;

function message(over: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-20260601',
    content: [{ type: 'text', text: '{"a":1}', citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    context_management: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 3000,
      cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 0 },
      inference_geo: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
      iterations: null,
    } as Anthropic.Usage,
    ...over,
  } as Anthropic.Message;
}

/** Fake client: each queued entry is either a Message to return or an Error to throw. */
function fakeClient(queue: Array<Anthropic.Message | Error>): AnthropicLike & { params: CreateParams[]; streamParams: CreateParams[] } {
  const params: CreateParams[] = [];
  const streamParams: CreateParams[] = [];
  const take = () => {
    const next = queue.shift();
    if (!next) throw new Error('fakeClient: queue exhausted');
    if (next instanceof Error) throw next;
    return next;
  };
  return {
    params,
    streamParams,
    messages: {
      async create(p: CreateParams) {
        params.push(p);
        return take();
      },
      stream(p: CreateParams) {
        streamParams.push(p);
        return { finalMessage: async () => take() };
      },
    },
  };
}

const headers = new Headers();
const badRequest = (msg: string) => new Anthropic.BadRequestError(400, { type: 'invalid_request_error', message: msg }, msg, headers, 'invalid_request_error');
const rateLimit = () => new Anthropic.RateLimitError(429, { type: 'rate_limit_error', message: 'slow down' }, 'slow down', headers, 'rate_limit_error');
const overloaded = () => new Anthropic.InternalServerError(529, { type: 'overloaded_error', message: 'overloaded' }, 'overloaded', headers, 'overloaded_error');

const WRITER: RoleConfig = { provider: 'anthropic', model: 'claude-opus-5', params: { max_tokens: 6000, thinking: 'adaptive', effort: 'high' } };
const CLASSIFIER: RoleConfig = { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', params: { max_tokens: 1200, temperature: 0 } };
const REQ = { system: 'You are a writer.', user: 'Write.', schema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] } };

const noSleep = async () => {};

beforeEach(() => resetAnthropicProviderState());
afterEach(() => vi.restoreAllMocks());

describe('request shape', () => {
  it('cache_control on the system prefix, adaptive thinking, effort, json_schema format', async () => {
    const client = fakeClient([message()]);
    const p = createAnthropicProvider({ client, sleep: noSleep });
    const res = await p.call<{ a: number }>(WRITER, REQ);
    const sent = client.params[0];
    expect(sent.model).toBe('claude-opus-5');
    expect(sent.max_tokens).toBe(6000);
    expect(sent.system).toEqual([{ type: 'text', text: 'You are a writer.', cache_control: { type: 'ephemeral' } }]);
    expect(sent.thinking).toEqual({ type: 'adaptive' });
    expect(sent.output_config).toEqual({ effort: 'high', format: { type: 'json_schema', schema: REQ.schema } });
    expect(sent.temperature).toBeUndefined();
    expect(sent.tools).toBeUndefined();
    expect(res.output).toEqual({ a: 1 });
    expect(res.structured_via).toBe('format');
  });
  it('streams (not create) when max_tokens exceeds the non-streaming ceiling', async () => {
    // The SDK refuses a non-streaming create() above ~8k max_tokens; the big
    // creative_package role (32000) must go through the stream path instead.
    const BIG: RoleConfig = { provider: 'anthropic', model: 'claude-opus-5', params: { max_tokens: 32000, thinking: 'adaptive', effort: 'high' } };
    const client = fakeClient([message()]);
    const p = createAnthropicProvider({ client, sleep: noSleep });
    const res = await p.call<{ a: number }>(BIG, REQ);
    expect(client.streamParams).toHaveLength(1);
    expect(client.params).toHaveLength(0);
    expect(client.streamParams[0].max_tokens).toBe(32000);
    expect(res.output).toEqual({ a: 1 });
  });
  it('uses plain create() when max_tokens is at/under the ceiling', async () => {
    const client = fakeClient([message()]);
    const p = createAnthropicProvider({ client, sleep: noSleep });
    await p.call(WRITER, REQ); // 6000 max_tokens
    expect(client.params).toHaveLength(1);
    expect(client.streamParams).toHaveLength(0);
  });
  it('cache:false drops cache_control; no thinking param when unset; temperature forwarded', async () => {
    const client = fakeClient([message()]);
    const p = createAnthropicProvider({ client, sleep: noSleep });
    await p.call(CLASSIFIER, { ...REQ, cache: false });
    const sent = client.params[0];
    expect(sent.system).toEqual([{ type: 'text', text: 'You are a writer.' }]);
    expect(sent.thinking).toBeUndefined();
    expect(sent.temperature).toBe(0);
    expect(sent.output_config).toEqual({ format: { type: 'json_schema', schema: REQ.schema } });
  });
  it("thinking:'off' → disabled; temperature dropped when thinking is adaptive", async () => {
    const client = fakeClient([message(), message()]);
    const p = createAnthropicProvider({ client, sleep: noSleep });
    await p.call({ ...WRITER, params: { thinking: 'off' } }, REQ);
    expect(client.params[0].thinking).toEqual({ type: 'disabled' });
    await p.call({ ...WRITER, params: { thinking: 'adaptive', temperature: 0.7 } }, REQ);
    expect(client.params[1].temperature).toBeUndefined();
  });
  it('images go before the text as url / base64 blocks', async () => {
    const client = fakeClient([message()]);
    const p = createAnthropicProvider({ client, sleep: noSleep });
    await p.call(WRITER, { ...REQ, images: [{ url: 'https://x/y.webp' }, { base64: 'AAAA', mime: 'image/png' }] });
    const content = client.params[0].messages[0].content as Anthropic.ContentBlockParam[];
    expect(content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://x/y.webp' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      { type: 'text', text: 'Write.' },
    ]);
  });
  it('rejects a non-anthropic role', async () => {
    const p = createAnthropicProvider({ client: fakeClient([]), sleep: noSleep });
    await expect(p.call({ provider: 'modal', model: 'bge-m3' }, REQ)).rejects.toThrow(/^provider:anthropic role provider is 'modal'/);
  });
});

describe('result', () => {
  it('reports usage, cost from pricing.ts (incl. cache), model, version (resolved snapshot), latency', async () => {
    let t = 100;
    const client = fakeClient([message()]);
    const p = createAnthropicProvider({ client, sleep: noSleep, now: () => (t += 250) });
    const res = await p.call(WRITER, REQ);
    expect(res.usage).toEqual({ in: 1000, out: 500, cache_read: 3000, cache_write: 2000 });
    // opus-5: 1000×5 + 500×25 + 3000×0.5 + 2000×6.25 per M = 0.005+0.0125+0.0015+0.0125 = 0.0315
    expect(res.cost_usd).toBe(0.0315);
    expect(res.provider).toBe('anthropic');
    expect(res.model).toBe('claude-opus-5');
    expect(res.version).toBe('claude-opus-5-20260601');
    expect(res.latency_ms).toBe(250);
  });
  it('role.version wins over the resolved model id', async () => {
    const p = createAnthropicProvider({ client: fakeClient([message()]), sleep: noSleep });
    const res = await p.call({ ...WRITER, version: 'v7' }, REQ);
    expect(res.version).toBe('v7');
  });
  it('unknown model → cost_usd null, still returns output', async () => {
    const p = createAnthropicProvider({ client: fakeClient([message()]), sleep: noSleep });
    const res = await p.call({ provider: 'anthropic', model: 'claude-future-9' }, REQ);
    expect(res.cost_usd).toBeNull();
    expect(res.output).toEqual({ a: 1 });
  });
  it('invalid JSON → provider: error', async () => {
    const p = createAnthropicProvider({ client: fakeClient([message({ content: [{ type: 'text', text: '{oops', citations: null }] })]), sleep: noSleep });
    await expect(p.call(WRITER, REQ)).rejects.toThrow(/^provider:anthropic invalid JSON/);
  });
  it('refusal / max_tokens stop reasons → provider: errors', async () => {
    const p = createAnthropicProvider({
      client: fakeClient([
        message({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null } as unknown as Anthropic.Message['stop_details'] }),
        message({ stop_reason: 'max_tokens' }),
      ]),
      sleep: noSleep,
    });
    await expect(p.call(WRITER, REQ)).rejects.toThrow(/^provider:anthropic refusal \(category=cyber/);
    await expect(p.call(WRITER, REQ)).rejects.toThrow(/^provider:anthropic max_tokens reached/);
  });
});

describe('structured-output fallback to a forced tool', () => {
  it('retries with a single forced tool when the API rejects output_config, then remembers per model', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const toolMsg = message({
      content: [{ type: 'tool_use', id: 'tu_1', name: 'emit_result', input: { a: 42 }, caller: { type: 'direct' } }],
      stop_reason: 'tool_use',
    });
    const client = fakeClient([badRequest('output_config.format is not supported for this model'), toolMsg, toolMsg]);
    const p = createAnthropicProvider({ client, sleep: noSleep });
    const res = await p.call<{ a: number }>(CLASSIFIER, REQ);
    expect(res.output).toEqual({ a: 42 });
    expect(res.structured_via).toBe('tool');
    expect(client.params).toHaveLength(2);
    const second = client.params[1];
    expect(second.output_config).toBeUndefined();
    expect(second.tools?.[0]).toMatchObject({ name: 'emit_result', input_schema: { type: 'object', required: ['a'] } });
    expect(second.tool_choice).toEqual({ type: 'tool', name: 'emit_result', disable_parallel_tool_use: true });
    expect(err).toHaveBeenCalledTimes(1);
    // Next call for the same model skips straight to the tool path.
    await p.call(CLASSIFIER, REQ);
    expect(client.params).toHaveLength(3);
    expect(client.params[2].tools).toBeDefined();
    expect(client.params[2].output_config).toBeUndefined();
  });
  it('a 400 unrelated to structured outputs is NOT retried and surfaces as provider:', async () => {
    const client = fakeClient([badRequest('messages: first message must use the user role')]);
    const p = createAnthropicProvider({ client, sleep: noSleep });
    // The SDK prepends the HTTP status to APIError.message ("400 messages: …") — we keep it verbatim.
    await expect(p.call(WRITER, REQ)).rejects.toThrow(/^provider:anthropic BadRequestError 400 invalid_request_error: .*first message must use the user role \(model=claude-opus-5, attempts=1\)/);
    expect(client.params).toHaveLength(1);
  });
  it('tool mode with no tool_use block → provider: error', async () => {
    const client = fakeClient([badRequest('structured outputs unavailable'), message()]);
    const p = createAnthropicProvider({ client, sleep: noSleep });
    await expect(p.call(WRITER, REQ)).rejects.toThrow(/^provider:anthropic forced tool 'emit_result' was not called/);
  });
});

describe('retries', () => {
  it('retries 429 and 529 with backoff, then succeeds', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sleeps: number[] = [];
    const client = fakeClient([rateLimit(), overloaded(), message()]);
    const p = createAnthropicProvider({ client, sleep: async (ms) => { sleeps.push(ms); }, baseDelayMs: 100 });
    const res = await p.call(WRITER, REQ);
    expect(res.output).toEqual({ a: 1 });
    expect(client.params).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(100);
    expect(sleeps[0]).toBeLessThan(125);
    expect(sleeps[1]).toBeGreaterThanOrEqual(200);
  });
  it('gives up after maxAttempts (3) with a provider: error carrying the cause', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = fakeClient([rateLimit(), rateLimit(), rateLimit(), message()]);
    const p = createAnthropicProvider({ client, sleep: noSleep });
    const err = await p.call(WRITER, REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^provider:anthropic RateLimitError 429 rate_limit_error: .*slow down \(model=claude-opus-5, attempts=3\)/);
    expect((err as Error & { cause?: unknown }).cause).toBeInstanceOf(Anthropic.RateLimitError);
    expect(client.params).toHaveLength(3);
  });
  it('retries connection errors too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = fakeClient([new Anthropic.APIConnectionError({ message: 'ECONNRESET' }), message()]);
    const p = createAnthropicProvider({ client, sleep: noSleep });
    await expect(p.call(WRITER, REQ)).resolves.toMatchObject({ output: { a: 1 } });
  });
});

describe('client construction', () => {
  it('throws provider: when ANTHROPIC_API_KEY is unset and no client injected', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const p = createAnthropicProvider({ sleep: noSleep });
      await expect(p.call(WRITER, REQ)).rejects.toThrow(/^provider:anthropic ANTHROPIC_API_KEY is not set/);
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});
