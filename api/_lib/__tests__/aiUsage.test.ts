/**
 * Unit tests for the AI usage recorder.
 *
 * The behaviours that matter most here are the ones that decide whether a
 * number in a cost report is trustworthy:
 *   - a failed call still produces a row (it burned input tokens)
 *   - a recording failure never becomes the caller's failure
 *   - "we do not know the cost" never gets written as a known zero
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  recordAiUsage,
  anthropicTokens,
  openAiCompatTokens,
  trackAnthropic,
  trackedAnthropic,
} from '../aiUsage.js';

const ENV = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc-key' };

/** Capture the rows a test's calls would have inserted. */
function mockFetch(impl?: () => Promise<Response>) {
  const rows: Record<string, unknown>[] = [];
  const spy = vi.fn(async (_url: string, init?: RequestInit) => {
    rows.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return impl ? impl() : new Response(null, { status: 201 });
  });
  vi.stubGlobal('fetch', spy);
  return { rows, spy };
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', ENV.SUPABASE_URL);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', ENV.SUPABASE_SERVICE_ROLE_KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('token extraction', () => {
  it('reads the Anthropic usage shape including both cache dimensions', () => {
    expect(
      anthropicTokens({
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 50,
        },
      }),
    ).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 50 });
  });

  it('returns nothing rather than zeros when a response carries no usage', () => {
    // Zeros would read as "a free call"; absent reads as "nothing to add".
    expect(anthropicTokens({})).toEqual({});
    expect(anthropicTokens(null)).toEqual({});
  });

  it('splits a DeepSeek prompt into billed input and cache-read halves', () => {
    // DeepSeek charges the cache-hit half at a lower rate, so recording the
    // whole prompt as `input` would overstate the bill.
    expect(
      openAiCompatTokens({
        usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 800 },
      }),
    ).toEqual({ inputTokens: 200, outputTokens: 200, cacheReadTokens: 800 });
  });

  it('treats a prompt with no cache hits as all input', () => {
    expect(openAiCompatTokens({ usage: { prompt_tokens: 500, completion_tokens: 10 } })).toEqual({
      inputTokens: 500,
      outputTokens: 10,
      cacheReadTokens: 0,
    });
  });
});

describe('recordAiUsage', () => {
  it('posts a complete row to the ai_usage table', async () => {
    const { rows, spy } = mockFetch();
    await recordAiUsage({
      area: 'sales',
      callSite: 'api/client-summary',
      operation: 'summary',
      provider: 'deepseek',
      model: 'deepseek-chat',
      inputTokens: 120,
      outputTokens: 30,
      latencyMs: 450,
      entityKind: 'record',
      entityId: 'rec-1',
    });

    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]![0])).toBe(`${ENV.SUPABASE_URL}/rest/v1/ai_usage`);
    expect(rows[0]).toMatchObject({
      area: 'sales',
      call_site: 'api/client-summary',
      operation: 'summary',
      provider: 'deepseek',
      model: 'deepseek-chat',
      status: 'ok',
      input_tokens: 120,
      output_tokens: 30,
      latency_ms: 450,
      entity_kind: 'record',
      entity_id: 'rec-1',
    });
  });

  it('leaves cost to the price book unless the caller measured it', async () => {
    const { rows } = mockFetch();
    await recordAiUsage({ area: 'sales', callSite: 'x', provider: 'deepseek', model: 'deepseek-chat' });
    // No cost keys at all → the database trigger prices the row.
    expect(rows[0]).not.toHaveProperty('cost_usd');
    expect(rows[0]).not.toHaveProperty('cost_known');
  });

  it('passes a measured cost through as KNOWN, including a real zero', async () => {
    const { rows } = mockFetch();
    await recordAiUsage({ area: 'marketing', callSite: 'runner:x', provider: 'runner', model: 'claude-runner', costUsd: 0 });
    // The runner genuinely costs nothing on the API — that is a measurement,
    // not an unknown, so it must be marked known.
    expect(rows[0]).toMatchObject({ cost_usd: 0, cost_known: true });
  });

  it('never lets a recording failure escape to the caller', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await expect(
      recordAiUsage({ area: 'sales', callSite: 'x', provider: 'deepseek', model: 'deepseek-chat' }),
    ).resolves.toBeUndefined();
    // Swallowed, but never silent.
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[aiUsage] insert threw'));
  });

  it('says so loudly when the environment cannot record at all', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    vi.stubEnv('SUPABASE_URL', '');
    const { spy } = mockFetch();
    await recordAiUsage({ area: 'sales', callSite: 'x', provider: 'deepseek', model: 'deepseek-chat' });
    expect(spy).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('AI usage is NOT being recorded'));
  });
});

describe('trackAnthropic', () => {
  it('records a successful call and returns the response untouched', async () => {
    const { rows } = mockFetch();
    const response = { usage: { input_tokens: 10, output_tokens: 4 }, content: [] };
    const out = await trackAnthropic(
      { area: 'internal', callSite: 'api/doc-assist', provider: 'anthropic', model: 'claude-sonnet-4-6' },
      async () => response,
    );
    expect(out).toBe(response);
    expect(rows[0]).toMatchObject({ status: 'ok', input_tokens: 10, output_tokens: 4 });
  });

  it('records a FAILED call and re-throws the provider error unchanged', async () => {
    const { rows } = mockFetch();
    const boom = new Error('529 overloaded');
    await expect(
      trackAnthropic(
        { area: 'internal', callSite: 'api/doc-assist', provider: 'anthropic', model: 'claude-sonnet-4-6' },
        async () => { throw boom; },
      ),
    ).rejects.toBe(boom);
    // A failed call still consumed input tokens and still belongs on the bill.
    expect(rows[0]).toMatchObject({ status: 'error', error: '529 overloaded' });
  });
});

describe('trackedAnthropic', () => {
  it('records every messages.create through the wrapped client', async () => {
    const { rows } = mockFetch();
    const client = {
      messages: {
        create: async (_p: unknown) => ({ usage: { input_tokens: 7, output_tokens: 3 } }),
      },
      otherProp: 'kept',
    };
    const tracked = trackedAnthropic(client, {
      area: 'translation',
      callSite: 'api/translate',
      isFallback: true,
      fallbackFrom: 'deepseek',
    });

    const res = await tracked.messages.create({ model: 'claude-haiku-4-5-20251001' });

    expect(res).toEqual({ usage: { input_tokens: 7, output_tokens: 3 } });
    expect(rows[0]).toMatchObject({
      call_site: 'api/translate',
      // The model comes off the request params, so a per-call model override is
      // billed correctly without the wrapper being told about it.
      model: 'claude-haiku-4-5-20251001',
      is_fallback: true,
      fallback_from: 'deepseek',
      input_tokens: 7,
    });
    // The proxy must not hide the rest of the client.
    expect(tracked.otherProp).toBe('kept');
  });

  it('bills a Kimi call to moonshot, not anthropic', async () => {
    const { rows } = mockFetch();
    const client = { messages: { create: async () => ({ usage: { input_tokens: 1, output_tokens: 1 } }) } };
    const tracked = trackedAnthropic(client, {
      area: 'sales',
      callSite: 'api/whatsapp/basic-reply',
      provider: 'moonshot',
      modelOverride: 'kimi-k3',
    });
    await tracked.messages.create({ model: 'ignored-by-override' });
    expect(rows[0]).toMatchObject({ provider: 'moonshot', model: 'kimi-k3' });
  });
});
