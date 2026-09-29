import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { recordMock, createMock } = vi.hoisted(() => ({ recordMock: vi.fn(), createMock: vi.fn() }));

vi.mock('../aiUsage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../aiUsage.js')>();
  return { ...actual, recordAiUsage: recordMock };
});

vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    messages = { create: createMock };
  },
}));

import {
  buildExtractSystemPrompt, buildExtractUserText, EXTRACT_SYSTEM_PROMPT, PREF_FIELDS,
  callDeepSeek, extractPreferences, PREF_CLAUDE_FALLBACK_MODEL, PREF_DEEPSEEK_MODEL, PREF_EXTRACTOR_VERSION,
} from '../prefExtract.js';

const GOOD_JSON = JSON.stringify({
  preferred_unit_type: { value: ['فيلا'], quote: 'أبي فيلا', confidence: 90 },
  budget: { value: { min: null, max: 3000000 }, quote: 'ما يتجاوز الثلاثة مليون', confidence: 80 },
  districts: ['النرجس'],
});

function deepseekResponse(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({ model: 'deepseek-v4-flash', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

const ENV_KEYS = ['DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'WA_EXTRACT_STUB', 'TEXT_LLM_PROVIDER'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.DEEPSEEK_API_KEY = 'ds-test';
  process.env.ANTHROPIC_API_KEY = 'an-test';
  delete process.env.WA_EXTRACT_STUB;
  delete process.env.TEXT_LLM_PROVIDER;
  recordMock.mockReset();
  createMock.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe('prompts per channel', () => {
  it('the chat prompt is about WhatsApp and never says «مكالمة»; the call prompt is the reverse', () => {
    const chat = buildExtractSystemPrompt('chat');
    const call = buildExtractSystemPrompt('call');
    expect(chat).toContain('واتساب');
    expect(chat).not.toContain('مكالمة');
    expect(call).toContain('مكالمة');
    expect(call).not.toContain('واتساب');
    expect(EXTRACT_SYSTEM_PROMPT).toBe(call);
  });
  it('the chat prompt carries the rep-proposal / question / voice-note rules', () => {
    const chat = buildExtractSystemPrompt('chat');
    expect(chat).toContain('(رسالة صوتية)');
    expect(chat).toContain('فيه فلل؟');
    expect(chat).toContain('وافق عليه العميل');
  });
  it('the rent rule (no purpose, no budget for a renter) is on BOTH channels', () => {
    for (const ch of ['chat', 'call'] as const) {
      const p = buildExtractSystemPrompt(ch);
      expect(p).toContain('إيجار');
      expect(p).toContain('فلا تُخرج purchase_objective ولا budget');
    }
  });
  it('the salesperson rule is on the CALL prompt only, and names the «العميل» line', () => {
    const call = buildExtractSystemPrompt('call');
    const chat = buildExtractSystemPrompt('chat');
    expect(call).toContain('ما يقوله المندوب ليس تفضيلًا للعميل');
    expect(call).toContain('في سطر «العميل» الخاص به');
    expect(call).toContain('لا من كلام المندوب أبدًا');
    expect(chat).not.toContain('ما يقوله المندوب ليس تفضيلًا للعميل');
    // The chat-only rules stay off the call prompt.
    expect(call).not.toContain('(رسالة صوتية)');
  });
  it('the extractor version was bumped for the new rules', () => {
    expect(PREF_EXTRACTOR_VERSION).toBe('pref-extract/v3');
  });
  it('the user text heading follows the channel', () => {
    expect(buildExtractUserText('chat', 'x')).toBe('المحادثة:\nx');
    expect(buildExtractUserText('call', 'x')).toBe('نص المكالمة:\nx');
  });
});

describe('field options match the live clients schema', () => {
  it('amenities have no «قبو» / «ملحق»; purpose uses the stored API values', () => {
    expect(PREF_FIELDS.preferred_amenities.options).toEqual(['حوش', 'سطح', 'غرفة خادمة', 'غرفة سائق', 'مجلس', 'مسبح', 'مصعد']);
    expect(PREF_FIELDS.purchase_objective.options).toEqual(['investment', 'residential']);
    expect(PREF_FIELDS.preferred_unit_type.options).toContain('ملحق');
  });
});

describe('metering', () => {
  it('callDeepSeek records operation extract_chat with the entity', async () => {
    const fetchMock = vi.fn(async () => deepseekResponse(GOOD_JSON));
    vi.stubGlobal('fetch', fetchMock);
    await callDeepSeek({ apiKey: 'k', model: 'deepseek-chat', transcript: '[1] العميل: أبي فيلا', channel: 'chat', entity: { kind: 'client', id: 'c1' } });
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock.mock.calls[0]![0]).toMatchObject({
      callSite: 'api/_lib/prefExtract', operation: 'extract_chat', provider: 'deepseek', status: 'ok',
      entityKind: 'client', entityId: 'c1',
    });
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body) as { messages: Array<{ content: string }> };
    expect(sent.messages[0]!.content).toContain('واتساب');
  });
  it('defaults to the call channel (operation extract_call)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => deepseekResponse(GOOD_JSON)));
    await callDeepSeek({ apiKey: 'k', model: 'deepseek-chat', transcript: 'x' });
    expect(recordMock.mock.calls[0]![0]).toMatchObject({ operation: 'extract_call' });
  });
  it('a transport failure is recorded as an error row and re-thrown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    await expect(callDeepSeek({ apiKey: 'k', model: 'deepseek-chat', transcript: 'x', channel: 'chat' })).rejects.toThrow('ECONNRESET');
    expect(recordMock.mock.calls[0]![0]).toMatchObject({ status: 'error', operation: 'extract_chat' });
  });
});

