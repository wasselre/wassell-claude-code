/**
 * Tests for the operator-script AI recorder (scripts/lib/aiUsage.mjs).
 *
 * This is a fourth copy of the recorder, written because `.mjs` tooling cannot
 * import the TypeScript one. A copy that silently stops recording is worse than
 * no copy — the page would show a confident total that is missing every batch
 * an operator ran by hand — so the proxy chain is tested against all four call
 * shapes the scripts in this folder actually use.
 *
 * Nothing here touches a real provider: the Anthropic client is a stub and the
 * PostgREST insert is a fetch mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// @ts-expect-error — plain .mjs module, no type declarations by design
import { trackedAnthropic, openAiCompatModel, openAiCompatTokens, anthropicTokens } from '../aiUsage.mjs';

const ENV = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc-key' };

let rows: Array<Record<string, unknown>>;

beforeEach(() => {
  rows = [];
  Object.assign(process.env, ENV);
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
    rows.push(JSON.parse(init.body));
    return { ok: true, status: 201, text: async () => '' } as unknown as Response;
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const USAGE = { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 };

function stubClient() {
  const filesList = vi.fn(() => 'FILES');
  const skillsCreate = vi.fn(async () => ({ id: 'skill_1' }));
  const make = () => ({
    create: vi.fn(async (p: { model: string }) => ({ model: p.model, usage: USAGE, stop_reason: 'end_turn' })),
    stream: vi.fn(() => {
      let calls = 0;
      return {
        finalMessage: async () => { calls += 1; return { usage: USAGE, stop_reason: 'end_turn', _calls: calls }; },
        [Symbol.asyncIterator]: async function* () { yield { type: 'x' }; },
      };
    }),
  });
  return {
    messages: make(),
    beta: { messages: make(), files: { list: filesList }, skills: { create: skillsCreate } },
  };
}

const OPTS = { area: 'internal', callSite: 'scripts/test' };

describe('trackedAnthropic (scripts)', () => {
  it('records a plain messages.create with its tokens', async () => {
    const c = trackedAnthropic(stubClient(), OPTS);
    await c.messages.create({ model: 'claude-haiku-4-5' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      call_site: 'scripts/test', provider: 'anthropic', model: 'claude-haiku-4-5',
      status: 'ok', input_tokens: 120, output_tokens: 34, cache_read_tokens: 7,
    });
  });

  it('records beta.messages.create — the namespace the deck scripts use', async () => {
    // time-anthropic-deck.mjs calls client.beta.messages.create. Wrapping only
    // the non-beta path would have left it spending silently.
    const c = trackedAnthropic(stubClient(), OPTS);
    await c.beta.messages.create({ model: 'claude-opus-5' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: 'claude-opus-5', status: 'ok', input_tokens: 120 });
  });

  it('records a stream when finalMessage() resolves, not when it starts', async () => {
    const c = trackedAnthropic(stubClient(), OPTS);
    const turn = c.beta.messages.stream({ model: 'claude-sonnet-5' });
    expect(rows).toHaveLength(0); // a stream has no usage yet
    await turn.finalMessage();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: 'claude-sonnet-5', status: 'ok', output_tokens: 34 });
  });

  it('does not double-record when finalMessage() is awaited twice', async () => {
    // The SDK caches finalMessage, so a script reading it twice is normal and
    // must not produce two rows — that would overstate the bill.
    const c = trackedAnthropic(stubClient(), OPTS);
    const turn = c.beta.messages.stream({ model: 'claude-sonnet-5' });
    await turn.finalMessage();
    await turn.finalMessage();
    expect(rows).toHaveLength(1);
  });

  it('leaves the stream iterable so `for await` still drains it', async () => {
    const c = trackedAnthropic(stubClient(), OPTS);
    const turn = c.beta.messages.stream({ model: 'claude-sonnet-5' });
    const seen: unknown[] = [];
    for await (const ev of turn) seen.push(ev);
    expect(seen).toEqual([{ type: 'x' }]);
  });

  it('passes beta.files and beta.skills through untouched and records nothing', async () => {
    // Those are storage APIs — they cost no tokens, so a row would be noise.
    const c = trackedAnthropic(stubClient(), OPTS);
    expect(c.beta.files.list()).toBe('FILES');
    await c.beta.skills.create({ display_title: 'x' });
    expect(rows).toEqual([]);
  });

  it('records a failure and re-throws the original error unchanged', async () => {
    const boom = new Error('overloaded_error');
    const client = stubClient();
    client.messages.create = vi.fn(async () => { throw boom; });
    const c = trackedAnthropic(client, OPTS);
    await expect(c.messages.create({ model: 'claude-haiku-4-5' })).rejects.toBe(boom);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'error', error: 'overloaded_error', model: 'claude-haiku-4-5' });
  });

  it('marks script rows as operator-run so the page can separate them', async () => {
    const c = trackedAnthropic(stubClient(), OPTS);
    await c.messages.create({ model: 'claude-haiku-4-5' });
    expect((rows[0]!.meta as Record<string, unknown>).run_kind).toBe('operator_script');
  });

  it('never writes a known zero cost', async () => {
    // cost_usd=NULL means UNKNOWN; the price book fills it in later.
    const c = trackedAnthropic(stubClient(), OPTS);
    await c.messages.create({ model: 'claude-haiku-4-5' });
    expect(rows[0]).not.toHaveProperty('cost_usd');
    expect(rows[0]).not.toHaveProperty('cost_known');
  });
});

describe('token + model helpers (scripts copy)', () => {
  it('extracts Anthropic usage identically to the canonical recorder', () => {
    expect(anthropicTokens({ usage: USAGE })).toEqual({
      inputTokens: 120, outputTokens: 34, cacheReadTokens: 7, cacheWriteTokens: 0,
    });
    expect(anthropicTokens({})).toEqual({});
  });

  it('splits an OpenAI-compatible cache hit out of the prompt total', () => {
    expect(openAiCompatTokens({ usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 40 } }))
      .toEqual({ inputTokens: 60, outputTokens: 10, cacheReadTokens: 40 });
  });

  it('prefers the served model over the requested alias', () => {
    expect(openAiCompatModel({ model: 'deepseek-flash' }, 'deepseek-chat')).toBe('deepseek-flash');
    expect(openAiCompatModel(null, 'deepseek-chat')).toBe('deepseek-chat');
  });
});
