import { afterEach, describe, expect, it } from 'vitest';
import { isInsufficientQuota, openaiChatJson, openaiCostUsd, openaiStrictSchema, OPENAI_QUOTA } from '../../../ai/providers/openaiHttp.js';
import { DAILY_QUOTA_MARK } from '../../../ai/providers/geminiHttp.js';
import { buildOpenAiReadPrompt } from '../openaiRead.js';
import { isModelRead } from '../geminiEnrich.js';
import { designSchema } from '../geminiDesign.js';
import { slideReadProblems } from '../../../creative/designRead/schemas.js';

const walk = (s: unknown, visit: (o: Record<string, unknown>) => void): void => {
  if (Array.isArray(s)) { s.forEach((x) => walk(x, visit)); return; }
  if (s && typeof s === 'object') { visit(s as Record<string, unknown>); Object.values(s).forEach((v) => walk(v, visit)); }
};

describe('openaiCostUsd', () => {
  it('prices at the cited standard rate', () => {
    expect(openaiCostUsd('gpt-6-luna', { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 })).toBe(0.6);
    expect(openaiCostUsd('gpt-6.1-sol', { prompt_tokens: 10_000, completion_tokens: 2_000 })).toBe(0.04);
  });
  it('is null for a model with no cited price (never a made-up number)', () => {
    expect(openaiCostUsd('gpt-unknown', { prompt_tokens: 5 })).toBeNull();
  });
});

describe('openaiStrictSchema', () => {
  it('closes every object, requires every property, drops constraints strict mode refuses', () => {
    walk(openaiStrictSchema(designSchema()), (o) => {
      for (const k of ['minimum', 'maximum', 'minItems', 'maxItems', 'pattern', 'description']) expect(o).not.toHaveProperty(k);
      if (o.type === 'object') {
        expect(o.additionalProperties).toBe(false);
        expect(o.required).toEqual(Object.keys(o.properties as object));
      }
    });
  });
});

describe('openaiChatJson', () => {
  const realKey = process.env.OPENAI_API_KEY;
  afterEach(() => { process.env.OPENAI_API_KEY = realKey; });
  const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

  it('an empty balance pauses at once (DAILY_QUOTA_MARK + OPENAI_QUOTA), never retried', async () => {
    process.env.OPENAI_API_KEY = 'test';
    let calls = 0;
    const fetchStub = (async () => { calls++; return res(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }); }) as typeof fetch;
    await expect(openaiChatJson('gpt-6-luna', [], 's', {}, { fetch: fetchStub, sleep: async () => {} })).rejects.toThrow(new RegExp(`${DAILY_QUOTA_MARK} ${OPENAI_QUOTA}`));
    expect(calls).toBe(1);
  });
  it('a rate limit is retried, then the answer comes back', async () => {
    process.env.OPENAI_API_KEY = 'test';
    let calls = 0;
    const fetchStub = (async () => {
      calls++;
      return calls < 3 ? res(429, { error: { code: 'rate_limit_exceeded' } }, { 'retry-after': '1' })
        : res(200, { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
    }) as typeof fetch;
    const r = await openaiChatJson('gpt-6-luna', [], 's', {}, { fetch: fetchStub, sleep: async () => {} });
    expect(calls).toBe(3);
    expect(r.text).toBe('{"ok":true}');
    expect(r.usage.prompt_tokens).toBe(10);
  });
  it('a 400 is a request bug: thrown at once', async () => {
    process.env.OPENAI_API_KEY = 'test';
    let calls = 0;
    const fetchStub = (async () => { calls++; return res(400, { error: { message: 'bad schema' } }); }) as typeof fetch;
    await expect(openaiChatJson('gpt-6-luna', [], 's', {}, { fetch: fetchStub, sleep: async () => {} })).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);
  });
  it('recognises the empty-balance wording', () => {
    expect(isInsufficientQuota('{"error":{"code":"insufficient_quota"}}')).toBe(true);
    expect(isInsufficientQuota('{"error":{"code":"rate_limit_exceeded"}}')).toBe(false);
  });
});

describe('buildOpenAiReadPrompt', () => {
  it("labels a video's frames as frames of that video and maps every picture back to its media item", () => {
    const one = Buffer.from('x');
    const { prompt, owner } = buildOpenAiReadPrompt({ post_id: 'p' }, [
      { mediaId: 'img', kind: 'image', jpegs: [one] },
      { mediaId: 'vid', kind: 'video', jpegs: [one, one, one] },
    ]);
    expect(owner).toEqual([0, 1, 1, 1]);
    expect(prompt).toContain('[2] frame 1 of 3 from video 2');
    expect(prompt).toContain('still frames sampled evenly in time order');
  });
});

describe('isModelRead', () => {
  it('counts Gemini and OpenAI decisions as read, nothing else', () => {
    expect(isModelRead({ status: 'done', model: 'gemini-3.8-flash' })).toBe(true);
    expect(isModelRead({ status: 'done', model: 'gpt-6-luna' })).toBe(true);
    expect(isModelRead({ status: 'done', model: 'claude-runner' })).toBe(false);
    expect(isModelRead({ status: 'pending', model: 'gpt-6-luna' })).toBe(false);
  });
});

describe('slide validator', () => {
  it('accepts 0 type sizes for an image with no text (rejected every such read before 2026-10-06)', () => {
    const errs = slideReadProblems({ typography: { arabic_style: 'none', size_levels: 0, weight_contrast: 'low', latin_present: false, numerals: 'none' } });
    expect(errs.some((e) => e.includes('size_levels'))).toBe(false);
  });
});