describe('extractPreferences routing', () => {
  it('DeepSeek primary: parsed suggestions, districts parsed (callers drop them)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => deepseekResponse(GOOD_JSON)));
    const r = await extractPreferences({ channel: 'chat', transcript: '[1] العميل: أبي فيلا' });
    expect(r.model).toBe(PREF_DEEPSEEK_MODEL);
    expect(r.isFallback).toBe(false);
    expect(r.output.suggestions.preferred_unit_type?.value).toEqual(['فيلا']);
    expect(r.output.suggestions.budget?.value).toEqual({ max: 3000000 });
    expect(createMock).not.toHaveBeenCalled();
  });
  it('falls back to Claude Haiku when DeepSeek throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => deepseekResponse('boom', 500)));
    createMock.mockResolvedValue({ content: [{ type: 'text', text: GOOD_JSON }], usage: { input_tokens: 1, output_tokens: 1 } });
    const r = await extractPreferences({ channel: 'chat', transcript: 'x' });
    expect(r.model).toBe(PREF_CLAUDE_FALLBACK_MODEL);
    expect(r.isFallback).toBe(true);
    expect(r.output.suggestions.preferred_unit_type?.value).toEqual(['فيلا']);
    expect((createMock.mock.calls[0]![0] as { model: string }).model).toBe(PREF_CLAUDE_FALLBACK_MODEL);
  });
  it('falls back when DeepSeek answers with unparseable JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => deepseekResponse('{ not json')));
    createMock.mockResolvedValue({ content: [{ type: 'text', text: GOOD_JSON }], usage: {} });
    const r = await extractPreferences({ channel: 'chat', transcript: 'x' });
    expect(r.isFallback).toBe(true);
  });
  it('THROWS when both providers fail — never a silent empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => deepseekResponse('boom', 500)));
    createMock.mockRejectedValue(new Error('anthropic down'));
    await expect(extractPreferences({ channel: 'chat', transcript: 'x' })).rejects.toThrow(/both providers.*anthropic down/);
  });
  it('the kill switch (TEXT_LLM_PROVIDER=anthropic) goes straight to Claude, not as a fallback', async () => {
    process.env.TEXT_LLM_PROVIDER = 'anthropic';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    createMock.mockResolvedValue({ content: [{ type: 'text', text: GOOD_JSON }], usage: {} });
    const r = await extractPreferences({ channel: 'chat', transcript: 'x' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.isFallback).toBe(false);
  });
});
